/**
 * Persist and evaluate voice call sessions when a call ends (webhook).
 * Uses same evaluation criteria as correspondence (evaluatorV2).
 */

import { prisma } from '../db';
import { openai } from '../lib/openaiClient';
import { config } from '../config';
import { getRecordByCallId, type TranscriptTurn } from './callHistory';
import { loadCar } from '../data/carLoader';
import { getDefaultState } from '../state/defaultState';
import { evaluateSessionV2 } from '../llm/evaluatorV2';
import { getTranscriptFromVoxLog } from './voxLogTranscript';
import { buildConversationPairs, generateCallSummary, generateReplyImprovements } from './callSummary';
import { generateUnifiedCallReport } from './unifiedCallReport';

export type VoxWebhookEvent = 'progress' | 'connected' | 'disconnected' | 'failed' | 'busy' | 'no_answer';

export interface VoxWebhookPayload {
  call_id?: string;
  to?: string;
  event?: string;
  ts?: string;
  details?: Record<string, unknown> & { reason?: string; code?: number };
  /** Transcript from scenario (e.g. realtime_pure): [{ role: 'manager'|'client', text: string }] */
  transcript?: TranscriptTurn[] | unknown[];
  /** Voximplant session id (from AppEvents.Started) — used to fetch session log and parse transcript if not sent */
  vox_session_id?: number;
  /** Some Vox scenarios send vox_call_id instead of vox_session_id (call session history id). */
  vox_call_id?: number | string;
}

function normalizeWebhookEventName(rawEvent: unknown): string {
  const event = String(rawEvent ?? '').trim().toLowerCase();
  if (!event) return '';
  if (event === 'hangup' || event === 'disconnect' || event === 'completed' || event === 'ended') {
    return 'disconnected';
  }
  if (event === 'answer') return 'connected';
  if (event === 'ringing') return 'progress';
  return event;
}

function normalizeOutcome(event: string, details?: { reason?: string; code?: number }): string {
  const normalizedEvent = normalizeWebhookEventName(event);
  if (normalizedEvent === 'no_answer' || normalizedEvent === 'busy' || normalizedEvent === 'failed') return normalizedEvent;
  if (normalizedEvent === 'disconnected') return 'disconnected';
  return 'completed';
}

