// Isolated hypothesis scenario:
// Voximplant <-> our media bridge <-> Yandex AI Studio Realtime -> ElevenLabs TTS.
// This scenario deliberately does not use the production /webhooks/vox finalizer.
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
    Logger.write("yandex_realtime_test: invalid customData: " + error);
  }

  var callId = data.call_id || ("realtime_test_" + Date.now());
  var to = data.to ? "+" + String(data.to).replace(/\D/g, "") : "";
  var callerId = data.caller_id ? "+" + String(data.caller_id).replace(/\D/g, "") : "";
  var eventUrl = data.event_url || "";
  var streamUrl = data.stream_url || "";
  var voxSessionId = startedEvent && startedEvent.sessionId != null ? startedEvent.sessionId : null;
  var call = null;
  var mediaSocket = null;
  var finished = false;
  var finalEventSent = false;

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

  function messageText(event) {
    if (!event) return "";
    if (event.text != null) return String(event.text);
    if (typeof event.data === "string") return event.data;
    return "";
  }

  function onControlMessage(event) {
    var text = messageText(event);
    if (!text) return;
    var message;
    try { message = JSON.parse(text); } catch (ignoreParse) { return; }
    if (!message || message.customEvent !== "control") return;

    if (message.action === "clear_media") {
      try { mediaSocket.clearMediaBuffer(); } catch (error) {
        Logger.write("yandex_realtime_test: clearMediaBuffer failed: " + error);
      }
      return;
    }
    if (message.action === "send_dtmf" && /^[0-9*#]$/.test(String(message.digit || ""))) {
      try {
        call.sendDigits(String(message.digit));
        send("ivr_selected", { digit: String(message.digit) });
      } catch (error) {
        Logger.write("yandex_realtime_test: sendDigits failed: " + error);
      }
      return;
    }
    if (message.action === "hangup") {
      try { call.hangup(); } catch (ignoreHangup) {}
    }
  }

  if (!to || !streamUrl || !eventUrl) {
    Logger.write("yandex_realtime_test: missing to, stream_url or event_url");
    finish("failed", { reason: "invalid_custom_data" });
    return;
  }

  call = VoxEngine.callPSTN(to, callerId || undefined);
  send("progress", { reason: "call_initiated" });
  setTimeout(function () {
    if (finished) return;
    Logger.write("yandex_realtime_test: maximum test duration reached");
    try { call.hangup(); } catch (ignoreHangup) {}
    finish("disconnected", { reason: "test_timeout" });
  }, 5 * 60 * 1000);

  call.addEventListener(CallEvents.Connected, function (event) {
    send("connected", { headers: event && event.headers ? event.headers : {} });
    try {
      mediaSocket = VoxEngine.createWebSocket(streamUrl);
      mediaSocket.onopen = function () {
        if (finished) return;
        Logger.write("yandex_realtime_test: media WebSocket open");
        try {
          call.sendMediaTo(mediaSocket, { encoding: WebSocketAudioEncoding.PCM16_16KHZ });
          mediaSocket.sendMediaTo(call, { tag: "assistant" });
        } catch (error) {
          Logger.write("yandex_realtime_test: media routing failed: " + error);
          try { call.hangup(); } catch (ignoreHangup) {}
          finish("failed", { reason: "media_routing_failed" });
        }
      };
      mediaSocket.onmediastarted = function (event) {
        Logger.write(
          "yandex_realtime_test: output media started, tag=" +
          String(event && event.tag || "") +
          ", encoding=" + String(event && event.encoding || "")
        );
      };
      mediaSocket.onmediaended = function (event) {
        Logger.write(
          "yandex_realtime_test: output media ended, tag=" +
          String(event && event.tag || "") +
          ", mediaInfo=" + JSON.stringify(event && event.mediaInfo || {})
        );
      };
      mediaSocket.onmessage = onControlMessage;
      mediaSocket.onerror = function (event) {
        Logger.write("yandex_realtime_test: media WebSocket error: " + (event && event.error ? event.error : "unknown"));
      };
      mediaSocket.onclose = function () {
        if (finished) return;
        Logger.write("yandex_realtime_test: media WebSocket closed");
        try { call.hangup(); } catch (ignoreHangup) {}
      };
    } catch (error) {
      Logger.write("yandex_realtime_test: createWebSocket failed: " + error);
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
