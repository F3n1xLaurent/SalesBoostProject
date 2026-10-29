import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import WebSocket from 'ws';
import { config } from '../config';
import { resolveRealtimeTestPlanConfiguration, type RealtimeTestPlanConfiguration } from './callSettingsManagement';
import { classifyLiveSpeaker, classifyLiveSpeakerLocally, type LiveSpeakerDecision } from './callLiveSpeakerClassifier';
import { elevenLabsWebSocketOptions } from './elevenLabsHttp';
import { startVoiceCall } from './startVoiceCall';
import {
  naturalizeAssistantText,
  pcm16HasSpeech,
  resolveAgentTtsSettings,
  type ElevenLabsTtsSettings,
} from './yandexRealtimeTest';
import { assessUserTurnCompletion, classifyInterruption, mergeLogicalTurnText } from './realtimeConversationFlow';
import { detectVehicleEntityMismatch, vehicleMismatchInstruction } from './realtimeEntityConsistency';
import { appendSpeechAlignment, audibleTextAt, type SpeechAlignmentPoint } from './realtimeBargeIn';
import { hypothesis2SpokenSubject, hypothesis2SpokenText } from './hypothesis2Speech';
import { adaptHypothesis2Prompt, callbackFarewell, pinSelfIntroduction, profileIdentity } from './hypothesis2Dialogue';
import { extractNaturalFarewell, hasClosingIntention, hasNaturalFarewell, throughFirstFarewell } from './hypothesis2Closing';
export { hasNaturalFarewell } from './hypothesis2Closing';

type TurnMetrics = {
  speechDurationMs?: number | null;
  speechToTextMs?: number | null;
  vadEndpointMs?: number | null;
  endpointWaitMs?: number | null;
  llmFirstTextMs?: number | null;
  llmTextGenerationMs?: number | null;
  ttsRequestDelayMs?: number | null;
  ttsSocketWaitMs?: number | null;
  ttsFirstAudioMs?: number | null;
  ttsGenerationMs?: number | null;
  audioDurationMs?: number | null;
  speechToFirstAudioMs?: number | null;
  speechToPlaybackMs?: number | null;
  speechToVoxPlaybackMs?: number | null;
  silentResponseRetries?: number;
  interrupted?: boolean;
  interruptionPlaybackMs?: number;
  heardTextOnInterruption?: string;
  contextCorrected?: boolean;
  cancelRaceCount?: number;
  responseOutputGuardMs?: number;
};

type TranscriptTurn = {
  role: 'manager' | 'client';
  text: string;
  at: string;
  updatedAt?: string;
  metrics: TurnMetrics;
};

type RealtimeTestProvider = 'comet' | 'openai';

type CometRealtimeTestSession = {
  callId: string;
  token: string;
  provider: RealtimeTestProvider;
  model: string;
  planId: string;
  planName: string;
  phone: string;
  prompt: string;
  subjectTitle: string | null;
  elevenLabsVoiceId: string;
  elevenLabsTts: ElevenLabsTtsSettings;
  status: string;
  createdAt: string;
  startedAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  providerConnectedAt: string | null;
  providerReadyAt: string | null;
  providerWarmupDoneAt: string | null;
  firstSpeechStoppedAt: string | null;
  firstTextAfterSpeechAt: string | null;
  firstAudioAfterSpeechAt: string | null;
  transcript: TranscriptTurn[];
  tools: Array<{ name: string; arguments: Record<string, unknown>; at: string }>;
  ivrDetected: boolean;
  ivrPath: string[];
  connectionState: 'awaiting_answer' | 'waiting_operator' | 'live_conversation';
  errors: string[];
  flowEvents?: Array<{ type: 'barge_in_candidate' | 'barge_in_confirmed' | 'barge_in_ignored'; at: string; reason: string; latencyMs?: number }>;
};

const sessions = new Map<string, CometRealtimeTestSession>();
export type Hypothesis2Snapshot = ReturnType<typeof publicSession>;
const MAX_ITEMS = 100;
const COMET_REALTIME_TEST_MODELS = new Set([
  'gpt-realtime-2',
  'gpt-realtime-2.1',
  'gpt-realtime-2.1-mini',
]);

function providerLabel(session: CometRealtimeTestSession): 'CometAPI' | 'OpenAI' {
  return session.provider === 'openai' ? 'OpenAI' : 'CometAPI';
}

function providerConfiguration(session: CometRealtimeTestSession) {
  return session.provider === 'openai'
    ? {
        apiKey: config.openaiRealtimeApiKey,
        url: config.openaiRealtimeUrl,
        reasoningEffort: config.openaiRealtimeReasoningEffort,
        endpointSilenceMs: config.openaiRealtimeEndpointSilenceMs,
        longTurnEndpointSilenceMs: config.openaiRealtimeLongTurnEndpointSilenceMs,
        longTurnThresholdMs: config.openaiRealtimeLongTurnThresholdMs,
        transcriptionModel: config.openaiRealtimeTranscriptionModel,
      }
    : {
        apiKey: config.cometApiKey,
        url: config.cometRealtimeUrl,
        reasoningEffort: config.cometRealtimeReasoningEffort,
        endpointSilenceMs: config.cometRealtimeEndpointSilenceMs,
        longTurnEndpointSilenceMs: config.cometRealtimeEndpointSilenceMs,
        longTurnThresholdMs: Number.POSITIVE_INFINITY,
        transcriptionModel: config.cometRealtimeTranscriptionModel,
      };
}

function isoNow(): string {
  return new Date().toISOString();
}

function elapsed(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.max(0, new Date(to).getTime() - new Date(from).getTime());
}

