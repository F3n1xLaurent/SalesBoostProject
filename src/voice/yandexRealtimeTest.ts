import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import WebSocket from 'ws';
import { config } from '../config';
import { normalizeRussianSpeechNumbers } from './speechFacts';
import { startVoiceCall } from './startVoiceCall';
import { elevenLabsWebSocketOptions, fetchElevenLabs } from './elevenLabsHttp';
import {
  appendSpeechAlignment,
  audibleTextAt,
  isCumulativeTranscriptUpdate,
  type SpeechAlignmentPoint,
} from './realtimeBargeIn';
import {
  assessUserTurnCompletion,
  classifyInterruption,
  mergeLogicalTurnText,
  mergeTranscriptionHypothesis,
  openingTurnNeedsIntroGrace,
  sourceLooksLikeQuestion,
  userTurnEndpoint,
} from './realtimeConversationFlow';
import { assessSemanticTurnCompletion } from './realtimeSemanticTurn';
import { detectVehicleEntityMismatch, vehicleMismatchInstruction } from './realtimeEntityConsistency';
import {
  admitBackchannel,
  chooseBackchannelText,
  dialogueDeliveryDirective,
  effectiveAssistantContext,
  HUMAN_CONVERSATION_INSTRUCTIONS,
  inferDialogueDelivery,
  type DialogueDelivery,
} from './realtimeHumanConversation';

type TurnMetrics = {
  speechDurationMs?: number | null;
  speechToTextMs?: number | null;
  endpointWaitMs?: number | null;
  endpointStabilityMs?: number | null;
  llmFirstTextMs?: number | null;
  llmTextGenerationMs?: number | null;
  ttsRequestDelayMs?: number | null;
  ttsSocketWaitMs?: number | null;
  ttsFirstAudioMs?: number | null;
  ttsGenerationMs?: number | null;
  audioDurationMs?: number | null;
  speechToFirstAudioMs?: number | null;
  speechToPlaybackMs?: number | null;
  interrupted?: boolean;
  interruptionPlaybackMs?: number | null;
  heardTextOnInterruption?: string | null;
  contextCorrected?: boolean;
  deliveryStyle?: DialogueDelivery;
};
type TranscriptTurn = {
  role: 'manager' | 'client';
  text: string;
  at: string;
  updatedAt?: string;
  metrics: TurnMetrics;
};
type ToolEvent = { name: string; arguments: Record<string, unknown>; at: string };
type ConversationFlowEvent = {
  type: 'barge_in_candidate' | 'barge_in_confirmed' | 'barge_in_ignored'
    | 'backchannel_scheduled' | 'backchannel_played' | 'backchannel_cancelled'
    | 'endpoint_continuation_detected' | 'endpoint_completion_grace_started'
    | 'endpoint_semantic_assessed' | 'endpoint_turn_committed'
    | 'entity_mismatch_detected' | 'manager_audio_discarded'
    | 'speculative_response_started' | 'speculative_response_cancelled'
    | 'handoff_started' | 'handoff_cutover';
  at: string;
  reason: string;
  speechDurationMs?: number | null;
  latencyMs?: number | null;
};

export type ElevenLabsTtsSettings = {
  modelId: string;
  defaultVoiceId: string | null;
  stability: number;
  similarityBoost: number;
  speed: number;
  optimizeStreamingLatency: number;
  source: 'agent' | 'fallback';
  pronunciationDictionaryLocators: Array<{ pronunciation_dictionary_id: string; version_id: string }>;
};

type RealtimeTestSession = {
  callId: string;
  token: string;
  planId: string;
  planName: string;
  phone: string;
  prompt: string;
  subjectTitle: string | null;
  subjectDescription: string | null;
  elevenLabsVoiceId: string;
  elevenLabsTts: ElevenLabsTtsSettings;
  status: string;
  createdAt: string;
  startedAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  yandexConnectedAt: string | null;
  firstSpeechStoppedAt: string | null;
  firstTextDeltaAt: string | null;
  firstTtsAudioAt: string | null;
  firstTextAfterSpeechAt: string | null;
  firstAudioAfterSpeechAt: string | null;
  transcript: TranscriptTurn[];
  tools: ToolEvent[];
  flowEvents: ConversationFlowEvent[];
  errors: string[];
};

const sessions = new Map<string, RealtimeTestSession>();
const MAX_EVENT_ITEMS = 100;
const FALLBACK_TTS_SETTINGS: ElevenLabsTtsSettings = {
  modelId: 'eleven_flash_v2_5',
  defaultVoiceId: null,
  stability: 0.75,
  similarityBoost: 0.75,
  speed: config.yandexRealtimeTtsSpeed,
  optimizeStreamingLatency: 3,
  source: 'fallback',
  pronunciationDictionaryLocators: [],
};
let agentTtsCache: { expiresAt: number; value: ElevenLabsTtsSettings } | null = null;
const VERBAL_THINKING_FILLERS = ['Хм-м…', 'Так…'];
const LISTENING_BACKCHANNELS = ['Угу.', 'Ага.'];
type BackchannelKind = 'listening' | 'thinking';
const backchannelCache = new Map<string, {
  listeningClips: BackchannelClip[];
  thinkingClips: BackchannelClip[];
  loading: Promise<void> | null;
}>();
type BackchannelClip = { text: string; audio: Buffer };

const LEADING_MODEL_ACKNOWLEDGEMENT = /^(?:понял(?:а)?|понятно|ясно|ага|угу|хм+(?:-м)?|так)(?:[.!?,:;—-]+|\s)+/iu;
const ONLY_MODEL_ACKNOWLEDGEMENT = /^(?:понял(?:а)?|понятно|ясно|ага|угу|хм+(?:-м)?|так)[.!?,:;—-]*$/iu;

export function naturalizeAssistantText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (ONLY_MODEL_ACKNOWLEDGEMENT.test(trimmed)) return '';
  return trimmed.replace(LEADING_MODEL_ACKNOWLEDGEMENT, '').trim();
}

function isoNow(): string {
  return new Date().toISOString();
}

function elapsed(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.max(0, new Date(to).getTime() - new Date(from).getTime());
}

