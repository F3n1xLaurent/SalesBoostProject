import { prisma } from '../db';
import { addCall, setVoxSessionId } from './callHistory';
import { startVoiceCall, type VoiceCallScenario } from './startVoiceCall';
import type { VoxWebhookPayload } from './voiceCallSession';
import { listDealershipCallTargets } from './dealershipCallSource';

type BatchStatus = 'running' | 'paused' | 'cancelled' | 'completed';
type JobStatus = 'queued' | 'dialing' | 'in_progress' | 'retry_wait' | 'completed' | 'failed' | 'cancelled';

export type BatchMode = 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily';

export type BatchJobInput = {
  phone: string;
  dealershipId?: string | null;
  dealershipName?: string | null;
  plannedAt?: Date | string | null;
};

export type CreateCallBatchInput = {
  mode?: BatchMode;
  title?: string;
  jobs: BatchJobInput[];
  maxConcurrency?: number;
  startIntervalMs?: number;
  maxAttempts?: number;
  scenario?: VoiceCallScenario;
  testMode?: boolean;
};

const TICK_MS = 1000;
const DEFAULT_SCENARIO: VoiceCallScenario = 'realtime_pure';
const RETRIABLE_OUTCOMES = new Set(['busy', 'no_answer', 'failed']);
const nextDispatchAtByBatch = new Map<string, number>();
const batchRuntimeConfig = new Map<string, { scenario: VoiceCallScenario; testMode: boolean }>();
let lastAutoDailyKey: string | null = null;

let timer: NodeJS.Timeout | null = null;
let tickInFlight = false;

function now(): Date {
  return new Date();
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizePhone(v: string): string {
  const digits = String(v || '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

function isRetriableOutcome(outcome: string): boolean {
  return RETRIABLE_OUTCOMES.has(outcome);
}

function retryDelayMs(attempt: number): number {
  if (attempt <= 1) return 30_000;
  if (attempt === 2) return 90_000;
  return 240_000;
}

function normalizeWebhookOutcome(event: string | undefined): string {
  if (!event) return 'disconnected';
  const normalizedEvent = String(event).trim().toLowerCase();
  if (normalizedEvent === 'busy' || normalizedEvent === 'no_answer' || normalizedEvent === 'failed') return normalizedEvent;
  if (
    normalizedEvent === 'disconnected' ||
    normalizedEvent === 'hangup' ||
    normalizedEvent === 'disconnect' ||
    normalizedEvent === 'completed' ||
    normalizedEvent === 'ended'
  ) {
    return 'disconnected';
  }
  return 'disconnected';
}

function asAuditIdFromVoiceSession(sessionId: number): string {
  return `call-${sessionId}`;
}

function isGlobalTestMode(): boolean {
  return process.env.CALL_BATCH_TEST_MODE === 'true' || process.env.CALL_BATCH_TEST_MODE === '1';
}

function timeoutMs(): number {
  const v = Number(process.env.CALL_BATCH_STUCK_TIMEOUT_MS || 6 * 60 * 1000);
  return Number.isFinite(v) && v >= 30_000 ? v : 6 * 60 * 1000;
}

function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function randomInt(minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(Math.random() * (maxInclusive - minInclusive + 1));
}

function randomTimesInWorkingWindow(baseDay: Date, startHour: number, endHour: number, count: number): Date[] {
  const s = Math.max(0, Math.min(23, startHour));
  const e = Math.max(s + 1, Math.min(23, endHour));
  const minMinute = s * 60;
  const maxMinute = e * 60 - 1;
  const picks = new Set<number>();
  while (picks.size < count) {
    picks.add(randomInt(minMinute, maxMinute));
  }
  const out = [...picks]
    .sort((a, b) => a - b)
    .map((m) => {
      const h = Math.floor(m / 60);
      const mm = m % 60;
      const dt = new Date(baseDay);
      dt.setHours(h, mm, randomInt(0, 59), 0);
      return dt;
    });
  return out;
}

async function recomputeBatchCounters(batchId: string): Promise<void> {
  const jobs = await prisma.callBatchJob.findMany({
    where: { batchId },
    select: { status: true },
  });
  const counts = {
    totalJobs: jobs.length,
    queuedJobs: 0,
    inProgressJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    cancelledJobs: 0,
    retryingJobs: 0,
  };

  for (const j of jobs) {
    if (j.status === 'queued') counts.queuedJobs += 1;
    else if (j.status === 'retry_wait') counts.retryingJobs += 1;
    else if (j.status === 'dialing' || j.status === 'in_progress') counts.inProgressJobs += 1;
    else if (j.status === 'completed') counts.completedJobs += 1;
    else if (j.status === 'failed') counts.failedJobs += 1;
    else if (j.status === 'cancelled') counts.cancelledJobs += 1;
  }

  const batch = await prisma.callBatch.findUnique({
    where: { id: batchId },
    select: { status: true, finishedAt: true, startedAt: true },
  });
  if (!batch) return;

  const noActive = counts.queuedJobs + counts.retryingJobs + counts.inProgressJobs === 0;
  const shouldFinish = batch.status !== 'cancelled' && noActive;

  await prisma.callBatch.update({
    where: { id: batchId },
    data: {
      ...counts,
      startedAt: batch.status === 'running' && !batch.startedAt ? now() : batch.startedAt,
      status: shouldFinish ? 'completed' : batch.status,
      finishedAt: shouldFinish ? now() : batch.finishedAt,
    },
  });
}

async function markJobFailedOrRetry(jobId: string, outcome: string, errorText: string): Promise<void> {
  const job = await prisma.callBatchJob.findUnique({
    where: { id: jobId },
    include: { batch: true },
  });
  if (!job) return;

  const canRetry = isRetriableOutcome(outcome) && job.attempt < job.maxAttempts && job.batch.status === 'running';
  if (canRetry) {
    await prisma.callBatchJob.update({
      where: { id: job.id },
      data: {
        status: 'retry_wait',
        nextRunAt: new Date(Date.now() + retryDelayMs(job.attempt)),
        lastError: errorText,
        lastOutcome: outcome,
      },
    });
  } else {
    await prisma.callBatchJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        endedAt: now(),
        lastError: errorText,
        lastOutcome: outcome,
      },
    });
  }
  await recomputeBatchCounters(job.batchId);
}

