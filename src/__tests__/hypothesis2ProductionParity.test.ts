import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { handleCometRealtimeTestSocket, handleCometRealtimeTestWebhook, handleStartCometRealtimeTest, handleGetCometRealtimeTest,
  prepareProductionOpenAiRealtimeCall, updateProductionRealtimeLifecycle, createCallPlanSimulation } from '../voice/cometRealtimeTest';

const mocks = vi.hoisted(() => ({ sockets: [] as any[], failuresRemaining: 0, acknowledgeHistory: true, handshake: true, start: vi.fn(),
  plan: { planId: 'plan', planName: 'План', prompt: 'Ты Анна, женщина. Звонишь по Kia Carnival. Уточни цену.',
    elevenLabsVoiceId: 'profile-voice', customerVoiceId: 'voice-row', subjectTitle: 'Kia Carnival', subjectDescription: null },
  tts: { modelId: 'eleven_v4_turbo', defaultVoiceId: 'agent-default', stability: 0.75, similarityBoost: 0.75, speed: 1.13,
    source: 'agent' as const, optimizeStreamingLatency: 0, pronunciationDictionaryLocators: [] },
}));
vi.mock('../voice/callSettingsManagement', () => ({ resolveRealtimeTestPlanConfiguration: async () => mocks.plan }));
vi.mock('../voice/startVoiceCall', () => ({ startVoiceCall: mocks.start }));
vi.mock('../voice/yandexRealtimeTest', async (original) => ({ ...await original<typeof import('../voice/yandexRealtimeTest')>(), resolveAgentTtsSettings: async () => mocks.tts }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
    readyState = 1; sent: any[] = []; url: string;
    constructor(url: string | URL) {
      super(); this.url = String(url); mocks.sockets.push(this);
      queueMicrotask(() => {
        if (this.url.includes('/realtime') && mocks.failuresRemaining > 0) { mocks.failuresRemaining--; this.close(); return; }
        this.emit('open');
        if (this.url.includes('/realtime')) this.server({ type: 'session.created' });
      });
    }
    server(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
    send(raw: string) {
      const value = JSON.parse(raw); this.sent.push(value);
      if (value.type === 'session.update' && mocks.handshake) queueMicrotask(() => this.server({ type: 'session.updated' }));
      if (value.type === 'conversation.item.create' && value.item?.id?.startsWith('restore_') && mocks.acknowledgeHistory) {
        queueMicrotask(() => this.server({ type: 'conversation.item.created', item: value.item }));
      }
    }
    drop(code = 1006) { this.readyState = 3; this.emit('close', code, Buffer.from('')); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000, Buffer.from('closed')); }
  }
  return { default: Socket };
});
class Vox extends EventEmitter {
  readyState = 1; sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  input(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  close() { this.readyState = 3; this.emit('close'); }
}
const original = { key: config.openaiRealtimeApiKey, eleven: config.elevenLabsApiKey, model: config.openaiRealtimeModel,
  endpoint: config.openaiRealtimeEndpointSilenceMs, longEndpoint: config.openaiRealtimeLongTurnEndpointSilenceMs };
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.sockets.length = 0; mocks.failuresRemaining = 0;
  mocks.acknowledgeHistory = true; mocks.handshake = true;
  config.openaiRealtimeApiKey = 'test'; config.elevenLabsApiKey = 'test'; config.openaiRealtimeModel = 'gpt-realtime-2';
  config.openaiRealtimeEndpointSilenceMs = 400; config.openaiRealtimeLongTurnEndpointSilenceMs = 650;
  mocks.start.mockImplementation(async (_phone, options) => ({ callId: options.callId, scenario: options.scenario, startedAt: new Date().toISOString() }));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const socket of mocks.sockets) socket.close();
  vi.useRealTimers();
  config.openaiRealtimeApiKey = original.key; config.elevenLabsApiKey = original.eleven; config.openaiRealtimeModel = original.model;
  config.openaiRealtimeEndpointSilenceMs = original.endpoint; config.openaiRealtimeLongTurnEndpointSilenceMs = original.longEndpoint;
});

async function launch(mode: 'test' | 'production') {
  const offset = mocks.sockets.length;
  const vox = new Vox();
  let callId: string; let token: string; let snapshot: () => any;
  if (mode === 'production') {
    callId = 'production-parity';
    const pending = prepareProductionOpenAiRealtimeCall({ callId, phone: '+79507503215', plan: mocks.plan });
    await vi.advanceTimersByTimeAsync(0);
    const prepared = await pending; token = prepared.streamToken;
    snapshot = prepared.snapshot;
    prepared.markDialing(new Date().toISOString());
    updateProductionRealtimeLifecycle(callId, 'connected', new Date().toISOString());
    cleanups.push(() => { vox.close(); prepared.dispose(); });
  } else {
    let status = 200; let result: any;
    const res = { status(code: number) { status = code; return this; }, json(value: any) { result = value; } };
    const pending = handleStartCometRealtimeTest({ body: { provider: 'openai', planId: 'plan', to: '+79507503215', model: config.openaiRealtimeModel } } as Request, res as Response);
    await vi.advanceTimersByTimeAsync(0); await pending;
    expect(status).toBe(200); callId = result.callId; token = mocks.start.mock.calls.at(-1)![1].streamToken;
    snapshot = () => {
      let value: any;
      handleGetCometRealtimeTest({ params: { callId } } as unknown as Request, { json(data: any) { value = data; } } as Response);
      return value;
    };
    cleanups.push(() => { vox.close(); handleCometRealtimeTestWebhook({ body: { call_id: callId, event: 'disconnected' } } as Request, { status: () => ({ end: () => {} }) } as unknown as Response); });
  }
  handleCometRealtimeTestSocket(vox as unknown as WebSocket, `/voice/${mode === 'test' ? 'comet-realtime-test' : 'openai-realtime'}?call_id=${callId}&token=${token}`);
  const sockets = mocks.sockets.slice(offset);
  return { vox, provider: sockets.filter(socket => socket.url.includes('/realtime')).at(-1), tts: sockets.find(socket => socket.url.includes('elevenlabs')), sockets, snapshot };
}

