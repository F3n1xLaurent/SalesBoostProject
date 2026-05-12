// Voximplant scenario: исходящий звонок → OpenAI Realtime API.
// Режим 1: если передан dialog_url — ответы даёт наш бэкенд (виртуальный клиент), Realtime только озвучивает (function calling get_reply).
// Режим 2: без dialog_url — обычный Realtime с инструкциями (например, «отвечай на русском»).
// customData: { call_id, to, event_url, caller_id, openai_api_key [, dialog_url ] [, instructions ] }

require(Modules.OpenAI);

var DEFAULT_REALTIME_MODEL = "gpt-realtime-2";

function getRealtimeModel(data) {
  return (data && data.model && data.model.length) ? data.model : DEFAULT_REALTIME_MODEL;
}

function getRealtimeReasoning(data) {
  var effort = (data && data.realtime_reasoning_effort && data.realtime_reasoning_effort.length)
    ? String(data.realtime_reasoning_effort)
    : "low";
  return { effort: effort };
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

function postDialog(dialogUrl, body, callback) {
  Net.httpRequest(
    dialogUrl,
    function (result) {
      var replyText = "";
      var endSession = false;
      var code = result && (result.code != null ? result.code : result.status);
      var raw = (result && result.text) ? String(result.text) : "";
      if (code === 200 && raw && raw.length > 0) {
        var trimmed = raw.trim();
        if (trimmed.charAt(0) === "{") {
          try {
            var data = JSON.parse(raw);
            replyText = (data.reply_text != null) ? String(data.reply_text) : "";
            endSession = data.end_session === true;
          } catch (e) {
            Logger.write("postDialog parse error: " + e);
          }
        }
      }
      if (typeof callback === "function") callback(replyText, endSession);
    },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      postData: JSON.stringify(body),
      timeout: 12,
    }
  );
}