async function syncLinkedAuditByCallId(jobId: string, callId: string, fallbackReason = 'no_call_review_yet'): Promise<void> {
  if (!callId) return;
  const session = await prisma.voiceCallSession.findUnique({
    where: { callId },
    select: { id: true, transcriptJson: true, evaluationJson: true },
  });
  if (!session) {
    await prisma.callBatchJob.update({
      where: { id: jobId },
      data: {
        linkedAuditId: null,
        linkReason: fallbackReason,
      },
    });
    return;
  }
  const hasTranscript = !!session.transcriptJson;
  const hasEvaluation = !!session.evaluationJson;
  await prisma.callBatchJob.update({
    where: { id: jobId },
    data: {
      linkedAuditId: asAuditIdFromVoiceSession(session.id),
      linkReason: hasTranscript || hasEvaluation ? null : 'no_call_review_yet',
    },
  });
}

async function dispatchOneJob(batchId: string, scenario: VoiceCallScenario): Promise<boolean> {
  const batch = await prisma.callBatch.findUnique({
    where: { id: batchId },
    select: { id: true, status: true, maxConcurrency: true, startIntervalMs: true },
  });
  if (!batch || batch.status !== 'running') return false;

  const active = await prisma.callBatchJob.count({
    where: {
      batchId,
      status: { in: ['dialing', 'in_progress'] },
    },
  });
  if (active >= batch.maxConcurrency) return false;

  const nextAllowedAt = nextDispatchAtByBatch.get(batchId) ?? 0;
  if (Date.now() < nextAllowedAt) return false;

  const job = await prisma.callBatchJob.findFirst({
    where: {
      batchId,
      status: { in: ['queued', 'retry_wait'] },
      nextRunAt: { lte: now() },
    },
    orderBy: [{ nextRunAt: 'asc' }, { queuedAt: 'asc' }],
  });
  if (!job) return false;

  const updated = await prisma.callBatchJob.updateMany({
    where: {
      id: job.id,
      status: { in: ['queued', 'retry_wait'] },
    },
    data: {
      status: 'dialing',
      attempt: { increment: 1 },
      startedAt: job.startedAt ?? now(),
      lastError: null,
    },
  });
  if (updated.count === 0) return false;

  const fresh = await prisma.callBatchJob.findUnique({ where: { id: job.id } });
  if (!fresh) return false;

  nextDispatchAtByBatch.set(batchId, Date.now() + Math.max(100, batch.startIntervalMs));

  const runtime = batchRuntimeConfig.get(batchId);
  const testMode = runtime?.testMode ?? isGlobalTestMode();
  if (testMode) {
    const fakeCallId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await prisma.callBatchAttempt.create({
      data: {
        jobId: fresh.id,
        attempt: fresh.attempt,
        voiceCallId: fakeCallId,
        status: 'dialing',
      },
    });
    await prisma.callBatchJob.update({
      where: { id: fresh.id },
      data: {
        status: 'in_progress',
        lastVoiceCallId: fakeCallId,
        lastOutcome: null,
        lastError: null,
      },
    });
    // Simulate webhook completion so end-to-end flow is testable locally without real calls.
    const delayMs = 4_000 + Math.round(Math.random() * 9_000);
    setTimeout(() => {
      const outcomes = ['disconnected', 'disconnected', 'disconnected', 'busy', 'no_answer'];
      const event = outcomes[Math.floor(Math.random() * outcomes.length)] as 'disconnected' | 'busy' | 'no_answer';
      onVoxBatchWebhook({ call_id: fakeCallId, event }).catch(() => {});
    }, delayMs);
    await recomputeBatchCounters(batchId);
    return true;
  }

  const result = await startVoiceCall(fresh.phone, { scenario });
  if ('error' in result) {
    await markJobFailedOrRetry(fresh.id, 'failed', result.error);
    return true;
  }

  addCall(result.callId, fresh.phone);
  if (result.callSessionHistoryId) {
    setVoxSessionId(result.callId, result.callSessionHistoryId);
  }
  await prisma.callBatchAttempt.create({
    data: {
      jobId: fresh.id,
      attempt: fresh.attempt,
      voiceCallId: result.callId,
      status: 'dialing',
    },
  });
  await prisma.callBatchJob.update({
    where: { id: fresh.id },
    data: {
      status: 'in_progress',
      lastVoiceCallId: result.callId,
      lastOutcome: null,
      lastError: null,
    },
  });
  await recomputeBatchCounters(batchId);
  return true;
}

