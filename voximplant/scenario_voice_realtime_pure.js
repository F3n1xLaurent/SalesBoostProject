// Voximplant scenario: OpenAI Realtime, prompt comes from backend.
// Intended customData:
// {
//   call_id, to, event_url, caller_id, openai_api_key,
//   instructions, model, realtime_reasoning_effort, voice
// }

require(Modules.OpenAI);
require(Modules.WebSocket);

var FALLBACK_INSTRUCTIONS = [
  "Ты — клиент, который звонит сотруднику компании.",
  "Веди диалог только на русском языке, говори естественно и коротко.",
  "Если задача разговора выполнена или разговор исчерпан, попрощайся и вызови функцию end_call.",
  "Для рабочих запусков сервер должен передать полный prompt в customData.instructions."
].join("\n");

function parseCustomData() {
  var raw = VoxEngine.customData();
  try {
    if (typeof raw === "string") return JSON.parse(raw || "{}");
    if (raw && typeof raw === "object") return raw;
  } catch (err) {
    Logger.write("voice_realtime_pure: failed to parse customData: " + err);
  }
  return {};
}

function normalizePhone(value) {
  var digits = String(value || "").replace(/\D/g, "");
  return digits ? ("+" + digits) : "";
}

function getString(value, fallback) {
  var parsed = String(value || "").trim();
  return parsed || fallback;
}

function postEvent(eventUrl, payload) {
  if (!eventUrl) return;
  Net.httpRequest(
    eventUrl,
    function () {},
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      postData: JSON.stringify(payload),
    }
  );
}

function extractTranscriptFromItem(item) {
  if (!item || !item.content || !Array.isArray(item.content)) return "";
  var parts = [];
  for (var i = 0; i < item.content.length; i++) {
    var part = item.content[i];
    if (!part) continue;
    var text = "";
    if (part.transcript != null && String(part.transcript).trim()) text = String(part.transcript).trim();
    else if (part.text != null && String(part.text).trim()) text = String(part.text).trim();
    if (text) parts.push(text);
  }
  return parts.join(" ").trim();
}

