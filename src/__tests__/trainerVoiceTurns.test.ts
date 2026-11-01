import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrainerVoiceTurns, type TrainerTurnControl } from '../trainer/trainerVoiceTurns';

afterEach(() => vi.useRealTimers());
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
describe('trainer voice corrections before reply commit', () => {
  it('accepts two separate inputs, retaining arrival order despite reverse STT completion, and commits one answer', async () => {
    const tasks = new Set<string>(), queue = new TrainerVoiceTurns(tasks, 0), firstStt = gate();
    const stored: string[] = [];
    const prepare = async (text: string) => { if (text === '640 500') await firstStt.promise; return text; };
    const generate = vi.fn(async (messages: string[], control: TrainerTurnControl) => { control.assertCurrent(); control.commit(); stored.push(messages.join('\n')); return { reply: '6 405 000' }; });
    const a = queue.submit('session', '640 500', prepare, generate);
    const b = queue.submit('session', 'Поправлюсь: 6 405 000', prepare, generate);
    expect(tasks.has('session')).toBe(true); firstStt.resolve();
    const result = await Promise.all([a, b]);
    expect(result.map((item) => item.superseded)).toEqual([true, false]); expect(stored).toEqual(['640 500\nПоправлюсь: 6 405 000']); expect(generate).toHaveBeenCalledOnce(); expect(tasks.size).toBe(0);
  });
  it('discards an already generating stale answer instead of persisting or delivering it', async () => {
    const queue = new TrainerVoiceTurns(new Set(), 0), generating = gate(), release = gate();
    const discard = vi.fn(), persisted: string[] = [], spoken: string[] = [];
    const generate = vi.fn(async (messages: string[], control: TrainerTurnControl) => {
      if (messages.length === 1) { generating.resolve(); await release.promise; }
      control.assertCurrent(); spoken.push(messages.at(-1)!); control.commit(); persisted.push(messages.at(-1)!); return { reply: messages.at(-1)! };
    });
    const first = queue.submit('s', 'старое', async (text) => text, generate, discard);
    await generating.promise;
    const second = queue.submit('s', 'исправление', async (text) => text, generate, discard); release.resolve();
    const result = await Promise.all([first, second]);
    expect(generate).toHaveBeenCalledTimes(2); expect(discard).toHaveBeenCalledOnce(); expect(persisted).toEqual(['исправление']); expect(spoken).toEqual(['исправление']); expect(result[1].reply).toBe('исправление');
  });
  it('also discards corrections arriving during whole-message TTS before commit', async () => {
    const queue = new TrainerVoiceTurns(new Set(), 0), tts = gate(), release = gate(); const persisted: string[] = [];
    const generate = async (messages: string[], control: TrainerTurnControl) => {
      control.assertCurrent(); if (messages.length === 1) { tts.resolve(); await release.promise; }
      control.commit(); persisted.push(messages.join(' / ')); return { reply: 'актуальный ответ' };
    };
    const a = queue.submit('s', 'первое', async (value) => value, generate); await tts.promise;
    const b = queue.submit('s', 'поправка', async (value) => value, generate); release.resolve(); await Promise.all([a, b]);
    expect(persisted).toEqual(['первое / поправка']);
  });
  it('rejects a new input after the atomic commit boundary, but allows the next real turn', async () => {
    const tasks = new Set<string>(), queue = new TrainerVoiceTurns(tasks, 0), committed = gate(), release = gate();
    const generate = async (_messages: string[], control: TrainerTurnControl) => { control.commit(); committed.resolve(); await release.promise; return { ok: true }; };
    const first = queue.submit('s', 'первое', async (text) => text, generate); await committed.promise;
    await expect(queue.submit('s', 'слишком поздно', async (text) => text, generate)).rejects.toMatchObject({ status: 409 });
    release.resolve(); await first; expect(tasks.size).toBe(0);
    await expect(queue.submit('s', 'следующий ход', async (text) => text, async (_messages, control) => { control.commit(); return { ok: true }; })).resolves.toMatchObject({ ok: true, superseded: false });
  });
  it('isolates session IDs and releases the lock after STT and generation failures', async () => {
    const tasks = new Set<string>(), queue = new TrainerVoiceTurns(tasks, 0);
    const failed = queue.submit('s', 'bad', async () => { throw new Error('STT failed'); }, async () => ({ ok: true }));
    await expect(failed).rejects.toThrow('STT failed'); await new Promise((resolve) => setTimeout(resolve, 0)); expect(tasks.size).toBe(0);
    const failedGeneration = queue.submit('s', 'ok', async (x) => x, async () => { throw new Error('LLM failed'); });
    const other = queue.submit('other', 'ok', async (x) => x, async () => ({ ok: true }));
    await expect(failedGeneration).rejects.toThrow('LLM failed'); await expect(other).resolves.toMatchObject({ ok: true }); expect(tasks.size).toBe(0);
  });
  it('does not supersede a valid voice when only the correction fails STT', async () => {
    const queue = new TrainerVoiceTurns(new Set(), 0);
    const generate = async (messages: string[], control: TrainerTurnControl) => { control.commit(); return { reply: messages.join() }; };
    const a = queue.submit('s', 'valid', async (x) => x, generate), b = queue.submit('s', 'bad', async () => { throw new Error('No speech'); }, generate);
    const result = await Promise.allSettled([a, b]); expect(result[0]).toMatchObject({ status: 'fulfilled', value: { superseded: false, reply: 'valid' } }); expect(result[1].status).toBe('rejected');
  });
});
