import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import { config } from '../config';
import { addCall, setVoxSessionId } from './callHistory';
import { prepareProductionOpenAiRealtimeCall, updateProductionRealtimeLifecycle } from './cometRealtimeTest';
import type { RealtimeTestPlanConfiguration } from './callSettingsManagement';
import { startVoiceCall, type StartVoiceCallResult } from './startVoiceCall';
import { flushProductionRealtimeState, registerProductionRealtimeState, realtimeWebhookTokenHash, unregisterProductionRealtimeState } from './productionRealtimeState';

export type CallPlanTelephonyProvider = 'openai_realtime' | 'elevenlabs_agent';
export function resolveCallPlanTelephonyProvider(value = process.env.CALL_PLAN_TELEPHONY_PROVIDER): CallPlanTelephonyProvider {
  const normalized = value?.trim().toLowerCase() || 'openai_realtime';
  if (normalized !== 'openai_realtime' && normalized !== 'elevenlabs_agent') {
    throw new Error('CALL_PLAN_TELEPHONY_PROVIDER должен быть openai_realtime или elevenlabs_agent.');
  }
  return normalized;
}

const active = new Map<string, { stop: () => void }>();

/** Freeze provider/profile before dialing. The caller MUST persist its rows
 * using this id before invoking start(), so even immediate webhooks are linked. */
export async function prepareCallPlanTelephony(phone: string, plan: RealtimeTestPlanConfiguration) {
  const provider = resolveCallPlanTelephonyProvider();
  const callId = randomUUID();
  const realtime = provider === 'openai_realtime'
    ? await prepareProductionOpenAiRealtimeCall({ callId, phone, plan }) : null;
  const webhookToken = realtime ? randomUUID() : null;
  const scenario = realtime ? 'openai_realtime' as const : 'realtime_pure' as const;
  const startedAt = new Date().toISOString();
  const telephony = {
    provider, scenario, model: realtime ? config.openaiRealtimeModel : null,
    voiceId: realtime?.voiceId ?? plan.elevenLabsVoiceId,
    webhookTokenHash: webhookToken ? realtimeWebhookTokenHash(webhookToken) : null,
  };
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  let started = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearInterval(timer);
    try { if (realtime) await flushProductionRealtimeState(callId); }
    finally {
      unregisterProductionRealtimeState(callId);
      realtime?.dispose();
      active.delete(callId);
    }
  };
  try {
    if (realtime && webhookToken) {
      registerProductionRealtimeState(callId, webhookToken, realtime.snapshot);
      await flushProductionRealtimeState(callId);
    }
  } catch (error) { await dispose(); throw error; }

  return {
    callId, startedAt, scenario, telephony, dispose,
    start: async (): Promise<StartVoiceCallResult> => {
      if (disposed) throw new Error('Подготовка звонка уже закрыта.');
      if (started) throw new Error('Этот звонок уже был запущен.');
      started = true;
      addCall(callId, phone, startedAt);
      realtime?.markDialing(startedAt);
      if (realtime) {
        await flushProductionRealtimeState(callId);
        timer = setInterval(() => {
          void flushProductionRealtimeState(callId).catch((error) => console.error('[voice/realtime] snapshot save failed', { callId, error: String(error) }));
        }, 1000);
        timer.unref();
        active.set(callId, { stop: () => { if (timer) clearInterval(timer); } });
      }
      const result = await startVoiceCall(phone, {
        scenario, callId, instructions: plan.prompt,
        elevenLabsVoiceId: telephony.voiceId,
        customerVoiceId: plan.customerVoiceId,
        streamToken: realtime?.streamToken,
        webhookToken: webhookToken ?? undefined,
      });
      if ('error' in result) {
        updateProductionRealtimeLifecycle(callId, 'failed', new Date().toISOString());
        await dispose();
        throw new Error(result.error);
      }
      if (result.callSessionHistoryId) {
        setVoxSessionId(callId, result.callSessionHistoryId);
        await prisma.voiceCallSession.updateMany({ where: { callId }, data: { voxSessionId: String(result.callSessionHistoryId) } })
          .catch((error) => console.warn('[voice/realtime] session-id persistence delayed', { callId, error: String(error) }));
      }
      return { ...result, startedAt };
    },
  };
}

export async function finishProductionCallPlanTelephony(callId: string, event: string, at: string): Promise<void> {
  updateProductionRealtimeLifecycle(callId, event, at);
  active.get(callId)?.stop();
  try { await flushProductionRealtimeState(callId); }
  finally {
    unregisterProductionRealtimeState(callId);
    active.delete(callId);
  }
}

export async function markCallPlanLaunchFailed(callId: string, error: unknown): Promise<void> {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  const endedAt = new Date();
  await prisma.voiceCallSession.updateMany({ where: { callId, connectedAt: null, endedAt: null }, data: { outcome: 'failed', endedAt, failureReason: reason } });
  await prisma.callPlanCall.updateMany({ where: { callId, endedAt: null }, data: { status: 'failed', outcome: 'failed', endedAt, failureReason: reason } });
}
