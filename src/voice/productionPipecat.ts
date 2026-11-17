import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import { config } from '../config';
import type { RealtimeTestPlanConfiguration } from './callSettingsManagement';
import { recordVoiceCallConnected } from './voiceCallSession';

export const PIPECAT_PROFILE = Object.freeze({ provider: 'openai', model: 'gpt-realtime-2.1',
  ttsModel: 'eleven_v4_turbo', dialogueMode: 'semantic', backchannel: true,
  reasoningEffort: 'low', trimIdleAudio: false });
export const PIPECAT_STATE_ROOT = path.resolve('storage/voice-pipecat');
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(id);
const terminal = new Set(['disconnected', 'failed', 'busy', 'no_answer', 'cancelled']);
export class PipecatCapacityError extends Error {}
export class PipecatLaunchUncertainError extends Error {}
export type PipecatSnapshot = {
  callId: string; diagnosticId: string; to: string; status: string; finalized: boolean;
  createdAt: string; connectedAt: string | null; endedAt: string | null;
  voxSessionId: number | string | null; recordingStarted: boolean; failureReason: string | null;
  transcript: Array<{ role: 'client' | 'manager'; text: string }>;
  profile: Record<string, unknown>; metrics: unknown[]; usage?: unknown[]; callState?: unknown;
  ivrDetected?: boolean; ivrPath?: string[]; lineState?: string; lineTerminalReason?: string;
};

