import * as Sentry from '@sentry/react';

function sanitizeEvent<T extends Sentry.Event>(event: T): T {
  if (event.user) event.user = event.user.id ? { id: String(event.user.id) } : undefined;
  if (event.request) {
    event.request.cookies = undefined;
    event.request.data = undefined;
    event.request.query_string = undefined;
    if (event.request.url) event.request.url = event.request.url.split('?')[0];
    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (['authorization', 'cookie'].includes(key.toLowerCase())) {
          delete event.request.headers[key];
        }
      }
    }
  }
  return event;
}

export function initializeFrontendMonitoring(): void {
  const dsn = __SENTRY_FRONTEND_DSN__.trim();
  Sentry.init({
    dsn: dsn || undefined,
    enabled: Boolean(dsn),
    environment: __SENTRY_ENVIRONMENT__,
    release: __SENTRY_RELEASE__ || undefined,
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    tracePropagationTargets: [/^\//],
    tracesSampleRate: __SENTRY_TRACES_SAMPLE_RATE__,
    beforeSend: sanitizeEvent,
    beforeSendTransaction: sanitizeEvent,
  });
}

export { Sentry };