async function processTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await prisma.callBatchJob.updateMany({
      where: {
        status: 'retry_wait',
        nextRunAt: { lte: now() },
      },
      data: { status: 'queued' },
    });

    await maybeCreateAutoDailyBatch();

    await reapStuckInProgressJobs();

    const runningBatches = await prisma.callBatch.findMany({
      where: { status: 'running' },
      select: { id: true },
    });
    for (const b of runningBatches) {
      const runtime = batchRuntimeConfig.get(b.id);
      const scenario = runtime?.scenario || ((process.env.CALL_BATCH_SCENARIO as VoiceCallScenario) || DEFAULT_SCENARIO);
      // Try to dispatch several jobs per tick for this batch.
      // The internal cadence check ensures we do not exceed startIntervalMs.
      for (let i = 0; i < 10; i += 1) {
        const dispatched = await dispatchOneJob(b.id, scenario);
        if (!dispatched) break;
      }
      await recomputeBatchCounters(b.id);
    }
  } catch (err) {
    console.error('[call-batch] tick error:', err instanceof Error ? err.message : err);
  } finally {
    tickInFlight = false;
  }
}

async function reapStuckInProgressJobs(): Promise<void> {
  const staleBefore = new Date(Date.now() - timeoutMs());
  const staleJobs = await prisma.callBatchJob.findMany({
    where: {
      status: 'in_progress',
      updatedAt: { lt: staleBefore },
    },
    select: { id: true },
    take: 200,
  });
  if (staleJobs.length === 0) return;

  for (const j of staleJobs) {
    await prisma.callBatchAttempt.updateMany({
      where: { jobId: j.id, status: 'dialing' },
      data: {
        status: 'ended',
        outcome: 'failed',
        error: 'Call completion timeout',
        endedAt: now(),
      },
    });
    await markJobFailedOrRetry(j.id, 'failed', 'Превышен таймаут ожидания завершения звонка');
  }
}

