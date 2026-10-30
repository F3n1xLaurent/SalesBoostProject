import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { handleCometRealtimeTestSocket, handleCometRealtimeTestWebhook, handleStartCometRealtimeTest,
  prepareProductionOpenAiRealtimeCall, updateProductionRealtimeLifecycle, createCallPlanSimulation } from '../voice/cometRealtimeTest';

const mocks = vi.hoisted(() => ({ sockets: [] as any[], failuresRemaining: 0, start: vi.fn(),
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
      if (value.type === 'session.update') queueMicrotask(() => this.server({ type: 'session.updated' }));
    }
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
const original = { key: config.openaiRealtimeApiKey, eleven: config.elevenLabsApiKey, model: config.openaiRealtimeModel };
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.sockets.length = 0; mocks.failuresRemaining = 0;
  config.openaiRealtimeApiKey = 'test'; config.elevenLabsApiKey = 'test'; config.openaiRealtimeModel = 'gpt-realtime-2';
  mocks.start.mockImplementation(async (_phone, options) => ({ callId: options.callId, scenario: options.scenario, startedAt: new Date().toISOString() }));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const socket of mocks.sockets) socket.close();
  vi.useRealTimers();
  config.openaiRealtimeApiKey = original.key; config.elevenLabsApiKey = original.eleven; config.openaiRealtimeModel = original.model;
});

async function launch(mode: 'test' | 'production') {
  const offset = mocks.sockets.length;
  const vox = new Vox();
  let callId: string; let token: string;
  if (mode === 'production') {
    callId = 'production-parity';
    const pending = prepareProductionOpenAiRealtimeCall({ callId, phone: '+79507503215', plan: mocks.plan });
    await vi.advanceTimersByTimeAsync(0);
    const prepared = await pending; token = prepared.streamToken;
    prepared.markDialing(new Date().toISOString());
    updateProductionRealtimeLifecycle(callId, 'connected', new Date().toISOString());
    cleanups.push(() => { vox.close(); prepared.dispose(); });
  } else {
    let status = 200; let result: any;
    const res = { status(code: number) { status = code; return this; }, json(value: any) { result = value; } };
    const pending = handleStartCometRealtimeTest({ body: { provider: 'openai', planId: 'plan', to: '+79507503215', model: config.openaiRealtimeModel } } as Request, res as Response);
    await vi.advanceTimersByTimeAsync(0); await pending;
    expect(status).toBe(200); callId = result.callId; token = mocks.start.mock.calls.at(-1)![1].streamToken;
    cleanups.push(() => { vox.close(); handleCometRealtimeTestWebhook({ body: { call_id: callId, event: 'disconnected' } } as Request, { status: () => ({ end: () => {} }) } as unknown as Response); });
  }
  handleCometRealtimeTestSocket(vox as unknown as WebSocket, `/voice/${mode === 'test' ? 'comet-realtime-test' : 'openai-realtime'}?call_id=${callId}&token=${token}`);
  const sockets = mocks.sockets.slice(offset);
  return { vox, provider: sockets.filter(socket => socket.url.includes('/realtime')).at(-1), tts: sockets.find(socket => socket.url.includes('elevenlabs')), sockets };
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
