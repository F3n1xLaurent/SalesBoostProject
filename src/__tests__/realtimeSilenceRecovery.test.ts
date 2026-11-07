import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ sockets: [] as any[], transcripts: [] as string[], responses: [] as any[], stallTts: false }));
vi.mock('../config', async (original) => {
  const actual = await original<any>();
  return { ...actual, config: { ...actual.config, openaiRealtimeApiKey: 'test', elevenLabsApiKey: 'test' } };
});
vi.mock('../voice/callLiveSpeakerClassifier', async original => {
  const actual = await original<any>();
  return { ...actual, classifyLiveSpeaker: vi.fn(async () => ({ speakerType: 'uncertain', confidence: 0, reason: 'offline_test' })) };
});
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    sent: any[] = [];
    constructor(readonly url: string) {
      super(); transport.sockets.push(this);
      void Promise.resolve().then(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1; this.emit('open');
        if (!String(url).includes('elevenlabs')) this.receive({ type: 'session.created' });
      });
    }
    receive(value: any) { this.emit('message', Buffer.from(JSON.stringify(value))); }
    send(raw: string) {
      const value = JSON.parse(raw); this.sent.push(value);
      if (value.type === 'session.update') this.receive({ type: 'session.updated' });
      if (value.type === 'conversation.item.create') this.receive({ type: 'conversation.item.created', item: value.item });
      if (value.type === 'input_audio_buffer.commit') {
        const id = `input-${this.sent.length}`;
        this.receive({ type: 'input_audio_buffer.committed', item_id: id });
        const transcript = transport.transcripts.shift() ?? '';
        setTimeout(() => this.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript }), 10);
      }
      if (value.type === 'response.create') {
        const response = transport.responses.shift();
        if (response) setTimeout(() => {
          const id = `response-${this.sent.length}`;
          this.receive({ type: 'response.created', response: { id } });
          if (response.text) this.receive({ type: 'response.output_text.delta', response_id: id, delta: response.text });
          if (response.tool) this.receive({ type: 'response.function_call_arguments.done', response_id: id,
            name: response.tool, call_id: id, arguments: JSON.stringify(response.args) });
          this.receive({ type: 'response.done', response: { id } });
        }, 1);
      }
      if (value.flush && !transport.stallTts) setTimeout(() => this.receive({ audio: Buffer.alloc(800, 128).toString('base64'), is_final_audio_for_turn: true }), 1);
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); }
  }
  return { default: Socket };
});

import { createHypothesis2Simulation } from '../voice/cometRealtimeTest';

class Vox extends EventEmitter {
  readyState = 1; sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  receive(value: any) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  close() { this.readyState = 3; this.emit('close'); }
}
let simulation: Awaited<ReturnType<typeof createHypothesis2Simulation>> | undefined;
let vox: Vox;
async function setup() {
  vox = new Vox();
  simulation = await createHypothesis2Simulation({ planId: 'test', planName: 'test', prompt: 'Ты клиент. Тебя зовут Андрей. Нужна диагностика автомобиля.', elevenLabsVoiceId: 'voice' } as any,
    'gpt-realtime-2.1', vox as any, { modelId: 'eleven_v4_turbo', defaultVoiceId: 'voice', pronunciationDictionaryLocators: [], stability: 0.75, similarityBoost: 0.75, speed: 1 } as any);
}
async function manager(text: string, settleMs = 2200) {
  transport.transcripts.push(text);
  const pcm = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 10000), i * 2);
  for (let i = 0; i < 10; i++) {
    vox.receive({ event: 'media', media: { payload: pcm.toString('base64') } });
    await vi.advanceTimersByTimeAsync(20);
  }
  await vi.advanceTimersByTimeAsync(settleMs);
}
beforeEach(() => { vi.useFakeTimers(); transport.sockets.length = 0; transport.transcripts.length = 0; transport.responses.length = 0; transport.stallTts = false; });
afterEach(() => { simulation?.close(); simulation = undefined; vi.useRealTimers(); });

