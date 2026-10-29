import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve('voximplant/scenario_voice_openai_realtime.js'), 'utf8');
function fixture() {
  let started: (event: any) => void = () => undefined;
  const listeners: Record<string, (event?: any) => void> = {};
  const events: Array<{ body: any; headers: any }> = [];
  const callbacks: Array<(response: any) => void> = [];
  const socket: Record<string, any> = { sendMediaTo: vi.fn(), stopMediaTo: vi.fn(), clearMediaBuffer: vi.fn(), close: vi.fn(), send: vi.fn() };
  const call = { addEventListener: vi.fn((name, handler) => { listeners[name] = handler; }), record: vi.fn(),
    sendMediaTo: vi.fn(), sendDigits: vi.fn(), hangup: vi.fn() };
  const terminate = vi.fn(); const timers: Array<{ callback: () => void; ms: number }> = [];
  const callPSTN = vi.fn(() => call);
  runInNewContext(source, {
    require: vi.fn(), Modules: { WebSocket: 'WebSocket' }, AppEvents: { Started: 'started' },
    CallEvents: { Connected: 'connected', RecordStarted: 'recorded', Disconnected: 'disconnected', Failed: 'failed' },
    WebSocketAudioEncoding: { PCM16_16KHZ: 'pcm16' }, Logger: { write: vi.fn() },
    VoxEngine: { addEventListener: (_event: string, handler: any) => { started = handler; }, callPSTN,
      terminate, createWebSocket: vi.fn(() => socket), customData: () => JSON.stringify({ call_id: 'call', to: '+79507503215',
        event_url: 'https://events.example/webhooks/vox-openai-realtime', event_token: 'hook-token', stream_url: 'wss://media.example/voice/openai-realtime' }) },
    Net: { httpRequest: (_url: string, callback: any, options: any) => { events.push({ body: JSON.parse(options.postData), headers: options.headers }); callbacks.push(callback); } },
    setTimeout: (callback: () => void, ms: number) => { timers.push({ callback, ms }); return timers.length; },
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
  });
  started({ sessionId: 789 });
  const control = (message: object) => socket.onmessage({ text: JSON.stringify({ customEvent: 'control', ...message }) });
  return { listeners, events, callbacks, socket, call, terminate, timers, control, callPSTN };
}
describe('separate production Voximplant scenario runtime', () => {
  it('records both sides and relays microphone only after answer with output initially muted', () => {
    const f = fixture();
    expect(f.callPSTN).toHaveBeenCalledWith('+79507503215', undefined);
    f.listeners.connected();
    expect(f.call.record).toHaveBeenCalledWith({ stereo: true });
    expect(f.socket.sendMediaTo).not.toHaveBeenCalled();
    f.socket.onopen();
    expect(f.call.sendMediaTo).toHaveBeenCalledWith(f.socket, { encoding: 'pcm16' });
    f.listeners.recorded();
    expect(f.events.at(-1)).toMatchObject({ body: { event: 'recording_started', recording_started: true, vox_session_id: 789 }, headers: { 'X-Realtime-Webhook-Token': 'hook-token' } });
  });
  it('acknowledges actual playback and clears stale audio on interruption', () => {
    const f = fixture(); f.listeners.connected();
    f.control({ action: 'set_output_enabled', enabled: true });
    expect(f.socket.sendMediaTo).toHaveBeenCalledWith(f.call, { tag: 'assistant' });
    f.socket.onmediastarted({ tag: 'assistant' }); f.socket.onmediaended({ tag: 'assistant' });
    expect(f.socket.send.mock.calls.map((call: string[]) => JSON.parse(call[0]).status)).toEqual(['started', 'ended']);
    f.control({ action: 'set_output_enabled', enabled: false });
    expect(f.socket.stopMediaTo).toHaveBeenCalledWith(f.call);
    expect(f.socket.clearMediaBuffer).toHaveBeenCalled();
  });
  it('hangs up immediately on the backend command and delivers one final event before terminating runtime', () => {
    const f = fixture(); f.listeners.connected(); f.listeners.recorded();
    f.control({ action: 'hangup' });
    expect(f.call.hangup).toHaveBeenCalledTimes(1);
    f.listeners.disconnected({ reason: 'normal' }); f.listeners.disconnected();
    expect(f.events.filter(event => event.body.event === 'disconnected')).toHaveLength(1);
    expect(f.events.at(-1)?.body).toMatchObject({ recording_started: true, connected_at: expect.any(String), vox_session_id: 789 });
    expect(f.terminate).not.toHaveBeenCalled();
    f.callbacks.at(-1)!({ code: 200 });
    expect(f.terminate).toHaveBeenCalledTimes(1);
  });
  it('retries lifecycle delivery without redialing', () => {
    const f = fixture();
    f.callbacks[0]({ code: 503 });
    f.timers.find(timer => timer.ms === 1000)!.callback();
    expect(f.events).toHaveLength(2);
    expect(f.events[1].body).toEqual(f.events[0].body);
    expect(f.callPSTN).toHaveBeenCalledTimes(1);
  });
  it('sends DTMF to the phone and persists the IVR path', () => {
    const f = fixture(); f.listeners.connected();
    f.control({ action: 'send_dtmf', digit: '1' });
    expect(f.call.sendDigits).toHaveBeenCalledWith('1');
    expect(f.events.at(-1)?.body).toMatchObject({ event: 'ivr_selected', ivr: true, ivr_path: ['1'] });
    f.control({ action: 'send_dtmf', digit: 'oops' });
    expect(f.call.sendDigits).toHaveBeenCalledTimes(1);
  });
});
