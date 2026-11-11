import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { handleCometRealtimeTestSocket, handleCometRealtimeTestWebhook, handleStartCometRealtimeTest, handleGetCometRealtimeTest,
  prepareProductionOpenAiRealtimeCall, updateProductionRealtimeLifecycle, createCallPlanSimulation } from '../voice/cometRealtimeTest';

const mocks = vi.hoisted(() => ({ sockets: [] as any[], failuresRemaining: 0, acknowledgeHistory: true, handshake: true, openingAudio: false,
  classifyOverride: null as null | ((input: unknown) => Promise<any>), start: vi.fn(),
  plan: { planId: 'plan', planName: 'План', prompt: 'Ты Анна, женщина. Звонишь по Kia Carnival. Уточни цену.',
    elevenLabsVoiceId: 'profile-voice', customerVoiceId: 'voice-row', subjectTitle: 'Kia Carnival', subjectDescription: null },
  tts: { modelId: 'eleven_v4_turbo', defaultVoiceId: 'agent-default', stability: 0.75, similarityBoost: 0.75, speed: 1.13,
    source: 'agent' as const, optimizeStreamingLatency: 0, pronunciationDictionaryLocators: [] },
}));
vi.mock('../voice/callLiveSpeakerClassifier', async original => {
  const actual = await original<typeof import('../voice/callLiveSpeakerClassifier')>();
  return { ...actual, classifyLiveSpeaker: (input: Parameters<typeof actual.classifyLiveSpeaker>[0]) =>
    mocks.classifyOverride ? mocks.classifyOverride(input) : actual.classifyLiveSpeaker(input) };
});
vi.mock('../voice/realtimeOpeningAudio', async original => {
  const actual = await original<typeof import('../voice/realtimeOpeningAudio')>();
  return { ...actual, prepareOpeningAudio: (...args: Parameters<typeof actual.prepareOpeningAudio>) => mocks.openingAudio ? actual.prepareOpeningAudio(...args) : () => {},
    preparedOpeningAudio: (...args: Parameters<typeof actual.preparedOpeningAudio>) => mocks.openingAudio ? actual.preparedOpeningAudio(...args) : null };
});
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
  mocks.openingAudio = false;
  mocks.classifyOverride = null;
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
async function playReply(pair: Awaited<ReturnType<typeof launch>>, id: string, text: string) {
  pair.provider.server({ type: 'response.created', response: { id } });
  pair.provider.server({ type: 'response.output_text.delta', delta: text });
  pair.provider.server({ type: 'response.done', response: { id } });
  pair.tts.server({ audio: Buffer.alloc(800, 0xff).toString('base64'), is_final_audio_for_turn: true });
  pair.vox.input({ customEvent: 'media_status', status: 'started' });
  await vi.advanceTimersByTimeAsync(1000);
  pair.vox.input({ customEvent: 'media_status', status: 'ended' });
}
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