const managerAudio = Buffer.alloc(640);
for (let index = 0; index < 320; index++) managerAudio.writeInt16LE(index % 2 ? 4000 : -4000, index * 2);
async function commitManagerFragment(pair: Awaited<ReturnType<typeof launch>>, itemId: string) {
  for (let index = 0; index < 8; index++) {
    pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
    if (index < 7) await vi.advanceTimersByTimeAsync(20);
  }
  const commits = pair.provider.sent.filter((event: any) => event.type === 'input_audio_buffer.commit').length;
  await vi.advanceTimersByTimeAsync(400);
  expect(pair.provider.sent.filter((event: any) => event.type === 'input_audio_buffer.commit')).toHaveLength(commits + 1);
  pair.provider.server({ type: 'input_audio_buffer.committed', item_id: itemId });
}
const spokenInputs = (pair: Awaited<ReturnType<typeof launch>>) => pair.tts.sent
  .flatMap((event: any) => (event.inputs ?? []).map((input: any) => input.text)).join('').trim();
const voicedOutput = (pair: Awaited<ReturnType<typeof launch>>) => pair.vox.sent.some((event: any) => event.event === 'media');
async function askManagerQuestion(pair: Awaited<ReturnType<typeof launch>>) {
  pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
  pair.provider.server({ type: 'response.created', response: { id: 'opening-question' } });
  pair.provider.server({ type: 'response.output_text.delta', response_id: 'opening-question', delta: 'Что по порогам — не сильно ли гнилые?' });
  pair.provider.server({ type: 'response.done', response: { id: 'opening-question' } });
  pair.tts.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
  pair.vox.input({ customEvent: 'media_status', status: 'started' });
  await vi.advanceTimersByTimeAsync(1000);
  pair.vox.input({ customEvent: 'media_status', status: 'ended' });
  pair.tts.sent.length = 0;
}

