import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import type { Telegraf } from 'telegraf';
import { WebSocketServer } from 'ws';
import { prisma } from './db';
import { config } from './config';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleVoiceDialog } from './voice/voiceDialog';
import { handleVoiceStreamMessage } from './voice/voiceStream';
import { addCall, getCallHistory, getTestNumbers, setVoxSessionId } from './voice/callHistory';
import { resolveVoiceCallUrls, startVoiceCall } from './voice/startVoiceCall';
import { finalizeVoiceCallSession } from './voice/voiceCallSession';
import { evaluateDemoExampleFromTranscript } from './voice/demoExampleEvaluation';
import { computeUiDimensionScoresFromChecklist } from './voice/uiDimensionScores';
import {
  cancelCallBatch,
  createCallBatch,
  getCallBatch,
  getCallBatchJobs,
  listCallBatches,
  onVoxBatchWebhook,
  pauseCallBatch,
  resumeCallBatch,
  startCallBatchOrchestrator,
} from './voice/callBatchOrchestrator';
import { getDefaultState } from './state/defaultState';
import { buildDealershipFromCar } from './llm/virtualClient';
import { loadCar } from './data/carLoader';
import { getVirtualClientReply, type Strictness } from './llm/virtualClient';
import { generateSpeechBuffer } from './voice/tts';
import {
  handleCreateCallCustomerProfile,
  handleCreateCallPlan,
  handleCreateCallScript,
  handleDeleteCallCustomerProfile,
  handleDeleteCallScript,
  handleGetCallPlanOptions,
  handleInitiateCallPlan,
  handleListCallPlanCalls,
  handleListCallCustomerProfiles,
  handleListCallPlans,
  handleListCallScripts,
  handlePreviewCallPlanPrompt,
  handleUpdateCallCustomerProfile,
  handleUpdateCallScript,
} from './voice/callSettingsManagement';
import type { TtsVoice } from './state/userPreferences';
import { transcribeVoice } from './voice/stt';
import { classifyBehavior, type BehaviorSignal } from './logic/behaviorClassifier';
import { getDealershipDirectory } from './super-admin/dealershipDirectory';
import { adminApiAuthMiddleware, handleAuthLogin, handleAuthMe } from './auth/http';
import {
  handleAnalyzeImportSource,
  handleCreateImport,
  handleDeleteImport,
  handleGenerateImportTagRule,
  handleGenerateImportTagRules,
  handleGetImport,
  handleListImportedItems,
  handleListImportedTags,
  handleListImports,
  handlePreviewImportConfig,
  handleRunImport,
  handleTestImportTagRules,
  handleUpdateImport,
} from './imports/importManagement';
import {
  handleCreateDealership,
  handleCreateDealershipDirection,
  handleCreateDealershipPhoneNumber,
  handleCreateHolding,
  handleCreatePhoneNumberType,
  handleDeleteDealership,
  handleDeleteDealershipDirection,
  handleDeleteDealershipPhoneNumber,
  handleDeleteHolding,
  handleListDealerships,
  handleListCities,
  handleListDealershipDirections,
  handleListDealershipPhoneNumbers,
  handleListHoldings,
  handleListPhoneNumberTypes,
  handleSyncMockOrganization,
  handleUpdateDealership,
  handleUpdateDealershipDirection,
  handleUpdateDealershipPhoneNumber,
  handleUpdateHolding,
  handleUpdatePhoneNumberType,
} from './auth/organizationManagement';
import {
  handleCreatePermissionTemplate,
  handleCreateUser,
  handleChangeOwnPassword,
  handleChangeUserPassword,
  handleDeletePermissionTemplate,
  handleDeleteUser,
  handleDeleteUserPhoneNumber,
  handleCreateUserPhoneNumber,
  handleListPermissionTemplates,
  handleListUserPhoneNumbers,
  handleListUsers,
  handleRbacMeta,
  handleUpdatePermissionTemplate,
  handleUpdateUserPhoneNumber,
  handleUpdateUser,
} from './auth/userManagement';
import {
  advanceTopic,
  checkCriticalEvasions,
  recordEvasion,
  type TopicCode,
} from './logic/topicStateMachine';

// ---- In-memory cache for admin analytics (Team / Voice dashboard) ----
type TeamSummaryCache = {
  totalAttempts: number;
  avgScore: number;
  levelCounts: { Junior: number; Middle: number; Senior: number };
  topWeaknesses: { weakness: string; count: number }[];
  topStrengths: { strength: string; count: number }[];
  expertSummary: unknown;
};

type VoiceDashboardCache = {
  totalCalls: number;
  answeredPercent: number;
  missedPercent: number;
  avgDurationSec: number;
  outcomeBreakdown: {
    completed: number;
    no_answer: number;
    busy: number;
    failed: number;
    disconnected: number;
  };
};

const ANALYTICS_TTL_MS = 5 * 60 * 1000; // 5 minutes

let teamSummaryCache: { data: TeamSummaryCache | null; expiresAt: number } = {
  data: null,
  expiresAt: 0,
};

let voiceDashboardCache: { data: VoiceDashboardCache | null; expiresAt: number } = {
  data: null,
  expiresAt: 0,
};
import { getTunnelUrl } from './tunnel';
import { getCallSourceInfo } from './voice/dealershipCallSource';

const app = express();

/** Path for Telegram webhook (production). Call registerTelegramWebhook(bot) before startServer(). */
export const WEBHOOK_PATH = '/telegram-webhook';

export function registerTelegramWebhook(bot: Telegraf): void {
  app.post(WEBHOOK_PATH, async (req, res) => {
    try {
      if (!req.body) {
        console.error('[WEBHOOK] No body');
        return res.status(400).end();
      }
      await bot.handleUpdate(req.body, res);
    } catch (err) {
      console.error('[WEBHOOK] Error:', err);
      res.status(500).end();
    }
  });
}
app.use(express.json({ limit: '12mb' }));

// ── In‑memory web training sessions (independent от Telegram) ──
type WebTrainingProfile = 'normal' | 'thorough' | 'pressure';

type WebTrainingSession = {
  id: string;
  strictness: Strictness;
  profile: WebTrainingProfile;
  state: any;
  car: ReturnType<typeof loadCar>;
  dialogHistory: { role: 'client' | 'manager'; content: string }[];
  behaviorSignals: BehaviorSignal[];
};

type WebTrainingResult = {
  verdict: 'pass' | 'fail';
  totalScore: number;
  qualityTag: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  reasonCode: string | null;
};

const webTrainingSessions = new Map<string, WebTrainingSession>();