function enterTransferWait(pair: Awaited<ReturnType<typeof launch>>) {
  pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'hold', transcript: 'Оставайтесь на линии, сейчас соединю с отделом продаж.' });
  pair.provider.server({ type: 'response.created', response: { id: 'hold-response' } });
  pair.provider.server({ type: 'response.function_call_arguments.done', response_id: 'hold-response', name: 'skip_turn', call_id: 'hold-tool', arguments: JSON.stringify({ kind: 'waiting' }) });
  pair.provider.server({ type: 'response.done', response: { id: 'hold-response' } });
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
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Спасибо за звонок, до свидания.' });
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
    it(`${mode}: 1181 does not interrupt or invent a new question from the isolated word Vas`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'still-speaking' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'still-speaking', delta: 'Меня зовут Анна. Подскажите, машина с пробегом ещё в продаже?' });
      pair.provider.server({ type: 'response.done', response: { id: 'still-speaking' } });
      pair.tts.server({ audio: Buffer.alloc(64_000).toString('base64'), is_final_audio_for_turn: true });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < 8; i++) {
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
        await vi.advanceTimersByTimeAsync(20);
      }
      await vi.advanceTimersByTimeAsync(300);
      pair.provider.server({ type: 'input_audio_buffer.committed', item_id: 'pronoun' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'pronoun', transcript: 'Вас.' });
      expect(pair.vox.sent.some((event: any) => event.action === 'clear_media')).toBe(false);
      expect(pair.snapshot().conversationFlow.events.some((event: any) => event.type === 'barge_in_confirmed')).toBe(false);
      expect(pair.provider.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'pronoun' });
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'client')).toHaveLength(1);
    });
    it.each(['recording', 'closed'])(`${mode}: deferred classification returning after %s cannot leak queued speech`, async outcome => {
      let resolve!: (value: any) => void;
      mocks.classifyOverride = () => new Promise(done => { resolve = done; });
      const pair = await launch(mode); enterTransferWait(pair);
      await commitManagerFragment(pair, 'unknown-speaker'); await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'pending-speaker' } });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unknown-speaker', transcript: 'Информация о специальных предложениях.' });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'pending-speaker', delta: 'Здравствуйте. Машина ещё в продаже?' });
      pair.provider.server({ type: 'response.done', response: { id: 'pending-speaker' } });
      if (outcome === 'closed') pair.vox.close();
      const sent = pair.vox.sent.length;
      resolve({ speakerType: outcome === 'closed' ? 'live_human' : 'ivr_or_recording', confidence: 1, reason: outcome });
      await vi.advanceTimersByTimeAsync(0);
      expect(spokenInputs(pair)).toBe('');
      expect(pair.vox.sent.some((event: any) => event.event === 'media')).toBe(false);
      expect(pair.snapshot().transcript.some((turn: any) => turn.role === 'client')).toBe(false);
      if (outcome === 'closed') expect(pair.vox.sent).toHaveLength(sent);
    });
    it.each([
      ['1163', 'Алло.'],
      ['1166', 'Подак. Контрактирина. Здравствуйте. Алло, вас не слышно.'],
      ['1169', 'Добрый день, компания Арконт, оператор Елена, рада вас приветствовать.'],
      ['1179', 'Доброе утро, Новоавтоком.'],
      ['1175', 'Сергей, добрый день, меня зовут Ильнур, менеджер отдела продаж. По определенной машине обращаетесь?'],
      ['1177', 'Про Карлсона, меня, Олег, слушаю вас.'],
    ])(`${mode}: resumes speech after IVR/transfer on call %s`, async (_call, greeting) => {
      const pair = await launch(mode); enterTransferWait(pair);
      await commitManagerFragment(pair, 'employee'); await vi.advanceTimersByTimeAsync(350);
      expect(pair.provider.sent.some((event: any) => event.type === 'response.create')).toBe(true);
      pair.provider.server({ type: 'response.created', response: { id: 'employee-response' } });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'employee', transcript: greeting });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'employee-response', delta: 'Меня зовут Анна. Подскажите, машина ещё в продаже?' });
      pair.provider.server({ type: 'response.done', response: { id: 'employee-response' } });
      expect(spokenInputs(pair)).toContain('Подскажите, машина ещё в продаже?');
      expect(pair.vox.sent.filter((event: any) => event.action === 'set_output_enabled').at(-1)?.enabled).toBe(true);
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'client')).toHaveLength(1);
    });
    it(`${mode}: waits for delayed live-speaker classification without losing the transferred employee reply`, async () => {
      let resolve!: (value: any) => void;
      mocks.classifyOverride = () => new Promise(done => { resolve = done; });
      const pair = await launch(mode); enterTransferWait(pair);
      await commitManagerFragment(pair, 'new-employee'); await vi.advanceTimersByTimeAsync(350);
      pair.provider.server({ type: 'response.created', response: { id: 'classified-response' } });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-employee', transcript: 'Ваши пожелания по комплектации?' });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'classified-response', delta: 'Пока сравниваю комплектации. Подскажите, машина ещё в продаже?' });
      pair.provider.server({ type: 'response.done', response: { id: 'classified-response' } });
      await vi.advanceTimersByTimeAsync(1_300);
      expect(spokenInputs(pair)).toBe('');
      expect(pair.snapshot().transcript.some((turn: any) => turn.role === 'client')).toBe(false);
      resolve({ speakerType: 'live_human', confidence: 1, reason: 'employee_address' });
      await vi.advanceTimersByTimeAsync(0);
      expect(spokenInputs(pair)).toBe('Пока сравниваю комплектации. Подскажите, машина ещё в продаже?');
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'client')).toHaveLength(1);
      expect(pair.vox.sent.filter((event: any) => event.action === 'set_output_enabled').at(-1)?.enabled).toBe(true);
    });
    it(`${mode}: a mixed hold-plus-human transcript cannot mute the new employee again`, async () => {
      const pair = await launch(mode); enterTransferWait(pair);
      const transcript = 'Оставайтесь на линии, сейчас соединю. Добрый день, меня зовут Ильнур, по какой машине обращаетесь?';
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'combined', transcript });
      pair.provider.server({ type: 'response.created', response: { id: 'erroneous-skip' } });
      pair.provider.server({ type: 'response.function_call_arguments.done', response_id: 'erroneous-skip', name: 'skip_turn', call_id: 'wrong-wait', arguments: JSON.stringify({ kind: 'waiting' }) });
      const output = pair.provider.sent.find((event: any) => event.item?.call_id === 'wrong-wait');
      expect(JSON.parse(output.item.output).ignored).toBe(true);
      expect(pair.vox.sent.filter((event: any) => event.action === 'set_output_enabled').at(-1)?.enabled).toBe(true);
    });
    it.each([
      ['Звоните с вашего личного номера для отправки визитки с адресом ДЦ?', 'Не уверен, что это мой личный номер. Связь может идти через сервис, и сообщения могут не дойти.', 'Отправьте, пожалуйста, визитку с адресом на этот номер.'],
      ['Это робот?', 'Да, я голосовой AI-помощник.', 'Меня зовут Анна. Что по порогам — не сильно ли гнилые?'],
    ])(`${mode}: stays in the customer role when asked %s`, async (question, draft, expected) => {
      const pair = await launch(mode); await askManagerQuestion(pair);
      await commitManagerFragment(pair, 'identity-question');
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'identity-question', transcript: question });
      await vi.advanceTimersByTimeAsync(500);
      pair.provider.server({ type: 'response.created', response: { id: 'identity-response' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'identity-response', delta: draft });
      expect(spokenInputs(pair)).toBe('');
      pair.provider.server({ type: 'response.done', response: { id: 'identity-response' } });
      expect(spokenInputs(pair)).toBe(expected);
      expect(pair.snapshot().transcript.at(-1)?.text).toBe(expected);
    });
    it(`${mode}: preserves heard audio if TTS fails before the model finishes and ignores late text`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human', transcript: 'Ну, Илья, установлен автомат.' });
      pair.provider.server({ type: 'response.created', response: { id: 'tts-before-model-done' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'tts-before-model-done', delta: 'Хорошо. А какие опции комфорта там предусмотрены?' });
      const chars = Array.from('Я Анна. Хорошо. ');
      pair.tts.server({ audio: Buffer.alloc(8_000).toString('base64'), alignment: {
        chars, char_start_times_ms: chars.map((_, index) => index * 20), char_durations_ms: chars.map(() => 20),
      } });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      pair.tts.drop(); await vi.advanceTimersByTimeAsync(1_500);
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'client').map((turn: any) => turn.text)).toEqual(['Я Анна. Хорошо.']);
      const inputCount = mocks.sockets.flatMap(socket => socket.sent).filter((event: any) => event.inputs?.length).length;
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'tts-before-model-done', delta: ' Ещё один непрозвучавший вопрос.' });
      pair.provider.server({ type: 'response.done', response: { id: 'tts-before-model-done' } });
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'client').map((turn: any) => turn.text)).toEqual(['Я Анна. Хорошо.']);
      expect(mocks.sockets.flatMap(socket => socket.sent).filter((event: any) => event.inputs?.length)).toHaveLength(inputCount);
    });
    it.each(['close', 'provider-error'])(`${mode}: partial live TTS ending with %s never records the unheard suffix`, async failure => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'partial-live' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'partial-live', delta: 'Меня зовут Анна. Смотрю Киа Карнивал, машина ещё актуальна?' });
      pair.provider.server({ type: 'response.done', response: { id: 'partial-live' } });
      const chars = Array.from('Меня зовут Анна. ');
      pair.tts.server({ audio: Buffer.alloc(8_000).toString('base64'), alignment: {
        chars, char_start_times_ms: chars.map((_, index) => index * 20), char_durations_ms: chars.map(() => 20),
      } });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      if (failure === 'close') pair.tts.drop();
      else pair.tts.server({ error: 'upstream_stream_failed' });
      await vi.advanceTimersByTimeAsync(1_500);
      const client = pair.snapshot().transcript.find((turn: any) => turn.role === 'client');
      expect(client.text).toBe('Меня зовут Анна.');
      expect(client.metrics.ttsFailed).toBe(true);
      expect(client.metrics.audioDurationMs).toBe(1_000);
      expect(pair.vox.sent.some((event: any) => event.event === 'stop')).toBe(true);
      expect(pair.snapshot().errors).toContain('ElevenLabs: audio stream ended before its final frame');
    });
    it(`${mode}: an unaligned partial TTS stream stays explicitly incomplete`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'unaligned-partial' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'unaligned-partial', delta: 'Меня зовут Анна. Смотрю Киа Карнивал, машина ещё актуальна?' });
      pair.provider.server({ type: 'response.done', response: { id: 'unaligned-partial' } });
      pair.tts.server({ audio: Buffer.alloc(8_000).toString('base64') });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      pair.tts.drop(); await vi.advanceTimersByTimeAsync(1_500);
      expect(pair.snapshot().transcript.find((turn: any) => turn.role === 'client')?.text).toBe('[реплика прозвучала не полностью]');
    });
    it(`${mode}: a wrong-name correction cannot turn filtered technical output into spoken text`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'wrong-name', transcript: 'Ну, Илья, у этой машины установлен автомат.' });
      pair.provider.server({ type: 'response.created', response: { id: 'filtered-with-name' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'filtered-with-name', delta: 'Давайте уточним следующий шаг: о чём договоримся?' });
      expect(spokenInputs(pair)).toBe('');
      expect(pair.vox.sent.some((event: any) => event.event === 'media')).toBe(false);
    });
    it(`${mode}: keeps one continuous manager utterance while cancellation acknowledgement is delayed`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'unheard-delayed' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'unheard-delayed', delta: 'Здравствуйте. Машина ещё актуальна?' });
      // No response.done acknowledgement until after the entire long utterance.
      for (let i = 0; i < 100; i++) {
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(pair.snapshot().conversationFlow.events.filter((event: any) => event.type === 'continuation_confirmed')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(700);
      expect(pair.provider.sent.some((event: any) => event.type === 'input_audio_buffer.commit')).toBe(true);
      pair.provider.server({ type: 'response.done', response: { id: 'unheard-delayed', status: 'cancelled' } });
      pair.provider.server({ type: 'input_audio_buffer.committed', item_id: 'whole-manager-turn' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'whole-manager-turn', transcript: 'Вас не слышно, чем могу помочь?' });
      await vi.advanceTimersByTimeAsync(700);
      expect(pair.provider.sent.some((event: any) => event.type === 'response.create')).toBe(true);
    });
    it(`${mode}: cached greeting does not conceal a broken TTS stream for the rest of the reply`, async () => {
      mocks.openingAudio = true;
      const pair = await launch(mode);
      pair.sockets.filter(socket => socket.url.includes('elevenlabs'))[1]?.server({ audio: Buffer.alloc(8_000).toString('base64'), is_final_audio_for_turn: true });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'cached-with-rest' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'cached-with-rest', delta: 'Здравствуйте. Меня зовут Анна. Машина ещё актуальна?' });
      pair.provider.server({ type: 'response.done', response: { id: 'cached-with-rest' } });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      pair.tts.drop();
      await vi.advanceTimersByTimeAsync(5_000);
      const replacement = mocks.sockets.at(-1);
      const replay = replacement.sent.flatMap((event: any) => event.inputs ?? []).map((input: any) => input.text).join('').trim();
      expect(replay).toBe('Меня зовут Анна. Машина ещё актуальна?');
      replacement.server({ audio: Buffer.alloc(8_000).toString('base64'), is_final_audio_for_turn: true });
      await vi.advanceTimersByTimeAsync(2_000);
      const turn = pair.snapshot().transcript.find((turn: any) => turn.role === 'client');
      expect(turn.metrics.audioDurationMs).toBe(2_000);
      expect(turn.metrics.ttsFailed).not.toBe(true);
    });
    it(`${mode}: corrects Ilya when the chosen client name is Maxim, once before the useful reply`, async () => {
      const prompt = mocks.plan.prompt;
      mocks.plan.prompt = 'Ты Максим, мужчина. Звонишь по Kia Carnival. Уточни цену.';
      let pair: Awaited<ReturnType<typeof launch>>;
      try { pair = await launch(mode); } finally { mocks.plan.prompt = prompt; }
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'wrong-name', transcript: 'Ну, Илья, у этой машины установлен автомат. Максимально удобен для новичка.' });
      pair.provider.server({ type: 'response.created', response: { id: 'correct-name' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'correct-name', delta: 'Хорошо. А какие опции комфорта там предусмотрены?' });
      expect(spokenInputs(pair)).toBe('Я Максим. Хорошо. А какие опции комфорта там предусмотрены?');
      pair.provider.server({ type: 'response.done', response: { id: 'correct-name' } });
      expect(pair.snapshot().transcript.find((turn: any) => turn.role === 'client')?.text).toBe('Я Максим. Хорошо. А какие опции комфорта там предусмотрены?');
    });
    it(`${mode}: failed speech after a cached greeting records only what was audible and stops playback`, async () => {
      mocks.openingAudio = true;
      const pair = await launch(mode);
      pair.sockets.filter(socket => socket.url.includes('elevenlabs'))[1]?.server({ audio: Buffer.alloc(8_000).toString('base64'), is_final_audio_for_turn: true });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'partial-failed' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'partial-failed', delta: 'Здравствуйте. Меня зовут Анна. Машина ещё актуальна?' });
      pair.provider.server({ type: 'response.done', response: { id: 'partial-failed' } });
      pair.vox.input({ customEvent: 'media_status', status: 'started' });
      pair.tts.drop();
      await vi.advanceTimersByTimeAsync(10_001);
      const client = pair.snapshot().transcript.find((turn: any) => turn.role === 'client');
      expect(client.text).toBe('Здравствуйте.');
      expect(client.metrics.ttsFailed).toBe(true);
      expect(client.metrics.audioDurationMs).toBe(1_000);
      expect(pair.vox.sent.some((event: any) => event.event === 'stop')).toBe(true);
      pair.vox.input({ customEvent: 'media_status', status: 'ended' });
      await commitManagerFragment(pair, 'after-failure');
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'after-failure', transcript: 'Вы меня слышите?' });
      await vi.advanceTimersByTimeAsync(700);
      expect(pair.provider.sent.some((event: any) => event.type === 'response.create')).toBe(true);
    });
    it(`${mode}: warms greeting audio without speaking to IVR and uses it only after the model chooses it`, async () => {
      mocks.openingAudio = true;
      const pair = await launch(mode);
      const preparation = pair.sockets.filter(socket => socket.url.includes('elevenlabs'))[1];
      preparation?.server({ audio: Buffer.alloc(8_000, 0xff).toString('base64'), is_final_audio_for_turn: true });
      expect(pair.vox.sent.some((event: any) => event.event === 'media')).toBe(false);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ivr', transcript: 'Здравствуйте! Для соединения с отделом продаж нажмите один.' });
      expect(pair.snapshot().transcript.some((turn: any) => turn.role === 'client')).toBe(false);
      expect(pair.vox.sent.some((event: any) => event.event === 'media')).toBe(false);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'human', transcript: 'Алло, слушаю.' });
      expect(pair.vox.sent.some((event: any) => event.event === 'media')).toBe(false);
      pair.provider.server({ type: 'response.created', response: { id: 'opening-cached' } });
      const text = 'Здравствуйте. Меня зовут Анна. Звоню по поводу Киа Карнивал.';
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'opening-cached', delta: text });
      expect(pair.vox.sent.some((event: any) => event.event === 'media')).toBe(true);
      expect(spokenInputs(pair)).toBe('Меня зовут Анна. Звоню по поводу Киа Карнивал.');
      pair.provider.server({ type: 'response.done', response: { id: 'opening-cached' } });
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'client')).toEqual([
        expect.objectContaining({ text, metrics: expect.objectContaining({ openingAudioCached: true }) }),
      ]);
    });
    it(`${mode}: answers a substantive first question without automatically playing a cached greeting`, async () => {
      mocks.openingAudio = true;
      const pair = await launch(mode);
      pair.sockets.filter(socket => socket.url.includes('elevenlabs'))[1]?.server({ audio: Buffer.alloc(8_000).toString('base64'), is_final_audio_for_turn: true });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'question', transcript: 'Какой автомобиль вас интересует?' });
      pair.provider.server({ type: 'response.created', response: { id: 'answer' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'answer', delta: 'Интересует Киа Карнивал из объявления.' });
      expect(pair.vox.sent.some((event: any) => event.event === 'media')).toBe(false);
      expect(spokenInputs(pair)).toBe('Интересует Киа Карнивал из объявления.');
    });
    it.each([
      { buffered: false, finished: false }, { buffered: false, finished: true }, { buffered: true, finished: true },
    ])(`${mode}: treats continued speech before Vox playback as continuation (%j)`, async ({ buffered, finished }) => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'unheard' } });
      pair.provider.server({ type: 'response.output_item.added', response_id: 'unheard', item: { type: 'message', id: 'unheard-item' } });
      pair.provider.server({ type: 'response.output_text.delta', response_id: 'unheard', delta: 'Здравствуйте. Машина ещё актуальна?' });
      if (finished) pair.provider.server({ type: 'response.done', response: { id: 'unheard' } });
      const requestsBeforeContinuation = pair.provider.sent.filter((event: any) => event.type === 'response.create').length;
      if (buffered) pair.tts.server({ audio: Buffer.alloc(16_000).toString('base64') });
      for (let i = 0; i < 8; i++) {
        pair.vox.input({ event: 'media', media: { payload: managerAudio.toString('base64') } });
        await vi.advanceTimersByTimeAsync(20);
      }
      const events = pair.snapshot().conversationFlow.events;
      expect(events.some((event: any) => event.type === 'continuation_confirmed')).toBe(true);
      expect(events.some((event: any) => event.type === 'barge_in_confirmed')).toBe(false);
      expect(pair.provider.sent.some((event: any) => event.type === 'response.cancel' && event.response_id === 'unheard')).toBe(!finished);
      if (!finished) pair.provider.server({ type: 'response.done', response: { id: 'unheard', status: 'cancelled' } });
      expect(pair.vox.sent).toContainEqual({ customEvent: 'control', action: 'clear_media' });
      const sentAudio = pair.vox.sent.filter((event: any) => event.event === 'media').length;
      pair.tts.server({ audio: Buffer.alloc(8_000).toString('base64') });
      await vi.advanceTimersByTimeAsync(100);
      expect(pair.vox.sent.filter((event: any) => event.event === 'media')).toHaveLength(sentAudio);
      expect(pair.snapshot().transcript.some((turn: any) => turn.metrics.interrupted)).toBe(false);
      expect(pair.snapshot().transcript.some((turn: any) => turn.role === 'client')).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      pair.provider.server({ type: 'input_audio_buffer.committed', item_id: 'continued-greeting' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'continued-greeting', transcript: 'Вас не слышно, чем могу помочь?' });
      await vi.advanceTimersByTimeAsync(500);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create').length).toBeGreaterThan(requestsBeforeContinuation);
    });
    it(`${mode}: reconnects idle TTS before the operator answers, with a bounded retry budget`, async () => {
      const pair = await launch(mode);
      let socket = pair.tts;
      for (const delay of [250, 1_000, 2_500]) {
        const count = mocks.sockets.length;
        socket.close(); await vi.advanceTimersByTimeAsync(delay - 1);
        expect(mocks.sockets).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(1);
        socket = mocks.sockets.at(-1);
        expect(socket).not.toBe(pair.tts);
        expect(socket.sent).toContainEqual(expect.objectContaining({ voices: ['profile-voice'] }));
      }
      const count = mocks.sockets.length;
      socket.close(); await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.sockets).toHaveLength(count);
      expect(pair.vox.sent.some((event: any) => event.event === 'media')).toBe(false);
    });
    const replacementProvider = () => mocks.sockets.filter(socket => socket.url.includes('/realtime')).at(-1);
    it(`${mode}: a new options question is answered before closing a confirmed appointment`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'slot', transcript: 'Приезжайте завтра в 12:00.' });
      await playReply(pair, 'confirmation', 'Хорошо, завтра в двенадцать приеду.');
      pair.tts.sent.length = 0;
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'options', transcript: 'А какими опциями вы сейчас пользуетесь?' });
      pair.provider.server({ type: 'response.created', response: { id: 'missed-options' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Хорошо, договорились. До свидания.' });
      pair.provider.server({ type: 'response.done', response: { id: 'missed-options' } });
      expect(spokenInputs(pair)).toBe('');
      expect(pair.provider.sent.filter((e: any) => e.type === 'response.create').at(-1)?.response.instructions).toContain('опциями');
      await playReply(pair, 'options-answer', 'Пользуюсь подогревом сидений и камерой заднего вида. Спасибо, до свидания.');
      expect(spokenInputs(pair)).toContain('подогревом сидений');
      expect(pair.vox.sent.filter((e: any) => e.action === 'hangup')).toHaveLength(1);
    });
    it(`${mode}: replacing an unaccepted slot invalidates the old explicit-offer guard`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-slot', transcript: 'Приезжайте завтра в 12:00.' });
      await playReply(pair, 'clarification', 'А можно выбрать другое время?');
      pair.tts.sent.length = 0;
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-options', transcript: 'В двенадцать уже занято. Можно сегодня в 17:00 или завтра в 15:00.' });
      pair.provider.server({ type: 'response.created', response: { id: 'stale-confirmation' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Хорошо, договорились. До свидания.' });
      pair.provider.server({ type: 'response.done', response: { id: 'stale-confirmation' } });
      expect(spokenInputs(pair)).toBe('');
      expect(pair.provider.sent.filter((e: any) => e.type === 'response.create').at(-1)?.response.instructions).toContain('Предыдущая реплика отклонена');
      expect(pair.vox.sent.some((e: any) => e.action === 'hangup')).toBe(false);
    });
    it.each([
      'Сейчас отвечу и зафиксирую время, чтобы мы не растягивали разговор.',
      'Хорошо, сейчас отвечу и уточню детали визита, чтобы у нас всё было согласовано. До свидания.',
      'Хорошо, отвечу на вопрос и заодно подтвержу визит.',
      'Хорошо, выбираю из этих двух вариантов и сразу скажу, как мне удобнее.',
      'Хорошо, давайте сразу определимся со временем, чтобы вам было удобно. До свидания.',
      'Завтра удобнее. Спасибо, до свидания.',
    ])(`${mode}: rejects a production non-answer before TTS and recovers once: %s`, async (text) => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'visit-options', transcript: 'Планируете подъехать сегодня или завтра?' });
      pair.provider.server({ type: 'response.created', response: { id: 'invalid' } });
      for (const delta of Array.from(text)) pair.provider.server({ type: 'response.output_text.delta', delta });
      pair.provider.server({ type: 'response.output_text.done', text });
      pair.provider.server({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'invalid-end', arguments: '{}' });
      pair.provider.server({ type: 'response.done', response: { id: 'invalid' } });
      expect(spokenInputs(pair)).toBe('');
      expect(pair.snapshot().transcript.filter((turn: any) => turn.role === 'client')).toHaveLength(0);
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create').at(-1)?.response.instructions).toContain('Предыдущая реплика отклонена');
      pair.provider.server({ type: 'response.created', response: { id: 'repair' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Завтра удобнее. Можно приехать в двенадцать?' });
      pair.provider.server({ type: 'response.done', response: { id: 'repair' } });
      expect(spokenInputs(pair)).toBe('Завтра удобнее. Можно приехать в двенадцать?');
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
    });
    it(`${mode}: a premature goodbye on the opening cannot deadlock the next answer`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'hello', transcript: 'Алло, слушаю.' });
      pair.provider.server({ type: 'response.created', response: { id: 'early' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Спасибо, до свидания.' });
      pair.provider.server({ type: 'response.output_text.done', text: 'Спасибо, до свидания.' });
      pair.provider.server({ type: 'response.done', response: { id: 'early' } });
      expect(spokenInputs(pair)).toBe('');
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      pair.provider.server({ type: 'response.created', response: { id: 'opening-repair' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Добрый день, меня зовут Анна. Какая цена автомобиля?' });
      pair.provider.server({ type: 'response.done', response: { id: 'opening-repair' } });
      expect(spokenInputs(pair)).toContain('Какая цена автомобиля?');
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
    });
    it(`${mode}: 916 answers payment without reopening the already named appointment`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'visit-916', transcript: 'Предлагаю приехать на тест-драйв завтра.' });
      await playReply(pair, 'chosen-916', 'Завтра ближе к одиннадцати мне удобно.');
      pair.tts.sent.length = 0;
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'slot-916', transcript: 'Предлагаю встретиться завтра в одиннадцать ноль-ноль.' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'payment-916', transcript: 'Вы планируете покупку за наличные или за кредит? Спрашиваю, потому что сейчас действует выгода по кредиту.' });
      for (const id of ['meta-payment-916', 'bad-payment-retry-916']) {
        pair.provider.server({ type: 'response.created', response: { id } });
        pair.provider.server({ type: 'response.output_text.delta', delta: 'Хорошо, отвечу по способу оплаты, а потом закрепим нашу встречу.' });
        pair.provider.server({ type: 'response.done', response: { id } });
      }
      expect(spokenInputs(pair)).toBe('Способ оплаты пока выбираю. Окончательно решу после осмотра.');
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
    });
    it(`${mode}: 916 a repeated day/time question is replaced by confirmation of eleven`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'invite-916', transcript: 'Предлагаю записаться на тест-драйв завтра.' });
      await playReply(pair, 'preference-916', 'Мне удобно завтра ближе к одиннадцати.');
      pair.tts.sent.length = 0;
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'confirmed-slot-916', transcript: 'Давайте договоримся завтра в одиннадцать ноль ноль.' });
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'convenient-916', transcript: 'Удобно?' });
      for (const id of ['repeat-916', 'repeat-again-916']) {
        pair.provider.server({ type: 'response.created', response: { id } });
        pair.provider.server({ type: 'response.output_text.delta', delta: 'Подскажите, на какой конкретный день и время договоримся?' });
        pair.provider.server({ type: 'response.done', response: { id } });
      }
      expect(spokenInputs(pair)).toBe('Хорошо, приеду завтра в одиннадцать.');
      expect(pair.snapshot().conversationFlow.events.some((event: any) => event.reason === 'repeated_visit_question')).toBe(true);
    });
    it(`${mode}: repeatedly invalid visit responses produce one clarification, not a loop`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'visit', transcript: 'Планируете подъехать сегодня или завтра?' });
      for (const id of ['invalid-one', 'invalid-two']) {
        pair.provider.server({ type: 'response.created', response: { id } });
        pair.provider.server({ type: 'response.output_text.delta', delta: 'Сейчас отвечу и зафиксирую время. До свидания.' });
        pair.provider.server({ type: 'response.done', response: { id } });
      }
      expect(spokenInputs(pair)).toBe('Подскажите, на какой конкретный день и время договоримся?');
      expect(pair.provider.sent.filter((event: any) => event.type === 'response.create')).toHaveLength(1);
      expect(pair.vox.sent.some((event: any) => event.action === 'hangup')).toBe(false);
    });
    it(`${mode}: 874 preserves the chosen hour and answers the latest SMS question`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'slots', transcript: 'На завтра для визита свободно с девяти до пятнадцати.' });
      pair.provider.server({ type: 'response.created', response: { id: 'choose' } });
      pair.provider.server({ type: 'response.output_text.delta', delta: 'Завтра ближе к двенадцати мне подходит. Сможете записать?' });
      pair.provider.server({ type: 'response.done', response: { id: 'choose' } });
      pair.tts.server({ audio: Buffer.alloc(800,0xff).toString('base64'), is_final_audio_for_turn: true });
      pair.vox.input({ customEvent:'media_status',status:'started' });
      await vi.advanceTimersByTimeAsync(1000);
      pair.vox.input({ customEvent:'media_status',status:'ended' });
      pair.tts.sent.length=0;
      pair.provider.server({ type:'conversation.item.input_audio_transcription.completed',item_id:'changed-time',transcript:'Ждём вас завтра. Пятнадцать часов. Удобно получить СМС на этот номер?' });
      pair.provider.server({ type:'response.created',response:{id:'wrong-time'} });
      pair.provider.server({ type:'response.output_text.delta',delta:'Да, удобно. Завтра в пятнадцать подъеду.' });
      pair.provider.server({ type:'response.done',response:{id:'wrong-time'} });
      expect(spokenInputs(pair)).toBe('');
      const repair=pair.provider.sent.filter((e:any)=>e.type==='response.create').at(-1)?.response.instructions;
      expect(repair).toContain('двенадцати');
      expect(repair).toContain('Удобно получить СМС');
      pair.provider.server({ type:'response.created',response:{id:'clarify-time'} });
      pair.provider.server({ type:'response.output_text.delta',delta:'Да, СМС на этот номер удобно. Но я предлагала завтра в двенадцать: можно сохранить это время?' });
      pair.provider.server({ type:'response.done',response:{id:'clarify-time'} });
      expect(spokenInputs(pair)).toContain('можно сохранить это время?');
      expect(pair.vox.sent.some((e:any)=>e.action==='hangup')).toBe(false);
    });
    it(`${mode}: 877 asks once for a missing price instead of silently moving to the visit`, async () => {
      const pair=await launch(mode);
      pair.provider.server({type:'conversation.item.input_audio_transcription.completed',item_id:'hello',transcript:'Алло, слушаю.'});
      pair.provider.server({type:'response.created',response:{id:'price'}});
      pair.provider.server({type:'response.output_text.delta',delta:'Сколько стоит автомобиль?'});
      pair.provider.server({type:'response.done',response:{id:'price'}});
      pair.tts.server({audio:Buffer.alloc(800,0xff).toString('base64'),is_final_audio_for_turn:true});
      pair.vox.input({customEvent:'media_status',status:'started'});
      await vi.advanceTimersByTimeAsync(1000);
      pair.vox.input({customEvent:'media_status',status:'ended'});
      pair.tts.sent.length=0;
      pair.provider.server({type:'conversation.item.input_audio_transcription.completed',item_id:'evasion',transcript:'Цена зависит от комплектации. Приезжайте в салон.'});
      pair.provider.server({type:'response.created',response:{id:'skip-price'}});
      pair.provider.server({type:'response.output_text.delta',delta:'Хорошо, тогда какой день удобнее для тест-драйва?'});
      pair.provider.server({type:'response.done',response:{id:'skip-price'}});
      expect(spokenInputs(pair)).toBe('');
      expect(pair.provider.sent.filter((e:any)=>e.type==='response.create').at(-1)?.response.instructions).toContain('ответ по существу пока не получен');
      pair.provider.server({type:'response.created',response:{id:'clarify-price'}});
      pair.provider.server({type:'response.output_text.delta',delta:'Подскажите хотя бы стартовую цену автомобиля?'});
      pair.provider.server({type:'response.done',response:{id:'clarify-price'}});
      expect(spokenInputs(pair)).toContain('стартовую цену');
    });
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
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Спасибо за звонок, до свидания.' });
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
    it(`${mode}: recovery queued behind cancellation validates the completed clarification and ignores duplicate empty ASR`, async () => {
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
      // «Нет, ничего не…» is still unfinished: noise did not complete it.
      // Wait for the guarded response rather than voicing the model's guess.
      expect(spokenInputs(pair)).toBe('');
      pair.provider.server({ type: 'response.done', response: { id: 'after-race' } });
      expect(spokenInputs(pair)).toBe('Повторите, пожалуйста, конец фразы.');
      expect(pair.snapshot().transcript.at(-1)?.text).toBe('Повторите, пожалуйста, конец фразы.');
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
    it(`${mode}: hangs up on Mia immediately without waiting for an end_call tool`, async () => {
      const pair = await launch(mode);
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'mia',
        transcript: 'Я голосовой ассистент Мия. Запишу всё слово в слово. Попробуем?' });
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
      expect(pair.vox.sent).toContainEqual({ customEvent: 'control', action: 'set_output_enabled', enabled: false });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pair.vox.sent.filter((event: any) => event.action === 'hangup')).toHaveLength(1);
      expect(pair.tts.sent.some((event: any) => event.inputs?.length)).toBe(false);
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
        pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Спасибо за звонок, до свидания.' });
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
      pair.provider.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'greeting', transcript: 'Спасибо за звонок, до свидания.' });
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