export async function resolveAgentTtsSettings(): Promise<ElevenLabsTtsSettings> {
  if (agentTtsCache && agentTtsCache.expiresAt > Date.now()) return agentTtsCache.value;
  if (!config.elevenLabsApiKey || !config.elevenLabsAgentId) return FALLBACK_TTS_SETTINGS;
  try {
    const response = await fetchElevenLabs(
      `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(config.elevenLabsAgentId)}`,
      { headers: { 'xi-api-key': config.elevenLabsApiKey } },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as any;
    const tts = body?.conversation_config?.tts;
    if (!tts?.model_id) throw new Error('TTS config is missing');
    const value: ElevenLabsTtsSettings = {
      modelId: String(tts.model_id),
      defaultVoiceId: String(tts.voice_id ?? '').trim() || null,
      stability: Number.isFinite(Number(tts.stability)) ? Number(tts.stability) : 0.75,
      similarityBoost: Number.isFinite(Number(tts.similarity_boost)) ? Number(tts.similarity_boost) : 0.75,
      speed: config.yandexRealtimeTtsSpeed,
      optimizeStreamingLatency: Number.isFinite(Number(tts.optimize_streaming_latency))
        ? Number(tts.optimize_streaming_latency)
        : 3,
      source: 'agent',
      pronunciationDictionaryLocators: Array.isArray(tts.pronunciation_dictionary_locators)
        ? tts.pronunciation_dictionary_locators.flatMap((locator: any) => {
            const pronunciationDictionaryId = String(locator?.pronunciation_dictionary_id ?? '').trim();
            const versionId = String(locator?.version_id ?? '').trim();
            return pronunciationDictionaryId && versionId
              ? [{ pronunciation_dictionary_id: pronunciationDictionaryId, version_id: versionId }]
              : [];
          })
        : [],
    };
    agentTtsCache = { expiresAt: Date.now() + 5 * 60_000, value };
    return value;
  } catch (error) {
    console.warn('[yandex-realtime-test] failed to load ElevenLabs Agent TTS settings:', error);
    return FALLBACK_TTS_SETTINGS;
  }
}

function backchannelCacheKey(session: RealtimeTestSession): string {
  const tts = session.elevenLabsTts;
  const fillers = thinkingFillerTexts(session);
  return JSON.stringify([
    3,
    session.elevenLabsVoiceId,
    tts.modelId,
    tts.stability,
    tts.similarityBoost,
    tts.speed,
    'ru',
    'ulaw_8000',
    LISTENING_BACKCHANNELS,
    fillers,
  ]);
}

function thinkingFillerTexts(session: RealtimeTestSession): string[] {
  // Eleven v3/v4 understand non-verbal audio tags. Older models may literally
  // pronounce the English tag, so keep them on safe Russian verbal fillers.
  return /^(?:eleven_v3|eleven_v4)/.test(session.elevenLabsTts.modelId)
    ? [...VERBAL_THINKING_FILLERS, '[clears throat]']
    : VERBAL_THINKING_FILLERS;
}

async function synthesizeBackchannel(session: RealtimeTestSession, text: string): Promise<Buffer> {
  const tts = session.elevenLabsTts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(config.elevenLabsTtsTimeoutMs, 20_000));
  try {
    const latencyQuery = /^eleven_v4/.test(tts.modelId)
      ? ''
      : `&optimize_streaming_latency=${tts.optimizeStreamingLatency}`;
    const response = await fetchElevenLabs(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(session.elevenLabsVoiceId)}`
        + `?output_format=ulaw_8000${latencyQuery}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': config.elevenLabsApiKey!,
          'Content-Type': 'application/json',
          Accept: 'audio/basic, application/octet-stream',
        },
        body: JSON.stringify({
          text,
          model_id: tts.modelId,
          language_code: 'ru',
          voice_settings: {
            stability: tts.stability,
            similarity_boost: tts.similarityBoost,
            speed: tts.speed,
          },
          ...(tts.pronunciationDictionaryLocators.length
            ? { pronunciation_dictionary_locators: tts.pronunciationDictionaryLocators }
            : {}),
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw new Error('empty audio');
    return audio;
  } finally {
    clearTimeout(timeout);
  }
}

function warmBackchannelCache(session: RealtimeTestSession): void {
  if (!config.yandexRealtimeBackchannelEnabled || !config.elevenLabsApiKey) return;
  const key = backchannelCacheKey(session);
  const existing = backchannelCache.get(key);
  if (existing?.loading || existing?.listeningClips.length || existing?.thinkingClips.length) return;
  // A provider or billing failure must not poison the cache forever. The next
  // test call should retry after credentials, routing or balance are fixed.
  if (existing) backchannelCache.delete(key);
  const entry = {
    listeningClips: [] as BackchannelClip[],
    thinkingClips: [] as BackchannelClip[],
    loading: null as Promise<void> | null,
  };
  entry.loading = Promise.all([
    Promise.allSettled(LISTENING_BACKCHANNELS.map((text) => synthesizeBackchannel(session, text))),
    Promise.allSettled(thinkingFillerTexts(session).map((text) => synthesizeBackchannel(session, text))),
  ])
    .then(([listeningResults, thinkingResults]) => {
      entry.listeningClips = listeningResults.flatMap((result, index) => result.status === 'fulfilled'
        ? [{ text: LISTENING_BACKCHANNELS[index], audio: result.value }]
        : []);
      const thinkingTexts = thinkingFillerTexts(session);
      entry.thinkingClips = thinkingResults.flatMap((result, index) => result.status === 'fulfilled'
        ? [{ text: thinkingTexts[index], audio: result.value }]
        : []);
      const failures = listeningResults.length + thinkingResults.length
        - entry.listeningClips.length - entry.thinkingClips.length;
      if (failures) console.warn(`[yandex-realtime-test] backchannel cache prepared with ${failures} failed variants`);
    })
    .catch((error) => {
      console.warn('[yandex-realtime-test] failed to prepare backchannel cache:', error);
    })
    .finally(() => {
      entry.loading = null;
      if (!entry.listeningClips.length && !entry.thinkingClips.length) backchannelCache.delete(key);
    });
  backchannelCache.set(key, entry);
}

function readyBackchannelClips(session: RealtimeTestSession, kind: BackchannelKind): BackchannelClip[] {
  const entry = backchannelCache.get(backchannelCacheKey(session));
  return kind === 'listening' ? entry?.listeningClips ?? [] : entry?.thinkingClips ?? [];
}

function publicSession(session: RealtimeTestSession) {
  return {
    callId: session.callId,
    planId: session.planId,
    planName: session.planName,
    phone: session.phone,
    status: session.status,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    connectedAt: session.connectedAt,
    endedAt: session.endedAt,
    yandexConnectedAt: session.yandexConnectedAt,
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
    conversationFlow: {
      bargeInEnabled: config.yandexRealtimeBargeInEnabled,
      smartBargeInEnabled: config.yandexRealtimeSmartBargeInEnabled,
      backchannelEnabled: config.yandexRealtimeBackchannelEnabled,
      listeningBackchannelEnabled: config.yandexRealtimeListeningBackchannelEnabled,
      bargeInSustainedMs: config.yandexRealtimeBargeInSustainedMs,
      endpointSilenceMs: config.yandexRealtimeEndpointSilenceMs,
      incompleteTurnEnabled: config.yandexRealtimeIncompleteTurnEnabled,
      turnGraceMs: config.yandexRealtimeTurnGraceMs,
      incompleteTurnGraceMs: config.yandexRealtimeIncompleteTurnGraceMs,
      semanticTurnEnabled: config.yandexRealtimeSemanticTurnEnabled,
      semanticTurnTimeoutMs: config.yandexRealtimeSemanticTurnTimeoutMs,
      backchannelMinSpeechMs: config.yandexRealtimeBackchannelMinSpeechMs,
      backchannelCooldownMs: config.yandexRealtimeBackchannelCooldownMs,
      backchannelMaxPerTurn: Math.min(1, config.yandexRealtimeBackchannelMaxPerTurn),
      seamlessHandoffEnabled: config.yandexRealtimeSeamlessHandoffEnabled,
      handoffPauseMs: config.yandexRealtimeHandoffPauseMs,
      events: session.flowEvents,
    },
    errors: session.errors,
    metrics: {
      answerMs: elapsed(session.startedAt, session.connectedAt),
      yandexConnectMs: elapsed(session.connectedAt ?? session.startedAt, session.yandexConnectedAt),
      speechToFirstTextMs: elapsed(session.firstSpeechStoppedAt, session.firstTextAfterSpeechAt),
      speechToFirstAudioMs: elapsed(session.firstSpeechStoppedAt, session.firstAudioAfterSpeechAt),
      textToFirstAudioMs: elapsed(
        session.firstTextAfterSpeechAt ?? session.firstTextDeltaAt,
        session.firstAudioAfterSpeechAt ?? session.firstTtsAudioAt,
      ),
    },
  };
}

function normalizePhone(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

export async function handleStartYandexRealtimeTest(req: Request, res: Response): Promise<void> {
  const planId = String(req.body?.planId ?? '').trim();
  const phone = normalizePhone(req.body?.to);
  if (!planId) {
    res.status(400).json({ error: 'Выберите план прозвона.' });
    return;
  }
  if (phone.length < 11) {
    res.status(400).json({ error: 'Укажите корректный номер телефона.' });
    return;
  }
  if (!config.yandexCloudFolderId || !config.yandexCloudApiKey) {
    res.status(400).json({ error: 'YANDEX_CLOUD_FOLDER_ID и YANDEX_CLOUD_API_KEY должны быть заданы.' });
    return;
  }
  try {
    const { resolveRealtimeTestPlanConfiguration } = await import('./callSettingsManagement');
    const plan = await resolveRealtimeTestPlanConfiguration(req, planId);
    const elevenLabsTts = await resolveAgentTtsSettings();
    // The original ElevenLabs Agent also applies the plan/profile voice as an
    // override; its remaining synthesis settings come from the Agent config.
    const voiceId = plan.elevenLabsVoiceId || elevenLabsTts.defaultVoiceId || config.elevenLabsVoiceId;
    if (!voiceId || !config.elevenLabsApiKey) {
      res.status(400).json({ error: 'Для выбранного профиля или в ELEVENLABS_VOICE_ID не задан голос ElevenLabs.' });
      return;
    }
    const callId = randomUUID();
    const token = randomUUID();
    const createdAt = isoNow();
    const session: RealtimeTestSession = {
      callId,
      token,
      planId: plan.planId,
      planName: plan.planName,
      phone,
      prompt: plan.prompt,
      subjectTitle: plan.subjectTitle,
      subjectDescription: plan.subjectDescription,
      elevenLabsVoiceId: voiceId,
      elevenLabsTts,
      status: 'starting',
      createdAt,
      startedAt: null,
      connectedAt: null,
      endedAt: null,
      yandexConnectedAt: null,
      firstSpeechStoppedAt: null,
      firstTextDeltaAt: null,
      firstTtsAudioAt: null,
      firstTextAfterSpeechAt: null,
      firstAudioAfterSpeechAt: null,
      transcript: [],
      tools: [],
      flowEvents: [],
      errors: [],
    };
    sessions.set(callId, session);
    warmBackchannelCache(session);
    const result = await startVoiceCall(phone, {
      scenario: 'yandex_realtime_test',
      callId,
      streamToken: token,
    });
    if ('error' in result) {
      sessions.delete(callId);
      res.status(400).json({ error: result.error });
      return;
    }
    session.status = 'dialing';
    session.startedAt = result.startedAt;
    res.json(publicSession(session));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось запустить тестовый звонок.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export function handleGetYandexRealtimeTest(req: Request, res: Response): void {
  const session = sessions.get(String(req.params.callId ?? ''));
  if (!session) {
    res.status(404).json({ error: 'Тестовый звонок не найден или сервер был перезапущен.' });
    return;
  }
  res.json(publicSession(session));
}

export function handleYandexRealtimeTestWebhook(req: Request, res: Response): void {
  res.status(200).end();
  const callId = String(req.body?.call_id ?? '').trim();
  const session = sessions.get(callId);
  if (!session) return;
  const event = String(req.body?.event ?? '').trim();
  if (event === 'connected') {
    session.status = 'connected';
    session.connectedAt = String(req.body?.ts ?? isoNow());
  } else if (['disconnected', 'failed', 'busy', 'no_answer', 'cancelled'].includes(event)) {
    session.status = event;
    session.endedAt = String(req.body?.ts ?? isoNow());
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

export function pcm16HasSpeech(audio: Buffer): boolean {
  if (audio.length < 2) return false;
  let total = 0;
  let samples = 0;
  // Sampling every fourth PCM16 value is sufficient for a lightweight gate
  // and avoids doing a full DSP pass on every 20 ms telephony packet.
  for (let offset = 0; offset + 1 < audio.length; offset += 8) {
    total += Math.abs(audio.readInt16LE(offset));
    samples += 1;
  }
  return samples > 0 && total / samples >= 600;
}

function formatElevenLabsError(message: any): string {
  const error = typeof message?.error === 'string'
    ? message.error
    : message?.error?.message;
  const detail = typeof message?.detail === 'string'
    ? message.detail
    : message?.detail?.message;
  const description = typeof message?.message === 'string' ? message.message : detail;
  const primary = [error, description].filter(Boolean).join(': ') || 'unknown error';
  const metadata = [
    message?.param ? `param: ${String(message.param)}` : '',
    message?.code ? `code: ${String(message.code)}` : '',
  ].filter(Boolean);
  return metadata.length ? `${primary} (${metadata.join(', ')})` : primary;
}

/**
 * One warm Eleven v3 multi-context connection per phone call. Each answer gets
 * its own context, so a barge-in can close only that context while the socket
 * stays warm for the next answer.
 */
class ElevenLabsDialogueSocket {
  private static readonly WARM_CONTEXT_ID = 'warm';
  private ws: WebSocket | null = null;
  private opened = false;
  private closed = false;
  private turns = new Map<string, ElevenLabsTurn>();
  private contextIds = new WeakMap<ElevenLabsTurn, string>();
  private initializedContexts = new Set<string>();
  private closingContexts = new Set<string>();
  private finalizedContexts = new Set<string>();
  private turnFrames = new Map<ElevenLabsTurn, unknown[]>();
  private reconnectAttempts = new WeakMap<ElevenLabsTurn, number>();
  private pending: Array<{ turn: ElevenLabsTurn; value: unknown }> = [];
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly session: RealtimeTestSession) {}

  connect(): void {
    if (this.closed || this.ws) return;
    const tts = this.session.elevenLabsTts;
    const url = `wss://api.elevenlabs.io/v1/text-to-dialogue/multi-stream-input?model_id=${encodeURIComponent(tts.modelId)}&output_format=ulaw_8000&language_code=ru&sync_alignment=true&apply_text_normalization=on`;
    const ws = new WebSocket(url, {
      ...elevenLabsWebSocketOptions(),
      headers: { 'xi-api-key': config.elevenLabsApiKey },
    });
    this.ws = ws;
    ws.on('open', () => {
      if (this.closed || this.ws !== ws) return ws.close();
      this.opened = true;
      sendJson(ws, {
        context_id: ElevenLabsDialogueSocket.WARM_CONTEXT_ID,
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
      this.initializedContexts.add(ElevenLabsDialogueSocket.WARM_CONTEXT_ID);
      this.flushPending();
      this.keepAliveTimer = setInterval(() => {
        sendJson(ws, { context_id: ElevenLabsDialogueSocket.WARM_CONTEXT_ID, keep_alive: true });
      }, 10_000);
      this.keepAliveTimer.unref();
    });
    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      const message = parseJson(raw);
      if (!message) return;
      const contextId = String(message.context_id ?? '');
      const turn = this.turns.get(contextId);
      if (message.audio) {
        turn?.receiveDialogueAudio(
          String(message.audio),
          message.normalized_alignment ?? message.alignment,
        );
      }
      if (message.is_final_audio_for_turn) {
        if (turn) {
          turn.completeDialogueTurn();
          if (contextId && contextId !== ElevenLabsDialogueSocket.WARM_CONTEXT_ID) {
            this.closeContext(ws, contextId);
          }
        }
      }
      if (message.is_final && contextId) {
        if (turn) this.turnFrames.delete(turn);
        this.turns.delete(contextId);
        this.initializedContexts.delete(contextId);
        this.closingContexts.delete(contextId);
        this.finalizedContexts.add(contextId);
      }
      if (message.error || message.detail) {
        this.session.errors.push(`ElevenLabs: ${formatElevenLabsError(message)}`);
        try { ws.close(); } catch { /* noop */ }
      }
    });
    ws.on('error', (error) => {
      if (this.ws === ws) this.session.errors.push(`ElevenLabs: ${error.message}`);
    });
    ws.on('unexpected-response', (_request, response) => {
      const location = response.headers.location ? ` → ${response.headers.location}` : '';
      if (this.ws === ws) this.session.errors.push(`ElevenLabs WebSocket HTTP ${response.statusCode}${location}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.clearKeepAlive();
      this.ws = null;
      this.opened = false;
      this.initializedContexts.clear();
      this.requeueInterruptedTurns();
      this.closingContexts.clear();
      this.finalizedContexts.clear();
      if (!this.closed && (this.pending.length > 0 || this.turns.size > 0)) this.connect();
    });
  }

  sendText(turn: ElevenLabsTurn, text: string, newTurn: boolean): void {
    const contextId = this.contextFor(turn);
    this.ensureContext(turn, contextId);
    const spoken = normalizeRussianSpeechNumbers(text);
    const directed = newTurn
      ? `${dialogueDeliveryDirective(text)} ${spoken}`
      : spoken;
    this.sendForTurn(turn, {
      context_id: contextId,
      inputs: [{ text: directed, voice_id: this.session.elevenLabsVoiceId, new_turn: newTurn }],
    });
  }

  finish(turn: ElevenLabsTurn): void {
    const contextId = this.contextFor(turn);
    this.ensureContext(turn, contextId);
    this.sendForTurn(turn, { context_id: contextId, flush: true });
  }

  cancel(turn: ElevenLabsTurn): void {
    this.pending = this.pending.filter((item) => item.turn !== turn);
    this.turnFrames.delete(turn);
    const contextId = this.contextIds.get(turn);
    if (!contextId) return;
    this.turns.delete(contextId);
    if (this.finalizedContexts.has(contextId)) return;
    if (this.opened && this.ws?.readyState === WebSocket.OPEN) {
      this.closeContext(this.ws, contextId);
    }
  }

  close(): void {
    this.closed = true;
    this.pending = [];
    this.turns.clear();
    this.turnFrames.clear();
    this.initializedContexts.clear();
    this.closingContexts.clear();
    this.finalizedContexts.clear();
    this.clearKeepAlive();
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }

  private sendForTurn(turn: ElevenLabsTurn, value: unknown): void {
    const frames = this.turnFrames.get(turn) ?? [];
    frames.push(value);
    this.turnFrames.set(turn, frames);
    this.connect();
    if (this.opened && this.ws?.readyState === WebSocket.OPEN) sendJson(this.ws, value);
    else this.pending.push({ turn, value });
  }

  private flushPending(): void {
    if (!this.opened || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const queued = this.pending;
    this.pending = [];
    for (const item of queued) {
      const contextId = this.contextIds.get(item.turn);
      if (contextId && this.turns.get(contextId) === item.turn) sendJson(this.ws, item.value);
    }
  }

  private contextFor(turn: ElevenLabsTurn): string {
    const existing = this.contextIds.get(turn);
    if (existing) return existing;
    const contextId = `turn-${randomUUID()}`;
    this.contextIds.set(turn, contextId);
    this.turns.set(contextId, turn);
    return contextId;
  }

  private ensureContext(turn: ElevenLabsTurn, contextId: string): void {
    if (this.initializedContexts.has(contextId)) return;
    this.initializedContexts.add(contextId);
    const tts = this.session.elevenLabsTts;
    this.sendForTurn(turn, {
      context_id: contextId,
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
  }

  private closeContext(ws: WebSocket, contextId: string): void {
    if (this.closingContexts.has(contextId) || this.finalizedContexts.has(contextId)) return;
    this.closingContexts.add(contextId);
    sendJson(ws, { context_id: contextId, close_context: true });
  }

  private requeueInterruptedTurns(): void {
    this.pending = [];
    for (const [contextId, turn] of this.turns) {
      if (this.closingContexts.has(contextId)) {
        this.turnFrames.delete(turn);
        this.turns.delete(contextId);
        continue;
      }
      const attempts = this.reconnectAttempts.get(turn) ?? 0;
      if (turn.hasReceivedDialogueAudio() || attempts >= 1) {
        turn.completeDialogueTurn();
        this.turnFrames.delete(turn);
        this.turns.delete(contextId);
        continue;
      }
      this.reconnectAttempts.set(turn, attempts + 1);
      for (const value of this.turnFrames.get(turn) ?? []) {
        this.pending.push({ turn, value });
      }
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }
}

/**
 * Eleven v4 Text-to-Dialogue supports sequential turns on one warm socket.
 * Keeping it open avoids paying DNS/TCP/TLS/WebSocket setup for every answer.
 * Unlike the v3 multi-context transport, v4 turbo has one active voice/turn,
 * which matches this strict half-duplex phone experiment.
 */
class ElevenLabsV4DialogueSocket {
  private ws: WebSocket | null = null;
  private opened = false;
  private closed = false;
  private activeTurn: ElevenLabsTurn | null = null;
  private activeFrames: unknown[] = [];
  private pending: unknown[] = [];
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private connectStartedAt: string | null = null;

  constructor(private readonly session: RealtimeTestSession) {}

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
      if (message.audio) {
        turn?.receiveDialogueAudio(
          String(message.audio),
          message.normalized_alignment ?? message.alignment,
        );
      }
      if (message.is_final_audio_for_turn || message.is_final) {
        turn?.completeDialogueTurn();
        this.activeTurn = null;
        this.activeFrames = [];
      }
      if (message.error || message.detail) {
        this.session.errors.push(`ElevenLabs: ${formatElevenLabsError(message)}`);
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
      const location = response.headers.location ? ` → ${response.headers.location}` : '';
      if (this.ws === ws) this.session.errors.push(`ElevenLabs WebSocket HTTP ${response.statusCode}${location}`);
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

  sendText(turn: ElevenLabsTurn, text: string, newTurn: boolean): void {
    const spoken = normalizeRussianSpeechNumbers(text).trim();
    if (!spoken) return;
    if (this.activeTurn && this.activeTurn !== turn) {
      this.session.errors.push('ElevenLabs: attempted overlapping v4 dialogue turns');
      return;
    }
    this.activeTurn = turn;
    const directed = newTurn ? `${dialogueDeliveryDirective(text)} ${spoken}`.trim() : spoken;
    this.sendForTurn(turn, {
      inputs: [{ text: directed, voice_id: this.session.elevenLabsVoiceId, new_turn: newTurn }],
    });
  }

  finish(turn: ElevenLabsTurn): void {
    if (this.activeTurn !== turn) return;
    this.sendForTurn(turn, { flush: true });
  }

  cancel(turn: ElevenLabsTurn): void {
    if (this.activeTurn !== turn) return;
    this.activeTurn = null;
    this.activeFrames = [];
    this.pending = [];
    // The single-stream protocol has no per-turn cancellation. Reconnect so
    // audio from a discarded speculative answer can never leak into the next.
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
    this.opened = false;
  }

  private sendForTurn(turn: ElevenLabsTurn, value: unknown): void {
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

type ElevenLabsTurnSocket = ElevenLabsDialogueSocket | ElevenLabsV4DialogueSocket;

class VoxBackchannelPlayback {
  private offset = 0;
  private sequence = 0;
  private chunk = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private started = false;

  constructor(
    private readonly vox: WebSocket,
    private readonly audio: Buffer,
    private readonly onStarted: () => void,
    private readonly onStopped: (cancelled: boolean) => void,
  ) {}

  start(): void {
    if (this.stopped || !this.audio.length) return;
    this.started = true;
    sendJson(this.vox, {
      event: 'start',
      sequenceNumber: this.sequence++,
      start: { tag: 'assistant', mediaFormat: { encoding: 'ULAW' } },
    });
    this.onStarted();
    this.pump();
  }

  cancel(): boolean {
    if (this.stopped) return false;
    this.finish(true);
    return true;
  }

  private pump(): void {
    if (this.stopped) return;
    if (this.offset >= this.audio.length) {
      this.finish(false);
      return;
    }
    const packet = this.audio.subarray(this.offset, Math.min(this.offset + 320, this.audio.length));
    sendJson(this.vox, {
      event: 'media',
      sequenceNumber: this.sequence++,
      media: { tag: 'assistant', chunk: this.chunk++, timestamp: this.offset, payload: packet.toString('base64') },
    });
    this.offset += packet.length;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(20, Math.round(packet.length / 8)));
  }

  private finish(cancelled: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.started) {
      sendJson(this.vox, {
        event: 'stop',
        sequenceNumber: this.sequence++,
        stop: { tag: 'assistant', mediaInfo: {} },
      });
    }
    this.onStopped(cancelled);
  }
}

class ElevenLabsTurn {
  private static readonly FIRST_CHUNK_LOOKAHEAD = 40;
  private static readonly FIRST_CHUNK_MINIMUM = 28;
  private static readonly NEXT_CHUNK_LOOKAHEAD = 64;
  private static readonly NEXT_CHUNK_MINIMUM = 40;

  private ws: WebSocket | null = null;
  private pending: string[] = [];
  private textBuffer = '';
  private opened = false;
  private mediaStarted = false;
  private stopped = false;
  private sequence = 0;
  private chunk = 0;
  private timestamp = 0;
  private audioBytes = 0;
  private finishRequested = false;
  private finishSent = false;
  private textSent = false;
  private openingTextHandled = false;
  private pendingOpeningAcknowledgement = false;
  private ttsRequestedAt: string | null = null;
  private audioQueue: Buffer[] = [];
  private audioTimer: NodeJS.Timeout | null = null;
  private playbackStartTimer: NodeJS.Timeout | null = null;
  private playbackStarting = false;
  private playbackNotBeforeMs = 0;
  private firstAudioReceivedAt: string | null = null;
  private generationFinished = false;
  private sourceText = '';
  private alignment: SpeechAlignmentPoint[] = [];
  private readonly singleDialogueProtocol: boolean;

  constructor(
    private readonly session: RealtimeTestSession,
    private readonly vox: WebSocket,
    private readonly metrics: TurnMetrics,
    private readonly firstTextAt: string,
    private readonly speechStoppedAt: string | null,
    private readonly dialogueSocket: ElevenLabsTurnSocket | null,
    private readonly beforePlayback: (() => number) | null,
    private readonly onPlaybackStarted: (() => void) | null,
    private readonly onStopped: () => void,
  ) {
    this.singleDialogueProtocol = !dialogueSocket && /^eleven_v4/.test(session.elevenLabsTts.modelId);
  }

  append(delta: string): void {
    if (this.stopped || !delta) return;
    this.textBuffer += delta;
    if (/[,;:—.!?…]\s*$/.test(this.textBuffer)) {
      this.flushText();
      return;
    }
    // Open the provider socket as soon as a safe first phrase is available;
    // Yandex can keep generating the rest of the answer in parallel. Later
    // chunks stay larger to preserve Russian lexical context and prosody.
    // Never split in the middle of a word: that is a frequent source of
    // incorrect stress in names and vehicle models.
    const firstChunk = !this.textSent && this.pending.length === 0;
    const lookahead = firstChunk
      ? ElevenLabsTurn.FIRST_CHUNK_LOOKAHEAD
      : ElevenLabsTurn.NEXT_CHUNK_LOOKAHEAD;
    const minimum = firstChunk
      ? ElevenLabsTurn.FIRST_CHUNK_MINIMUM
      : ElevenLabsTurn.NEXT_CHUNK_MINIMUM;
    if (this.textBuffer.length >= lookahead) {
      const boundary = this.textBuffer.lastIndexOf(' ', lookahead);
      if (boundary >= minimum) this.flushText(boundary);
    }
  }

  finish(): void {
    if (this.stopped) return;
    this.flushText();
    if (this.pendingOpeningAcknowledgement && !this.textSent && this.pending.length === 0) {
      // Telephony owns short acknowledgements. If the model generated only a
      // filler, do not turn it into another audible "угу" at TTS level.
      this.pendingOpeningAcknowledgement = false;
      this.openingTextHandled = true;
    }
    if (!this.textSent && this.pending.length === 0) {
      this.stopped = true;
      this.onStopped();
      return;
    }
    this.ensureSocket();
    this.finishRequested = true;
    this.flushPending();
  }

  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.textBuffer = '';
    this.pending = [];
    this.audioQueue = [];
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.audioTimer = null;
    if (this.playbackStartTimer) clearTimeout(this.playbackStartTimer);
    this.playbackStartTimer = null;
    this.playbackStarting = false;
    if (this.mediaStarted) {
      sendJson(this.vox, {
        event: 'stop',
        sequenceNumber: this.sequence++,
        stop: { tag: 'assistant', mediaInfo: {} },
      });
    }
    if (this.dialogueSocket) this.dialogueSocket.cancel(this);
    else {
      try { this.ws?.close(); } catch { /* noop */ }
    }
    this.onStopped();
  }

  /** Stop provider generation but let already buffered audio bridge the LLM/TTS handoff. */
  stopGenerationAndDrain(): void {
    if (this.stopped) return;
    this.textBuffer = '';
    this.pending = [];
    this.finishRequested = true;
    this.finishSent = true;
    this.generationFinished = true;
    if (this.dialogueSocket) this.dialogueSocket.cancel(this);
    else {
      try { this.ws?.close(); } catch { /* noop */ }
    }
    this.pumpAudio();
  }

  setSourceText(text: string): void {
    if (text.trim()) this.sourceText = text.trim();
  }

  setPlaybackNotBefore(epochMs: number): void {
    if (!Number.isFinite(epochMs) || epochMs < 0 || epochMs === this.playbackNotBeforeMs) return;
    this.playbackNotBeforeMs = epochMs;
    if (this.playbackStartTimer) {
      clearTimeout(this.playbackStartTimer);
      this.playbackStartTimer = null;
      this.playbackStarting = false;
      this.startPlaybackWhenReady();
    }
  }

  isPlaying(): boolean {
    return this.mediaStarted && !this.stopped;
  }

  playedAudioMs(): number {
    return Math.round(this.timestamp / 8);
  }

  audibleText(playbackMs: number): string {
    return audibleTextAt(this.alignment, playbackMs, this.sourceText, Math.round(this.audioBytes / 8));
  }

  receiveDialogueAudio(payload: string, alignment?: unknown): void {
    if (this.stopped) return;
    appendSpeechAlignment(this.alignment, alignment, Math.round(this.audioBytes / 8));
    this.queueAudio(payload);
  }

  hasReceivedDialogueAudio(): boolean {
    return this.audioBytes > 0;
  }

  markDialogueSocketReady(connectStartedAt: string | null, openedAt: string): void {
    if (this.metrics.ttsSocketWaitMs != null) return;
    this.metrics.ttsSocketWaitMs = elapsed(connectStartedAt, openedAt) ?? 0;
  }

  completeDialogueTurn(): void {
    this.finishGeneration();
  }

  private flushText(boundary = this.textBuffer.length): void {
    let text = this.textBuffer.slice(0, boundary).trim();
    this.textBuffer = this.textBuffer.slice(boundary).trimStart();
    if (!text) return;
    if (!this.openingTextHandled) {
      if (ONLY_MODEL_ACKNOWLEDGEMENT.test(text)) {
        // Hold a leading filler for one more sentence. If meaningful text
        // follows, omit the filler; if the whole reply is only the filler,
        // finish() replaces it with a pre-agreed natural backchannel.
        this.pendingOpeningAcknowledgement = true;
        return;
      }
      text = naturalizeAssistantText(text);
      if (!text) {
        this.openingTextHandled = true;
        this.pendingOpeningAcknowledgement = false;
        return;
      }
      this.metrics.deliveryStyle = inferDialogueDelivery(text);
      this.openingTextHandled = true;
      this.pendingOpeningAcknowledgement = false;
    }
    this.ensureSocket();
    this.pending.push(`${text} `);
    this.flushPending();
  }

  private ensureSocket(): void {
    if (this.ws || this.stopped) return;
    if (this.dialogueSocket) {
      this.opened = true;
      this.dialogueSocket.connect();
      return;
    }
    // Voximplant's PSTN leg is natively 8 kHz. Asking ElevenLabs for mu-law
    // avoids PCM16 byte-order ambiguity and an unnecessary telephony transcode.
    const tts = this.session.elevenLabsTts;
    const url = this.singleDialogueProtocol
      ? `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=${encodeURIComponent(tts.modelId)}&output_format=ulaw_8000&language_code=ru&sync_alignment=true&apply_text_normalization=on`
      : `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.session.elevenLabsVoiceId)}/stream-input?model_id=${encodeURIComponent(tts.modelId)}&output_format=ulaw_8000&language_code=ru&optimize_streaming_latency=${tts.optimizeStreamingLatency}&inactivity_timeout=60`;
    const ws = new WebSocket(url, {
      ...elevenLabsWebSocketOptions(),
      headers: { 'xi-api-key': config.elevenLabsApiKey },
    });
    this.ws = ws;
    ws.on('open', () => {
      if (this.stopped) return ws.close();
      this.opened = true;
      const voiceSettings = {
        stability: tts.stability,
        similarity_boost: tts.similarityBoost,
        speed: tts.speed,
      };
      if (this.singleDialogueProtocol) {
        sendJson(ws, {
          voices: [this.session.elevenLabsVoiceId],
          voice_settings: voiceSettings,
          ...(tts.pronunciationDictionaryLocators.length
            ? { pronunciation_dictionary_locators: tts.pronunciationDictionaryLocators }
            : {}),
        });
      } else {
        sendJson(ws, { text: ' ', xi_api_key: config.elevenLabsApiKey, voice_settings: voiceSettings });
      }
      this.flushPending();
    });
    ws.on('message', (raw) => {
      const message = parseJson(raw);
      if (!message || this.stopped) return;
      if (message.error || message.detail) {
        this.session.errors.push(`ElevenLabs: ${formatElevenLabsError(message)}`);
        this.finishGeneration();
        try { ws.close(); } catch { /* noop */ }
        return;
      }
      if (message.audio) {
        if (this.singleDialogueProtocol) {
          appendSpeechAlignment(this.alignment, message.normalized_alignment ?? message.alignment, Math.round(this.audioBytes / 8));
        }
        this.queueAudio(String(message.audio));
      }
      if (message.is_final_audio_for_turn) {
        this.finishGeneration();
        if (this.singleDialogueProtocol) sendJson(ws, { close_socket: true });
      } else if (message.isFinal || message.is_final) this.finishGeneration();
    });
    ws.on('error', (error) => {
      this.session.errors.push(`ElevenLabs: ${error.message}`);
    });
    ws.on('unexpected-response', (_request, response) => {
      const location = response.headers.location ? ` → ${response.headers.location}` : '';
      this.session.errors.push(`ElevenLabs WebSocket HTTP ${response.statusCode}${location}`);
    });
    ws.on('close', () => this.finishGeneration());
  }

  private flushPending(): void {
    if (!this.opened) return;
    if (!this.dialogueSocket && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) return;
    while (this.pending.length > 0) {
      const text = this.pending.shift();
      if (!text) continue;
      if (!this.ttsRequestedAt) {
        this.ttsRequestedAt = isoNow();
        this.metrics.ttsRequestDelayMs = elapsed(this.firstTextAt, this.ttsRequestedAt);
      }
      if (this.dialogueSocket) this.dialogueSocket.sendText(this, text, !this.textSent);
      else if (this.ws && this.singleDialogueProtocol) {
        const spoken = normalizeRussianSpeechNumbers(text);
        sendJson(this.ws, {
          inputs: [{
            text: !this.textSent
              ? `${dialogueDeliveryDirective(text)} ${spoken}`
              : spoken,
            voice_id: this.session.elevenLabsVoiceId,
            new_turn: !this.textSent,
          }],
        });
      } else if (this.ws) sendJson(this.ws, { text: normalizeRussianSpeechNumbers(text) });
      this.textSent = true;
    }
    if (this.finishRequested && !this.finishSent) {
      this.finishSent = true;
      if (this.dialogueSocket) this.dialogueSocket.finish(this);
      else if (this.ws && this.singleDialogueProtocol) sendJson(this.ws, { flush: true });
      else if (this.ws) sendJson(this.ws, { text: '' });
    }
  }

  private queueAudio(payload: string): void {
    const audio = Buffer.from(payload, 'base64');
    if (!audio.length) return;
    if (!this.firstAudioReceivedAt) {
      const audioAt = isoNow();
      this.firstAudioReceivedAt = audioAt;
      if (!this.session.firstTtsAudioAt) this.session.firstTtsAudioAt = audioAt;
      if (this.session.firstSpeechStoppedAt && !this.session.firstAudioAfterSpeechAt) {
        this.session.firstAudioAfterSpeechAt = audioAt;
      }
      const ttsRequestedAt = this.ttsRequestedAt ?? this.firstTextAt;
      this.metrics.ttsFirstAudioMs = elapsed(ttsRequestedAt, audioAt);
      this.metrics.speechToFirstAudioMs = elapsed(this.speechStoppedAt, audioAt);
    }
    this.audioBytes += audio.length;
    // Keep only a tiny local playout queue. Sending an entire response at once
    // makes Voximplant buffer seconds of audio and produces a harsh barge-in.
    const packetBytes = 320; // 40 ms of 8 kHz mu-law.
    for (let offset = 0; offset < audio.length; offset += packetBytes) {
      this.audioQueue.push(audio.subarray(offset, Math.min(offset + packetBytes, audio.length)));
    }
    this.startPlaybackWhenReady();
  }

  private startPlaybackWhenReady(): void {
    if (this.stopped || this.mediaStarted || this.playbackStarting || !this.audioQueue.length) return;
    this.playbackStarting = true;
    const delayMs = Math.max(
      0,
      this.beforePlayback?.() ?? 0,
      this.playbackNotBeforeMs - Date.now(),
    );
    const start = () => {
      this.playbackStartTimer = null;
      this.playbackStarting = false;
      if (this.stopped || this.mediaStarted || !this.audioQueue.length) return;
      this.mediaStarted = true;
      this.metrics.speechToPlaybackMs = elapsed(this.speechStoppedAt, isoNow());
      this.onPlaybackStarted?.();
      sendJson(this.vox, {
        event: 'start',
        sequenceNumber: this.sequence++,
        start: { tag: 'assistant', mediaFormat: { encoding: 'ULAW' } },
      });
      this.pumpAudio();
    };
    if (delayMs > 0) {
      this.playbackStartTimer = setTimeout(start, delayMs);
      this.playbackStartTimer.unref();
    } else start();
  }

  private pumpAudio(): void {
    if (this.stopped || !this.mediaStarted || this.audioTimer) return;
    const packet = this.audioQueue.shift();
    if (!packet) {
      if (this.generationFinished) this.stopMedia();
      return;
    }
    const payload = packet.toString('base64');
    sendJson(this.vox, {
      event: 'media',
      sequenceNumber: this.sequence++,
      media: { tag: 'assistant', chunk: this.chunk++, timestamp: this.timestamp, payload },
    });
    // mu-law contains one byte per sample; Voximplant timestamps are samples.
    this.timestamp += packet.length;
    const packetDurationMs = Math.max(20, Math.round(packet.length / 8));
    this.audioTimer = setTimeout(() => {
      this.audioTimer = null;
      this.pumpAudio();
    }, packetDurationMs);
  }

  private finishGeneration(): void {
    if (this.stopped || this.generationFinished) return;
    this.generationFinished = true;
    const generatedAt = isoNow();
    const ttsRequestedAt = this.ttsRequestedAt ?? this.firstTextAt;
    this.metrics.ttsGenerationMs = elapsed(ttsRequestedAt, generatedAt);
    this.metrics.audioDurationMs = Math.round(this.audioBytes / 8);
    this.pumpAudio();
  }

  private stopMedia(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.mediaStarted) {
      sendJson(this.vox, {
        event: 'stop',
        sequenceNumber: this.sequence++,
        stop: { tag: 'assistant', mediaInfo: {} },
      });
    }
    this.onStopped();
  }
}

export function handleYandexRealtimeTestSocket(vox: WebSocket, requestUrl: string): void {
  const url = new URL(requestUrl, 'http://localhost');
  const callId = url.searchParams.get('call_id') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const session = sessions.get(callId);
  if (!session || !token || token !== session.token) {
    vox.close(1008, 'invalid test session');
    return;
  }
  if (!config.yandexCloudApiKey || !config.yandexCloudFolderId) {
    vox.close(1011, 'Yandex Realtime is not configured');
    return;
  }

  session.status = session.connectedAt ? 'connected' : 'media_connecting';
  const modelUri = `gpt://${config.yandexCloudFolderId}/${config.yandexRealtimeModel}`;
  const yandexUrl = `wss://ai.api.cloud.yandex.net/v1/realtime/openai?model=${encodeURIComponent(modelUri)}`;
  const yandex = new WebSocket(yandexUrl, {
    headers: { Authorization: `Api-Key ${config.yandexCloudApiKey}` },
  });
  // Keep one provider connection warm for the whole phone call. v3 uses
  // independent contexts; v4 turbo is sequential on one dialogue stream.
  const dialogueSocket: ElevenLabsTurnSocket | null = /^eleven_v3/.test(session.elevenLabsTts.modelId)
    ? new ElevenLabsDialogueSocket(session)
    : /^eleven_v4/.test(session.elevenLabsTts.modelId)
      ? new ElevenLabsV4DialogueSocket(session)
      : null;
  dialogueSocket?.connect();
  let ttsTurn: ElevenLabsTurn | null = null;
  let ttsTurnResponseId = '';
  let seamlessHandoffTurn: ElevenLabsTurn | null = null;
  let seamlessHandoffStartedAt: string | null = null;
  let assistantText = '';
  let responseActive = false;
  let activeResponseId = '';
  let responseAfterTool = false;
  let activeResponseCreatedAt: string | null = null;
  let activeTurnFirstTextAt: string | null = null;
  let activeTurnMetrics: TurnMetrics | null = null;
  let activeAssistantItemId = '';
  let activeAssistantPreviousItemId: string | null = null;
  const managerTranscriptIndexes = new Map<string, number>();
  let pendingContinuationTranscriptIndex: number | null = null;
  const cancelledResponseIds = new Set<string>();
  const suppressedResponseIds = new Set<string>();

  type BargeInSnapshot = {
    turn: ElevenLabsTurn;
    playbackMs: number;
    itemId: string;
    previousItemId: string | null;
    responseId: string;
    metrics: TurnMetrics | null;
  };
  type SpeechTiming = { startedAt: string | null; stoppedAt: string | null; transcribedAt: string | null };
  type ActiveSpeech = SpeechTiming & {
    itemId: string;
    partialText: string;
    outputWasActive: boolean;
    bargeIn: BargeInSnapshot | null;
    awaitingAnswer: boolean;
    interruptionConfirmed: boolean;
    priorSpeechDurationMs: number;
  };
  let currentSpeech: ActiveSpeech | null = null;
  let lastSpeech: SpeechTiming | null = null;
  let bargeInTimer: NodeJS.Timeout | null = null;
  let liveBackchannelTimer: NodeJS.Timeout | null = null;
  let thinkingBackchannelTimer: NodeJS.Timeout | null = null;
  let managerEndpointTimer: NodeJS.Timeout | null = null;
  let managerEndpointGeneration = 0;
  let speculativeEndpointGeneration: number | null = null;
  let endpointResponseRequested = false;
  let speculativePlaybackNotBeforeMs = 0;
  let activePlaybackNotBeforeMs = 0;
  let suppressNextResponseReason: string | null = null;
  let deferredResponseForSpeech = false;
  let backchannelPlayback: VoxBackchannelPlayback | null = null;
  let backchannelPlaybackKind: BackchannelKind | null = null;
  let lastListeningBackchannelAt = 0;
  let lastThinkingBackchannelAt = 0;
  let listeningBackchannelsInUserTurn = 0;
  let entityMismatchHandledForUserTurn = false;
  let backchannelVariant = 0;
  let pendingContextCorrection: BargeInSnapshot | null = null;
  let lastMainMediaStoppedAt = 0;
  let lastBackchannelStoppedAt = 0;
  let pendingHangupReason: string | null = null;
  let hangupSafetyTimer: NodeJS.Timeout | null = null;
  let hangupSent = false;
  let discardingManagerAudio = false;
  let discardedManagerAudioStartedAt: string | null = null;
  let discardedManagerAudioBytes = 0;
  let discardedSilenceMs = 0;
  let discardDrainStartedAtMs = 0;

  const recordFlowEvent = (event: ConversationFlowEvent) => {
    session.flowEvents.push(event);
    if (session.flowEvents.length > MAX_EVENT_ITEMS) {
      session.flowEvents.splice(0, session.flowEvents.length - MAX_EVENT_ITEMS);
    }
  };

  const assistantOwnsFloor = () => !config.yandexRealtimeBargeInEnabled
    && Boolean(ttsTurn?.isPlaying() || seamlessHandoffTurn?.isPlaying());

  const discardManagerAudioDuringAssistant = (payload: string): boolean => {
    const audio = Buffer.from(payload, 'base64');
    if (!audio.length) return false;
    const ownsFloor = assistantOwnsFloor();
    if (!ownsFloor && !discardingManagerAudio) return false;
    if (!discardedManagerAudioStartedAt) discardedManagerAudioStartedAt = isoNow();
    discardingManagerAudio = true;
    discardedManagerAudioBytes += audio.length;
    const durationMs = Math.round(audio.length / 32);
    if (ownsFloor) {
      // Do not let echo from the assistant poison the post-playback VAD.
      discardedSilenceMs = 0;
      discardDrainStartedAtMs = 0;
      return true;
    }
    if (!discardDrainStartedAtMs) discardDrainStartedAtMs = Date.now();
    if (pcm16HasSpeech(audio)) discardedSilenceMs = 0;
    else discardedSilenceMs += durationMs;

    // Once AI playback has ended, require a short clean silence boundary
    // before accepting microphone audio again. This prevents the tail of a
    // sentence spoken over the AI from becoming an answer to the next turn.
    const drainTimedOut = Date.now() - discardDrainStartedAtMs >= 2000;
    if (discardedSilenceMs >= 350 || drainTimedOut) {
      recordFlowEvent({
        type: 'manager_audio_discarded',
        at: isoNow(),
        reason: drainTimedOut
          ? 'strict_half_duplex_drain_timeout'
          : 'strict_half_duplex_until_silence',
        speechDurationMs: Math.round(discardedManagerAudioBytes / 32),
        latencyMs: elapsed(discardedManagerAudioStartedAt, isoNow()),
      });
      discardingManagerAudio = false;
      discardedManagerAudioStartedAt = null;
      discardedManagerAudioBytes = 0;
      discardedSilenceMs = 0;
      discardDrainStartedAtMs = 0;
    }
    return true;
  };

  const reconcileInterruptedContext = (snapshot: BargeInSnapshot): { heardText: string; corrected: boolean } => {
    const heardText = snapshot.turn.audibleText(snapshot.playbackMs);
    const incompleteHeardFragment = Boolean(heardText) && !/[.!?…][»”"')\]]*\s*$/.test(heardText);
    if (snapshot.itemId) {
      sendJson(yandex, { type: 'conversation.item.delete', item_id: snapshot.itemId });
      if (heardText) {
        sendJson(yandex, {
          type: 'conversation.item.create',
          ...(snapshot.previousItemId ? { previous_item_id: snapshot.previousItemId } : {}),
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: heardText }],
          },
        });
      }
      if (incompleteHeardFragment) {
        sendJson(yandex, {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{
              type: 'input_text',
              text: `Служебное событие телефонии: собеседник услышал только оборванный фрагмент «${heardText}». ` +
                'После него не прозвучал вопрос или законченная мысль. Не ссылайся на непрозвучавшее продолжение и дождись смысла текущего ответа. ' +
                'Ты остаёшься клиентом, который сам инициировал этот исходящий звонок; не переходи в роль принимающего звонок сотрудника.',
            }],
          },
        });
      }
      return { heardText, corrected: true };
    }

    // Fallback for a provider response that did not include an item id. This
    // does not rewrite history, but explicitly prevents the next answer from
    // relying on the unplayed tail.
    sendJson(yandex, {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{
          type: 'input_text',
          text: 'Служебное событие телефонии: предыдущую реплику перебили. ' +
            `Собеседник услышал только: «${heardText || 'ничего'}». ` +
            'Не считай остальную часть реплики сообщённой. Короткое подтверждение продолжает разговор, ' +
            'а не является ответом на непрозвучавший вопрос. Ты по-прежнему сам звонишь сотруднику как клиент.',
        }],
      },
    });
    return { heardText, corrected: false };
  };

  const applyInterruptedContext = (snapshot: BargeInSnapshot) => {
    const correction = reconcileInterruptedContext(snapshot);
    if (snapshot.metrics) {
      snapshot.metrics.heardTextOnInterruption = correction.heardText || null;
      snapshot.metrics.contextCorrected = correction.corrected;
    }
  };

  const cancelOutput = (bargeIn: BargeInSnapshot | null = null, preserveBufferedPlayback = false) => {
    const wasResponseActive = responseActive;
    if (wasResponseActive) {
      if (activeResponseId) cancelledResponseIds.add(activeResponseId);
      sendJson(yandex, { type: 'response.cancel' });
    }
    const interruptedTtsTurn = ttsTurn;
    const mainAudioMayStillBeBuffered = Boolean(
      interruptedTtsTurn?.isPlaying()
      || seamlessHandoffTurn?.isPlaying()
      || (lastMainMediaStoppedAt > 0 && Date.now() - lastMainMediaStoppedAt < 1600),
    );
    if (preserveBufferedPlayback && interruptedTtsTurn?.isPlaying()) {
      seamlessHandoffTurn?.cancel();
      interruptedTtsTurn.stopGenerationAndDrain();
      seamlessHandoffTurn = interruptedTtsTurn;
      seamlessHandoffStartedAt = isoNow();
      recordFlowEvent({ type: 'handoff_started', at: seamlessHandoffStartedAt, reason: 'answer_to_question' });
    } else {
      interruptedTtsTurn?.cancel();
      seamlessHandoffTurn?.cancel();
      seamlessHandoffTurn = null;
      seamlessHandoffStartedAt = null;
    }
    ttsTurn = null;
    ttsTurnResponseId = '';
    if (activeTurnMetrics) {
      activeTurnMetrics.interrupted = true;
      if (bargeIn) activeTurnMetrics.interruptionPlaybackMs = bargeIn.playbackMs;
    }
    if (bargeIn) {
      if (wasResponseActive) pendingContextCorrection = bargeIn;
      else applyInterruptedContext(bargeIn);
    }
    activeTurnMetrics = null;
    activeTurnFirstTextAt = null;
    assistantText = '';
    // Clear only when main speech can actually still be in Voximplant's
    // playout buffer. responseActive by itself is only model state and must
    // not erase an unrelated backchannel from the shared media buffer.
    if (!preserveBufferedPlayback && mainAudioMayStillBeBuffered) {
      sendJson(vox, { customEvent: 'control', action: 'clear_media' });
    }
  };

  const cancelSpeculativeOutput = (reason: string): boolean => {
    const preparedManagerAnswer = pendingContinuationTranscriptIndex != null
      && !ttsTurn?.isPlaying()
      && Boolean(responseActive || ttsTurn);
    if (speculativeEndpointGeneration == null && !preparedManagerAnswer) return false;
    const itemId = activeAssistantItemId;
    const metrics = activeTurnMetrics;
    cancelOutput(null, false);
    if (itemId) sendJson(yandex, { type: 'conversation.item.delete', item_id: itemId });
    const lastTurn = session.transcript[session.transcript.length - 1];
    if (lastTurn?.role === 'client' && lastTurn.metrics === metrics) session.transcript.pop();
    recordFlowEvent({
      type: 'speculative_response_cancelled',
      at: isoNow(),
      reason,
    });
    speculativeEndpointGeneration = null;
    endpointResponseRequested = false;
    speculativePlaybackNotBeforeMs = 0;
    activePlaybackNotBeforeMs = 0;
    return true;
  };

  const cancelBackchannel = (reason: string) => {
    const playback = backchannelPlayback;
    if (!playback || !playback.cancel()) return;
    backchannelPlayback = null;
    backchannelPlaybackKind = null;
    sendJson(vox, { customEvent: 'control', action: 'clear_media' });
    recordFlowEvent({ type: 'backchannel_cancelled', at: isoNow(), reason });
  };

  const cutOverBackchannelForMainAudio = (): number => {
    if (backchannelPlayback) {
      cancelBackchannel('main_audio_ready');
      return 100;
    }
    // The bridge sends filler audio in realtime, but Voximplant may still
    // retain its tail briefly after the local sender has finished.
    if (lastBackchannelStoppedAt > 0 && Date.now() - lastBackchannelStoppedAt < 1600) {
      sendJson(vox, { customEvent: 'control', action: 'clear_media' });
      recordFlowEvent({ type: 'backchannel_cancelled', at: isoNow(), reason: 'buffered_tail_before_main_audio' });
      return 100;
    }
    return 0;
  };

  const sendPendingHangup = () => {
    if (!pendingHangupReason || hangupSent) return;
    hangupSent = true;
    if (hangupSafetyTimer) clearTimeout(hangupSafetyTimer);
    hangupSafetyTimer = null;
    sendJson(vox, { customEvent: 'control', action: 'hangup', reason: pendingHangupReason });
  };

  const latestAssistantHasFarewell = () => {
    const lastAssistant = [...session.transcript].reverse().find((turn) => turn.role === 'client');
    return Boolean(lastAssistant && /(?:до\s+свидания|всего\s+доброго|хорошего\s+дня|спасибо[^.!?]*(?:до|всего))/iu.test(lastAssistant.text));
  };

  const ensureFarewellBeforeHangup = () => {
    if (!pendingHangupReason || hangupSent || ttsTurn?.isPlaying() || ttsTurn) return;
    if (latestAssistantHasFarewell()) {
      const timer = setTimeout(sendPendingHangup, 250);
      timer.unref();
      return;
    }
    const text = 'Хорошо, тогда договорились. Спасибо, до свидания.';
    const metrics: TurnMetrics = { deliveryStyle: 'warm' };
    const startedAt = isoNow();
    const turn = new ElevenLabsTurn(
      session,
      vox,
      metrics,
      startedAt,
      lastSpeech?.stoppedAt ?? null,
      dialogueSocket,
      () => {
        clearThinkingBackchannelTimer();
        return cutOverBackchannelForMainAudio();
      },
      null,
      () => {
        lastMainMediaStoppedAt = Date.now();
        if (ttsTurn === turn) ttsTurn = null;
        const timer = setTimeout(sendPendingHangup, 250);
        timer.unref();
      },
    );
    ttsTurn = turn;
    session.transcript.push({ role: 'client', text, at: startedAt, metrics });
    turn.setSourceText(text);
    turn.append(text);
    turn.finish();
  };

  const requestHangupAfterFarewell = (reason: string) => {
    pendingHangupReason = reason || 'completed';
    clearThinkingBackchannelTimer();
    if (backchannelPlayback) cancelBackchannel('call_finishing');
    if (hangupSafetyTimer) clearTimeout(hangupSafetyTimer);
    hangupSafetyTimer = setTimeout(sendPendingHangup, 15_000);
    hangupSafetyTimer.unref();
    if (!responseActive) ensureFarewellBeforeHangup();
  };

  const confirmInterruption = (speech: ActiveSpeech, reason: string) => {
    if (speech.interruptionConfirmed || !speech.outputWasActive) return;
    speech.interruptionConfirmed = true;
    if (bargeInTimer) clearTimeout(bargeInTimer);
    bargeInTimer = null;
    if (speech.bargeIn?.turn.isPlaying()) cancelBackchannel('main_interruption_confirmed');
    if (speech.bargeIn) speech.bargeIn.playbackMs = speech.bargeIn.turn.playedAudioMs();
    const preserveBufferedPlayback = config.yandexRealtimeSeamlessHandoffEnabled
      && reason === 'answer_to_question'
      && Boolean(speech.bargeIn?.turn.isPlaying());
    cancelOutput(speech.bargeIn, preserveBufferedPlayback);
    recordFlowEvent({
      type: 'barge_in_confirmed',
      at: isoNow(),
      reason,
      latencyMs: elapsed(speech.startedAt, isoNow()),
    });
    if (!speech.stoppedAt) {
      scheduleLiveBackchannel(
        speech,
        Math.max(100, config.yandexRealtimeBackchannelMinSpeechMs - speech.priorSpeechDurationMs),
      );
    }
  };

  const playBackchannel = (
    kind: BackchannelKind,
    reason: string,
    speechDurationMs: number | null,
    managerText = '',
  ) => {
    recordFlowEvent({ type: 'backchannel_scheduled', at: isoNow(), reason, speechDurationMs });
    if (!config.yandexRealtimeBackchannelEnabled) {
      recordFlowEvent({ type: 'backchannel_cancelled', at: isoNow(), reason: 'disabled', speechDurationMs });
      return;
    }
    const admission = admitBackchannel({
      kind,
      listeningCountInTurn: listeningBackchannelsInUserTurn,
      configuredListeningLimit: config.yandexRealtimeBackchannelMaxPerTurn,
      msSincePreviousBackchannel: lastBackchannelStoppedAt > 0
        ? Date.now() - lastBackchannelStoppedAt
        : null,
      msSincePreviousThinking: lastThinkingBackchannelAt > 0
        ? Date.now() - lastThinkingBackchannelAt
        : null,
    });
    if (!admission.allowed) {
      recordFlowEvent({
        type: 'backchannel_cancelled',
        at: isoNow(),
        reason: admission.reason,
        speechDurationMs,
      });
      return;
    }
    // Model generation is not an occupied phone audio channel. In particular,
    // Yandex may briefly keep responseActive=true while an auto-response is
    // being cancelled between VAD fragments. Blocking on that flag starved
    // every backchannel even though Voximplant was completely silent.
    if (ttsTurn?.isPlaying() || seamlessHandoffTurn?.isPlaying() || backchannelPlayback) {
      recordFlowEvent({ type: 'backchannel_cancelled', at: isoNow(), reason: 'output_busy', speechDurationMs });
      return;
    }
    const clips = readyBackchannelClips(session, kind);
    if (!clips.length) {
      recordFlowEvent({ type: 'backchannel_cancelled', at: isoNow(), reason: 'cache_not_ready', speechDurationMs });
      return;
    }
    const selectedText = chooseBackchannelText(
      kind,
      managerText,
      backchannelVariant++,
      clips.map((clip) => clip.text),
    );
    const clip = clips.find((candidate) => candidate.text === selectedText) ?? clips[0];
    const playback = new VoxBackchannelPlayback(
      vox,
      clip.audio,
      () => recordFlowEvent({
        type: 'backchannel_played',
        at: isoNow(),
        reason: `${reason}:${clip.text}`,
        speechDurationMs,
      }),
      () => {
        lastBackchannelStoppedAt = Date.now();
        if (backchannelPlayback === playback) {
          backchannelPlayback = null;
          backchannelPlaybackKind = null;
        }
      },
    );
    backchannelPlayback = playback;
    backchannelPlaybackKind = kind;
    if (kind === 'listening') {
      lastListeningBackchannelAt = Date.now();
      listeningBackchannelsInUserTurn += 1;
    } else {
      lastThinkingBackchannelAt = Date.now();
    }
    playback.start();
  };

  const clearLiveBackchannelTimer = () => {
    if (liveBackchannelTimer) clearTimeout(liveBackchannelTimer);
    liveBackchannelTimer = null;
  };

  const clearThinkingBackchannelTimer = () => {
    if (thinkingBackchannelTimer) clearTimeout(thinkingBackchannelTimer);
    thinkingBackchannelTimer = null;
  };

  const scheduleThinkingBackchannel = (speechDurationMs: number | null, managerText: string) => {
    clearThinkingBackchannelTimer();
    // Let the actual reply win when LLM + TTS are fast. A filler is useful
    // only for a real generation gap, not as a mandatory prefix to each turn.
    thinkingBackchannelTimer = setTimeout(() => {
      thinkingBackchannelTimer = null;
      if (currentSpeech || ttsTurn) {
        recordFlowEvent({
          type: 'backchannel_cancelled',
          at: isoNow(),
          reason: 'main_response_started_before_thinking_filler',
          speechDurationMs,
        });
        return;
      }
      playBackchannel('thinking', 'thinking_before_slow_response', speechDurationMs, managerText);
    }, 900);
    thinkingBackchannelTimer.unref();
  };

  const clearManagerEndpointTimer = () => {
    managerEndpointGeneration += 1;
    if (managerEndpointTimer) clearTimeout(managerEndpointTimer);
    managerEndpointTimer = null;
  };

  const scheduleManagerTurnCommit = (
    delayMs: number,
    reason: string,
    speechDurationMs: number | null,
  ): number => {
    clearManagerEndpointTimer();
    const generation = managerEndpointGeneration;
    speculativeEndpointGeneration = generation;
    speculativePlaybackNotBeforeMs = Date.now() + delayMs;
    if (activeTurnMetrics) {
      const endpointAnchorMs = new Date(lastSpeech?.transcribedAt ?? lastSpeech?.stoppedAt ?? isoNow()).getTime();
      activeTurnMetrics.endpointStabilityMs = Math.max(0, speculativePlaybackNotBeforeMs - endpointAnchorMs);
    }
    if (ttsTurn && !ttsTurn.isPlaying()) {
      activePlaybackNotBeforeMs = speculativePlaybackNotBeforeMs;
      ttsTurn.setPlaybackNotBefore(activePlaybackNotBeforeMs);
    }
    recordFlowEvent({
      type: 'endpoint_completion_grace_started',
      at: isoNow(),
      reason,
      speechDurationMs,
      latencyMs: delayMs,
    });
    recordFlowEvent({
      type: 'speculative_response_started',
      at: isoNow(),
      reason,
      speechDurationMs,
      latencyMs: delayMs,
    });
    // Generate while the endpoint is settling, but keep provider audio behind
    // the playback gate. A resumed manager turn cancels this draft before any
    // part of it can reach the phone.
    if (!responseActive && !endpointResponseRequested) {
      suppressNextResponseReason = null;
      endpointResponseRequested = true;
      sendJson(yandex, { type: 'response.create' });
    }
    managerEndpointTimer = setTimeout(() => {
      managerEndpointTimer = null;
      if (generation !== managerEndpointGeneration || currentSpeech) return;
      // Invalidate asynchronous semantic results that arrive after audio has
      // already been released; they must never reopen a committed turn.
      managerEndpointGeneration += 1;
      speculativeEndpointGeneration = null;
      const managerText = pendingContinuationTranscriptIndex != null
        ? session.transcript[pendingContinuationTranscriptIndex]?.text ?? ''
        : '';
      deferredResponseForSpeech = false;
      suppressNextResponseReason = null;
      recordFlowEvent({
        type: 'endpoint_turn_committed',
        at: isoNow(),
        reason,
        speechDurationMs,
      });
      scheduleThinkingBackchannel(speechDurationMs, managerText);
      if (!responseActive && !endpointResponseRequested) {
        endpointResponseRequested = true;
        sendJson(yandex, { type: 'response.create' });
      }
    }, delayMs);
    managerEndpointTimer.unref();
    return generation;
  };

  const scheduleLiveBackchannel = (speech: ActiveSpeech, delayMs: number) => {
    clearLiveBackchannelTimer();
    const listeningLimit = Math.min(1, config.yandexRealtimeBackchannelMaxPerTurn);
    if (
      !config.yandexRealtimeBackchannelEnabled
      || !config.yandexRealtimeListeningBackchannelEnabled
      || (speech.outputWasActive && !speech.interruptionConfirmed)
      || listeningBackchannelsInUserTurn >= listeningLimit
    ) return;
    liveBackchannelTimer = setTimeout(() => {
      liveBackchannelTimer = null;
      if (
        currentSpeech !== speech
        || speech.stoppedAt
        || listeningBackchannelsInUserTurn >= listeningLimit
      ) return;
      const liveSegmentMs = elapsed(speech.startedAt, isoNow()) ?? 0;
      const speechDurationMs = speech.priorSpeechDurationMs + liveSegmentMs;
      if (Date.now() - lastListeningBackchannelAt >= config.yandexRealtimeBackchannelCooldownMs) {
        playBackchannel('listening', 'manager_still_speaking', speechDurationMs, speech.partialText);
      }
      if (listeningBackchannelsInUserTurn < listeningLimit) {
        const cooldownRemaining = Math.max(
          250,
          config.yandexRealtimeBackchannelCooldownMs - (Date.now() - lastListeningBackchannelAt),
        );
        scheduleLiveBackchannel(speech, cooldownRemaining);
      }
    }, delayMs);
    liveBackchannelTimer.unref();
  };


  const toolResult = (callIdValue: string, value: unknown, requestFollowup = true) => {
    sendJson(yandex, {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callIdValue, output: JSON.stringify(value) },
    });
    if (!requestFollowup) return;
    if (responseActive) responseAfterTool = true;
    else sendJson(yandex, { type: 'response.create' });
  };

  yandex.on('open', () => {
    session.yandexConnectedAt = isoNow();
  });
  yandex.on('message', (raw) => {
    const message = parseJson(raw);
    if (!message) return;
    switch (message.type) {
      case 'response.created':
        {
          const createdResponseId = String(message.response?.id ?? message.response_id ?? '');
          const awaitingSpeechClassification = Boolean(
            currentSpeech
            && !currentSpeech.interruptionConfirmed
            && !currentSpeech.transcribedAt,
          );
          if (suppressNextResponseReason || awaitingSpeechClassification) {
            if (createdResponseId) {
              suppressedResponseIds.add(createdResponseId);
              cancelledResponseIds.add(createdResponseId);
            }
            sendJson(yandex, { type: 'response.cancel' });
            if (awaitingSpeechClassification) deferredResponseForSpeech = true;
            suppressNextResponseReason = null;
            break;
          }
        }
        responseActive = true;
        const speculativeResponse = speculativeEndpointGeneration != null;
        if (speculativeResponse) endpointResponseRequested = true;
        if (!speculativeResponse) {
          clearManagerEndpointTimer();
          pendingContinuationTranscriptIndex = null;
        }
        activeResponseId = String(message.response?.id ?? message.response_id ?? '');
        activeResponseCreatedAt = isoNow();
        activePlaybackNotBeforeMs = speculativeResponse ? speculativePlaybackNotBeforeMs : 0;
        activeTurnFirstTextAt = null;
        activeTurnMetrics = {
          endpointWaitMs: elapsed(
            lastSpeech?.transcribedAt ?? lastSpeech?.stoppedAt ?? null,
            activeResponseCreatedAt,
          ),
          endpointStabilityMs: speculativeResponse
            ? Math.max(0, activePlaybackNotBeforeMs - Date.now())
            : 0,
        };
        activeAssistantItemId = '';
        activeAssistantPreviousItemId = null;
        listeningBackchannelsInUserTurn = 0;
        entityMismatchHandledForUserTurn = false;
        break;
      case 'response.output_item.added':
        if (message.item?.type === 'message' && message.item?.role === 'assistant') {
          const responseId = String(message.response_id ?? '');
          if (responseId && suppressedResponseIds.has(responseId)) {
            const itemId = String(message.item.id ?? '');
            if (itemId) sendJson(yandex, { type: 'conversation.item.delete', item_id: itemId });
            break;
          }
          activeAssistantItemId = String(message.item.id ?? '');
        }
        break;
      case 'conversation.item.created':
        if (message.item?.type === 'message' && message.item?.role === 'assistant') {
          const itemId = String(message.item.id ?? '');
          if (!activeAssistantItemId || activeAssistantItemId === itemId) {
            activeAssistantItemId = itemId;
            activeAssistantPreviousItemId = message.previous_item_id
              ? String(message.previous_item_id)
              : null;
          }
        }
        break;
      case 'response.done':
        {
          const doneResponseId = String(message.response?.id ?? message.response_id ?? '');
          if (doneResponseId && suppressedResponseIds.has(doneResponseId)) {
            suppressedResponseIds.delete(doneResponseId);
            cancelledResponseIds.delete(doneResponseId);
            break;
          }
        }
        responseActive = false;
        if (pendingContextCorrection
          && (!pendingContextCorrection.responseId || pendingContextCorrection.responseId === activeResponseId)) {
          applyInterruptedContext(pendingContextCorrection);
          pendingContextCorrection = null;
        }
        if (activeResponseId) cancelledResponseIds.delete(activeResponseId);
        activeResponseId = '';
        if (responseAfterTool) {
          responseAfterTool = false;
          sendJson(yandex, { type: 'response.create' });
        }
        ensureFarewellBeforeHangup();
        break;
      case 'session.created':
        sendJson(yandex, {
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: `${session.prompt}\n\n` +
              'КРИТИЧЕСКИЙ ИНВАРИАНТ НА ВЕСЬ ЗВОНОК: ты AI-клиент и инициатор этого ИСХОДЯЩЕГО звонка. ' +
              'Во время твоей реплики входящая речь сотрудника откладывается и поступает в контекст после окончания озвучки; воспринимай её как следующую полную реплику, не как перебивание. ' +
              'На другом конце сотрудник, которому позвонил ты. Даже после паузы, перебивания, исправления контекста или непонятной реплики роли не меняются. ' +
              'Никогда не спрашивай сотрудника «по какому вопросу звонок?», «зачем вы звоните?», «чем могу помочь?» или «что вас интересует?» — это фразы принимающей стороны. ' +
              'Если сотрудник сам спрашивает о причине звонка, кратко назови СВОЮ причину из сценария и продолжай с позиции клиента. ' +
              (session.subjectTitle
                ? `Целевой предмет этого звонка: «${session.subjectTitle}». Если сотрудник явно назвал другую марку или модель, не переноси её характеристики на целевой предмет: один раз спокойно уточни объект разговора. `
                : '') +
              'Формат телефонного разговора: отвечай короткими естественными репликами, обычно одно-два предложения. ' +
              'По умолчанию укладывай ответ в одно предложение и примерно пятнадцать слов; второе предложение добавляй только если без него теряется смысл. ' +
              'Сначала говори ключевую реакцию, не повторяй уже сказанное и не используй канцелярские формулировки. ' +
              'Пока сотрудник говорит, молча дослушивай его: фоновые «ага», «угу» и «мгм» во время его речи отключены. ' +
              'Не генерируй «понял», «понятно» или «ясно» как самостоятельную реплику и не начинай ими каждый ответ; сразу переходи к содержательному продолжению разговора. ' +
              'Если собеседник перебил реплику, считай сообщённой только фактически прозвучавшую часть. ' +
              'После короткого подтверждения вроде «угу» естественно продолжи недосказанную мысль и не утверждай, что не расслышал ответ на вопрос, который ещё не прозвучал. ' +
              'Пиши числа, годы, сокращения и названия так, как их следует произнести по-русски. ' +
              'Иностранные марки, модели, аббревиатуры и буквенно-цифровые индексы передавай кириллицей в естественном русском произношении, не оставляй латиницу. ' +
              'Автомобильный индекс X5, Х5 или Ха5 всегда произноси «икс пять», никогда не произноси «ха пять». ' +
              'Не добавляй служебные ремарки, markdown и указания для озвучки.' +
              `\n\n${HUMAN_CONVERSATION_INSTRUCTIONS}`,
            output_modalities: ['text'],
            max_output_tokens: 300,
            yc_timeout_seconds: 1800,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 16000 },
                languages: ['ru-RU'],
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  silence_duration_ms: config.yandexRealtimeEndpointSilenceMs,
                },
              },
            },
            tools: [
              {
                type: 'function',
                name: 'send_dtmf',
                description: 'Нажать одну кнопку телефонного IVR. Вызывай только после завершения списка вариантов меню.',
                parameters: {
                  type: 'object',
                  properties: { digit: { type: 'string', enum: ['0','1','2','3','4','5','6','7','8','9','*','#'] } },
                  required: ['digit'],
                },
              },
              {
                type: 'function',
                name: 'end_call',
                description: 'Завершить звонок, когда разговор естественно окончен или продолжение невозможно.',
                parameters: {
                  type: 'object',
                  properties: { reason: { type: 'string' } },
                  required: [],
                },
              },
            ],
          },
        });
        break;
      case 'session.updated':
        session.status = session.connectedAt ? 'connected' : 'ready';
        // The caller must first hear and identify the live employee. Starting
        // a response here made AI speak over the employee's introduction.
        break;
      case 'input_audio_buffer.speech_started':
        // A suppression marker belongs only to the immediately preceding VAD
        // segment and must never eat the response to a new user turn.
        suppressNextResponseReason = null;
        // Speech resumed inside the endpoint stability window. Nothing from
        // the speculative answer has reached the phone, so discard that draft
        // and keep this audio in the same logical manager turn.
        const resumedBeforePlayback = cancelSpeculativeOutput('manager_resumed_before_playback');
        if (!resumedBeforePlayback && !responseActive && !ttsTurn?.isPlaying()) {
          endpointResponseRequested = false;
        }
        clearManagerEndpointTimer();
        clearThinkingBackchannelTimer();
        // Thinking fillers are played only after a committed endpoint. If the
        // manager resumes, the endpoint was premature and the filler must stop.
        if (backchannelPlaybackKind === 'thinking') cancelBackchannel('user_resumed_speaking');
        if (bargeInTimer) clearTimeout(bargeInTimer);
        {
          const startedAt = isoNow();
          const interruptedTurn = ttsTurn?.isPlaying() ? ttsTurn : null;
          const pendingMainOutput = !resumedBeforePlayback
            && Boolean((ttsTurn && !interruptedTurn) || (responseActive && !interruptedTurn));
          if (pendingMainOutput && config.yandexRealtimeBargeInEnabled) {
            cancelOutput(null, false);
            recordFlowEvent({
              type: 'barge_in_confirmed',
              at: startedAt,
              reason: 'manager_resumed_before_audio',
              latencyMs: 0,
            });
          }
          if (interruptedTurn && config.yandexRealtimeBargeInEnabled) interruptedTurn.setSourceText(assistantText);
          const playbackMs = interruptedTurn?.playedAudioMs() ?? 0;
          const heardAtSpeechStart = interruptedTurn?.audibleText(playbackMs) ?? '';
          const bargeIn: BargeInSnapshot | null = interruptedTurn && config.yandexRealtimeBargeInEnabled
            ? {
                turn: interruptedTurn,
                playbackMs,
                itemId: activeAssistantItemId,
                previousItemId: activeAssistantPreviousItemId,
                responseId: activeResponseId,
                metrics: activeTurnMetrics,
              }
            : null;
          // A speculative response does not own the phone channel. Once the
          // playback gate opens, strict half-duplex discards microphone audio
          // until a clean silence boundary instead of reusing it as an answer.
          const outputWasActive = Boolean(
            !resumedBeforePlayback
            && (interruptedTurn || (!config.yandexRealtimeBargeInEnabled && pendingMainOutput)),
          );
          currentSpeech = {
            startedAt,
            stoppedAt: null,
            transcribedAt: null,
            itemId: String(message.item_id ?? ''),
            partialText: '',
            outputWasActive,
            bargeIn,
            // A question only counts after its interrogative part actually
            // reached the phone. The full generated sentence may end with a
            // question that is still several seconds ahead in the audio.
            awaitingAnswer: sourceLooksLikeQuestion(heardAtSpeechStart),
            interruptionConfirmed: false,
            priorSpeechDurationMs: pendingContinuationTranscriptIndex != null
              ? session.transcript[pendingContinuationTranscriptIndex]?.metrics.speechDurationMs ?? 0
              : 0,
          };
          if (!outputWasActive) {
            scheduleLiveBackchannel(
              currentSpeech,
              Math.max(100, config.yandexRealtimeBackchannelMinSpeechMs - currentSpeech.priorSpeechDurationMs),
            );
          }
          if (outputWasActive && config.yandexRealtimeBargeInEnabled) {
            recordFlowEvent({ type: 'barge_in_candidate', at: startedAt, reason: 'vad_speech_started' });
            const confirmationMs = config.yandexRealtimeSmartBargeInEnabled
              ? config.yandexRealtimeBargeInSustainedMs
              : 240;
            const speech = currentSpeech;
            bargeInTimer = setTimeout(() => {
              bargeInTimer = null;
              if (currentSpeech !== speech || speech.stoppedAt) return;
              confirmInterruption(
                speech,
                speech.awaitingAnswer
                  ? 'answer_to_question'
                  : config.yandexRealtimeSmartBargeInEnabled ? 'sustained_speech' : 'legacy_vad_timeout',
              );
            }, confirmationMs);
          }
        }
        break;
      case 'input_audio_buffer.speech_stopped': {
        const stoppedAt = isoNow();
        clearLiveBackchannelTimer();
        if (bargeInTimer) clearTimeout(bargeInTimer);
        bargeInTimer = null;
        if (!currentSpeech) {
          currentSpeech = {
            startedAt: null,
            stoppedAt,
            transcribedAt: null,
            itemId: String(message.item_id ?? ''),
            partialText: '',
            outputWasActive: false,
            bargeIn: null,
            awaitingAnswer: false,
            interruptionConfirmed: false,
            priorSpeechDurationMs: pendingContinuationTranscriptIndex != null
              ? session.transcript[pendingContinuationTranscriptIndex]?.metrics.speechDurationMs ?? 0
              : 0,
          };
        }
        else currentSpeech.stoppedAt = stoppedAt;
        if (!session.firstSpeechStoppedAt) session.firstSpeechStoppedAt = stoppedAt;
        break;
      }
      case 'conversation.item.input_audio_transcription.delta':
      case 'conversation.item.input_audio_transcription.segment': {
        if (!currentSpeech) break;
        const incoming = String(message.transcript ?? message.text ?? message.delta ?? '').trim();
        currentSpeech.partialText = mergeTranscriptionHypothesis(
          currentSpeech.partialText,
          incoming,
          message.type.endsWith('.delta'),
        );
        if (config.yandexRealtimeBargeInEnabled
          && currentSpeech.outputWasActive
          && !currentSpeech.interruptionConfirmed) {
          const decision = classifyInterruption(currentSpeech.partialText, {
            awaitingAnswer: currentSpeech.awaitingAnswer,
            final: false,
            minMeaningfulWords: 2,
          });
          if (decision.kind === 'interrupt') confirmInterruption(currentSpeech, decision.reason);
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(message.transcript ?? '').trim();
        const transcribedAt = isoNow();
        if (!currentSpeech) {
          currentSpeech = {
            startedAt: null,
            stoppedAt: null,
            transcribedAt,
            itemId: String(message.item_id ?? ''),
            partialText: text,
            outputWasActive: false,
            bargeIn: null,
            awaitingAnswer: false,
            interruptionConfirmed: false,
            priorSpeechDurationMs: pendingContinuationTranscriptIndex != null
              ? session.transcript[pendingContinuationTranscriptIndex]?.metrics.speechDurationMs ?? 0
              : 0,
          };
        }
        else currentSpeech.transcribedAt = transcribedAt;
        if (bargeInTimer) clearTimeout(bargeInTimer);
        bargeInTimer = null;
        clearLiveBackchannelTimer();
        currentSpeech.partialText = text || currentSpeech.partialText;
        if (currentSpeech.outputWasActive && !config.yandexRealtimeBargeInEnabled) {
          const ignoredSpeech = currentSpeech;
          const ignoredItemId = String(message.item_id ?? message.item?.id ?? ignoredSpeech.itemId ?? '');
          if (ignoredItemId) {
            sendJson(yandex, { type: 'conversation.item.delete', item_id: ignoredItemId });
          }
          // Yandex may create an automatic response for this audio item. Drop
          // that response as well: speech that began while the AI owned the
          // floor (generation or playback) must not enter dialogue context.
          suppressNextResponseReason = 'assistant_turn_half_duplex';
          deferredResponseForSpeech = false;
          lastSpeech = ignoredSpeech;
          currentSpeech = null;
          recordFlowEvent({
            type: 'barge_in_ignored',
            at: transcribedAt,
            reason: 'assistant_turn_half_duplex',
            speechDurationMs: elapsed(ignoredSpeech.startedAt, ignoredSpeech.stoppedAt),
          });
          break;
        }
        const entityMismatch = detectVehicleEntityMismatch(
          [session.subjectTitle, session.subjectDescription].filter(Boolean).join('. '),
          currentSpeech.partialText,
        );
        if (entityMismatch && !entityMismatchHandledForUserTurn) {
          entityMismatchHandledForUserTurn = true;
          sendJson(yandex, {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{ type: 'input_text', text: vehicleMismatchInstruction(entityMismatch) }],
            },
          });
          recordFlowEvent({
            type: 'entity_mismatch_detected',
            at: transcribedAt,
            reason: `${entityMismatch.mentionedBrand}->${entityMismatch.targetBrand}`,
          });
        }
        const segmentSpeechDurationMs = elapsed(currentSpeech.startedAt, currentSpeech.stoppedAt);
        const speechDurationMs = currentSpeech.priorSpeechDurationMs
          + (segmentSpeechDurationMs ?? 0);
        let incompleteUserTurn = false;
        let endpointDelayMs = 0;
        let endpointReason = 'complete';
        let semanticTurnInput: { assistantQuestion: string; managerAnswer: string } | null = null;
        if (currentSpeech.outputWasActive && !currentSpeech.interruptionConfirmed) {
          const decision = classifyInterruption(currentSpeech.partialText, {
            awaitingAnswer: currentSpeech.awaitingAnswer,
            final: true,
            minMeaningfulWords: 2,
          });
          if (decision.kind === 'interrupt') {
            confirmInterruption(currentSpeech, decision.reason);
            if (deferredResponseForSpeech) {
              deferredResponseForSpeech = false;
              sendJson(yandex, { type: 'response.create' });
            }
          } else {
            const responseAlreadySuppressed = deferredResponseForSpeech;
            deferredResponseForSpeech = false;
            if (!responseAlreadySuppressed && !responseActive) suppressNextResponseReason = decision.reason;
            recordFlowEvent({
              type: 'barge_in_ignored',
              at: transcribedAt,
              reason: decision.reason,
              speechDurationMs,
            });
          }
        } else if (currentSpeech.outputWasActive && deferredResponseForSpeech) {
          deferredResponseForSpeech = false;
          sendJson(yandex, { type: 'response.create' });
        } else if (!currentSpeech.outputWasActive) {
          const previousAssistantTurn = [...session.transcript]
            .reverse()
            .find((turn) => turn.role === 'client');
          // Endpoint decisions must use what actually reached the phone. The
          // generated tail of an interrupted question is not conversation
          // context and otherwise makes a continuation look like a new answer.
          const previousAssistantText = effectiveAssistantContext(previousAssistantTurn);
          const pendingContinuationText = pendingContinuationTranscriptIndex != null
            && session.transcript[pendingContinuationTranscriptIndex]?.role === 'manager'
            ? session.transcript[pendingContinuationTranscriptIndex].text
            : '';
          const logicalUserText = pendingContinuationText
            ? mergeLogicalTurnText(pendingContinuationText, currentSpeech.partialText)
            : currentSpeech.partialText;
          const completion = config.yandexRealtimeIncompleteTurnEnabled
            ? assessUserTurnCompletion(logicalUserText, previousAssistantText)
            : { incomplete: false as const, reason: 'complete' as const };
          const openingIntroduction = !previousAssistantTurn && openingTurnNeedsIntroGrace(logicalUserText);
          const endpoint = openingIntroduction
            ? {
                delayMs: config.yandexRealtimeIncompleteTurnGraceMs,
                reason: 'opening_introduction_grace' as const,
              }
            : config.yandexRealtimeIncompleteTurnEnabled
              ? userTurnEndpoint(
                logicalUserText,
                previousAssistantText,
                completion,
                config.yandexRealtimeTurnGraceMs,
                config.yandexRealtimeIncompleteTurnGraceMs,
              )
              : { delayMs: 0, reason: 'complete' as const };
          endpointDelayMs = endpoint.delayMs;
          endpointReason = endpoint.reason;
          if (endpoint.delayMs > 0 && !openingIntroduction) {
            semanticTurnInput = { assistantQuestion: previousAssistantText, managerAnswer: logicalUserText };
          }
          if (endpoint.delayMs > 0) {
            incompleteUserTurn = true;
            const responseAlreadySuppressed = deferredResponseForSpeech;
            deferredResponseForSpeech = false;
            if (!responseAlreadySuppressed && !responseActive) {
              suppressNextResponseReason = endpoint.reason;
            }
            recordFlowEvent({
              type: 'endpoint_continuation_detected',
              at: transcribedAt,
              reason: endpoint.reason,
              speechDurationMs,
            });
          } else {
            scheduleThinkingBackchannel(speechDurationMs, logicalUserText);
            if (deferredResponseForSpeech) {
              deferredResponseForSpeech = false;
              sendJson(yandex, { type: 'response.create' });
            }
          }
        }
        lastSpeech = currentSpeech;
        currentSpeech = null;
        if (text) {
          const itemId = String(message.item_id ?? message.item?.id ?? '');
          const turn: TranscriptTurn = {
            role: 'manager',
            text,
            at: transcribedAt,
            updatedAt: transcribedAt,
            metrics: {
              speechDurationMs: elapsed(lastSpeech.startedAt, lastSpeech.stoppedAt),
              speechToTextMs: elapsed(lastSpeech.stoppedAt, lastSpeech.transcribedAt),
            },
          };
          const itemIndex = itemId ? managerTranscriptIndexes.get(itemId) : undefined;
          let cumulativeIndex: number | undefined;
          for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
            const candidate = session.transcript[index];
            // An actually delivered AI turn is a hard dialogue boundary. An
            // interrupted one-token stub is not and must not split the same
            // cumulative manager transcription into several rows.
            if (candidate.role === 'client') {
              if (!candidate.metrics.interrupted) break;
              continue;
            }
            if (isCumulativeTranscriptUpdate(
              candidate.text,
              text,
              candidate.updatedAt ?? candidate.at,
              transcribedAt,
              6500,
            )) cumulativeIndex = index;
            break;
          }
          const continuationIndex = pendingContinuationTranscriptIndex != null
            && session.transcript[pendingContinuationTranscriptIndex]?.role === 'manager'
            ? pendingContinuationTranscriptIndex
            : undefined;
          const replaceIndex = continuationIndex ?? itemIndex ?? cumulativeIndex;
          if (continuationIndex != null) {
            const previousTurn = session.transcript[continuationIndex];
            session.transcript[continuationIndex] = {
              role: 'manager',
              text: cumulativeIndex === continuationIndex
                ? text
                : mergeLogicalTurnText(previousTurn.text, text),
              at: previousTurn.at,
              updatedAt: transcribedAt,
              metrics: {
                speechDurationMs: (previousTurn.metrics.speechDurationMs ?? 0) + (turn.metrics.speechDurationMs ?? 0),
                speechToTextMs: turn.metrics.speechToTextMs,
              },
            };
          } else if (itemIndex != null && itemIndex >= 0) {
            const previousTurn = session.transcript[itemIndex];
            session.transcript[itemIndex] = {
              ...turn,
              at: previousTurn.at,
              updatedAt: transcribedAt,
              metrics: {
                speechDurationMs: Math.max(
                  previousTurn.metrics.speechDurationMs ?? 0,
                  turn.metrics.speechDurationMs ?? 0,
                ),
                speechToTextMs: turn.metrics.speechToTextMs,
              },
            };
          } else if (cumulativeIndex != null && cumulativeIndex >= 0) {
            const previousTurn = session.transcript[cumulativeIndex];
            session.transcript[cumulativeIndex] = {
              ...turn,
              at: previousTurn.at,
              updatedAt: transcribedAt,
              metrics: {
                speechDurationMs: (previousTurn.metrics.speechDurationMs ?? 0)
                  + (turn.metrics.speechDurationMs ?? 0),
                speechToTextMs: turn.metrics.speechToTextMs,
              },
            };
          } else session.transcript.push(turn);
          const storedIndex = replaceIndex ?? session.transcript.length - 1;
          if (itemId) managerTranscriptIndexes.set(itemId, storedIndex);
          pendingContinuationTranscriptIndex = incompleteUserTurn ? storedIndex : null;
          if (endpointDelayMs > 0) {
            const logicalDurationMs = session.transcript[storedIndex]?.metrics.speechDurationMs ?? speechDurationMs;
            const scheduledGeneration = scheduleManagerTurnCommit(endpointDelayMs, endpointReason, logicalDurationMs);
            if (config.yandexRealtimeSemanticTurnEnabled && semanticTurnInput) {
              const semanticStartedAt = Date.now();
              void assessSemanticTurnCompletion({
                ...semanticTurnInput,
                timeoutMs: config.yandexRealtimeSemanticTurnTimeoutMs,
              }).then((decision) => {
                if (
                  scheduledGeneration !== managerEndpointGeneration
                  || currentSpeech
                ) return;
                if (!decision) {
                  recordFlowEvent({
                    type: 'endpoint_semantic_assessed',
                    at: isoNow(),
                    reason: 'unavailable_or_timed_out',
                    speechDurationMs: logicalDurationMs,
                    latencyMs: Date.now() - semanticStartedAt,
                  });
                  return;
                }
                recordFlowEvent({
                  type: 'endpoint_semantic_assessed',
                  at: isoNow(),
                  reason: `${decision.complete ? 'complete' : 'incomplete'}:${decision.confidence.toFixed(2)}:${decision.reason}`,
                  speechDurationMs: logicalDurationMs,
                  latencyMs: Date.now() - semanticStartedAt,
                });
                const reliableComplete = decision.complete && decision.confidence >= 0.8;
                const reliableIncomplete = !decision.complete && decision.confidence >= 0.65;
                if (!reliableComplete && !reliableIncomplete) return;
                // Semantic completion must actually shorten the endpoint.
                // Previously it rescheduled the same full grace period, so a
                // confident result improved correctness but never latency.
                const targetDelayMs = reliableComplete
                  ? Math.min(config.yandexRealtimeTurnGraceMs, 400)
                  : config.yandexRealtimeIncompleteTurnGraceMs;
                const elapsedSinceTranscriptMs = Date.now() - new Date(transcribedAt).getTime();
                scheduleManagerTurnCommit(
                  Math.max(100, targetDelayMs - elapsedSinceTranscriptMs),
                  reliableComplete ? 'semantic_complete' : 'semantic_incomplete',
                  logicalDurationMs,
                );
              });
            }
          }
        }
        break;
      }
      case 'response.output_text.delta': {
        if (cancelledResponseIds.has(String(message.response_id ?? ''))) break;
        const delta = String(message.delta ?? '');
        if (!delta) break;
        const deltaResponseId = String(message.response_id ?? '');
        if (ttsTurn && ttsTurnResponseId && deltaResponseId && deltaResponseId !== ttsTurnResponseId) {
          cancelledResponseIds.add(deltaResponseId);
          sendJson(yandex, { type: 'response.cancel' });
          if (activeAssistantItemId) {
            sendJson(yandex, { type: 'conversation.item.delete', item_id: activeAssistantItemId });
          }
          session.errors.push('Yandex: overlapping response suppressed before TTS');
          break;
        }
        const textAt = isoNow();
        if (!session.firstTextDeltaAt) session.firstTextDeltaAt = textAt;
        if (session.firstSpeechStoppedAt && !session.firstTextAfterSpeechAt) {
          session.firstTextAfterSpeechAt = textAt;
        }
        if (!activeTurnMetrics) activeTurnMetrics = {};
        if (!activeTurnFirstTextAt) {
          activeTurnFirstTextAt = textAt;
          activeTurnMetrics.llmFirstTextMs = elapsed(activeResponseCreatedAt, textAt);
        }
        assistantText += delta;
        if (!ttsTurn) {
          const metrics = activeTurnMetrics;
          const turn = new ElevenLabsTurn(
            session,
            vox,
            metrics,
            activeTurnFirstTextAt,
            lastSpeech?.stoppedAt ?? null,
            dialogueSocket,
            () => {
              clearThinkingBackchannelTimer();
              const thinkingFillerPauseMs = cutOverBackchannelForMainAudio();
              const previousTurn = seamlessHandoffTurn;
              if (!previousTurn) return thinkingFillerPauseMs;
              seamlessHandoffTurn = null;
              previousTurn.cancel();
              sendJson(vox, { customEvent: 'control', action: 'clear_media' });
              recordFlowEvent({
                type: 'handoff_cutover',
                at: isoNow(),
                reason: 'new_audio_ready',
                latencyMs: elapsed(seamlessHandoffStartedAt, isoNow()),
              });
              seamlessHandoffStartedAt = null;
              return Math.max(thinkingFillerPauseMs, config.yandexRealtimeHandoffPauseMs);
            },
            () => {
              // The prepared answer is now audible. From this exact point the
              // dialogue boundary is final and strict half-duplex suppression
              // applies to microphone speech.
              pendingContinuationTranscriptIndex = null;
              speculativeEndpointGeneration = null;
              endpointResponseRequested = false;
              speculativePlaybackNotBeforeMs = 0;
            },
            () => {
              lastMainMediaStoppedAt = Date.now();
              if (ttsTurn === turn) {
                ttsTurn = null;
                ttsTurnResponseId = '';
              }
              ensureFarewellBeforeHangup();
            },
          );
          ttsTurn = turn;
          ttsTurnResponseId = deltaResponseId || activeResponseId;
          if (activePlaybackNotBeforeMs > 0) turn.setPlaybackNotBefore(activePlaybackNotBeforeMs);
        }
        ttsTurn.append(delta);
        break;
      }
      case 'response.output_text.done': {
        if (cancelledResponseIds.has(String(message.response_id ?? ''))) break;
        const textDoneAt = isoNow();
        const finalText = naturalizeAssistantText(String(message.text ?? assistantText));
        if (!activeTurnMetrics) activeTurnMetrics = {};
        activeTurnMetrics.llmTextGenerationMs = elapsed(activeTurnFirstTextAt, textDoneAt);
        if (finalText) {
          ttsTurn?.setSourceText(finalText);
          session.transcript.push({ role: 'client', text: finalText, at: textDoneAt, metrics: activeTurnMetrics });
        }
        assistantText = '';
        ttsTurn?.finish();
        break;
      }
      case 'response.function_call_arguments.done': {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(String(message.arguments ?? '{}')); } catch { /* noop */ }
        const name = String(message.name ?? '');
        session.tools.push({ name, arguments: args, at: isoNow() });
        if (name === 'send_dtmf') {
          const digit = String(args.digit ?? '');
          if (/^[0-9*#]$/.test(digit)) {
            sendJson(vox, { customEvent: 'control', action: 'send_dtmf', digit });
            toolResult(String(message.call_id), { ok: true, digit });
          } else {
            toolResult(String(message.call_id), { ok: false, error: 'invalid digit' });
          }
        } else if (name === 'end_call') {
          requestHangupAfterFarewell(String(args.reason ?? 'completed'));
          toolResult(String(message.call_id), { ok: true, deferred_until_audio_finished: true }, false);
        } else {
          toolResult(String(message.call_id), { ok: false, error: 'unknown tool' });
        }
        break;
      }
      case 'error':
        session.errors.push(`Yandex: ${String(message.error?.message ?? message.error ?? 'unknown error')}`);
        break;
    }
    if (session.transcript.length > MAX_EVENT_ITEMS) session.transcript.splice(0, session.transcript.length - MAX_EVENT_ITEMS);
    if (session.tools.length > MAX_EVENT_ITEMS) session.tools.splice(0, session.tools.length - MAX_EVENT_ITEMS);
  });
  yandex.on('error', (error) => session.errors.push(`Yandex socket: ${error.message}`));
  yandex.on('close', () => {
    if (bargeInTimer) clearTimeout(bargeInTimer);
    if (hangupSafetyTimer) clearTimeout(hangupSafetyTimer);
    clearLiveBackchannelTimer();
    clearThinkingBackchannelTimer();
    clearManagerEndpointTimer();
    cancelBackchannel('yandex_disconnected');
    ttsTurn?.cancel();
    seamlessHandoffTurn?.cancel();
    seamlessHandoffTurn = null;
    seamlessHandoffStartedAt = null;
    dialogueSocket?.close();
    pendingContextCorrection = null;
    discardingManagerAudio = false;
    discardedManagerAudioStartedAt = null;
    discardedManagerAudioBytes = 0;
    discardedSilenceMs = 0;
    discardDrainStartedAtMs = 0;
    if (!session.endedAt && !['failed', 'busy', 'no_answer', 'disconnected'].includes(session.status)) {
      session.status = 'yandex_disconnected';
      session.endedAt = isoNow();
    }
  });

  vox.on('message', (raw) => {
    const message = parseJson(raw);
    if (!message) return;
    if (message.event === 'media' && message.media?.payload) {
      const payload = String(message.media.payload);
      if (!discardManagerAudioDuringAssistant(payload)) {
        sendJson(yandex, { type: 'input_audio_buffer.append', audio: payload });
      }
    }
  });
  vox.on('error', (error) => session.errors.push(`Vox media socket: ${error.message}`));
  vox.on('close', () => {
    if (bargeInTimer) clearTimeout(bargeInTimer);
    if (hangupSafetyTimer) clearTimeout(hangupSafetyTimer);
    clearLiveBackchannelTimer();
    clearThinkingBackchannelTimer();
    clearManagerEndpointTimer();
    cancelBackchannel('call_disconnected');
    ttsTurn?.cancel();
    seamlessHandoffTurn?.cancel();
    seamlessHandoffTurn = null;
    seamlessHandoffStartedAt = null;
    discardingManagerAudio = false;
    discardedManagerAudioStartedAt = null;
    discardedManagerAudioBytes = 0;
    discardedSilenceMs = 0;
    discardDrainStartedAtMs = 0;
    dialogueSocket?.close();
    try { yandex.close(); } catch { /* noop */ }
  });
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [callId, session] of sessions) {
    if (new Date(session.createdAt).getTime() < cutoff) sessions.delete(callId);
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();
