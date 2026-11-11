import { describe, expect, it, vi } from 'vitest';
import { SupportCategoryCache } from '../support/categoryCache';

describe('support categories stale-while-revalidate cache', () => {
  it('immediately serves cold readers while deduplicating a burst of 100 refresh requests', async () => {
    let release!: (value: string[]) => void;
    const load = vi.fn(() => new Promise<string[]>(resolve => { release = resolve; }));
    const cache = new SupportCategoryCache(load);
    for (let i = 0; i < 100; i++) expect(cache.read()).toEqual([]);
    await Promise.resolve(); expect(load).toHaveBeenCalledOnce();
    release(['Категория А', 'Категория А', 'Категория Б']); await cache.refresh();
    expect(cache.read()).toEqual(['Категория А', 'Категория Б']);
    expect(load).toHaveBeenCalledOnce();
  });

  it('serves a stale value without waiting and then replaces it after a successful update', async () => {
    let now = 0, release!: (value: string[]) => void;
    const load = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(['А']).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const cache = new SupportCategoryCache(load, { ttlMs: 100, now: () => now });
    await cache.refresh(); now = 101;
    expect(cache.read()).toEqual(['А']);
    await Promise.resolve(); release(['Б']); await cache.refresh();
    expect(cache.read()).toEqual(['Б']); expect(load).toHaveBeenCalledTimes(2);
  });

  it('retains the last good value through failures and backs off rather than hammering Bitrix', async () => {
    let now = 0;
    const load = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(['А']).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(['Б']);
    const cache = new SupportCategoryCache(load, { ttlMs: 100, retryMs: 20, now: () => now });
    await cache.refresh(); now = 101; expect(await cache.refresh()).toBe(false);
    for (let i = 0; i < 100; i++) expect(cache.read()).toEqual(['А']);
    expect(load).toHaveBeenCalledTimes(2);
    now = 122; await cache.refresh(); expect(cache.read()).toEqual(['Б']);
  });

  it('does not replace a valid cache with empty categories or let a reader mutate it', async () => {
    let now = 0;
    const load = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(['А']).mockResolvedValueOnce([]);
    const cache = new SupportCategoryCache(load, { ttlMs: 10, now: () => now });
    await cache.refresh(); const value = cache.read(); value.push('В'); expect(cache.read()).toEqual(['А']);
    now = 11; expect(await cache.refresh()).toBe(false); expect(cache.read()).toEqual(['А']);
  });
});
