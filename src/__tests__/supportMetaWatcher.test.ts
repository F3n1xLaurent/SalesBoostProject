import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchSupportMeta } from '../../admin-frontend/src/widgets/support-widget/model/watchSupportMeta';
afterEach(() => { vi.useRealTimers(); });

describe('support widget metadata after a cold cache response', () => {
  it('replaces fallback choices with the ready cache and stops polling', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValueOnce({ categories: ['fallback'], categoriesPending: true })
      .mockResolvedValue({ categories: ['Bitrix category'], categoriesPending: false });
    const receive = vi.fn(), stop = watchSupportMeta(load, receive);
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenLastCalledWith({ categories: ['fallback'], categoriesPending: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(receive).toHaveBeenLastCalledWith({ categories: ['Bitrix category'], categoriesPending: false });
    await vi.advanceTimersByTimeAsync(120_000); expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not update an unmounted widget or schedule another request after its pending response arrives', async () => {
    vi.useFakeTimers();
    let release!: (value: { categoriesPending: boolean }) => void;
    const load = vi.fn(() => new Promise<{ categoriesPending: boolean }>(resolve => { release = resolve; }));
    const receive = vi.fn(), stop = watchSupportMeta(load, receive);
    stop(); release({ categoriesPending: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(receive).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledOnce();
  });

  it('does not turn an HTTP error into a tight retry loop', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(new Error('offline'));
    const stop = watchSupportMeta(load, vi.fn());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledOnce(); stop();
  });
});
