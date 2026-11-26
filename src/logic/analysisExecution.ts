import { currentAuditAnalyticsKey } from './auditAnalyticsProgress';

export const RECORDING_WAIT_TIMEOUT_MS = 60_000;
export const RETRANSCRIPTION_TIMEOUT_MS = 90_000;
export const EVALUATION_TIMEOUT_MS = 180_000;
export const EVALUATION_REQUEST_TIMEOUT_MS = 120_000;
export const PLAN_CRITERIA_TIMEOUT_MS = 60_000;
type AnalysisStage = 'recording_wait' | 'retranscription' | 'evaluation' | 'plan_criteria';

export class AnalysisStageTimeoutError extends Error {
  constructor(readonly stage: AnalysisStage) {
    super(`ANALYSIS_STAGE_TIMEOUT: ${stage}`);
    this.name = 'AnalysisStageTimeoutError';
  }
}

/** Bound both the HTTP request and the queue's wait. Late work cannot publish
 * its result or start another paid request after the deadline. */
export async function withAnalysisStageDeadline<T>(stage: AnalysisStage, timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let rejectDeadline!: (reason: unknown) => void;
  const expired = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    const error = new AnalysisStageTimeoutError(stage);
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);
  timer.unref();
  const started = performance.now();
  let status = 'done';
  try {
    const result = await Promise.race([Promise.resolve().then(() => task(controller.signal)), expired]);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    status = controller.signal.aborted ? 'timeout' : 'failed';
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    console.info('[analysis/stage]', { key: currentAuditAnalyticsKey() ?? null, stage, status,
      ms: Math.round(performance.now() - started) });
  }
}
