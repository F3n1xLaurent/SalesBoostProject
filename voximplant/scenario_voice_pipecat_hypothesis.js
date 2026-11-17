// Dedicated prototype rule only. Never replace voice_openai_realtime or voice_dialog.
// Outgoing: customData {call_id,to,caller_id,stream_url,event_url} from Python service.
// Incoming: provision the same per-call URLs via your trusted ingress controller.
require(Modules.WebSocket);
require(Modules.Conference);

VoxEngine.addEventListener(AppEvents.Started, function () {
  var data;
  try { data = JSON.parse(VoxEngine.customData() || "{}"); }
  catch (_) { VoxEngine.terminate(); return; }
  if (!data.stream_url || !data.event_url) { VoxEngine.terminate(); return; }
  var call = null;
  var socket = null;
  var finished = false;
  var connected = false;
  var allowedTags = {};
  var speechEnabled = !data.line_gate;
  var ivrPath = [];
  var dtmfCommands = {};
  var background = null;
  var backgroundTimer = null;
  var backgroundErrors = 0;
  var mixer = null;
  var breath = null;
  var breathPlaying = false;
  var breathCommand = null;
  var breathCommands = {};
  var lastBreathAt = -Infinity;

  function breathEvent(action) {
    if (socket) { try { socket.send(JSON.stringify({customEvent: "breath", action: action, commandId: breathCommand})); } catch (_) {} }
  }
  function prepareBreath() {
    if (finished || breath || !data.breath_audio || !/^https:\/\//.test(data.breath_audio.url || "")) return;
    try {
      var player = VoxEngine.createURLPlayer({url: data.breath_audio.url}, {loop: false, onPause: true});
      breath = player;
      player.addEventListener(PlayerEvents.PlaybackFinished, function () {
        if (breath !== player) return;
        breath = null;breathPlaying = false;breathEvent("ended");
        prepareBreath();
      });
      player.addEventListener(PlayerEvents.Error, function () {
        if (breath !== player) return;
        breath = null;breathPlaying = false;breathEvent("failed");
      });
      if (connected && mixer) player.sendMediaTo(mixer);
    } catch (_) { breathEvent("failed"); }
  }
  function stopBreath(finishing) {
    if (!breathPlaying && !finishing) return;
    var player = breath;breath = null;breathPlaying = false;
    try { if (player) player.stop(); } catch (_) {}
    if (player) breathEvent("stopped");
    if (!finishing) prepareBreath();
  }
  function playBreath(command) {
    if (!speechEnabled || !connected || finished || !mixer || !/^[a-f0-9]{32}$/.test(command || "") || breathCommands[command] || Date.now()-lastBreathAt<15000) return;
    prepareBreath();
    if (!breath) return;
    breathCommands[command] = true;breathCommand = command;lastBreathAt = Date.now();
    try { breath.sendMediaTo(mixer);breath.resume();breathPlaying = true;breathEvent("started"); }
    catch (_) { breathEvent("failed"); }
  }

  function stopBackground() {
    if (backgroundTimer) clearTimeout(backgroundTimer);
    backgroundTimer = null;
    var player = background;
    background = null;
    if (player) event('background_stopped');
    try { if (player) player.stop(); } catch (_) {}
    try { if (mixer) mixer.stop(); } catch (_) {}
    mixer = null;
  }
  function prepareBackground(paused) {
    if (finished || !data.background_audio || !/^https:\/\//.test(data.background_audio.url || '')) return;
    try {
      var player = VoxEngine.createURLPlayer({ url: data.background_audio.url }, { loop: true, onPause: paused });
      background = player;
      player.addEventListener(PlayerEvents.Started, function () { event('background_started'); });
      function ended(e) {
        if (finished || background !== player) return;
        background = null;
        try { player.stop(); } catch (_) {}
        if (e.error) {
          event('background_failed', String(e.error).slice(0, 160));
          backgroundErrors++;
          if (backgroundErrors > 2) return;
        }
        // Native loop normally stays running; recover an unexpected end too.
        backgroundTimer = setTimeout(function () {
          backgroundTimer = null;
          if (finished) return;
          event('background_restarted');
          prepareBackground(!connected);
        }, e.error ? 1000 : 0);
      }
      player.addEventListener(PlayerEvents.PlaybackFinished, ended);
      player.addEventListener(PlayerEvents.Error, ended);
      if (connected && mixer) player.sendMediaTo(mixer);
    } catch (_) { event('background_failed', 'player_creation_failed'); }
  }

  function event(name, reason) {
    Net.httpRequest(data.event_url, function () {}, {
      method: "POST", headers: { "Content-Type": "application/json" },
      postData: JSON.stringify({ event: name, call_id: data.call_id, reason: reason }),
    });
  }
  function finish(name, reason) {
    if (finished) return;
    finished = true;
    stopBreath(true);
    stopBackground();
    event(name, reason);
    try { if (socket) socket.close(); } catch (_) {}
    setTimeout(function () { VoxEngine.terminate(); }, 200);
  }
  function bind(activeCall) {
    call = activeCall;
    call.addEventListener(CallEvents.Disconnected, function () { finish("disconnected"); });
    call.addEventListener(CallEvents.Failed, function () { finish("failed"); });
    call.addEventListener(CallEvents.Connected, function () {
      if (connected || finished) return;
      connected = true;
      if (background || backgroundTimer || data.breath_audio) {
        try {
          // A call receives one stream: mix background and agent explicitly.
          // Only the agent WebSocket has tags; background cannot delay hangup.
          mixer = VoxEngine.createConference({ hd_audio: false });
          mixer.sendMediaTo(call);
          if (background) { background.sendMediaTo(mixer); background.resume(); }
          if (breath) breath.sendMediaTo(mixer);
        } catch (_) { stopBackground(); event('background_failed', 'mixer_creation_failed'); }
      }
      event("connected");
      socket = VoxEngine.createWebSocket(data.stream_url);
      socket.onopen = function () {
        socket.send(JSON.stringify({ customEvent: "transport_ready", diagnosticsVersion: 1, remoteUtcMs: Date.now() }));
        call.sendMediaTo(socket, { encoding: WebSocketAudioEncoding.PCM16_16KHZ });
      };
      socket.onmessage = function (e) {
        var message;
        try { message = JSON.parse(e.text || e.data || "{}"); } catch (_) { return; }
        if (message.customEvent !== "control") return;
        if (message.action === "diagnostic_ping" && typeof message.nonce === "string") {
          var receivedAt = Date.now();
          socket.send(JSON.stringify({ customEvent: "transport_pong", nonce: message.nonce,
            remoteReceivedUtcMs: receivedAt, remoteSentUtcMs: Date.now() }));
        } else if (message.action === "set_output_enabled") {
          speechEnabled = message.enabled === true;
          if (!speechEnabled) {
            socket.stopMediaTo(mixer || call);socket.clearMediaBuffer();allowedTags = {};
          }
        } else if (message.action === "send_dtmf") {
          var command = String(message.commandId || "");
          var digit = String(message.digit || "");
          var previous = dtmfCommands[command];
          var ok = false;
          if (previous) ok = previous.digit === digit && previous.ok;
          else if (/^[a-f0-9]{32}$/.test(command) && /^[0-9*#]$/.test(digit) && ivrPath.length < 6) {
            try { call.sendDigits(digit);ivrPath.push(digit);ok = true; } catch (_) {}
            dtmfCommands[command] = { digit: digit, ok: ok };
          }
          socket.send(JSON.stringify({ customEvent: "dtmf_result", commandId: command, digit: digit, ok: ok, path: ivrPath.slice() }));
        } else if (message.action === "play_breath") {
          playBreath(message.commandId);
        } else if (message.action === "stop_breath") {
          stopBreath(false);
        } else if (message.action === "begin_output" && speechEnabled && /^pc-\d+$/.test(message.tag)) {
          stopBreath(false);
          allowedTags[message.tag] = true;
          socket.sendMediaTo(mixer || call, { tag: message.tag });
        } else if (message.action === "clear_media") {
          // Flush audio already buffered in VoxEngine, in addition to Pipecat's queues.
          socket.clearMediaBuffer();
          allowedTags = {};
        } else if (message.action === "hangup") {
          call.hangup();
        }
      };
      socket.onmediastarted = function (e) {
        if (!allowedTags[e.tag]) return;
        socket.send(JSON.stringify({ customEvent: "playback", action: "started", tag: e.tag, remoteUtcMs: Date.now() }));
      };
      socket.onmediaended = function (e) {
        if (!allowedTags[e.tag]) return;
        delete allowedTags[e.tag];
        socket.send(JSON.stringify({ customEvent: "playback", action: "ended", tag: e.tag, remoteUtcMs: Date.now() }));
      };
      socket.onclose = function () {
        if (finished) return;
        finish("failed", "websocket_closed");
        try { call.hangup(); } catch (_) {}
      };
      socket.onerror = function () {
        finish("failed", "websocket_error");
        try { call.hangup(); } catch (_) {}
      };
    });
  }
  // Warm the file while PSTN is ringing; keep it paused until Connected.
  prepareBackground(true);
  prepareBreath();
  if (data.to) {
    bind(VoxEngine.callPSTN(data.to, data.caller_id || undefined));
  } else {
    VoxEngine.addEventListener(AppEvents.CallAlerting, function (e) {
      bind(e.call);
      e.call.answer();
    });
  }
  // Abnormal test safety limit, never reported as normal completion.
  setTimeout(function () {
    if (finished) return;
    finish("failed", "max_call_duration");
    try { if (call) call.hangup(); } catch (_) {}
  }, Math.max(60, Math.min(1800, Number(data.max_call_seconds) || 900)) * 1000);
});