async function maybeCreateAutoDailyBatch(): Promise<void> {
  const enabled = process.env.AUTO_DAILY_CALLS_ENABLED === 'true' || process.env.AUTO_DAILY_CALLS_ENABLED === '1';
  if (!enabled) return;

  const today = new Date();
  const dayKey = toDayKey(today);
  if (lastAutoDailyKey === dayKey) return;

  const existing = await prisma.callBatch.count({
    where: {
      mode: 'auto_daily',
      createdAt: {
        gte: new Date(`${dayKey}T00:00:00.000Z`),
        lt: new Date(`${dayKey}T23:59:59.999Z`),
      },
    },
  });
  if (existing > 0) {
    lastAutoDailyKey = dayKey;
    return;
  }

  const dealerships = listDealershipCallTargets();
  if (dealerships.length === 0) return;

  const jobs: BatchJobInput[] = [];
  for (const d of dealerships) {
    const callTimes = randomTimesInWorkingWindow(today, d.workStartHour, d.workEndHour, 3);
    for (const plannedAt of callTimes) {
      jobs.push({
        dealershipId: d.dealershipId,
        dealershipName: d.dealershipName,
        phone: d.phone,
        plannedAt,
      });
    }
  }

  if (jobs.length === 0) return;

  await createCallBatch({
    mode: 'auto_daily',
    title: `Авто-проверка ${dayKey}`,
    jobs,
    maxConcurrency: Math.min(Math.max(Number(process.env.AUTO_DAILY_MAX_CONCURRENCY || '10'), 1), 50),
    startIntervalMs: Math.min(Math.max(Number(process.env.AUTO_DAILY_START_INTERVAL_MS || '500'), 100), 60_000),
    maxAttempts: 3,
  });
  lastAutoDailyKey = dayKey;
}

export function startCallBatchOrchestrator(): void {
  if (timer) return;
  timer = setInterval(() => {
    processTick().catch((err) => {
      console.error('[call-batch] background tick failed:', err instanceof Error ? err.message : err);
    });
  }, TICK_MS);
}