function normalizePhone(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

function publicSession(session: CometRealtimeTestSession) {
  return {
    callId: session.callId,
    provider: session.provider,
    planId: session.planId,
    planName: session.planName,
    phone: session.phone,
    status: session.status,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    connectedAt: session.connectedAt,
    endedAt: session.endedAt,
    yandexConnectedAt: session.providerConnectedAt,
    providerConnectedAt: session.providerConnectedAt,
    providerReadyAt: session.providerReadyAt,
    providerWarmupDoneAt: session.providerWarmupDoneAt,
    model: session.model,
    voice: {
      voiceId: session.elevenLabsVoiceId,
      modelId: session.elevenLabsTts.modelId,
      stability: session.elevenLabsTts.stability,
      similarityBoost: session.elevenLabsTts.similarityBoost,
      speed: session.elevenLabsTts.speed,
      source: session.elevenLabsTts.source,
    },
    transcript: session.transcript,
    tools: session.tools,
    ivrDetected: session.ivrDetected,
    ivrPath: session.ivrPath,
    connectionState: session.connectionState,
    conversationFlow: {
      bargeInEnabled: true,
      smartBargeInEnabled: true,
      backchannelEnabled: false,
      listeningBackchannelEnabled: false,
      bargeInSustainedMs: 850,
      endpointSilenceMs: providerConfiguration(session).endpointSilenceMs,
      incompleteTurnEnabled: false,
      turnGraceMs: 0,
      incompleteTurnGraceMs: 0,
      semanticTurnEnabled: false,
      semanticTurnTimeoutMs: 0,
      backchannelMinSpeechMs: 0,
      backchannelCooldownMs: 0,
      backchannelMaxPerTurn: 0,
      seamlessHandoffEnabled: false,
      handoffPauseMs: 0,
      events: session.flowEvents ?? [],
    },
    errors: session.errors,
    metrics: {
      answerMs: elapsed(session.startedAt, session.connectedAt),
      yandexConnectMs: elapsed(session.connectedAt ?? session.startedAt, session.providerConnectedAt),
      providerConnectMs: elapsed(session.connectedAt ?? session.startedAt, session.providerConnectedAt),
      providerReadyMs: elapsed(session.startedAt, session.providerReadyAt),
      providerWarmupMs: elapsed(session.createdAt, session.providerWarmupDoneAt),
      speechToFirstTextMs: elapsed(session.firstSpeechStoppedAt, session.firstTextAfterSpeechAt),
      speechToFirstAudioMs: elapsed(session.firstSpeechStoppedAt, session.firstAudioAfterSpeechAt),
      textToFirstAudioMs: elapsed(session.firstTextAfterSpeechAt, session.firstAudioAfterSpeechAt),
    },
  };
}

export async function handleStartCometRealtimeTest(req: Request, res: Response): Promise<void> {
  const provider: RealtimeTestProvider = req.body?.provider === 'openai' ? 'openai' : 'comet';
  const planId = String(req.body?.planId ?? '').trim();
  const phone = normalizePhone(req.body?.to);
  const requestedModel = String(req.body?.model ?? '').trim();
  const model = requestedModel || (provider === 'openai' ? config.openaiRealtimeModel : config.cometRealtimeModel);
  const providerName = provider === 'openai' ? 'OpenAI' : 'CometAPI';
  const providerApiKey = provider === 'openai' ? config.openaiRealtimeApiKey : config.cometApiKey;
  if (!planId) {
    res.status(400).json({ error: 'Выберите план прозвона.' });
    return;
  }
  if (phone.length < 11) {
    res.status(400).json({ error: 'Укажите корректный номер телефона.' });
    return;
  }
  if (!providerApiKey) {
    res.status(400).json({
      error: provider === 'openai'
        ? 'Для прямого OpenAI Realtime задайте OPENAI_REALTIME_API_KEY на сервере.'
        : 'Для гипотезы 2 задайте COMETAPI_API_KEY на сервере.',
    });
    return;
  }
  if (requestedModel && !COMET_REALTIME_TEST_MODELS.has(model)) {
    res.status(400).json({ error: `Выберите поддерживаемую Realtime-модель ${providerName}.` });
    return;
  }

  try {
    const plan = await resolveRealtimeTestPlanConfiguration(req, planId);
    const elevenLabsTts = await resolveAgentTtsSettings();
    const voiceId = plan.elevenLabsVoiceId || elevenLabsTts.defaultVoiceId || config.elevenLabsVoiceId;
    if (!voiceId || !config.elevenLabsApiKey) {
      res.status(400).json({ error: 'Для выбранного профиля или в ELEVENLABS_VOICE_ID не задан голос ElevenLabs.' });
      return;
    }
    const callId = randomUUID();
    const token = randomUUID();
    const session: CometRealtimeTestSession = {
      callId,
      token,
      provider,
      model,
      planId: plan.planId,
      planName: plan.planName,
      phone,
      prompt: plan.prompt,
      subjectTitle: plan.subjectTitle,
      elevenLabsVoiceId: voiceId,
      elevenLabsTts,
      status: 'starting',
      createdAt: isoNow(),
      startedAt: null,
      connectedAt: null,
      endedAt: null,
      providerConnectedAt: null,
      providerReadyAt: null,
      providerWarmupDoneAt: null,
      firstSpeechStoppedAt: null,
      firstTextAfterSpeechAt: null,
      firstAudioAfterSpeechAt: null,
      transcript: [],
      tools: [],
      ivrDetected: false,
      ivrPath: [],
      connectionState: 'awaiting_answer',
      errors: [],
    };
    sessions.set(callId, session);
    prepareRealtimeProviders(session);
    let providerReady = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const prepared = preparedCometConnections.get(callId);
      if (prepared && await prepared.waitUntilReady(5_000)) {
        providerReady = true;
        break;
      }
      session.errors.push(`${providerName}: предварительное соединение не готово (${attempt}/3)`);
      prepared?.close();
      if (attempt < 3) preparedCometConnections.set(callId, new PreparedCometConnection(session));
    }
    if (!providerReady) {
      disposePreparedProviders(callId);
      sessions.delete(callId);
      res.status(503).json({
        error: `${providerName} Realtime сейчас недоступен: соединение закрывается до создания сессии. Звонок не был инициирован.`,
      });
      return;
    }
    const result = await startVoiceCall(phone, {
      scenario: 'comet_realtime_test',
      callId,
      streamToken: token,
    });
    if ('error' in result) {
      disposePreparedProviders(callId);
      sessions.delete(callId);
      res.status(400).json({ error: result.error });
      return;
    }
    session.status = 'dialing';
    session.startedAt = result.startedAt;
    res.json(publicSession(session));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось запустить гипотезу 2.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export function handleGetCometRealtimeTest(req: Request, res: Response): boolean {
  const session = sessions.get(String(req.params.callId ?? ''));
  if (!session) return false;
  res.json(publicSession(session));
  return true;
}

/** Same bridge and providers as a call, without StartScenarios or telephony. */
export async function createHypothesis2Simulation(
  plan: RealtimeTestPlanConfiguration,
  model: string,
  vox: WebSocket,
  tts: ElevenLabsTtsSettings,
) {
  if (!COMET_REALTIME_TEST_MODELS.has(model)) throw new Error('Неподдерживаемая Realtime-модель.');
  const at = isoNow();
  const session: CometRealtimeTestSession = {
    callId: randomUUID(), token: randomUUID(), provider: 'openai', model,
    planId: plan.planId, planName: plan.planName, phone: 'simulation', prompt: plan.prompt,
    subjectTitle: plan.subjectTitle,
    elevenLabsVoiceId: plan.elevenLabsVoiceId || tts.defaultVoiceId || config.elevenLabsVoiceId || '',
    elevenLabsTts: tts, status: 'starting', createdAt: at, startedAt: at, connectedAt: at,
    endedAt: null, providerConnectedAt: null, providerReadyAt: null, providerWarmupDoneAt: null,
    firstSpeechStoppedAt: null, firstTextAfterSpeechAt: null, firstAudioAfterSpeechAt: null,
    transcript: [], tools: [], ivrDetected: false, ivrPath: [], connectionState: 'awaiting_answer', errors: [],
  };
  if (!config.openaiRealtimeApiKey || !config.elevenLabsApiKey || !session.elevenLabsVoiceId) {
    throw new Error('Для стенда нужны ключи OpenAI Realtime, ElevenLabs и голос выбранного плана.');
  }
  sessions.set(session.callId, session);
  try {
    prepareRealtimeProviders(session);
    if (!await preparedCometConnections.get(session.callId)!.waitUntilReady(15_000)) {
      throw new Error(session.errors.join('; ') || 'OpenAI Realtime не создал сессию.');
    }
    handleCometRealtimeTestSocket(vox, `/voice/comet-realtime-test?call_id=${session.callId}&token=${session.token}`);
    session.status = 'ready';
    return {
      snapshot: () => publicSession(session),
      close: () => {
        vox.close();
        session.status = 'disconnected';
        session.endedAt = isoNow();
        disposePreparedProviders(session.callId);
        sessions.delete(session.callId);
      },
    };
  } catch (error) {
    disposePreparedProviders(session.callId);
    sessions.delete(session.callId);
    throw error;
  }
}

export function handleCometRealtimeTestWebhook(req: Request, res: Response): void {
  res.status(200).end();
  const session = sessions.get(String(req.body?.call_id ?? '').trim());
  if (!session) return;
  const event = String(req.body?.event ?? '').trim();
  if (event === 'connected') {
    session.status = session.providerConnectedAt ? 'ready' : 'connected';
    session.connectedAt = String(req.body?.ts ?? isoNow());
  } else if (event === 'ivr_detected') {
    session.ivrDetected = true;
    session.connectionState = 'waiting_operator';
  } else if (event === 'ivr_selected') {
    session.ivrDetected = true;
    session.connectionState = 'waiting_operator';
    const details = req.body?.details && typeof req.body.details === 'object' ? req.body.details : {};
    const path = Array.isArray(details.path) ? details.path : Array.isArray(req.body?.path) ? req.body.path : [];
    const normalizedPath = path.map(String).filter((digit: string) => /^[0-9*#]$/.test(digit));
    const digit = String(details.digit ?? req.body?.digit ?? '');
    if (normalizedPath.length) session.ivrPath = normalizedPath;
    else if (/^[0-9*#]$/.test(digit)) session.ivrPath.push(digit);
  } else if (['disconnected', 'failed', 'busy', 'no_answer', 'cancelled'].includes(event)) {
    session.status = event;
    session.endedAt = String(req.body?.ts ?? isoNow());
    disposePreparedProviders(session.callId);
  } else if (event) {
    session.status = event;
  }
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function parseJson(raw: WebSocket.RawData): any | null {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

/** Voximplant media WebSocket exposes PCM16 at 16 kHz, while GPT Realtime 2
 * requires at least 24 kHz. Resample each telephony frame before forwarding it.
 * Vox frames contain an even, stable number of samples, so the exact 3/2 ratio
 * does not accumulate timing drift between frames. */
export function resamplePcm16Base64To24Khz(payload: string): string {
  const source = Buffer.from(payload, 'base64');
  const sourceSamples = Math.floor(source.length / 2);
  if (sourceSamples === 0) return '';
  const outputSamples = Math.floor(sourceSamples * 1.5);
  const output = Buffer.allocUnsafe(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourcePosition = index * (2 / 3);
    const leftIndex = Math.min(sourceSamples - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(sourceSamples - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    const left = source.readInt16LE(leftIndex * 2);
    const right = source.readInt16LE(rightIndex * 2);
    const sample = Math.max(-32768, Math.min(32767, Math.round(left + (right - left) * fraction)));
    output.writeInt16LE(sample, index * 2);
  }
  return output.toString('base64');
}

function pcm16MeanAbsolute(audio: Buffer): number {
  if (audio.length < 2) return 0;
  let total = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < audio.length; offset += 8) {
    total += Math.abs(audio.readInt16LE(offset));
    samples += 1;
  }
  return samples ? total / samples : 0;
}

const TECHNICAL_SPEECH_PATTERN = /(?:end[_ ]call|(?:вызов(?:и|ите)|используй(?:те)?)\s+(?:функци(?:ю|и)|инструмент)|(?:кратк(?:ое|ая|ую|о)\s+)?заверш[а-яё]*\s+(?:этот\s+)?(?:разговор|диалог|звонок)|служебн(?:ая|ую|ое|ый)\s+(?:фраза|инструкция|комментарий|итог)|(?:я\s+)?(?:(?:сейчас|тогда|теперь)\s+)?(?:хочу|хотел(?:а)?\s+бы|должен|должна|собираюсь|буду)\s+(?:завершить|закончить|завершать|заканчивать)\s+(?:разговор|диалог|звонок)|(?:я\s+)?(?:(?:сейчас|тогда|теперь)\s+)?(?:хочу|хотел(?:а)?\s+бы|должен|должна|собираюсь|буду|могу)\s+попрощаться|мне\s+(?:нужно|осталось)\s+(?:завершить|закончить|попрощаться)|давайте\s+(?:я\s+)?(?:завершу|закончу|попрощаюсь)|(?:подытожу|подведу\s+итог)(?:\s+для\s+себя)?(?:.|\s)*(?:решу|определюсь|подумаю)|решу\s*,?\s+как\s+лучше\s+поступить|(?:(?:хорошо|супер)\s*,?\s*)?(?:тогда\s+)?сейчас\s+(?:коротко\s+)?договоримся(?:.|\s)*(?:я\s+)?(?:поеду|пойду|решу|определюсь))/iu;

export function sanitizeRealtimeSpokenText(text: string): string {
  const safe: string[] = [];
  for (const part of text.split(/(?<=[.!?…])\s+/u)) {
    const technical = containsTechnicalRealtimeSpeech(part);
    const candidate = technical ? extractNaturalFarewell(part) : part.trim();
    if (!candidate) continue;
    safe.push(throughFirstFarewell(candidate));
    if (hasNaturalFarewell(candidate)) break;
  }
  return safe.join(' ').trim();
}

export function containsTechnicalRealtimeSpeech(text: string): boolean {
  return TECHNICAL_SPEECH_PATTERN.test(text) || hasClosingIntention(text)
    || (!text.includes('?') && /(?:сейчас|тогда)\s+(?:я\s+)?(?:быстро|коротко)\s+уточню(?:.|\s)*(?:по\s+делу|дальше|поедем|понятно)/iu.test(text));
}

export function hasExplicitHoldInstruction(text: string): boolean {
  const explicit = /(?:оставайтесь\s+на\s+линии|не\s+кладите\s+трубку|сейчас\s+(?:вас\s+)?(?:соединю|переключу|переведу|уточню|проверю)|соединя(?:ю|ем)|переключа(?:ю|ем)|нажмите|наберите|выберите\s+(?:пункт|цифру|клавишу))/iu.test(text);
  if (explicit) return true;
  // "Подождите, у меня другой вопрос" is a request for the floor, not hold.
  if (/(?:у\s+меня\s+(?:другой\s+)?вопрос|я\s+хотел(?:а)?\s+(?:уточнить|спросить|сказать)|а\s+скажите)/iu.test(text)) return false;
  return /(?:подожд(?:и|ите|ём|ем)|(?:минут(?:у|ку|очку)|секунд(?:у|очку))(?:\s|[,!.]|$))/iu.test(text);
}

export function classifyHypothesis2LineLocally(text: string): LiveSpeakerDecision | null {
  // A past transfer mentioned by a named employee must not match the broad
  // recording marker "ваш звонок" in the shared primary-dialer classifier.
  if (!hasExplicitHoldInstruction(text)
    && /(?:коллега|сотрудник|менеджер)\s+(?:мне\s+)?передал[аи]?\s+(?:мне\s+)?(?:ваш\s+)?звонок/iu.test(text)
    && /(?:алло|меня\s+зовут|чем\s+могу\s+помочь)/iu.test(text)) {
    return { speakerType: 'live_human', confidence: 1, reason: 'named_employee_after_transfer' };
  }
  return classifyLiveSpeakerLocally(text);
}

export function isGarbledManagerText(text: string): boolean {
  return /(?:^|[.!?]\s*)(?:который|которая|которые)\s+было(?:\s|[.,!?]|$)/iu.test(text.trim());
}

export function looksLikeManagerQuestion(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return /\?/u.test(normalized)
    || /^(?:а\s+)?(?:как|какой|какая|какое|какие|когда|где|куда|откуда|почему|зачем|сколько|кто|что|чем|можете|хотите|будете|планируете|рассматриваете|подскажите|скажите)(?:\s|$)/iu.test(normalized);
}

export function extractManagerPreferredName(text: string): string | null {
  const patterns = [
    /меня\s+зовут\s+не\s+[а-яё][а-яё-]{1,30}\s*,?\s*а\s+([а-яё][а-яё-]{1,30})/iu,
    /(?:меня\s+зовут|моё\s+имя)\s+([а-яё][а-яё-]{1,30})/iu,
    /(?:зовите|называйте)(?:\s+меня)?\s+([а-яё][а-яё-]{1,30})|(?:обращайтесь\s+ко\s+мне)\s+([а-яё][а-яё-]{1,30})/iu,
    /(?:не\s+[а-яё][а-яё-]{1,30}\s*,?\s*а|(?:вообще|вообще-то)\s+я)\s+([а-яё][а-яё-]{1,30})/iu,
    /(?:теперь\s+я|давайте\s+я\s+буду|считайте\s*,?\s+что\s+я)\s+([а-яё][а-яё-]{1,30})/iu,
    /я\s+(?:уже\s+)?не\s+[а-яё][а-яё-]{1,30}\s*,?\s*(?:я\s+)?([а-яё][а-яё-]{1,30})/iu,
  ];
  for (const pattern of patterns) {
    const match = text.trim().match(pattern);
    if (match?.[1] || match?.[2]) {
      const name = match[1] ?? match[2];
      return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }
  }
  return null;
}

const RUSSIAN_NAME_ALIASES: Record<string, string> = {
  александр: 'александр', саша: 'александр', саш: 'александр',
  алексей: 'алексей', лёша: 'алексей', леша: 'алексей', лёш: 'алексей', леш: 'алексей',
  дмитрий: 'дмитрий', дима: 'дмитрий', дим: 'дмитрий',
  иван: 'иван', ваня: 'иван', вань: 'иван',
  михаил: 'михаил', миша: 'михаил', миш: 'михаил',
  николай: 'николай', коля: 'николай', коль: 'николай',
  сергей: 'сергей', серёжа: 'сергей', сережа: 'сергей', серёж: 'сергей', сереж: 'сергей',
  антон: 'антон', максим: 'максим', макс: 'максим', никита: 'никита',
  андрей: 'андрей', игорь: 'игорь', олег: 'олег', виктор: 'виктор',
  анна: 'анна', аня: 'анна', елена: 'елена', лена: 'елена',
  мария: 'мария', маша: 'мария', нина: 'нина', ольга: 'ольга',
  татьяна: 'татьяна', таня: 'татьяна', наталья: 'наталья', наташа: 'наталья',
};

function canonicalRussianName(value: string): string | null {
  return RUSSIAN_NAME_ALIASES[value.trim().toLowerCase().replace(/ё/gu, 'е')] ?? null;
}

export function extractAssistantPreferredName(text: string): string | null {
  const match = text.match(/(?:меня\s+зовут|моё\s+имя)\s+([а-яё][а-яё-]{1,30})/iu);
  const short = text.match(/(?:^|[.!?]\s*)[Яя]\s+([А-ЯЁ][а-яё-]+)(?=[,.!?]|$)/u);
  const name = match?.[1] ?? (short?.[1] && canonicalRussianName(short[1]) ? short[1] : null);
  if (!name) return null;
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

export function extractManagerAddressedClientName(text: string): string | null {
  const normalized = text.trim();
  const discourseMatch = normalized.match(/^(?:да|нет|слушайте|смотрите|хорошо|понятно|конечно|ну)\s*,\s*([а-яё][а-яё-]{1,30})\s*[,!]/iu);
  const directMatch = normalized.match(/^([а-яё][а-яё-]{1,30})\s*[,!]/iu);
  const candidate = discourseMatch?.[1] ?? directMatch?.[1] ?? '';
  if (!candidate || !canonicalRussianName(candidate)) return null;
  return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
}

export function areRussianNamesEquivalent(left: string, right: string): boolean {
  const leftCanonical = canonicalRussianName(left) ?? left.trim().toLowerCase();
  const rightCanonical = canonicalRussianName(right) ?? right.trim().toLowerCase();
  return leftCanonical === rightCanonical;
}

type PreparedElevenLabsSpeechSocket = {
  ws: WebSocket;
  connectStartedAt: string;
  openedAt: string | null;
};

const preparedSpeechSockets = new Map<string, PreparedElevenLabsSpeechSocket>();

function elevenLabsSpeechSocketUrl(session: CometRealtimeTestSession): string {
  const tts = session.elevenLabsTts;
  return `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(session.elevenLabsVoiceId)}/stream-input?model_id=${encodeURIComponent(tts.modelId)}&output_format=ulaw_8000&language_code=ru&optimize_streaming_latency=${tts.optimizeStreamingLatency}&inactivity_timeout=60`;
}

class CometElevenLabsTurn {
  readonly alignment: SpeechAlignmentPoint[] = [];
  playbackStartedAt: string | null = null;
  get totalAudioMs(): number { return this.audioBytes / 8; }
  private ws: WebSocket | null = null;
  private opened = false;
  private stopped = false;
  private finishRequested = false;
  private finishSent = false;
  private generationFinished = false;
  private textSent = false;
  private farewellSent = false;
  private textBuffer = '';
  private pending: string[] = [];
  private audioQueue: Buffer[] = [];
  private audioTimer: NodeJS.Timeout | null = null;
  private mediaStarted = false;
  private sequence = 0;
  private chunk = 0;
  private timestamp = 0;
  private audioBytes = 0;
  private initialBurstPacketsRemaining = 8;
  private socketStartedAt: string | null = null;
  private ttsRequestedAt: string | null = null;
  private readonly dialogueProtocol: boolean;

  constructor(
    private readonly session: CometRealtimeTestSession,
    private readonly vox: WebSocket,
    private readonly metrics: TurnMetrics,
    private readonly firstTextAt: string,
    private readonly speechStoppedAt: string | null,
    private readonly dialogueSocket: CometElevenLabsV4Socket | null,
    private readonly shouldBlockFarewell: () => boolean,
    private readonly onPlaybackStarted: () => void,
    private readonly onStopped: () => void,
    private readonly normalizeSpeech: (text: string) => string = (text) => text,
  ) {
    this.dialogueProtocol = /^eleven_v4/.test(session.elevenLabsTts.modelId);
  }

  append(delta: string): void {
    if (this.stopped || !delta) return;
    this.textBuffer += delta;
    // Validate a complete sentence before sending it to TTS. Character-sized
    // chunks used to split «Я хочу… / завершить разговор», allowing
    // the first, harmless-looking half to be spoken before the filter saw the
    // technical continuation.
    let boundary = 0;
    for (const ending of this.textBuffer.matchAll(/[.!?…]+(?:\s+|$)/gu)) {
      boundary = (ending.index ?? 0) + ending[0].length;
    }
    if (boundary > 0) this.flushText(boundary);
  }

  finish(): void {
    if (this.stopped) return;
    this.flushText();
    if (!this.textSent && this.pending.length === 0) return this.stopMedia();
    this.finishRequested = true;
    this.ensureSocket();
    this.flushPending();
  }

  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.audioTimer = null;
    this.audioQueue = [];
    this.pending = [];
    if (this.dialogueSocket) this.dialogueSocket.cancel(this);
    else {
      try { this.ws?.close(); } catch { /* noop */ }
    }
    this.onStopped();
  }

  private flushText(boundary = this.textBuffer.length): void {
    let text = this.textBuffer.slice(0, boundary).trim();
    this.textBuffer = this.textBuffer.slice(boundary).trimStart();
    if (!text) return;
    if (this.farewellSent) return;
    text = this.normalizeSpeech(sanitizeRealtimeSpokenText(text));
    if (this.shouldBlockFarewell() && hasNaturalFarewell(text)) text = '';
    if (!this.textSent && this.pending.length === 0) text = naturalizeAssistantText(text);
    if (!text) return;
    if (hasNaturalFarewell(text)) this.farewellSent = true;
    this.pending.push(`${hypothesis2SpokenText(text, this.session.subjectTitle)} `);
    this.ensureSocket();
    this.flushPending();
  }

  private ensureSocket(): void {
    if (this.dialogueSocket) {
      this.opened = true;
      this.dialogueSocket.connect();
      return;
    }
    if (this.ws || this.stopped) return;
    const tts = this.session.elevenLabsTts;
    const url = this.dialogueProtocol
      ? `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=${encodeURIComponent(tts.modelId)}&output_format=ulaw_8000&language_code=ru&sync_alignment=true&apply_text_normalization=on`
      : elevenLabsSpeechSocketUrl(this.session);
    const prepared = !this.dialogueProtocol ? preparedSpeechSockets.get(this.session.callId) : null;
    if (prepared) preparedSpeechSockets.delete(this.session.callId);
    const canUsePrepared = prepared
      && (prepared.ws.readyState === WebSocket.OPEN || prepared.ws.readyState === WebSocket.CONNECTING);
    this.socketStartedAt = canUsePrepared ? prepared.connectStartedAt : isoNow();
    const ws = canUsePrepared ? prepared.ws : new WebSocket(url, {
      ...elevenLabsWebSocketOptions(),
      headers: { 'xi-api-key': config.elevenLabsApiKey },
    });
    if (canUsePrepared) {
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
    }
    this.ws = ws;
    const onOpen = () => {
      if (this.stopped) return ws.close();
      this.opened = true;
      this.metrics.ttsSocketWaitMs = elapsed(this.socketStartedAt, isoNow());
      const voiceSettings = {
        stability: tts.stability,
        similarity_boost: tts.similarityBoost,
        speed: tts.speed,
      };
      if (this.dialogueProtocol) {
        sendJson(ws, {
          voices: [this.session.elevenLabsVoiceId],
          voice_settings: voiceSettings,
          ...(tts.pronunciationDictionaryLocators.length
            ? { pronunciation_dictionary_locators: tts.pronunciationDictionaryLocators }
            : {}),
        });
      } else sendJson(ws, { text: ' ', xi_api_key: config.elevenLabsApiKey, voice_settings: voiceSettings });
      this.flushPending();
    };
    if (ws.readyState === WebSocket.OPEN) queueMicrotask(onOpen);
    else ws.once('open', onOpen);
    ws.on('message', (raw) => {
      const message = parseJson(raw);
      if (!message || this.stopped) return;
      if (message.error || message.detail) {
        this.session.errors.push(`ElevenLabs: ${String(message.error?.message ?? message.detail?.message ?? message.error ?? message.detail)}`);
        this.finishGeneration();
        return;
      }
      if (message.audio) this.receiveDialogueAudio(String(message.audio), message.normalizedAlignment ?? message.alignment ?? message.normalized_alignment);
      if (message.is_final_audio_for_turn || message.isFinal || message.is_final) this.finishGeneration();
    });
    ws.on('error', (error) => this.session.errors.push(`ElevenLabs: ${error.message}`));
    ws.on('unexpected-response', (_request, response) => {
      this.session.errors.push(`ElevenLabs WebSocket HTTP ${response.statusCode}`);
    });
    ws.on('close', () => this.finishGeneration());
  }

  private flushPending(): void {
    if (!this.opened) return;
    if (!this.dialogueSocket && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) return;
    while (this.pending.length) {
      const text = this.pending.shift();
      if (!text) continue;
      if (!this.ttsRequestedAt) {
        this.ttsRequestedAt = isoNow();
        this.metrics.ttsRequestDelayMs = elapsed(this.firstTextAt, this.ttsRequestedAt);
      }
      if (this.dialogueSocket) this.dialogueSocket.sendText(this, text, !this.textSent);
      else if (this.dialogueProtocol && this.ws) {
        sendJson(this.ws, { inputs: [{ text, voice_id: this.session.elevenLabsVoiceId, new_turn: !this.textSent }] });
      } else if (this.ws) sendJson(this.ws, { text });
      this.textSent = true;
    }
    if (this.finishRequested && !this.finishSent) {
      this.finishSent = true;
      if (this.dialogueSocket) this.dialogueSocket.finish(this);
      else if (this.ws) sendJson(this.ws, this.dialogueProtocol ? { flush: true } : { text: '' });
    }
  }

  receiveDialogueAudio(payload: string, alignment?: unknown): void {
    if (this.stopped) return;
    appendSpeechAlignment(this.alignment, alignment, this.totalAudioMs);
    this.queueAudio(payload);
  }

  completeDialogueTurn(): void {
    this.finishGeneration();
  }

  hasReceivedDialogueAudio(): boolean {
    return this.audioBytes > 0;
  }

  markDialogueSocketReady(connectStartedAt: string | null, openedAt: string): void {
    if (this.metrics.ttsSocketWaitMs != null) return;
    this.metrics.ttsSocketWaitMs = elapsed(connectStartedAt, openedAt) ?? 0;
  }

  private queueAudio(payload: string): void {
    const audio = Buffer.from(payload, 'base64');
    if (!audio.length) return;
    if (this.audioBytes === 0) {
      const at = isoNow();
      this.metrics.ttsFirstAudioMs = elapsed(this.ttsRequestedAt ?? this.firstTextAt, at);
      this.metrics.speechToFirstAudioMs = elapsed(this.speechStoppedAt, at);
      this.session.firstAudioAfterSpeechAt ??= at;
    }
    this.audioBytes += audio.length;
    for (let offset = 0; offset < audio.length; offset += 320) {
      this.audioQueue.push(audio.subarray(offset, Math.min(offset + 320, audio.length)));
    }
    if (!this.mediaStarted) {
      this.mediaStarted = true;
      this.metrics.speechToPlaybackMs = elapsed(this.speechStoppedAt, isoNow());
      this.onPlaybackStarted();
      sendJson(this.vox, {
        event: 'start',
        sequenceNumber: this.sequence++,
        start: { tag: 'assistant', mediaFormat: { encoding: 'ULAW' } },
      });
    }
    this.pumpAudio();
  }

  private pumpAudio(): void {
    if (this.stopped || !this.mediaStarted || this.audioTimer) return;
    if (!this.audioQueue.length) {
      if (this.generationFinished) this.stopMedia();
      return;
    }
    if (this.initialBurstPacketsRemaining > 0) {
      while (this.audioQueue.length && this.initialBurstPacketsRemaining > 0) {
        const packet = this.audioQueue.shift();
        if (!packet) break;
        this.sendAudioPacket(packet);
        this.initialBurstPacketsRemaining -= 1;
      }
      // If ElevenLabs has not supplied the whole 320 ms startup buffer yet,
      // let the next incoming audio frame continue the burst immediately.
      if (this.initialBurstPacketsRemaining > 0 && !this.generationFinished) return;
      this.scheduleNextAudioPacket(40);
      return;
    }
    const packet = this.audioQueue.shift();
    if (!packet) return;
    this.sendAudioPacket(packet);
    this.scheduleNextAudioPacket(Math.max(20, Math.round(packet.length / 8)));
  }

  private sendAudioPacket(packet: Buffer): void {
    sendJson(this.vox, {
      event: 'media',
      sequenceNumber: this.sequence++,
      media: { tag: 'assistant', chunk: this.chunk++, timestamp: this.timestamp, payload: packet.toString('base64') },
    });
    this.timestamp += packet.length;
  }

  private scheduleNextAudioPacket(delayMs: number): void {
    this.audioTimer = setTimeout(() => {
      this.audioTimer = null;
      this.pumpAudio();
    }, delayMs);
  }

  private finishGeneration(): void {
    if (this.stopped || this.generationFinished) return;
    this.generationFinished = true;
    this.metrics.ttsGenerationMs = elapsed(this.ttsRequestedAt ?? this.firstTextAt, isoNow());
    this.metrics.audioDurationMs = Math.round(this.audioBytes / 8);
    this.pumpAudio();
  }

  private stopMedia(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.audioTimer) clearTimeout(this.audioTimer);
    if (this.mediaStarted) {
      sendJson(this.vox, {
        event: 'stop',
        sequenceNumber: this.sequence++,
        stop: { tag: 'assistant', mediaInfo: {} },
      });
    }
    if (!this.dialogueSocket) {
      try { this.ws?.close(); } catch { /* noop */ }
    }
    this.onStopped();
  }
}

/** One prewarmed ElevenLabs v4 dialogue connection for the whole call. */
class CometElevenLabsV4Socket {
  private ws: WebSocket | null = null;
  private opened = false;
  private closed = false;
  private activeTurn: CometElevenLabsTurn | null = null;
  private activeFrames: unknown[] = [];
  private pending: unknown[] = [];
  private connectStartedAt: string | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly session: CometRealtimeTestSession) {}

  connect(): void {
    if (this.closed || this.ws) return;
    const tts = this.session.elevenLabsTts;
    this.connectStartedAt = isoNow();
    const url = `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=${encodeURIComponent(tts.modelId)}&output_format=ulaw_8000&language_code=ru&sync_alignment=true&apply_text_normalization=on`;
    const ws = new WebSocket(url, {
      ...elevenLabsWebSocketOptions(),
      headers: { 'xi-api-key': config.elevenLabsApiKey },
    });
    this.ws = ws;
    ws.on('open', () => {
      if (this.closed || this.ws !== ws) return ws.close();
      this.opened = true;
      sendJson(ws, {
        voices: [this.session.elevenLabsVoiceId],
        voice_settings: {
          stability: tts.stability,
          similarity_boost: tts.similarityBoost,
          speed: tts.speed,
        },
        ...(tts.pronunciationDictionaryLocators.length
          ? { pronunciation_dictionary_locators: tts.pronunciationDictionaryLocators }
          : {}),
      });
      this.activeTurn?.markDialogueSocketReady(this.connectStartedAt, isoNow());
      const queued = this.pending;
      this.pending = [];
      for (const value of queued) sendJson(ws, value);
      this.keepAliveTimer = setInterval(() => sendJson(ws, { keep_alive: true }), 10_000);
      this.keepAliveTimer.unref();
    });
    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      const message = parseJson(raw);
      if (!message) return;
      const turn = this.activeTurn;
      if (message.audio) turn?.receiveDialogueAudio(String(message.audio), message.normalizedAlignment ?? message.alignment ?? message.normalized_alignment);
      if (message.is_final_audio_for_turn || message.is_final) {
        turn?.completeDialogueTurn();
        this.activeTurn = null;
        this.activeFrames = [];
      }
      if (message.error || message.detail) {
        this.session.errors.push(`ElevenLabs: ${String(message.error?.message ?? message.detail?.message ?? message.error ?? message.detail)}`);
        turn?.completeDialogueTurn();
        this.activeTurn = null;
        this.activeFrames = [];
        try { ws.close(); } catch { /* noop */ }
      }
    });
    ws.on('error', (error) => {
      if (this.ws === ws) this.session.errors.push(`ElevenLabs: ${error.message}`);
    });
    ws.on('unexpected-response', (_request, response) => {
      if (this.ws === ws) this.session.errors.push(`ElevenLabs WebSocket HTTP ${response.statusCode}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.clearKeepAlive();
      this.ws = null;
      this.opened = false;
      const turn = this.activeTurn;
      if (!this.closed && turn && !turn.hasReceivedDialogueAudio()) {
        this.pending = [...this.activeFrames];
        this.connect();
      } else if (turn) {
        turn.completeDialogueTurn();
        this.activeTurn = null;
        this.activeFrames = [];
      }
    });
  }

  sendText(turn: CometElevenLabsTurn, text: string, newTurn: boolean): void {
    if (this.activeTurn && this.activeTurn !== turn) {
      this.session.errors.push('ElevenLabs: attempted overlapping v4 dialogue turns');
      return;
    }
    this.sendForTurn(turn, {
      inputs: [{ text, voice_id: this.session.elevenLabsVoiceId, new_turn: newTurn }],
    });
  }

  finish(turn: CometElevenLabsTurn): void {
    if (this.activeTurn !== turn) return;
    this.sendForTurn(turn, { flush: true });
  }

  cancel(turn: CometElevenLabsTurn): void {
    if (this.activeTurn !== turn) return;
    this.activeTurn = null;
    this.activeFrames = [];
    this.pending = [];
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    this.clearKeepAlive();
    try { ws?.close(); } catch { /* noop */ }
    if (!this.closed) this.connect();
  }

  close(): void {
    this.closed = true;
    this.activeTurn = null;
    this.activeFrames = [];
    this.pending = [];
    this.clearKeepAlive();
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }

  private sendForTurn(turn: CometElevenLabsTurn, value: unknown): void {
    this.activeTurn = turn;
    this.activeFrames.push(value);
    this.connect();
    if (this.opened && this.ws?.readyState === WebSocket.OPEN) {
      const readyAt = isoNow();
      turn.markDialogueSocketReady(readyAt, readyAt);
      sendJson(this.ws, value);
    } else this.pending.push(value);
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }
}

function sessionInstructions(session: CometRealtimeTestSession): string {
  return `${adaptHypothesis2Prompt(session.prompt)}\n\n` +
    'Ты AI-клиент и инициатор исходящего телефонного звонка. На другом конце менеджер, которому позвонил ты. ' +
    'После первого приветствия менеджера обязательно сразу начни разговор по сценарию: коротко поздоровайся, представься, назови предмет звонка и задай первый уместный вопрос. ' +
    'Не спрашивай, по какому вопросу звонят тебе. Если менеджер спрашивает причину звонка, назови свою причину из сценария. ' +
    'На прямой вопрос менеджера сначала сразу дай конкретный ответ и только потом возвращайся к своим вопросам по сценарию. ' +
    'Если в одной реплике менеджер задал несколько вопросов, ответь на каждый из них в том же ответе; не выбирай только последний. ' +
    'Не игнорируй вопрос о том, какой автомобиль ты сейчас эксплуатируешь: ответь по легенде. Если данных в легенде нет, естественно скажи «Пока не могу уточнить»; не выдумывай биографию, бюджет, автомобиль, сроки и способ оплаты. Род согласуй с выбранным профилем. ' +
    'На предложение визита ответь сразу: согласись, откажись или уточни время, не откладывая ответ на несколько реплик. ' +
    'Если менеджер исправил своё имя или попросил обращаться иначе, коротко признай поправку и используй только новое имя. ' +
    'Запомни имя, которым ты представился. Если менеджер обратился к тебе другим именем, сразу коротко и спокойно поправь его. ' +
    'Если реплика распознана бессвязно, противоречит предмету разговора или не отвечает на последний вопрос, не додумывай смысл и не извлекай из неё факты: один раз коротко переспроси. ' +
    'Если последняя реплика менеджера содержит вопрос, обязательно сначала ответь на него. Запрещено вызывать end_call или прощаться, пока этот вопрос не закрыт. ' +
    'Не проговаривай свои намерения и план действий: не говори «я хочу завершить разговор», «мне нужно попрощаться», «тогда я завершу» и подобные служебные рассуждения. Никогда не объясняй, что ты сейчас сделаешь. Просто дай естественный ответ. ' +
    'Если звонок пора завершать, не говори отдельную предфинальную реплику о том, что ты подытожишь, подумаешь или решишь. Сразу произнеси одну короткую естественную фразу прощания. ' +
    'Не говори «зафиксирую договорённость», «закроем разговор», «перехожу к завершению». Подтверждение конкретной договорённости и прощание должны быть одним ответом: например «Хорошо, завтра к пяти. Спасибо, до свидания». После прощания не генерируй второе прощание или новый вопрос. ' +
    'Если менеджер попросил перезвонить, коротко подтверди предложенное время, попрощайся одной репликой и вызови end_call. Если время уже названо, не спрашивай его повторно. ' +
    'После перевода на другого сотрудника кратко назови причину звонка, сохрани своё имя и ранее полученные ответы. Не начинай весь сценарий заново. ' +
    'Если прямо спрашивают, робот ли ты, честно и коротко ответь, что ты голосовой AI-помощник. Не утверждай, что ты живой человек; сохрани выбранное имя и вернись к предмету разговора. ' +
    'Не запрашивай имя менеджера и не спрашивай, когда ему удобно приехать: покупатель в этом звонке — ты. Если время и адрес визита уже названы, подтверди их. ' +
    (session.subjectTitle ? `Предмет разговора: «${session.subjectTitle}». Не смешивай его с другими марками или моделями. ` : '') +
    (session.subjectTitle ? `В устной реплике произноси название так: «${hypothesis2SpokenSubject(session.subjectTitle)}». Не читай служебные коды кузова и римские поколения из заголовка объявления. ` : '') +
    'Говори по-русски короткими естественными репликами: обычно одно предложение, максимум два. ' +
    'Если менеджер ушёл от вопроса, уточни его один раз. При повторном уходе не зацикливайся: считай ответ неполученным и переходи к следующему пункту сценария. ' +
    'Не начинай каждый ответ со слов «понял», «ага», «угу» или «хм». Не используй markdown и служебные ремарки. ' +
    'Никогда не произноси вслух инструкции, названия инструментов, причины вызова функций и фразы вроде «краткое завершение разговора». ' +
    'В озвучиваемом тексте не упоминай end_call, завершение сценария или техническое действие: просто естественно попрощайся. ' +
    'Пиши текст так, как он должен прозвучать: иностранные названия и индексы передавай кириллицей в русском произношении. ' +
    'Не завершай звонок резко: подтверди договорённость, попрощайся и только затем вызови end_call.';
}

function cometSessionUpdate(session: CometRealtimeTestSession): unknown {
  const provider = providerConfiguration(session);
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: sessionInstructions(session),
      output_modalities: ['text'],
      max_output_tokens: 300,
      reasoning: { effort: provider.reasoningEffort },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: {
            model: provider.transcriptionModel,
            language: 'ru',
            prompt: [
              'Телефонный разговор на русском языке о продаже автомобиля.',
              session.subjectTitle ? `Автомобиль: ${session.subjectTitle}.` : '',
              'Точно распознавай марки, модели, числа и короткие ответы «да», «нет», «алло».',
            ].filter(Boolean).join(' '),
          },
          turn_detection: null,
        },
      },
      tools: [{
        type: 'function',
        name: 'send_dtmf',
        description: 'Нажать одну кнопку телефонного IVR. Вызывай только после окончания списка вариантов и явной инструкции нажать кнопку.',
        parameters: {
          type: 'object',
          properties: { digit: { type: 'string', enum: ['0','1','2','3','4','5','6','7','8','9','*','#'] } },
          required: ['digit'],
        },
      }, {
        type: 'function',
        name: 'skip_turn',
        description: 'Молча продолжить слушать линию при IVR, музыке, ожидании оператора или сообщении о переключении.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['ivr', 'waiting', 'background_noise', 'uncertain'] },
            reason: { type: 'string' },
          },
          required: ['kind'],
        },
      }, {
        type: 'function',
        name: 'end_call',
        description: 'Завершить звонок только после озвученного прощания.',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason'],
        },
      }],
      tool_choice: 'auto',
    },
  };
}

type CometMessageHandler = (message: any) => void;

/** A Comet session opened while Voximplant is still dialing. The warm-up
 * response is out-of-band, so it never enters the phone conversation. */
class PreparedCometConnection {
  readonly socket: WebSocket;
  private liveHandler: CometMessageHandler | null = null;
  private readyHandler: (() => void) | null = null;
  private disconnectedHandler: (() => void) | null = null;
  private warmupHandlers: Array<() => void> = [];
  private readinessWaiters: Array<(ready: boolean) => void> = [];
  private ready = false;
  private closed = false;
  private failed = false;

  constructor(private readonly session: CometRealtimeTestSession) {
    const provider = providerConfiguration(session);
    const providerUrl = new URL(provider.url);
    providerUrl.searchParams.set('model', session.model);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${provider.apiKey}`,
    };
    // CometAPI still documents the preview compatibility header. The current
    // direct OpenAI GA WebSocket endpoint does not require it.
    if (session.provider === 'comet') headers['OpenAI-Beta'] = 'realtime=v1';
    this.socket = new WebSocket(providerUrl, {
      headers,
    });
    this.socket.on('open', () => {
      session.providerConnectedAt = isoNow();
    });
    this.socket.on('message', (raw) => this.handleMessage(parseJson(raw)));
    this.socket.on('error', (error) => session.errors.push(`${providerLabel(session)} socket: ${error.message}`));
    this.socket.on('close', (code, reason) => {
      if (this.closed) return;
      this.failed = true;
      this.settlePreparation();
      this.settleReadiness(false);
      if (this.liveHandler && !session.endedAt && !['failed', 'busy', 'no_answer', 'disconnected'].includes(session.status)) {
        session.status = session.provider === 'openai' ? 'openai_disconnected' : 'comet_disconnected';
        session.errors.push(`${providerLabel(session)} disconnected: ${code} ${reason.toString()}`.trim());
      }
      this.disconnectedHandler?.();
    });
  }

  attach(handler: CometMessageHandler, onReady: () => void): void {
    this.liveHandler = handler;
    this.readyHandler = onReady;
    if (this.ready) onReady();
  }

  onWarmupSettled(handler: () => void): void {
    if (this.session.providerWarmupDoneAt) handler();
    else this.warmupHandlers.push(handler);
  }

  waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.failed || this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ready);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      this.readinessWaiters.push(finish);
    });
  }

  onDisconnected(handler: () => void): void {
    this.disconnectedHandler = handler;
    if (this.failed) queueMicrotask(handler);
  }

  isUsable(): boolean {
    return !this.closed
      && !this.failed
      && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN);
  }

  isWarmupActive(): boolean {
    return false;
  }

  close(): void {
    this.closed = true;
    this.disconnectedHandler = null;
    this.settleReadiness(false);
    try { this.socket.close(); } catch { /* noop */ }
  }

  private handleMessage(message: any | null): void {
    if (!message) return;
    const eventType = String(message.type ?? '');
    if (eventType === 'error') {
      if (this.liveHandler) this.liveHandler(message);
      else this.session.errors.push(`${providerLabel(this.session)} preconnect: ${String(message.error?.message ?? message.error ?? 'unknown error')}`);
      return;
    }
    if (eventType === 'session.created') {
      sendJson(this.socket, cometSessionUpdate(this.session));
      return;
    }
    if (eventType === 'session.updated') {
      this.ready = true;
      this.session.providerReadyAt = isoNow();
      // The session handshake itself is the safe warm-up. A synthetic
      // out-of-band response proved counterproductive through CometAPI: the
      // first real manager greeting could receive an empty response.
      this.session.providerWarmupDoneAt = this.session.providerReadyAt;
      this.settlePreparation();
      this.settleReadiness(true);
      this.readyHandler?.();
      return;
    }
    this.liveHandler?.(message);
  }

  private settlePreparation(): void {
    this.session.providerWarmupDoneAt ??= isoNow();
    const handlers = this.warmupHandlers.splice(0);
    for (const handler of handlers) handler();
  }

  private settleReadiness(ready: boolean): void {
    const waiters = this.readinessWaiters.splice(0);
    for (const waiter of waiters) waiter(ready);
  }
}

const preparedCometConnections = new Map<string, PreparedCometConnection>();
const preparedDialogueSockets = new Map<string, CometElevenLabsV4Socket>();

function prepareRealtimeProviders(session: CometRealtimeTestSession): void {
  const comet = new PreparedCometConnection(session);
  preparedCometConnections.set(session.callId, comet);
  if (/^eleven_v4/.test(session.elevenLabsTts.modelId)) {
    const dialogue = new CometElevenLabsV4Socket(session);
    preparedDialogueSockets.set(session.callId, dialogue);
    dialogue.connect();
  } else {
    const prepared: PreparedElevenLabsSpeechSocket = {
      ws: new WebSocket(elevenLabsSpeechSocketUrl(session), {
        ...elevenLabsWebSocketOptions(),
        headers: { 'xi-api-key': config.elevenLabsApiKey },
      }),
      connectStartedAt: isoNow(),
      openedAt: null,
    };
    prepared.ws.once('open', () => { prepared.openedAt = isoNow(); });
    prepared.ws.on('error', (error) => session.errors.push(`ElevenLabs preconnect: ${error.message}`));
    preparedSpeechSockets.set(session.callId, prepared);
  }
}

function disposePreparedProviders(callId: string): void {
  preparedCometConnections.get(callId)?.close();
  preparedCometConnections.delete(callId);
  preparedDialogueSockets.get(callId)?.close();
  preparedDialogueSockets.delete(callId);
  try { preparedSpeechSockets.get(callId)?.ws.close(); } catch { /* noop */ }
  preparedSpeechSockets.delete(callId);
}

export function handleCometRealtimeTestSocket(vox: WebSocket, requestUrl: string): void {
  const url = new URL(requestUrl, 'http://localhost');
  const session = sessions.get(String(url.searchParams.get('call_id') ?? ''));
  if (!session || url.searchParams.get('token') !== session.token) {
    vox.close(1008, 'invalid session');
    return;
  }
  if (!providerConfiguration(session).apiKey) {
    session.errors.push(`${session.provider === 'openai' ? 'OPENAI_REALTIME_API_KEY' : 'COMETAPI_API_KEY'} is missing`);
    vox.close(1011, 'provider is not configured');
    return;
  }

  const cachedPreparedComet = preparedCometConnections.get(session.callId);
  let preparedComet = cachedPreparedComet?.isUsable()
    ? cachedPreparedComet
    : new PreparedCometConnection(session);
  if (cachedPreparedComet && cachedPreparedComet !== preparedComet) {
    cachedPreparedComet.close();
    session.providerReadyAt = null;
    session.providerWarmupDoneAt = null;
  }
  preparedCometConnections.delete(session.callId);
  let comet = preparedComet.socket;
  const dialogueSocket = /^eleven_v4/.test(session.elevenLabsTts.modelId)
    ? (preparedDialogueSockets.get(session.callId) ?? new CometElevenLabsV4Socket(session))
    : null;
  preparedDialogueSockets.delete(session.callId);
  dialogueSocket?.connect();

  let responseActive = false;
  let assistantSpeaking = false;
  let assistantText = '';
  let ttsTurn: CometElevenLabsTurn | null = null;
  let responseCreatedAt: string | null = null;
  let firstTextAt: string | null = null;
  let lastSpeechStartedAt: string | null = null;
  let lastSpeechStoppedAt: string | null = null;
  let lastVoiceActivityAt: string | null = null;
  let lastVadEndpointMs: number | null = null;
  let lastCompletedManagerVoiceAt: string | null = null;
  let lastCompletedManagerCommitAt: string | null = null;
  let currentMetrics: TurnMetrics = {};
  let playbackTurn: CometElevenLabsTurn | null = null;
  let activeResponseId: string | null = null;
  let assistantItemIds: string[] = [];
  const cancelledResponses = new Set<string>();
  const pendingCancellations = new Map<string, { responseId: string; metrics: TurnMetrics }>();
  const contextRepairs: Array<{ metrics: TurnMetrics; deletions: Set<string>; replacementId: string | null; replacementCreated: boolean }> = [];
  let suppressInterruptedOutput = false;
  let managerHasFloor = false;
  let pendingInterruptionInstruction = '';
  let rejectedSkipTurnCount = 0;
  let hangupSent = false;
  let bargeFrames: Buffer[] = [];
  let bargeStartedAt: string | null = null;
  let bargeLastVoiceAt: string | null = null;
  let bargeVoicedMs = 0;
  let bargeTimer: NodeJS.Timeout | null = null;
  const bargeProbes: Array<{ startedAt: string; stoppedAt: string; voicedMs: number }> = [];
  const pendingCommitKinds: Array<'manager' | 'probe'> = [];
  type ManagerCommitTiming = { startedAt: string | null; stoppedAt: string | null; lastVoiceAt: string | null; vadMs: number | null };
  const pendingManagerTimings: ManagerCommitTiming[] = [];
  const committedManagerTimings = new Map<string, ManagerCommitTiming>();
  const committedProbeItems = new Map<string, { startedAt: string; stoppedAt: string; voicedMs: number }>();
  let endCallRequested = false;
  let awaitingAssistantMediaEnd = false;
  let finishAfterPlayback = false;
  let responseRequestPending = false;
  let queuedServerFarewell = false;
  let queuedResponseAfterPlayback = false;
  let queuedResponseInstructions: string | null = null;
  let assistantTurnRecorded = false;
  let responseHadToolCall = false;
  let responseMustAnswerManagerQuestion = false;
  let unansweredManagerQuestion = false;
  const identity = profileIdentity(session.prompt);
  let assistantPreferredName: string | null = identity.name;
  let guardedResponseText: string | null = null;
  const pendingResponseEvents: any[] = [];
  let responseTranscriptTimer: NodeJS.Timeout | null = null;
  let flushingResponseEvents = false;
  let awaitingManagerTranscript = false;
  let managerTranscriptWaitTimer: NodeJS.Timeout | null = null;
  let managerContinuationTimer: NodeJS.Timeout | null = null;
  let pendingManagerContinuationText = '';
  let pendingManagerContinuationIndex: number | null = null;
  let continuationStartedBeforeTranscript = false;
  let managerPreferredName: string | null = null;
  let silentResponseRetryCount = 0;
  let localEndpointTimer: NodeJS.Timeout | null = null;
  let localSpeechVoicedMs = 0;
  let localTurnCommitted = false;
  let localCommitPending = false;
  let localNoiseFloor = 100;
  let providerSessionReady = false;
  let providerReconnectCount = 0;
  let liveSpeakerClassificationRevision = 0;
  const pendingProviderAudio: string[] = [];
  let playServerFarewell: () => void = () => {};

  const clearLocalEndpointTimer = () => {
    if (localEndpointTimer) clearTimeout(localEndpointTimer);
    localEndpointTimer = null;
  };

  const clearManagerTranscriptWaitTimer = () => {
    if (managerTranscriptWaitTimer) clearTimeout(managerTranscriptWaitTimer);
    managerTranscriptWaitTimer = null;
  };

  const clearManagerContinuationTimer = () => {
    if (managerContinuationTimer) clearTimeout(managerContinuationTimer);
    managerContinuationTimer = null;
  };

  const sendHangupOnce = () => {
    if (hangupSent) return;
    hangupSent = true;
    clearLocalEndpointTimer();
    clearManagerTranscriptWaitTimer();
    clearManagerContinuationTimer();
    sendJson(vox, { customEvent: 'control', action: 'hangup' });
  };

  const resetLocalTurn = () => {
    clearLocalEndpointTimer();
    localSpeechVoicedMs = 0;
    localTurnCommitted = false;
    localCommitPending = false;
    if (!providerSessionReady) pendingProviderAudio.length = 0;
    lastSpeechStartedAt = null;
    lastSpeechStoppedAt = null;
    lastVoiceActivityAt = null;
    lastVadEndpointMs = null;
  };

  const flowEvent = (type: 'barge_in_candidate' | 'barge_in_confirmed' | 'barge_in_ignored', reason: string, from?: string) => {
    session.flowEvents ??= [];
    session.flowEvents.push({ type, at: isoNow(), reason, ...(from ? { latencyMs: elapsed(from, isoNow()) ?? 0 } : {}) });
    if (session.flowEvents.length > MAX_ITEMS) session.flowEvents.shift();
  };

  const clearBargeCandidate = () => {
    if (bargeTimer) clearTimeout(bargeTimer);
    bargeTimer = null;
    bargeFrames = [];
    bargeStartedAt = null;
    bargeLastVoiceAt = null;
    bargeVoicedMs = 0;
  };

  const cancelActiveResponse = () => {
    // A pending response.create has no id yet. response.created will cancel it
    // if the manager still has the floor; do not cancel an unrelated response.
    if (!responseActive || !activeResponseId) return;
    if ([...pendingCancellations.values()].some((entry) => entry.responseId === activeResponseId)) return;
    const eventId = `cancel_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    pendingCancellations.set(eventId, { responseId: activeResponseId, metrics: currentMetrics });
    if (pendingCancellations.size > MAX_ITEMS) pendingCancellations.delete(pendingCancellations.keys().next().value!);
    sendJson(comet, { type: 'response.cancel', response_id: activeResponseId, event_id: eventId });
  };

  const normalizeAssistantSpeech = (text: string) => {
    assistantPreferredName ??= extractAssistantPreferredName(text);
    return pinSelfIntroduction(text, assistantPreferredName);
  };

  const managerResponseGuard = () => {
    if (pendingManagerTimings.length || committedManagerTimings.size) return null;
    const text = [...session.transcript].reverse().find((turn) => turn.role === 'manager')?.text ?? '';
    return isGarbledManagerText(text) ? 'Не совсем слышно. Повторите, пожалуйста.' : callbackFarewell(text);
  };

  const flushPendingResponseEvents = () => {
    if (responseTranscriptTimer) clearTimeout(responseTranscriptTimer);
    responseTranscriptTimer = null;
    const events = pendingResponseEvents.splice(0);
    if (events.length) currentMetrics.responseOutputGuardMs = elapsed(events[0].receivedAt, isoNow()) ?? 0;
    flushingResponseEvents = true;
    try { for (const event of events) handleCometMessage(event); }
    finally { flushingResponseEvents = false; }
  };

  const repairAssistantText = (text: string) => {
    const replacementId = text ? `heard_${randomUUID().replace(/-/g, '').slice(0, 24)}` : null;
    contextRepairs.push({ metrics: currentMetrics, deletions: new Set(assistantItemIds), replacementId, replacementCreated: !replacementId });
    currentMetrics.contextCorrected = false;
    for (const id of assistantItemIds) sendJson(comet, { type: 'conversation.item.delete', item_id: id });
    assistantItemIds = [];
    if (replacementId) sendJson(comet, { type: 'conversation.item.create', item: {
      id: replacementId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }],
    } });
  };

  const interruptAssistant = (reason: string, startedAt: string) => {
    if (endCallRequested || finishAfterPlayback || hangupSent) return;
    flowEvent('barge_in_confirmed', reason, startedAt);
    finishAfterPlayback = false;
    queuedServerFarewell = false;
    endCallRequested = false;
    queuedResponseAfterPlayback = false;
    queuedResponseInstructions = null;
    suppressInterruptedOutput = true;
    managerHasFloor = true;
    if (activeResponseId) cancelledResponses.add(activeResponseId);
    cancelActiveResponse();
    const heardMs = playbackTurn?.playbackStartedAt ? elapsed(playbackTurn.playbackStartedAt, isoNow()) ?? 0 : 0;
    const speechSource = hypothesis2SpokenText(normalizeAssistantSpeech(sanitizeRealtimeSpokenText(naturalizeAssistantText(assistantText))), session.subjectTitle);
    const heard = audibleTextAt(playbackTurn?.alignment ?? [], heardMs, speechSource, playbackTurn?.totalAudioMs ?? 0);
    currentMetrics.interrupted = true;
    currentMetrics.interruptionPlaybackMs = heardMs;
    currentMetrics.heardTextOnInterruption = heard;
    currentMetrics.contextCorrected = false;
    pendingInterruptionInstruction = `Менеджер перебил твой предыдущий ответ. Он услышал только: «${heard || 'ничего из реплики ещё не прозвучало'}». ` +
      'Остальная сгенерированная реплика не была произнесена; не считай непрозвучавший вопрос заданным. ' +
      'Дождись всей реплики менеджера и ответь на неё. Не повторяй предыдущую фразу целиком и не начинай знакомство заново. ' +
      'Если менеджер отвечает на предыдущий вопрос, учти ответ и продолжи с уместного места. ';
    // Realtime generated TEXT; conversation.item.truncate only accepts AUDIO.
    // Replace its message with the externally aligned audible prefix instead.
    repairAssistantText(heard);
    const recorded = [...session.transcript].reverse().find((turn) => turn.role === 'client' && turn.metrics === currentMetrics);
    if (recorded) recorded.text = heard || '[реплика не прозвучала]';
    else if (heard) session.transcript.push({ role: 'client', text: heard, at: isoNow(), metrics: currentMetrics });
    assistantTurnRecorded = true;
    const activeTurn = ttsTurn;
    ttsTurn = null;
    // Block onStopped from resetting manager speech while cancelling audio.
    awaitingAssistantMediaEnd = true;
    activeTurn?.cancel();
    sendJson(vox, { customEvent: 'control', action: 'clear_media' });
    assistantSpeaking = false;
    awaitingAssistantMediaEnd = false;
    playbackTurn = null;
    resetLocalTurn();
    sendJson(comet, { type: 'input_audio_buffer.clear' });
  };

  const submitBargeProbe = () => {
    bargeTimer = null;
    if (!bargeStartedAt || bargeVoicedMs < 100) return clearBargeCandidate();
    const probe = { startedAt: bargeStartedAt, stoppedAt: bargeLastVoiceAt ?? isoNow(), voicedMs: bargeVoicedMs };
    const audio = resamplePcm16Base64To24Khz(Buffer.concat(bargeFrames).toString('base64'));
    clearBargeCandidate();
    bargeProbes.push(probe);
    pendingCommitKinds.push('probe');
    sendJson(comet, { type: 'input_audio_buffer.append', audio });
    sendJson(comet, { type: 'input_audio_buffer.commit' });
  };

  // Realtime response.instructions replaces the session instructions for that
  // response; it does not append to them. Always repeat the complete scenario
  // here, otherwise an opening/retry response loses the language and call-plan
  // context and may hallucinate an unrelated conversation.
  const responseInstructions = (extra: string) => `${sessionInstructions(session)}\n\n${extra}` +
    (pendingInterruptionInstruction ? `\n\n${pendingInterruptionInstruction}` : '') +
    (assistantPreferredName ? `\n\nТвоё неизменное имя клиента: «${assistantPreferredName}». Ты уже представился этим именем. Не меняй его после перевода или вопроса о роботе; не путай с именем менеджера.` : '') +
    (identity.gender ? `\nГрамматический род клиента на весь звонок: ${identity.gender}. Сохраняй его во всех ответах.` : '') +
    (managerPreferredName
      ? `\n\nТекущее исправленное имя менеджера: «${managerPreferredName}». Не возвращайся к прежнему имени.`
      : '');

  const openingResponseInstructions = () => responseInstructions(
    'Менеджер ответил на твой исходящий звонок. Сразу начни разговор по заданному сценарию: ' +
    'коротко поздоровайся, представься как клиент, назови предмет и причину звонка и задай первый уместный вопрос. ' +
    'Обязательно выдай текстовую реплику, не оставляй ответ пустым.',
  );

  const createResponseNow = (turnInstructions?: string) => {
    if (finishAfterPlayback || hangupSent) return;
    if (preparedComet.isWarmupActive()) {
      queuedResponseAfterPlayback = true;
      queuedResponseInstructions = turnInstructions ?? queuedResponseInstructions;
      return;
    }
    if (responseActive || responseRequestPending || assistantSpeaking || awaitingAssistantMediaEnd) {
      queuedResponseAfterPlayback = true;
      queuedResponseInstructions = turnInstructions ?? queuedResponseInstructions;
      return;
    }
    responseRequestPending = true;
    managerHasFloor = false;
    suppressInterruptedOutput = false;
    // The complete call-plan prompt was already loaded by session.update while
    // Voximplant was dialing. Repeating it in the first response.create makes
    // the model process the long prompt again on the latency-critical turn.
    sendJson(comet, turnInstructions || pendingInterruptionInstruction || assistantPreferredName ? {
      type: 'response.create',
      response: {
        output_modalities: ['text'],
        instructions: responseInstructions(turnInstructions ?? ''),
      },
    } : { type: 'response.create' });
    pendingInterruptionInstruction = '';
  };

  const managerTurnInstructions = (text: string) => {
    const nameInstruction = managerPreferredName && extractManagerPreferredName(text)
      ? ` Менеджер сообщил, что его нужно называть «${managerPreferredName}»: коротко признай поправку и дальше используй только это имя.`
      : '';
    const addressedName = extractManagerAddressedClientName(text);
    const wrongClientNameInstruction = assistantPreferredName && addressedName
      && !areRussianNamesEquivalent(assistantPreferredName, addressedName)
      ? ` Менеджер только что обратился к тебе как «${addressedName}», но ты представился как «${assistantPreferredName}». Начни ответ с короткой естественной поправки имени.`
      : '';
    const entityMismatch = session.subjectTitle
      ? detectVehicleEntityMismatch(session.subjectTitle, text)
      : null;
    const entityInstruction = entityMismatch ? ` ${vehicleMismatchInstruction(entityMismatch)}` : '';
    const clarificationInstruction = isGarbledManagerText(text)
      ? ' Распознавание содержит грамматически бессвязный фрагмент. Следующая реплика должна только попросить повторить сказанное; не придумывай смысл и не задавай новый вопрос сценария.' : '';
    return `Последняя завершённая реплика менеджера дословно: «${text}». ` +
      'Ответь по существу на каждый заданный в ней вопрос, включая перечисленные подряд; ничего не пропускай. ' +
      'Если это не вопрос, естественно отреагируй на всю мысль. Если текст бессвязный или неоднозначный, не додумывай ответ за менеджера — коротко переспроси. ' +
      'Не описывай свои действия. Если договорённость уже достигнута, все вопросы закрыты или менеджер просит перезвонить, закончи одной естественной репликой прощания и вызови end_call.' +
      nameInstruction + wrongClientNameInstruction + entityInstruction + clarificationInstruction;
  };

  const requestResponseAfterManagerTranscript = () => {
    clearManagerTranscriptWaitTimer();
    awaitingManagerTranscript = true;
    // The auxiliary transcript normally follows commit almost immediately.
    // A small bounded wait lets us pin every question and a corrected name to
    // this exact response instead of relying only on the model's audio memory.
    managerTranscriptWaitTimer = setTimeout(() => {
      managerTranscriptWaitTimer = null;
      if (!awaitingManagerTranscript) return;
      awaitingManagerTranscript = false;
      createResponseNow(
        'Ответь сейчас на всю последнюю завершённую реплику менеджера. ' +
        'Если в ней было несколько вопросов, ответь на каждый. Не описывай свои действия. Если всё согласовано или менеджер просит перезвонить, подтверди договорённость и естественно попрощайся.',
      );
    }, 350);
    managerTranscriptWaitTimer.unref();
  };

  const waitForManagerContinuation = (text: string, graceMs = 1_200) => {
    clearManagerContinuationTimer();
    resetLocalTurn();
    sendJson(comet, { type: 'input_audio_buffer.clear' });
    managerContinuationTimer = setTimeout(() => {
      managerContinuationTimer = null;
      const completeText = pendingManagerContinuationText || text;
      pendingManagerContinuationText = '';
      pendingManagerContinuationIndex = null;
      createResponseNow(managerTurnInstructions(completeText));
    }, graceMs);
    managerContinuationTimer.unref();
  };

  const releaseInputAfterPlayback = () => {
    assistantSpeaking = false;
    awaitingAssistantMediaEnd = false;
    if (!lastSpeechStartedAt || localTurnCommitted) {
      resetLocalTurn();
      if (!bargeProbes.length && !committedProbeItems.size) sendJson(comet, { type: 'input_audio_buffer.clear' });
    }
    if (finishAfterPlayback) {
      // This is called on Voximplant's playback-ended acknowledgement, not on
      // TTS generation completion or sending the final packet. No extra wait.
      sendHangupOnce();
      return;
    }
    if (queuedServerFarewell) {
      queuedServerFarewell = false;
      playServerFarewell();
      return;
    }
    if (queuedResponseAfterPlayback) {
      queuedResponseAfterPlayback = false;
      const instructions = queuedResponseInstructions;
      queuedResponseInstructions = null;
      createResponseNow(instructions ?? undefined);
    }
  };

  const commitLocalManagerTurn = () => {
    localEndpointTimer = null;
    if (finishAfterPlayback || endCallRequested || hangupSent) return;
    if (localTurnCommitted || assistantSpeaking || ((responseActive || responseRequestPending) && !managerHasFloor)) return;
    // Keep short but meaningful answers such as «да»/«нет»; the PCM
    // energy threshold already filters low-level telephony noise.
    if (!lastSpeechStartedAt || localSpeechVoicedMs < 100) {
      resetLocalTurn();
      sendJson(comet, { type: 'input_audio_buffer.clear' });
      return;
    }
    lastSpeechStoppedAt = isoNow();
    lastVadEndpointMs = elapsed(lastVoiceActivityAt, lastSpeechStoppedAt);
    lastCompletedManagerVoiceAt = lastVoiceActivityAt ?? lastSpeechStoppedAt;
    lastCompletedManagerCommitAt = lastSpeechStoppedAt;
    localTurnCommitted = true;
    rejectedSkipTurnCount = 0;
    silentResponseRetryCount = 0;
    if (!providerSessionReady) {
      localCommitPending = true;
      return;
    }
    pendingManagerTimings.push({ startedAt: lastSpeechStartedAt, stoppedAt: lastSpeechStoppedAt, lastVoiceAt: lastVoiceActivityAt, vadMs: lastVadEndpointMs });
    pendingCommitKinds.push('manager');
    sendJson(comet, { type: 'input_audio_buffer.commit' });
    requestResponseAfterManagerTranscript();
  };

  const flushProviderAudio = () => {
    if (!providerSessionReady) return;
    while (pendingProviderAudio.length) {
      const audio = pendingProviderAudio.shift();
      if (audio) sendJson(comet, { type: 'input_audio_buffer.append', audio });
    }
    if (localCommitPending) {
      localCommitPending = false;
      pendingManagerTimings.push({ startedAt: lastSpeechStartedAt, stoppedAt: lastSpeechStoppedAt, lastVoiceAt: lastVoiceActivityAt, vadMs: lastVadEndpointMs });
      pendingCommitKinds.push('manager');
      sendJson(comet, { type: 'input_audio_buffer.commit' });
      if (!finishAfterPlayback && !hangupSent) requestResponseAfterManagerTranscript();
    }
  };

  const scheduleLocalEndpoint = () => {
    clearLocalEndpointTimer();
    const provider = providerConfiguration(session);
    const effectiveLongTurnThresholdMs = Math.min(provider.longTurnThresholdMs, 700);
    const silenceMs = localSpeechVoicedMs >= effectiveLongTurnThresholdMs
      ? provider.longTurnEndpointSilenceMs
      : provider.endpointSilenceMs;
    localEndpointTimer = setTimeout(commitLocalManagerTurn, silenceMs);
    localEndpointTimer.unref();
  };

  const recordAssistantTurn = (reportedText?: unknown, completedAt = isoNow()) => {
    if (assistantTurnRecorded) return;
    const finalText = hypothesis2SpokenText(normalizeAssistantSpeech(sanitizeRealtimeSpokenText(
      naturalizeAssistantText(String(reportedText ?? assistantText)),
    )), session.subjectTitle);
    currentMetrics.llmTextGenerationMs = elapsed(firstTextAt, completedAt);
    if (finalText) {
      session.transcript.push({ role: 'client', text: finalText, at: isoNow(), metrics: currentMetrics });
      assistantPreferredName ??= extractAssistantPreferredName(finalText);
    }
    assistantTurnRecorded = true;
  };

  const sendToolResult = (callId: string, output: unknown, requestFollowup: boolean) => {
    sendJson(comet, {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    if (requestFollowup) createResponseNow();
  };

  playServerFarewell = () => {
    if (assistantSpeaking || awaitingAssistantMediaEnd || ttsTurn) {
      queuedServerFarewell = true;
      return;
    }
    const managerText = [...session.transcript].reverse().find((turn) => turn.role === 'manager')?.text ?? '';
    const text = callbackFarewell(managerText) ?? 'Спасибо за ответы, всего доброго.';
    const at = isoNow();
    finishAfterPlayback = true;
    assistantSpeaking = true;
    currentMetrics = {
      endpointWaitMs: 0,
      llmFirstTextMs: 0,
      llmTextGenerationMs: 0,
      ttsRequestDelayMs: 0,
    };
    repairAssistantText(text);
    session.transcript.push({ role: 'client', text, at, metrics: currentMetrics });
    ttsTurn = new CometElevenLabsTurn(
      session,
      vox,
      currentMetrics,
      at,
      null,
      dialogueSocket,
      () => false,
      () => { awaitingAssistantMediaEnd = true; },
      () => {
        ttsTurn = null;
        if (!awaitingAssistantMediaEnd) releaseInputAfterPlayback();
      },
    );
    ttsTurn.append(text);
    ttsTurn.finish();
  };

  const handleCometMessage = (message: any) => {
    const eventType = String(message.type ?? '');

    if (eventType === 'conversation.item.deleted' || eventType === 'conversation.item.created' || eventType === 'conversation.item.added') {
      for (const repair of contextRepairs) {
        if (eventType === 'conversation.item.deleted') repair.deletions.delete(String(message.item_id));
        else if (message.item?.id === repair.replacementId) repair.replacementCreated = true;
        if (!repair.deletions.size && repair.replacementCreated) repair.metrics.contextCorrected = true;
      }
    }

    if (eventType === 'input_audio_buffer.committed') {
      const kind = pendingCommitKinds.shift();
      if (kind === 'probe') {
        const probe = bargeProbes.shift();
        if (probe) committedProbeItems.set(String(message.item_id), probe);
      } else if (kind === 'manager') {
        const timing = pendingManagerTimings.shift();
        if (timing) committedManagerTimings.set(String(message.item_id), timing);
      }
      return;
    }

    if (eventType === 'response.output_item.added' && message.item?.type === 'message') {
      if (cancelledResponses.has(String(message.response_id ?? ''))) {
        sendJson(comet, { type: 'conversation.item.delete', item_id: message.item.id });
      } else assistantItemIds.push(String(message.item.id));
    }
    if (message.response_id && cancelledResponses.has(String(message.response_id)) && eventType !== 'response.done') return;

    // Text generation can beat its asynchronous ASR transcript. Hold only the
    // already-produced output, not model inference, until the current text can
    // be checked for a callback/garbled utterance. Never add a fixed wait when
    // ASR is already available. A bounded fallback protects against absent ASR.
    if (!flushingResponseEvents && !ttsTurn
      && (pendingManagerTimings.length || committedManagerTimings.size)
      && /^(?:response\.(?:output_text|text)\.(?:delta|done)|response\.function_call_arguments\.done|response\.done)$/u.test(eventType)) {
      pendingResponseEvents.push({ ...message, receivedAt: isoNow() });
      if (!responseTranscriptTimer) {
        responseTranscriptTimer = setTimeout(flushPendingResponseEvents, 1200);
        responseTranscriptTimer.unref();
      }
      return;
    }

    if (eventType === 'conversation.item.input_audio_transcription.completed') {
      const text = String(message.transcript ?? '').trim();
      const committedTiming = committedManagerTimings.get(String(message.item_id));
      committedManagerTimings.delete(String(message.item_id));
      const probe = committedProbeItems.get(String(message.item_id));
      committedProbeItems.delete(String(message.item_id));
      if (endCallRequested || finishAfterPlayback || hangupSent) {
        if (probe && message.item_id) sendJson(comet, { type: 'conversation.item.delete', item_id: message.item_id });
        return;
      }
      let probeContinuation: { audio: Buffer; startedAt: string; lastVoiceAt: string; voicedMs: number } | null = null;
      if (probe) {
        const decision = classifyInterruption(text, { awaitingAnswer: false, final: true, minMeaningfulWords: 2 });
        if (decision.kind !== 'interrupt') {
          if (message.item_id) sendJson(comet, { type: 'conversation.item.delete', item_id: message.item_id });
          flowEvent('barge_in_ignored', decision.reason, probe.startedAt);
          return;
        }
        if (bargeStartedAt && bargeLastVoiceAt && bargeVoicedMs > 0) {
          probeContinuation = { audio: Buffer.concat(bargeFrames), startedAt: bargeStartedAt, lastVoiceAt: bargeLastVoiceAt, voicedMs: bargeVoicedMs };
        }
        clearBargeCandidate();
        interruptAssistant(decision.reason, probe.startedAt);
        lastSpeechStartedAt = probe.startedAt;
        lastSpeechStoppedAt = probe.stoppedAt;
        lastVoiceActivityAt = probe.stoppedAt;
        lastCompletedManagerVoiceAt = probe.stoppedAt;
        lastCompletedManagerCommitAt = isoNow();
        awaitingManagerTranscript = true;
        if (probeContinuation) continuationStartedBeforeTranscript = true;
      }
      if (text) {
        let logicalText = pendingManagerContinuationText
          ? mergeLogicalTurnText(pendingManagerContinuationText, text)
          : text;
        let mergeManagerIndex = pendingManagerContinuationIndex;
        if (mergeManagerIndex == null && committedTiming?.startedAt) {
          const previousIndex = session.transcript.map((turn) => turn.role).lastIndexOf('manager');
          const previous = session.transcript[previousIndex];
          const gap = previous ? new Date(committedTiming.startedAt).getTime() - new Date(previous.updatedAt ?? previous.at).getTime() : Infinity;
          const noAudibleNewQuestion = session.transcript.slice(previousIndex + 1).every((turn) => turn.role !== 'client' || turn.metrics.interrupted);
          if (previous && gap >= -2000 && gap <= 2500 && noAudibleNewQuestion) {
            mergeManagerIndex = previousIndex;
            logicalText = mergeLogicalTurnText(previous.text, text);
          }
        }
        const preferredName = extractManagerPreferredName(logicalText);
        if (preferredName) managerPreferredName = preferredName;
        const managerAskedQuestion = looksLikeManagerQuestion(logicalText);
        if (managerAskedQuestion) {
          unansweredManagerQuestion = true;
          if (responseActive) responseMustAnswerManagerQuestion = true;
        }
        const at = isoNow();
        const managerTurn: TranscriptTurn = {
          role: 'manager',
          text: logicalText,
          // Keep the UI in conversational order even though the auxiliary
          // transcript commonly arrives after the model has started replying.
          at: committedTiming?.stoppedAt ?? lastSpeechStoppedAt ?? at,
          updatedAt: at,
          metrics: {
            speechDurationMs: elapsed(committedTiming?.startedAt ?? lastSpeechStartedAt, committedTiming?.lastVoiceAt ?? lastSpeechStoppedAt),
            speechToTextMs: elapsed(committedTiming?.stoppedAt ?? lastSpeechStoppedAt, at),
            vadEndpointMs: committedTiming?.vadMs ?? lastVadEndpointMs,
          },
        };
        let storedManagerIndex: number;
        if (mergeManagerIndex != null
          && session.transcript[mergeManagerIndex]?.role === 'manager') {
          const previous = session.transcript[mergeManagerIndex];
          session.transcript[mergeManagerIndex] = {
            ...managerTurn,
            at: previous.at,
            metrics: {
              ...managerTurn.metrics,
              speechDurationMs: (previous.metrics.speechDurationMs ?? 0)
                + (managerTurn.metrics.speechDurationMs ?? 0),
            },
          };
          storedManagerIndex = mergeManagerIndex;
        } else {
          session.transcript.push(managerTurn);
          storedManagerIndex = session.transcript.length - 1;
        }
        const classificationRevision = ++liveSpeakerClassificationRevision;
        const applyLineDecision = (decision: LiveSpeakerDecision) => {
          if (classificationRevision !== liveSpeakerClassificationRevision) return;
          // Once a live employee has been confirmed, never downgrade the line
          // back to IVR because of a later short/noisy ASR fragment. That used
          // to mute valid assistant audio for tens of seconds mid-dialogue.
          if (session.connectionState === 'live_conversation' && decision.speakerType !== 'live_human') return;
          if (decision.speakerType === 'live_human') {
            session.connectionState = 'live_conversation';
            session.firstSpeechStoppedAt ??= committedTiming?.lastVoiceAt ?? lastCompletedManagerVoiceAt;
            sendJson(vox, { customEvent: 'control', action: 'set_output_enabled', enabled: true });
          } else if (decision.speakerType === 'ivr_or_recording'
            || decision.speakerType === 'background_noise') {
            session.connectionState = 'waiting_operator';
            if (/нажмите|наберите|выберите\s+(?:пункт|цифру|клавишу)|голосов(?:ое|ого)\s+меню/iu.test(text)) {
              session.ivrDetected = true;
            }
            sendJson(vox, { customEvent: 'control', action: 'set_output_enabled', enabled: false });
          }
        };
        const localDecision = session.connectionState === 'live_conversation'
          ? null
          : classifyHypothesis2LineLocally(text);
        if (localDecision) applyLineDecision(localDecision);
        else if (session.connectionState !== 'live_conversation') {
          void classifyLiveSpeaker({
            candidateText: text,
            recentTranscript: session.transcript.slice(-3),
          }).then(applyLineDecision).catch((error) => {
            session.errors.push(`Классификация линии: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        if (awaitingManagerTranscript) {
          awaitingManagerTranscript = false;
          clearManagerTranscriptWaitTimer();
          const previousAssistantText = [...session.transcript]
            .reverse()
            .find((turn) => turn.role === 'client')?.text ?? '';
          const completion = assessUserTurnCompletion(logicalText, previousAssistantText);
          if (continuationStartedBeforeTranscript) {
            continuationStartedBeforeTranscript = false;
            pendingManagerContinuationText = logicalText;
            pendingManagerContinuationIndex = storedManagerIndex;
            if (probeContinuation) {
              lastSpeechStartedAt = probeContinuation.startedAt;
              lastVoiceActivityAt = probeContinuation.lastVoiceAt;
              localSpeechVoicedMs = probeContinuation.voicedMs;
              localTurnCommitted = false;
              sendJson(comet, { type: 'input_audio_buffer.append', audio: resamplePcm16Base64To24Khz(probeContinuation.audio.toString('base64')) });
              scheduleLocalEndpoint();
            }
            return;
          }
          const needsContinuationGuard = completion.incomplete
            || managerAskedQuestion
            || logicalText.trim().split(/\s+/u).length >= 6;
          if (needsContinuationGuard) {
            pendingManagerContinuationText = logicalText;
            pendingManagerContinuationIndex = storedManagerIndex;
            waitForManagerContinuation(logicalText, completion.incomplete ? 1_200 : 500);
          } else {
            clearManagerContinuationTimer();
            pendingManagerContinuationText = '';
            pendingManagerContinuationIndex = null;
            createResponseNow(managerTurnInstructions(logicalText));
          }
        }
      }
      if (!pendingManagerTimings.length && !committedManagerTimings.size) flushPendingResponseEvents();
      return;
    }
    if (eventType === 'response.created') {
      if (managerHasFloor && suppressInterruptedOutput) {
        activeResponseId = String(message.response?.id ?? '');
        cancelledResponses.add(activeResponseId);
        responseRequestPending = false;
        responseActive = true;
        cancelActiveResponse();
        return;
      }
      responseRequestPending = false;
      responseActive = true;
      activeResponseId = String(message.response?.id ?? '');
      assistantItemIds = [];
      suppressInterruptedOutput = false;
      managerHasFloor = false;
      playbackTurn = null;
      guardedResponseText = managerResponseGuard();
      responseCreatedAt = isoNow();
      firstTextAt = null;
      assistantText = '';
      currentMetrics = {
        endpointWaitMs: elapsed(lastCompletedManagerCommitAt ?? lastSpeechStoppedAt, responseCreatedAt),
        silentResponseRetries: silentResponseRetryCount || undefined,
      };
      assistantTurnRecorded = false;
      responseHadToolCall = false;
      responseMustAnswerManagerQuestion = unansweredManagerQuestion;
      ttsTurn = null;
      return;
    }
    if (eventType === 'response.output_text.delta' || eventType === 'response.text.delta') {
      if (suppressInterruptedOutput) return;
      const delta = String(message.delta ?? '');
      if (!delta) return;
      const at: string = message.receivedAt ?? isoNow();
      if (!firstTextAt) {
        firstTextAt = at;
        if (session.connectionState === 'live_conversation') session.firstTextAfterSpeechAt ??= at;
        currentMetrics.llmFirstTextMs = elapsed(responseCreatedAt, at);
      }
      assistantText += delta;
      // These turns need no speculation. Wait for response.done, then send one
      // complete clarification/callback confirmation, never the model's guess.
      if (!message.guardResolved) guardedResponseText ??= !ttsTurn ? managerResponseGuard() : null;
      if (guardedResponseText) return;
      if (!ttsTurn) {
        assistantSpeaking = true;
        ttsTurn = new CometElevenLabsTurn(
          session,
          vox,
          currentMetrics,
          firstTextAt,
          lastCompletedManagerVoiceAt ?? lastSpeechStoppedAt,
          dialogueSocket,
          () => responseMustAnswerManagerQuestion,
          () => {
            awaitingAssistantMediaEnd = true;
            session.firstSpeechStoppedAt ??= lastCompletedManagerVoiceAt;
            session.firstTextAfterSpeechAt ??= firstTextAt;
            session.firstAudioAfterSpeechAt ??= isoNow();
          },
          () => {
            ttsTurn = null;
            if (!awaitingAssistantMediaEnd) releaseInputAfterPlayback();
          },
          normalizeAssistantSpeech,
        );
        playbackTurn = ttsTurn;
      }
      ttsTurn.append(delta);
      return;
    }
    if (eventType === 'response.output_text.done' || eventType === 'response.text.done') {
      if (suppressInterruptedOutput) return;
      // Keep the text stream open until tools are finished. end_call may need
      // to append a goodbye to this SAME TTS turn, without discarding its body.
      if (!guardedResponseText) recordAssistantTurn(message.text, message.receivedAt ?? isoNow());
      return;
    }
    if (eventType === 'response.function_call_arguments.done') {
      if (suppressInterruptedOutput) return;
      responseHadToolCall = true;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(message.arguments ?? '{}')); } catch { /* noop */ }
      const name = String(message.name ?? '');
      session.tools.push({ name, arguments: args, at: isoNow() });
      if (name === 'send_dtmf') {
        const digit = String(args.digit ?? '');
        const recentManagerText = [...session.transcript]
          .reverse()
          .find((turn) => turn.role === 'manager')?.text ?? '';
        const hasExplicitInstruction = /нажмите|наберите|выберите\s+(?:пункт|цифру|клавишу)|клавиш[ауи]|кнопк[ауи]/iu.test(recentManagerText);
        if (/^[0-9*#]$/.test(digit) && hasExplicitInstruction) {
          session.ivrDetected = true;
          session.connectionState = 'waiting_operator';
          sendJson(vox, { customEvent: 'control', action: 'set_output_enabled', enabled: false });
          sendJson(vox, { customEvent: 'control', action: 'send_dtmf', digit });
          sendToolResult(String(message.call_id ?? ''), { ok: true, digit, waiting_for_operator: true }, false);
        } else {
          sendToolResult(String(message.call_id ?? ''), {
            ok: false,
            ignored: true,
            error: /^[0-9*#]$/.test(digit) ? 'no_explicit_ivr_instruction' : 'invalid_digit',
          }, false);
        }
      } else if (name === 'skip_turn') {
        const kind = String(args.kind ?? 'uncertain');
        const recentManagerText = [...session.transcript]
          .reverse()
          .find((turn) => turn.role === 'manager')?.text ?? '';
        const hasHoldInstruction = hasExplicitHoldInstruction(recentManagerText);
        const hasIvrInstruction = /(?:нажмите|наберите|выберите\s+(?:пункт|цифру|клавишу)|голосов(?:ое|ого)\s+меню)/iu.test(recentManagerText);
        const canSilenceLine = hasHoldInstruction || (kind === 'ivr' && hasIvrInstruction);
        if (!canSilenceLine) {
          sendToolResult(String(message.call_id ?? ''), {
            ok: false,
            ignored: true,
            error: session.connectionState === 'live_conversation'
              ? 'live_manager_did_not_ask_to_wait'
              : 'uncertain_audio_is_not_enough_to_mute_line',
          }, false);
          if (recentManagerText && rejectedSkipTurnCount < 1) {
            rejectedSkipTurnCount += 1;
            createResponseNow(managerTurnInstructions(recentManagerText) + ' Это содержательная реплика живого сотрудника, а не ожидание на линии: ответь словами, не вызывай skip_turn.');
          }
          return;
        }
        session.connectionState = 'waiting_operator';
        if (kind === 'ivr') session.ivrDetected = true;
        sendJson(vox, { customEvent: 'control', action: 'set_output_enabled', enabled: false });
        sendToolResult(String(message.call_id ?? ''), { ok: true, listening: true, kind }, false);
      } else if (name === 'end_call') {
        if (unansweredManagerQuestion || responseMustAnswerManagerQuestion) {
          sendToolResult(String(message.call_id ?? ''), {
            ok: false,
            ignored: true,
            error: 'answer_the_manager_question_before_ending',
          }, true);
          return;
        }
        // Tool arguments may arrive before the final text delta. Decide
        // whether a fallback farewell is needed only after response.done.
        endCallRequested = true;
        sendToolResult(String(message.call_id ?? ''), { ok: true, deferred_until_response_finished: true }, false);
      } else {
        sendToolResult(String(message.call_id ?? ''), { ok: false, error: 'unknown tool' }, true);
      }
      return;
    }
    if (eventType === 'response.done') {
      if (message.response?.id && activeResponseId && message.response.id !== activeResponseId) return;
      responseActive = false;
      responseRequestPending = false;
      if (suppressInterruptedOutput) {
        if (queuedResponseAfterPlayback) {
          const instructions = queuedResponseInstructions;
          queuedResponseAfterPlayback = false;
          queuedResponseInstructions = null;
          createResponseNow(instructions ?? undefined);
        }
        return;
      }
      if (session.connectionState === 'waiting_operator') {
        sendJson(vox, { customEvent: 'control', action: 'clear_media' });
        // A defensive hard gate: even if the model produced text instead of
        // skip_turn for IVR/hold audio, discard its TTS and immediately return
        // to listening. Nothing generated for automation may leak when a live
        // employee is connected later.
        assistantText = '';
        assistantTurnRecorded = true;
        awaitingAssistantMediaEnd = false;
        if (ttsTurn) ttsTurn.cancel();
        else releaseInputAfterPlayback();
        return;
      }
      if (guardedResponseText) {
        assistantText = guardedResponseText;
        repairAssistantText(guardedResponseText);
        // A callback is a complete agreed ending; a clarification never is.
        endCallRequested = hasNaturalFarewell(guardedResponseText);
        unansweredManagerQuestion = false;
        responseMustAnswerManagerQuestion = false;
        assistantTurnRecorded = false;
      }
      let spokenFinalText = normalizeAssistantSpeech(sanitizeRealtimeSpokenText(naturalizeAssistantText(assistantText)));
      if (!unansweredManagerQuestion && !responseMustAnswerManagerQuestion
        && (hasNaturalFarewell(spokenFinalText)
          || (hasClosingIntention(assistantText) && !looksLikeManagerQuestion(assistantText)))) {
        endCallRequested = true;
        queuedResponseAfterPlayback = false;
        queuedResponseInstructions = null;
      }
      if (endCallRequested && spokenFinalText && !hasNaturalFarewell(spokenFinalText)) {
        assistantText += ' До свидания.';
        spokenFinalText += ' До свидания.';
        ttsTurn?.append(' До свидания.');
        const recorded = session.transcript.find((turn) => turn.role === 'client' && turn.metrics === currentMetrics);
        if (recorded) recorded.text = hypothesis2SpokenText(spokenFinalText, session.subjectTitle);
      }
      if (!guardedResponseText && spokenFinalText && (containsTechnicalRealtimeSpeech(assistantText)
        || pinSelfIntroduction(assistantText, assistantPreferredName) !== assistantText
        || sanitizeRealtimeSpokenText(assistantText) !== assistantText.trim())) {
        repairAssistantText(spokenFinalText);
      }
      if (guardedResponseText) {
        // Reuse the normal streaming path so timing, buffering and the voice
        // remain identical to other responses.
        guardedResponseText = null;
        const finalText = assistantText;
        assistantText = '';
        handleCometMessage({ type: 'response.output_text.delta', delta: finalText, guardResolved: true });
      }
      const responseWasEmpty = !spokenFinalText.trim() && !responseHadToolCall && !endCallRequested;
      if (responseWasEmpty && (lastCompletedManagerCommitAt || lastSpeechStoppedAt) && silentResponseRetryCount < 1) {
        silentResponseRetryCount += 1;
        responseRequestPending = true;
        sendJson(comet, {
          type: 'response.create',
          response: {
            output_modalities: ['text'],
            instructions: !session.transcript.some((turn) => turn.role === 'client')
              ? openingResponseInstructions()
              : responseInstructions(
                  managerTurnInstructions([...session.transcript].reverse().find((turn) => turn.role === 'manager')?.text ?? '') + ' ' +
                  'Обязательно ответь сейчас короткой устной репликой на последнее сообщение менеджера. ' +
                  'Не оставляй ответ пустым.',
                ),
          },
        });
        return;
      }
      if (responseWasEmpty && silentResponseRetryCount >= 1) {
        session.errors.push(`${providerLabel(session)}: после повторной генерации нет допустимого текста для озвучки.`);
      }
      ttsTurn?.finish();
      recordAssistantTurn(undefined, message.receivedAt ?? isoNow());
      const spokenResponse = sanitizeRealtimeSpokenText(naturalizeAssistantText(assistantText));
      if (responseMustAnswerManagerQuestion && spokenResponse && !hasNaturalFarewell(spokenResponse)) {
        unansweredManagerQuestion = false;
        responseMustAnswerManagerQuestion = false;
      }
      if (endCallRequested) {
        endCallRequested = false;
        const hasFarewell = hasNaturalFarewell(spokenResponse);
        if (hasFarewell) {
          finishAfterPlayback = true;
          if (!assistantSpeaking && !awaitingAssistantMediaEnd && !ttsTurn) {
            sendHangupOnce();
          }
        }
        else queuedServerFarewell = true;
      }
      if (queuedServerFarewell && !assistantSpeaking && !awaitingAssistantMediaEnd) {
        queuedServerFarewell = false;
        playServerFarewell();
      } else if (!assistantSpeaking && !ttsTurn) {
        releaseInputAfterPlayback();
      }
      return;
    }
    if (eventType === 'error') {
      const errorEventId = String(message.error?.event_id ?? '');
      const candidates = [...pendingCancellations.entries()].filter(([, entry]) => entry.responseId === activeResponseId);
      const cancelEventId = errorEventId || (candidates.length === 1 ? candidates[0][0] : '');
      const pending = pendingCancellations.get(cancelEventId);
      if (pending && (message.error?.code === 'response_cancel_not_active'
        || String(message.error?.message ?? '') === 'Cancellation failed: no active response found')) {
        pendingCancellations.delete(cancelEventId);
        pending.metrics.cancelRaceCount = (pending.metrics.cancelRaceCount ?? 0) + 1;
        if (activeResponseId === pending.responseId) responseActive = false;
        return;
      }
      session.errors.push(`${providerLabel(session)}: ${String(message.error?.message ?? message.error ?? 'unknown error')}`);
    }
    if (session.transcript.length > MAX_ITEMS) session.transcript.splice(0, session.transcript.length - MAX_ITEMS);
    if (session.tools.length > MAX_ITEMS) session.tools.splice(0, session.tools.length - MAX_ITEMS);
  };

  const attachCometConnection = (connection: PreparedCometConnection) => {
    preparedComet = connection;
    comet = connection.socket;
    connection.attach(handleCometMessage, () => {
      if (connection !== preparedComet) return;
      providerSessionReady = true;
      session.status = session.connectedAt ? 'ready' : session.status;
      flushProviderAudio();
    });
    connection.onWarmupSettled(() => {
      if (connection !== preparedComet) return;
      if (queuedResponseAfterPlayback && !assistantSpeaking && !responseActive && !responseRequestPending) {
        queuedResponseAfterPlayback = false;
        const instructions = queuedResponseInstructions;
        queuedResponseInstructions = null;
        createResponseNow(instructions ?? undefined);
      }
    });
    connection.onDisconnected(() => {
      if (connection !== preparedComet || providerSessionReady || session.endedAt || providerReconnectCount >= 2) return;
      providerReconnectCount += 1;
      session.errors.push(`${providerLabel(session)}: переподключение до готовности сессии (${providerReconnectCount}/2)`);
      session.providerReadyAt = null;
      session.providerWarmupDoneAt = null;
      const replacement = new PreparedCometConnection(session);
      attachCometConnection(replacement);
    });
  };
  attachCometConnection(preparedComet);

  vox.on('message', (raw) => {
    const message = parseJson(raw);
    if (!message) return;
    if (message.event === 'media' && message.media?.payload) {
      // An accepted terminal action is final: let its farewell finish rather
      // than treating the manager's goodbye as a new interruption/query.
      if (endCallRequested || finishAfterPlayback || hangupSent) return;
      const pcm = Buffer.from(String(message.media.payload), 'base64');
      const hasVoice = pcm16HasSpeech(pcm) || pcm16MeanAbsolute(pcm) >= Math.max(280, localNoiseFloor * 2.8);
      if (!managerHasFloor && (assistantSpeaking || awaitingAssistantMediaEnd || responseActive || responseRequestPending)) {
        if (hasVoice && !bargeStartedAt) {
          bargeStartedAt = isoNow();
          flowEvent('barge_in_candidate', 'speech_over_assistant');
        }
        if (bargeStartedAt) {
          bargeFrames.push(pcm);
          if (hasVoice) {
            bargeLastVoiceAt = isoNow();
            bargeVoicedMs += pcm.length / 32;
            if (bargeTimer) clearTimeout(bargeTimer);
            bargeTimer = setTimeout(submitBargeProbe, 240);
          }
          if (bargeVoicedMs >= 850 && !bargeProbes.length && !committedProbeItems.size) {
            const startedAt = bargeStartedAt;
            const frames = Buffer.concat(bargeFrames);
            const voicedMs = bargeVoicedMs;
            clearBargeCandidate();
            interruptAssistant('sustained_manager_speech', startedAt);
            lastSpeechStartedAt = startedAt;
            lastVoiceActivityAt = isoNow();
            localSpeechVoicedMs = voicedMs;
            sendJson(comet, { type: 'input_audio_buffer.append', audio: resamplePcm16Base64To24Khz(frames.toString('base64')) });
            scheduleLocalEndpoint();
          }
        }
        return;
      }
      const canCaptureManagerAudio = !assistantSpeaking
        && !awaitingAssistantMediaEnd
        && (!responseActive || managerHasFloor)
        && (!responseRequestPending || managerHasFloor)
        && (!localTurnCommitted || awaitingManagerTranscript);
      if (canCaptureManagerAudio) {
        const payload = String(message.media.payload);
        const pcm16 = Buffer.from(payload, 'base64');
        const audio = resamplePcm16Base64To24Khz(payload);
        if (audio) {
          if (providerSessionReady) sendJson(comet, { type: 'input_audio_buffer.append', audio });
          else {
            pendingProviderAudio.push(audio);
            // About 12 seconds at common 20 ms telephony framing. The socket
            // normally becomes ready in ~1.2 s, so this is only a safety cap.
            if (pendingProviderAudio.length > 600) pendingProviderAudio.shift();
          }
        }
        const energy = pcm16MeanAbsolute(pcm16);
        const speechThreshold = Math.max(280, localNoiseFloor * 2.8);
        const hasSpeech = pcm16HasSpeech(pcm16) || energy >= speechThreshold;
        if (hasSpeech) {
          const at = isoNow();
          if (localTurnCommitted && awaitingManagerTranscript) {
            // Speech resumed in the short commit->transcript window. Keep the
            // new audio in the provider's fresh buffer and never start an AI
            // response for the first fragment.
            continuationStartedBeforeTranscript = true;
            localTurnCommitted = false;
            localSpeechVoicedMs = 0;
            lastSpeechStartedAt = null;
            lastVoiceActivityAt = null;
          }
          clearManagerContinuationTimer();
          if (!lastSpeechStartedAt) lastSpeechStartedAt = at;
          lastVoiceActivityAt = at;
          localSpeechVoicedMs += Math.round((pcm16.length / 2 / 16_000) * 1000);
          scheduleLocalEndpoint();
        } else if (!lastSpeechStartedAt) {
          localNoiseFloor = Math.max(50, Math.min(500, localNoiseFloor * 0.95 + energy * 0.05));
        }
      }
      return;
    }
    if (message.customEvent === 'media_status' && message.status === 'ended') {
      if (awaitingAssistantMediaEnd) {
        releaseInputAfterPlayback();
      }
      return;
    }
    if (message.customEvent === 'media_status' && message.status === 'started') {
      if (playbackTurn) playbackTurn.playbackStartedAt = isoNow();
      currentMetrics.speechToVoxPlaybackMs = elapsed(lastCompletedManagerVoiceAt ?? lastVoiceActivityAt ?? lastSpeechStoppedAt, isoNow());
      return;
    }
  });
  vox.on('error', (error) => session.errors.push(`Vox media socket: ${error.message}`));
  vox.on('close', () => {
    if (responseTranscriptTimer) clearTimeout(responseTranscriptTimer);
    pendingResponseEvents.length = 0;
    clearBargeCandidate();
    clearLocalEndpointTimer();
    clearManagerTranscriptWaitTimer();
    clearManagerContinuationTimer();
    awaitingAssistantMediaEnd = true;
    ttsTurn?.cancel();
    dialogueSocket?.close();
    try { preparedSpeechSockets.get(session.callId)?.ws.close(); } catch { /* noop */ }
    preparedSpeechSockets.delete(session.callId);
    preparedComet.close();
  });
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [callId, session] of sessions) {
    if (new Date(session.createdAt).getTime() < cutoff) {
      disposePreparedProviders(callId);
      sessions.delete(callId);
    }
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();
