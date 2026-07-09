// @ts-nocheck
import { Telegraf, Scenes, session, Context } from 'telegraf';
import { config } from './config';
import { handleStart, handleNameInput, showMainMenu, showMainMenuContent } from './handlers/start';
import { handleStartTraining, showStrictnessChoice, showProfileChoice, showTrainingMenu, handleStopTraining } from './handlers/training';
import { handleAdmin, handleDeleteMe, handleCheckAdmin } from './handlers/admin';
import { handleSettings, handleSettingsCallback } from './handlers/settings';
import { sendCSV, isAdmin } from './utils';
import { initCommandsMenu, setDefaultCommands, setChatCommands } from './commandsMenu';
import { prisma } from './db';
import { startServer } from './server';
import { startTunnel } from './tunnel';
import { registerManagerMessageHandlers } from './bot';
import { isTtsEnabled } from './voice/tts';
import { resolveVoiceCallUrls } from './voice/startVoiceCall';
import { seedCityDictionaryIfNeeded } from './data/cityDictionary';
import { seedCallReportProblemCatalog } from './voice/problemCatalog';

const bot = new Telegraf(config.botToken);

// Registration scene (prompt is sent from /start handler before entering)
const registrationScene = new Scenes.BaseScene('registration');
registrationScene.enter(() => {});

registrationScene.on('text', async (ctx) => {
  const name = ctx.message.text;
  await handleNameInput(ctx, name);
  await ctx.scene.leave();
});

// Bot commands and handlers
const stage = new Scenes.Stage([registrationScene]);
bot.use(session());
bot.use(stage.middleware());

bot.command('start', async (ctx) => {
  const safeReply = (text: string) =>
    ctx.reply(text).catch((e) => console.error('Reply failed:', e));
  console.log('[start] /start from', ctx.from?.id ?? 'unknown');
  try {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) {
      await safeReply('Ошибка: не удалось определить ваш ID. Напишите /start ещё раз.');
      return;
    }

    let user = null;
    try {
      user = await prisma.user.findUnique({ where: { telegramId } });
    } catch (dbErr) {
      console.error('DB error in /start:', dbErr);
      await safeReply('Ошибка базы данных. Попробуйте /start через минуту.');
      return;
    }

    if (user) {
      try {
        // Mark abandoned attempts as cancelled (not completed) — admin shows only properly evaluated attempts
        await prisma.attempt.updateMany({
          where: { userId: user.id, status: 'in_progress' },
          data: { status: 'cancelled', finishedAt: new Date() },
        });
        await prisma.trainingSession.updateMany({
          where: { userId: user.id, status: 'in_progress' },
          data: { status: 'completed', completedAt: new Date() },
        });
      } catch (_) {}
      if (isAdmin(ctx) && user.role !== 'admin') {
        await prisma.user.update({
          where: { id: user.id },
          data: { role: 'admin' },
        }).catch(() => {});
      }
    }

    if (!user || user.fullName === `User ${telegramId}`) {
      await safeReply('Укажите ваше полное имя:');
      await ctx.scene.enter('registration');
      return;
    }

    await handleStart(ctx);
    const chatId = ctx.chat?.id;
    if (chatId && ctx.chat?.type === 'private') {
      setChatCommands(chatId, { trainingActive: false, isAdmin: isAdmin(ctx) }).catch((e) =>
        console.error('setChatCommands on start:', e)
      );
    }
  } catch (err) {
    console.error('Error in /start:', err);
    await safeReply('Произошла ошибка. Напишите /start ещё раз.');
  }
});

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id.toString();
  if (telegramId) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (user) {
      const inProgress = await prisma.trainingSession.findFirst({
        where: { userId: user.id, status: 'in_progress' },
      });
      if (inProgress) {
        await showTrainingMenu(ctx);
        return;
      }
    }
  }
  await showMainMenuContent(ctx, { edit: true });
});
bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showMainMenuContent(ctx, { edit: true, simple: true });
});