describe('production bridge silence regressions with local transports', () => {
  it('994/1010: responds when an employee greets after a recording', async () => {
    await setup();
    transport.responses.push({ tool: 'skip_turn', args: { kind: 'ivr' } });
    await manager('Вас приветствует компания. Для контроля качества обслуживания разговор будет записан.');
    transport.responses.push({ text: 'Здравствуйте. Меня зовут Андрей. Нужна диагностика автомобиля.' });
    await manager('Оператор Анастасия, добрый вечер.');
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
  });

  it('958/1020: responds to the new employee after transfer', async () => {
    await setup();
    transport.responses.push({ tool: 'skip_turn', args: { kind: 'waiting' } });
    await manager('Оставайтесь на линии, соединяю с отделом продаж.');
    transport.responses.push({ text: 'Здравствуйте. Я звоню по поводу автомобиля.' });
    await manager('Добрый день, меня зовут Павел, отдел продаж. Какой автомобиль вас интересует?');
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
  });

  it('1007/1016: replays an unheard TTS reply on a fresh socket after the first-audio deadline', async () => {
    await setup();
    transport.stallTts = true;
    transport.responses.push({ text: 'Меня зовут Андрей.' });
    await manager('Здравствуйте, как я могу к вам обращаться?');
    expect(vox.sent.some(event => event.event === 'media')).toBe(false);
    transport.stallTts = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
    const texts = transport.sockets.filter(socket => String(socket.url).includes('elevenlabs'))
      .flatMap(socket => socket.sent).filter(message => message.inputs).map(message => message.inputs[0].text);
    expect(texts).toEqual(['Меня зовут Андрей. ', 'Меня зовут Андрей. ']);
  });

  it('1051: preserves the pending text when ElevenLabs closes with input_timeout_exceeded', async () => {
    await setup();
    transport.stallTts = true;
    transport.responses.push({ text: 'Да, я на связи.' });
    await manager('Здравствуйте, вы меня слышите?');
    const tts = transport.sockets.find(socket => String(socket.url).includes('elevenlabs'));
    tts.receive({ error: 'input_timeout_exceeded' });
    transport.stallTts = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
  });

  it('stops retrying a silent provider and releases the next manager reply', async () => {
    await setup();
    transport.stallTts = true;
    transport.responses.push({ text: 'Меня зовут Андрей.' });
    await manager('Здравствуйте, как я могу к вам обращаться?');
    await vi.advanceTimersByTimeAsync(11000);
    expect(simulation!.snapshot().errors).toContain('ElevenLabs: no audio after bounded recovery');
    expect(simulation!.snapshot().transcript.some(turn => turn.text === 'Меня зовут Андрей.')).toBe(false);
    const connections = transport.sockets.length;
    await vi.advanceTimersByTimeAsync(11000);
    expect(transport.sockets).toHaveLength(connections);
    transport.stallTts = false;
    transport.responses.push({ text: 'Андрей, я вас слышу.' });
    await manager('Алло, вы меня слышите?');
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
  });

  it('972/994: restores heard history and answers if an inference request never completes', async () => {
    await setup();
    await manager('Оператор Анастасия, добрый вечер.');
    expect(vox.sent.some(event => event.event === 'media')).toBe(false);
    transport.responses.push({ text: 'Здравствуйте, Андрей. Нужна диагностика автомобиля.' });
    await vi.advanceTimersByTimeAsync(9000);
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
    const restored = transport.sockets.flatMap(socket => socket.sent)
      .filter(message => message.type === 'conversation.item.create' && message.item.role === 'user');
    expect(restored.some(message => message.item.content[0].text.includes('Оператор Анастасия'))).toBe(true);
  });

  it('recovers a final TTS event without audio instead of losing the text to replay', async () => {
    await setup(); transport.stallTts = true;
    transport.responses.push({ text: 'Меня зовут Андрей.' });
    await manager('Здравствуйте, как к вам обращаться?');
    const tts = transport.sockets.find(socket => String(socket.url).includes('elevenlabs'));
    tts.receive({ is_final_audio_for_turn: true });
    transport.stallTts = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
  });

  it('recovers a new manager question when the cancelled inference never acknowledges completion', async () => {
    await setup();
    await manager('Здравствуйте, чем могу помочь?');
    const provider = transport.sockets.find(socket => !String(socket.url).includes('elevenlabs'));
    provider.receive({ type: 'response.created', response: { id: 'stuck-response' } });
    await manager('Алло, как я могу к вам обращаться?');
    transport.responses.push({ text: 'Меня зовут Андрей.' });
    await vi.advanceTimersByTimeAsync(9000);
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
    expect(simulation!.snapshot().errors.some(error => error.includes('response timeout'))).toBe(true);
  });

  it('does not replay an already audible reply after its deadline', async () => {
    await setup(); transport.responses.push({ text: 'Меня зовут Андрей.' });
    await manager('Здравствуйте, как к вам обращаться?');
    const connections = transport.sockets.length;
    const packets = vox.sent.filter(event => event.event === 'media').length;
    expect(packets).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(12000);
    expect(transport.sockets).toHaveLength(connections);
    expect(vox.sent.filter(event => event.event === 'media')).toHaveLength(packets);
  });

  it('cancels an unheard reply and its retry when the employee starts a new question', async () => {
    await setup(); transport.stallTts = true;
    transport.responses.push({ text: 'Меня зовут Андрей.' });
    await manager('Здравствуйте, как к вам обращаться?');
    transport.stallTts = false;
    transport.responses.push({ text: 'Да, я вас слышу.' });
    await manager('Алло, вы меня слышите?');
    await vi.advanceTimersByTimeAsync(12000);
    const texts = transport.sockets.filter(socket => String(socket.url).includes('elevenlabs'))
      .flatMap(socket => socket.sent).filter(message => message.inputs).map(message => message.inputs[0].text);
    expect(texts.filter(text => text.includes('Меня зовут Андрей'))).toHaveLength(1);
    expect(vox.sent.some(event => event.event === 'media')).toBe(true);
  });

  it('repeats the last audible question on «вас не слышно» and blocks a generated goodbye', async () => {
    await setup();
    transport.responses.push({ text: 'Во сколько можно приехать?' });
    await manager('Здравствуйте, чем могу помочь?');
    vox.receive({ customEvent: 'media_status', status: 'ended' });
    transport.responses.push({ text: 'Сейчас уточню. До свидания.', tool: 'end_call', args: { reason: 'finished' } });
    await manager('Алло, вас не слышно.');
    const texts = transport.sockets.filter(socket => String(socket.url).includes('elevenlabs'))
      .flatMap(socket => socket.sent).filter(message => message.inputs).map(message => message.inputs[0].text);
    expect(texts.filter(text => text.includes('Во сколько можно приехать?'))).toHaveLength(2);
    expect(texts.some(text => /До свидания|Сейчас уточню/u.test(text))).toBe(false);
    expect(vox.sent.some(event => event.action === 'hangup')).toBe(false);
  });

  it('asks for the missing end of a question instead of speaking the generated menu of guesses', async () => {
    await setup();
    transport.responses.push({ text: 'Здравствуйте.' });
    await manager('Здравствуйте, чем могу помочь?');
    vox.receive({ customEvent: 'media_status', status: 'ended' });
    transport.responses.push({ text: 'Вы спрашиваете, как обращаться, как проходит осмотр или как записаться?' });
    await manager('Подскажите, пожалуйста, как…');
    const texts = transport.sockets.filter(socket => String(socket.url).includes('elevenlabs'))
      .flatMap(socket => socket.sent).filter(message => message.inputs).map(message => message.inputs[0].text).join(' ');
    expect(texts).toContain('Повторите, пожалуйста, конец фразы.');
    expect(texts).not.toContain('как проходит осмотр');
    expect(texts).not.toContain('как записаться');
  });

  it('waits for a resumed question and answers its complete meaning without a premature clarification', async () => {
    await setup();
    transport.responses.push({ text: 'Здравствуйте.' });
    await manager('Здравствуйте, чем могу помочь?');
    vox.receive({ customEvent: 'media_status', status: 'ended' });
    await manager('Подскажите, пожалуйста, как', 800);
    transport.responses.push({ text: 'Меня зовут Андрей.' });
    await manager('к вам обращаться?');
    const texts = transport.sockets.filter(socket => String(socket.url).includes('elevenlabs'))
      .flatMap(socket => socket.sent).filter(message => message.inputs).map(message => message.inputs[0].text).join(' ');
    expect(texts).toContain('Меня зовут Андрей.');
    expect(texts).not.toContain('конец фразы');
  });
});
