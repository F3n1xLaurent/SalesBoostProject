import { AsyncResource } from 'node:async_hooks';

export function analyticsConcurrency(value = process.env.ANALYTICS_CONCURRENCY): number {
  const parsed = Number(value ?? 2);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : 2;
}

/** One shared FIFO for initial call/trainer analysis and report repairs. */
export class AnalyticsQueue {
  private running = 0;
  private pending: Array<{ key: string; start: () => void }> = [];
  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid analytics concurrency');
  }

  position(key: string): number | undefined {
    const index = this.pending.findIndex(job => job.key === key);
    return index < 0 ? undefined : index + 1;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const bound = AsyncResource.bind(task);
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ key, start: () => {
        this.running++;
        let result: Promise<T>;
        try { result = bound(); } catch (error) { result = Promise.reject(error); }
        void result.then(resolve, reject).finally(() => { this.running--; this.drain(); });
      } });
      this.drain();
    });
  }

  private drain() {
    while (this.running < this.concurrency && this.pending.length) this.pending.shift()!.start();
  }
}

export const analyticsQueue = new AnalyticsQueue(analyticsConcurrency());
