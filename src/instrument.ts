import * as Sentry from '@sentry/node';
import { env } from './config/env';

const enabled = Boolean(env.sentryBackendDsn);

function sanitizeEvent<T extends Sentry.Event>(event: T): T {
  if (event.user) {
    event.user = event.user.id ? { id: String(event.user.id) } : undefined;
  }
  if (event.request) {
    event.request.cookies = undefined;
    event.request.data = undefined;
    event.request.query_string = undefined;
    if (event.request.url) event.request.url = event.request.url.split('?')[0];
    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (['authorization', 'cookie', 'x-voximplant-signature'].includes(key.toLowerCase())) {
          delete event.request.headers[key];
        }
      }
    }
  }
  return event;
}

Sentry.init({
  dsn: env.sentryBackendDsn,
  enabled,
  environment: env.sentryEnvironment,
  release: env.sentryRelease,
  sendDefaultPii: false,
  tracesSampleRate: env.sentryTracesSampleRate,
  beforeSend: sanitizeEvent,
  beforeSendTransaction: sanitizeEvent,
});

if (enabled) {
  console.log(`[monitoring] Sentry backend enabled environment=${env.sentryEnvironment}`);
}
