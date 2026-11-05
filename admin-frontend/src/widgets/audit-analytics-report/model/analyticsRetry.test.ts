import { describe, expect, it } from 'vitest';
import { analyticsRetryDelayed } from './analyticsRetry';

const openedAt = Date.parse('2026-11-05T12:00:00Z');
describe('report retry waiting deadline', () => {
  it('offers recovery immediately when reopening a report older than two minutes', () => {
    expect(analyticsRetryDelayed(openedAt, openedAt, '2026-11-05T11:30:00Z')).toBe(true);
  });

  it.each([undefined, 'invalid', '2026-11-05T15:00:00Z', '2026-11-05T12:01:59Z'])(
    'never extends the local two-minute wait for server timestamp %s', (startedAt) => {
      expect(analyticsRetryDelayed(openedAt + 119_999, openedAt, startedAt)).toBe(false);
      expect(analyticsRetryDelayed(openedAt + 120_000, openedAt, startedAt)).toBe(true);
      expect(analyticsRetryDelayed(openedAt + 30 * 60_000, openedAt, startedAt)).toBe(true);
    },
  );

  it('keeps recovery available when polling advances or corrupts the server timestamp', () => {
    const now = openedAt + 120_000;
    for (const startedAt of ['2026-11-05T12:00:00Z', '2026-11-05T12:02:00Z', 'invalid']) {
      expect(analyticsRetryDelayed(now, openedAt, startedAt)).toBe(true);
    }
  });

  it('starts a new local deadline after a successful manual retry', () => {
    const retriedAt = openedAt + 30 * 60_000;
    const startedAt = new Date(retriedAt).toISOString();
    expect(analyticsRetryDelayed(retriedAt, retriedAt, startedAt)).toBe(false);
    expect(analyticsRetryDelayed(retriedAt + 120_000, retriedAt, startedAt)).toBe(true);
  });
});
