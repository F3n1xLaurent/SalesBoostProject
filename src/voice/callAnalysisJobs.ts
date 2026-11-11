import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import { withCostContext } from '../economics/costContext';
import type { VoxWebhookPayload } from './voiceCallSession';

export async function saveCallAnalysisJob(callId: string, payload: VoxWebhookPayload, restart: boolean, db = prisma) {
  const existing = await db.callAnalysisJob.findUnique({ where: { callId } });
  if (existing && !restart) return ['done', 'failed'].includes(existing.status) ? null : existing;
  const data = { runId: randomUUID(), payloadJson: JSON.stringify({ ...payload, call_id: callId }), status: 'queued',
    queuedAt: new Date(), startedAt: null, finishedAt: null };
  return db.callAnalysisJob.upsert({ where: { callId }, create: { callId, ...data }, update: data });
}

export async function runCallAnalysisJob(job: { callId: string; runId: string }, task: () => Promise<void>, db = prisma) {
  const where = { callId: job.callId, runId: job.runId };
  const claimed = await db.callAnalysisJob.updateMany({ where: { ...where, status: 'queued' },
    data: { status: 'processing', startedAt: new Date() } });
  if (!claimed.count) return;
  try {
    await task();
    await db.callAnalysisJob.updateMany({ where, data: { status: 'done', finishedAt: new Date(), payloadJson: '{}' } });
  } catch (error) {
    await db.callAnalysisJob.updateMany({ where, data: { status: 'failed', finishedAt: new Date(), payloadJson: '{}' } });
    throw error;
  }
}

let started = false;
/** Only one app process may own this SQLite-backed recovery scheduler. */
export function startCallAnalysisRecovery(
  finalize: (payload: VoxWebhookPayload) => Promise<void>, isActive: (callId: string) => boolean,
  db = prisma,
) {
  if (started) return;
  started = true;
  let scanning = false;
  let stopped = false;
  const scan = async () => {
    if (scanning || stopped) return;
    scanning = true;
    try {
      const jobs = await db.callAnalysisJob.findMany({ where: { status: 'queued' }, orderBy: { queuedAt: 'asc' }, take: 50 });
      for (const job of jobs) {
        if (stopped || isActive(job.callId)) continue;
        const finish = (status: string) => db.callAnalysisJob.updateMany({
          where: { callId: job.callId, runId: job.runId, status: 'queued' },
          data: { status, finishedAt: new Date(), payloadJson: '{}' },
        });
        let payload: VoxWebhookPayload;
        try {
          payload = JSON.parse(job.payloadJson);
          if (!payload || payload.call_id !== job.callId) throw new Error('Invalid queued call payload');
        } catch {
          await finish('failed');
          continue;
        }
        void withCostContext({ entityType: 'voice_call', entityId: job.callId, stage: 'call_processing' },
          () => finalize(payload)).then(() => finish('done'), () => {
          console.warn('[analytics-queue] recovered call failed', { callId: job.callId });
          return finish('failed');
        }).catch(error => console.error('[analytics-queue] recovery persistence failed', error));
      }
    } finally { scanning = false; }
  };
  // Restore only unfinished work. Terminal failures require an explicit retry.
  const ready = db.callAnalysisJob.updateMany({ where: { status: 'processing' }, data: { status: 'queued', startedAt: null } })
    .then(scan).catch(error => console.error('[analytics-queue] startup recovery failed', error));
  const timer = setInterval(() => { void scan().catch(error => console.error('[analytics-queue] scan failed', error)); }, 10_000);
  timer.unref();
  return { ready, stop: () => { stopped = true; clearInterval(timer); started = false; } };
}
