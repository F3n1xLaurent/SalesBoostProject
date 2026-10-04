/**
 * Voice call dialog: ASR (Voximplant) → text → our LLM (virtual client) → reply_text → TTS (Voximplant).
 * In-memory session store keyed by call_id. Same algorithm as Telegram training.
 */

import type { Request, Response } from 'express';
import { loadCar } from '../data/carLoader';
import { buildDealershipFromCar, getVirtualClientReply, type Strictness } from '../llm/virtualClient';
import { getDefaultState, type DialogState } from '../state/defaultState';
import { classifyBehavior, type BehaviorSignal } from '../logic/behaviorClassifier';
import { pickRandomObjection, type ClientProfile } from '../logic/clientProfile';
import type { Car } from '../data/carLoader';
import {
  advanceTopic,
  recordEvasion,
  type TopicCode,
} from '../logic/topicStateMachine';
import { appendTranscript } from './callHistory';

const DIALOG_HISTORY_LIMIT = 12;
const DEFAULT_STRICTNESS: Strictness = 'medium';
const DEFAULT_PROFILE: ClientProfile = 'normal';

interface VoiceCallSession {
  state: DialogState;
  history: Array<{ role: 'client' | 'manager'; content: string }>;
  car: Car;
  dealership: string;
  strictness: Strictness;
  max_client_turns: number;
  createdAt: number;
}

const sessions = new Map<string, VoiceCallSession>();

// Car loaded once at first use
let cachedCar: Car | null = null;
let cachedDealership: string = '';

function getCarAndDealership(): { car: Car; dealership: string } {
  if (!cachedCar) {
    cachedCar = loadCar();
    cachedDealership = buildDealershipFromCar(cachedCar);
  }
  return { car: cachedCar, dealership: cachedDealership };
}

function getOrCreateSession(callId: string): VoiceCallSession {
  let session = sessions.get(callId);
  if (session) return session;

  const { car, dealership } = getCarAndDealership();
  const state = getDefaultState(DEFAULT_PROFILE);
  const max_client_turns = 10;
  state.strictnessState = { strictness: DEFAULT_STRICTNESS, max_client_turns };
  state.objection_triggered = pickRandomObjection(DEFAULT_PROFILE);

  session = {
    state,
    history: [],
    car,
    dealership,
    strictness: DEFAULT_STRICTNESS,
    max_client_turns,
    createdAt: Date.now(),
  };
  sessions.set(callId, session);
  return session;
}

function applyDiagnosticsToState(state: DialogState, out: Awaited<ReturnType<typeof getVirtualClientReply>>): void {
  const diag = out.diagnostics;
  state.phase = diag.current_phase;
  state.client_turns = out.update_state.client_turns;
  state.stage = out.update_state.stage as any;
  state.notes = out.update_state.notes ?? state.notes;
  if (out.update_state.checklist) {
    state.checklist = { ...state.checklist, ...out.update_state.checklist } as any;
  }

  let topicMap = { ...state.topics };
  for (const code of diag.topics_addressed as TopicCode[]) {
    if (topicMap[code]) {
      const currentStatus = topicMap[code].status;
      const next = currentStatus === 'none' ? 'asked' : currentStatus === 'asked' ? 'answered' : currentStatus;
      const result = advanceTopic(topicMap, code, next as any);
      if (result.valid) topicMap = result.map;
    }
  }
  for (const code of diag.topics_evaded as TopicCode[]) {
    if (topicMap[code]) topicMap = recordEvasion(topicMap, code);
  }
  state.topics = topicMap;

  state.communication.tone = diag.manager_tone;
  state.communication.engagement = diag.manager_engagement;
  if (diag.misinformation_detected) state.fact_context.misinformation_detected = true;
}

/** Result of one voice dialog turn (same shape as POST /voice/dialog response). */
export interface VoiceDialogReply {
  reply_text: string;
  end_session: boolean;
}

/**
 * Core logic: get reply_text and end_session for a call_id and optional manager text.
 * Used by both POST /voice/dialog and WebSocket /voice/stream.
 */
const FALLBACK_GREETING = 'Здравствуйте! Я увидел ваше объявление. Подскажите, товар ещё доступен?';

