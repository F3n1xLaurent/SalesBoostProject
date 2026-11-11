import { describe, expect, it, vi } from 'vitest';
import { AnalyticsQueue, analyticsConcurrency, analyticsQueue } from '../logic/analyticsQueue';
import { currentCostContext, withCostContext } from '../economics/costContext';
import { auditAnalyticsProgress, scheduleAuditReportBackfill, withAuditAnalyticsProgress } from '../logic/auditAnalyticsProgress';

describe('analytics concurrency and FIFO', () => {
  it('processes a burst of 30 calls with two workers in arrival order', async () => {
    const queue = new AnalyticsQueue(2), started: number[] = [], releases: Array<() => void> = [];
    let active = 0, peak = 0;
    const jobs = Array.from({ length: 30 }, (_, i) => queue.run(`call-${i}`, async () => {
      active++; peak = Math.max(peak, active); started.push(i);
      await new Promise<void>(resolve => { releases[i] = resolve; });
      active--; return i;
    }));
    expect(started).toEqual([0, 1]); expect(queue.position('call-2')).toBe(1);
    for (let i = 0; i < 30; i++) {
      await vi.waitFor(() => expect(releases[i]).toBeTypeOf('function'));
      releases[i]();
    }
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(started).toEqual(Array.from({ length: 30 }, (_, i) => i)); expect(peak).toBe(2);
  });

  it('releases a slot after failure and preserves each queued job cost context', async () => {
    const queue = new AnalyticsQueue(1);
    let fail!: () => void;
    const first = queue.run('failed', () => new Promise<void>((_, reject) => { fail = () => reject(new Error('failed')); }));
    const rejected = expect(first).rejects.toThrow('failed');
    const second = withCostContext({ entityType: 'voice_call', entityId: 'second' }, () => queue.run('second', async () => currentCostContext()?.entityId));
    fail(); await rejected; expect(await second).toBe('second');
  });

  it('uses a conservative configurable default and rejects unsafe configuration values', () => {
    expect(analyticsConcurrency('3')).toBe(3);
    for (const value of ['', '0', '-1', '999', 'abc', '2.5']) expect(analyticsConcurrency(value)).toBe(2);
  });
});

describe('shared initial-analysis and repair queue', () => {
  it('keeps waiting jobs idempotent beyond two minutes and permits nested work without another slot', async () => {
    const releases: Array<() => void> = [];
    const blockers = Array.from({ length: analyticsQueue.concurrency }, (_, i) => withAuditAnalyticsProgress(`queue-blocker-${i}`, 'evaluation',
      () => new Promise<void>(resolve => releases.push(resolve))));
    const generate = vi.fn();
    const pending = withAuditAnalyticsProgress('queue-waiter', 'transcription', async () => {
      await withAuditAnalyticsProgress('queue-waiter', 'evaluation', async () => { generate(); });
    });
    const data = { key: 'queue-waiter', transcriptReady: true, evaluationReady: false, reportReady: false };
    try {
      expect(auditAnalyticsProgress(data)).toMatchObject({ status: 'waiting', waitingForSlot: true, queuePosition: 1 });
      // Preliminary ASR can be ineligible until queued recording recovery runs.
      expect(auditAnalyticsProgress({ ...data, unavailable: true })).toMatchObject({ status: 'waiting', waitingForSlot: true });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180_000);
      expect(scheduleAuditReportBackfill(data.key, async () => {}, { retry: true })).toBe(false);
      expect(generate).not.toHaveBeenCalled(); clock.mockRestore();
    } finally { releases.forEach(release => release()); await Promise.all([...blockers, pending]); }
    expect(generate).toHaveBeenCalledOnce();
  });
});
