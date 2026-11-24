import type { AuditDetailItem } from '../../../shared/api/adminPanel';

export function needsAnalyticsRefresh(detail: AuditDetailItem): boolean {
  const reportPending = !detail.unifiedReport
    && !['failed', 'unavailable'].includes(detail.analyticsProgress?.status ?? 'waiting');
  const recordingPending = detail.type === 'call'
    && ['pending', 'processing'].includes(detail.recordingStatus ?? '');
  return reportPending || recordingPending;
}

/** A report and its recording finish independently. Keep a parent's completed
 * report while accepting the latest recording state from polling. */
export function mergeAuditRefresh(provided: AuditDetailItem, refreshed: AuditDetailItem | null): AuditDetailItem {
  if (!refreshed || refreshed.id !== provided.id) return provided;
  return { ...refreshed, unifiedReport: provided.unifiedReport ?? refreshed.unifiedReport };
}

/** One request at a time; stop on completion, terminal status, dismissal or navigation. */
export function pollAuditAnalytics(options: {
  load: (signal: AbortSignal) => Promise<AuditDetailItem | null>;
  onDetail: (detail: AuditDetailItem) => void;
  onError: () => void;
  intervalMs?: number;
}): () => void {
  const interval = options.intervalMs ?? 5000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const schedule = (delay = interval) => { if (!stopped) timer = setTimeout(tick, delay); };
  async function tick() {
    try {
      const detail = await options.load(controller.signal);
      if (stopped) return;
      if (!detail) { options.onError(); return; }
      options.onDetail(detail);
      if (needsAnalyticsRefresh(detail)) schedule();
    } catch {
      if (!stopped) { options.onError(); schedule(Math.min(interval * 2, 15000)); }
    }
  }
  schedule();
  return () => { stopped = true; clearTimeout(timer); controller.abort(); };
}
