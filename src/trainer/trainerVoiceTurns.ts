export class TrainerTurnSuperseded extends Error {
  constructor() { super('Поступило уточнение голосового до отправки ответа.'); }
}
export type TrainerTurnControl = { assertCurrent(): void; commit(): void };
type Entry = { ready: Promise<void>; value?: unknown; failed?: boolean; resolve(value: any): void; reject(error: unknown): void };
type Batch = { entries: Entry[]; revision: number; sealed: boolean };

/** One logical manager turn, including separate corrections received before
 * commit. STT runs concurrently; arrival order is retained, not completion order.
 * Stale generations never persist or reach the client. The caller must check
 * assertCurrent before TTS, and commit synchronously before its persistence.
 */
export class TrainerVoiceTurns {
  private batches = new Map<string, Batch>();
  constructor(private readonly tasks: Set<string>, private readonly settleMs = 40) {}

  submit<Input, Prepared, Result extends object>(id: string, input: Input,
    prepare: (input: Input) => Promise<Prepared>,
    generate: (messages: Prepared[], control: TrainerTurnControl) => Promise<Result>,
    discard: () => void = () => {},
  ): Promise<Result & { superseded: boolean }> {
    let batch = this.batches.get(id);
    if (batch?.sealed || (!batch && this.tasks.has(id))) return Promise.reject(Object.assign(new Error('Ответ уже сохраняется. Дождитесь ответа клиента.'), { status: 409 }));
    if (batch && batch.entries.length >= 8) return Promise.reject(Object.assign(new Error('Слишком много уточнений в одной реплике.'), { status: 429 }));
    const fresh = !batch;
    if (!batch) { batch = { entries: [], revision: 0, sealed: false }; this.batches.set(id, batch); this.tasks.add(id); }
    const current = batch;
    let entry!: Entry;
    const result = new Promise<Result & { superseded: boolean }>((resolve, reject) => { entry = { ready: Promise.resolve(), resolve, reject }; });
    current.entries.push(entry); current.revision++;
    entry.ready = Promise.resolve().then(() => prepare(input)).then((value) => { entry.value = value; }, (error) => { entry.failed = true; entry.reject(error); });
    if (fresh) void this.drain(id, current, generate, discard);
    return result;
  }
  private async drain<Prepared, Result extends object>(id: string, batch: Batch,
    generate: (messages: Prepared[], control: TrainerTurnControl) => Promise<Result>, discard: () => void,
  ) {
    try {
      while (true) {
        const revision = batch.revision;
        await Promise.all(batch.entries.map((entry) => entry.ready));
        if (this.settleMs) await new Promise((resolve) => setTimeout(resolve, this.settleMs));
        if (revision !== batch.revision) continue;
        const entries = batch.entries.filter((entry) => !entry.failed);
        if (!entries.length) return;
        const assertCurrent = () => { if (revision !== batch.revision) throw new TrainerTurnSuperseded(); };
        try {
          const output = await generate(entries.map((entry) => entry.value as Prepared), {
            assertCurrent, commit: () => { assertCurrent(); batch.sealed = true; },
          });
          // Also protect adapters without persistence; production commits first.
          assertCurrent(); batch.sealed = true;
          entries.forEach((entry, index) => entry.resolve({ ...output, superseded: index !== entries.length - 1 }));
          return;
        } catch (error) {
          if (error instanceof TrainerTurnSuperseded && !batch.sealed) { discard(); continue; }
          throw error;
        }
      }
    } catch (error) { batch.entries.filter((entry) => !entry.failed).forEach((entry) => entry.reject(error)); }
    finally { if (this.batches.get(id) === batch) { this.batches.delete(id); this.tasks.delete(id); } }
  }
}
