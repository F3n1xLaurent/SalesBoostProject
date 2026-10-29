// Isolated network latency probe:
// VoxEngine -> CometAPI GPT Realtime (text only).
//
// It makes no phone calls and does not touch the production/test call flow.
// Required Voximplant application secret: COMETAPI_API_KEY.

require(Modules.WebSocket);

var MODEL = "gpt-realtime-2";
var RUNS = 5;
var TIMEOUT_MS = 45000;
var URL = "wss://api.cometapi.com/v1/realtime?model=" + encodeURIComponent(MODEL);

VoxEngine.addEventListener(AppEvents.Started, function () {
  var apiKey = VoxEngine.getSecretValue("COMETAPI_API_KEY");
  if (!apiKey) {
    Logger.write("COMET_VOX_ERROR missing COMETAPI_API_KEY secret");
    VoxEngine.terminate();
    return;
  }

  var startedAt = Date.now();
  var socketOpenedAt = null;
  var sessionCreatedAt = null;
  var sessionUpdatedAt = null;
  var requestStartedAt = null;
  var responseCreatedAt = null;
  var firstTextAt = null;
  var runIndex = 0;
  var results = [];
  var socket = null;
  var finished = false;

  function elapsed(from, to) {
    return Math.max(0, (to == null ? Date.now() : to) - from);
  }

  function send(message) {
    socket.send(JSON.stringify(message));
  }

  function finish(error) {
    if (finished) return;
    finished = true;
    if (error) Logger.write("COMET_VOX_ERROR " + String(error));
    Logger.write("COMET_VOX_SUMMARY " + JSON.stringify({
      model: MODEL,
      websocketOpenMs: socketOpenedAt == null ? null : elapsed(startedAt, socketOpenedAt),
      sessionCreatedMs: sessionCreatedAt == null ? null : elapsed(startedAt, sessionCreatedAt),
      sessionUpdatedMs: sessionUpdatedAt == null ? null : elapsed(startedAt, sessionUpdatedAt),
      runs: results,
    }));
    try { if (socket) socket.close(); } catch (ignoreClose) {}
    setTimeout(function () { VoxEngine.terminate(); }, 200);
  }

  function startRun() {
    if (runIndex >= RUNS) {
      finish();
      return;
    }
    requestStartedAt = Date.now();
    responseCreatedAt = null;
    firstTextAt = null;
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Ответь: соединение работает." }],
      },
    });
    send({ type: "response.create" });
  }

  var timeout = setTimeout(function () {
    finish("probe timed out after " + TIMEOUT_MS + " ms");
  }, TIMEOUT_MS);

  // Distinguishes a CometAPI/IP authorization problem from a WebSocket
  // upgrade-header compatibility problem in VoxEngine.
  var httpProbeStartedAt = Date.now();
  Net.httpRequest("https://api.cometapi.com/v1/models", function (result) {
    Logger.write("COMET_VOX_HTTP " + JSON.stringify({
      status: result && result.code != null ? result.code : null,
      elapsedMs: elapsed(httpProbeStartedAt),
      error: result && result.error ? String(result.error) : null,
    }));
  }, {
    method: "GET",
    headers: { Authorization: "Bearer " + apiKey },
    timeout: 10,
    connectionTimeout: 5,
  });

  try {
    socket = VoxEngine.createWebSocket(URL, {
      headers: [
        { key: "Authorization", value: "Bearer " + apiKey },
        { key: "OpenAI-Beta", value: "realtime=v1" },
      ],
      privacy: true,
    });
  } catch (error) {
    clearTimeout(timeout);
    finish("createWebSocket failed: " + error);
    return;
  }

  socket.onopen = function () {
    socketOpenedAt = Date.now();
    Logger.write("COMET_VOX_STAGE websocket_open_ms=" + elapsed(startedAt, socketOpenedAt));
  };

  socket.onmessage = function (event) {
    var raw = event && event.text != null ? String(event.text) : "";
    if (!raw) return;
    var message;
    try { message = JSON.parse(raw); } catch (ignoreParse) { return; }

    if (message.type === "session.created") {
      sessionCreatedAt = Date.now();
      Logger.write("COMET_VOX_STAGE session_created_ms=" + elapsed(startedAt, sessionCreatedAt));
      send({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["text"],
          instructions: "Отвечай одним коротким русским предложением.",
        },
      });
      return;
    }

    if (message.type === "session.updated") {
      sessionUpdatedAt = Date.now();
      Logger.write("COMET_VOX_STAGE session_updated_ms=" + elapsed(startedAt, sessionUpdatedAt));
      startRun();
      return;
    }

    if (message.type === "response.created") {
      responseCreatedAt = Date.now();
      return;
    }

    if (message.type === "response.text.delta" || message.type === "response.output_text.delta") {
      if (firstTextAt == null) firstTextAt = Date.now();
      return;
    }

    if (message.type === "response.done") {
      var doneAt = Date.now();
      var metric = {
        run: runIndex + 1,
        requestToResponseCreatedMs: responseCreatedAt == null ? null : elapsed(requestStartedAt, responseCreatedAt),
        requestToFirstTextMs: firstTextAt == null ? null : elapsed(requestStartedAt, firstTextAt),
        requestToDoneMs: elapsed(requestStartedAt, doneAt),
        status: message.response && message.response.status ? message.response.status : null,
      };
      results.push(metric);
      Logger.write("COMET_VOX_METRICS " + JSON.stringify(metric));
      runIndex += 1;
      setTimeout(startRun, 100);
      return;
    }

    if (message.type === "error") {
      clearTimeout(timeout);
      finish(message.error && message.error.message ? message.error.message : JSON.stringify(message.error || message));
    }
  };

  socket.onerror = function (event) {
    clearTimeout(timeout);
    finish("WebSocket error: " + String(event && event.error ? event.error : "unknown"));
  };

  socket.onclose = function (event) {
    if (!finished) {
      clearTimeout(timeout);
      finish("WebSocket closed before completion: " + JSON.stringify(event || {}));
    }
  };
});