bot.command('start_training', async (ctx) => {
  await showStrictnessChoice(ctx);
});
bot.command('stop_training', async (ctx) => {
  await handleStopTraining(ctx);
});
bot.command('menu', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (telegramId) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (user) {
      const inProgress = await prisma.trainingSession.findFirst({
        where: { userId: user.id, status: 'in_progress' },
      });
      if (inProgress) {
        await showTrainingMenu(ctx);
        return;
      }
    }
  }
  await showMainMenuContent(ctx);
});
bot.command('settings', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (telegramId) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (user) {
      const inProgress = await prisma.trainingSession.findFirst({
        where: { userId: user.id, status: 'in_progress' },
      });
      if (inProgress) {
        await ctx.reply('🔧 Настройки недоступны во время тренировки. Завершите или остановите тренировку.');
        return;
      }
    }
  }
  await handleSettings(ctx);
});
bot.command('admin', handleAdmin);
bot.command('delete_me', handleDeleteMe);
bot.command('check_admin', handleCheckAdmin);
bot.command('export_csv', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ Нет доступа');
  }
  await sendCSV(ctx);
});

bot.action('stop_training', async (ctx) => {
  await ctx.answerCbQuery();
  await handleStopTraining(ctx);
});
// Начать тренировку — сначала выбор строгости, затем старт
bot.action('start_training', async (ctx) => {
  await ctx.answerCbQuery();
  await showStrictnessChoice(ctx);
});
bot.action('start_training_low', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.callbackQuery?.message && 'message_id' in ctx.callbackQuery.message) {
    await ctx.telegram.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id).catch(() => {});
  }
  showProfileChoice(ctx, 'low');
});
bot.action('start_training_medium', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.callbackQuery?.message && 'message_id' in ctx.callbackQuery.message) {
    await ctx.telegram.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id).catch(() => {});
  }
  showProfileChoice(ctx, 'medium');
});
bot.action('start_training_high', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.callbackQuery?.message && 'message_id' in ctx.callbackQuery.message) {
    await ctx.telegram.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id).catch(() => {});
  }
  showProfileChoice(ctx, 'high');
});
// Client profile selection → start training
bot.action(/^profile_(low|medium|high)_(normal|thorough|pressure)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.callbackQuery?.message && 'message_id' in ctx.callbackQuery.message) {
    await ctx.telegram.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message.message_id).catch(() => {});
  }
  const strictness = ctx.match[1] as 'low' | 'medium' | 'high';
  const profile = ctx.match[2] as 'normal' | 'thorough' | 'pressure';
  await handleStartTraining(ctx, strictness, profile);
});
bot.action('training', async (ctx) => {
  await ctx.answerCbQuery();
  await showStrictnessChoice(ctx);
});
// Старые кнопки — показываем выбор строгости (на случай старых сообщений)
bot.action('start_test', async (ctx) => {
  await ctx.answerCbQuery();
  await showStrictnessChoice(ctx);
});
bot.action('continue_test', async (ctx) => {
  await ctx.answerCbQuery();
  await showStrictnessChoice(ctx);
});
bot.action('restart_test', async (ctx) => {
  await ctx.answerCbQuery();
  await showStrictnessChoice(ctx);
});

// Legacy admin callbacks - kept for backward compatibility with old messages
bot.action(/^admin_latest(?:_(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Эта функция доступна только в Mini App. Используйте /admin для открытия панели.');
});

bot.action(/^admin_by_manager(?:_(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Эта функция доступна только в Mini App. Используйте /admin для открытия панели.');
});

bot.action(/^admin_manager_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Эта функция доступна только в Mini App. Используйте /admin для открытия панели.');
});

bot.action('admin_summary', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Эта функция доступна только в Mini App. Используйте /admin для открытия панели.');
});

bot.action('admin_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await handleAdmin(ctx);
});

bot.action('settings', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id.toString();
  if (telegramId) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (user) {
      const inProgress = await prisma.trainingSession.findFirst({
        where: { userId: user.id, status: 'in_progress' },
      });
      if (inProgress) {
        await ctx.reply('🔧 Настройки недоступны во время тренировки.');
        return;
      }
    }
  }
  await handleSettings(ctx);
});
bot.action(/^settings_(reply_text|reply_voice|voice_male|voice_female|save)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const data = 'settings_' + (ctx.match[1] || '');
  await handleSettingsCallback(ctx, data);
});