export function stopCallBatchOrchestrator(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export async function createCallBatch(input: CreateCallBatchInput): Promise<{ batchId: string; totalJobs: number }> {
  const testMode = !!input.testMode || isGlobalTestMode();
  const normalizedJobs = input.jobs
    .map((j) => ({
      phone: normalizePhone(j.phone) || (testMode ? '+70000000000' : ''),
      dealershipId: j.dealershipId ?? null,
      dealershipName: j.dealershipName ?? null,
      plannedAt: j.plannedAt ? new Date(j.plannedAt) : null,
    }))
    .filter((j) => j.phone.length >= 10);

  if (normalizedJobs.length === 0) {
    throw new Error('Не передано ни одного валидного номера.');
  }

  const maxConcurrency = clamp(Number(input.maxConcurrency ?? 10), 1, 50);
  const startIntervalMs = clamp(Number(input.startIntervalMs ?? 250), 100, 60_000);
  const maxAttempts = clamp(Number(input.maxAttempts ?? 3), 1, 5);
  const mode: BatchMode = input.mode ?? 'manual';
  const title = input.title?.trim() || null;
  const scenario = input.scenario ?? ((process.env.CALL_BATCH_SCENARIO as VoiceCallScenario) || DEFAULT_SCENARIO);

  const isManualMode = mode === 'manual' || mode === 'single_dealership' || mode === 'all_dealerships';
  if (isManualMode) {
    const activeManual = await prisma.callBatch.count({
      where: {
        mode: { in: ['manual', 'single_dealership', 'all_dealerships'] },
        status: { in: ['running', 'paused'] },
      },
    });
    if (activeManual > 0) {
      throw new Error('Уже есть активная ручная проверка. Сначала завершите ее.');
    }
  }

  const batch = await prisma.callBatch.create({
    data: {
      mode,
      title,
      status: 'running',
      maxConcurrency,
      startIntervalMs,
      maxAttempts,
      totalJobs: normalizedJobs.length,
      queuedJobs: normalizedJobs.length,
      jobs: {
        create: normalizedJobs.map((j) => ({
          phone: j.phone,
          dealershipId: j.dealershipId,
          dealershipName: j.dealershipName,
          status: 'queued',
          maxAttempts,
          nextRunAt: j.plannedAt ?? now(),
        })),
      },
    },
  });

  batchRuntimeConfig.set(batch.id, {
    scenario,
    testMode,
  });

  return { batchId: batch.id, totalJobs: normalizedJobs.length };
}

export async function listCallBatches(limit: number, mode?: BatchMode | 'all'): Promise<Array<{
  id: string;
  mode: BatchMode;
  status: BatchStatus;
  title: string | null;
  totalJobs: number;
  queuedJobs: number;
  inProgressJobs: number;
  completedJobs: number;
  failedJobs: number;
  retryingJobs: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}>> {
  const rows = await prisma.callBatch.findMany({
    where: mode && mode !== 'all' ? { mode } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
  return rows.map((b) => ({
    id: b.id,
    mode: b.mode as BatchMode,
    status: b.status as BatchStatus,
    title: b.title,
    totalJobs: b.totalJobs,
    queuedJobs: b.queuedJobs,
    inProgressJobs: b.inProgressJobs,
    completedJobs: b.completedJobs,
    failedJobs: b.failedJobs,
    retryingJobs: b.retryingJobs,
    startedAt: b.startedAt ? b.startedAt.toISOString() : null,
    finishedAt: b.finishedAt ? b.finishedAt.toISOString() : null,
    createdAt: b.createdAt.toISOString(),
  }));
}

export async function getCallBatch(batchId: string): Promise<{
  batch: Awaited<ReturnType<typeof prisma.callBatch.findUnique>>;
  jobsPreview: Awaited<ReturnType<typeof prisma.callBatchJob.findMany>>;
  dealershipSummary: Array<{
    dealershipId: string | null;
    dealershipName: string;
    total: number;
    queued: number;
    inProgress: number;
    retrying: number;
    completed: number;
    failed: number;
    cancelled: number;
    status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'partial';
  }>;
}> {
  const batch = await prisma.callBatch.findUnique({
    where: { id: batchId },
  });
  if (!batch) {
    throw new Error('Батч не найден.');
  }
  const jobsPreview = await prisma.callBatchJob.findMany({
    where: { batchId },
    orderBy: [{ queuedAt: 'asc' }],
    take: 100,
  });
  const jobsForSummary = await prisma.callBatchJob.findMany({
    where: { batchId },
    select: {
      dealershipId: true,
      dealershipName: true,
      status: true,
    },
  });
  const summaryMap = new Map<string, {
    dealershipId: string | null;
    dealershipName: string;
    total: number;
    queued: number;
    inProgress: number;
    retrying: number;
    completed: number;
    failed: number;
    cancelled: number;
  }>();
  for (const j of jobsForSummary) {
    const key = `${j.dealershipId ?? 'none'}::${j.dealershipName ?? 'Автосалон'}`;
    if (!summaryMap.has(key)) {
      summaryMap.set(key, {
        dealershipId: j.dealershipId,
        dealershipName: j.dealershipName ?? 'Автосалон',
        total: 0,
        queued: 0,
        inProgress: 0,
        retrying: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      });
    }
    const item = summaryMap.get(key)!;
    item.total += 1;
    if (j.status === 'queued') item.queued += 1;
    else if (j.status === 'retry_wait') item.retrying += 1;
    else if (j.status === 'dialing' || j.status === 'in_progress') item.inProgress += 1;
    else if (j.status === 'completed') item.completed += 1;
    else if (j.status === 'failed') item.failed += 1;
    else if (j.status === 'cancelled') item.cancelled += 1;
  }
  const dealershipSummary = [...summaryMap.values()].map((s) => {
    let status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'partial' = 'queued';
    if (s.inProgress > 0 || s.retrying > 0) status = 'in_progress';
    else if (s.failed > 0 && s.completed > 0) status = 'partial';
    else if (s.failed > 0) status = 'failed';
    else if (s.completed === s.total) status = 'completed';
    else if (s.cancelled === s.total) status = 'cancelled';
    return { ...s, status };
  });
  return { batch, jobsPreview, dealershipSummary };
}

export async function getCallBatchJobs(batchId: string, limit: number, offset: number, status?: JobStatus): Promise<{
  jobs: any[];
  total: number;
}> {
  const where = {
    batchId,
    ...(status ? { status } : {}),
  };
  const [jobsRaw, total] = await Promise.all([
    prisma.callBatchJob.findMany({
      where,
      orderBy: [{ queuedAt: 'asc' }],
      take: limit,
      skip: offset,
    }),
    prisma.callBatchJob.count({ where }),
  ]);
  const callIds = [...new Set(jobsRaw.map((j) => j.lastVoiceCallId).filter((v): v is string => !!v))];
  const sessions = callIds.length
    ? await prisma.voiceCallSession.findMany({
        where: { callId: { in: callIds } },
        select: { id: true, callId: true, transcriptJson: true, evaluationJson: true },
      })
    : [];
  const sessionByCallId = new Map(sessions.map((s) => [s.callId, s]));

  // Opportunistic backfill for older jobs where link wasn't persisted yet.
  for (const j of jobsRaw) {
    if (j.linkedAuditId || !j.lastVoiceCallId) continue;
    const s = sessionByCallId.get(j.lastVoiceCallId);
    if (!s) continue;
    await prisma.callBatchJob.update({
      where: { id: j.id },
      data: {
        linkedAuditId: asAuditIdFromVoiceSession(s.id),
        linkReason: s.transcriptJson || s.evaluationJson ? null : 'no_call_review_yet',
      },
    });
    j.linkedAuditId = asAuditIdFromVoiceSession(s.id);
    j.linkReason = s.transcriptJson || s.evaluationJson ? null : 'no_call_review_yet';
  }

  const jobs = jobsRaw.map((j) => {
    const s = j.lastVoiceCallId ? sessionByCallId.get(j.lastVoiceCallId) : null;
    const hasTranscript = !!s?.transcriptJson;
    const linkedAuditId = j.linkedAuditId ?? (s ? asAuditIdFromVoiceSession(s.id) : null);
    const linkReason = j.linkReason ?? (!linkedAuditId ? 'no_linked_call' : null);
    return {
      ...j,
      hasTranscript,
      linkedAuditId,
      linkReason,
    };
  });

  return { jobs, total };
}

export async function pauseCallBatch(batchId: string): Promise<void> {
  await prisma.callBatch.update({
    where: { id: batchId },
    data: { status: 'paused' },
  });
}

export async function resumeCallBatch(batchId: string): Promise<void> {
  await prisma.callBatch.update({
    where: { id: batchId },
    data: { status: 'running' },
  });
}

export async function cancelCallBatch(batchId: string): Promise<void> {
  await prisma.callBatch.update({
    where: { id: batchId },
    data: { status: 'cancelled', finishedAt: now() },
  });
  await prisma.callBatchJob.updateMany({
    where: {
      batchId,
      status: { in: ['queued', 'retry_wait', 'dialing'] },
    },
    data: { status: 'cancelled', endedAt: now() },
  });
  await recomputeBatchCounters(batchId);
}

export async function onVoxBatchWebhook(payload: VoxWebhookPayload): Promise<void> {
  const callId = payload.call_id;
  if (!callId) return;

  const attempt = await prisma.callBatchAttempt.findUnique({
    where: { voiceCallId: callId },
    include: { job: true },
  });
  if (!attempt) return;

  if (attempt.status === 'ended') return;

  const outcome = normalizeWebhookOutcome(payload.event);
  await prisma.callBatchAttempt.update({
    where: { id: attempt.id },
    data: {
      status: 'ended',
      outcome,
      endedAt: now(),
    },
  });

  const job = await prisma.callBatchJob.findUnique({
    where: { id: attempt.jobId },
  });
  if (!job) return;
  if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') return;

  const canRetry = isRetriableOutcome(outcome) && job.attempt < job.maxAttempts;
  if (canRetry) {
    await prisma.callBatchJob.update({
      where: { id: job.id },
      data: {
        status: 'retry_wait',
        nextRunAt: new Date(Date.now() + retryDelayMs(job.attempt)),
        lastOutcome: outcome,
        lastError: `Vox outcome: ${outcome}`,
      },
    });
  } else {
    const finalStatus: JobStatus = outcome === 'busy' || outcome === 'no_answer' || outcome === 'failed'
      ? 'failed'
      : 'completed';
    await prisma.callBatchJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        endedAt: now(),
        lastOutcome: outcome,
      },
    });
    await syncLinkedAuditByCallId(job.id, callId, 'no_call_review_yet');
  }
  await recomputeBatchCounters(job.batchId);
}
