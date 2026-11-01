import { AsyncLocalStorage } from 'node:async_hooks';

export type AnalyticsStage = 'transcription' | 'evaluation' | 'report';
export type AuditAnalyticsProgress = {
  stage: AnalyticsStage;
  status: 'waiting' | 'processing' | 'ready' | 'failed' | 'unavailable';
  transcriptReady: boolean;
  evaluationReady: boolean;
  message: string;
};
const context = new AsyncLocalStorage<{ key: string; token: symbol }>();
const active = new Map<string, { stage: AnalyticsStage; token: symbol }>();
const backfills = new Map<string, { status: 'processing' | 'failed' | 'done'; updatedAt: number }>();
const failures = new Map<string, { stage: AnalyticsStage; updatedAt: number }>();
const RETENTION_MS = 30 * 60_000;

/** Track real work without saving intermediate evaluations as final reports. */
export async function withAuditAnalyticsProgress<T>(key: string, stage: AnalyticsStage, task: () => Promise<T>): Promise<T> {
  const state = { stage, token: Symbol(key) };
  failures.delete(key);
  active.set(key, state);
  try { return await context.run({ key, token: state.token }, task); }
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
export function scheduleAuditReportBackfill(key: string, task: () => Promise<void>): boolean {
  const now = Date.now();
  for (const [id, job] of backfills) if (job.status !== 'processing' && now - job.updatedAt > RETENTION_MS) backfills.delete(id);
  if (active.has(key) || backfills.has(key) || backfills.size >= 1000) return false;
  const job = { status: 'processing' as 'processing' | 'failed' | 'done', updatedAt: now };
  backfills.set(key, job);
  void withAuditAnalyticsProgress(key, 'report', task).then(() => {
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
}): AuditAnalyticsProgress {
  const runningStage = active.get(input.key)?.stage;
  const failure = failures.get(input.key);
  if (failure && Date.now() - failure.updatedAt > RETENTION_MS) failures.delete(input.key);
  const transcriptReady = runningStage === 'transcription' ? false : input.transcriptReady || runningStage === 'evaluation' || runningStage === 'report';
  const evaluationReady = input.evaluationReady || runningStage === 'report';
  const stage = runningStage ?? failures.get(input.key)?.stage ?? (!transcriptReady ? 'transcription' : !evaluationReady ? 'evaluation' : 'report');
  const base = { stage, transcriptReady, evaluationReady };
  if (input.reportReady) return { ...base, stage: 'report', status: 'ready', transcriptReady: true, evaluationReady: true, message: 'Отчёт готов.' };
  if (input.unavailable) return { ...base, status: 'unavailable', message: 'Разговор не состоялся. Аналитика для этого звонка не формируется.' };
  if (runningStage) return { ...base, status: 'processing', message: 'Анализируем разговор. Отчёт появится здесь автоматически.' };
  if (input.failureReason || failures.has(input.key) || backfills.get(input.key)?.status === 'failed') return { ...base, status: 'failed', message: 'Не удалось завершить подготовку аналитики. Попробуйте проверить отчёт позже.' };
  return { ...base, status: 'waiting', message: 'Ожидаем данные для следующего этапа. Статус обновляется автоматически.' };
}