export async function pipecatRequest<T>(route: string, body?: unknown): Promise<T> {
  const base = process.env.PIPECAT_HYPOTHESIS_URL?.replace(/\/$/u, '');
  const token = process.env.PIPECAT_HYPOTHESIS_TOKEN;
  if (!base || !token || token.length < 32) throw new Error('Не настроено подключение к Pipecat.');
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(body === undefined ? 12_000 : 180_000),
  });
  if (response.status === 429) { await response.text(); throw new PipecatCapacityError('Pipecat занят; звонок ожидает свободный слот.'); }
  if (!response.ok) throw new Error(`Pipecat HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json() as Promise<T>;
}

export async function savePipecatState(snapshot: PipecatSnapshot, root = PIPECAT_STATE_ROOT): Promise<void> {
  if (!validId(snapshot.callId)) throw new Error('Invalid Pipecat call ID');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, snapshot.callId + '.json');
  const temporary = target + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  await fs.rename(temporary, target);
}

export async function readPipecatState(id: string, root = PIPECAT_STATE_ROOT): Promise<PipecatSnapshot | null> {
  if (!validId(id)) return null;
  try { const s = JSON.parse(await fs.readFile(path.join(root, id + '.json'), 'utf8'));
    return s.callId === id && Array.isArray(s.transcript) ? s : null;
  } catch { return null; }
}

export async function prepareProductionPipecatCall(callId: string, phone: string, plan: RealtimeTestPlanConfiguration) {
  const voiceId = plan.elevenLabsVoiceId || config.elevenLabsVoiceId;
  if (!voiceId) throw new Error('В профиле плана не задан голос ElevenLabs.');
  const prepared = await pipecatRequest<PipecatSnapshot>('/production/sessions', {
    callId, to: '+' + phone.replace(/\D/g, ''), voiceId, prompt: plan.prompt,
    context: { planId: plan.planId, planName: plan.planName, subjectTitle: plan.subjectTitle,
      subjectDescription: plan.subjectDescription, customerNeed: plan.customerNeed ?? null, companyName: plan.companyName ?? null },
  });
  if (prepared.callId !== callId || prepared.status !== 'prepared') throw new Error('Pipecat не подтвердил подготовку нового звонка.');
  await savePipecatState(prepared);
  return { voiceId, diagnosticId: prepared.diagnosticId,
    start: async () => {
      // No retries or alternate dialer: an HTTP timeout may follow a successful
      // PSTN start. The recovery worker resolves that same call ID instead.
      let snapshot: PipecatSnapshot;
      try { snapshot = await pipecatRequest<PipecatSnapshot>(`/production/sessions/${callId}/start`, {}); }
      catch { throw new PipecatLaunchUncertainError('Ответ запуска Pipecat потерян; состояние проверит обработчик восстановления. Повторный набор запрещён.'); }
      await savePipecatState(snapshot);
      if (snapshot.callId !== callId) throw new PipecatLaunchUncertainError('Pipecat call ID mismatch');
      return { callId, scenario: 'pipecat' as const, startedAt: snapshot.createdAt,
        callSessionHistoryId: snapshot.voxSessionId ? Number(snapshot.voxSessionId) : null };
    },
    dispose: async () => { await pipecatRequest(`/production/sessions/${callId}/discard`, {}); },
  };
}

type ProcessEvent = (payload: Record<string, unknown>) => Promise<void>;
let polling = false;
const heartbeat = new Map<string, number>();

/** DB is the recovery queue. Completed reports use the existing idempotent
 * finalizer/analysis jobs. This worker NEVER prepares or starts a call. */
export async function syncProductionPipecatCalls(processEvent: ProcessEvent): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const rows = await prisma.voiceCallSession.findMany({
      where: { scenario: 'pipecat', endedAt: null }, orderBy: { startedAt: 'asc' }, take: 100,
      select: { callId: true, startedAt: true, connectedAt: true, caseContextJson: true },
    });
    for (let offset = 0; offset < rows.length; offset += 4) {
      await Promise.all(rows.slice(offset, offset + 4).map(async row => {
        try {
          let snapshot: PipecatSnapshot;
          try { snapshot = await pipecatRequest<PipecatSnapshot>(`/production/sessions/${row.callId}`); }
          catch (error) {
            // A bounded watchdog covers a lost service/expired preparation.
            // Never replace an unknown launch with another actual PSTN call.
            if (Date.now() - row.startedAt.getTime() < 35 * 60_000) throw error;
            const saved = await readPipecatState(row.callId);
            if (!saved) throw error;
            snapshot = { ...saved, status: 'failed', finalized: true, endedAt: new Date().toISOString(), failureReason: 'pipecat_recovery_timeout' };
          }
          if (snapshot.callId !== row.callId) throw new Error('Pipecat call ID mismatch');
          if (snapshot.status === 'prepared' && Date.now() - row.startedAt.getTime() > 3 * 60_000) {
            await pipecatRequest(`/production/sessions/${row.callId}/discard`, {});
            snapshot = { ...snapshot, status: 'cancelled', finalized: true, endedAt: new Date().toISOString(), failureReason: 'prepared_call_never_started' };
          }
          await savePipecatState(snapshot);
          const context = JSON.parse(row.caseContextJson || '{}');
          await prisma.voiceCallSession.updateMany({ where: { callId: row.callId, endedAt: null }, data: {
            caseContextJson: JSON.stringify({ ...context, pipecat: { diagnosticId: snapshot.diagnosticId,
              profile: snapshot.profile, metrics: snapshot.metrics, usage: snapshot.usage, callState: snapshot.callState,
              lineState: snapshot.lineState, lineTerminalReason: snapshot.lineTerminalReason } }),
            ...(snapshot.ivrDetected ? { ivrDetected: true } : {}),
            ...(snapshot.ivrPath?.length ? { ivrPathJson: JSON.stringify(snapshot.ivrPath) } : {}),
            ...(snapshot.voxSessionId ? { voxSessionId: String(snapshot.voxSessionId) } : {}),
            ...(snapshot.recordingStarted ? { recordingStatus: 'pending' } : {}),
          } });
          if (snapshot.connectedAt && !row.connectedAt) {
            await recordVoiceCallConnected({ call_id: row.callId, to: snapshot.to, ts: snapshot.connectedAt });
          }
          const payload = { call_id: row.callId, to: snapshot.to, vox_session_id: snapshot.voxSessionId,
            recording_started: snapshot.recordingStarted, transcript: snapshot.transcript,
            ivr: snapshot.ivrDetected === true, ivr_path: snapshot.ivrPath || [],
            details: { reason: snapshot.failureReason || undefined } };
          if (terminal.has(snapshot.status) && snapshot.finalized) {
            await processEvent({ ...payload, event: snapshot.status, ts: snapshot.endedAt || new Date().toISOString() });
            heartbeat.delete(row.callId);
          } else if (Date.now() - (heartbeat.get(row.callId) || 0) >= 30_000) {
            heartbeat.set(row.callId, Date.now());
            await processEvent({ ...payload, event: 'progress' });
          }
        } catch (error) { console.error('[voice/pipecat] synchronization failed', { callId: row.callId, error: error instanceof Error ? error.message : String(error) }); }
      }));
    }
  } finally { polling = false; }
}

export async function recoverPipecatQueueClaims(bootAt: number, now = Date.now()): Promise<void> {
  // Only placeholders from BEFORE this backend boot can be returned to the
  // queue. A real UUID always has its VoiceCallSession persisted before dial.
  const abandoned = await prisma.callPlanCall.findMany({ where: { status: 'running', endedAt: null,
    startedAt: { gte: new Date(bootAt - 35 * 60_000), lt: new Date(Math.min(bootAt, now - 180_000)) },
    OR: [{ callId: { startsWith: 'manual-pipecat-' } }, { callId: { startsWith: 'scheduled:' } }],
  }, select: { id: true, callId: true }, take: 100 });
  for (const row of abandoned) {
    const session = await prisma.voiceCallSession.findUnique({ where: { callId: row.callId }, select: { callId: true } });
    if (!session) await prisma.callPlanCall.updateMany({ where: { id: row.id, callId: row.callId, status: 'running', endedAt: null },
      data: { status: 'scheduled', failureReason: null } });
  }
}

export function startProductionPipecatRecovery(processEvent: ProcessEvent): NodeJS.Timeout {
  const bootAt = Date.now();let lastClaimsCheck = 0;
  const run = () => { void (async () => {
    if (Date.now() - lastClaimsCheck > 30_000) { lastClaimsCheck = Date.now(); await recoverPipecatQueueClaims(bootAt); }
    await syncProductionPipecatCalls(processEvent);
  })().catch(error => console.error('[voice/pipecat] recovery failed', String(error))); };
  run();
  const timer = setInterval(run, 2_000);timer.unref();return timer;
}
