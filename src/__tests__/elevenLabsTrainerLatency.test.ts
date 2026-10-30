import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import {
  closeElevenLabsAgentConversation,
  runElevenLabsAgentAudioTurn,
  runElevenLabsAgentTurn,
  warmUpElevenLabsAgentConversation,
} from '../voice/elevenLabsAgent';

const mocks = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock('../voice/elevenLabsHttp', () => ({
  fetchElevenLabs: vi.fn(async () => new Response(JSON.stringify({ signed_url: 'wss://test.invalid/agent' }))),
}));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    constructor() {
      super();
      mocks.sockets.push(this);
      Promise.resolve().then(() => this.emit('open'));
    }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    server(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  return { default: Socket };
});

const original = { key: config.elevenLabsApiKey, agent: config.elevenLabsAgentId };
beforeEach(() => {
  vi.useFakeTimers();
  config.elevenLabsApiKey = 'test';
  config.elevenLabsAgentId = 'test';
  mocks.sockets.length = 0;
});
afterEach(() => {
  closeElevenLabsAgentConversation('session');
  config.elevenLabsApiKey = original.key;
  config.elevenLabsAgentId = original.agent;
  vi.useRealTimers();
});
const reply = (text: string) => ({ type: 'agent_response', agent_response_event: { agent_response: text } });

describe('whole-message trainer latency (mock providers)', () => {
  it('ignores partial text and delivers the whole response without the 1600ms idle delay', async () => {
    let resolved = false;
    const pending = runElevenLabsAgentTurn({ sessionId: 'session', prompt: 'Контекст', managerText: 'Здравствуйте' })
      .then((result) => { resolved = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    const socket = mocks.sockets[0];
    socket.server({ type: 'agent_chat_response_part', text_response_part: { type: 'delta', text: 'Часть' } });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
    socket.server(reply('Подскажите, пожалуйста, автомобиль ещё доступен?'));
    await expect(pending).resolves.toMatchObject({ clientMessage: 'Подскажите, пожалуйста, автомобиль ещё доступен?' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gates an early manager answer on warmup, without confusing it with the opening', async () => {
    const warmup = warmUpElevenLabsAgentConversation({ sessionId: 'session', prompt: 'Контекст', firstMessage: 'Добрый день!' });
    expect(warmUpElevenLabsAgentConversation({ sessionId: 'session', prompt: 'Контекст' })).toBe(warmup);
    const answer = runElevenLabsAgentTurn({ sessionId: 'session', prompt: 'Контекст', managerText: 'Здравствуйте, слушаю.' });
    await vi.advanceTimersByTimeAsync(0);
    const socket = mocks.sockets[0];
    expect(socket.sent.filter((event: any) => event.type === 'user_message')).toHaveLength(0);
    socket.server(reply('Добрый день!'));
    await warmup;
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sockets).toHaveLength(1);
    expect(socket.sent.filter((event: any) => event.type === 'user_message')).toEqual([
      { type: 'user_message', text: 'Здравствуйте, слушаю.' },
    ]);
    socket.server(reply('Меня интересует автомобиль из объявления.'));
    await expect(answer).resolves.toMatchObject({ clientMessage: 'Меня интересует автомобиль из объявления.' });
  });

  it('discards divergent opening context and allows the next turn to reconnect', async () => {
    const warmup = warmUpElevenLabsAgentConversation({ sessionId: 'session', prompt: 'Контекст', firstMessage: 'Добрый день!' });
    const failed = expect(warmup).rejects.toThrow('opening differs');
    await vi.advanceTimersByTimeAsync(0);
    mocks.sockets[0].server(reply('Какой-то другой вопрос.'));
    await failed;
    expect(mocks.sockets[0].readyState).toBe(3);
    const answer = runElevenLabsAgentTurn({ sessionId: 'session', prompt: 'Полная история с настоящим приветствием', managerText: 'Да.' });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sockets).toHaveLength(2);
    mocks.sockets[1].server(reply('Спасибо.'));
    await expect(answer).resolves.toMatchObject({ clientMessage: 'Спасибо.' });
  });

  it('acknowledges end_call arriving during TTS and retains it after socket closure', async () => {
    const pending = runElevenLabsAgentTurn({ sessionId: 'session', prompt: 'Контекст', managerText: 'До свидания.' });
    await vi.advanceTimersByTimeAsync(0);
    const socket = mocks.sockets[0];
    socket.server(reply('Спасибо, всего доброго.'));
    const result = await pending;
    expect(result.endedByAgent).toBe(false);
    socket.server({ type: 'client_tool_call', client_tool_call: { tool_call_id: 'end', tool_name: 'end_call' } });
    expect(socket.sent.some((event: any) => event.type === 'client_tool_result' && event.tool_call_id === 'end')).toBe(true);
    socket.close();
    expect(result.endedByAgent).toBe(true);
  });

  it('does not let late completion of a previous reply consume the next manager answer', async () => {
    const first = runElevenLabsAgentTurn({ sessionId: 'session', prompt: 'Контекст', managerText: 'Первый ответ.' });
    await vi.advanceTimersByTimeAsync(0);
    const socket = mocks.sockets[0];
    socket.server(reply('Первый вопрос.'));
    await first;
    let resolved = false;
    const second = runElevenLabsAgentTurn({ sessionId: 'session', managerText: 'Второй ответ.' })
      .then((result) => { resolved = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    socket.server({ type: 'agent_response_complete' });
    socket.server({ type: 'end_of_turn' });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    socket.server(reply('Второй вопрос.'));
    await expect(second).resolves.toMatchObject({ clientMessage: 'Второй вопрос.', endedByAgent: false });
  });

  it('keeps collecting audio in the separate audio-agent path', async () => {
    let resolved = false;
    const pending = runElevenLabsAgentAudioTurn({ sessionId: 'session', prompt: 'Контекст', audioBase64: 'AAAA' })
      .then((result) => { resolved = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    const socket = mocks.sockets[0];
    socket.server(reply('Полная реплика.'));
    socket.server({ type: 'audio', audio_event: { audio_base_64: Buffer.from([1, 2]).toString('base64') } });
    await vi.advanceTimersByTimeAsync(300);
    expect(resolved).toBe(false);
    socket.server({ type: 'audio', audio_event: { audio_base_64: Buffer.from([3, 4]).toString('base64') } });
    socket.server({ type: 'agent_response_complete' });
    const result = await pending;
    expect(Buffer.from(result.audioBase64!, 'base64').subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
