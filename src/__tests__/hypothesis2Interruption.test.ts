import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { createHypothesis2Simulation } from '../voice/cometRealtimeTest';
import type WebSocket from 'ws';

const sockets = vi.hoisted(() => [] as any[]);
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
    readyState = 1; sent: any[] = []; url: string;
    constructor(url: string | URL) {
      super(); this.url = String(url); sockets.push(this);
      queueMicrotask(() => {
        this.emit('open');
        if (this.url.includes('/realtime')) this.server({ type: 'session.created' });
      });
    }
    server(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
    send(raw: string) {
      const message = JSON.parse(raw); this.sent.push(message);
      if (message.type === 'session.update') queueMicrotask(() => this.server({ type: 'session.updated' }));
      if (message.type === 'response.cancel') queueMicrotask(() => this.server({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } }));
    }
    close() { this.readyState = 3; this.emit('close', 1000, Buffer.from('closed')); }
  }
  return { default: Socket };
});

class Vox extends EventEmitter {
  readyState = 1; sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  input(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
const original = { key: config.openaiRealtimeApiKey, eleven: config.elevenLabsApiKey };
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); sockets.length = 0;
  config.openaiRealtimeApiKey = 'test'; config.elevenLabsApiKey = 'test';
});
afterEach(() => {
  cleanup?.(); cleanup = undefined; vi.useRealTimers();
  config.openaiRealtimeApiKey = original.key; config.elevenLabsApiKey = original.eleven;
});
async function setup(options: { prompt?: string; openingText?: string } = {}) {
  const vox = new Vox();
  const task = createHypothesis2Simulation({ planId: 'test', planName: 'Test', prompt: options.prompt ?? 'Ты Анна, звонишь о Kia Carnival.',
    elevenLabsVoiceId: 'voice', customerVoiceId: null, subjectTitle: 'Kia Carnival', subjectDescription: null },
  'gpt-realtime-2.1', vox as unknown as WebSocket, { modelId: 'eleven_v4_turbo', defaultVoiceId: 'voice', stability: 0.75,
    similarityBoost: 0.75, speed: 1.13, source: 'agent', optimizeStreamingLatency: 0, pronunciationDictionaryLocators: [] });
  await vi.advanceTimersByTimeAsync(0);
  const simulation = await task; cleanup = simulation.close;
  const provider = sockets.find((s) => s.url.includes('/realtime'));
  const tts = sockets.find((s) => s.url.includes('elevenlabs'));
  provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
  provider.server({ type: 'response.created', response: { id: 'r1' } });
  provider.server({ type: 'response.output_item.added', response_id: 'r1', item: { type: 'message', id: 'a1' } });
  provider.server({ type: 'response.output_text.delta', response_id: 'r1', delta: options.openingText ?? 'Хорошо. Когда можно приехать посмотреть машину?' });
  tts.server({ audio: Buffer.alloc(64_000, 0xff).toString('base64'), alignment: { chars: Array.from('Хорошо. Когда можно приехать посмотреть машину?'), char_start_times_ms: Array.from({ length: 50 }, (_, i) => i * 100), char_durations_ms: Array(50).fill(100) } });
  vox.input({ customEvent: 'media_status', status: 'started' });
  await vi.advanceTimersByTimeAsync(1000);
  return { vox, provider, simulation };
}
async function speech(vox: Vox, durationMs: number) {
  const pcm = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.2) * 7000), i * 2);
  for (let n = 0; n < durationMs; n += 20) {
    vox.input({ event: 'media', media: { payload: pcm.toString('base64') } });
    await vi.advanceTimersByTimeAsync(20);
  }
}

async function finishOpening(vox: Vox, provider: any) {
  provider.server({ type: 'response.done', response: { id: 'r1' } });
  sockets.find((s) => s.url.includes('elevenlabs')).server({ is_final_audio_for_turn: true });
  await vi.advanceTimersByTimeAsync(9000);
  vox.input({ customEvent: 'media_status', status: 'ended' });
}