function createWebSessionId(): string {
  return `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRu(text: string): string {
  return text.toLowerCase().replace(/[ё]/g, 'е').replace(/\s+/g, ' ').trim();
}

const HARD_RUDE_PATTERNS = [
  'пошел на',
  'пошел ты',
  'пошла ты',
  'да пошел ты',
  'иди на',
  'заткнись',
  'отвали',
  'мне насрать',
  'мне плевать',
  'сами разбирайтесь',
  'закрой рот',
  'не твое дело',
  'достал',
  'задолбал',
];

function isHardRude(text: string): boolean {
  const n = normalizeRu(text);
  return HARD_RUDE_PATTERNS.some((p) => n.includes(p));
}

function shouldForceConversationEnd(clientMessage: string): boolean {
  const n = normalizeRu(clientMessage);
  return (
    n.includes('не готов продолжать разговор') ||
    n.includes('на этом, пожалуй, закончим') ||
    n.includes('видимо, сейчас не лучшее время') ||
    n.includes('пожалуй, обращусь в другой салон') ||
    n.includes('всего доброго') ||
    n.includes('до свидания')
  );
}

async function runWebTrainingTurn(params: {
  sessionId: string;
  message: string;
  replyMode: 'text' | 'text+voice';
  ttsVoice: TtsVoice;
}): Promise<{ clientMessage: string; endConversation: boolean; audioBase64: string | null; result: WebTrainingResult | null }> {
  const { sessionId, message, replyMode, ttsVoice } = params;
  const sess = webTrainingSessions.get(sessionId);
  if (!sess) {
    throw new Error('SESSION_NOT_FOUND');
  }

  const { car, strictness } = sess;
  const state = { ...sess.state };
  const historyBefore = [...sess.dialogHistory];
  const history = [...historyBefore, { role: 'manager' as const, content: message }];
  const max_client_turns = (state.strictnessState?.max_client_turns as number) ?? 12;
  const behavior = classifyBehavior(message, {
    lastClientQuestion: [...historyBefore].reverse().find((m) => m.role === 'client')?.content,
    isClientWaitingAnswer: true,
  });
  const hardRude = isHardRude(message);
  const behaviorSignals = [...sess.behaviorSignals, behavior];

  if (behavior.toxic || hardRude || behavior.disengaging) {
    const toxicReply =
      behavior.disengaging
        ? 'Понимаю. Не буду больше отвлекать. Спасибо за время, всего доброго.'
        : behavior.severity === 'HIGH' || hardRude
        ? 'Извините, но я не готов продолжать разговор в таком тоне. Всего доброго.'
        : 'Мне бы хотелось более уважительного общения. На этом, пожалуй, закончим.';
    const newHistory = [...history, { role: 'client' as const, content: toxicReply }];
    const result = buildWebTrainingResult(
      state,
      newHistory,
      behaviorSignals,
      true,
      behavior.disengaging ? 'DISENGAGEMENT' : 'BAD_TONE',
    );
    webTrainingSessions.delete(sessionId);
    return { clientMessage: toxicReply, endConversation: true, audioBase64: null, result };
  }

  if (behavior.low_effort) state.low_effort_streak = (state.low_effort_streak ?? 0) + 1;
  else state.low_effort_streak = 0;

  const lowQualityStreak = behaviorSignals.reduce((acc, s) => (s.low_quality ? acc + 1 : 0), 0);
  if ((state.low_effort_streak ?? 0) >= 3 || lowQualityStreak >= 2) {
    const failReply =
      'Я задаю конкретные вопросы и хотел бы получать развёрнутые ответы. Видимо, сейчас не лучшее время. До свидания.';
    const newHistory = [...history, { role: 'client' as const, content: failReply }];
    const result = buildWebTrainingResult(
      state,
      newHistory,
      behaviorSignals,
      true,
      lowQualityStreak >= 2 ? 'REPEATED_LOW_QUALITY' : 'REPEATED_LOW_EFFORT',
    );
    webTrainingSessions.delete(sessionId);
    return { clientMessage: failReply, endConversation: true, audioBase64: null, result };
  }

  const out = await getVirtualClientReply({
    car,
    dealership: buildDealershipFromCar(car),
    state,
    manager_last_message: message,
    dialog_history: history,
    strictness,
    max_client_turns,
    behaviorSignal: behavior,
    maxResponseTokens: 220,
  });

  state.phase = out.diagnostics.current_phase;
  let topicMap = { ...state.topics };
  for (const code of out.diagnostics.topics_addressed as TopicCode[]) {
    if (!topicMap[code]) continue;
    const currentStatus = topicMap[code].status;
    const next = currentStatus === 'none' ? 'asked' : currentStatus === 'asked' ? 'answered' : currentStatus;
    const result = advanceTopic(topicMap, code, next as any);
    if (result.valid) topicMap = result.map;
  }
  for (const code of out.diagnostics.topics_evaded as TopicCode[]) {
    if (!topicMap[code]) continue;
    topicMap = recordEvasion(topicMap, code);
  }
  state.topics = topicMap;

  const nextState = {
    ...state,
    stage: out.update_state.stage,
    checklist: { ...state.checklist, ...out.update_state.checklist },
    notes: out.update_state.notes,
    client_turns: out.update_state.client_turns,
  };

  const newHistory = [...history, { role: 'client' as const, content: out.client_message }];
  const evasionCheck = checkCriticalEvasions(topicMap);
  if (evasionCheck.shouldFail) {
    const evasionReply =
      'Я дважды задал важный вопрос и не получил ответа. Пожалуй, обращусь в другой салон.';
    const failHistory = [...history, { role: 'client' as const, content: evasionReply }];
    const result = buildWebTrainingResult(nextState, failHistory, behaviorSignals, true, `CRITICAL_EVASION:${evasionCheck.failedTopic}`);
    webTrainingSessions.delete(sessionId);
    return { clientMessage: evasionReply, endConversation: true, audioBase64: null, result };
  }

  const endConversation = Boolean(out.end_conversation) || shouldForceConversationEnd(out.client_message);
  const result = endConversation
    ? buildWebTrainingResult(nextState, newHistory, behaviorSignals, false, null)
    : null;
  if (endConversation) {
    webTrainingSessions.delete(sessionId);
  } else {
    webTrainingSessions.set(sessionId, {
      ...sess,
      state: nextState,
      dialogHistory: newHistory,
      behaviorSignals,
    });
  }

  let audioBase64: string | null = null;
  if (replyMode === 'text+voice' && out.client_message.trim()) {
    try {
      const buf = await generateSpeechBuffer(out.client_message, ttsVoice);
      if (buf.length) audioBase64 = buf.toString('base64');
    } catch (e) {
      console.error('[web-training] TTS turn error:', e);
    }
  }

  return {
    clientMessage: out.client_message,
    endConversation,
    audioBase64,
    result,
  };
}

function buildWebTrainingResult(
  state: any,
  history: { role: 'client' | 'manager'; content: string }[],
  behaviorSignals: BehaviorSignal[],
  forcedFail: boolean,
  reasonCode: string | null,
): WebTrainingResult {
  const toxicCount = behaviorSignals.filter((s) => s.toxic).length;
  const lowEffortCount = behaviorSignals.filter((s) => s.low_effort).length;
  const evasionCount = behaviorSignals.filter((s) => s.evasion).length;
  const highSeverityCount = behaviorSignals.filter((s) => s.severity === 'HIGH').length;
  const prohibitedUnique = new Set(behaviorSignals.flatMap((s) => s.prohibited_phrase_hits)).size;
  const turns = history.filter((m) => m.role === 'manager').length;
  const criticalEvasion = behaviorSignals.some((s) => s.evasion) && String(reasonCode || '').startsWith('CRITICAL_EVASION');

  let score = 82;
  score -= toxicCount * 28;
  score -= lowEffortCount * 12;
  score -= evasionCount * 10;
  score -= highSeverityCount * 10;
  score -= prohibitedUnique * 6;
  if (turns >= 4) score += 5;
  if (turns >= 7) score += 3;
  if (forcedFail) score = Math.min(score, toxicCount > 0 ? 18 : criticalEvasion ? 28 : 35);
  score = Math.max(0, Math.min(100, Math.round(score)));

  const verdict: 'pass' | 'fail' = forcedFail || score < 60 ? 'fail' : 'pass';
  const qualityTag =
    score >= 80 ? 'Хорошо' : score >= 60 ? 'Средне' : 'Нужно улучшить';

  const strengths: string[] = [];
  if (toxicCount === 0) strengths.push('Корректный тон общения');
  if (lowEffortCount <= 1) strengths.push('Ответы в основном содержательные');
  if (evasionCount === 0) strengths.push('Не уходили от ключевых вопросов клиента');
  if (!strengths.length) strengths.push('Диалог состоялся, можно улучшать качество обработки возражений');

  const weaknesses: string[] = [];
  if (lowEffortCount > 0) weaknesses.push(`Короткие/слабые ответы: ${lowEffortCount}`);
  if (evasionCount > 0) weaknesses.push(`Уход от вопросов клиента: ${evasionCount}`);
  if (prohibitedUnique > 0) weaknesses.push('Использовались нежелательные формулировки');
  if (toxicCount > 0) weaknesses.push('Нарушен тон коммуникации');
  if (!weaknesses.length) weaknesses.push('Существенных провалов в коммуникации не обнаружено');

  const recommendations: string[] = [];
  if (lowEffortCount > 0) recommendations.push('Давать развёрнутый ответ на каждый вопрос клиента');
  if (evasionCount > 0) recommendations.push('Не уходить от прямых вопросов, сначала закрывать их');
  if (prohibitedUnique > 0) recommendations.push('Убрать фразы вроде "посмотрите на сайте"/"я не знаю"');
  if (toxicCount > 0) recommendations.push('Сохранять вежливый и уважительный тон в любых ситуациях');
  if (!recommendations.length) recommendations.push('Поддерживать текущий уровень и фокусироваться на закрытии на следующий шаг');

  const summary =
    verdict === 'pass'
      ? 'Тестирование завершено успешно. Менеджер удержал диалог и дал приемлемые ответы.'
      : 'Тестирование завершено с отрицательным результатом. Качество ответов и ведения диалога требует улучшения.';

  return {
    verdict,
    totalScore: score,
    qualityTag,
    summary,
    strengths,
    weaknesses,
    recommendations,
    reasonCode,
  };
}

// Resolve absolute path to public/index.html (works for tsx and compiled)
function getIndexPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'public', 'index.html'),
    path.resolve(__dirname, '..', 'public', 'index.html'),
    path.resolve(__dirname, '..', '..', 'public', 'index.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const INDEX_HTML_PATH = getIndexPath();

/** Only show attempts that were properly evaluated (have score, evaluation result, or error) — excludes empty force-closed sessions */
const completedWithDataWhere = {
  status: 'completed' as const,
  OR: [
    { totalScore: { not: null } },
    { evaluationResultJson: { not: null } },
    { evaluationError: { not: null } },
  ],
};

if (!INDEX_HTML_PATH) {
  console.error('[ERROR] public/index.html not found. Checked:', path.resolve(process.cwd(), 'public'), path.resolve(__dirname, '..', 'public'));
} else {
  console.log('[OK] Mini App index:', INDEX_HTML_PATH);
}

// Static files
const publicPath = path.resolve(process.cwd(), 'public');
const publicPathAlt = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicPath));
if (publicPathAlt !== publicPath) {
  app.use(express.static(publicPathAlt));
}

// Friendly error page (Russian)
function sendErrorHtml(res: express.Response, status: number, title: string, message: string) {
  res.status(status).type('html').send(`
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sales Boost</title></head>
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:20px;background:#1a1a2e;color:#eee;">
<h1 style="color:#fff;">${title}</h1>
<p>${message}</p>
<p style="color:#888;font-size:14px;">Проверьте, что бот запущен (npm run dev) и туннель активен. Откройте /admin в боте снова.</p>
</body></html>
  `);
}

function buildVoiceCallDetailResponse(session: {
  id: number;
  callId: string;
  to: string;
  scenario: string | null;
  startedAt: Date;
  endedAt: Date | null;
  outcome: string | null;
  durationSec: number | null;
  transcriptJson: string | null;
  evaluationJson: string | null;
  totalScore: number | null;
  failureReason: string | null;
}) {
  const transcript = session.transcriptJson
    ? (JSON.parse(session.transcriptJson) as Array<{ role: string; text: string }>)
    : [];
  let evaluation: Record<string, unknown> | null = null;
  if (session.evaluationJson) {
    try {
      evaluation = JSON.parse(session.evaluationJson) as Record<string, unknown>;
    } catch (_) {}
  }
  const callSummary =
    evaluation && (evaluation as any).call_summary && typeof (evaluation as any).call_summary === 'object'
      ? (evaluation as any).call_summary
      : null;
  const replyImprovements =
    evaluation && Array.isArray((evaluation as any).reply_improvements)
      ? (evaluation as any).reply_improvements
      : null;
  const score = session.totalScore ?? (evaluation && typeof (evaluation as any).overall_score_0_100 === 'number'
    ? (evaluation as any).overall_score_0_100
    : null);
  const checklist = evaluation && Array.isArray((evaluation as any).checklist) ? (evaluation as any).checklist : [];
  const issues = evaluation && Array.isArray((evaluation as any).issues) ? (evaluation as any).issues : [];
  const recommendations = evaluation && Array.isArray((evaluation as any).recommendations) ? (evaluation as any).recommendations : [];
  const dimensionScoresRaw = evaluation && (evaluation as any).dimension_scores ? (evaluation as any).dimension_scores : null;
  const dimensionScores =
    Array.isArray(checklist) && checklist.length > 0
      ? computeUiDimensionScoresFromChecklist(checklist as Array<{ code?: string; status?: string }>, dimensionScoresRaw)
      : dimensionScoresRaw;
  const qualityTag = score != null ? (score >= 76 ? 'Хорошо' : score >= 50 ? 'Средне' : 'Плохо') : null;
  const ended = !!session.endedAt;
  const hasEval = !!session.evaluationJson;
  const endedAtMs = session.endedAt ? session.endedAt.getTime() : null;
  const ageSec = endedAtMs != null ? (Date.now() - endedAtMs) / 1000 : null;
  const isRecent = ageSec != null && ageSec >= 0 && ageSec < 120;
  const isProcessing = ended && !hasEval && !session.failureReason && (transcript.length >= 2 || isRecent);
  const processingStage = !ended || hasEval || !isProcessing ? null : (transcript.length >= 2 ? 'evaluation' : 'transcript');

  return {
    id: session.id,
    callId: session.callId,
    to: session.to,
    scenario: session.scenario,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    outcome: session.outcome,
    durationSec: session.durationSec,
    transcript,
    transcriptTurns: transcript.length,
    hasEvaluation: !!session.evaluationJson,
    isProcessing,
    processingStage,
    processingError: session.failureReason,
    totalScore: score,
    qualityTag,
    dimensionScores,
    checklist,
    issues,
    recommendations,
    callSummary,
    replyImprovements,
    strengths: checklist.filter((c: any) => c.status === 'YES').map((c: any) => c.comment || c.code),
    weaknesses: issues.map((i: any) => (i.recommendation || i.issue_type) || ''),
  };
}

// Health check: verify server is running (e.g. curl http://localhost:3000/health)
app.get('/health', (_req, res) => {
  res.json({ ok: true, message: 'Sales Boost server is running' });
});

// Voice call dialog: Voximplant scenario sends ASR text here, we return LLM reply for TTS
app.post('/voice/dialog', (req, res) => {
  console.log('[voice/dialog] POST received');
  handleVoiceDialog(req, res).catch((err) => {
    console.error('[voice/dialog] Unhandled:', err);
    res.status(500).json({ error: 'Internal error', reply_text: 'Здравствуйте, произошла ошибка. Попробуйте позже.', end_session: false });
  });
});

// ── Web training API: start session ──
app.post('/api/training/web/start', async (req, res) => {
  try {
    const body = req.body || {};
    const strictness = (body.strictness ?? 'medium') as Strictness;
    const profile = (body.profile ?? 'normal') as WebTrainingProfile;
    const replyMode = (body.replyMode ?? 'text') as 'text' | 'text+voice';
    const ttsVoice = (body.voice ?? 'male') as TtsVoice;

    const car = loadCar();
    const baseState = getDefaultState(profile);
    const max_client_turns =
      strictness === 'low' ? 8 : strictness === 'high' ? 14 : baseState.strictnessState.max_client_turns;

    const state = {
      ...baseState,
      strictnessState: { strictness, max_client_turns },
    };

    const sessionId = createWebSessionId();
    const dealership = buildDealershipFromCar(car);

    const out = await getVirtualClientReply({
      car,
      dealership,
      state,
      manager_last_message: '',
      dialog_history: [],
      strictness,
      max_client_turns,
    });

    const nextState = {
      ...state,
      stage: out.update_state.stage,
      checklist: { ...state.checklist, ...out.update_state.checklist },
      notes: out.update_state.notes,
      client_turns: out.update_state.client_turns,
    };

    webTrainingSessions.set(sessionId, {
      id: sessionId,
      strictness,
      profile,
      state: nextState,
      car,
      dialogHistory: [{ role: 'client', content: out.client_message }],
      behaviorSignals: [],
    });

    let audioBase64: string | null = null;
    if (replyMode === 'text+voice' && out.client_message.trim()) {
      try {
        const buf = await generateSpeechBuffer(out.client_message, ttsVoice);
        if (buf.length) {
          audioBase64 = buf.toString('base64');
        }
      } catch (e) {
        console.error('[web-training] TTS start error:', e);
      }
    }

    res.json({
      sessionId,
      clientMessage: out.client_message,
      endConversation: out.end_conversation ?? false,
      audioBase64,
    });
  } catch (error) {
    console.error('[web-training] start error:', error);
    const msg = error instanceof Error ? error.message : String(error);

    // Максимально безопасный fallback: просто текст без внешних вызовов
    res.json({
      sessionId: null,
      clientMessage:
        'Сейчас тренажёр недоступен локально (ошибка подключения к AI‑клиенту). ' +
        'Интерфейс работает, но диалог с клиентом мы сможем полностью включить уже на проде.',
      endConversation: true,
      audioBase64: null,
      warning:
        'Локальный режим без OpenAI: запрос к виртуальному клиенту не выполнен. ' +
        'Подключим полноценного клиента на продакшене.',
      error: msg,
    });
  }
});

// ── Web training API: manager message ──
app.post('/api/training/web/message', async (req, res) => {
  try {
    const body = req.body || {};
    const { sessionId, message } = body as { sessionId?: string; message?: string };
    const replyMode = (body.replyMode ?? 'text') as 'text' | 'text+voice';
    const ttsVoice = (body.voice ?? 'male') as TtsVoice;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Пустое сообщение' });
    }

    if (!webTrainingSessions.has(sessionId)) {
      return res.status(404).json({ error: 'Сессия не найдена или истекла' });
    }

    const out = await runWebTrainingTurn({
      sessionId,
      message,
      replyMode,
      ttsVoice,
    });

    res.json(out);
  } catch (error) {
    console.error('[web-training] message error:', error);
    const msg = error instanceof Error ? error.message : String(error);

    res.json({
      clientMessage:
        'Диалог сейчас недоступен из‑за ошибки подключения к AI‑клиенту. ' +
        'Но интерфейс теста уже готов — в продакшене он будет работать как в Telegram.',
      endConversation: true,
      audioBase64: null,
      warning:
        'Локальный режим без OpenAI: сообщения не обрабатываются. ' +
        'Полноценный диалог включим на боевом сервере.',
      error: msg,
    });
  }
});

// ── Web training API: manager voice message ──
app.post('/api/training/web/voice-message', async (req, res) => {
  try {
    const body = req.body || {};
    const { sessionId, audioBase64, mimeType } = body as {
      sessionId?: string;
      audioBase64?: string;
      mimeType?: string;
    };
    const replyMode = (body.replyMode ?? 'text+voice') as 'text' | 'text+voice';
    const ttsVoice = (body.voice ?? 'male') as TtsVoice;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return res.status(400).json({ error: 'audioBase64 обязателен' });
    }
    if (!webTrainingSessions.has(sessionId)) {
      return res.status(404).json({ error: 'Сессия не найдена или истекла' });
    }

    const ext = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'm4a' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `web-voice-${Date.now()}.${ext}`);
    const buf = Buffer.from(audioBase64, 'base64');
    await fs.promises.writeFile(tmpPath, buf);

    let managerText = '';
    try {
      managerText = await transcribeVoice(tmpPath);
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }

    if (!managerText.trim()) {
      return res.status(400).json({ error: 'Не удалось распознать голосовое сообщение' });
    }

    const out = await runWebTrainingTurn({
      sessionId,
      message: managerText,
      replyMode,
      ttsVoice,
    });

    res.json({ ...out, managerTranscript: managerText });
  } catch (error) {
    console.error('[web-training] voice-message error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    res.json({
      clientMessage:
        'Сейчас не удалось обработать голос на локальном стенде, но интерфейс работает. ' +
        'В продакшене ответ будет как в Telegram.',
      endConversation: true,
      audioBase64: null,
      warning:
        'Локальный fallback: проверьте доступ к OpenAI/STT (VPN/прокси). ' +
        'Диалог завершён, чтобы избежать повторных ошибок.',
      error: msg || 'Ошибка обработки голосового сообщения',
    });
  }
});

// Prevent caching of index.html so users always get latest app after deploy/refresh
function sendIndexHtml(res: express.Response) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  return res.sendFile(INDEX_HTML_PATH!);
}

// Explicit root: always serve Mini App
app.get('/', (req, res) => {
  if (INDEX_HTML_PATH) {
    try {
      return sendIndexHtml(res);
    } catch (err) {
      console.error('Error sending index.html:', err);
      sendErrorHtml(res, 500, 'Ошибка загрузки', 'Не удалось отдать страницу приложения. См. логи сервера.');
      return;
    }
  }
  sendErrorHtml(res, 404, 'Файл не найден', 'Файл public/index.html не найден. Убедитесь, что папка public и index.html есть в проекте.');
});

app.post('/api/auth/login', (req, res) => {
  handleAuthLogin(req, res).catch((error) => {
    console.error('Auth login error:', error);
    res.status(500).json({ error: 'Ошибка авторизации. Попробуйте позже.' });
  });
});

app.get('/api/auth/me', (req, res) => {
  handleAuthMe(req, res).catch((error) => {
    console.error('Auth me error:', error);
    res.status(500).json({ error: 'Ошибка проверки сессии. Попробуйте позже.' });
  });
});

// API endpoint to verify admin and get data
app.get('/api/admin/verify', async (req, res) => {
  try {
    if (req.get('authorization')?.startsWith('Bearer ')) {
      await handleAuthMe(req, res);
      return;
    }

    const { initData } = req.query;
    const isLocalhost = ['127.0.0.1', '::1', 'localhost'].includes(req.ip || '') ||
      (req.get('host') || '').startsWith('localhost');

    // Dev bypass: on localhost with ALLOW_DEV_ADMIN=true, allow without Telegram
    if (!initData && config.allowDevAdmin && isLocalhost) {
      return res.json({
        success: true,
        user: { id: 'dev', username: 'dev', firstName: 'Локальный доступ (dev)' },
      });
    }

    if (!initData) {
      return res.status(401).json({
        error: 'Нет данных авторизации. Откройте панель через кнопку «Открыть Админ-панель» в чате с ботом (напишите /admin). В браузере напрямую панель не авторизуется.',
      });
    }

    const params = new URLSearchParams(initData as string);
    const userStr = params.get('user');
    if (!userStr) {
      return res.status(401).json({ error: 'Неверные данные Telegram. Откройте панель из чата с ботом (/admin).' });
    }

    const user = JSON.parse(userStr);
    const telegramId = user.id?.toString();
    const username = user.username?.toLowerCase();

    if (!telegramId) {
      return res.status(401).json({ error: 'Не удалось определить пользователя.' });
    }

    const isAdmin = config.adminIdentifiers.includes(telegramId) ||
      (username && (
        config.adminIdentifiers.includes(username) ||
        config.adminIdentifiers.includes(`@${username}`)
      ));

    if (!isAdmin) {
      return res.status(403).json({ error: 'Нет доступа. Ваш Telegram не в списке администраторов (ADMIN_TELEGRAM_IDS в .env).' });
    }

    res.json({
      success: true,
      user: {
        id: telegramId,
        username: user.username,
        firstName: user.first_name,
      },
    });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ error: 'Ошибка сервера. Попробуйте позже.' });
  }
});

app.use('/api/admin', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Admin API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
});

app.use('/api/imports', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Imports API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
});

app.post('/api/imports/analyze-source', (req, res) => {
  handleAnalyzeImportSource(req, res).catch((error) => {
    console.error('Analyze import source error:', error);
    res.status(500).json({ error: 'Не удалось проанализировать источник.' });
  });
});

app.post('/api/imports/generate-tag-rule', (req, res) => {
  handleGenerateImportTagRule(req, res).catch((error) => {
    console.error('Generate import tag rule error:', error);
    res.status(500).json({ error: 'Не удалось сформировать правило.' });
  });
});

app.post('/api/imports/generate-tag-rules', (req, res) => {
  handleGenerateImportTagRules(req, res).catch((error) => {
    console.error('Generate import tag rules error:', error);
    res.status(500).json({ error: 'Не удалось сформировать правила.' });
  });
});

app.post('/api/imports/test-tag-rules', (req, res) => {
  handleTestImportTagRules(req, res).catch((error) => {
    console.error('Test import tag rules error:', error);
    res.status(500).json({ error: 'Не удалось протестировать правила тегов.' });
  });
});

app.post('/api/imports/preview', (req, res) => {
  handlePreviewImportConfig(req, res).catch((error) => {
    console.error('Preview import config error:', error);
    res.status(500).json({ error: 'Не удалось построить preview.' });
  });
});

app.get('/api/imported-items/tags', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Imported tags API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
}, (req, res) => {
  handleListImportedTags(req, res).catch((error) => {
    console.error('List imported tags error:', error);
    res.status(500).json({ error: 'Не удалось загрузить теги.' });
  });
});

app.get('/api/imported-items', (req, res, next) => {
  adminApiAuthMiddleware(req, res, next).catch((error) => {
    console.error('Imported items API auth error:', error);
    res.status(500).json({ error: 'Ошибка проверки доступа. Попробуйте позже.' });
  });
}, (req, res) => {
  handleListImportedItems(req, res).catch((error) => {
    console.error('List imported items error:', error);
    res.status(500).json({ error: 'Не удалось загрузить данные.' });
  });
});

app.get('/api/imports', (req, res) => {
  handleListImports(req, res).catch((error) => {
    console.error('List imports error:', error);
    res.status(500).json({ error: 'Не удалось загрузить импорты.' });
  });
});

app.get('/api/admin/call-settings/customer-profiles', (req, res) => {
  handleListCallCustomerProfiles(req, res).catch((error) => {
    console.error('List call customer profiles error:', error);
    res.status(500).json({ error: 'Не удалось загрузить профили клиентов.' });
  });
});

app.post('/api/admin/call-settings/customer-profiles', (req, res) => {
  handleCreateCallCustomerProfile(req, res).catch((error) => {
    console.error('Create call customer profile error:', error);
    res.status(500).json({ error: 'Не удалось создать профиль клиента.' });
  });
});

app.patch('/api/admin/call-settings/customer-profiles/:id', (req, res) => {
  handleUpdateCallCustomerProfile(req, res).catch((error) => {
    console.error('Update call customer profile error:', error);
    res.status(500).json({ error: 'Не удалось обновить профиль клиента.' });
  });
});

app.delete('/api/admin/call-settings/customer-profiles/:id', (req, res) => {
  handleDeleteCallCustomerProfile(req, res).catch((error) => {
    console.error('Delete call customer profile error:', error);
    res.status(500).json({ error: 'Не удалось удалить профиль клиента.' });
  });
});

app.get('/api/admin/call-settings/scripts', (req, res) => {
  handleListCallScripts(req, res).catch((error) => {
    console.error('List call scripts error:', error);
    res.status(500).json({ error: 'Не удалось загрузить скрипты.' });
  });
});

app.post('/api/admin/call-settings/scripts', (req, res) => {
  handleCreateCallScript(req, res).catch((error) => {
    console.error('Create call script error:', error);
    res.status(500).json({ error: 'Не удалось создать скрипт.' });
  });
});

app.patch('/api/admin/call-settings/scripts/:id', (req, res) => {
  handleUpdateCallScript(req, res).catch((error) => {
    console.error('Update call script error:', error);
    res.status(500).json({ error: 'Не удалось обновить скрипт.' });
  });
});

app.delete('/api/admin/call-settings/scripts/:id', (req, res) => {
  handleDeleteCallScript(req, res).catch((error) => {
    console.error('Delete call script error:', error);
    res.status(500).json({ error: 'Не удалось удалить скрипт.' });
  });
});

app.get('/api/admin/call-settings/plan-options', (req, res) => {
  handleGetCallPlanOptions(req, res).catch((error) => {
    console.error('Get call plan options error:', error);
    res.status(500).json({ error: 'Не удалось загрузить данные плана прозвона.' });
  });
});

app.get('/api/admin/call-settings/plans', (req, res) => {
  handleListCallPlans(req, res).catch((error) => {
    console.error('List call plans error:', error);
    res.status(500).json({ error: 'Не удалось загрузить планы прозвона.' });
  });
});

app.post('/api/admin/call-settings/plans', (req, res) => {
  handleCreateCallPlan(req, res).catch((error) => {
    console.error('Create call plan error:', error);
    res.status(500).json({ error: 'Не удалось создать план прозвона.' });
  });
});

app.post('/api/admin/call-settings/plans/:id/initiate', (req, res) => {
  handleInitiateCallPlan(req, res).catch((error) => {
    console.error('Initiate call plan error:', error);
    res.status(500).json({ error: 'Не удалось инициировать прозвон.' });
  });
});

app.get('/api/admin/call-settings/plans/:id/prompt-preview', (req, res) => {
  handlePreviewCallPlanPrompt(req, res).catch((error) => {
    console.error('Preview call plan prompt error:', error);
    res.status(500).json({ error: 'Не удалось сгенерировать промпт.' });
  });
});

app.get('/api/admin/call-settings/plans/:id/calls', (req, res) => {
  handleListCallPlanCalls(req, res).catch((error) => {
    console.error('List call plan calls error:', error);
    res.status(500).json({ error: 'Не удалось загрузить историю прозвона.' });
  });
});

app.post('/api/imports', (req, res) => {
  handleCreateImport(req, res).catch((error) => {
    console.error('Create import error:', error);
    res.status(500).json({ error: 'Не удалось создать импорт.' });
  });
});

app.get('/api/imports/:id', (req, res) => {
  handleGetImport(req, res).catch((error) => {
    console.error('Get import error:', error);
    res.status(500).json({ error: 'Не удалось загрузить импорт.' });
  });
});

app.patch('/api/imports/:id', (req, res) => {
  handleUpdateImport(req, res).catch((error) => {
    console.error('Update import error:', error);
    res.status(500).json({ error: 'Не удалось обновить импорт.' });
  });
});

app.delete('/api/imports/:id', (req, res) => {
  handleDeleteImport(req, res).catch((error) => {
    console.error('Delete import error:', error);
    res.status(500).json({ error: 'Не удалось удалить импорт.' });
  });
});

app.post('/api/imports/:id/run', (req, res) => {
  handleRunImport(req, res).catch((error) => {
    console.error('Run import error:', error);
    res.status(500).json({ error: 'Не удалось запустить импорт.' });
  });
});

app.get('/api/admin/rbac/meta', (req, res) => {
  handleRbacMeta(req, res).catch((error) => {
    console.error('RBAC meta error:', error);
    res.status(500).json({ error: 'Не удалось загрузить RBAC-метаданные.' });
  });
});

app.get('/api/admin/holdings', (req, res) => {
  handleListHoldings(req, res).catch((error) => {
    console.error('List holdings error:', error);
    res.status(500).json({ error: 'Не удалось загрузить компании.' });
  });
});

app.get('/api/admin/cities', (req, res) => {
  handleListCities(req, res).catch((error) => {
    console.error('List cities route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить города.' });
  });
});

app.post('/api/admin/holdings', (req, res) => {
  handleCreateHolding(req, res).catch((error) => {
    console.error('Create holding route error:', error);
    res.status(500).json({ error: 'Не удалось создать компанию.' });
  });
});

app.patch('/api/admin/holdings/:holdingId', (req, res) => {
  handleUpdateHolding(req, res).catch((error) => {
    console.error('Update holding route error:', error);
    res.status(500).json({ error: 'Не удалось обновить компанию.' });
  });
});

app.delete('/api/admin/holdings/:holdingId', (req, res) => {
  handleDeleteHolding(req, res).catch((error) => {
    console.error('Delete holding route error:', error);
    res.status(500).json({ error: 'Не удалось удалить компанию.' });
  });
});

app.get('/api/admin/dealerships', (req, res) => {
  handleListDealerships(req, res).catch((error) => {
    console.error('List dealerships error:', error);
    res.status(500).json({ error: 'Не удалось загрузить точки.' });
  });
});

app.post('/api/admin/dealerships', (req, res) => {
  handleCreateDealership(req, res).catch((error) => {
    console.error('Create dealership route error:', error);
    res.status(500).json({ error: 'Не удалось создать точку.' });
  });
});

app.patch('/api/admin/dealerships/:dealershipId', (req, res) => {
  handleUpdateDealership(req, res).catch((error) => {
    console.error('Update dealership route error:', error);
    res.status(500).json({ error: 'Не удалось обновить точку.' });
  });
});

app.delete('/api/admin/dealerships/:dealershipId', (req, res) => {
  handleDeleteDealership(req, res).catch((error) => {
    console.error('Delete dealership route error:', error);
    res.status(500).json({ error: 'Не удалось удалить точку.' });
  });
});

app.get('/api/admin/dealership-directions', (req, res) => {
  handleListDealershipDirections(req, res).catch((error) => {
    console.error('List dealership directions route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить направления точек.' });
  });
});

app.post('/api/admin/dealership-directions', (req, res) => {
  handleCreateDealershipDirection(req, res).catch((error) => {
    console.error('Create dealership direction route error:', error);
    res.status(500).json({ error: 'Не удалось создать направление точки.' });
  });
});

app.patch('/api/admin/dealership-directions/:directionId', (req, res) => {
  handleUpdateDealershipDirection(req, res).catch((error) => {
    console.error('Update dealership direction route error:', error);
    res.status(500).json({ error: 'Не удалось обновить направление точки.' });
  });
});

app.delete('/api/admin/dealership-directions/:directionId', (req, res) => {
  handleDeleteDealershipDirection(req, res).catch((error) => {
    console.error('Delete dealership direction route error:', error);
    res.status(500).json({ error: 'Не удалось удалить направление точки.' });
  });
});

app.get('/api/admin/phone-number-types', (req, res) => {
  handleListPhoneNumberTypes(req, res).catch((error) => {
    console.error('List phone number types route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить типы номеров.' });
  });
});

app.post('/api/admin/phone-number-types', (req, res) => {
  handleCreatePhoneNumberType(req, res).catch((error) => {
    console.error('Create phone number type route error:', error);
    res.status(500).json({ error: 'Не удалось создать тип номера.' });
  });
});

app.patch('/api/admin/phone-number-types/:typeId', (req, res) => {
  handleUpdatePhoneNumberType(req, res).catch((error) => {
    console.error('Update phone number type route error:', error);
    res.status(500).json({ error: 'Не удалось обновить тип номера.' });
  });
});

app.get('/api/admin/dealerships/:dealershipId/phone-numbers', (req, res) => {
  handleListDealershipPhoneNumbers(req, res).catch((error) => {
    console.error('List dealership phone numbers route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить номера телефонов.' });
  });
});

app.post('/api/admin/dealerships/:dealershipId/phone-numbers', (req, res) => {
  handleCreateDealershipPhoneNumber(req, res).catch((error) => {
    console.error('Create dealership phone number route error:', error);
    res.status(500).json({ error: 'Не удалось добавить номер телефона.' });
  });
});

app.patch('/api/admin/dealership-phone-numbers/:phoneNumberId', (req, res) => {
  handleUpdateDealershipPhoneNumber(req, res).catch((error) => {
    console.error('Update dealership phone number route error:', error);
    res.status(500).json({ error: 'Не удалось обновить номер телефона.' });
  });
});

app.delete('/api/admin/dealership-phone-numbers/:phoneNumberId', (req, res) => {
  handleDeleteDealershipPhoneNumber(req, res).catch((error) => {
    console.error('Delete dealership phone number route error:', error);
    res.status(500).json({ error: 'Не удалось удалить номер телефона.' });
  });
});

app.post('/api/admin/organization/sync-mock', (req, res) => {
  handleSyncMockOrganization(req, res).catch((error) => {
    console.error('Sync mock organization route error:', error);
    res.status(500).json({ error: 'Не удалось синхронизировать оргструктуру.' });
  });
});

app.get('/api/admin/users', (req, res) => {
  handleListUsers(req, res).catch((error) => {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Не удалось загрузить пользователей.' });
  });
});

app.post('/api/admin/users', (req, res) => {
  handleCreateUser(req, res).catch((error) => {
    console.error('Create user route error:', error);
    res.status(500).json({ error: 'Не удалось создать пользователя.' });
  });
});

app.patch('/api/admin/users/:accountId', (req, res) => {
  handleUpdateUser(req, res).catch((error) => {
    console.error('Update user route error:', error);
    res.status(500).json({ error: 'Не удалось обновить пользователя.' });
  });
});

app.post('/api/admin/me/password', (req, res) => {
  handleChangeOwnPassword(req, res).catch((error) => {
    console.error('Change own password route error:', error);
    res.status(500).json({ error: 'Не удалось изменить пароль.' });
  });
});

app.post('/api/admin/users/:accountId/password', (req, res) => {
  handleChangeUserPassword(req, res).catch((error) => {
    console.error('Change user password route error:', error);
    res.status(500).json({ error: 'Не удалось изменить пароль пользователя.' });
  });
});

app.delete('/api/admin/users/:accountId', (req, res) => {
  handleDeleteUser(req, res).catch((error) => {
    console.error('Delete user route error:', error);
    res.status(500).json({ error: 'Не удалось удалить пользователя.' });
  });
});

app.get('/api/admin/users/:accountId/phone-numbers', (req, res) => {
  handleListUserPhoneNumbers(req, res).catch((error) => {
    console.error('List user phone numbers route error:', error);
    res.status(500).json({ error: 'Не удалось загрузить номера телефонов.' });
  });
});

app.post('/api/admin/users/:accountId/phone-numbers', (req, res) => {
  handleCreateUserPhoneNumber(req, res).catch((error) => {
    console.error('Create user phone number route error:', error);
    res.status(500).json({ error: 'Не удалось добавить номер телефона.' });
  });
});

app.patch('/api/admin/user-phone-numbers/:phoneNumberId', (req, res) => {
  handleUpdateUserPhoneNumber(req, res).catch((error) => {
    console.error('Update user phone number route error:', error);
    res.status(500).json({ error: 'Не удалось обновить номер телефона.' });
  });
});

app.delete('/api/admin/user-phone-numbers/:phoneNumberId', (req, res) => {
  handleDeleteUserPhoneNumber(req, res).catch((error) => {
    console.error('Delete user phone number route error:', error);
    res.status(500).json({ error: 'Не удалось удалить номер телефона.' });
  });
});

app.get('/api/admin/permission-templates', (req, res) => {
  handleListPermissionTemplates(req, res).catch((error) => {
    console.error('List permission templates error:', error);
    res.status(500).json({ error: 'Не удалось загрузить шаблоны прав.' });
  });
});

app.post('/api/admin/permission-templates', (req, res) => {
  handleCreatePermissionTemplate(req, res).catch((error) => {
    console.error('Create permission template error:', error);
    res.status(500).json({ error: 'Не удалось создать шаблон прав.' });
  });
});

app.patch('/api/admin/permission-templates/:templateId', (req, res) => {
  handleUpdatePermissionTemplate(req, res).catch((error) => {
    console.error('Update permission template error:', error);
    res.status(500).json({ error: 'Не удалось обновить шаблон прав.' });
  });
});

app.delete('/api/admin/permission-templates/:templateId', (req, res) => {
  handleDeletePermissionTemplate(req, res).catch((error) => {
    console.error('Delete permission template error:', error);
    res.status(500).json({ error: 'Не удалось удалить шаблон прав.' });
  });
});

// Get training session details (V2 evaluation-aware)
app.get('/api/admin/training-sessions/:sessionId', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const session = await prisma.trainingSession.findUnique({
      where: { id: sessionId },
      include: {
        user: true,
        messages: { orderBy: { createdAt: 'asc' as const } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const isFailed = session.status === 'failed';
    const hasV2Eval = session.evaluationJson != null;
    const hasLegacyAssessment = session.assessmentScore != null && session.assessmentJson != null;

    // Build conversation steps from messages (sequential pairs)
    const msgs = session.messages;
    const conversationPairs: Array<{ order: number; customerMessage: string; answer: string }> = [];
    for (let i = 0; i + 1 < msgs.length; i += 2) {
      if (msgs[i].role === 'client' && msgs[i + 1].role === 'manager') {
        conversationPairs.push({
          order: conversationPairs.length + 1,
          customerMessage: msgs[i].content,
          answer: msgs[i + 1].content,
        });
      }
    }

    // Collect behavior signals from manager messages (V2)
    const managerMsgs = msgs.filter(m => m.role === 'manager' && m.qualitySignalJson);
    let behaviorSummary: any = null;
    if (managerMsgs.length > 0) {
      let toxicCount = 0;
      let lowEffortCount = 0;
      let evasionCount = 0;
      const allProhibited: string[] = [];
      for (const m of managerMsgs) {
        try {
          const sig = JSON.parse(m.qualitySignalJson!);
          if (sig.toxic) toxicCount++;
          if (sig.low_effort) lowEffortCount++;
          if (sig.evasion) evasionCount++;
          if (Array.isArray(sig.prohibited_phrase_hits)) allProhibited.push(...sig.prohibited_phrase_hits);
        } catch { /* skip */ }
      }
      behaviorSummary = {
        totalManagerMessages: managerMsgs.length,
        toxicCount,
        lowEffortCount,
        evasionCount,
        prohibitedPhrases: [...new Set(allProhibited)],
      };
    }

    if (hasV2Eval) {
      // ── V2 evaluation response ──
      const evalData = JSON.parse(session.evaluationJson as string);
      const score = evalData.overall_score_0_100 ?? session.totalScore ?? 0;
      const level = scoreToLevel(score);
      const qualityTag = isFailed ? 'Плохо' : scoreToQualityTag(score);

      const checklistItems = Array.isArray(evalData.checklist) ? evalData.checklist : [];
      const issues = Array.isArray(evalData.issues) ? evalData.issues : [];
      const recommendations = Array.isArray(evalData.recommendations) ? evalData.recommendations : [];

      const steps = conversationPairs.map((p) => {
        return {
          order: p.order,
          customerMessage: p.customerMessage,
          answer: p.answer,
          score: null,
          feedback: null,
          betterExample: null,
          criteriaScores: {} as Record<string, number>,
        };
      });

      return res.json({
        type: 'training',
        id: session.id,
        userName: session.user.fullName,
        testTitle: 'Тренировка с виртуальным клиентом',
        clientProfile: (session as any).clientProfile ?? 'normal',
        startedAt: session.createdAt,
        finishedAt: session.completedAt,
        totalScore: score,
        level,
        qualityTag,
        failureReason: session.failureReason,
        failureReasonLabel: isFailed ? getFailureReasonLabel(session.failureReason) : null,
        dimensionScores: evalData.dimension_scores ?? null,
        checklist: checklistItems,
        issues,
        strengths: checklistItems
          .filter((c: any) => c.status === 'YES')
          .map((c: any) => c.comment || c.code),
        weaknesses: issues.map((i: any) => i.recommendation || i.issue_type),
        recommendations,
        behaviorSummary,
        steps,
      });
    }

    // ── Legacy assessment fallback ──
    const data = hasLegacyAssessment ? JSON.parse(session.assessmentJson as string) : {};
    const score = hasLegacyAssessment ? (session.assessmentScore as number) : 0;
    const level = hasLegacyAssessment ? scoreToLevel(score) : null;
    const qualityTag = isFailed ? 'Плохо' : scoreToQualityTag(score);
    const assessmentSteps = (data.steps || []) as Array<{
      step_order: number;
      step_score: number;
      feedback?: string;
      better_example?: string;
    }>;
    const globalImprovements: string[] = Array.isArray(data.improvements)
      ? (data.improvements as string[])
      : [];

    const steps = conversationPairs.map((p) => {
      const stepData = assessmentSteps.find((s) => s.step_order === p.order);
      if (!stepData) {
        const genericImprovement =
          globalImprovements[0] ||
          'Ответить подробнее и сфокусироваться на пользе для клиента и следующем шаге.';
        return {
          order: p.order,
          customerMessage: p.customerMessage,
          answer: p.answer,
          score: 0,
          feedback:
            'Этот ответ не был отдельно оценён моделью. ' +
            `Общая рекомендация: ${genericImprovement}`,
          betterExample: genericImprovement,
          criteriaScores: {} as Record<string, number>,
        };
      }
      return {
        order: p.order,
        customerMessage: p.customerMessage,
        answer: p.answer,
        score: stepData.step_score ?? 0,
        feedback: stepData.feedback ?? null,
        betterExample: stepData.better_example ?? null,
        criteriaScores: {} as Record<string, number>,
      };
    });

    res.json({
      type: 'training',
      id: session.id,
      userName: session.user.fullName,
      testTitle: 'Тренировка с виртуальным клиентом',
      clientProfile: (session as any).clientProfile ?? 'normal',
      startedAt: session.createdAt,
      finishedAt: session.completedAt,
      totalScore: hasLegacyAssessment ? session.assessmentScore : isFailed ? 0 : null,
      level,
      qualityTag,
      failureReason: session.failureReason,
      failureReasonLabel: isFailed ? getFailureReasonLabel(session.failureReason) : null,
      dimensionScores: null,
      checklist: [],
      issues: [],
      strengths: [],
      weaknesses: data.mistakes || [],
      recommendations: data.improvements || [],
      behaviorSummary,
      steps,
    });
  } catch (error) {
    console.error('Get training session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single attempt details with full feedback (must come before /api/admin/attempts)
app.get('/api/admin/attempts/:attemptId', async (req, res) => {
  try {
    const attemptId = parseInt(req.params.attemptId);
    const attempt = await prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        user: true,
        test: true,
        answers: {
          include: {
            step: true,
          },
          orderBy: {
            step: {
              order: 'asc',
            },
          },
        },
      },
    });

    if (!attempt) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Only serve attempts with meaningful data (exclude empty force-closed sessions)
    const hasData =
      attempt.totalScore != null ||
      attempt.evaluationResultJson != null ||
      attempt.evaluationError != null;
    if (!hasData) {
      return res.status(404).json({ error: 'Attempt has no evaluation data' });
    }

    let steps: Array<{
      order: number;
      customerMessage: string;
      stepGoal?: string;
      answer: string;
      score: number | null;
      feedback: string | null;
      betterExample: string | null;
      criteriaScores: Record<string, number>;
    }>;

    if (attempt.answers.length > 0) {
      steps = attempt.answers.map(answer => ({
        order: answer.step.order,
        customerMessage: answer.step.customerMessage,
        stepGoal: answer.step.stepGoal,
        answer: answer.answerText,
        score: answer.stepScore,
        feedback: answer.feedback,
        betterExample: answer.betterExample,
        criteriaScores: answer.criteriaScoresJson ? JSON.parse(answer.criteriaScoresJson) : {},
      }));
    } else if (attempt.evaluationResultJson && attempt.conversationHistoryJson) {
      const history: Array<{ role: string; text: string }> = JSON.parse(attempt.conversationHistoryJson);
      const evalResult = JSON.parse(attempt.evaluationResultJson);
      const pairs: Array<{ customerMessage: string; answer: string }> = [];
      for (let i = 0; i + 1 < history.length; i += 2) {
        if (history[i].role === 'client' && history[i + 1].role === 'manager') {
          pairs.push({ customerMessage: history[i].text, answer: history[i + 1].text });
        }
      }
      steps = (evalResult.steps || []).map((s: { step_order: number; step_score: number; feedback?: string; better_example?: string; criteria?: Record<string, number> }, idx: number) => {
        const pair = pairs[idx] || { customerMessage: '', answer: '' };
        return {
          order: s.step_order,
          customerMessage: pair.customerMessage,
          answer: pair.answer,
          score: s.step_score,
          feedback: s.feedback ?? null,
          betterExample: s.better_example ?? null,
          criteriaScores: s.criteria ?? {},
        };
      });
    } else {
      steps = [];
    }

    const score = attempt.totalScore ?? 0;
    res.json({
      id: attempt.id,
      userName: attempt.user.fullName,
      testTitle: attempt.test.title,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      totalScore: attempt.totalScore,
      level: attempt.level,
      qualityTag: scoreToQualityTag(score),
      evaluationError: attempt.evaluationError,
      strengths: attempt.strengthsJson ? JSON.parse(attempt.strengthsJson) : [],
      weaknesses: attempt.weaknessesJson ? JSON.parse(attempt.weaknessesJson) : [],
      recommendations: attempt.recommendationsJson ? JSON.parse(attempt.recommendationsJson) : [],
      suspicionFlags: attempt.suspicionFlagsJson ? JSON.parse(attempt.suspicionFlagsJson) : [],
      steps,
    });
  } catch (error) {
    console.error('Get attempt details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper: derive level from score (for backward compatibility)
function scoreToLevel(score: number): string {
  if (score < 40) return 'Junior';
  if (score < 70) return 'Middle';
  return 'Senior';
}

// Quality tag for conversation result (one word)
function scoreToQualityTag(score: number): string {
  if (score < 50) return 'Плохо';
  if (score < 76) return 'Средне';
  return 'Хорошо';
}

function getFailureReasonLabel(reason?: string | null): string {
  if (!reason) return 'Тренировка досрочно завершена';
  const base = reason.split(':')[0];
  const map: Record<string, string> = {
    PROFANITY: 'Недопустимая лексика',
    BAD_TONE: 'Грубый / враждебный тон',
    IGNORED_QUESTIONS: 'Игнорирование вопросов клиента',
    POOR_COMMUNICATION: 'Низкое качество коммуникации',
    REPEATED_LOW_EFFORT: 'Повторные некачественные ответы',
    REPEATED_LOW_QUALITY: 'Повторные некачественные/формальные ответы',
    DISENGAGEMENT: 'Менеджер завершил коммуникацию / отказался от диалога',
    rude_language: 'Недопустимая лексика',
    ignored_questions: 'Игнорирование вопросов клиента',
    poor_communication: 'Низкое качество коммуникации',
    repeated_low_effort: 'Повторные некачественные ответы',
    repeated_low_quality: 'Повторные некачественные/формальные ответы',
    disengagement: 'Менеджер завершил коммуникацию / отказался от диалога',
  };
  if (map[base]) return map[base];
  if (base === 'CRITICAL_EVASION' || base === 'critical_evasion') {
    const topic = reason.split(':')[1] ?? '';
    return `Критический вопрос проигнорирован (${topic})`;
  }
  return 'Тренировка досрочно завершена';
}

// Short summary for card (from assessment or built from strengths/weaknesses)
function buildCardSummary(
  type: 'attempt' | 'training',
  data: { quality?: string; strengths?: string[]; weaknesses?: string[]; recommendations?: string[]; mistakes?: string[]; improvements?: string[] }
): string {
  if (type === 'training' && data.quality?.trim()) {
    return data.quality;
  }
  const parts: string[] = [];
  if (data.strengths?.length) parts.push(data.strengths[0]);
  if (data.weaknesses?.length) parts.push(data.weaknesses[0]);
  if (data.mistakes?.length) parts.push(data.mistakes[0]);
  if (data.recommendations?.length && parts.length < 2) parts.push(data.recommendations[0]);
  if (data.improvements?.length && parts.length < 2) parts.push(data.improvements[0]);
  return parts.slice(0, 2).join('. ') || 'Краткая оценка диалога.';
}

// Get attempts + training sessions merged (for Employees tab)
app.get('/api/admin/attempts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 1000;

    const [attempts, trainingSessions] = await Promise.all([
      prisma.attempt.findMany({
        where: completedWithDataWhere,
        include: {
          user: true,
          test: true,
          answers: {
            include: { step: true },
            orderBy: { step: { order: 'asc' as const } },
          },
        },
        orderBy: { finishedAt: 'desc' },
      }),
      prisma.trainingSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          OR: [
            { assessmentScore: { not: null } },
            { failureReason: { not: null } },
          ],
        },
        include: { user: true },
        orderBy: { completedAt: 'desc' },
      }),
    ]);

    const attemptItems = attempts.map(a => {
      const strengths = a.strengthsJson ? JSON.parse(a.strengthsJson) : [];
      const weaknesses = a.weaknessesJson ? JSON.parse(a.weaknessesJson) : [];
      const recommendations = a.recommendationsJson ? JSON.parse(a.recommendationsJson) : [];
      const score = a.totalScore ?? 0;
      return {
        type: 'attempt' as const,
        id: a.id,
        userName: a.user.fullName,
        testTitle: a.test.title,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        totalScore: a.totalScore,
        level: a.level,
        qualityTag: scoreToQualityTag(score),
        summary: buildCardSummary('attempt', { strengths, weaknesses, recommendations }),
        evaluationError: a.evaluationError,
        strengths,
        weaknesses,
        recommendations,
        steps: a.answers.map(ans => ({
          order: ans.step.order,
          customerMessage: ans.step.customerMessage,
          answer: ans.answerText,
          score: ans.stepScore,
          feedback: ans.feedback,
        })),
      };
    });

    const trainingItems = trainingSessions.map(s => {
      const hasV2Eval = s.evaluationJson != null;
      const hasLegacyAssessment = s.assessmentScore != null && s.assessmentJson != null;
      const isFailed = s.status === 'failed';

      let score = 0;
      let weaknesses: string[] = [];
      let recommendations: string[] = [];
      let dimensionScores = null;

      if (hasV2Eval) {
        const evalData = JSON.parse(s.evaluationJson as string);
        score = evalData.overall_score_0_100 ?? s.totalScore ?? 0;
        weaknesses = Array.isArray(evalData.issues)
          ? evalData.issues.map((i: any) => i.recommendation || i.issue_type)
          : [];
        recommendations = Array.isArray(evalData.recommendations) ? evalData.recommendations : [];
        dimensionScores = evalData.dimension_scores ?? null;
      } else if (hasLegacyAssessment) {
        const data = JSON.parse(s.assessmentJson as string);
        score = s.assessmentScore as number;
        weaknesses = Array.isArray(data.mistakes) ? data.mistakes : [];
        recommendations = Array.isArray(data.improvements) ? data.improvements : [];
      }

      const failReasonLabels: Record<string, string> = {
        rude_language: 'Досрочно завершена: недопустимая лексика.',
        ignored_questions: 'Досрочно завершена: менеджер игнорировал вопросы.',
        poor_communication: 'Досрочно завершена: низкое качество коммуникации.',
        repeated_low_effort: 'Досрочно завершена: повторные некачественные ответы.',
        PROFANITY: 'Досрочно завершена: недопустимая лексика.',
        BAD_TONE: 'Досрочно завершена: грубый / враждебный тон.',
        IGNORED_QUESTIONS: 'Досрочно завершена: менеджер игнорировал вопросы.',
        POOR_COMMUNICATION: 'Досрочно завершена: низкое качество коммуникации.',
        REPEATED_LOW_EFFORT: 'Досрочно завершена: повторные некачественные ответы.',
        REPEATED_LOW_QUALITY: 'Досрочно завершена: формальные/некачественные ответы.',
        DISENGAGEMENT: 'Досрочно завершена: менеджер отказался продолжать диалог.',
      };
      const baseReason = (s.failureReason ?? '').split(':')[0];

      let summary: string;
      if (isFailed) {
        summary = failReasonLabels[baseReason]
          ?? (baseReason === 'critical_evasion' || baseReason === 'CRITICAL_EVASION'
            ? `Досрочно завершена: критический вопрос проигнорирован (${(s.failureReason ?? '').split(':')[1] ?? ''}).`
            : 'Тренировка досрочно завершена системой.');
      } else if (hasV2Eval) {
        summary = `Балл: ${score}/100`;
      } else {
        const data = hasLegacyAssessment ? JSON.parse(s.assessmentJson as string) : {};
        summary = buildCardSummary('training', {
          quality: data.quality,
          mistakes: data.mistakes,
          improvements: data.improvements,
        });
      }

      return {
        type: 'training' as const,
        id: `t-${s.id}`,
        sessionId: s.id,
        userName: s.user.fullName,
        testTitle: 'Тренировка с виртуальным клиентом',
        clientProfile: (s as any).clientProfile ?? 'normal',
        startedAt: s.createdAt,
        finishedAt: s.completedAt,
        totalScore: score,
        level: scoreToLevel(score),
        qualityTag: isFailed ? 'Плохо' : scoreToQualityTag(score),
        summary,
        evaluationError: null,
        strengths: [],
        weaknesses,
        recommendations,
        dimensionScores,
        steps: [],
      };
    });

    const merged = [...attemptItems, ...trainingItems].sort((a, b) => {
      const dateA = a.finishedAt ? new Date(a.finishedAt).getTime() : 0;
      const dateB = b.finishedAt ? new Date(b.finishedAt).getTime() : 0;
      return dateB - dateA;
    });

    const total = merged.length;
    const page = 0;
    const paginated = merged.slice(0, limit);

    res.json({
      attempts: paginated,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Get attempts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get team summary (training & attempts) with in-memory snapshot cache
app.get('/api/admin/summary', async (req, res) => {
  try {
    const now = Date.now();
    if (teamSummaryCache.data && teamSummaryCache.expiresAt > now) {
      return res.json(teamSummaryCache.data);
    }

    const [attempts, trainingSessions] = await Promise.all([
      prisma.attempt.findMany({
        where: { status: 'completed', totalScore: { not: null } },
        include: {
          user: true,
        },
      }),
      prisma.trainingSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          OR: [
            { assessmentScore: { not: null } },
            { failureReason: { not: null } },
          ],
        },
        include: {
          user: true,
        },
      }),
    ]);

    const totalItems = attempts.length + trainingSessions.length;

    if (totalItems === 0) {
      const empty: TeamSummaryCache = {
        totalAttempts: 0,
        avgScore: 0,
        levelCounts: { Junior: 0, Middle: 0, Senior: 0 },
        topWeaknesses: [],
        topStrengths: [],
        expertSummary: null,
      };
      teamSummaryCache = { data: empty, expiresAt: now + ANALYTICS_TTL_MS };
      return res.json(empty);
    }

    const totalScoreAttempts = attempts.reduce((sum, a) => sum + (a.totalScore || 0), 0);
    const totalScoreTrainings = trainingSessions.reduce((sum, s) => {
      if (s.totalScore != null) return sum + s.totalScore;
      if (s.evaluationJson != null) {
        try {
          const evalData = JSON.parse(s.evaluationJson);
          if (typeof evalData.overall_score_0_100 === 'number') return sum + evalData.overall_score_0_100;
        } catch { /* skip */ }
      }
      if (s.assessmentScore != null) return sum + s.assessmentScore;
      if (s.status === 'failed') return sum;
      return sum;
    }, 0);

    const totalScore = totalScoreAttempts + totalScoreTrainings;
    const avgScore = totalItems > 0 ? totalScore / totalItems : 0;

    const levelCounts = {
      Junior: 0,
      Middle: 0,
      Senior: 0,
    };

    const allWeaknesses: Record<string, number> = {};
    const allStrengths: Record<string, number> = {};

    attempts.forEach((attempt) => {
      if (attempt.level) {
        levelCounts[attempt.level as keyof typeof levelCounts]++;
      }
      if (attempt.weaknessesJson) {
        const weaknesses = JSON.parse(attempt.weaknessesJson);
        weaknesses.forEach((w: string) => {
          allWeaknesses[w] = (allWeaknesses[w] || 0) + 1;
        });
      }
      if (attempt.strengthsJson) {
        const strengths = JSON.parse(attempt.strengthsJson);
        strengths.forEach((s: string) => {
          allStrengths[s] = (allStrengths[s] || 0) + 1;
        });
      }
    });

    trainingSessions.forEach((s) => {
      const hasV2Eval = s.evaluationJson != null;
      if (hasV2Eval) {
        try {
          const evalData = JSON.parse(s.evaluationJson as string);
          const issues: any[] = Array.isArray(evalData.issues) ? evalData.issues : [];
          const recs: string[] = Array.isArray(evalData.recommendations) ? evalData.recommendations : [];
          const checklistItems: any[] = Array.isArray(evalData.checklist) ? evalData.checklist : [];
          issues.forEach((i: any) => {
            const text = i.recommendation || i.issue_type || '';
            if (text) allWeaknesses[text] = (allWeaknesses[text] || 0) + 1;
          });
          recs.forEach((r: string) => {
            if (r) allStrengths[r] = (allStrengths[r] || 0) + 1;
          });
          checklistItems
            .filter((c: any) => c.status === 'YES')
            .forEach((c: any) => {
              const text = c.comment || c.code;
              if (text) allStrengths[text] = (allStrengths[text] || 0) + 1;
            });
        } catch { /* skip malformed JSON */ }
      } else if (s.assessmentJson) {
        const data = JSON.parse(s.assessmentJson) as {
          mistakes?: string[];
          improvements?: string[];
          quality?: string;
        };
        const mistakes = Array.isArray(data.mistakes) ? data.mistakes : [];
        const improvements = Array.isArray(data.improvements) ? data.improvements : [];
        mistakes.forEach((w: string) => {
          allWeaknesses[w] = (allWeaknesses[w] || 0) + 1;
        });
        improvements.forEach((r: string) => {
          allStrengths[r] = (allStrengths[r] || 0) + 1;
        });
      }
    });

    const topWeaknesses = Object.entries(allWeaknesses)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([weakness, count]) => ({ weakness, count }));

    const topStrengths = Object.entries(allStrengths)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([strength, count]) => ({ strength, count }));

    // Prepare data for expert summary
    const teamData = {
      totalAttempts: totalItems,
      avgScore,
      levelCounts,
      topWeaknesses,
      topStrengths,
      attempts: [
        ...attempts.map(a => ({
          userName: a.user.fullName,
          score: a.totalScore || 0,
          level: a.level || '',
          strengths: a.strengthsJson ? JSON.parse(a.strengthsJson) : [],
          weaknesses: a.weaknessesJson ? JSON.parse(a.weaknessesJson) : [],
          recommendations: a.recommendationsJson ? JSON.parse(a.recommendationsJson) : [],
        })),
        ...trainingSessions.map(s => {
          let score = 0;
          let weaknesses: string[] = [];
          let recommendations: string[] = [];
          let strengths: string[] = [];

          if (s.evaluationJson) {
            try {
              const evalData = JSON.parse(s.evaluationJson);
              score = evalData.overall_score_0_100 ?? s.totalScore ?? s.assessmentScore ?? 0;
              weaknesses = Array.isArray(evalData.issues)
                ? evalData.issues.map((i: any) => i.recommendation || i.issue_type)
                : [];
              recommendations = Array.isArray(evalData.recommendations) ? evalData.recommendations : [];
              strengths = Array.isArray(evalData.checklist)
                ? evalData.checklist.filter((c: any) => c.status === 'YES').map((c: any) => c.comment || c.code)
                : [];
            } catch { /* skip */ }
          } else if (s.assessmentJson) {
            const data = JSON.parse(s.assessmentJson) as { mistakes?: string[]; improvements?: string[] };
            score = s.assessmentScore ?? 0;
            weaknesses = data.mistakes || [];
            recommendations = data.improvements || [];
          }

          return {
            userName: s.user.fullName,
            score,
            level: scoreToLevel(score),
            strengths,
            weaknesses,
            recommendations,
          };
        }),
      ],
    };

    // Generate expert summary
    let expertSummary = null;
    try {
      const { generateExpertTeamSummary } = await import('./team-summary');
      expertSummary = await generateExpertTeamSummary(teamData);
    } catch (error) {
      console.error('Error generating expert summary:', error);
      // Continue without expert summary if generation fails
    }

    const payload: TeamSummaryCache = {
      totalAttempts: totalItems,
      avgScore: Math.round(avgScore * 10) / 10,
      levelCounts,
      topWeaknesses,
      topStrengths,
      expertSummary,
    };
    teamSummaryCache = { data: payload, expiresAt: now + ANALYTICS_TTL_MS };
    res.json(payload);
  } catch (error) {
    console.error('Get summary error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Voice calls dashboard (telephony availability) with in-memory snapshot cache
app.get('/api/admin/voice-dashboard', async (_req, res) => {
  try {
    const now = Date.now();
    if (voiceDashboardCache.data && voiceDashboardCache.expiresAt > now) {
      return res.json(voiceDashboardCache.data);
    }

    const calls = await prisma.voiceCallSession.findMany();
    if (!calls.length) {
      const empty: VoiceDashboardCache = {
        totalCalls: 0,
        answeredPercent: 0,
        missedPercent: 0,
        avgDurationSec: 0,
        outcomeBreakdown: {
          completed: 0,
          no_answer: 0,
          busy: 0,
          failed: 0,
          disconnected: 0,
        },
      };
      voiceDashboardCache = { data: empty, expiresAt: now + ANALYTICS_TTL_MS };
      return res.json(empty);
    }

    const breakdown: VoiceDashboardCache['outcomeBreakdown'] = {
      completed: 0,
      no_answer: 0,
      busy: 0,
      failed: 0,
      disconnected: 0,
    };

    let totalDuration = 0;
    let durationCount = 0;

    for (const c of calls) {
      const key = (c.outcome || 'disconnected') as keyof typeof breakdown;
      if (breakdown[key] !== undefined) {
        breakdown[key] += 1;
      } else {
        breakdown.disconnected += 1;
      }
      if (typeof c.durationSec === 'number' && c.durationSec > 0) {
        totalDuration += c.durationSec;
        durationCount += 1;
      }
    }

    const total = calls.length;
    const answered = breakdown.completed;
    const missed = total - answered;
    const answeredPercent = total > 0 ? Math.round((answered / total) * 100) : 0;
    const missedPercent = total > 0 ? Math.round((missed / total) * 100) : 0;
    const avgDurationSec = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;

    const payload: VoiceDashboardCache = {
      totalCalls: total,
      answeredPercent,
      missedPercent,
      avgDurationSec,
      outcomeBreakdown: breakdown,
    };
    voiceDashboardCache = { data: payload, expiresAt: now + ANALYTICS_TTL_MS };
    res.json(payload);
  } catch (error) {
    console.error('Get voice-dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get OpenAI usage/expenses for current period
app.get('/api/admin/expenses', async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const startTime = Math.floor(startOfMonth.getTime() / 1000);
    const endTime = Math.floor(endOfMonth.getTime() / 1000);

    let totalSpentUsd = 0;
    let error: string | null = null;

    try {
      const https = await import('https');
      const response = await new Promise<{ statusCode: number; data: string }>((resolve, reject) => {
        const url = `https://api.openai.com/v1/organization/costs?start_time=${startTime}&end_time=${endTime}&limit=31`;
        const apiKey = config.openaiApiKey;
        if (!apiKey) {
          reject(new Error('OPENAI_API_KEY not configured'));
          return;
        }
        const req = https.get(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }, (resp) => {
          let data = '';
          resp.on('data', (chunk) => { data += chunk; });
          resp.on('end', () => resolve({ statusCode: resp.statusCode || 0, data }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });

      if (response.statusCode === 200) {
        const json = JSON.parse(response.data);
        const buckets = json.data || [];
        for (const bucket of buckets) {
          const results = bucket.results || [];
          for (const r of results) {
            const amount = r.amount;
            if (amount && typeof amount.value === 'number') {
              totalSpentUsd += amount.value;
            }
          }
        }
      } else {
        try {
          const errJson = response.data ? JSON.parse(response.data) : {};
          error = errJson.error?.message || `API returned ${response.statusCode}`;
        } catch {
          error = `API returned ${response.statusCode}`;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error = msg;
      if (msg.includes('401') || msg.includes('403') || msg.includes('organization')) {
        error = 'Требуется ключ организации (Organization API key) для доступа к данным расходов. Используйте platform.openai.com для просмотра.';
      }
    }

    res.json({
      periodStart: startOfMonth.toISOString(),
      periodEnd: endOfMonth.toISOString(),
      totalSpentUsd: Math.round(totalSpentUsd * 100) / 100,
      currency: 'USD',
      error,
      billingUrl: 'https://platform.openai.com/account/billing',
    });
  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get managers list
app.get('/api/admin/managers', async (req, res) => {
  try {
    const managers = await prisma.user.findMany({
      where: { role: 'manager' },
      include: {
        attempts: {
          where: completedWithDataWhere,
          orderBy: { finishedAt: 'desc' },
        },
      },
      orderBy: { fullName: 'asc' },
    });

    res.json({
      managers: managers.map(manager => ({
        id: manager.id,
        name: manager.fullName,
        telegramId: manager.telegramId,
        attemptsCount: manager.attempts.length,
        latestAttempt: manager.attempts[0] ? {
          id: manager.attempts[0].id,
          finishedAt: manager.attempts[0].finishedAt,
          score: manager.attempts[0].totalScore,
          level: manager.attempts[0].level,
        } : null,
      })),
    });
  } catch (error) {
    console.error('Get managers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get manager attempts
app.get('/api/admin/managers/:managerId/attempts', async (req, res) => {
  try {
    const managerId = parseInt(req.params.managerId);
    const attempts = await prisma.attempt.findMany({
      where: {
        userId: managerId,
        ...completedWithDataWhere,
      },
      include: {
        test: true,
        answers: {
          include: {
            step: true,
          },
          orderBy: {
            step: {
              order: 'asc',
            },
          },
        },
      },
      orderBy: { finishedAt: 'desc' },
    });

    res.json({
      attempts: attempts.map(attempt => ({
        id: attempt.id,
        testTitle: attempt.test.title,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        totalScore: attempt.totalScore,
        level: attempt.level,
        strengths: attempt.strengthsJson ? JSON.parse(attempt.strengthsJson) : [],
        weaknesses: attempt.weaknessesJson ? JSON.parse(attempt.weaknessesJson) : [],
        recommendations: attempt.recommendationsJson ? JSON.parse(attempt.recommendationsJson) : [],
        steps: attempt.answers.map(answer => ({
          order: answer.step.order,
          customerMessage: answer.step.customerMessage,
          answer: answer.answerText,
          score: answer.stepScore,
          feedback: answer.feedback,
        })),
      })),
    });
  } catch (error) {
    console.error('Get manager attempts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: diagnose voice env (no secrets — only presence). Uses live tunnel URL when available.
app.get('/api/admin/voice-env-check', (_req, res) => {
  const VOX_ACCOUNT_ID = !!process.env.VOX_ACCOUNT_ID?.trim();
  const VOX_API_KEY = !!process.env.VOX_API_KEY?.trim();
  const VOX_APP_ID = !!process.env.VOX_APP_ID?.trim();
  const VOX_CALLER_ID = !!process.env.VOX_CALLER_ID?.trim();
  const tunnelLive = !!getTunnelUrl()?.trim();
  const baseUrlFromEnv = !!(process.env.VOICE_DIALOG_BASE_URL || process.env.MINI_APP_URL || process.env.PUBLIC_BASE_URL)?.trim();
  const baseUrl = tunnelLive || baseUrlFromEnv;
  const voxKeys = Object.keys(process.env).filter((k) => k.startsWith('VOX_') || k.startsWith('VOICE_'));
  res.json({
    ok: VOX_ACCOUNT_ID && VOX_API_KEY && VOX_APP_ID && baseUrl,
    VOX_ACCOUNT_ID,
    VOX_API_KEY,
    VOX_APP_ID,
    VOX_CALLER_ID,
    VOICE_DIALOG_BASE_URL_or_MINI_APP_URL: baseUrl,
    tunnel_live: tunnelLive,
    voxAndVoiceKeysInProcess: voxKeys.sort(),
  });
});

// Admin: test numbers for Call tab (from .env)
app.get('/api/admin/test-numbers', (_req, res) => {
  try {
    const numbers = getTestNumbers();
    res.json({ numbers });
  } catch (err) {
    console.error('test-numbers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: start voice call (Voximplant)
app.post('/api/admin/start-voice-call', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const toRaw = body.to != null ? String(body.to).trim() : null;
    const numbers = getTestNumbers();
    const defaultTo = numbers.length > 0 ? numbers[0] : null;
    const to = toRaw || defaultTo;
    if (!to) {
      return res.status(400).json({
        error: 'Укажите номер (to) или задайте VOX_TEST_TO / VOX_TEST_NUMBERS в .env.',
      });
    }
    const scenario = (body.scenario === 'realtime' || body.scenario === 'realtime_pure' || body.scenario === 'dialog') ? body.scenario : 'realtime_pure';
    const result = await startVoiceCall(to, { scenario });
    if ('error' in result) {
      return res.status(400).json({ error: result.error });
    }
    addCall(result.callId, to);
    if (result.callSessionHistoryId) {
      setVoxSessionId(result.callId, result.callSessionHistoryId);
    }
    const toNormalized = '+' + String(to).replace(/\D/g, '');
    try {
      await prisma.voiceCallSession.create({
        data: {
          callId: result.callId,
          to: toNormalized,
          scenario: result.scenario ?? 'dialog',
          startedAt: new Date(result.startedAt),
        },
      });
    } catch (e) {
      console.warn('[voice] VoiceCallSession create (may already exist):', e instanceof Error ? e.message : e);
    }
    res.json({ callId: result.callId, startedAt: result.startedAt, to, scenario: result.scenario });
  } catch (err) {
    console.error('start-voice-call error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/public/demo-call/start', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const toRaw = body.to != null ? String(body.to).trim() : '';
    if (!toRaw) {
      return res.status(400).json({ error: 'Введите номер телефона.' });
    }
    const scenario = body.scenario === 'dialog' || body.scenario === 'realtime'
      ? body.scenario
      : 'realtime_pure';
    const result = await startVoiceCall(toRaw, { scenario });
    if ('error' in result) {
      return res.status(400).json({ error: result.error });
    }
    addCall(result.callId, toRaw);
    if (result.callSessionHistoryId) {
      setVoxSessionId(result.callId, result.callSessionHistoryId);
    }
    const toNormalized = '+' + String(toRaw).replace(/\D/g, '');
    try {
      await prisma.voiceCallSession.create({
        data: {
          callId: result.callId,
          to: toNormalized,
          scenario: result.scenario ?? 'realtime_pure',
          startedAt: new Date(result.startedAt),
        },
      });
    } catch (e) {
      console.warn('[demo-call] VoiceCallSession create (may already exist):', e instanceof Error ? e.message : e);
    }
    res.json({ callId: result.callId, startedAt: result.startedAt, to: toRaw, scenario: result.scenario });
  } catch (err) {
    console.error('public demo-call/start error:', err);
    res.status(500).json({ error: 'Не удалось запустить звонок.' });
  }
});

/** Пример отчёта на странице /demo-call: полная оценка стенограммы (evaluatorV2 + LLM-сводка и улучшения ответов). */
app.post('/api/public/demo-call/evaluate-example', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const raw = (body as { transcript?: unknown }).transcript;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'Ожидается массив transcript: [{ role, text }].' });
    }
    const transcript = raw
      .map((row) =>
        row && typeof row === 'object'
          ? {
              role: String((row as { role?: unknown }).role ?? ''),
              text: String((row as { text?: unknown }).text ?? ''),
            }
          : null
      )
      .filter((x): x is { role: string; text: string } => !!x);
    const result = await evaluateDemoExampleFromTranscript(transcript);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось оценить пример.';
    console.error('public demo-call/evaluate-example error:', err);
    res.status(500).json({ error: message });
  }
});

app.get('/api/public/demo-call/:callId', async (req, res) => {
  try {
    const callId = String(req.params.callId || '').trim();
    if (!callId) {
      return res.status(400).json({ error: 'Missing callId.' });
    }
    const session = await prisma.voiceCallSession.findUnique({ where: { callId } });
    if (!session) {
      return res.status(404).json({ error: 'Звонок не найден.' });
    }
    res.json(buildVoiceCallDetailResponse(session));
  } catch (err) {
    console.error('public demo-call/:callId error:', err);
    res.status(500).json({ error: 'Не удалось получить статус звонка.' });
  }
});

// Admin: create batch call orchestration job
app.post('/api/admin/call-batches', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const jobsRaw = Array.isArray((body as { jobs?: unknown[] }).jobs) ? ((body as { jobs: unknown[] }).jobs) : [];
    const jobs = jobsRaw
      .map((j) => (j && typeof j === 'object' ? j as { phone?: unknown; dealershipId?: unknown; dealershipName?: unknown } : null))
      .filter((j): j is { phone?: unknown; dealershipId?: unknown; dealershipName?: unknown } => !!j)
      .map((j) => ({
        phone: j.phone != null ? String(j.phone) : '',
        dealershipId: j.dealershipId != null ? String(j.dealershipId) : null,
        dealershipName: j.dealershipName != null ? String(j.dealershipName) : null,
      }));

    const out = await createCallBatch({
      mode: (body as { mode?: 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily' }).mode ?? 'manual',
      title: (body as { title?: string }).title,
      jobs,
      maxConcurrency: Number((body as { maxConcurrency?: number }).maxConcurrency ?? 10),
      startIntervalMs: Number((body as { startIntervalMs?: number }).startIntervalMs ?? 250),
      maxAttempts: Number((body as { maxAttempts?: number }).maxAttempts ?? 3),
      scenario: (body as { scenario?: 'dialog' | 'realtime' | 'realtime_pure' }).scenario ?? 'realtime_pure',
      testMode: !!(body as { testMode?: boolean }).testMode,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось создать батч.';
    res.status(400).json({ error: message });
  }
});

app.get('/api/admin/call-batches/:id', async (req, res) => {
  try {
    const { batch, jobsPreview, dealershipSummary } = await getCallBatch(req.params.id);
    res.json({ batch, jobsPreview, dealershipSummary });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Батч не найден.';
    res.status(404).json({ error: message });
  }
});

app.get('/api/admin/call-batches', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const modeRaw = String(req.query.mode ?? 'all').trim();
    const allowedModes = new Set(['all', 'manual', 'single_dealership', 'all_dealerships', 'auto_daily']);
    const mode = allowedModes.has(modeRaw) ? modeRaw as 'all' | 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily' : 'all';
    const items = await listCallBatches(limit, mode);
    res.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось получить список batch';
    res.status(400).json({ error: message });
  }
});

app.get('/api/admin/super-admin/dealership-schedules', async (_req, res) => {
  try {
    const schedules = getDealershipDirectory().map((d) => ({
      id: d.id,
      name: d.name,
      city: d.city,
      workStartHour: d.workStartHour,
      workEndHour: d.workEndHour,
    }));
    res.json({ schedules });
  } catch (err) {
    console.error('super-admin/dealership-schedules error:', err);
    res.json({ schedules: [] });
  }
});

app.get('/api/admin/super-admin/call-orchestrator-config', async (_req, res) => {
  try {
    const callSource = getCallSourceInfo();
    res.json({
      callSource,
      autoDailyEnabled: process.env.AUTO_DAILY_CALLS_ENABLED === 'true' || process.env.AUTO_DAILY_CALLS_ENABLED === '1',
      batchTestModeEnabled: process.env.CALL_BATCH_TEST_MODE === 'true' || process.env.CALL_BATCH_TEST_MODE === '1',
      sourceMode: process.env.CALL_SOURCE_MODE || 'mock',
    });
  } catch (err) {
    console.error('super-admin/call-orchestrator-config error:', err);
    res.json({
      callSource: { mode: 'mock', targetsAvailable: 0, usingMockFallback: true },
      autoDailyEnabled: false,
      batchTestModeEnabled: false,
      sourceMode: 'mock',
    });
  }
});

app.get('/api/admin/call-batches/:id/jobs', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const statusRaw = String(req.query.status ?? '').trim();
    const allowedStatuses = new Set(['queued', 'dialing', 'in_progress', 'retry_wait', 'completed', 'failed', 'cancelled']);
    const status = allowedStatuses.has(statusRaw) ? statusRaw as 'queued' | 'dialing' | 'in_progress' | 'retry_wait' | 'completed' | 'failed' | 'cancelled' : undefined;
    const out = await getCallBatchJobs(req.params.id, limit, offset, status);
    res.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось получить jobs батча.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/admin/call-batches/:id/pause', async (req, res) => {
  try {
    await pauseCallBatch(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось поставить батч на паузу.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/admin/call-batches/:id/resume', async (req, res) => {
  try {
    await resumeCallBatch(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось возобновить батч.';
    res.status(400).json({ error: message });
  }
});

app.post('/api/admin/call-batches/:id/cancel', async (req, res) => {
  try {
    await cancelCallBatch(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось отменить батч.';
    res.status(400).json({ error: message });
  }
});

function normalizeVoxWebhookEvent(rawEvent: unknown): string {
  const event = String(rawEvent ?? '').trim().toLowerCase();
  if (!event) return '';
  if (event === 'hangup' || event === 'disconnect' || event === 'completed' || event === 'ended') {
    return 'disconnected';
  }
  if (event === 'answer') return 'connected';
  if (event === 'ringing') return 'progress';
  return event;
}

const voxFinalWatchdogs = new Map<string, NodeJS.Timeout>();
const voxWatchdogMeta = new Map<string, { to: string; voxSessionId?: number | null }>();
const VOX_FINAL_WEBHOOK_TIMEOUT_MS = (() => {
  const raw = Number(process.env.VOX_FINAL_WEBHOOK_TIMEOUT_MS || 6 * 60 * 1000);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 6 * 60 * 1000;
})();

function clearVoxFinalWatchdog(callId: string): void {
  const timer = voxFinalWatchdogs.get(callId);
  if (timer) {
    clearTimeout(timer);
    voxFinalWatchdogs.delete(callId);
  }
}

function armVoxFinalWatchdog(callId: string): void {
  clearVoxFinalWatchdog(callId);
  const timer = setTimeout(() => {
    const meta = voxWatchdogMeta.get(callId);
    if (!meta?.to) return;
    console.warn('[webhooks/vox] final webhook timeout -> synthetic finalize', {
      callId,
      to: meta.to,
      voxSessionId: meta.voxSessionId ?? null,
      timeoutMs: VOX_FINAL_WEBHOOK_TIMEOUT_MS,
    });
    const syntheticPayload = {
      call_id: callId,
      to: meta.to,
      event: 'failed',
      details: { reason: 'final_webhook_timeout' },
      vox_session_id: meta.voxSessionId ?? undefined,
    };
    finalizeVoiceCallSession(syntheticPayload).catch((err) => {
      console.error('[webhooks/vox] synthetic finalizeVoiceCallSession error:', err instanceof Error ? err.message : err);
    });
    onVoxBatchWebhook(syntheticPayload).catch((err) => {
      console.error('[webhooks/vox] synthetic onVoxBatchWebhook error:', err instanceof Error ? err.message : err);
    });
    voxFinalWatchdogs.delete(callId);
  }, VOX_FINAL_WEBHOOK_TIMEOUT_MS);
  voxFinalWatchdogs.set(callId, timer);
}

function safeVoxPayloadPreview(value: unknown, maxLen = 4000): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen)}... [truncated ${text.length - maxLen} chars]` : text;
  } catch {
    return '[unserializable payload]';
  }
}

app.use('/webhooks/vox', (req, _res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : null;
  const requestId = `vox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  (req as express.Request & { voxRequestId?: string }).voxRequestId = requestId;
  console.log('[webhooks/vox] request', {
    requestId,
    at: new Date().toISOString(),
    method: req.method,
    originalUrl: req.originalUrl,
    path: req.path,
    query: req.query,
    ip: req.ip,
    forwardedFor: req.get('x-forwarded-for') || null,
    host: req.get('host') || null,
    userAgent: req.get('user-agent') || null,
    contentType: req.get('content-type') || null,
    bodyKeys: body ? Object.keys(body) : [],
    bodyPreview: safeVoxPayloadPreview(body ?? req.body),
  });
  next();
});

app.get('/webhooks/vox', (_req, res) => {
  res.status(200).json({
    ok: true,
    message: 'Voximplant webhook endpoint is alive. Expected method: POST.',
  });
});

// Voximplant webhook: call events (disconnected, failed, no_answer, busy)
app.post('/webhooks/vox', async (req, res) => {
  res.status(200).end();
  const requestId = (req as express.Request & { voxRequestId?: string }).voxRequestId || null;
  const payload = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const voxSessionIdRaw =
    (payload as { vox_session_id?: unknown }).vox_session_id ??
    (payload as { vox_call_id?: unknown }).vox_call_id ??
    (payload as { call_session_history_id?: unknown }).call_session_history_id ??
    null;
  const voxSessionId = (() => {
    if (typeof voxSessionIdRaw === 'number') return Number.isFinite(voxSessionIdRaw) && voxSessionIdRaw > 0 ? voxSessionIdRaw : null;
    if (typeof voxSessionIdRaw === 'string') {
      const parsed = Number.parseInt(voxSessionIdRaw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    // Some payloads may send an object; try common shapes.
    if (voxSessionIdRaw && typeof voxSessionIdRaw === 'object') {
      const obj = voxSessionIdRaw as Record<string, unknown>;
      const nested = obj.call_session_history_id ?? obj.session_id ?? obj.id ?? null;
      if (typeof nested === 'number') return Number.isFinite(nested) && nested > 0 ? nested : null;
      if (typeof nested === 'string') {
        const parsed = Number.parseInt(nested, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
    }
    return null;
  })();
  const normalizedPayload =
    voxSessionId != null
      ? { ...payload, vox_session_id: voxSessionId }
      : payload;
  const event = normalizeVoxWebhookEvent((payload as any).event ?? (payload as any).event_type ?? '');
  const hasTranscript = Array.isArray((normalizedPayload as { transcript?: unknown }).transcript);
  const callIdStr = String((normalizedPayload as { call_id?: unknown }).call_id ?? '');
  if (callIdStr && voxSessionId != null) {
    setVoxSessionId(callIdStr, voxSessionId);
  }
  const toStr = String((normalizedPayload as { to?: unknown }).to ?? '').trim();
  if (callIdStr && toStr) {
    voxWatchdogMeta.set(callIdStr, {
      to: toStr,
      voxSessionId: voxSessionId ?? null,
    });
  }
  console.log('[webhooks/vox] received', {
    requestId,
    event,
    callId: (normalizedPayload as { call_id?: unknown }).call_id,
    to: (normalizedPayload as { to?: unknown }).to ?? null,
    voxSessionId: (normalizedPayload as { vox_session_id?: unknown }).vox_session_id ?? null,
    voxSessionIdRaw: voxSessionIdRaw ?? null,
    keys: Object.keys(normalizedPayload),
    transcriptTurns: hasTranscript ? (normalizedPayload as { transcript: unknown[] }).transcript.length : 0,
  });
  const isFinalEvent = ['disconnected', 'failed', 'no_answer', 'busy'].includes(event);
  if (!isFinalEvent) {
    if (callIdStr) {
      armVoxFinalWatchdog(callIdStr);
    }
    console.log('[webhooks/vox] non-final event (ignored for finalize)', {
      requestId,
      event,
      callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
    });
    return;
  }

  console.log('[webhooks/vox] final event -> start finalize', {
    requestId,
    event,
    callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
  });
  if (callIdStr) {
    clearVoxFinalWatchdog(callIdStr);
  }

  if (isFinalEvent) {
    finalizeVoiceCallSession(normalizedPayload).catch((err) => {
      console.error('[webhooks/vox] finalizeVoiceCallSession error:', {
        requestId,
        event,
        callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
        error: err instanceof Error ? err.message : err,
      });
    });
    onVoxBatchWebhook(normalizedPayload).catch((err) => {
      console.error('[webhooks/vox] onVoxBatchWebhook error:', {
        requestId,
        event,
        callId: (normalizedPayload as { call_id?: unknown }).call_id ?? null,
        error: err instanceof Error ? err.message : err,
      });
    });
  }
});

// Admin: call history from DB (persisted; same phone = multiple cards)
app.get('/api/admin/call-history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const sessions = await prisma.voiceCallSession.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    const calls = sessions.map((s) => {
      const transcript = s.transcriptJson
        ? (JSON.parse(s.transcriptJson) as Array<{ role: string; text: string }>)
        : [];
      const hasEvaluation = !!s.evaluationJson;
      const ended = !!s.endedAt;
      const endedAtMs = s.endedAt ? s.endedAt.getTime() : null;
      const ageSec = endedAtMs != null ? (Date.now() - endedAtMs) / 1000 : null;
      const isRecent = ageSec != null && ageSec >= 0 && ageSec < 120;
      // Avoid "stuck processing" forever when there is no transcript: only show processing for recent ended calls.
      const isProcessing = ended && !hasEvaluation && !s.failureReason && (transcript.length >= 2 || isRecent);
      const processingStage = ended && !hasEvaluation && isProcessing
        ? (transcript.length >= 2 ? 'evaluation' : 'transcript')
        : null;
      return {
        id: s.id,
        callId: s.callId,
        to: s.to,
        scenario: s.scenario,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        outcome: s.outcome,
        durationSec: s.durationSec,
        transcript,
        transcriptTurns: transcript.length,
        totalScore: s.totalScore,
        hasEvaluation,
        isProcessing,
        processingStage,
        processingError: s.failureReason,
      };
    });
    res.json({ calls });
  } catch (err) {
    console.error('call-history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: one call session detail (for card open: checklist, recommendations, transcript)
app.get('/api/admin/call-history/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const session = await prisma.voiceCallSession.findFirst({
      where: { id },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(buildVoiceCallDetailResponse(session));
  } catch (err) {
    console.error('call-history/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Super Admin: platform-level data (no schema change) ─────────────────

// Merged audits: attempts + training sessions + voice calls (platform-wide list)
app.get('/api/admin/super-admin/audits', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const [attempts, trainingSessions, voiceSessions] = await Promise.all([
      prisma.attempt.findMany({
        where: { status: 'completed', totalScore: { not: null } },
        include: { user: true },
        orderBy: { id: 'desc' },
        take: limit,
      }),
      prisma.trainingSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          OR: [
            { assessmentScore: { not: null } },
            { failureReason: { not: null } },
          ],
        },
        include: { user: true },
        orderBy: { id: 'desc' },
        take: limit,
      }),
      prisma.voiceCallSession.findMany({
        orderBy: { id: 'desc' },
        take: limit,
      }),
    ]);

    const auditFromAttempt = (a: { id: number; user: { fullName: string } | null; totalScore: number | null; finishedAt: Date | null }) => {
      const score = a.totalScore ?? 0;
      return {
        id: `attempt-${a.id}`,
        type: 'attempt' as const,
        company: 'Platform',
        dealer: '—',
        date: a.finishedAt?.toISOString() ?? new Date().toISOString(),
        aiScore: Math.round(score * 10) / 10,
        status: score >= 76 ? 'Good' as const : score >= 50 ? 'Medium' as const : 'Bad' as const,
        userName: a.user?.fullName ?? '—',
        detailId: a.id,
        detailType: 'attempt' as const,
      };
    };
    const auditFromTraining = (s: { id: number; user: { fullName: string } | null; totalScore: number | null; evaluationJson: string | null; assessmentScore: number | null; completedAt: Date | null }) => {
      let score = s.totalScore ?? 0;
      if (score === 0 && s.evaluationJson) {
        try {
          const e = JSON.parse(s.evaluationJson);
          score = e.overall_score_0_100 ?? s.assessmentScore ?? 0;
        } catch { /* skip */ }
      }
      if (score === 0 && s.assessmentScore != null) score = s.assessmentScore;
      return {
        id: `training-${s.id}`,
        type: 'training' as const,
        company: 'Platform',
        dealer: '—',
        date: s.completedAt?.toISOString() ?? new Date().toISOString(),
        aiScore: Math.round(score * 10) / 10,
        status: score >= 76 ? 'Good' as const : score >= 50 ? 'Medium' as const : 'Bad' as const,
        userName: s.user?.fullName ?? '—',
        detailId: s.id,
        detailType: 'training' as const,
      };
    };
    const auditFromCall = (s: { id: number; to: string; startedAt: Date; totalScore: number | null; evaluationJson: string | null }) => {
      let score = s.totalScore ?? 0;
      if (score === 0 && s.evaluationJson) {
        try {
          const e = JSON.parse(s.evaluationJson);
          score = e.overall_score_0_100 ?? 0;
        } catch { /* skip */ }
      }
      return {
        id: `call-${s.id}`,
        type: 'call' as const,
        company: 'Platform',
        dealer: s.to,
        date: s.startedAt.toISOString(),
        aiScore: Math.round(score * 10) / 10,
        status: score >= 76 ? 'Good' as const : score >= 50 ? 'Medium' as const : 'Bad' as const,
        userName: null,
        detailId: s.id,
        detailType: 'call' as const,
      };
    };

    const items = [
      ...attempts.map(auditFromAttempt),
      ...trainingSessions.map(auditFromTraining),
      ...voiceSessions.map(auditFromCall),
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);

    res.json({ audits: items });
  } catch (err) {
    console.error('super-admin/audits error:', err);
    res.json({ audits: [] });
  }
});

// Time-series: last 7 days avg AI score (for dashboard chart)
app.get('/api/admin/super-admin/time-series', async (_req, res) => {
  try {
    const days = 7;
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    const [attempts, trainingSessions, voiceSessions] = await Promise.all([
      prisma.attempt.findMany({
        where: {
          status: 'completed',
          totalScore: { not: null },
          finishedAt: { gte: start },
        },
        select: { finishedAt: true, totalScore: true },
      }),
      prisma.trainingSession.findMany({
        where: {
          status: { in: ['completed', 'failed'] },
          completedAt: { gte: start },
          OR: [
            { assessmentScore: { not: null } },
            { evaluationJson: { not: null } },
          ],
        },
        select: { completedAt: true, totalScore: true, evaluationJson: true, assessmentScore: true },
      }),
      prisma.voiceCallSession.findMany({
        where: {
          startedAt: { gte: start },
          OR: [
            { totalScore: { not: null } },
            { evaluationJson: { not: null } },
          ],
        },
        select: { startedAt: true, totalScore: true, evaluationJson: true },
      }),
    ]);

    const byDay: Record<string, { sum: number; count: number }> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      byDay[key] = { sum: 0, count: 0 };
    }

    const addScore = (date: Date | null, score: number) => {
      if (!date) return;
      const key = new Date(date).toISOString().slice(0, 10);
      if (byDay[key]) {
        byDay[key].sum += score;
        byDay[key].count += 1;
      }
    };

    attempts.forEach((a) => addScore(a.finishedAt, a.totalScore!));
    trainingSessions.forEach((s) => {
      let score = s.totalScore ?? s.assessmentScore ?? 0;
      if (score === 0 && s.evaluationJson) {
        try {
          const e = JSON.parse(s.evaluationJson);
          score = e.overall_score_0_100 ?? 0;
        } catch { /* skip */ }
        addScore(s.completedAt, score);
      } else if (score > 0) {
        addScore(s.completedAt, score);
      }
    });
    voiceSessions.forEach((s) => {
      let score = s.totalScore ?? 0;
      if (score === 0 && s.evaluationJson) {
        try {
          const e = JSON.parse(s.evaluationJson);
          score = e.overall_score_0_100 ?? 0;
        } catch { /* skip */ }
        addScore(s.startedAt, score);
      } else if (score > 0) {
        addScore(s.startedAt, score);
      }
    });

    const series = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { sum, count }]) => ({
        date,
        avgScore: count > 0 ? Math.round((sum / count) * 10) / 10 : 0,
        count,
      }));

    res.json({ series });
  } catch (err) {
    console.error('super-admin/time-series error:', err);
    res.json({ series: [] });
  }
});

// Mock companies & dealers for local/test (no DB entities for company/dealer)
app.get('/api/admin/super-admin/mock-entities', async (req, res) => {
  try {
    const isLocalhost = /localhost|127\.0\.0\.1/.test(req.get('host') || req.get('origin') || '');
    const useMock = !!(isLocalhost || config.allowDevAdmin || process.env.NODE_ENV !== 'production' || req.query.mock === '1');
    const companies = useMock
      ? [
          { id: 'corp-1', name: 'Компания Север', autodealers: 4, avgAiScore: 82.4, answerRate: 78, lastAudit: new Date(Date.now() - 86400000).toISOString().slice(0, 10), trend: 1 },
          { id: 'corp-2', name: 'Drive Group', autodealers: 3, avgAiScore: 75.1, answerRate: 71, lastAudit: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), trend: -1 },
          { id: 'corp-3', name: 'МоторСервис', autodealers: 5, avgAiScore: 88.2, answerRate: 85, lastAudit: new Date().toISOString().slice(0, 10), trend: 1 },
          { id: 'corp-4', name: 'Авто Плюс', autodealers: 2, avgAiScore: 69.3, answerRate: 62, lastAudit: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), trend: 0 },
          { id: 'corp-5', name: 'КарДилер', autodealers: 6, avgAiScore: 79.5, answerRate: 74, lastAudit: new Date(Date.now() - 86400000).toISOString().slice(0, 10), trend: -1 },
        ]
      : [];
    const dealers = useMock
      ? getDealershipDirectory().map((d, idx) => ({
          id: d.id,
          name: d.name,
          city: d.city,
          avgScore: [84.2, 79.3, 87.6, 52.1, 91.2][idx] ?? 75,
          audits: [24, 18, 31, 12, 40][idx] ?? 15,
          bestEmployee: ['Иван П.', 'Мария К.', 'Алексей В.', 'Ольга С.', 'Дмитрий Л.'][idx] ?? '—',
          worstMetric: ['—', 'Answer time', '—', 'Script adherence', '—'][idx] ?? '—',
          workStartHour: d.workStartHour,
          workEndHour: d.workEndHour,
        }))
      : [];
    res.json({ companies, dealers });
  } catch (err) {
    console.error('super-admin/mock-entities error:', err);
    res.json({ companies: [], dealers: [] });
  }
});

// Settings (view-only): scripts count, phones count, language, telephony
app.get('/api/admin/super-admin/settings', async (_req, res) => {
  try {
    const [testCount, phoneResult] = await Promise.all([
      prisma.test.count(),
      prisma.voiceCallSession.findMany({ select: { to: true } }).then((sessions) => {
        const distinct = new Set(sessions.map((s) => s.to));
        return distinct.size;
      }),
    ]);
    res.json({
      totalScripts: testCount,
      totalPhones: phoneResult,
      platformLanguage: 'RU / KZ',
      telephonyProvider: 'Voximplant',
    });
  } catch (err) {
    console.error('super-admin/settings error:', err);
    res.json({
      totalScripts: 0,
      totalPhones: 0,
      platformLanguage: 'RU / KZ',
      telephonyProvider: '—',
    });
  }
});

// Fallback: for any non-API GET request, serve Mini App (so /index.html etc. work)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/webhooks/')) return next();
  if (INDEX_HTML_PATH) {
    try {
      return sendIndexHtml(res);
    } catch (err) {
      console.error('Error sending index.html (fallback):', err);
    }
  }
  next();
});

// Final 404: friendly message instead of plain "Not Found"
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Маршрут не найден', path: req.path });
  }
  if (req.path.startsWith('/webhooks/')) {
    return res.status(404).json({ error: 'Webhook route not found', path: req.path });
  }
  sendErrorHtml(
    res,
    404,
    'Страница не найдена',
    `Запрошенный адрес «${req.path}» не найден. Mini App открывается по корневому адресу (/) — проверьте URL в настройках бота.`
  );
});

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Try multiple paths for certificates (dev and production)
    const possibleCertPaths = [
      path.join(process.cwd(), 'cert.pem'),
      path.join(__dirname, '../../cert.pem'),
      path.join(__dirname, '../cert.pem'),
    ];
    const possibleKeyPaths = [
      path.join(process.cwd(), 'key.pem'),
      path.join(__dirname, '../../key.pem'),
      path.join(__dirname, '../key.pem'),
    ];

    let certPath: string | null = null;
    let keyPath: string | null = null;

    for (const cp of possibleCertPaths) {
      if (fs.existsSync(cp)) {
        certPath = cp;
        break;
      }
    }

    for (const kp of possibleKeyPaths) {
      if (fs.existsSync(kp)) {
        keyPath = kp;
        break;
      }
    }

    // For tunnel (Cloudflare), always use HTTP - tunnel provides HTTPS
    // When miniAppUrl is localhost, always use HTTP so the site loads in browser immediately
    const useTunnel = config.miniAppUrl.includes('trycloudflare.com') || config.miniAppUrl.includes('loca.lt') || config.miniAppUrl.includes('localtunnel.me') || config.miniAppUrl.includes('serveo') || config.miniAppUrl.includes('lhr.life');
    const isLocalhost = config.miniAppUrl.includes('localhost') || config.miniAppUrl.includes('127.0.0.1');
    const useHttp = useTunnel || isLocalhost || !certPath || !keyPath || !config.miniAppUrl.startsWith('https://');

    const onListen = () => {
      startCallBatchOrchestrator();
      resolve();
    };

    const host = '0.0.0.0'; // listen on all interfaces (Railway requires this)
    const port = parseInt(process.env.PORT || String(config.port), 10);

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error('[ERROR] Port ' + port + ' is already in use.');
        console.error('        Stop the other process or use another port: PORT=3002 npm run dev');
      } else {
        console.error('[ERROR] Server error:', err);
      }
      reject(err);
    };

    function attachVoiceStream(server: http.Server | https.Server): void {
      const wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (ws, _req) => {
        console.log('[voice/stream] Client connected, waiting for message');
        ws.on('message', (data: Buffer | string) => {
          handleVoiceStreamMessage(ws, data.toString());
        });
      });
      server.on('upgrade', (request, socket, head) => {
        if (request.url?.startsWith('/voice/stream')) {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      });
    }

    if (!useHttp && certPath && keyPath) {
      const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
      const httpsServer = https.createServer(options, app);
      attachVoiceStream(httpsServer);
      httpsServer.on('error', onError);
      httpsServer.listen(port, host, () => {
        console.log('[OK] HTTPS server: http://localhost:' + port);
        console.log('     Mini App URL: ' + config.miniAppUrl);
        console.log('     (Self-signed cert - Telegram may show warning)');
        onListen();
      });
    } else {
      const httpServer = http.createServer(app);
      attachVoiceStream(httpServer);
      httpServer.on('error', onError);
      httpServer.listen(port, host, () => {
        const voiceUrls = resolveVoiceCallUrls();
        console.log('[OK] HTTP server: http://localhost:' + port);
        console.log('     Open in browser: http://localhost:' + port);
        console.log('     Health: http://localhost:' + port + '/health');
        console.log('     Voice stream: ws://localhost:' + port + '/voice/stream');
        console.log('     Vox webhook event_url: ' + (voiceUrls.eventUrl || '(not resolved)'));
        if (useTunnel) {
          console.log('     Tunnel will provide HTTPS for Telegram.');
        }
        onListen();
      });
    }
  });
}
