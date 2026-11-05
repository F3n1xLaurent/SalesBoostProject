export const ANALYTICS_RETRY_AFTER_MS = 2 * 60_000;

/** Server timestamps can be missing, malformed, ahead of the browser or change
 * during polling. They must never extend two minutes already spent waiting. */
export function analyticsRetryDelayed(now: number, observedAt: number, startedAt?: string): boolean {
  const serverStart = startedAt ? Date.parse(startedAt) : NaN;
  const waitStart = Number.isFinite(serverStart) ? Math.min(observedAt, serverStart) : observedAt;
  return now - waitStart >= ANALYTICS_RETRY_AFTER_MS;
}
