/** Stale-while-revalidate: readers never wait for the upstream service. */
export class SupportCategoryCache {
  private value: string[] = [];
  private nextRefreshAt = 0;
  private pending: Promise<boolean> | null = null;

  constructor(private readonly load: () => Promise<string[]>, private readonly options: {
    ttlMs?: number; retryMs?: number; now?: () => number;
    onRefresh?: (event: { success: boolean; durationMs: number; count: number }) => void;
  } = {}) {}

  read(): string[] {
    void this.refresh();
    return [...this.value];
  }

  get refreshing(): boolean { return this.pending !== null; }

  refresh(): Promise<boolean> {
    if (this.pending) return this.pending;
    const now = this.options.now ?? Date.now;
    if (now() < this.nextRefreshAt) return Promise.resolve(false);
    const started = now();
    // Defer invocation until pending is assigned, including sync loader errors.
    this.pending = Promise.resolve().then(this.load).then(value => {
      const next = [...new Set(value.map(item => item.trim()).filter(Boolean))];
      if (!next.length) throw new Error('No support categories');
      this.value = next;
      this.nextRefreshAt = now() + (this.options.ttlMs ?? 30 * 60_000);
      this.options.onRefresh?.({ success: true, durationMs: now() - started, count: next.length });
      return true;
    }).catch(() => {
      this.nextRefreshAt = now() + (this.options.retryMs ?? 60_000);
      this.options.onRefresh?.({ success: false, durationMs: now() - started, count: this.value.length });
      return false;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