export async function getVoiceDialogReply(callId: string, managerText?: string): Promise<VoiceDialogReply> {
  const text = typeof managerText === 'string' ? managerText.trim() : '';
  let session: VoiceCallSession;
  try {
    session = getOrCreateSession(callId);
  } catch (err) {
    console.error('[voice/dialog] getOrCreateSession failed (e.g. loadCar):', err instanceof Error ? err.message : err);
    return { reply_text: FALLBACK_GREETING, end_session: false };
  }
  const { state, history, car, dealership, strictness, max_client_turns } = session;

  if (history.length === 0) {
    const fallbackFirst = `Здравствуйте! Я увидел объявление о ${car.title}. Он ещё доступен для покупки?`;
    let out: Awaited<ReturnType<typeof getVirtualClientReply>>;
    try {
      out = await getVirtualClientReply({
        car,
        dealership,
        state,
        manager_last_message: '',
        dialog_history: [],
        strictness,
        max_client_turns,
        maxResponseTokens: 220,
      });
    } catch (err) {
      console.error('[voice/dialog] First message LLM error:', err instanceof Error ? err.message : err);
      out = {
        client_message: fallbackFirst,
        end_conversation: false,
        reason: '',
        diagnostics: {
          current_phase: 'first_contact',
          topics_addressed: [],
          topics_evaded: [],
          manager_tone: 'neutral',
          manager_engagement: 'active',
          misinformation_detected: false,
          phase_checks_update: {},
        },
        update_state: { stage: state.stage, checklist: {}, notes: '', client_turns: 1 },
      };
    }
    applyDiagnosticsToState(state, out);
    const firstReply = (out.client_message && out.client_message.trim()) || fallbackFirst;
    session.history.push({ role: 'client', content: firstReply });
    return { reply_text: firstReply, end_session: out.end_conversation };
  }

  if (!text) {
    const lastClient = [...history].reverse().find((m) => m.role === 'client');
    return { reply_text: lastClient?.content ?? '', end_session: false };
  }

  session.history.push({ role: 'manager', content: text });
  const lastClientMsg = [...history].reverse().find((m) => m.role === 'client');
  const behavior: BehaviorSignal = classifyBehavior(text, {
    lastClientQuestion: lastClientMsg?.content,
    isClientWaitingAnswer: true,
  });

  if (behavior.toxic) {
    const toxicReply =
      behavior.severity === 'HIGH'
        ? 'Извините, но я не готов продолжать разговор в таком тоне. Всего доброго.'
        : 'Мне бы хотелось более уважительного общения. На этом, пожалуй, закончим.';
    session.history.push({ role: 'client', content: toxicReply });
    sessions.delete(callId);
    return { reply_text: toxicReply, end_session: true };
  }

  if (behavior.low_effort) {
    state.low_effort_streak = (state.low_effort_streak ?? 0) + 1;
  } else {
    state.low_effort_streak = 0;
  }
  const historyForLlm = history.slice(-DIALOG_HISTORY_LIMIT);
  let out: Awaited<ReturnType<typeof getVirtualClientReply>>;
  try {
    out = await getVirtualClientReply({
      car,
      dealership,
      state,
      manager_last_message: text,
      dialog_history: historyForLlm,
      strictness,
      max_client_turns,
      behaviorSignal: behavior,
      maxResponseTokens: 220,
    });
  } catch (err) {
    console.error('[voice/dialog] LLM error:', err instanceof Error ? err.message : err);
    throw new Error('LLM failed');
  }

  applyDiagnosticsToState(state, out);
  session.history.push({ role: 'client', content: out.client_message });

  if (out.end_conversation) sessions.delete(callId);
  return { reply_text: out.client_message, end_session: out.end_conversation };
}

/** Split reply text into chunks for streaming TTS (by sentence, then by max length). */
export function splitReplyIntoChunks(replyText: string, maxChunkLen = 80): string[] {
  const s = replyText.trim();
  if (!s) return [];
  const sentences = s.split(/(?<=[.!?])\s+/).map((t) => t.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const sent of sentences) {
    if (sent.length <= maxChunkLen) {
      parts.push(sent);
    } else {
      for (let i = 0; i < sent.length; i += maxChunkLen) {
        parts.push(sent.slice(i, i + maxChunkLen));
      }
    }
  }
  return parts.length > 0 ? parts : [s];
}

/**
 * POST /voice/dialog
 * Body: { call_id: string, text?: string, is_final?: boolean }
 * - First request (no text or empty history): returns first client greeting.
 * - Subsequent: appends manager text, runs LLM, returns reply_text and end_session.
 */
export async function handleVoiceDialog(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { call_id?: string; text?: string; is_final?: boolean };
    const callId = body?.call_id;
    const managerText = typeof body?.text === 'string' ? body.text.trim() : '';

    console.log('[voice/dialog] Request', { call_id: callId, text_preview: managerText ? managerText.slice(0, 60) : '(first)' });

    if (!callId) {
      res.status(400).json({ error: 'Missing call_id' });
      return;
    }

    const result = await getVoiceDialogReply(callId, managerText);
    if (managerText) appendTranscript(callId, 'manager', managerText);
    appendTranscript(callId, 'client', result.reply_text);
    res.json({ reply_text: result.reply_text, end_session: result.end_session });
  } catch (err) {
    console.error('[voice/dialog] Error:', err);
    res.status(200).json({
      reply_text: FALLBACK_GREETING,
      end_session: false,
    });
  }
}

/** Optional: cleanup old sessions (e.g. call ended without proper end_session) */
export function deleteVoiceSession(callId: string): void {
  sessions.delete(callId);
}
