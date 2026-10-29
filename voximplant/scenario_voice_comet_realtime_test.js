// Isolated hypothesis 2:
// Voximplant <-> backend <-> CometAPI GPT Realtime (text)
//              <-> ElevenLabs Streaming TTS (ULAW 8 kHz) -> Voximplant.
// customData: { call_id, to, event_url, stream_url, caller_id }

require(Modules.WebSocket);

function postEvent(eventUrl, payload) {
  if (!eventUrl) return;
  Net.httpRequest(eventUrl, function () {}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    postData: JSON.stringify(payload),
  });
}

VoxEngine.addEventListener(AppEvents.Started, function (startedEvent) {
  var data = {};
  try {
    var raw = VoxEngine.customData();
    data = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
  } catch (error) {
    Logger.write("comet_realtime_test: invalid customData: " + error);
  }

  var callId = data.call_id || ("comet_test_" + Date.now());
  var to = data.to ? "+" + String(data.to).replace(/\D/g, "") : "";
  var callerId = data.caller_id ? "+" + String(data.caller_id).replace(/\D/g, "") : "";
  var eventUrl = data.event_url || "";
  var streamUrl = data.stream_url || "";
  var voxSessionId = startedEvent && startedEvent.sessionId != null ? startedEvent.sessionId : null;
  var call = null;
  var mediaSocket = null;
  var finished = false;
  var finalEventSent = false;
  var ivrDetected = false;
  var ivrPath = [];
  var outputConnected = false;

  function send(eventName, details) {
    var payload = {
      call_id: callId,
      to: to,
      vox_call_id: call ? call.id() : null,
      event: eventName,
      ts: new Date().toISOString(),
      details: details || {},
    };
    if (voxSessionId != null) payload.vox_session_id = voxSessionId;
    postEvent(eventUrl, payload);
  }

  function sendSocket(value) {
    if (!mediaSocket) return;
    try { mediaSocket.send(JSON.stringify(value)); } catch (error) {
      Logger.write("comet_realtime_test: socket send failed: " + error);
    }
  }

  function finish(eventName, details) {
    if (finished) return;
    finished = true;
    if (!finalEventSent) {
      finalEventSent = true;
      send(eventName || "disconnected", details || {});
    }
    try { if (mediaSocket) mediaSocket.close(); } catch (ignoreSocketClose) {}
    setTimeout(function () { VoxEngine.terminate(); }, 250);
  }

  function onSocketMessage(event) {
    var text = event && event.text != null
      ? String(event.text)
      : event && typeof event.data === "string" ? event.data : "";
    if (!text) return;
    var message;
    try { message = JSON.parse(text); } catch (ignoreParse) { return; }
    if (!message || message.customEvent !== "control") return;
    if (message.action === "set_output_enabled") {
      if (message.enabled && !outputConnected) {
        try {
          mediaSocket.sendMediaTo(call, { tag: "assistant" });
          outputConnected = true;
          Logger.write("comet_realtime_test: live manager confirmed, output enabled");
        } catch (error) {
          Logger.write("comet_realtime_test: enable output failed: " + error);
        }
      } else if (!message.enabled && outputConnected) {
        try { mediaSocket.stopMediaTo(call); } catch (ignoreStop) {}
        outputConnected = false;
        try { mediaSocket.clearMediaBuffer(); } catch (ignoreClear) {}
        Logger.write("comet_realtime_test: IVR/waiting detected, output muted");
      } else if (!message.enabled) {
        try { mediaSocket.clearMediaBuffer(); } catch (ignoreAlreadyMutedClear) {}
      }
      return;
    }
    if (message.action === "clear_media") {
      try { mediaSocket.clearMediaBuffer(); } catch (error) {
        Logger.write("comet_realtime_test: clearMediaBuffer failed: " + error);
      }
      return;
    }
    if (message.action === "send_dtmf" && /^[0-9*#]$/.test(String(message.digit || ""))) {
      var digit = String(message.digit);
      try {
        call.sendDigits(digit);
        if (!ivrDetected) {
          ivrDetected = true;
          send("ivr_detected", { ivr: true });
        }
        ivrPath.push(digit);
        send("ivr_selected", {
          ivr: true,
          digit: digit,
          level: ivrPath.length,
          path: ivrPath.slice(),
        });
      } catch (error) {
        Logger.write("comet_realtime_test: sendDigits failed: " + error);
      }
      return;
    }
    if (message.action === "hangup") {
      try { call.hangup(); } catch (ignoreHangup) {}
    }
  }

  if (!to || !streamUrl || !eventUrl) {
    Logger.write("comet_realtime_test: missing to, stream_url or event_url");
    finish("failed", { reason: "invalid_custom_data" });
    return;
  }

  call = VoxEngine.callPSTN(to, callerId || undefined);
  send("progress", { reason: "call_initiated" });
  setTimeout(function () {
    if (finished) return;
    try { call.hangup(); } catch (ignoreHangup) {}
    finish("disconnected", { reason: "test_timeout" });
  }, 5 * 60 * 1000);

  call.addEventListener(CallEvents.Connected, function (event) {
    send("connected", { headers: event && event.headers ? event.headers : {} });
    try {
      mediaSocket = VoxEngine.createWebSocket(streamUrl);
      mediaSocket.onopen = function () {
        if (finished) return;
        Logger.write("comet_realtime_test: media WebSocket open");
        try {
          call.sendMediaTo(mediaSocket, { encoding: WebSocketAudioEncoding.PCM16_16KHZ });
          // Match the active dialer: keep assistant output muted until the
          // backend confirms that a live employee, not IVR/music, answered.
          outputConnected = false;
        } catch (error) {
          Logger.write("comet_realtime_test: input media routing failed: " + error);
          try { call.hangup(); } catch (ignoreHangup) {}
          finish("failed", { reason: "media_routing_failed" });
        }
      };
      mediaSocket.onmessage = onSocketMessage;
      mediaSocket.onmediastarted = function (event) {
        sendSocket({
          customEvent: "media_status",
          status: "started",
          tag: event && event.tag ? event.tag : "assistant",
        });
      };
      mediaSocket.onmediaended = function (event) {
        sendSocket({
          customEvent: "media_status",
          status: "ended",
          tag: event && event.tag ? event.tag : "assistant",
        });
      };
      mediaSocket.onerror = function (event) {
        Logger.write("comet_realtime_test: media WebSocket error: " + String(event && event.error || "unknown"));
      };
      mediaSocket.onclose = function () {
        if (finished) return;
        Logger.write("comet_realtime_test: media WebSocket closed");
        try { call.hangup(); } catch (ignoreHangup) {}
      };
    } catch (error) {
      Logger.write("comet_realtime_test: createWebSocket failed: " + error);
      try { call.hangup(); } catch (ignoreHangup) {}
      finish("failed", { reason: "websocket_failed" });
    }
  });

  call.addEventListener(CallEvents.Disconnected, function (event) {
    finish("disconnected", { reason: event && event.reason ? event.reason : "remote_disconnected" });
  });
  call.addEventListener(CallEvents.Failed, function (event) {
    finish("failed", {
      reason: event && event.reason ? event.reason : "call_failed",
      code: event && event.code != null ? event.code : null,
    });
  });
});
