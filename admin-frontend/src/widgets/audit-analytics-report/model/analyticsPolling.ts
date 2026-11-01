import type { AuditDetailItem } from '../../../shared/api/adminPanel';

export function needsAnalyticsRefresh(detail: AuditDetailItem): boolean {
  return !detail.unifiedReport
    && !['failed', 'unavailable', 'ready'].includes(detail.analyticsProgress?.status ?? 'waiting');
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