function dialogHistoryFromTranscript(transcript: TranscriptTurn[]): Array<{ role: 'client' | 'manager'; content: string }> {
  return transcript.map((t) => ({
    role: t.role as 'client' | 'manager',
    content: t.text,
  }));
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractAnalyticsEvaluationFields(evaluation: unknown): {
  dimensionsJson?: string;
  checklistResultsJson?: string;
} {
  if (!evaluation || typeof evaluation !== 'object') return {};
  const source = evaluation as Record<string, unknown>;
  return {
    dimensionsJson: source.dimension_scores ? JSON.stringify(source.dimension_scores) : undefined,
    checklistResultsJson: Array.isArray(source.checklist) ? JSON.stringify(source.checklist) : undefined,
  };
}

function clampNumber(value: unknown, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function normalizePlanCriteriaEvaluation(value: unknown): unknown | null {
  if (!value || typeof value !== 'object') return value ?? null;
  const source = value as Record<string, unknown>;
  const sourceItems = Array.isArray(source.items) ? source.items : [];
  const items = sourceItems.map((raw) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const maxScore = clampNumber(item.maxScore, 0, 100);
    const score = clampNumber(item.score, 0, maxScore);
    return {
      ...item,
      maxScore,
      score,
    };
  });
  const maxScore = items.reduce((sum, item) => sum + item.maxScore, 0);
  const totalScore = items.reduce((sum, item) => sum + item.score, 0);
  const percent = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
  return {
    ...source,
    items,
    totalScore,
    maxScore,
    percent,
  };
}

async function evaluatePlanCriteria(callId: string, transcript: TranscriptTurn[]): Promise<unknown | null> {
  const planCall = await prisma.callPlanCall.findUnique({ where: { callId }, select: { criteriaJson: true } });
  if (!planCall) return null;
  const criteria = safeJsonParse<Array<{ expectedAnswer?: string; score?: number }>>(planCall.criteriaJson, []);
  const meaningfulCriteria = criteria.filter((item) => String(item.expectedAnswer || '').trim());
  if (meaningfulCriteria.length === 0) return null;
  const prompt = [
    'Ты оцениваешь разговор сотрудника с виртуальным клиентом по условиям успеха скрипта.',
    'Для каждого условия сравни ответ сотрудника с эталоном.',
    'Правила: если ответил также или почти также — полный балл; если близко — половина; если не ответил — 0.',
    'Критично: score по каждому пункту НЕ МОЖЕТ быть больше maxScore этого пункта. Если maxScore=80, максимум score=80.',
    'totalScore должен быть суммой score, maxScore должен быть суммой maxScore, percent = totalScore / maxScore * 100.',
    'Верни только JSON: {"items":[{"expectedAnswer":"...","maxScore":100,"score":0,"evidence":"цитата или причина"}],"totalScore":0,"maxScore":0,"percent":0}.',
    '',
    `Условия:\n${JSON.stringify(meaningfulCriteria, null, 2)}`,
    '',
    `Диалог:\n${transcript.map((turn) => `${turn.role === 'manager' ? 'Сотрудник' : 'Клиент'}: ${turn.text}`).join('\n')}`,
  ].join('\n');
  try {
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'Ты строгий оценщик продаж. Отвечай только валидным JSON.' },
        { role: 'user', content: prompt },
      ],
    });
    const content = response.choices[0]?.message?.content || '';
    const jsonText = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    return normalizePlanCriteriaEvaluation(JSON.parse(jsonText));
  } catch (error) {
    console.warn('[voice/session] plan criteria evaluation failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function syncCallPlanCallFromSession(callId: string, patch: {
  outcome?: string | null;
  endedAt?: Date | null;
  transcript?: TranscriptTurn[] | null;
  evaluation?: unknown | null;
  totalScore?: number | null;
  failureReason?: string | null;
}): Promise<void> {
  const existing = await prisma.callPlanCall.findUnique({
    where: { callId },
    select: {
      id: true,
      planId: true,
      employeeId: true,
      dealershipId: true,
      profileId: true,
      importedItemId: true,
      scriptId: true,
      promptText: true,
    },
  });
  if (!existing) return;
  const analyticsFields = extractAnalyticsEvaluationFields(patch.evaluation);
  await prisma.callPlanCall.update({
    where: { callId },
    data: {
      status: patch.endedAt ? 'completed' : undefined,
      outcome: patch.outcome ?? undefined,
      endedAt: patch.endedAt ?? undefined,
      transcriptJson: patch.transcript ? JSON.stringify(patch.transcript) : undefined,
      evaluationJson: patch.evaluation ? JSON.stringify(patch.evaluation) : undefined,
      totalScore: patch.totalScore ?? undefined,
      failureReason: patch.failureReason ?? undefined,
    },
  });
  await prisma.voiceCallSession.update({
    where: { callId },
    data: {
      source: 'scheduled',
      planId: existing.planId,
      managerId: existing.employeeId,
      dealershipId: existing.dealershipId,
      dimensionsJson: analyticsFields.dimensionsJson,
      checklistResultsJson: analyticsFields.checklistResultsJson,
      caseContextJson: JSON.stringify({
        planId: existing.planId,
        scriptId: existing.scriptId,
        profileId: existing.profileId,
        importedItemId: existing.importedItemId,
      }),
    },
  }).catch((err) => {
    console.warn('[voice/session] failed to sync analytics links:', err instanceof Error ? err.message : err);
  });
}

/**
 * Called when Vox sends event (e.g. disconnected). Persists session and runs evaluation if we have transcript.
 */
