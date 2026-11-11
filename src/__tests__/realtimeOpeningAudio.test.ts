import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareOpeningAudio, preparedOpeningAudio } from '../voice/realtimeOpeningAudio';

const sockets = vi.hoisted(() => [] as any[]);
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    sent: any[] = []; closed = false;
    constructor(readonly url: string) { super(); sockets.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.closed = true; this.emit('close'); }
    server(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  } };
});

const releases: Array<() => void> = [];
let serial = 0;
const options = () => ({ prompt: `scenario-${++serial}`, elevenLabsVoiceId: 'voice', elevenLabsTts: {
  modelId: 'eleven_v4_turbo', defaultVoiceId: 'voice', stability: 0.75, similarityBoost: 0.75,
  speed: 1.13, source: 'agent' as const, optimizeStreamingLatency: 0, pronunciationDictionaryLocators: [],
} });
beforeEach(() => { vi.useFakeTimers(); sockets.length = 0; });
afterEach(async () => { releases.splice(0).forEach(release => release()); await vi.advanceTimersByTimeAsync(31 * 60_000); vi.useRealTimers(); });
function prepare(input = options()) {
  releases.push(prepareOpeningAudio(input));
  const ws = sockets.at(-1); ws.emit('open');
  return { input, ws };
}
function complete(ws: any) {
  ws.server({ audio: Buffer.alloc(8_000, 0xff).toString('base64'),
    alignment: { chars: ['З'], char_start_times_ms: [0], char_durations_ms: [100] }, is_final_audio_for_turn: true });
}

describe('prepared first greeting', () => {
  it('only returns audio for an exact greeting chosen for a live conversation', () => {
    const { input, ws } = prepare(); complete(ws);
    expect(preparedOpeningAudio(input, 'Здравствуйте. Меня зовут Анна.', true)?.audio.length).toBe(8_000);
    expect(preparedOpeningAudio(input, 'Здравствуйте!', true)?.alignment).toEqual([{ character: 'З', endMs: 100 }]);
    for (const text of ['Добрый день.', 'Да, я по объявлению.', 'Здравствуйте, меня зовут Анна.', 'Здравствуйте?']) {
      expect(preparedOpeningAudio(input, text, true)).toBeNull();
    }
    expect(preparedOpeningAudio(input, 'Здравствуйте.', false)).toBeNull();
  });
  it('never uses partial audio and separates scenarios, voices and voice settings', () => {
    const { input, ws } = prepare();
    ws.server({ audio: Buffer.alloc(800).toString('base64') });
    expect(preparedOpeningAudio(input, 'Здравствуйте.', true)).toBeNull();
    complete(ws);
    expect(preparedOpeningAudio({ ...input, prompt: 'other scenario' }, 'Здравствуйте.', true)).toBeNull();
    expect(preparedOpeningAudio({ ...input, elevenLabsVoiceId: 'other' }, 'Здравствуйте.', true)).toBeNull();
    expect(preparedOpeningAudio({ ...input, elevenLabsTts: { ...input.elevenLabsTts, speed: 1 } }, 'Здравствуйте.', true)).toBeNull();
  });
  it('deduplicates preparations and only cancels when the last owner leaves', () => {
    const input = options(); const first = prepareOpeningAudio(input); const second = prepareOpeningAudio(input);
    expect(sockets).toHaveLength(1);
    first(); first(); expect(sockets[0].closed).toBe(false);
    second(); expect(sockets[0].closed).toBe(true);
  });
  it.each(['error', 'unexpected-response', 'oversized', 'timeout'])("falls back normally after %s and allows retry", async failure => {
    const { input, ws } = prepare();
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(8_000);
    else if (failure === 'oversized') ws.server({ audio: Buffer.alloc(64_001).toString('base64') });
    else ws.emit(failure, new Error('offline'));
    expect(ws.closed).toBe(true);
    expect(preparedOpeningAudio(input, 'Здравствуйте.', true)).toBeNull();
    releases.push(prepareOpeningAudio(input)); expect(sockets).toHaveLength(2);
  });
  it('expires completed audio and bounds retained entries', async () => {
    const { input, ws } = prepare(); complete(ws);
    for (let i = 0; i < 32; i++) { const item = prepare(); complete(item.ws); }
    expect(preparedOpeningAudio(input, 'Здравствуйте.', true)).toBeNull();
    const latest = prepare(); complete(latest.ws);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(preparedOpeningAudio(latest.input, 'Здравствуйте.', true)).toBeNull();
  });
  it('uses the selected legacy voice and protocol too', () => {
    const input = options(); input.elevenLabsTts.modelId = 'eleven_flash_v2_5';
    const { ws } = prepare(input);
    expect(ws.url).toContain('/text-to-speech/voice/');
    expect(ws.sent).toContainEqual({ text: 'Здравствуйте. ', try_trigger_generation: true });
    ws.server({ audio: Buffer.alloc(800).toString('base64'), isFinal: true });
    expect(preparedOpeningAudio(input, 'Здравствуйте.', true)?.audio.length).toBe(800);
  });
});
