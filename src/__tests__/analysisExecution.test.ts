import { afterEach, expect, it, vi } from 'vitest';
import { AnalyticsQueue } from '../logic/analyticsQueue';
import { withAnalysisStageDeadline } from '../logic/analysisExecution';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('releases the analytics slot at the deadline even when an upstream operation ignores cancellation', async () => {
  vi.useFakeTimers();
  const queue = new AnalyticsQueue(1);
  let signal!: AbortSignal;
  let late!: (value: string) => void;
  const first = queue.run('stalled', () => withAnalysisStageDeadline('evaluation', 25, current => {
    signal = current;
    return new Promise<string>(resolve => { late = resolve; });
  }));
  const rejected = expect(first).rejects.toThrow('ANALYSIS_STAGE_TIMEOUT: evaluation');
  const next = vi.fn(async () => 'next report');
  const second = queue.run('next', next);
  await vi.advanceTimersByTimeAsync(24);
  expect(next).not.toHaveBeenCalled();expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);await rejected;
  expect(await second).toBe('next report');expect(signal.aborted).toBe(true);
  late('late report');await vi.advanceTimersByTimeAsync(0);
  expect(next).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not replace a provider error with a timeout and clears the deadline after settling', async () => {
  vi.useFakeTimers();
  const failure = new Error('provider unavailable');
  await expect(withAnalysisStageDeadline('evaluation', 25, async () => { throw failure; })).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
  await expect(withAnalysisStageDeadline('evaluation', 25, async () => 'verified report')).resolves.toBe('verified report');
  expect(vi.getTimerCount()).toBe(0);
});
