// Primary call-plan telephony: backend OpenAI Realtime + ElevenLabs streaming.
// Keep scenario_voice_comet_realtime_test.js and the ElevenLabs Agent scenario
// independent. No provider API keys are passed to this scenario.
require(Modules.WebSocket);

VoxEngine.addEventListener(AppEvents.Started, function (startedEvent) {
  var data = {};
  try {
    var customData = VoxEngine.customData();
    data = typeof customData === "string" ? JSON.parse(customData || "{}") : customData || {};
  } catch (ignoreParse) {}
  var callId = String(data.call_id || "");
  var to = "+" + String(data.to || "").replace(/\D/g, "");
  var eventUrl = String(data.event_url || "");
  var eventToken = String(data.event_token || "");
  var streamUrl = String(data.stream_url || "");
  var voxSessionId = startedEvent && startedEvent.sessionId;
  var call = null;
  var mediaSocket = null;
  var finished = false;
  var recordingStarted = false;
  var connectedAt = null;
  var outputConnected = false;
  var ivrDetected = false;
  var ivrPath = [];
  var heartbeat = null;

  function sendSocket(value) {
    if (!mediaSocket) return;
    try { mediaSocket.send(JSON.stringify(value)); } catch (ignoreSend) {}
  }
  function send(eventName, details, done) {
    var payload = JSON.stringify({
      call_id: callId, to: to, event: eventName, ts: new Date().toISOString(),
      vox_session_id: voxSessionId, recording_started: recordingStarted,
      connected_at: connectedAt, ivr: ivrDetected, ivr_path: ivrPath.slice(),
      details: details || {},
    });
    var attempt = 0;
    function post() {
      attempt++;
      Net.httpRequest(eventUrl, function (response) {
        if (response && response.code >= 200 && response.code < 300) { if (done) done(); return; }
        if (attempt < 3) { setTimeout(post, 1000); return; }
        Logger.write("openai_realtime: lifecycle delivery failed event=" + eventName);
        if (done) done();
      }, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Realtime-Webhook-Token": eventToken },
        postData: payload,
      });
    }
    post();
  }
  function finish(eventName, details) {
    if (finished) return;
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    send(eventName, details, function () { VoxEngine.terminate(); });
    try { if (mediaSocket) mediaSocket.close(); } catch (ignoreClose) {}
    // Call has already ended; keep the runtime alive only to deliver its event.
    setTimeout(function () { VoxEngine.terminate(); }, 12000);
  }
  function onSocketMessage(event) {
    var raw = event && event.text != null ? String(event.text) : event && event.data;
    var message;
    try { message = JSON.parse(raw); } catch (ignoreParse) { return; }
    if (!message || message.customEvent !== "control" || finished) return;
    try {
    if (message.action === "set_output_enabled") {
      if (message.enabled && !outputConnected) {
        mediaSocket.sendMediaTo(call, { tag: "assistant" });
        outputConnected = true;
      } else if (!message.enabled) {
        if (outputConnected) mediaSocket.stopMediaTo(call);
        outputConnected = false;
        mediaSocket.clearMediaBuffer();
      }
    } else if (message.action === "clear_media") {
      mediaSocket.clearMediaBuffer();
    } else if (message.action === "send_dtmf" && /^[0-9*#]$/.test(String(message.digit || ""))) {
      call.sendDigits(String(message.digit));
      if (!ivrDetected) { ivrDetected = true; send("ivr_detected", {}); }
      ivrPath.push(String(message.digit));
      send("ivr_selected", { digit: String(message.digit), path: ivrPath.slice() });
    } else if (message.action === "hangup") {
      call.hangup();
    }
    } catch (error) { Logger.write("openai_realtime: media control failed: " + error); }
  }
  if (!callId || to.length < 11 || !eventUrl || !eventToken || !streamUrl) {
    Logger.write("openai_realtime: invalid custom data"); VoxEngine.terminate(); return;
  }
  call = VoxEngine.callPSTN(to, data.caller_id || undefined);
  send("progress", { reason: "call_initiated" });
  heartbeat = setInterval(function () { if (!finished) send("progress", { reason: "call_active" }); }, 30000);
  setTimeout(function () {
    if (finished) return;
    try { call.hangup(); } catch (ignoreHangup) {}
    finish("disconnected", { reason: "max_duration" });
  }, 10 * 60 * 1000);

  call.addEventListener(CallEvents.RecordStarted, function () {
    recordingStarted = true; send("recording_started", {});
  });
  call.addEventListener(CallEvents.Connected, function () {
    connectedAt = new Date().toISOString();
    try { call.record({ stereo: true }); }
    catch (error) { Logger.write("openai_realtime: recording failed: " + error); }
    send("connected", {});
    try {
      mediaSocket = VoxEngine.createWebSocket(streamUrl);
      mediaSocket.onopen = function () {
        if (!finished) call.sendMediaTo(mediaSocket, { encoding: WebSocketAudioEncoding.PCM16_16KHZ });
      };
      mediaSocket.onmessage = onSocketMessage;
      mediaSocket.onmediastarted = function (event) {
        sendSocket({ customEvent: "media_status", status: "started", tag: event && event.tag || "assistant" });
      };
      mediaSocket.onmediaended = function (event) {
        sendSocket({ customEvent: "media_status", status: "ended", tag: event && event.tag || "assistant" });
      };
      mediaSocket.onclose = function () { if (!finished) { try { call.hangup(); } catch (ignoreHangup) {} } };
      mediaSocket.onerror = function () { Logger.write("openai_realtime: media socket error"); };
    } catch (error) {
      try { call.hangup(); } catch (ignoreHangup) {}
      finish("failed", { reason: "websocket_failed" });
    }
  });
  call.addEventListener(CallEvents.Disconnected, function (event) {
    finish("disconnected", { reason: event && event.reason || "remote_disconnected" });
  });
  call.addEventListener(CallEvents.Failed, function (event) {
    finish("failed", { reason: event && event.reason || "call_failed", code: event && event.code });
  });
});