VoxEngine.addEventListener(AppEvents.Started, function (e) {
  var raw = VoxEngine.customData();
  var data = {};
  try {
    if (typeof raw === "string") {
      data = JSON.parse(raw || "{}");
    } else if (raw && typeof raw === "object") {
      data = raw;
    }
  } catch (err) {
    Logger.write("voice_realtime: Failed to parse customData: " + err);
  }

  var voxSessionId = (e && (e.sessionId != null)) ? e.sessionId : null;
  var callId = data.call_id || ("call_" + Date.now());
  var to = data.to;
  var eventUrl = data.event_url;
  var dialogUrl = data.dialog_url || null;
  var callerId = data.caller_id || "";
  var openaiApiKey = data.openai_api_key || "";

  if (!to || !eventUrl) {
    Logger.write("voice_realtime: Missing 'to' or 'event_url' in customData.");
    VoxEngine.terminate();
    return;
  }

  if (!openaiApiKey || openaiApiKey.length < 10) {
    Logger.write("voice_realtime: Missing or invalid 'openai_api_key' in customData.");
    VoxEngine.terminate();
    return;
  }

  to = "+" + String(to).replace(/\D/g, "");
  callerId = callerId ? "+" + String(callerId).replace(/\D/g, "") : "";
  var useOurAlgorithm = !!dialogUrl;
  if (useOurAlgorithm) Logger.write("voice_realtime: using our algorithm (dialog_url)");

  Logger.write("voice_realtime: to=" + to + " call_id=" + callId);

  var call = VoxEngine.callPSTN(to, callerId || undefined);
  var realtimeClient = null;
  var sessionEnded = false;

  function finish(details) {
    if (sessionEnded) return;
    sessionEnded = true;
    try {
      if (realtimeClient) realtimeClient.close();
    } catch (e) {}
    try {
      if (call) call.hangup();
    } catch (e) {}
    postEvent(eventUrl, {
      call_id: callId,
      to: to,
      event: "disconnected",
      ts: new Date().toISOString(),
      details: details || {},
      vox_session_id: voxSessionId,
    });
    VoxEngine.terminate();
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

    function connectAndSetup() {
      if (useOurAlgorithm && dialogUrl) {
        var firstReplyText = null;
        var clientReady = null;
        function maybeContinue() {
          if (clientReady === null || firstReplyText === null) return;
          var client = clientReady;
          var text = (typeof firstReplyText === "string") ? firstReplyText.trim() : "";
          realtimeClient = client;
          try {
            call.sendMediaTo(realtimeClient);
            realtimeClient.sendMediaTo(call);
          } catch (err) {
            Logger.write("voice_realtime: sendMediaTo error: " + err);
            finish({ error: String(err) });
            return;
          }
          var instructions = "Ты только озвучиваешь ответы системы. Запрещено придумывать свои фразы. Твоё первое сообщение пользователю (скажи только это, ничего больше): «" + (text || "Здравствуйте!") + "». Дальше на каждую реплику пользователя обязательно вызывай функцию get_reply с точным текстом того, что он сказал. Говори только точный текст из ответа функции (reply_text). Не добавляй от себя ни слова (никаких «Готов обсудить», «Какой шаг?» и т.п.). Отвечай только на русском.";
          var tools = [
              {
                type: "function",
                name: "get_reply",
                description: "Get the training system reply. Call with the exact transcript of what the user (sales manager) just said.",
                parameters: {
                  type: "object",
                  properties: { user_message: { type: "string", description: "Exact words the user said" } },
                  required: ["user_message"],
                },
              },
            ];
            // Register handler before sessionUpdate so we never miss a function_call
            realtimeClient.addEventListener(OpenAI.RealtimeAPIEvents.ConversationItemDone, function (ev) {
              if (sessionEnded || !realtimeClient) return;
              var payload = (ev && ev.payload) ? ev.payload : (ev && ev.data) ? ev.data : null;
              var item = (payload && payload.item) ? payload.item : (ev && ev.item) ? ev.item : null;
              if (!item || item.type !== "function_call" || item.name !== "get_reply") return;
              Logger.write("voice_realtime: get_reply function_call received");
              var args = {};
              var rawArgs = (item.arguments != null && typeof item.arguments === "string") ? item.arguments.trim() : "";
              try {
                args = rawArgs ? JSON.parse(rawArgs) : {};
              } catch (e) {
                Logger.write("voice_realtime: get_reply args parse error: " + e);
                return;
              }
              var userMessage = (args.user_message != null) ? String(args.user_message).trim() : "";
              var callIdForOutput = (item.call_id != null) ? item.call_id : (item.id != null) ? item.id : null;
              if (!callIdForOutput) return;
              var fallbackReply = "Связь установлена. Слышу вас.";
              Logger.write("voice_realtime: get_reply user_message=" + (userMessage ? userMessage.substring(0, 60) : "(empty)"));
              postDialog(dialogUrl, { call_id: callId, text: userMessage, is_final: true }, function (replyText, endSession) {
                if (sessionEnded || !realtimeClient) return;
                var usedFallback = !(replyText && replyText.length > 0);
                var output = usedFallback ? fallbackReply : replyText;
                Logger.write("voice_realtime: get_reply sending output len=" + output.length + (usedFallback ? " (fallback)" : ""));
                try {
                  realtimeClient.conversationItemCreate({
                    item: {
                      type: "function_call_output",
                      call_id: callIdForOutput,
                      output: output,
                    },
                  });
                } catch (e) {
                  Logger.write("voice_realtime: conversationItemCreate error: " + e);
                }
                if (endSession) {
                  setTimeout(function () { finish({ reason: "end_session" }); }, 8000);
                }
              });
            });
          try {
            var session = {
              type: "realtime",
              instructions: instructions,
              tools: tools,
              tool_choice: "auto",
            };
            if (getRealtimeModel(data) === "gpt-realtime-2") {
              session.reasoning = getRealtimeReasoning(data);
            }
            realtimeClient.sessionUpdate({
              session: session,
            });
          } catch (suErr) {
            Logger.write("voice_realtime: sessionUpdate warning: " + suErr);
          }
          try {
            realtimeClient.responseCreate({});
          } catch (rcErr) {
            Logger.write("voice_realtime: responseCreate warning: " + rcErr);
          }
        }
        postDialog(dialogUrl, { call_id: callId }, function (reply, endSession) {
          if (sessionEnded) return;
          firstReplyText = (reply != null && typeof reply === "string") ? reply.trim() : "";
          maybeContinue();
        });
        OpenAI.createRealtimeAPIClient({
          apiKey: openaiApiKey,
          model: getRealtimeModel(data),
          onWebSocketClose: function (event) {
            Logger.write("voice_realtime: WebSocket closed");
            finish({ reason: "websocket_closed" });
          },
        }).then(function (client) {
          if (sessionEnded || !call) return;
          clientReady = client;
          maybeContinue();
        }).catch(function (err) {
          Logger.write("voice_realtime: createRealtimeAPIClient error: " + (err && err.message ? err.message : err));
          finish({ error: String(err && err.message ? err.message : err) });
        });
      } else {
        OpenAI.createRealtimeAPIClient({
          apiKey: openaiApiKey,
          model: getRealtimeModel(data),
          onWebSocketClose: function (event) {
            Logger.write("voice_realtime: WebSocket closed");
            finish({ reason: "websocket_closed" });
          },
        }).then(function (client) {
          if (sessionEnded || !call) return;
          realtimeClient = client;
          try {
            call.sendMediaTo(realtimeClient);
            realtimeClient.sendMediaTo(call);
          } catch (err) {
            Logger.write("voice_realtime: sendMediaTo error: " + err);
            finish({ error: String(err) });
            return;
          }
          var instructions = (data.instructions && typeof data.instructions === "string" && data.instructions.length > 0)
            ? data.instructions
            : "Ты дружелюбный голосовой помощник. Отвечай только на русском языке. Говори кратко и по делу.";
          try {
            var session = {
              type: "realtime",
              instructions: instructions,
            };
            if (getRealtimeModel(data) === "gpt-realtime-2") {
              session.reasoning = getRealtimeReasoning(data);
            }
            realtimeClient.sessionUpdate({
              session: session,
            });
          } catch (suErr) {
            Logger.write("voice_realtime: sessionUpdate warning: " + suErr);
          }
        }).catch(function (err) {
          Logger.write("voice_realtime: createRealtimeAPIClient error: " + (err && err.message ? err.message : err));
          finish({ error: String(err && err.message ? err.message : err) });
        });
      }
    }

    connectAndSetup();
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