export async function finalizeVoiceCallSession(payload: VoxWebhookPayload): Promise<void> {
  const callId = payload.call_id;
  const to = payload.to;
  const event = (normalizeWebhookEventName(payload.event) || 'disconnected') as VoxWebhookEvent;

  if (!callId || !to) {
    console.warn('[voice/session] finalizeVoiceCallSession: missing call_id or to', payload);
    return;
  }

  const record = getRecordByCallId(callId);
  const payloadVoxSessionId =
    payload.vox_session_id ??
    (payload.vox_call_id != null ? Number.parseInt(String(payload.vox_call_id), 10) || null : null) ??
    null;
  const recordVoxSessionId = record?.voxSessionId ?? null;
  // Prefer call_session_history_id saved from StartScenarios response (record),
  // then fallback to webhook payload IDs.
  const resolvedVoxSessionId = recordVoxSessionId ?? payloadVoxSessionId;
  const startedAt = record ? new Date(record.startedAt) : new Date();
  const endedAt = new Date();
  const durationSec = record ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000) : 0;
  const outcome = normalizeOutcome(event, payload.details);
  console.log('[voice/session] finalize start', {
    callId,
    event,
    to,
    hasPayloadTranscript: Array.isArray(payload.transcript) ? payload.transcript.length : 0,
    hasMemoryTranscript: record?.transcript?.length ?? 0,
    voxSessionId: resolvedVoxSessionId,
    voxSessionIdSource: recordVoxSessionId ? 'record' : (payloadVoxSessionId ? 'webhook' : 'none'),
    payloadVoxSessionId,
    recordVoxSessionId,
  });

  // Prefer transcript from webhook payload (e.g. realtime_pure sends it); fallback to in-memory record (dialog scenario)
  const rawPayloadTranscript = payload.transcript;
  let payloadTranscript: TranscriptTurn[] =
    Array.isArray(rawPayloadTranscript) &&
    rawPayloadTranscript.length > 0 &&
    rawPayloadTranscript.every(
      (t: unknown) =>
        typeof t === 'object' &&
        t !== null &&
        'role' in t &&
        'text' in t &&
        ((t as { role: string }).role === 'manager' || (t as { role: string }).role === 'client')
    )
      ? (rawPayloadTranscript as TranscriptTurn[])
      : [];

  const toNormalized = '+' + String(to).replace(/\D/g, '');

  // 1) Save session immediately so admin shows "Processing..." right after hangup
  const initialTranscript = payloadTranscript.length > 0 ? payloadTranscript : (record?.transcript ?? []);
  try {
    await prisma.voiceCallSession.upsert({
      where: { callId },
      create: {
        callId,
        to: toNormalized,
        startedAt,
        endedAt,
        outcome,
        durationSec,
        transcriptJson: JSON.stringify(initialTranscript),
        evaluationJson: null,
        totalScore: null,
        failureReason: null,
      },
      update: {
        endedAt,
        outcome,
        durationSec,
        transcriptJson: JSON.stringify(initialTranscript),
      },
    });
  } catch (err) {
    console.error('[voice/session] initial upsert error:', err instanceof Error ? err.message : err);
  }
  await syncCallPlanCallFromSession(callId, { outcome, endedAt, transcript: initialTranscript });

  // 2) If transcript missing but we have vox_session_id (realtime_pure), fetch from Voximplant log and update
  let transcript: TranscriptTurn[] = initialTranscript;
  let transcriptSource: 'webhook' | 'memory' | 'vox_log' | 'none' =
    payloadTranscript.length > 0 ? 'webhook' : (record?.transcript?.length ? 'memory' : 'none');

  if (transcript.length === 0 && resolvedVoxSessionId != null) {
    try {
      await new Promise((r) => setTimeout(r, 2000));
      const { transcript: logTranscript, error: voxLogError } = await getTranscriptFromVoxLog(resolvedVoxSessionId);
      if (logTranscript.length > 0) {
        transcript = logTranscript;
        transcriptSource = 'vox_log';
        await prisma.voiceCallSession.update({
          where: { callId },
          data: { transcriptJson: JSON.stringify(transcript) },
        });
      } else if (voxLogError === 'log_unauthorized') {
        await prisma.voiceCallSession.update({
          where: { callId },
          data: {
            failureReason:
              'Transcript unavailable: Vox log is protected (401). Set VOX_SERVICE_ACCOUNT_CREDENTIALS in .env to allow JWT log access.',
          },
        });
      }
    } catch (err) {
      console.warn('[voice/session] getTranscriptFromVoxLog failed:', err instanceof Error ? err.message : err);
    }
  }

  console.log('[voice/session] transcript', { callId, source: transcriptSource, turns: transcript.length });

  if (transcript.length < 2) {
    const reason =
      transcript.length === 0
        ? 'Transcript unavailable: webhook payload empty and Vox log returned no transcript.'
        : `Transcript too short for evaluation: ${transcript.length} turn(s).`;
    console.warn('[voice/session] transcript insufficient', { callId, source: transcriptSource, reason });
    try {
      await prisma.voiceCallSession.update({
        where: { callId },
        data: { failureReason: reason.slice(0, 200) },
      });
      await syncCallPlanCallFromSession(callId, { outcome, endedAt, transcript, failureReason: reason.slice(0, 200) });
    } catch (err) {
      console.warn('[voice/session] failed to save transcript failureReason:', err instanceof Error ? err.message : err);
    }
    return;
  }

  // 3) Run evaluation (can take time) and update session when ready
  try {
    const car = loadCar();
    const state = getDefaultState('normal');
    const dialogHistory = dialogHistoryFromTranscript(transcript);
    console.log('[voice/session] evaluation start', { callId, turns: transcript.length });
    const { evaluation } = await evaluateSessionV2({
      dialogHistory,
      car,
      state,
      earlyFail: false,
      behaviorSignals: [],
    });

    // ---- Extended call summary (team-summary style) + per-answer improvements ----
    let callSummary: unknown = null;
    let replyImprovements: unknown = null;
    let unifiedCallReport: unknown = null;
    try {
      const checklist = Array.isArray((evaluation as any).checklist) ? (evaluation as any).checklist : [];
      const issues = Array.isArray((evaluation as any).issues) ? (evaluation as any).issues : [];
      const recommendations = Array.isArray((evaluation as any).recommendations) ? (evaluation as any).recommendations : [];
      const dimensionScores = (evaluation as any).dimension_scores ?? null;

      callSummary = await generateCallSummary({
        transcript,
        outcome,
        totalScore: evaluation.overall_score_0_100 ?? null,
        dimensionScores: dimensionScores && typeof dimensionScores === 'object' ? dimensionScores : null,
        issues,
        checklist,
        recommendations,
      });

      const pairs = buildConversationPairs(transcript);
      if (pairs.length > 0) {
        const improvements = await generateReplyImprovements({
          pairs,
          limit: 12,
          issues,
        });
        replyImprovements = improvements;
      }
    } catch (err) {
      console.warn('[voice/session] callSummary generation failed:', err instanceof Error ? err.message : err);
    }

    try {
      unifiedCallReport = await generateUnifiedCallReport({
        transcript,
        outcome,
        totalScore: evaluation.overall_score_0_100 ?? null,
        evaluation: {
          ...evaluation,
          call_summary: callSummary,
          reply_improvements: replyImprovements,
        },
      });
    } catch (err) {
      console.warn('[voice/session] unified call report generation failed:', err instanceof Error ? err.message : err);
    }

    const evaluationJson = JSON.stringify({
      ...evaluation,
      call_summary: callSummary,
      reply_improvements: replyImprovements,
      unified_call_report: unifiedCallReport,
      plan_criteria: await evaluatePlanCriteria(callId, transcript),
    });
    const evaluationForPlan = JSON.parse(evaluationJson);
    const analyticsFields = extractAnalyticsEvaluationFields(evaluationForPlan);
    const totalScore = evaluation.overall_score_0_100 ?? null;

    await prisma.voiceCallSession.update({
      where: { callId },
      data: {
        evaluationJson,
        dimensionsJson: analyticsFields.dimensionsJson,
        checklistResultsJson: analyticsFields.checklistResultsJson,
        totalScore,
        failureReason: null,
      },
    });
    await syncCallPlanCallFromSession(callId, {
      outcome,
      endedAt,
      transcript,
      evaluation: evaluationForPlan,
      totalScore,
      failureReason: null,
    });
    console.log('[voice/session] evaluation saved', { callId, totalScore });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[voice/session] evaluateSessionV2 error:', msg);
    try {
      await prisma.voiceCallSession.update({
        where: { callId },
        data: { failureReason: msg.slice(0, 200) },
      });
      await syncCallPlanCallFromSession(callId, { outcome, endedAt, transcript, failureReason: msg.slice(0, 200) });
    } catch (_) {}
  }
}
