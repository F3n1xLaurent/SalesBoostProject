import type { Request, Response } from 'express';
import { prisma } from '../db';
import { finishProductionCallPlanTelephony } from './callPlanTelephony';
import { updateProductionRealtimeLifecycle } from './cometRealtimeTest';
import { authenticateProductionRealtimeWebhook, flushProductionRealtimeState, readProductionRealtimeState } from './productionRealtimeState';
import { normalizeVoxWebhookEvent } from './voxCallOutcome';
import { recordVoiceCallConnected } from './voiceCallSession';

const terminal = new Set(['disconnected', 'failed', 'busy', 'no_answer', 'cancelled']);

export async function handleProductionRealtimeWebhook(req: Request, res: Response,
  processEvent: (payload: Record<string, unknown>) => Promise<void>): Promise<void> {
  const payload = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const callId = String(payload.call_id ?? '');
  const state = await readProductionRealtimeState(callId);
  if (!state || !authenticateProductionRealtimeWebhook(state, req.get('X-Realtime-Webhook-Token'))) {
    res.status(403).json({ error: 'Invalid realtime lifecycle authentication.' }); return;
  }
  const event = normalizeVoxWebhookEvent(payload.event);
  if (state.snapshot.endedAt && !terminal.has(event)) { res.status(200).end(); return; }
  const at = typeof payload.ts === 'string' ? payload.ts : new Date().toISOString();
  if (typeof payload.connected_at === 'string') updateProductionRealtimeLifecycle(callId, 'connected', payload.connected_at);
  if (terminal.has(event)) await finishProductionCallPlanTelephony(callId, event, at);
  else {
    updateProductionRealtimeLifecycle(callId, event, at);
    await flushProductionRealtimeState(callId);
  }
  // recording_started may arrive after connected, or a retried final event may
  // arrive first. Persist actual answer/recording evidence before finalization.
  if (typeof payload.connected_at === 'string') {
    await recordVoiceCallConnected({ call_id: callId, to: state.snapshot.phone, ts: payload.connected_at });
  }
  if (payload.recording_started === true) {
    await prisma.voiceCallSession.updateMany({
      where: { callId, recordingStatus: null }, data: { recordingStatus: 'pending' },
    });
  }
  const current = await readProductionRealtimeState(callId) ?? state;
  // Ack only after durable state and answer/recording evidence are saved, so
  // transient persistence errors receive 500 and Vox retries delivery. Never
  // wait for audio download, retranscription or report generation here.
  res.status(200).end();
  await processEvent({ ...payload, to: state.snapshot.phone, transcript: current.snapshot.transcript,
    ivr: payload.ivr === true || current.snapshot.ivrDetected,
    ivr_path: Array.isArray(payload.ivr_path) && payload.ivr_path.length ? payload.ivr_path : current.snapshot.ivrPath });
}
