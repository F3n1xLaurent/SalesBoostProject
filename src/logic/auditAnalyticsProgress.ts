import { AsyncLocalStorage } from 'node:async_hooks';
import { analyticsQueue } from './analyticsQueue';

export type AnalyticsStage = 'transcription' | 'evaluation' | 'report';
export type AuditAnalyticsProgress = {
  stage: AnalyticsStage;
  status: 'waiting' | 'processing' | 'ready' | 'failed' | 'unavailable';
  transcriptReady: boolean;
  evaluationReady: boolean;
  message: string;
  startedAt?: string;
  waitingForSlot?: boolean;
  queuePosition?: number;
};
const context = new AsyncLocalStorage<{ key: string; token: symbol }>();
const active = new Map<string, { stage: AnalyticsStage; token: symbol; queuedAt: number; startedAt?: number }>();
const backfills = new Map<string, { status: 'processing' | 'failed' | 'done'; updatedAt: number }>();
const failures = new Map<string, { stage: AnalyticsStage; updatedAt: number }>();
const RETENTION_MS = 30 * 60_000;
export function currentAuditAnalyticsKey(): string | undefined { return context.getStore()?.key; }
export const AUDIT_ANALYTICS_RETRY_AFTER_MS = 2 * 60_000;

/** A superseded worker may finish its network request, but must not publish its result. */
export function assertAuditAnalyticsCurrent() {
  const current = context.getStore();
  if (current && active.get(current.key)?.token !== current.token) throw new Error('AUDIT_ANALYTICS_SUPERSEDED');
}

/** Track real work without saving intermediate evaluations as final reports. */
export async function withAuditAnalyticsProgress<T>(key: string, stage: AnalyticsStage, task: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (parent?.key === key) assertAuditAnalyticsCurrent();
  if (parent?.key === key && active.get(key)?.token === parent.token) {
    updateAuditAnalyticsStage(stage);
    return task();
  }
  const state: { stage: AnalyticsStage; token: symbol; queuedAt: number; startedAt?: number } = { stage, token: Symbol(key), queuedAt: Date.now() };
  failures.delete(key);
  active.set(key, state);
  try { return await analyticsQueue.run(key, () => {
    if (active.get(key) !== state) throw new Error('AUDIT_ANALYTICS_SUPERSEDED');
    state.startedAt = Date.now();
    return context.run({ key, token: state.token }, task);
  }); }
  catch (error) {
    if (active.get(key) === state) {
      if (failures.size >= 1000) failures.delete(failures.keys().next().value!);
      failures.set(key, { stage: state.stage, updatedAt: Date.now() });
    }
    throw error;
  }
  finally { if (active.get(key) === state) active.delete(key); }
}

export function updateAuditAnalyticsStage(stage: AnalyticsStage) {
  const current = context.getStore();
  const state = current && active.get(current.key);
  if (state && state.token === current?.token) state.stage = stage;
}

/** Repeated status reads must never start parallel paid repairs or retry a failed repair in a loop. */
export function scheduleAuditReportBackfill(key: string, task: () => Promise<void>, options: { retry?: boolean; stage?: AnalyticsStage } = {}): boolean {
  const now = Date.now();
  for (const [id, job] of backfills) if (job.status !== 'processing' && now - job.updatedAt > RETENTION_MS) backfills.delete(id);
  const running = active.get(key);
  // Both queued and executing workers own this key until they settle. A report
  // legitimately takes longer than the UI's two-minute retry hint; replacing
  // its token would discard the result and collide with its durable DB job.
  if (running) return false;
  const startedAt = backfills.get(key)?.updatedAt;
  const expired = options.retry && startedAt != null && now - startedAt >= AUDIT_ANALYTICS_RETRY_AFTER_MS;
  if (backfills.get(key)?.status === 'processing' && !expired) return false;
  if (options.retry) backfills.delete(key);
  if (backfills.has(key) || backfills.size >= 1000) return false;
  const job = { status: 'processing' as 'processing' | 'failed' | 'done', updatedAt: now };
  backfills.set(key, job);
  void withAuditAnalyticsProgress(key, options.stage ?? 'report', task).then(() => {
    job.status = 'done'; job.updatedAt = Date.now();
  }, (error) => {
    job.status = 'failed'; job.updatedAt = Date.now();
    console.warn('[audit-report] background generation failed:', error instanceof Error ? error.message : error);
  });
  return true;
}

export function auditAnalyticsProgress(input: {
  key: string; transcriptReady: boolean; evaluationReady: boolean; reportReady: boolean;
  failureReason?: string | null; unavailable?: boolean;
  startedAt?: Date | null;
}): AuditAnalyticsProgress {
  const current = active.get(input.key);
  const runningStage = current?.stage;
  const failure = failures.get(input.key);
  if (failure && Date.now() - failure.updatedAt > RETENTION_MS) failures.delete(input.key);
  const transcriptReady = runningStage === 'transcription' ? false : input.transcriptReady || runningStage === 'evaluation' || runningStage === 'report';
  const evaluationReady = input.evaluationReady || runningStage === 'report';
  const stage = runningStage ?? failures.get(input.key)?.stage ?? (!transcriptReady ? 'transcription' : !evaluationReady ? 'evaluation' : 'report');
  const startedAt = active.get(input.key)?.startedAt ?? backfills.get(input.key)?.updatedAt ?? input.startedAt?.getTime();
  const base = { stage, transcriptReady, evaluationReady, ...(startedAt != null ? { startedAt: new Date(startedAt).toISOString() } : {}) };
  if (input.reportReady) return { ...base, stage: 'report', status: 'ready', transcriptReady: true, evaluationReady: true, message: 'Отчёт готов.' };
  if (current && current.startedAt == null) return { ...base, status: 'waiting', waitingForSlot: true,
    queuePosition: analyticsQueue.position(input.key), message: 'Отчёт в очереди на обработку. Он появится автоматически.' };
  if (runningStage) return { ...base, status: 'processing', message: 'Анализируем разговор. Отчёт появится здесь автоматически.' };
  if (input.unavailable) return { ...base, status: 'unavailable', message: 'Разговор не состоялся. Аналитика для этого звонка не формируется.' };
  if (input.failureReason || failures.has(input.key) || backfills.get(input.key)?.status === 'failed') return { ...base, status: 'failed', message: 'Не удалось завершить подготовку аналитики. Можно запросить отчёт повторно.' };
  return { ...base, status: 'waiting', message: 'Ожидаем данные для следующего этапа. Статус обновляется автоматически.' };
}
