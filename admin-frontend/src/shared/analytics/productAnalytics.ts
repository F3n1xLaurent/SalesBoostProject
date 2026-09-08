import { apiFetch } from '../../entities/session';

export type ClientProductEventName =
  | 'session_started'
  | 'page_viewed'
  | 'analytics_opened'
  | 'manager_viewed'
  | 'dealership_viewed'
  | 'comparison_used'
  | 'report_viewed'
  | 'score_viewed'
  | 'errors_viewed'
  | 'recommendations_viewed';

type TrackOptions = {
  route?: string;
  targetType?: string;
  targetId?: string;
  properties?: Record<string, string | number | boolean | null>;
};

const recentEvents = new Map<string, number>();
let fallbackSessionId = '';

function clientSessionId(): string {
  const storageKey = 'salesboost:product-analytics-session';
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
  } catch {
    // Some hardened/private browser modes disable sessionStorage.
  }
  if (fallbackSessionId) return fallbackSessionId;
  fallbackSessionId = typeof window.crypto?.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  try {
    window.sessionStorage.setItem(storageKey, fallbackSessionId);
  } catch {
    // The in-memory ID still keeps this tab internally consistent.
  }
  return fallbackSessionId;
}

export function trackProductEvent(eventName: ClientProductEventName, options: TrackOptions = {}): void {
  if (typeof window === 'undefined') return;
  const sessionId = clientSessionId();
  const eventKey = [eventName, options.route, options.targetType, options.targetId, JSON.stringify(options.properties ?? {})].join(':');
  const now = Date.now();
  if (now - (recentEvents.get(eventKey) ?? 0) < 1_000) return;
  recentEvents.set(eventKey, now);

  void apiFetch('/api/admin/product-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventName,
      route: options.route ?? window.location.pathname,
      targetType: options.targetType,
      targetId: options.targetId,
      clientSessionId: sessionId,
      properties: options.properties,
    }),
    keepalive: true,
  }).catch(() => {
    // Product analytics must never interrupt the user's workflow.
  });
}

export function startProductAnalyticsSession(accountId: string): void {
  const markerKey = `salesboost:product-analytics-started:${accountId}`;
  try {
    if (window.sessionStorage.getItem(markerKey)) return;
    window.sessionStorage.setItem(markerKey, '1');
  } catch {
    // The backend deduplication key still protects repeated session events.
  }
  trackProductEvent('session_started');
}
