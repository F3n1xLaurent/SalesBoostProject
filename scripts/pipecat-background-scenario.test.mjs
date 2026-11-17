import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function scenario(withBackground = true) {
  const data = { to: '+79990000000', stream_url: 'wss://test/media', event_url: 'https://test/events',
    ...(withBackground ? { background_audio: { url: 'https://test/background.wav', volume: .2 } } : {}) };
  const calls = [], players = [], mixers = [], timers = new Map(), events = [];
  let started, counter = 0;
  const call = { handlers: {}, sendMediaTo(...args) { calls.push(args); },
    addEventListener(name, fn) { this.handlers[name] = fn; }, hangup() { this.handlers.disconnected?.(); } };
  const socket = { targets: [], sent: [], clears: 0,
    sendMediaTo(...args) { this.targets.push(args); }, send(raw) { this.sent.push(JSON.parse(raw)); },
    clearMediaBuffer() { this.clears++; }, close() {} };
  const context = { require() {}, Modules: { WebSocket: 'ws', Conference: 'conference' },
    AppEvents: { Started: 'started' }, CallEvents: { Connected: 'connected', Disconnected: 'disconnected', Failed: 'failed' },
    PlayerEvents: { Started: 'started', PlaybackFinished: 'finished', Error: 'error' },
    WebSocketAudioEncoding: { PCM16_16KHZ: 'pcm16' },
    setTimeout(fn, delay) { const id = ++counter; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Net: { httpRequest(url, callback, options) { events.push(JSON.parse(options.postData)); } },
    VoxEngine: { customData: () => JSON.stringify(data),
      addEventListener(name, fn) { started = fn; }, callPSTN: () => call, terminate() {}, createWebSocket: () => socket,
      createConference(options) { const mixer = { options, target: null, stopped: false,
        sendMediaTo(target) { this.target = target; }, stop() { this.stopped = true; } }; mixers.push(mixer); return mixer; },
      createURLPlayer(url, options) { const player = { url, options, handlers: {}, targets: [], stopped: false, resumed: false,
        addEventListener(name, fn) { this.handlers[name] = fn; }, sendMediaTo(target) { this.targets.push(target); },
        resume() { this.resumed = true; this.handlers.started?.(); }, stop() { this.stopped = true; } }; players.push(player); return player; } } };
  vm.runInNewContext(fs.readFileSync('voximplant/scenario_voice_pipecat_hypothesis.js', 'utf8'), context);
  started();
  return { call, socket, players, mixers, events, calls, timers,
    connect() { call.handlers.connected(); socket.onopen(); },
    command(action, tag = 'pc-1') { socket.onmessage({ text: JSON.stringify({ customEvent: 'control', action, tag }) }); },
    tick() { for (const [id, timer] of [...timers]) if (timer.delay <= 1000) { timers.delete(id); timer.fn(); } } };
}

test('preloads paused, loops after connection, explicitly mixes both outputs, keeps input separate', () => {
  const s = scenario();assert.equal(s.players[0].options.loop, true);assert.equal(s.players[0].options.onPause, true);
  assert.equal(s.players[0].url.url, 'https://test/background.wav');
  assert.equal(s.players[0].resumed, false);assert.equal(s.mixers.length, 0);
  s.connect();s.command('begin_output');
  assert.equal(s.players[0].resumed, true);assert.equal(s.players[0].targets[0], s.mixers[0]);
  assert.equal(s.socket.targets[0][0], s.mixers[0]);assert.equal(s.mixers[0].target, s.call);
  assert.equal(s.calls[0][0], s.socket);
  assert.ok(s.events.some(e => e.event === 'background_started'));
});

test('barge-in clears only speech, preserves background and speech tag ACKs', () => {
  const s = scenario();s.connect();s.command('begin_output');
  s.socket.onmediaended({ tag: 'pc-1' });assert.equal(s.socket.sent.at(-1).action, 'ended');
  s.command('clear_media');assert.equal(s.socket.clears, 1);assert.equal(s.players[0].stopped, false);
  assert.equal(s.mixers[0].stopped, false);
  s.command('begin_output', 'pc-2');s.socket.onmediastarted({ tag: 'pc-2' });
  assert.equal(s.socket.sent.at(-1).tag, 'pc-2');
});

test('unexpected end restarts, disconnect cancels retries and stops mixer/player', () => {
  const s = scenario();s.connect();s.players[0].handlers.finished({});s.tick();
  assert.equal(s.players.length, 2);assert.equal(s.players[1].targets[0], s.mixers[0]);
  s.call.handlers.disconnected();assert.equal(s.players[1].stopped, true);assert.equal(s.mixers[0].stopped, true);
  s.players[1].handlers.finished({});s.tick();assert.equal(s.players.length, 2);
});

test('background errors have bounded retries and do not end the voice call', () => {
  const s = scenario();s.connect();
  for (let i = 0; i < 4; i++) { s.players.at(-1).handlers.error({ error: 'Download failed' });s.tick(); }
  assert.equal(s.players.length, 3);s.command('begin_output');assert.equal(s.socket.targets[0][0], s.mixers[0]);
});

test('empty pack preserves original direct WebSocket playback', () => {
  const s = scenario(false);s.connect();s.command('begin_output');
  assert.equal(s.players.length, 0);assert.equal(s.mixers.length, 0);assert.equal(s.socket.targets[0][0], s.call);
});