// Error handling
bot.catch((err, ctx) => {
  console.error('[BOT ERROR]', err);
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[BOT ERROR] details:', msg);
  ctx.reply('Произошла ошибка. Попробуйте позже.').catch(() => {});
});

// Seed database if needed
async function seedIfNeeded() {
  const seededCities = await seedCityDictionaryIfNeeded(prisma);
  if (seededCities > 0) {
    console.log(`Seeded city dictionary with ${seededCities} cities.`);
  }
  const syncedProblems = await seedCallReportProblemCatalog(prisma);
  if (syncedProblems > 0) {
    console.log(`Synced call report problem catalog with ${syncedProblems} items.`);
  }

  const existingTest = await prisma.test.findFirst({
    where: { isActive: true },
  });

  if (!existingTest) {
    console.log('No active test found, seeding database...');
    
    const test = await prisma.test.create({
      data: {
        title: 'Тест продаж автомобилей',
        isActive: true,
        steps: {
          create: [
            {
              order: 1,
              customerMessage: 'Здравствуйте! Я интересуюсь покупкой автомобиля. Можете рассказать, какие модели у вас есть в наличии?',
              stepGoal: 'Initial contact - establish rapport, show interest, gather initial information about customer needs',
              scoringFocusJson: JSON.stringify(['STRUCTURE', 'EMPATHY_TONE', 'NEEDS_DISCOVERY']),
            },
            {
              order: 2,
              customerMessage: 'Хорошо, а какая цена на эту модель? Это довольно дорого... Может быть, есть что-то подешевле?',
              stepGoal: 'Price objection - handle price concern, provide value, explore alternatives without losing the sale',
              scoringFocusJson: JSON.stringify(['OBJECTION_HANDLING', 'VALUE_ARGUMENTATION', 'EMPATHY_TONE']),
            },
            {
              order: 3,
              customerMessage: 'Я слышал, что у конкурентов такая же машина стоит дешевле. Почему у вас дороже?',
              stepGoal: 'Competitor comparison - differentiate value, build trust, address comparison without badmouthing competitors',
              scoringFocusJson: JSON.stringify(['OBJECTION_HANDLING', 'VALUE_ARGUMENTATION', 'RISK_PHRASES']),
            },
            {
              order: 4,
              customerMessage: 'Хм, я не уверен. Мне нужно подумать. Может быть, я вернусь позже?',
              stepGoal: 'Hesitation/indecision - create urgency, address concerns, move toward commitment',
              scoringFocusJson: JSON.stringify(['OBJECTION_HANDLING', 'NEXT_STEP_CTA', 'EMPATHY_TONE']),
            },
            {
              order: 5,
              customerMessage: 'А как насчет гарантии? И что если что-то пойдет не так после покупки?',
              stepGoal: 'Trust and risk concerns - build confidence, address warranty and after-sale support',
              scoringFocusJson: JSON.stringify(['EMPATHY_TONE', 'VALUE_ARGUMENTATION', 'OBJECTION_HANDLING']),
            },
            {
              order: 6,
              customerMessage: 'Хорошо, допустим я готов купить. Что дальше? Какие документы нужны?',
              stepGoal: 'Closing readiness - provide clear next steps, make process easy, maintain momentum',
              scoringFocusJson: JSON.stringify(['NEXT_STEP_CTA', 'STRUCTURE', 'VALUE_ARGUMENTATION']),
            },
            {
              order: 7,
              customerMessage: 'Отлично! Можем ли мы записаться на тест-драйв на этой неделе?',
              stepGoal: 'Final commitment - confirm appointment, set expectations, ensure smooth transition',
              scoringFocusJson: JSON.stringify(['NEXT_STEP_CTA', 'STRUCTURE', 'EMPATHY_TONE']),
            },
          ],
        },
      },
      include: {
        steps: true,
      },
    });

    console.log(`Created test "${test.title}" with ${test.steps.length} steps`);
  }
}

