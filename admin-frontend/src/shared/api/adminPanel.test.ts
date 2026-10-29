import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../entities/session', () => ({ apiFetch }));

import { fetchAuditDetail } from './adminPanel';

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('audit detail loading', () => {
  it.each([0, 2])('returns a ready report with score %s and clears the deadline', async (totalScore) => {
    vi.useFakeTimers();
    const item = { id: 'call-737', totalScore, unifiedReport: { summary: 'Готовый отчёт' } };
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ item })));

    expect(await fetchAuditDetail(item.id)).toEqual(item);
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/audits/call-737', {
      signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['headers', 'body'])('aborts stalled response %s so the drawer can leave its loading state', async (stage) => {
    vi.useFakeTimers();
    const waitForAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    apiFetch.mockImplementation((_url, { signal }) => stage === 'headers'
      ? waitForAbort(signal)
      : Promise.resolve({ ok: true, status: 200, json: () => waitForAbort(signal) }));
    const assertion = expect(fetchAuditDetail('call-734')).rejects.toThrow(
      'Сервер не ответил за 20 секунд',
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves missing-report behavior and clears the deadline', async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await fetchAuditDetail('call-unknown')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a network error and clears the deadline', async () => {
    vi.useFakeTimers();
    apiFetch.mockRejectedValue(new Error('Network unavailable'));
    await expect(fetchAuditDetail('call-737')).rejects.toThrow('Network unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
});
