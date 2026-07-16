/**
 * Generates one synthetic voice call for an account and runs the same AI analytics
 * pipeline used for finished real calls.
 *
 * Usage:
 *   npx tsx scripts/seed-ai-call-for-user.ts --email user@example.com
 *   npx tsx scripts/seed-ai-call-for-user.ts --email user@example.com --planId cm... --quality weak
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { config } from '../src/config';
import { loadCar } from '../src/data/carLoader';
import { getDefaultState } from '../src/state/defaultState';
import { evaluateSessionV2 } from '../src/llm/evaluatorV2';
import { openai } from '../src/lib/openaiClient';
import { buildConversationPairs, generateCallSummary, generateReplyImprovements } from '../src/voice/callSummary';
import { buildCustomerScenarioPromptCore } from '../src/voice/customerScenarioPrompt';
import { generateUnifiedCallReport } from '../src/voice/unifiedCallReport';

type TranscriptTurn = { role: 'manager' | 'client'; text: string };
type Quality = 'mixed' | 'weak' | 'medium' | 'strong';

const prisma = new PrismaClient();

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1]?.trim() || null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printHelp(): void {
  console.log(`Генерация одного AI-звонка для пользователя.

Обязательные параметры:
  --email <email>          Email web-аккаунта.

Опционально:
  --planId <id>           Конкретный план прозвона. По умолчанию берется любой план холдинга пользователя.
  --dealershipId <id>     Точка, если у пользователя нет manager profile.
  --quality <value>       mixed | weak | medium | strong. По умолчанию mixed.
  --startedAt <iso>       Дата начала звонка. По умолчанию сейчас.

Пример:
  npx tsx scripts/seed-ai-call-for-user.ts --email test@mail.ru --quality medium`);
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function pickOne<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)] ?? null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizePhone(value: string | null | undefined): string {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '+79990000000';
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function dimensionJsonFromEvaluation(evaluation: unknown): string | undefined {
  if (!evaluation || typeof evaluation !== 'object') return undefined;
  const value = (evaluation as { dimension_scores?: unknown }).dimension_scores;
  return value && typeof value === 'object' ? JSON.stringify(value) : undefined;
}

function checklistJsonFromEvaluation(evaluation: unknown): string | undefined {
  if (!evaluation || typeof evaluation !== 'object') return undefined;
  const value = (evaluation as { checklist?: unknown }).checklist;
  return Array.isArray(value) ? JSON.stringify(value) : undefined;
}

function labelForQuality(quality: Quality): string {
  if (quality === 'weak') return 'слабый звонок: менеджер часто пропускает важные этапы, мало диагностирует и плохо закрывает следующий шаг';
  if (quality === 'medium') return 'средний звонок: часть этапов выполнена, но есть заметные пропуски и неуверенное закрытие';
  if (quality === 'strong') return 'сильный звонок: менеджер хорошо ведет диалог, выявляет потребности и фиксирует следующий шаг';
  return 'смешанный реалистичный звонок: не идеальный, с несколькими сильными и слабыми местами';
}

function buildDialogGenerationPrompt(input: {
  accountName: string;
  dealershipName: string;
  holdingName: string;
  plan: Prisma.CallPlanGetPayload<{}>;
  script: Prisma.CallScriptGetPayload<{}>;
  customerProfile: Prisma.CallCustomerProfileGetPayload<{}> | null;
  importedItem: Prisma.ImportedItemGetPayload<{}> | null;
  quality: Quality;
}): string {
  const questions = safeJsonParse<Array<{ text?: string; required?: boolean }>>(input.script.questionsJson, []);
  const objections = safeJsonParse<Array<{ phrase?: string; whenAppropriate?: string }>>(input.script.objectionsJson, []);
  const criteria = safeJsonParse<Array<{ expectedAnswer?: string; score?: number }>>(input.script.successCriteriaJson, []);
  const profile = input.customerProfile;
  const scenarioCore = buildCustomerScenarioPromptCore({
    age: String(profile?.age ?? profile?.ageFrom ?? 35),
    temperament: profile?.temperament || 'normal',
    patience: profile?.patience || 'medium',
    replyLength: profile?.replyLength || 'medium',
    communicationStyle: profile?.communicationStyle || 'Говори естественно, как реальный клиент по телефону.',
    context: input.script.context || 'Клиент интересуется предложением компании.',
    itemTitle: input.importedItem?.title || 'предложение из выборки',
    itemDescription: input.importedItem?.description || '',
    voiceName: null,
    questions,
    objections,
    criteria,
  });

  return [
    'Сгенерируй синтетическую стенограмму телефонного звонка тайного покупателя в автосалон.',
    'Это тестовые данные для аналитики. Реального звонка не было.',
    '',
    'Контекст:',
    `- Компания: ${input.holdingName}`,
    `- Точка: ${input.dealershipName}`,
    `- Менеджер: ${input.accountName}`,
    `- План прозвона: ${input.plan.name}`,
    `- Желаемое качество: ${labelForQuality(input.quality)}`,
    '',
    scenarioCore,
    '',
    'Требования к диалогу:',
    '- 10-18 реплик, первая реплика обычно от клиента.',
    '- Роли только manager и client.',
    '- Текст только на русском.',
    '- Менеджер должен звучать как реальный сотрудник, не как ассистент AI.',
    '- Клиент должен задавать вопросы из скрипта и иногда использовать возражения, если они есть.',
    '- Диалог должен быть завершенным, без мета-комментариев и без markdown.',
    '- Верни только JSON.',
    '',
    'Формат JSON:',
    JSON.stringify({
      outcome: 'disconnected',
      answerTimeSec: 8,
      talkDurationSec: 180,
      transcript: [
        { role: 'client', text: 'Здравствуйте, подскажите, пожалуйста...' },
        { role: 'manager', text: 'Добрый день...' },
      ],
    }, null, 2),
  ].join('\n');
}

async function generateTranscript(input: Parameters<typeof buildDialogGenerationPrompt>[0]): Promise<{
  outcome: string;
  answerTimeSec: number;
  talkDurationSec: number;
  transcript: TranscriptTurn[];
}> {
  const response = await openai.chat.completions.create({
    model: config.openaiChatModel,
    messages: [
      { role: 'system', content: 'Ты генерируешь реалистичные русскоязычные стенограммы звонков для QA-аналитики. Отвечай только валидным JSON.' },
      { role: 'user', content: buildDialogGenerationPrompt(input) },
    ],
    response_format: { type: 'json_object' },
    temperature: input.quality === 'mixed' ? 0.85 : 0.65,
    max_tokens: 2500,
  });
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error('AI не вернул стенограмму.');
  const parsed = JSON.parse(content) as {
    outcome?: unknown;
    answerTimeSec?: unknown;
    talkDurationSec?: unknown;
    transcript?: Array<{ role?: unknown; text?: unknown }>;
  };
  const transcript = (Array.isArray(parsed.transcript) ? parsed.transcript : [])
    .map((turn) => ({
      role: turn.role === 'manager' ? 'manager' as const : 'client' as const,
      text: String(turn.text ?? '').trim(),
    }))
    .filter((turn) => turn.text);
  if (transcript.length < 4) throw new Error('AI вернул слишком короткую стенограмму.');
  return {
    outcome: String(parsed.outcome || 'disconnected'),
    answerTimeSec: clampInt(parsed.answerTimeSec, 8, 1, 90),
    talkDurationSec: clampInt(parsed.talkDurationSec, transcript.length * 12, 30, 1200),
    transcript,
  };
}

async function evaluatePlanCriteriaDirect(input: {
  criteriaJson: string;
  transcript: TranscriptTurn[];
}): Promise<unknown | null> {
  const criteria = safeJsonParse<Array<{ expectedAnswer?: string; score?: number }>>(input.criteriaJson, []);
  const meaningfulCriteria = criteria.filter((item) => String(item.expectedAnswer || '').trim());
  if (meaningfulCriteria.length === 0) return null;
  const prompt = [
    'Ты оцениваешь разговор сотрудника с виртуальным клиентом по условиям успеха скрипта.',
    'Для каждого условия сравни ответ сотрудника с эталоном.',
    'Правила: если ответил также или почти также — полный балл; если близко — половина; если не ответил — 0.',
    'Верни только JSON: {"items":[{"expectedAnswer":"...","maxScore":100,"score":0,"evidence":"цитата или причина"}],"totalScore":0,"maxScore":0,"percent":0}.',
    '',
    `Условия:\n${JSON.stringify(meaningfulCriteria, null, 2)}`,
    '',
    `Диалог:\n${input.transcript.map((turn) => `${turn.role === 'manager' ? 'Сотрудник' : 'Клиент'}: ${turn.text}`).join('\n')}`,
  ].join('\n');
  try {
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      messages: [
        { role: 'system', content: 'Ты строгий оценщик продаж. Отвечай только валидным JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 1200,
    });
    const content = response.choices[0]?.message?.content?.trim();
    return content ? JSON.parse(content) : null;
  } catch (error) {
    console.warn('[seed-ai-call] plan criteria evaluation failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printHelp();
    return;
  }

  const email = argValue('email')?.toLowerCase();
  const planId = argValue('planId');
  const dealershipIdArg = argValue('dealershipId');
  const qualityRaw = argValue('quality') as Quality | null;
  const quality: Quality = qualityRaw && ['mixed', 'weak', 'medium', 'strong'].includes(qualityRaw) ? qualityRaw : 'mixed';
  const startedAtRaw = argValue('startedAt');
  const startedAt = startedAtRaw ? new Date(startedAtRaw) : new Date();
  if (!email) throw new Error('Передайте --email user@example.com');
  if (Number.isNaN(startedAt.getTime())) throw new Error('Некорректный --startedAt. Используйте ISO-дату.');

  const account = await prisma.account.findUnique({
    where: { email },
    include: {
      memberships: true,
      phoneNumbers: { where: { isActive: true }, take: 1 },
      managerProfiles: { include: { dealership: { include: { holding: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!account) throw new Error(`Аккаунт с email ${email} не найден.`);

  let manager = account.managerProfiles[0] ?? null;
  if (!manager) {
    const dealershipId = dealershipIdArg
      || account.memberships.find((membership) => membership.dealershipId)?.dealershipId
      || null;
    const holdingId = account.memberships.find((membership) => membership.holdingId)?.holdingId ?? null;
    const dealership = dealershipId
      ? await prisma.dealership.findUnique({ where: { id: dealershipId }, include: { holding: true } })
      : holdingId
        ? await prisma.dealership.findFirst({ where: { holdingId, isActive: true }, include: { holding: true }, orderBy: { createdAt: 'asc' } })
        : null;
    if (!dealership) {
      throw new Error('У пользователя нет профиля сотрудника и не удалось определить точку. Передайте --dealershipId.');
    }
    manager = await prisma.managerProfile.create({
      data: {
        accountId: account.id,
        dealershipId: dealership.id,
        fullName: account.displayName || account.email,
        email: account.email,
        phone: account.phoneNumbers[0]?.phone ?? null,
        status: 'active',
      },
      include: { dealership: { include: { holding: true } } },
    });
    console.log(`[seed-ai-call] Создан manager profile ${manager.id} для ${account.email}`);
  }

  const holdingId = manager.dealership.holdingId;
  if (!holdingId) throw new Error(`У точки ${manager.dealership.name} не указан holdingId.`);

  const plan = planId
    ? await prisma.callPlan.findFirst({ where: { id: planId, holdingId } })
    : await prisma.callPlan.findFirst({ where: { holdingId }, orderBy: { updatedAt: 'desc' } });
  if (!plan) throw new Error(`Не найден план прозвона для холдинга ${holdingId}.`);

  const script = await prisma.callScript.findFirst({ where: { id: plan.scriptId, holdingId } });
  if (!script) throw new Error(`Скрипт ${plan.scriptId} из плана ${plan.name} не найден.`);

  const profileIds = safeJsonParse<string[]>(script.profileIdsJson, []);
  const customerProfiles = profileIds.length
    ? await prisma.callCustomerProfile.findMany({ where: { id: { in: profileIds }, holdingId } })
    : await prisma.callCustomerProfile.findMany({ where: { holdingId }, take: 20, orderBy: { updatedAt: 'desc' } });
  const customerProfile = pickOne(customerProfiles);

  const importSources = await prisma.importSource.findMany({ where: { holdingId }, select: { id: true }, take: 20 });
  const importedItems = importSources.length
    ? await prisma.importedItem.findMany({ where: { importSourceId: { in: importSources.map((source) => source.id) } }, take: 50 })
    : [];
  const importedItem = pickOne(importedItems);

  console.log(`[seed-ai-call] Генерирую стенограмму через AI: ${account.email}, план "${plan.name}", quality=${quality}`);
  const generated = await generateTranscript({
    accountName: manager.fullName,
    dealershipName: manager.dealership.name,
    holdingName: manager.dealership.holding?.name ?? 'Компания',
    plan,
    script,
    customerProfile,
    importedItem,
    quality,
  });

  console.log(`[seed-ai-call] Оцениваю звонок (${generated.transcript.length} реплик)...`);
  const dialogHistory = generated.transcript.map((turn) => ({
    role: turn.role as 'client' | 'manager',
    content: turn.text,
  }));
  const { evaluation } = await evaluateSessionV2({
    dialogHistory,
    car: loadCar(),
    state: getDefaultState('normal'),
    earlyFail: false,
    behaviorSignals: [],
  });

  const checklist = Array.isArray((evaluation as any).checklist) ? (evaluation as any).checklist : [];
  const issues = Array.isArray((evaluation as any).issues) ? (evaluation as any).issues : [];
  const recommendations = Array.isArray((evaluation as any).recommendations) ? (evaluation as any).recommendations : [];
  const dimensionScores = (evaluation as any).dimension_scores ?? null;
  const callSummary = await generateCallSummary({
    transcript: generated.transcript,
    outcome: generated.outcome,
    totalScore: evaluation.overall_score_0_100 ?? null,
    dimensionScores: dimensionScores && typeof dimensionScores === 'object' ? dimensionScores : null,
    issues,
    checklist,
    recommendations,
  });
  const pairs = buildConversationPairs(generated.transcript);
  const replyImprovements = pairs.length
    ? await generateReplyImprovements({ pairs, limit: 12, issues })
    : null;
  const planCriteria = await evaluatePlanCriteriaDirect({
    criteriaJson: script.successCriteriaJson,
    transcript: generated.transcript,
  });
  const unifiedCallReport = await generateUnifiedCallReport({
    transcript: generated.transcript,
    outcome: generated.outcome,
    totalScore: evaluation.overall_score_0_100 ?? null,
    evaluation: {
      ...evaluation,
      call_summary: callSummary,
      reply_improvements: replyImprovements,
      plan_criteria: planCriteria,
    },
  });

  const answerTimeSec = generated.answerTimeSec;
  const talkDurationSec = generated.talkDurationSec;
  const connectedAt = new Date(startedAt.getTime() + answerTimeSec * 1000);
  const endedAt = new Date(connectedAt.getTime() + talkDurationSec * 1000);
  const callId = randomUUID();
  const phone = normalizePhone(manager.phone || account.phoneNumbers[0]?.phone || '+79990000000');
  const promptText = buildDialogGenerationPrompt({
    accountName: manager.fullName,
    dealershipName: manager.dealership.name,
    holdingName: manager.dealership.holding?.name ?? 'Компания',
    plan,
    script,
    customerProfile,
    importedItem,
    quality,
  });
  const evaluationJson = JSON.stringify({
    ...evaluation,
    call_summary: callSummary,
    reply_improvements: replyImprovements,
    unified_call_report: unifiedCallReport,
    plan_criteria: planCriteria,
  });
  const evaluationForDb = JSON.parse(evaluationJson);

  const createdSession = await prisma.$transaction(async (tx) => {
    const session = await tx.voiceCallSession.create({
      data: {
        callId,
        to: phone,
        scenario: 'ai_synthetic',
        source: 'demo',
        dealershipId: manager!.dealershipId,
        managerId: manager!.id,
        planId: plan.id,
        startedAt,
        connectedAt,
        endedAt,
        outcome: generated.outcome,
        answerTimeSec,
        durationSec: talkDurationSec,
        talkDurationSec,
        transcriptJson: JSON.stringify(generated.transcript),
        evaluationJson,
        dimensionsJson: dimensionJsonFromEvaluation(evaluationForDb),
        checklistResultsJson: checklistJsonFromEvaluation(evaluationForDb),
        caseContextJson: JSON.stringify({
          synthetic: true,
          generatedBy: 'scripts/seed-ai-call-for-user.ts',
          accountId: account.id,
          planId: plan.id,
          scriptId: script.id,
          profileId: customerProfile?.id ?? null,
          importedItemId: importedItem?.id ?? null,
          quality,
        }),
        totalScore: evaluation.overall_score_0_100 ?? null,
        failureReason: null,
      },
    });
    await tx.callPlanCall.create({
      data: {
        planId: plan.id,
        callId,
        employeeId: manager!.id,
        employeeName: manager!.fullName,
        dealershipId: manager!.dealershipId,
        dealershipName: manager!.dealership.name,
        phone,
        phoneNumberTypeId: plan.phoneNumberTypeId,
        scriptId: script.id,
        profileId: customerProfile?.id ?? null,
        importedItemId: importedItem?.id ?? null,
        promptText,
        criteriaJson: script.successCriteriaJson,
        status: 'completed',
        outcome: generated.outcome,
        startedAt,
        endedAt,
        transcriptJson: JSON.stringify(generated.transcript),
        evaluationJson,
        totalScore: evaluation.overall_score_0_100 ?? null,
        failureReason: null,
      },
    });
    return session;
  });

  console.log('[seed-ai-call] Готово.');
  console.log(`  account: ${account.email}`);
  console.log(`  managerId: ${manager.id}`);
  console.log(`  dealership: ${manager.dealership.name}`);
  console.log(`  plan: ${plan.name}`);
  console.log(`  callId: ${callId}`);
  console.log(`  auditUrl: /audits/call-${createdSession.id}`);
  console.log(`  score: ${evaluation.overall_score_0_100}/100`);
}

main()
  .catch((error) => {
    console.error('[seed-ai-call] Ошибка:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