VoxEngine.addEventListener(AppEvents.Started, function (e) {
  var data = parseCustomData();
  var voxSessionId = (e && e.sessionId != null) ? e.sessionId : null;
  var callId = getString(data.call_id, "call_" + Date.now());
  var to = normalizePhone(data.to);
  var callerId = normalizePhone(data.caller_id);
  var eventUrl = getString(data.event_url, "");
  var openaiApiKey = getString(data.openai_api_key, "");
  var model = getString(data.model, "gpt-realtime-2");
  var reasoningEffort = getString(data.realtime_reasoning_effort, "low");
  var voice = getString(data.voice, "marin");
  var instructions = getString(data.instructions, FALLBACK_INSTRUCTIONS);

  if (!to || !eventUrl) {
    Logger.write("voice_realtime_pure: missing to or event_url in customData.");
    VoxEngine.terminate();
    return;
  }

  if (!openaiApiKey || openaiApiKey.length < 10) {
    Logger.write("voice_realtime_pure: missing or invalid openai_api_key in customData.");
    VoxEngine.terminate();
    return;
  }

  if (!data.instructions || !String(data.instructions).trim()) {
    Logger.write("voice_realtime_pure: WARNING customData.instructions is empty, fallback prompt is used.");
  }

  Logger.write("voice_realtime_pure: started call_id=" + callId + " to=" + to + " model=" + model);

  var call = VoxEngine.callPSTN(to, callerId || undefined);
  var realtimeClient = null;
  var sessionEnded = false;
  var hangupScheduled = false;
  var callTranscript = [];
  var END_CALL_DELAY_MS = 2000;

  function pushTranscript(role, text) {
    text = String(text || "").trim();
    if (!text) return;
    callTranscript.push({ role: role, text: text });
    Logger.write("voice_realtime_pure: transcript turn " + role + " (" + callTranscript.length + " total)");
  }

  function scheduleHangup(reason) {
    if (hangupScheduled) return;
    hangupScheduled = true;
    Logger.write("voice_realtime_pure: scheduling hangup, reason=" + (reason || "script_end"));
    setTimeout(function () {
      finish({ reason: reason || "script_end" });
    }, END_CALL_DELAY_MS);
  }

  function finish(details) {
    if (sessionEnded) return;
    sessionEnded = true;
    try {
      if (realtimeClient) realtimeClient.close();
    } catch (closeErr) {}
    try {
      if (call) call.hangup();
    } catch (hangupErr) {}

    var payload = {
      call_id: callId,
      to: to,
      event: "disconnected",
      ts: new Date().toISOString(),
      details: details || {},
    };
    if (callTranscript.length > 0) payload.transcript = callTranscript;
    if (voxSessionId != null) payload.vox_session_id = voxSessionId;
    postEvent(eventUrl, payload);
    VoxEngine.terminate();
  }

  function handleRealtimeMessage(message) {
    if (sessionEnded || !message) return;
    var payload = message.payload ? message.payload : message;
    var type = message.type || payload.type || "";
    var customEvent = message.customEvent || "";

    if (type === "conversation.item.input_audio_transcription.completed" || customEvent === "ConversationItemInputAudioTranscriptionCompleted") {
      pushTranscript("manager", message.transcript != null ? message.transcript : payload.transcript);
      return;
    }

    if (type === "response.output_audio_transcript.done" || customEvent === "ResponseOutputAudioTranscriptDone") {
      pushTranscript("client", message.transcript != null ? message.transcript : payload.transcript);
      return;
    }

    if ((type === "conversation.item.done" || customEvent === "ConversationItemDone") && payload.item) {
      handleConversationItem(payload.item);
    }
  }

  function handleConversationItem(item) {
    if (!item) return;

    if (item.type === "function_call" && item.name === "end_call") {
      var args = {};
      var rawArgs = item.arguments != null ? String(item.arguments).trim() : "";
      try {
        args = rawArgs ? JSON.parse(rawArgs) : {};
      } catch (err) {
        Logger.write("voice_realtime_pure: end_call args parse error: " + err);
      }
      scheduleHangup(args && args.reason ? String(args.reason) : "script_end");
      return;
    }

    if (item.role === "user" || item.role === "assistant") {
      var text = extractTranscriptFromItem(item);
      if (text) pushTranscript(item.role === "user" ? "manager" : "client", text);
    }
  }

  function subscribeRealtimeEvents(client) {
    try {
      client.addEventListener(OpenAI.RealtimeAPIEvents.ConversationItemDone, function (ev) {
        var payload = ev && ev.payload ? ev.payload : ev && ev.data ? ev.data : ev || {};
        if (payload.item) handleConversationItem(payload.item);
      });
    } catch (err1) {
      Logger.write("voice_realtime_pure: ConversationItemDone listener warning: " + err1);
    }

    try {
      client.addEventListener("ConversationItemDone", function (ev) {
        var payload = ev && ev.payload ? ev.payload : ev && ev.data ? ev.data : ev || {};
        if (payload.item) handleConversationItem(payload.item);
      });
    } catch (err2) {}

    try {
      if (OpenAI.RealtimeAPIEvents.ResponseAudioTranscriptDone) {
        client.addEventListener(OpenAI.RealtimeAPIEvents.ResponseAudioTranscriptDone, function (clientArg, dataArg) {
          var data = dataArg != null ? dataArg : {};
          if (clientArg && clientArg.transcript != null) data = { transcript: clientArg.transcript };
          pushTranscript("client", data.transcript);
        });
      }
    } catch (err3) {
      Logger.write("voice_realtime_pure: ResponseAudioTranscriptDone listener warning: " + err3);
    }

    try {
      if (OpenAI.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted) {
        client.addEventListener(OpenAI.RealtimeAPIEvents.ConversationItemInputAudioTranscriptionCompleted, function (ev) {
          var payload = ev && ev.payload ? ev.payload : ev && ev.data ? ev.data : ev || {};
          pushTranscript("manager", payload.transcript);
        });
      }
    } catch (err4) {
      Logger.write("voice_realtime_pure: InputAudioTranscriptionCompleted listener warning: " + err4);
    }

    try {
      if (OpenAI.Events && OpenAI.Events.WebSocketMessage) {
        client.addEventListener(OpenAI.Events.WebSocketMessage, handleRealtimeMessage);
        Logger.write("voice_realtime_pure: subscribed to OpenAI.Events.WebSocketMessage");
      }
    } catch (err5) {
      Logger.write("voice_realtime_pure: WebSocketMessage listener warning: " + err5);
    }

    try {
      var previousOnMessage = client.onmessage;
      client.onmessage = function (ev) {
        if (previousOnMessage) {
          try {
            previousOnMessage(ev);
          } catch (prevErr) {}
        }
        var text = ev && ev.text ? ev.text : ev && ev.data != null ? String(ev.data) : "";
        if (!text) return;
        try {
          handleRealtimeMessage(JSON.parse(text));
        } catch (parseErr) {}
      };
    } catch (err6) {
      Logger.write("voice_realtime_pure: onmessage hook warning: " + err6);
    }

    try {
      if (typeof WebSocketEvents !== "undefined" && WebSocketEvents && WebSocketEvents.MESSAGE) {
        client.addEventListener(WebSocketEvents.MESSAGE, function (ev) {
          var text = ev && ev.text ? ev.text : "";
          if (!text) return;
          try {
            handleRealtimeMessage(JSON.parse(text));
          } catch (parseErr) {}
        });
      }
    } catch (err7) {
      Logger.write("voice_realtime_pure: WebSocketEvents.MESSAGE listener warning: " + err7);
    }
  }

  postEvent(eventUrl, {
    call_id: callId,
    to: to,
    vox_call_id: call.id(),
    event: "progress",
    ts: new Date().toISOString(),
    details: { reason: "call_initiated" },
  });

  call.addEventListener(CallEvents.Connected, function (ev) {
    postEvent(eventUrl, {
      call_id: callId,
      to: to,
      vox_call_id: call.id(),
      event: "connected",
      ts: new Date().toISOString(),
      details: ev && ev.headers ? { headers: ev.headers } : {},
    });

    var tools = [
      {
        type: "function",
        name: "end_call",
        description: "Технический сигнал о том, что сценарий разговора завершён и звонок можно вежливо завершать.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Краткая причина завершения, например next_step_scheduled, will_think, bad_tone.",
            },
          },
          required: [],
        },
      },
    ];

    OpenAI.createRealtimeAPIClient({
      apiKey: openaiApiKey,
      model: model,
      onWebSocketClose: function () {
        Logger.write("voice_realtime_pure: WebSocket closed");
        finish({ reason: "websocket_closed" });
      },
    })
      .then(function (client) {
        if (sessionEnded || !call) return;
        realtimeClient = client;
        subscribeRealtimeEvents(realtimeClient);

        try {
          call.sendMediaTo(realtimeClient);
          realtimeClient.sendMediaTo(call);
        } catch (mediaErr) {
          Logger.write("voice_realtime_pure: sendMediaTo error: " + mediaErr);
          finish({ error: String(mediaErr) });
          return;
        }

        try {
          var session = {
            type: "realtime",
            instructions: instructions,
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 250,
                  silence_duration_ms: 300,
                },
                transcription: {
                  model: "whisper-1",
                  language: "ru",
                },
              },
              output: {
                voice: voice,
              },
            },
            tools: tools,
            tool_choice: "auto",
          };
          if (model === "gpt-realtime-2") {
            session.reasoning = { effort: reasoningEffort };
          }
          realtimeClient.sessionUpdate({ session: session });
        } catch (sessionErr) {
          Logger.write("voice_realtime_pure: sessionUpdate warning: " + sessionErr);
        }

        try {
          realtimeClient.responseCreate({});
        } catch (responseErr) {
          Logger.write("voice_realtime_pure: responseCreate warning: " + responseErr);
        }
      })
      .catch(function (err) {
        Logger.write("voice_realtime_pure: createRealtimeAPIClient error: " + (err && err.message ? err.message : err));
        finish({ error: String(err && err.message ? err.message : err) });
      });
  });

  call.addEventListener(CallEvents.Failed, function (ev) {
    ev = ev || {};
    var cause = ev.code || ev.reason;
    var eventName = "failed";
    if (cause === 486) eventName = "busy";
    else if (cause === 480 || cause === 408) eventName = "no_answer";
    postEvent(eventUrl, {
      call_id: callId,
      to: to,
      event: eventName,
      ts: new Date().toISOString(),
      details: { code: ev.code, reason: ev.reason },
    });
    VoxEngine.terminate();
  });

  call.addEventListener(CallEvents.Disconnected, function (ev) {
    finish(ev ? { code: ev.code, reason: ev.reason } : {});
  });
});