describe('hypothesis 2 real bridge interruptions', () => {
  it('keeps playing on a short acknowledgement and removes it from conversation history', async () => {
    const { vox, provider, simulation } = await setup();
    await speech(vox, 200); await vi.advanceTimersByTimeAsync(300);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'ack' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ack', transcript: 'Угу.' });
    expect(provider.sent.some((x: any) => x.type === 'response.cancel')).toBe(false);
    expect(vox.sent.some((x) => x.action === 'clear_media')).toBe(false);
    expect(provider.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'ack' });
    expect(simulation.snapshot().conversationFlow.events.at(-1)?.type).toBe('barge_in_ignored');
  });

  it('stops on sustained speech, repairs unheard context, and accepts the next response', async () => {
    const { vox, provider, simulation } = await setup();
    await speech(vox, 1000);
    expect(provider.sent.some((x: any) => x.type === 'response.cancel')).toBe(true);
    expect(vox.sent.some((x) => x.action === 'clear_media')).toBe(true);
    expect(provider.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'a1' });
    const repaired = provider.sent.find((x: any) => x.type === 'conversation.item.create' && x.item.role === 'assistant');
    expect(repaired.item.id.length).toBeLessThanOrEqual(32);
    expect(repaired?.item.content[0].text).not.toContain('посмотреть машину');
    expect(simulation.snapshot().transcript.find((x) => x.metrics.interrupted)?.metrics.contextCorrected).toBe(false);
    provider.server({ type: 'conversation.item.deleted', item_id: 'a1' });
    provider.server({ type: 'conversation.item.added', item: { id: repaired.item.id } });
    expect(simulation.snapshot().transcript.find((x) => x.metrics.interrupted)?.metrics.contextCorrected).toBe(true);
    provider.server({ type: 'response.output_text.delta', response_id: 'r1', delta: 'Этот старый текст нельзя произносить.' });
    await vi.advanceTimersByTimeAsync(800);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'answer' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer', transcript: 'Пробег тридцать тысяч.' });
    await vi.advanceTimersByTimeAsync(600);
    provider.server({ type: 'response.created', response: { id: 'r2' } });
    provider.server({ type: 'response.output_item.added', response_id: 'r2', item: { type: 'message', id: 'a2' } });
    provider.server({ type: 'response.output_text.delta', response_id: 'r2', delta: 'Спасибо. А ДТП были?' });
    provider.server({ type: 'response.output_text.done', response_id: 'r2', text: 'Спасибо. А ДТП были?' });
    expect(simulation.snapshot().transcript.at(-1)?.text).toBe('Спасибо. А ДТП были?');
    expect(simulation.snapshot().transcript.some((x) => x.text.includes('старый текст'))).toBe(false);
  });

  it('recognizes a short stop command as a substantive interruption', async () => {
    const { vox, provider, simulation } = await setup();
    await speech(vox, 200); await vi.advanceTimersByTimeAsync(300);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'stop' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'stop', transcript: 'Стоп.' });
    expect(provider.sent.some((x: any) => x.type === 'response.cancel')).toBe(true);
    expect(simulation.snapshot().conversationFlow.events.some((x) => x.reason === 'strong_command')).toBe(true);
  });

  it('keeps a fully played answer when overlapping ASR arrives after Vox playback ended (e844 regression)', async () => {
    const { vox, provider, simulation } = await setup();
    await speech(vox, 200); await vi.advanceTimersByTimeAsync(300);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'late-answer' });
    await finishOpening(vox, provider);
    const spoken = simulation.snapshot().transcript.find(turn => turn.role === 'client')?.text;
    expect(spoken).toBeTruthy();
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late-answer', transcript: 'Нет.' });
    expect(simulation.snapshot().transcript.find(turn => turn.role === 'client')?.text).toBe(spoken);
    expect(simulation.snapshot().transcript.some(turn => turn.text === '[реплика не прозвучала]')).toBe(false);
    expect(provider.sent.some((event: any) => event.type === 'conversation.item.delete' && event.item_id === 'a1')).toBe(false);
    expect(simulation.snapshot().transcript.some(turn => turn.role === 'manager' && turn.text === 'Нет.')).toBe(true);
    expect(simulation.snapshot().conversationFlow.events.at(-1)?.reason).toBe('probed_playback_already_finished');
  });

  it('does not let a stale probe cancel a newer assistant turn', async () => {
    const { vox, provider, simulation } = await setup();
    await speech(vox, 200); await vi.advanceTimersByTimeAsync(300);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'old-probe' });
    await finishOpening(vox, provider);
    provider.server({ type: 'response.created', response: { id: 'r2' } });
    provider.server({ type: 'response.output_item.added', response_id: 'r2', item: { type: 'message', id: 'a2' } });
    provider.server({ type: 'response.output_text.delta', response_id: 'r2', delta: 'А пробег актуальный?' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-probe', transcript: 'Да.' });
    expect(provider.sent.some((event: any) => event.type === 'response.cancel' && event.response_id === 'r2')).toBe(false);
    expect(provider.sent.some((event: any) => event.type === 'conversation.item.delete' && event.item_id === 'a2')).toBe(false);
    expect(simulation.snapshot().transcript.some(turn => turn.metrics.interrupted)).toBe(false);
  });

  it('does not confuse a delayed ordinary transcription with an overlapping acknowledgement', async () => {
    const { vox, provider, simulation } = await setup();
    await speech(vox, 200); await vi.advanceTimersByTimeAsync(300);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'ack_late' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ordinary', transcript: 'Цена два миллиона рублей.' });
    expect(simulation.snapshot().transcript.some((x) => x.text === 'Цена два миллиона рублей.')).toBe(true);
    expect(provider.sent.some((x: any) => x.type === 'conversation.item.delete' && x.item_id === 'ordinary')).toBe(false);
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ack_late', transcript: 'Ага.' });
    expect(provider.sent.some((x: any) => x.type === 'conversation.item.delete' && x.item_id === 'ack_late')).toBe(true);
  });

  it('restores actual media output after a transfer and does not remain muted', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'hold', transcript: 'Подождите, сейчас переведу на другого сотрудника. Оставайтесь на линии.' });
    provider.server({ type: 'response.created', response: { id: 'rhold' } });
    provider.server({ type: 'response.function_call_arguments.done', name: 'skip_turn', arguments: JSON.stringify({ kind: 'waiting' }), call_id: 'holdtool' });
    provider.server({ type: 'response.done', response: { id: 'rhold' } });
    expect(simulation.snapshot().connectionState).toBe('waiting_operator');
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'live', transcript: 'Алло, меня зовут Сергей, коллега передал ваш звонок. Чем могу помочь?' });
    expect(simulation.snapshot().connectionState).toBe('live_conversation');
    expect(vox.sent.filter((x) => x.action === 'set_output_enabled').at(-1).enabled).toBe(true);
    const packetsBefore = vox.sent.filter((x) => x.event === 'media').length;
    provider.server({ type: 'response.created', response: { id: 'rnext' } });
    provider.server({ type: 'response.output_text.delta', response_id: 'rnext', delta: 'Звоню по машине, хотел уточнить пробег.' });
    sockets.find((s) => s.url.includes('elevenlabs')).server({ audio: Buffer.alloc(800, 0xff).toString('base64') });
    expect(vox.sent.filter((x) => x.event === 'media').length).toBeGreaterThan(packetsBefore);
  });

  it('retries an invalid skip_turn when the manager asks a substantive question', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'question', transcript: 'Подождите, пожалуйста. У меня другой вопрос, я хотел уточнить комплектацию.' });
    provider.server({ type: 'response.created', response: { id: 'rquestion' } });
    provider.server({ type: 'response.function_call_arguments.done', name: 'skip_turn', arguments: JSON.stringify({ kind: 'waiting' }), call_id: 'wrongskip' });
    provider.server({ type: 'response.done', response: { id: 'rquestion' } });
    expect(simulation.snapshot().connectionState).toBe('live_conversation');
    expect(provider.sent.filter((x: any) => x.type === 'response.create').at(-1)?.response.instructions).toContain('а не ожидание на линии');
  });

  it('keeps speech timing captured at commit when recognition arrives after another turn starts', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    await speech(vox, 400); await vi.advanceTimersByTimeAsync(700);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'timed' });
    provider.server({ type: 'response.created', response: { id: 'rlate' } });
    await speech(vox, 1000);
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'timed', transcript: 'Автомобиль есть.' });
    const turn = simulation.snapshot().transcript.find((x) => x.text === 'Автомобиль есть.');
    expect(turn?.metrics.speechDurationMs).toBeGreaterThanOrEqual(380);
    expect(turn?.metrics.speechDurationMs).toBeLessThan(450);
  });

  it('hangs up exactly once immediately after Vox confirms final playback, never at generation completion', async () => {
    const { vox, provider } = await setup();
    await finishOpening(vox, provider);
    provider.server({ type: 'response.created', response: { id: 'rbye' } });
    provider.server({ type: 'response.output_text.delta', response_id: 'rbye', delta: 'Всего доброго.' });
    provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'bye' });
    provider.server({ type: 'response.done', response: { id: 'rbye' } });
    expect(vox.sent.filter((x) => x.action === 'hangup')).toHaveLength(0);
    sockets.find((s) => s.url.includes('elevenlabs')).server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(vox.sent.filter((x) => x.action === 'hangup')).toHaveLength(0);
    await speech(vox, 1000);
    expect(provider.sent.some((m: any) => m.type === 'response.cancel')).toBe(false);
    expect(vox.sent.filter((x) => x.action === 'hangup')).toHaveLength(0);
    vox.input({ customEvent: 'media_status', status: 'ended' });
    expect(vox.sent.filter((x) => x.action === 'hangup')).toHaveLength(1);
    vox.input({ customEvent: 'media_status', status: 'ended' });
    await vi.advanceTimersByTimeAsync(12000);
    expect(vox.sent.filter((x) => x.action === 'hangup')).toHaveLength(1);
  });

  it('does not wait again when final playback ended before end_call arrived', async () => {
    const { vox, provider } = await setup();
    await finishOpening(vox, provider);
    provider.server({ type: 'response.created', response: { id: 'rbye_late_tool' } });
    provider.server({ type: 'response.output_text.delta', delta: 'Всего доброго.' });
    sockets.find((s) => s.url.includes('elevenlabs')).server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
    await vi.advanceTimersByTimeAsync(1000);
    vox.input({ customEvent: 'media_status', status: 'ended' });
    expect(vox.sent.filter((x) => x.action === 'hangup')).toHaveLength(0);
    provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'late_bye' });
    provider.server({ type: 'response.done', response: { id: 'rbye_late_tool' } });
    expect(vox.sent.filter((x) => x.action === 'hangup')).toHaveLength(1);
  });

  it('measures first TTS audio and Vox playback from the same last-voice timestamp', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    await speech(vox, 1000); await vi.advanceTimersByTimeAsync(700);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'latency' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'latency', transcript: 'Да актуально.' });
    provider.server({ type: 'response.created', response: { id: 'rtiming' } });
    provider.server({ type: 'response.output_text.delta', response_id: 'rtiming', delta: 'Пробег актуальный?' });
    sockets.find((s) => s.url.includes('elevenlabs')).server({ audio: Buffer.alloc(800, 0xff).toString('base64') });
    vox.input({ customEvent: 'media_status', status: 'started' });
    provider.server({ type: 'response.output_text.done', response_id: 'rtiming', text: 'Пробег актуальный?' });
    const metrics = simulation.snapshot().transcript.at(-1)!.metrics;
    expect(metrics.speechToFirstAudioMs).toBeGreaterThanOrEqual(700);
    expect(metrics.speechToVoxPlaybackMs).toBe(metrics.speechToFirstAudioMs);
  });

  it('retries a filtered meta-answer using the actual garbled transcript', async () => {
    const { vox, provider } = await setup();
    await finishOpening(vox, provider);
    await speech(vox, 400); await vi.advanceTimersByTimeAsync(700);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'garbled' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'garbled', transcript: 'Который было не в любое время.' });
    await vi.advanceTimersByTimeAsync(600);
    provider.server({ type: 'response.created', response: { id: 'rmeta' } });
    provider.server({ type: 'response.output_text.delta', response_id: 'rmeta', delta: 'Сейчас быстро уточню это по делу, чтобы дальше было понятно, как смотреть машину.' });
    provider.server({ type: 'response.output_text.done', response_id: 'rmeta', text: 'Сейчас быстро уточню это по делу, чтобы дальше было понятно, как смотреть машину.' });
    provider.server({ type: 'response.done', response: { id: 'rmeta' } });
    expect(provider.sent.filter((x: any) => x.type === 'response.create').at(-1)?.response.instructions).toContain('только попросить повторить');
  });

  it('pins identity in the next request, the audio text and the recorded transcript', async () => {
    const { vox, provider, simulation } = await setup({
      prompt: 'Голос клиента: Женский. Для этого теста ты Анна, женщина.',
      openingText: 'Здравствуйте, меня зовут Анна. Звоню по машине.',
    });
    await finishOpening(vox, provider);
    await speech(vox, 400); await vi.advanceTimersByTimeAsync(700);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'robot' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'robot', transcript: 'А вы робот или живой человек?' });
    await vi.advanceTimersByTimeAsync(600);
    const instructions = provider.sent.filter((x: any) => x.type === 'response.create').at(-1)?.response.instructions;
    expect(instructions).toContain('неизменное имя клиента: «Анна»');
    expect(instructions).toContain('род клиента на весь звонок: женский');
    provider.server({ type: 'response.created', response: { id: 'ridentity' } });
    provider.server({ type: 'response.output_text.delta', delta: 'Меня зовут Алексей. Подскажите пробег.' });
    provider.server({ type: 'response.output_text.done', text: 'Меня зовут Алексей. Подскажите пробег.' });
    provider.server({ type: 'response.done', response: { id: 'ridentity' } });
    const voiceText = sockets.filter((s) => s.url.includes('elevenlabs')).flatMap((s) => s.sent).flatMap((m: any) => m.inputs ?? []).map((m: any) => m.text).join(' ');
    expect(voiceText).toContain('Меня зовут Анна');
    expect(voiceText).not.toContain('Меня зовут Алексей');
    expect(simulation.snapshot().transcript.at(-1)?.text).toContain('Меня зовут Анна');
  });

  it('confirms callback time as one TTS turn without clearing media', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    await speech(vox, 400); await vi.advanceTimersByTimeAsync(700);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'callback' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'callback', transcript: 'Я сейчас занят. Перезвоните, пожалуйста, завтра после десяти утра.' });
    await vi.advanceTimersByTimeAsync(600);
    provider.server({ type: 'response.created', response: { id: 'rcallback' } });
    provider.server({ type: 'response.output_item.added', item: { type: 'message', id: 'acallback' } });
    provider.server({ type: 'response.output_text.delta', delta: 'Хорошо, перезвоню завтра после десяти.' });
    provider.server({ type: 'response.output_text.done', text: 'Хорошо, перезвоню завтра после десяти.' });
    provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'callbacktool' });
    provider.server({ type: 'response.done', response: { id: 'rcallback' } });
    const final = simulation.snapshot().transcript.filter((t) => t.role === 'client').at(-1)!;
    expect(final.text).toBe('Хорошо, перезвоню завтра после десяти утра. До свидания.');
    expect(vox.sent.filter((x) => x.action === 'clear_media')).toHaveLength(0);
    const payloads = sockets.filter((s) => s.url.includes('elevenlabs')).flatMap((s) => s.sent).filter((m: any) => m.inputs?.some((i: any) => i.text.includes('перезвоню')));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].inputs[0].new_turn).toBe(true);
    expect(provider.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'acallback' });
  });

  it('appends a missing goodbye to useful final text rather than replacing or chopping it', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    provider.server({ type: 'response.created', response: { id: 'rfinish' } });
    provider.server({ type: 'response.output_text.delta', delta: 'Спасибо, условия мне подходят.' });
    provider.server({ type: 'response.output_text.done', text: 'Спасибо, условия мне подходят.' });
    provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'finish' });
    provider.server({ type: 'response.done', response: { id: 'rfinish' } });
    expect(simulation.snapshot().transcript.at(-1)?.text).toBe('Спасибо, условия мне подходят. До свидания.');
    expect(vox.sent.filter((x) => x.action === 'clear_media')).toHaveLength(0);
    const texts = sockets.filter((s) => s.url.includes('elevenlabs')).flatMap((s) => s.sent).flatMap((m: any) => m.inputs ?? []);
    expect(texts.at(-1).text.trim()).toBe('До свидания.');
    expect(texts.at(-1).new_turn).toBe(false);
  });

  it('replaces a speculative interpretation of garbled speech with a neutral clarification', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    await speech(vox, 400); await vi.advanceTimersByTimeAsync(700);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'unclear' });
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unclear', transcript: 'Который было не в любое время.' });
    await vi.advanceTimersByTimeAsync(600);
    provider.server({ type: 'response.created', response: { id: 'runclear' } });
    provider.server({ type: 'response.output_item.added', item: { type: 'message', id: 'aunclear' } });
    provider.server({ type: 'response.output_text.delta', delta: 'Вы про время визита? Во сколько приедете?' });
    provider.server({ type: 'response.output_text.done', text: 'Вы про время визита? Во сколько приедете?' });
    provider.server({ type: 'response.done', response: { id: 'runclear' } });
    expect(simulation.snapshot().transcript.at(-1)?.text).toBe('Не совсем слышно. Повторите, пожалуйста.');
    const texts = sockets.filter((s) => s.url.includes('elevenlabs')).flatMap((s) => s.sent).flatMap((m: any) => m.inputs ?? []).map((m: any) => m.text).join(' ');
    expect(texts).not.toContain('время визита');
    expect(provider.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'aunclear' });
  });

  it('treats a correlated late cancellation as a diagnostic, but preserves real errors', async () => {
    const { vox, provider, simulation } = await setup();
    await speech(vox, 1000);
    const cancel = provider.sent.find((x: any) => x.type === 'response.cancel');
    expect(cancel.response_id).toBe('r1');
    provider.server({ type: 'error', error: { event_id: cancel.event_id, code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found' } });
    expect(simulation.snapshot().errors).toEqual([]);
    expect(simulation.snapshot().transcript.find((x) => x.metrics.interrupted)?.metrics.cancelRaceCount).toBe(1);
    provider.server({ type: 'error', error: { code: 'server_error', message: 'Server failed' } });
    expect(simulation.snapshot().errors).toContain('OpenAI: Server failed');
  });

  it('checks a late ASR transcript before emitting already-generated speculative audio', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    await speech(vox, 400); await vi.advanceTimersByTimeAsync(700);
    provider.server({ type: 'input_audio_buffer.committed', item_id: 'late_unclear' });
    await vi.advanceTimersByTimeAsync(400);
    const inputCount = () => sockets.filter((s) => s.url.includes('elevenlabs')).flatMap((s) => s.sent).flatMap((m: any) => m.inputs ?? []).length;
    const before = inputCount();
    provider.server({ type: 'response.created', response: { id: 'rlate_unclear' } });
    provider.server({ type: 'response.output_item.added', item: { type: 'message', id: 'alate_unclear' } });
    provider.server({ type: 'response.output_text.delta', delta: 'Вы про время визита? Во сколько приедете?' });
    provider.server({ type: 'response.output_text.done', text: 'Вы про время визита? Во сколько приедете?' });
    provider.server({ type: 'response.done', response: { id: 'rlate_unclear' } });
    expect(inputCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(200);
    provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late_unclear', transcript: 'Который было не в любое время.' });
    expect(simulation.snapshot().transcript.at(-1)?.text).toBe('Не совсем слышно. Повторите, пожалуйста.');
    expect(simulation.snapshot().transcript.at(-1)?.metrics.responseOutputGuardMs).toBe(200);
    expect(inputCount()).toBe(before + 1);
  });

  it('does not silently discard an unsolicited no-active-response error', async () => {
    const { provider, simulation } = await setup();
    provider.server({ type: 'error', error: { code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found' } });
    expect(simulation.snapshot().errors).toHaveLength(1);
  });

  it('filters a split technical closing and sends exactly one farewell through TTS', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    const voiceInputs = () => sockets.filter((s) => s.url.includes('elevenlabs')).flatMap((s) => s.sent).flatMap((m: any) => m.inputs ?? []);
    const before = voiceInputs().length;
    provider.server({ type: 'response.created', response: { id: 'rclosing' } });
    for (const delta of ['Зафикси', 'рую договорённость и закроем ', 'разговор. ']) {
      provider.server({ type: 'response.output_text.delta', response_id: 'rclosing', delta });
    }
    expect(voiceInputs()).toHaveLength(before);
    for (const delta of ['Спасибо, до свидания. ', 'Всего доброго.']) {
      provider.server({ type: 'response.output_text.delta', response_id: 'rclosing', delta });
    }
    provider.server({ type: 'response.output_text.done', response_id: 'rclosing', text: 'Зафиксирую договорённость и закроем разговор. Спасибо, до свидания. Всего доброго.' });
    provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'closing', arguments: '{}' });
    provider.server({ type: 'response.done', response: { id: 'rclosing' } });
    expect(voiceInputs().slice(before)).toHaveLength(1);
    expect(voiceInputs().at(-1).text.trim()).toBe('Спасибо, до свидания.');
    expect(voiceInputs().at(-1).new_turn).toBe(true);
    expect(simulation.snapshot().transcript.filter((t) => t.role === 'client').at(-1)?.text).toBe('Спасибо, до свидания.');
    expect(vox.sent.filter((m) => m.action === 'clear_media')).toHaveLength(0);
  });

  it('sends a natural fallback once for a technical-only closing, without generating another model answer', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    const before = provider.sent.filter((m: any) => m.type === 'response.create').length;
    provider.server({ type: 'response.created', response: { id: 'ronlyclosing' } });
    provider.server({ type: 'response.output_text.delta', delta: 'Зафиксирую договорённость и закроем разговор.' });
    provider.server({ type: 'response.output_text.done', text: 'Зафиксирую договорённость и закроем разговор.' });
    provider.server({ type: 'response.done', response: { id: 'ronlyclosing' } });
    const turns = simulation.snapshot().transcript.filter((t) => t.role === 'client');
    expect(turns).toHaveLength(2); // Opening + one server farewell.
    expect(turns.at(-1)?.text).toBe('Спасибо за ответы, всего доброго.');
    expect(provider.sent.filter((m: any) => m.type === 'response.create')).toHaveLength(before);
  });

  it('keeps a useful agreement and appends the goodbye to the same turn after filtering a closing intention', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    provider.server({ type: 'response.created', response: { id: 'rconfirmclosing' } });
    const text = 'Договорились, завтра к пяти. Зафиксирую договорённость и закроем разговор.';
    provider.server({ type: 'response.output_text.delta', delta: text });
    provider.server({ type: 'response.output_text.done', text });
    provider.server({ type: 'response.done', response: { id: 'rconfirmclosing' } });
    expect(simulation.snapshot().transcript.at(-1)?.text).toBe('Договорились, завтра к пяти. До свидания.');
    const texts = sockets.filter((s) => s.url.includes('elevenlabs')).flatMap((s) => s.sent).flatMap((m: any) => m.inputs ?? []);
    expect(texts.at(-1).text.trim()).toBe('До свидания.');
    expect(texts.at(-1).new_turn).toBe(false);
  });

  it('finishes after a spoken goodbye even if the model omitted end_call, without a second goodbye', async () => {
    const { vox, provider, simulation } = await setup();
    await finishOpening(vox, provider);
    const before = provider.sent.filter((m: any) => m.type === 'response.create').length;
    provider.server({ type: 'response.created', response: { id: 'rbye_no_tool' } });
    provider.server({ type: 'response.output_text.delta', delta: 'Договорились, завтра к пяти. До свидания.' });
    provider.server({ type: 'response.output_text.done', text: 'Договорились, завтра к пяти. До свидания.' });
    provider.server({ type: 'response.done', response: { id: 'rbye_no_tool' } });
    sockets.find((s) => s.url.includes('elevenlabs')).server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
    await vi.advanceTimersByTimeAsync(1000);
    vox.input({ customEvent: 'media_status', status: 'ended' });
    await speech(vox, 400); await vi.advanceTimersByTimeAsync(2000);
    expect(vox.sent.filter((m) => m.action === 'hangup')).toHaveLength(1);
    expect(provider.sent.filter((m: any) => m.type === 'response.create')).toHaveLength(before);
    expect(simulation.snapshot().transcript.filter((t) => t.role === 'client')).toHaveLength(2);
  });
});