// Start bot
async function main() {
  try {
    console.log('Starting Sales Boost...');

    // Production: MINI_APP_URL from env (Railway etc). Dev: tunnel for HTTPS.
    const miniUrl = (process.env.MINI_APP_URL || '').trim().replace(/\/+$/, '');
    const isProduction = miniUrl.startsWith('https://') && !miniUrl.includes('localhost');
    const isDevAdmin = process.env.ALLOW_DEV_ADMIN === 'true' || process.env.ALLOW_DEV_ADMIN === '1';
    (config as any).miniAppUrl = miniUrl || `http://localhost:${config.port}`;

    // 1. Start HTTP server
    await startServer();
    console.log('[OK] Web server: http://localhost:' + config.port);

    // 2. In dev (or when ALLOW_DEV_ADMIN): always start tunnel so URL is always current.
    //    When tunnel is ready, config.miniAppUrl and getTunnelUrl() are updated — no .env changes needed.
    const shouldStartTunnel = !isProduction || isDevAdmin;
    if (shouldStartTunnel) {
      const onTunnelUrl = (url: string) => {
        const clean = (url || '').trim().replace(/\/+$/, '');
        if (!clean) return;
        (config as any).miniAppUrl = clean;
        const voiceUrls = resolveVoiceCallUrls();
        console.log('[TUNNEL] ' + clean);
        console.log('[TUNNEL] Vox webhook event_url: ' + (voiceUrls.eventUrl || '(not resolved)'));
        console.log('        Админ-панель готова. Нажмите /admin → «Открыть Админ-панель».');
      };
      startTunnel(onTunnelUrl).then((url) => {
        if (url) onTunnelUrl(url);
        else console.log('[TUNNEL] Не запустился. Для production укажите MINI_APP_URL в .env');
      }).catch(() => {});
    } else {
      console.log('[OK] Mini App URL: ' + miniUrl);
    }

    await seedIfNeeded();
    console.log('[OK] Database ready.');

    // 3. Connect bot
    console.log('Connecting to Telegram...');
    const me = await bot.telegram.getMe();
    console.log('[OK] Bot connected: @' + me.username);

    initCommandsMenu(bot.telegram);
    await setDefaultCommands();
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } });
    console.log('[OK] Bot menu set.');

    // Unified text + voice handlers for manager training dialog
    registerManagerMessageHandlers(bot);

    // Polling: delete any webhook first, then launch
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    const maxRetries = 8;
    const retryDelayMs = 15000;
    let launched = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await bot.launch({ dropPendingUpdates: true });
        launched = true;
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const is409 = typeof msg === 'string' && msg.includes('409');
        if (is409 && attempt < maxRetries) {
          console.warn(`[BOT] 409 Conflict (${attempt}/${maxRetries}). Остановите локальный бот. Повтор через ${retryDelayMs / 1000}с...`);
          await new Promise((r) => setTimeout(r, retryDelayMs));
        } else {
          throw err;
        }
      }
    }

    if (launched) {
      console.log('[OK] Bot is running. Send /start or /admin in Telegram.');
    }
    console.log('      TTS:', isTtsEnabled() ? 'enabled (OpenAI)' : 'disabled');

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (error) {
    console.error('[ERROR] Failed to start:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('409')) {
      console.error('[BOT] Mini App и /health работают. Остановите ВСЕ локальные экземпляры бота (npm run dev) и сделайте Redeploy.');
      // Keep process alive — HTTP server stays up
      const retryInterval = setInterval(async () => {
        try {
          await bot.telegram.deleteWebhook({ drop_pending_updates: true });
          await bot.launch({ dropPendingUpdates: true });
          clearInterval(retryInterval);
          console.log('[OK] Bot подключился после повтора.');
        } catch {
          // Will retry again
        }
      }, 60000);
    } else {
      // process.exit(1);
      console.error('[ERROR] Failed to start:', error instanceof Error ? error.message : error);

      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }

      console.warn('[BOT] Telegram недоступен. Бэкенд продолжает работать без бота.');
    }
  }
}

main();