describe('actual hypothesis-2 and production launch parity (no live providers)', () => {
  it('uses the real production session/configuration for a plan simulation without dialing', async () => {
    config.openaiRealtimeModel = 'gpt-realtime-2.1';
    const production = await launch('production');
    const dialCount = mocks.start.mock.calls.length;
    const offset = mocks.sockets.length;
    const vox = new Vox();
    const pending = createCallPlanSimulation(mocks.plan, vox as unknown as WebSocket, mocks.tts);
    await vi.advanceTimersByTimeAsync(0);
    const simulation = await pending;
    cleanups.push(simulation.close);
    const sockets = mocks.sockets.slice(offset);
    const provider = sockets.find((socket) => socket.url.includes('/realtime'));
    const tts = sockets.find((socket) => socket.url.includes('elevenlabs'));
    expect(mocks.start).toHaveBeenCalledTimes(dialCount);
    expect(provider.url).toBe(production.provider.url);
    expect(provider.sent.find((event: any) => event.type === 'session.update'))
      .toEqual(production.provider.sent.find((event: any) => event.type === 'session.update'));
    expect(tts.url).toBe(production.tts.url);
    expect(tts.sent).toEqual(production.tts.sent);
    expect(simulation.snapshot()).toMatchObject({ model: 'gpt-realtime-2.1', phone: 'simulation', planId: 'plan' });
  });
  it.each(['gpt-realtime-2', 'gpt-realtime-2.1'])('uses identical OpenAI instructions, tools and ElevenLabs settings for %s', async (model) => {
    config.openaiRealtimeModel = model;
    const test = await launch('test'); const production = await launch('production');
    expect(production.provider.url).toBe(test.provider.url);
    expect(production.provider.sent.find((event: any) => event.type === 'session.update'))
      .toEqual(test.provider.sent.find((event: any) => event.type === 'session.update'));
    expect(production.tts.url).toBe(test.tts.url);
    expect(production.tts.sent).toEqual(test.tts.sent);
    for (const pair of [test, production]) {
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'r1' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'r1', delta: 'Спасибо, до свидания.' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'end' });
      pair.provider.server({ type: 'response.done', response: { id: 'r1' } });
      pair.tts.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
      pair.vox.input({ customEvent: 'media_status', status: 'ended' });
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
    }
    expect(production.tts.sent).toEqual(test.tts.sent);
    expect(production.vox.sent).toEqual(test.vox.sent);
  });
  it('retries preflight in production just as on the hypothesis screen', async () => {
    mocks.failuresRemaining = 1; const test = await launch('test');
    mocks.failuresRemaining = 1; const production = await launch('production');
    for (const pair of [test, production]) {
      const providers = pair.sockets.filter(socket => socket.url.includes('/realtime'));
      expect(providers).toHaveLength(2);
      expect(providers[0].readyState).toBe(3); expect(providers[1].readyState).toBe(1);
    }
  });

  const closingRegressions = [
    'Хорошо, тогда я коротко сориентируюсь и аккуратно подвезу разговор к завершению. До свидания.',
    'Хорошо, давайте тогда коротко закрепим договорённость и аккуратно подведём разговор к завершению. До свидания.',
  ];
  for (const mode of ['test', 'production'] as const) {
    const replacementProvider = () => mocks.sockets.filter(socket => socket.url.includes('/realtime')).at(-1);
    it(`${mode}: restores a live session's heard history after 1006 without dialing or repeating tools`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      const calls = mocks.start.mock.calls.length;
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      const replacement = replacementProvider();
      expect(replacement).not.toBe(pair.provider);
      expect(replacement.url).toBe(pair.provider.url);
      expect(replacement.sent.find((event: any) => event.type === 'session.update'))
        .toEqual(pair.provider.sent.find((event: any) => event.type === 'session.update'));
      const history = replacement.sent.filter((event: any) => event.type === 'conversation.item.create');
      expect(history.map((event: any) => event.item.role)).toEqual(['user', 'assistant']);
      expect(history.map((event: any) => event.item.content[0].text)).toEqual(['Алло, слушаю.', 'Что по порогам — не сильно ли гнилые?']);
      expect(history.every((event: any) => event.item.type === 'message')).toBe(true);
      expect(replacement.sent.some((event: any) => event.type === 'response.create')).toBe(false);
      expect(mocks.start).toHaveBeenCalledTimes(calls);
      const recovered = { ...pair, provider: replacement };
      await commitManagerFragment(recovered, 'after-reconnect');
      replacement.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'after-reconnect', transcript: 'Нет, не гнилые.' });
      expect(replacement.sent.some((event: any) => event.type === 'response.create')).toBe(true);
      expect(pair.snapshot().conversationFlow.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'provider_disconnected' }),
        expect.objectContaining({ type: 'provider_reconnected' }),
      ]));
    });
    it(`${mode}: waits for every history ACK and buffers new manager speech until restored`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      mocks.acknowledgeHistory = false;
      pair.provider.drop();
      expect(pair.snapshot().status).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(0);
      const replacement = replacementProvider();
      const history = replacement.sent.filter((event: any) => event.item?.id?.startsWith('restore_'));
      for (let index = 0; index < 8; index++) {
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
        await vi.advanceTimersByTimeAsync(20);
      }
      await vi.advanceTimersByTimeAsync(400);
      expect(replacement.sent.some((event: any) => event.type.startsWith('input_audio_buffer.'))).toBe(false);
      replacement.server({ type: 'conversation.item.added', item: history[1].item });
      replacement.server({ type: 'conversation.item.done', item: history[1].item }); // duplicate ACK
      expect(replacement.sent.some((event: any) => event.type === 'input_audio_buffer.commit')).toBe(false);
      replacement.server({ type: 'conversation.item.created', item: history[0].item });
      expect(replacement.sent.filter((event: any) => event.type === 'input_audio_buffer.append')).toHaveLength(8);
      expect(replacement.sent.filter((event: any) => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
      expect(replacement.sent.some((event: any) => event.type === 'response.create')).toBe(false);
      replacement.server({ type: 'input_audio_buffer.committed', item_id: 'recovered-audio' });
      replacement.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'recovered-audio', transcript: 'Нет, не было.' });
      expect(replacement.sent.some((event: any) => event.type === 'response.create')).toBe(true);
    });
    it(`${mode}: does not restore a generated but unheard question, resumes the pending answer`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'answer');
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer', transcript: 'Нет, не было.' });
      pair.provider.server({ type: 'response.created', response: { id: 'cut-off' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'cut-off', delta: 'Хорошо. А когда можно приехать?' });
      pair.provider.server({ type: 'response.done', response: { id: 'cut-off' } });
      pair.provider.drop(); // text generated, but no audio has arrived
      await vi.advanceTimersByTimeAsync(0);
      const replacement = replacementProvider();
      const history = replacement.sent.filter((event: any) => event.item?.id?.startsWith('restore_'));
      expect(history.map((event: any) => event.item.content[0].text).join(' ')).not.toContain('когда можно приехать');
      expect(replacement.sent.some((event: any) => event.type === 'input_audio_buffer.append')).toBe(false);
      expect(replacement.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      expect(replacement.sent.find((event: any) => event.type === 'response.create').response.instructions).toContain('Непрозвучавший вопрос не считай заданным');
      expect(pair.snapshot().transcript.at(-1).metrics.heardTextOnInterruption).toBe('');
    });
    it.each(['before-commit', 'awaiting-commit-ack', 'awaiting-asr'] as const)(`${mode}: replays only unrecognized manager audio lost %s`, async (stage) => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      for (let index = 0; index < 8; index++) {
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
        await vi.advanceTimersByTimeAsync(20);
      }
      if (stage !== 'before-commit') await vi.advanceTimersByTimeAsync(400);
      if (stage === 'awaiting-asr') pair.provider.server({ type: 'input_audio_buffer.committed', item_id: 'lost-input' });
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      const replacement = replacementProvider();
      expect(replacement.sent.filter((event: any) => event.type === 'input_audio_buffer.append')).toHaveLength(8);
      if (stage === 'before-commit') {
        expect(replacement.sent.some((event: any) => event.type === 'input_audio_buffer.commit')).toBe(false);
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(replacement.sent.filter((event: any) => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
      expect(replacement.sent.some((event: any) => event.type === 'response.create')).toBe(false);
      replacement.server({ type: 'input_audio_buffer.committed', item_id: 'replayed-input' });
      replacement.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'replayed-input', transcript: 'Нет, не было.' });
      expect(replacement.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'manager' && turn.text === 'Нет, не было.')).toHaveLength(1);
    });
    it(`${mode}: ignores old socket output and tool events after replacement`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      const before = JSON.stringify(pair.snapshot().transcript);
      pair.provider.server({ type: 'response.created', response: { id: 'stale' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'stale', delta: 'Новая ненужная реплика.' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'send_dtmf', call_id: 'stale-tool', arguments: '{"digit":"1"}' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'stale-end', arguments: '{}' });
      pair.provider.server({ type: 'response.done', response: { id: 'stale' } });
      expect(JSON.stringify(pair.snapshot().transcript)).toBe(before);
      expect(pair.vox.sent.some((event: any) => ['hangup', 'send_dtmf'].includes(event.action))).toBe(false);
      expect(spokenInputs(pair)).toBe('');
    });
    it(`${mode}: restores only the aligned heard prefix when speech is cut off`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'answer');
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer', transcript: 'Нет, не было.' });
      pair.provider.server({ type: 'response.created', response: { id: 'partial' } });
      const text = 'Хорошо. А когда можно приехать?';
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'partial', delta: text });
      pair.provider.server({ type: 'response.done', response: { id: 'partial' } });
      pair.tts.server({ audio: Buffer.alloc(24_000, 0xff).toString('base64'), normalizedAlignment: {
        chars: [...text], char_start_times_ms: [...text].map((_, i) => i * 100), char_durations_ms: [...text].map(() => 100),
      } });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      await vi.advanceTimersByTimeAsync(1000);
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      const restored = replacementProvider().sent.filter((event: any) => event.item?.id?.startsWith('restore_'));
      expect(restored.at(-1).item.content[0].text).toBe('Хорошо.');
      expect(pair.snapshot().transcript.at(-1).text).toBe('Хорошо.');
      expect(pair.vox.sent).toContainEqual({ customEvent: 'control', action: 'clear_media' });
    });
    it(`${mode}: a new answer during recovery wins over the interrupted pending answer`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'answer');
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer', transcript: 'Нет, не было.' });
      pair.provider.server({ type: 'response.created', response: { id: 'not-heard' } });
      mocks.acknowledgeHistory = false;
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      const replacement = replacementProvider();
      for (let index = 0; index < 8; index++) {
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
        await vi.advanceTimersByTimeAsync(20);
      }
      await vi.advanceTimersByTimeAsync(400);
      for (const event of replacement.sent.filter((event: any) => event.item?.id?.startsWith('restore_'))) {
        replacement.server({ type: 'conversation.item.created', item: event.item });
      }
      expect(replacement.sent.filter((event: any) => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
      expect(replacement.sent.some((event: any) => event.type === 'response.create')).toBe(false);
      replacement.server({ type: 'input_audio_buffer.committed', item_id: 'new-answer' });
      replacement.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-answer', transcript: 'Да, уточню.' });
      expect(replacement.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      expect(replacement.sent.find((event: any) => event.type === 'response.create').response.instructions).toContain('Да, уточню.');
    });
    it(`${mode}: retries rejected history, but keeps a whole-call two-reconnect limit`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      mocks.acknowledgeHistory = false;
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      const rejected = replacementProvider();
      mocks.acknowledgeHistory = true;
      rejected.server({ type: 'error', error: { message: 'History rejected' } });
      await vi.advanceTimersByTimeAsync(0);
      const replacement = replacementProvider();
      expect(replacement).not.toBe(rejected);
      expect(pair.snapshot().conversationFlow.events.some((event: any) => event.type === 'provider_reconnected')).toBe(true);
      replacement.drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.sockets.filter(socket => socket.url.includes('/realtime'))).toHaveLength(3);
      expect(pair.snapshot().conversationFlow.events.some((event: any) => event.type === 'provider_recovery_failed')).toBe(true);
    });
    it(`${mode}: does not unmute IVR or replay a completed DTMF after reconnecting`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ivr', transcript: 'Для отдела продаж нажмите 1.' });
      pair.provider.server({ type: 'response.created', response: { id: 'ivr' } });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'send_dtmf', arguments: '{"digit":"1"}', call_id: 'digit' });
      pair.provider.server({ type: 'response.done', response: { id: 'ivr' } });
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(pair.vox.sent.filter((event: any) => event.action === 'send_dtmf')).toHaveLength(1);
      expect(pair.vox.sent.some((event: any) => event.action === 'set_output_enabled' && event.enabled)).toBe(false);
      expect(replacementProvider().sent.some((event: any) => event.type === 'response.create')).toBe(false);
      expect(spokenInputs(pair)).toBe('');
    });
    it(`${mode}: an accepted voicemail ending still hangs up silently on provider loss`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ivr', transcript: 'Оставьте сообщение после сигнала.' });
      pair.provider.server({ type: 'response.created', response: { id: 'voicemail' } });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'skip_turn', arguments: '{"kind":"waiting"}', call_id: 'wait' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'end' });
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.sockets.filter(socket => socket.url.includes('/realtime'))).toHaveLength(1);
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
      expect(spokenInputs(pair)).toBe('');
    });
    it.each(['handshake', 'history', 'disconnect'] as const)(`${mode}: bounded recovery on %s failure ends naturally instead of permanent silence`, async (failure) => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      if (failure === 'handshake') mocks.handshake = false;
      if (failure === 'history') mocks.acknowledgeHistory = false;
      if (failure === 'disconnect') mocks.failuresRemaining = 3;
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.sockets.filter(socket => socket.url.includes('/realtime'))).toHaveLength(3);
      expect(pair.snapshot().conversationFlow.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'provider_recovery_failed' })]));
      expect(pair.snapshot().status).toBe('ending');
      expect(mocks.sockets.flatMap(socket => socket.sent).flatMap((event: any) => (event.inputs ?? []).map((input: any) => input.text)).join(' '))
        .toContain('Извините, связь прервалась. До свидания.');
      await vi.advanceTimersByTimeAsync(6_000);
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
    });
    it(`${mode}: closes immediately after failure-farewell playback, without waiting for the fallback timer`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      mocks.failuresRemaining = 3;
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      const speech = mocks.sockets.filter(socket => socket.url.includes('elevenlabs')).at(-1);
      speech.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
      pair.vox.input({ customEvent: 'media_status', status: 'ended' });
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
    });
    it(`${mode}: an accepted end_call finishes its audio without reconnecting, even without response.done`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'final' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'final', delta: 'Спасибо, до свидания.' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'end' });
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.sockets.filter(socket => socket.url.includes('/realtime'))).toHaveLength(1);
      pair.tts.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
      pair.vox.input({ customEvent: 'media_status', status: 'ended' });
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
    });
    it(`${mode}: cancels recovery deadlines when the phone disconnects`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      mocks.handshake = false;
      pair.provider.drop();
      await vi.advanceTimersByTimeAsync(0);
      pair.vox.close();
      const sockets = mocks.sockets.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.sockets).toHaveLength(sockets);
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
    });
    it(`${mode}: e0af2255 late unfinished ASR cancels unheard output and merges the continuation`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'fragment-1');
      await vi.advanceTimersByTimeAsync(350);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      pair.provider.server({ type: 'response.created', response: { id: 'premature' } });
      pair.provider.server({ type: 'response.output_item.added', response_id: 'premature', item: { id: 'unheard-question', type: 'message' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'premature', delta: 'Спасибо. А по ДТП что-то было?' });
      await vi.advanceTimersByTimeAsync(433);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'fragment-1', transcript: 'Нет, ничего не...' });
      expect(spokenInputs(pair)).toBe('');
      expect(pair.provider.sent).toContainEqual(expect.objectContaining({ type: 'response.cancel', response_id: 'premature' }));
      expect(pair.provider.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'unheard-question' });
      // A generated-but-buffered terminal tool must be discarded too.
      pair.provider.server({ type: 'response.function_call_arguments.done', response_id: 'premature', name: 'end_call', call_id: 'stale-end', arguments: '{}' });
      pair.provider.server({ type: 'response.done', response: { id: 'premature', status: 'cancelled' } });
      await vi.advanceTimersByTimeAsync(300);
      await commitManagerFragment(pair, 'fragment-2');
      await vi.advanceTimersByTimeAsync(200);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'fragment-2', transcript: 'Нет, не было.' });
      const answers = pair.snapshot().transcript.filter((turn: any) => turn.role === 'manager' && turn.text.startsWith('Нет'));
      expect(answers).toHaveLength(1);
      expect(answers[0].text).toBe('Нет, ничего не... Нет, не было.');
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'client')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      const requests = pair.provider.sent.filter((event: any) => event.type === 'response.create');
      expect(requests).toHaveLength(2);
      expect(requests.at(-1).response.instructions).toContain('Нет, ничего не... Нет, не было.');
      pair.provider.server({ type: 'response.created', response: { id: 'valid-next' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'valid-next', delta: 'Хорошо. По цене возможна скидка?' });
      pair.provider.server({ type: 'response.done', response: { id: 'valid-next' } });
      expect(spokenInputs(pair)).toBe('Хорошо. По цене возможна скидка?');
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
    });
    it(`${mode}: late complete short ASR releases the existing response immediately without regenerating it`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'complete-answer');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'complete-response' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'complete-response', delta: 'Хорошо. Возможна скидка?' });
      pair.provider.server({ type: 'response.done', response: { id: 'complete-response' } });
      expect(spokenInputs(pair)).toBe('');
      await vi.advanceTimersByTimeAsync(557);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'complete-answer', transcript: 'Нет, не было.' });
      expect(spokenInputs(pair)).toBe('Хорошо. Возможна скидка?');
      expect(pair.provider.sent.some((event: any) => event.type === 'response.cancel')).toBe(false);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
    });
    it(`${mode}: timely complete short ASR starts a response without adding continuation grace`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'timely-answer');
      await vi.advanceTimersByTimeAsync(200);
      expect(pair.provider.sent.some((event: any) => event.type === 'response.create')).toBe(false);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'timely-answer', transcript: 'Нет, не было.' });
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      pair.provider.server({ type: 'response.created', response: { id: 'timely-response' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'timely-response', delta: 'Хорошо. Возможна скидка?' });
      expect(spokenInputs(pair)).toBe('Хорошо. Возможна скидка?');
      await vi.advanceTimersByTimeAsync(1200);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
    });
    it(`${mode}: cancels a speculative request even when response.created arrives after unfinished ASR`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'pending-answer');
      await vi.advanceTimersByTimeAsync(783);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'pending-answer', transcript: 'Нет, ничего не' });
      pair.provider.server({ type: 'response.created', response: { id: 'late-created' } });
      pair.provider.server({ type: 'response.output_item.added', response_id: 'late-created', item: { id: 'late-unheard-item', type: 'message' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'late-created', delta: 'А по ДТП что-то было?' });
      expect(pair.provider.sent).toContainEqual(expect.objectContaining({ type: 'response.cancel', response_id: 'late-created' }));
      expect(pair.provider.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'late-unheard-item' });
      pair.provider.server({ type: 'response.done', response: { id: 'late-created', status: 'cancelled' } });
      expect(spokenInputs(pair)).toBe('');
      await vi.advanceTimersByTimeAsync(1200);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(2);
    });
    it(`${mode}: consumes buffered completion and removes unheard tool context instead of waiting for cancellation`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'finished-speculation');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'finished-unheard' } });
      pair.provider.server({ type: 'response.output_item.added', response_id: 'finished-unheard', item: { id: 'unheard-tool-item', type: 'function_call' } });
      pair.provider.server({ type: 'response.function_call_arguments.done', response_id: 'finished-unheard', name: 'end_call', call_id: 'unheard-end', arguments: '{}' });
      pair.provider.server({ type: 'response.done', response: { id: 'finished-unheard', status: 'completed', usage: { total_tokens: 100 } } });
      await vi.advanceTimersByTimeAsync(433);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'finished-speculation', transcript: 'Нет, ничего не...' });
      expect(pair.provider.sent.some((event: any) => event.type === 'response.cancel')).toBe(false);
      expect(pair.provider.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'unheard-tool-item' });
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
      if (mode === 'production') expect(pair.snapshot().usage).toContainEqual({ responseId: 'finished-unheard', usage: { total_tokens: 100 } });
      await vi.advanceTimersByTimeAsync(1200);
      // No response.done/cancellation acknowledgement is forthcoming; the
      // next response must still be able to start after the bounded grace.
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(2);
      expect(spokenInputs(pair)).toBe('');
    });
    it(`${mode}: captures a short continuation before late ASR without requiring a sustained barge-in`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'before-resume');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'before-resume-response' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'before-resume-response', delta: 'А по ДТП что-то было?' });
      await vi.advanceTimersByTimeAsync(350);
      pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
      expect(pair.provider.sent.some((event: any) => event.type === 'response.cancel')).toBe(false);
      for (let index = 0; index < 4; index++) {
        await vi.advanceTimersByTimeAsync(20);
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
      }
      expect(pair.provider.sent).toContainEqual(expect.objectContaining({ type: 'response.cancel', response_id: 'before-resume-response' }));
      const leadingAudio = pair.provider.sent.filter((event: any) => event.type === 'input_audio_buffer.append').at(-1).audio;
      expect(Buffer.from(leadingAudio, 'base64')).toHaveLength(5 * managerAudio.length * 1.5);
      pair.provider.server({ type: 'response.done', response: { id: 'before-resume-response', status: 'cancelled' } });
      await vi.advanceTimersByTimeAsync(3);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'before-resume', transcript: 'Нет, ничего не...' });
      await commitManagerFragment(pair, 'resumed-answer');
      await vi.advanceTimersByTimeAsync(200);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'resumed-answer', transcript: 'Нет, не было.' });
      const answers = pair.snapshot().transcript.filter((turn: any) => turn.role === 'manager' && turn.text.startsWith('Нет'));
      expect(answers).toHaveLength(1);
      expect(answers[0].text).toBe('Нет, ничего не... Нет, не было.');
      expect(spokenInputs(pair)).toBe('');
      await vi.advanceTimersByTimeAsync(500);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(2);
      expect(pair.snapshot().conversationFlow.events.some((event: any) => event.type === 'barge_in_confirmed')).toBe(false);
    });
    it(`${mode}: 43cb30f8 isolated 20 ms noise never cancels the greeting response`, async () => {
      const pair = await launch(mode);
      await commitManagerFragment(pair, 'greeting');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'greeting-response' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'greeting-response', delta: 'Здравствуйте. Звоню по объявлению, машина ещё актуальна?' });
      await vi.advanceTimersByTimeAsync(50);
      pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
      expect(pair.provider.sent.some((event: any) => event.type === 'response.cancel')).toBe(false);
      await vi.advanceTimersByTimeAsync(367);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Добрый день.' });
      pair.provider.server({ type: 'response.done', response: { id: 'greeting-response' } });
      expect(spokenInputs(pair)).toBe('Здравствуйте. Звоню по объявлению, машина ещё актуальна?');
      await vi.advanceTimersByTimeAsync(3000);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      expect(pair.provider.sent.filter((event: any) => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
    });
    it(`${mode}: ignores a short sound even before the speculative response starts`, async () => {
      const pair = await launch(mode);
      await commitManagerFragment(pair, 'greeting');
      await vi.advanceTimersByTimeAsync(100);
      pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
      await vi.advanceTimersByTimeAsync(250);
      pair.provider.server({ type: 'response.created', response: { id: 'early-noise-response' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'early-noise-response', delta: 'Здравствуйте. Машина ещё актуальна?' });
      await vi.advanceTimersByTimeAsync(417);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Добрый день.' });
      expect(spokenInputs(pair)).toBe('Здравствуйте. Машина ещё актуальна?');
      expect(pair.provider.sent.some((event: any) => event.type === 'response.cancel')).toBe(false);
      expect(pair.provider.sent.filter((event: any) => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
    });
    it(`${mode}: holds output until an acoustic candidate is resolved even if complete ASR arrived first`, async () => {
      const pair = await launch(mode);
      await commitManagerFragment(pair, 'greeting');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'candidate-gated-response' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'candidate-gated-response', delta: 'Здравствуйте. Машина ещё актуальна?' });
      pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
      await vi.advanceTimersByTimeAsync(20);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Добрый день.' });
      expect(spokenInputs(pair)).toBe('');
      await vi.advanceTimersByTimeAsync(219);
      expect(spokenInputs(pair)).toBe('');
      await vi.advanceTimersByTimeAsync(1);
      expect(spokenInputs(pair)).toBe('Здравствуйте. Машина ещё актуальна?');
      expect(pair.provider.sent.some((event: any) => event.type === 'response.cancel')).toBe(false);
    });
    it.each([false, true])(`${mode}: 43cb30f8 recovers from empty ASR (noise still pending: %s)`, async (lateNoise) => {
      const pair = await launch(mode);
      await commitManagerFragment(pair, 'greeting');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'first-cancelled' } });
      await vi.advanceTimersByTimeAsync(50);
      for (let index = 0; index < 5; index++) {
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
        if (index < 4) await vi.advanceTimersByTimeAsync(20);
      }
      expect(pair.provider.sent).toContainEqual(expect.objectContaining({ type: 'response.cancel', response_id: 'first-cancelled' }));
      pair.provider.server({ type: 'response.done', response: { id: 'first-cancelled', status: 'cancelled' } });
      await vi.advanceTimersByTimeAsync(287);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Добрый день.' });
      await vi.advanceTimersByTimeAsync(113);
      expect(pair.provider.sent.filter((event: any) => event.type === 'input_audio_buffer.commit')).toHaveLength(2);
      pair.provider.server({ type: 'input_audio_buffer.committed', item_id: 'noise' });
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'noise-response' } });
      if (lateNoise) await vi.advanceTimersByTimeAsync(377);
      pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
      await vi.advanceTimersByTimeAsync(lateNoise ? 40 : 417);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'noise', transcript: '' });
      pair.provider.server({ type: 'response.done', response: { id: 'noise-response', status: 'cancelled' } });
      await vi.advanceTimersByTimeAsync(240);
      const requests = pair.provider.sent.filter((event: any) => event.type === 'response.create');
      expect(requests).toHaveLength(3);
      expect(requests.at(-1).response.instructions).toContain('Менеджер ответил на твой исходящий звонок');
      pair.provider.server({ type: 'response.created', response: { id: 'recovered-greeting' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'recovered-greeting', delta: 'Здравствуйте. Звоню по объявлению, машина ещё актуальна?' });
      pair.provider.server({ type: 'response.done', response: { id: 'recovered-greeting' } });
      pair.tts.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
      expect(voicedOutput(pair)).toBe(true);
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'manager').map((turn: any) => turn.text)).toEqual(['Добрый день.']);
      expect(pair.snapshot().errors).toEqual([]);
      expect(pair.snapshot().conversationFlow.events).toContainEqual(expect.objectContaining({ type: 'turn_recovered' }));
    });
    it(`${mode}: a short noise during unfinished-turn grace cannot lose the response timer`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'unfinished');
      await vi.advanceTimersByTimeAsync(200);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unfinished', transcript: 'Нет, ничего не...' });
      pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
      await vi.advanceTimersByTimeAsync(1599);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create').at(-1).response.instructions).toContain('Нет, ничего не...');
      expect(spokenInputs(pair)).toBe('');
    });
    it(`${mode}: the next committed fragment survives when it precedes the first slow transcript`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'slow-first');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'slow-first-response' } });
      await vi.advanceTimersByTimeAsync(50);
      for (let index = 0; index < 5; index++) {
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
        if (index < 4) await vi.advanceTimersByTimeAsync(20);
      }
      pair.provider.server({ type: 'response.done', response: { id: 'slow-first-response', status: 'cancelled' } });
      await vi.advanceTimersByTimeAsync(400);
      pair.provider.server({ type: 'input_audio_buffer.committed', item_id: 'fast-next' });
      await vi.advanceTimersByTimeAsync(220);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'slow-first', transcript: 'Нет, ничего не...' });
      await vi.advanceTimersByTimeAsync(200);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'fast-next', transcript: 'Нет, не было.' });
      await vi.advanceTimersByTimeAsync(500);
      const requests = pair.provider.sent.filter((event: any) => event.type === 'response.create');
      expect(requests).toHaveLength(2);
      expect(requests.at(-1).response.instructions).toContain('Нет, ничего не... Нет, не было.');
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'manager' && turn.text.startsWith('Нет'))).toHaveLength(1);
      expect(spokenInputs(pair)).toBe('');
    });
    it(`${mode}: recovery queued behind cancellation resumes on cancel-not-active and ignores duplicate empty ASR`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'unfinished');
      await vi.advanceTimersByTimeAsync(200);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unfinished', transcript: 'Нет, ничего не...' });
      await commitManagerFragment(pair, 'unrecognized');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'cancel-race' } });
      await vi.advanceTimersByTimeAsync(417);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unrecognized', transcript: '' });
      const cancellation = pair.provider.sent.find((event: any) => event.type === 'response.cancel' && event.response_id === 'cancel-race');
      expect(cancellation).toBeDefined();
      await vi.advanceTimersByTimeAsync(1200);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      pair.provider.server({ type: 'error', error: { event_id: cancellation.event_id, code: 'response_cancel_not_active' } });
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(2);
      pair.provider.server({ type: 'response.created', response: { id: 'after-race' } });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unrecognized', transcript: '' });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'after-race', delta: 'Правильно понимаю, пороги без коррозии?' });
      expect(spokenInputs(pair)).toBe('Правильно понимаю, пороги без коррозии?');
      expect(pair.snapshot().errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(2);
    });
    it(`${mode}: retains bounded output fallback when ASR is missing, without duplicating a response on very late ASR`, async () => {
      const pair = await launch(mode);
      await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'missing-asr');
      await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'fallback' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'fallback', delta: 'Хорошо. Возможна скидка?' });
      pair.provider.server({ type: 'response.done', response: { id: 'fallback' } });
      await vi.advanceTimersByTimeAsync(1199);
      expect(spokenInputs(pair)).toBe('');
      await vi.advanceTimersByTimeAsync(1);
      expect(spokenInputs(pair)).toBe('Хорошо. Возможна скидка?');
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'missing-asr', transcript: 'Нет, не было.' });
      await vi.advanceTimersByTimeAsync(1500);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      expect(pair.provider.sent.some((event: any) => event.type === 'response.cancel')).toBe(false);
      expect(spokenInputs(pair)).toBe('Хорошо. Возможна скидка?');
    });
    it(`${mode}: hangs up silently on the c271ecf4 voicemail end_call without waiting for playback`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'voicemail',
        transcript: 'Привет. Я занята, абоненту неудобно сейчас говорить. Я не голосовой ассистент, оставьте сообщение, и абонент увидит его. Можете говорить.' });
      expect(pair.vox.sent).toContainEqual({ customEvent: 'control', action: 'set_output_enabled', enabled: false });
      pair.provider.server({ type: 'response.created', response: { id: 'voicemail-end' } });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call',
        arguments: JSON.stringify({ reason: 'Voicemail detected; do not leave a message per instructions.' }), call_id: 'voicemail-end-tool' });
      pair.provider.server({ type: 'response.done', response: { id: 'voicemail-end' } });
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
      expect(pair.tts.sent.some((event: any) => event.inputs?.length)).toBe(false);
      // Duplicate completion/media acknowledgements must not send another
      // terminal command or manufacture a farewell for an answering machine.
      pair.provider.server({ type: 'response.done', response: { id: 'voicemail-end' } });
      pair.vox.input({ customEvent: 'media_status', status: 'ended' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
      expect(pair.tts.sent.some((event: any) => event.inputs?.length)).toBe(false);
    });
    it(`${mode}: cancels muted generated speech and still honors an accepted end_call`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'voicemail',
        transcript: 'Абонент недоступен. Оставьте сообщение после сигнала.' });
      pair.provider.server({ type: 'response.created', response: { id: 'muted-end' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'До свидания.' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{"reason":"voicemail"}', call_id: 'muted-end-tool' });
      pair.provider.server({ type: 'response.done', response: { id: 'muted-end' } });
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
      expect(pair.vox.sent.some((event: any) => event.action === 'set_output_enabled' && event.enabled)).toBe(false);
    });
    it(`${mode}: keeps IVR routing and operator hold open instead of hanging up on any muted response`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ivr',
        transcript: 'Для соединения с отделом продаж нажмите 1.' });
      pair.provider.server({ type: 'response.created', response: { id: 'ivr-choice' } });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'send_dtmf', arguments: '{"digit":"1"}', call_id: 'ivr-digit' });
      pair.provider.server({ type: 'response.done', response: { id: 'ivr-choice' } });
      expect(pair.vox.sent).toContainEqual({ customEvent: 'control', action: 'send_dtmf', digit: '1' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'hold',
        transcript: 'Оставайтесь на линии, сейчас соединю с оператором.' });
      pair.provider.server({ type: 'response.created', response: { id: 'operator-hold' } });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'skip_turn', arguments: '{"kind":"hold"}', call_id: 'hold-tool' });
      pair.provider.server({ type: 'response.done', response: { id: 'operator-hold' } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
      expect(pair.tts.sent.some((event: any) => event.inputs?.length)).toBe(false);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'live',
        transcript: 'Добрый день. Меня зовут Иван, чем могу помочь?' });
      expect(pair.vox.sent.at(-1)).toEqual({ customEvent: 'control', action: 'set_output_enabled', enabled: true });
    });
    it(`${mode}: rejects the 8cfa445a tool-only ending and confirms the visit in one audible reply`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'visit', transcript: 'Приезжайте сегодня к семнадцати часам. Адрес: улица Пушкина, дом один.' });
      pair.provider.server({ type: 'response.created', response: { id: 'bad-ending' } });
      pair.provider.server({ type: 'response.output_item.added', item: { id: 'bad-message', type: 'message' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Спасибо за ответы, всего доброго.' });
      pair.provider.server({ type: 'response.output_text.done', text: 'Спасибо за ответы, всего доброго.' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: JSON.stringify({ reason: 'Клиент подтвердил визит сегодня в 17:00' }), call_id: 'invalid-end' });
      pair.provider.server({ type: 'response.done', response: { id: 'bad-ending' } });
      const spoken = () => pair.tts.sent.flatMap((event: any) => (event.inputs ?? []).map((input: any) => input.text)).join('').trim();
      expect(spoken()).toBe(''); expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
      expect(pair.provider.sent).toContainEqual(expect.objectContaining({ type: 'conversation.item.delete', item_id: 'bad-message' }));
      expect(pair.provider.sent).toContainEqual(expect.objectContaining({ type: 'conversation.item.create', item: expect.objectContaining({ call_id: 'invalid-end', output: expect.stringContaining('respond_to_visit_offer_before_ending') }) }));
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create').at(-1).response.instructions).toContain('Предыдущее прощание не прозвучало');
      pair.provider.server({ type: 'response.created', response: { id: 'valid-ending' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Хорошо, приеду сегодня к пяти. Спасибо, до свидания.' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'valid-end' });
      pair.provider.server({ type: 'response.done', response: { id: 'valid-ending' } });
      expect(spoken()).toBe('Хорошо, приеду сегодня к пяти. Спасибо, до свидания.');
      pair.tts.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
      pair.vox.input({ customEvent: 'media_status', status: 'ended' });
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
    });
    it(`${mode}: retains a counteroffer question and never hangs up on it`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'visit', transcript: 'Приезжайте сегодня к семнадцати часам.' });
      pair.provider.server({ type: 'response.created', response: { id: 'counteroffer' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Сегодня не смогу. Можно завтра к пяти? До свидания.' });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'end' });
      pair.provider.server({ type: 'response.done', response: { id: 'counteroffer' } });
      const spoken = pair.tts.sent.flatMap((event: any) => (event.inputs ?? []).map((input: any) => input.text)).join('').trim();
      expect(spoken).toBe('Сегодня не смогу. Можно завтра к пяти?');
      pair.tts.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
      pair.vox.input({ customEvent: 'media_status', status: 'started' }); await vi.advanceTimersByTimeAsync(1000); pair.vox.input({ customEvent: 'media_status', status: 'ended' });
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
    });
    it(`${mode}: bounds retries when the model repeats the invalid ending`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'visit', transcript: 'Приезжайте сегодня к семнадцати часам.' });
      for (const id of ['bad-1', 'bad-2']) {
        pair.provider.server({ type: 'response.created', response: { id } }); pair.provider.server({ type: 'response.output_text.delta', delta: 'Спасибо, до свидания.' });
        pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: id }); pair.provider.server({ type: 'response.done', response: { id } });
      }
      const spoken = pair.tts.sent.flatMap((event: any) => (event.inputs ?? []).map((input: any) => input.text)).join('').trim();
      expect(spoken).toBe('Уточню время визита: вы предлагаете сегодня к семнадцати часам, правильно?');
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
    });
    for (const chunks of ['whole', 'characters'] as const) {
      it.each(closingRegressions)(`${mode}: filters the recorded 2.1 ending BEFORE TTS (${chunks}): %s`, async (text) => {
        config.openaiRealtimeModel = 'gpt-realtime-2.1';
        const pair = await launch(mode);
        pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
        pair.provider.server({ type: 'response.created', response: { id: 'closing' } });
        const deltas = chunks === 'characters' ? Array.from(text) : [text];
        for (const delta of deltas) pair.provider.server({ type: 'response.output_text.delta', response_id: 'closing', delta });
        const spokenInputs = () => pair.tts.sent.flatMap((event: any) => (event.inputs ?? []).map((input: any) => input.text)).join('').trim();
        // Check while streaming, not only after response.done: a late cleanup
        // cannot retract technical text already sent for speech synthesis.
        expect(spokenInputs()).toBe('До свидания.');
        pair.provider.server({ type: 'response.output_text.done', response_id: 'closing', text });
        pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'end' });
        pair.provider.server({ type: 'response.done', response: { id: 'closing' } });
        expect(spokenInputs()).toBe('До свидания.');
        expect(pair.provider.sent).toContainEqual(expect.objectContaining({ type: 'conversation.item.create', item: expect.objectContaining({
          role: 'assistant', content: [{ type: 'output_text', text: 'До свидания.' }],
        }) }));
        pair.tts.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
        pair.vox.input({ customEvent: 'media_status', status: 'started' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
        pair.vox.input({ customEvent: 'media_status', status: 'ended' });
        expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
      });
    }
    it(`${mode}: substitutes one natural farewell when the entire closing was technical`, async () => {
      config.openaiRealtimeModel = 'gpt-realtime-2.1';
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'closing' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'closing', delta: 'Аккуратно подведём разговор к завершению.' });
      expect(pair.tts.sent.some((event: any) => event.inputs?.length)).toBe(false);
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', arguments: '{}', call_id: 'end' });
      pair.provider.server({ type: 'response.done', response: { id: 'closing' } });
      const spoken = pair.tts.sent.flatMap((event: any) => (event.inputs ?? []).map((input: any) => input.text)).join('').trim();
      expect(spoken).toBe('Спасибо за ответы, всего доброго.');
    });
  }
});
