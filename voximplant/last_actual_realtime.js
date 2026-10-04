// Voximplant scenario: outbound call -> ElevenLabs Agent.
// customData:
// {
//   call_id,
//   to,
//   caller_id,
//   event_url,
//   instructions,
//   elevenlabs_voice_id
// }

var ELEVENLABS_API_KEY = "...";
var ELEVENLABS_AGENT_ID = "...";


require(Modules.ElevenLabs);

function parseCustomData() {
  var raw = VoxEngine.customData();

  try {
    if (typeof raw === "string") return JSON.parse(raw || "{}");
    if (raw && typeof raw === "object") return raw;
  } catch (err) {
    Logger.write("elevenlabs_test: failed to parse customData: " + err);
  }

  return {};
}

function normalizePhone(value) {
  var digits = String(value || "").replace(/\D/g, "");
  return digits ? "+" + digits : "";
}

function getString(value, fallback) {
  var parsed = String(value || "").trim();
  return parsed || fallback;
}

function postEvent(eventUrl, payload, done) {
  if (!eventUrl) {
    if (done) done();
    return;
  }

  Net.httpRequest(
    eventUrl,
    function () {
      if (done) done();
    },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      postData: JSON.stringify(payload),
    }
  );
}

VoxEngine.addEventListener(AppEvents.Started, function (e) {
  var data = parseCustomData();

  var callId = getString(data.call_id, "call_" + Date.now());
  var voxSessionId =
    e && e.sessionId != null && e.sessionId !== ""
      ? Number(e.sessionId)
      : null;

  var to = normalizePhone(data.to);
  var callerId = normalizePhone(data.caller_id);
  var eventUrl = getString(data.event_url, "");

  var elevenlabsApiKey = ELEVENLABS_API_KEY;
  var elevenlabsAgentId = ELEVENLABS_AGENT_ID;
  var elevenlabsVoiceId = getString(data.elevenlabs_voice_id, "");

  var instructions = getString(data.instructions, "");

  if (!to) {
    Logger.write("elevenlabs_test: missing to");
    VoxEngine.terminate();
    return;
  }

  if (!elevenlabsApiKey) {
    Logger.write("elevenlabs_test: missing elevenlabs_api_key");
    VoxEngine.terminate();
    return;
  }

  if (!elevenlabsAgentId) {
    Logger.write("elevenlabs_test: missing elevenlabs_agent_id");
    VoxEngine.terminate();
    return;
  }

  var call = VoxEngine.callPSTN(to, callerId || undefined);
  var client = null;
  var ended = false;
  var transcript = [];
  var pendingDtmf = null;
  var dtmfGuardMs = 1800;
  var connectionState = "awaiting_answer";
  var agentOutputConnected = false;
  var lastInputKind = "none";
  var lastExplicitDtmfInstructionAt = 0;

  // IVR tag for this call.
  // Becomes true once ElevenLabs makes the first valid send_dtmf tool call.
  var ivrDetected = false;

  // Digits that were actually sent to the remote IVR.
  var ivrPath = [];

  // Set to true after Voximplant confirms that call recording has started.
  var recordingStarted = false;

  function pushTranscript(role, text) {
    text = String(text || "").trim();
    if (!text) return;

    transcript.push({
      role: role,
      text: text,
    });

    Logger.write("elevenlabs_test: " + role + ": " + text);
  }

  function normalizeInputTranscript(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/\s+/g, " ");
  }

  function isAutomatedOrWaitingMessage(text) {
    return /подожд|ожидайте|оставайтесь на линии|соединя(?:ем|ю|ет)|перевожу|вам ответит|оператор ответит|ваш звонок|вы позвонили|добро пожаловать|вас приветствует|нажмите|выберите пункт|голосов(?:ое|ого) меню|после сигнала|абонент (?:занят|недоступен)/i.test(
      text
    );
  }

  function isExplicitBackgroundNoise(text) {
    return /^(?:\.{2,}|шум(?:\s|$)|музык(?:а|и|у|ой)(?:\s|$)|фонов(?:ый|ая|ое)\s+(?:шум|музыка)|звук\s+(?:дороги|мотора|радио)|\[(?:music|noise)\])/.test(
      text
    );
  }

  function isClearlyLiveHuman(text) {
    return /(?:^|[.!?\s,])(алло|слушаю|вас слушаю|говорите|здравствуйте|добрый день|добрый вечер|чем могу помочь|чем помочь|по какому вопросу|что вас интересует|повторите|повторите пожалуйста|не расслышал|не расслышала|кто это|кто говорит)(?:$|[.!?\s,])/i.test(
      text
    ) || /(?:меня зовут|[а-я]+,?\s+(?:менеджер|администратор|оператор)|менеджер|отдел продаж|отдел сервиса|сервисный центр|автосалон|автоцентр|салон|компания).*(?:слушает|на связи|говорит|чем могу помочь|чем помочь)?/i.test(
      text
    );
  }

  function muteAgentOutput(reason) {
    if (agentOutputConnected && client) {
      try {
        client.stopMediaTo(call);
      } catch (stopErr) {
        Logger.write("elevenlabs_test: stop agent output error=" + stopErr);
      }
    }

    agentOutputConnected = false;

    if (client) {
      try {
        client.clearMediaBuffer();
      } catch (clearErr) {}
    }

    Logger.write("elevenlabs_test: agent output muted, reason=" + reason);
  }

  function enableAgentOutput() {
    if (agentOutputConnected || !client) return;

    try {
      // Drop any response generated for IVR/music before opening the line.
      client.clearMediaBuffer();
    } catch (clearErr) {}

    try {
      client.sendMediaTo(call);
      agentOutputConnected = true;
      Logger.write("elevenlabs_test: live person confirmed, agent output enabled");
    } catch (sendErr) {
      Logger.write("elevenlabs_test: enable agent output error=" + sendErr);
    }
  }

  function handleUserTranscript(text) {
    var normalized = normalizeInputTranscript(text);
    if (!normalized) return;

    pushTranscript("manager", text);

    if (/нажмите|наберите|выберите (?:пункт|цифру|клавишу)|клавиш[ауи]|кнопк[ауи]/i.test(normalized)) {
      lastExplicitDtmfInstructionAt = Date.now();
    }

    if (isExplicitBackgroundNoise(normalized)) {
      lastInputKind = "background_noise";
      connectionState = "waiting_operator";
      muteAgentOutput("background_noise_transcript");
      return;
    }

    if (isAutomatedOrWaitingMessage(normalized)) {
      lastInputKind = "automation";
      connectionState = "waiting_operator";
      muteAgentOutput("ivr_or_waiting_message");
      return;
    }

    /*
     * Never unlock the agent on an arbitrary ASR result. Hold music can be
     * transcribed as lyrics or random speech. Until a live person explicitly
     * addresses the caller, every ambiguous transcript remains muted.
     */
    if (
      connectionState !== "live_conversation" &&
      !isClearlyLiveHuman(normalized)
    ) {
      lastInputKind = "unconfirmed_speech";
      muteAgentOutput("unconfirmed_human_speech");
      Logger.write(
        "elevenlabs_test: ignored unconfirmed transcript=" +
          normalized.slice(0, 160)
      );
      return;
    }

    lastInputKind = "live_human";
    connectionState = "live_conversation";
    enableAgentOutput();
  }

  function markIvrDetected() {
    if (ivrDetected) return;

    ivrDetected = true;

    Logger.write("elevenlabs_test: IVR detected");

    // One-time webhook: the server can immediately tag this call as containing IVR.
    postEvent(eventUrl, {
      call_id: callId,
      vox_session_id: voxSessionId,
      to: to,
      event: "ivr_detected",
      ts: new Date().toISOString(),
      ivr: true,
      details: {
        ivr: true,
      },
    });
  }

  function finish(details) {
    if (ended) return;
    ended = true;

    try {
      if (client) client.close();
    } catch (err1) {}

    try {
      if (call) call.hangup();
    } catch (err2) {}

    var finalPayload = {
      call_id: callId,
      vox_session_id: voxSessionId,
      to: to,
      event: "disconnected",
      ts: new Date().toISOString(),
      ivr: ivrDetected,
      ivr_path: ivrPath.slice(),
      recording_started: recordingStarted,
      details: details || {},
      transcript: transcript,
    };

    Logger.write("elevenlabs_test: final transcript size=" + transcript.length);
    Logger.write("elevenlabs_test: final payload=" + JSON.stringify(finalPayload));

    postEvent(eventUrl, finalPayload, function () {
      VoxEngine.terminate();
    });

    setTimeout(function () {
      VoxEngine.terminate();
    }, 1500);
  }

  function finishWithEvent(eventName, details) {
    if (ended) return;
    ended = true;

    try {
      if (client) client.close();
    } catch (err1) {}

    try {
      if (call) call.hangup();
    } catch (err2) {}

    var finalPayload = {
      call_id: callId,
      vox_session_id: voxSessionId,
      to: to,
      event: eventName,
      ts: new Date().toISOString(),
      ivr: ivrDetected,
      ivr_path: ivrPath.slice(),
      recording_started: recordingStarted,
      details: details || {},
      transcript: transcript,
    };

    Logger.write("elevenlabs_test: final event=" + eventName);
    Logger.write("elevenlabs_test: final payload=" + JSON.stringify(finalPayload));

    postEvent(eventUrl, finalPayload, function () {
      VoxEngine.terminate();
    });

    setTimeout(function () {
      VoxEngine.terminate();
    }, 1500);
  }

  function getPayload(ev) {
    return (
      (ev && ev.data && ev.data.payload) ||
      (ev && ev.payload) ||
      (ev && ev.data) ||
      ev ||
      {}
    );
  }

  function parseArgs(value) {
    if (!value) return {};
    if (typeof value === "object") return value;

    try {
      return JSON.parse(String(value));
    } catch (err) {
      return {};
    }
  }

  function extractTextDeep(obj) {
    if (!obj) return "";

    var keys = [
      "text",
      "transcript",
      "user_transcript",
      "userTranscript",
      "agent_response",
      "agentResponse",
      "response",
    ];

    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] != null && String(obj[keys[i]]).trim()) {
        return String(obj[keys[i]]).trim();
      }
    }

    if (typeof obj === "object") {
      for (var k in obj) {
        if (!obj.hasOwnProperty(k)) continue;
        var nested = extractTextDeep(obj[k]);
        if (nested) return nested;
      }
    }

    return "";
  }

  postEvent(eventUrl, {
    call_id: callId,
    vox_session_id: voxSessionId,
    to: to,
    event: "progress",
    ts: new Date().toISOString(),
    details: { reason: "call_initiated" },
  });

  var callConnected = false;

  call.addEventListener(CallEvents.RecordStarted, function (ev) {
    recordingStarted = true;

    Logger.write(
      "elevenlabs_test: recording started, vox_session_id=" +
        voxSessionId +
        ", record_url=" +
        (ev && ev.url ? ev.url : "")
    );
  });

  call.addEventListener(CallEvents.Connected, function (ev) {
    callConnected = true;

    Logger.write(
      "elevenlabs_test: call connected, vox_session_id=" + voxSessionId
    );

    /*
     * Record both directions of this PSTN leg.
     * stereo=true keeps the endpoint->Voximplant and
     * Voximplant->endpoint streams in separate channels.
     *
     * Backend retrieval:
     * GetCallHistory(call_session_history_id=vox_session_id,
     *                with_records=true)
     */
    try {
      call.record({
        stereo: true,
      });

      Logger.write(
        "elevenlabs_test: call.record requested, vox_session_id=" +
          voxSessionId
      );
    } catch (recordErr) {
      Logger.write(
        "elevenlabs_test: call.record error=" + recordErr
      );
    }

    postEvent(eventUrl, {
      call_id: callId,
      vox_session_id: voxSessionId,
      to: to,
      vox_call_id: call.id(),
      event: "connected",
      ts: new Date().toISOString(),
      details: ev && ev.headers ? { headers: ev.headers } : {},
    });

    ElevenLabs.createAgentsClient({
      xiApiKey: elevenlabsApiKey,
      agentId: elevenlabsAgentId,
      onWebSocketClose: function () {
        Logger.write("elevenlabs_test: websocket closed");
        finish({ reason: "websocket_closed" });
      },
    })
      .then(function (elevenClient) {
        client = elevenClient;

        Logger.write("elevenlabs_test: ElevenLabs client created");

        var conversationData = {
          conversation_config_override: {
            agent: {
              prompt: {
                prompt: instructions,
              },
              first_message: "",
              language: "ru",
            },
          },
        };

        if (elevenlabsVoiceId) {
          conversationData.conversation_config_override.tts = {
            voice_id: elevenlabsVoiceId,
          };
        }

        try {
          client.conversationInitiationClientData(conversationData);
          Logger.write(
            "elevenlabs_test: conversation initiation data sent, voice_id=" +
              elevenlabsVoiceId
          );
        } catch (err) {
          Logger.write(
            "elevenlabs_test: conversationInitiationClientData error: " + err
          );
        }

        client.addEventListener(
  ElevenLabs.AgentsEvents.UserTranscript,
  function (ev) {
    Logger.write(
      "EL UserTranscript RAW: " + JSON.stringify(ev)
    );

    handleUserTranscript(extractTextDeep(ev));

    /*
     * Если ElevenLabs уже решил нажать кнопку,
     * но IVR продолжил говорить — старое решение
     * было принято слишком рано.
     */
    if (pendingDtmf) {
      Logger.write(
        "elevenlabs_test: IVR continued, cancelling pending DTMF=" +
        pendingDtmf.digit
      );

      clearTimeout(pendingDtmf.timer);

      try {
        client.clientToolResult({
          tool_call_id: pendingDtmf.toolCallId,
          tool_name: "send_dtmf",
          result: {
            ok: false,
            cancelled: true,
            reason: "ivr_continued",
          },
        });
      } catch (err) {
        Logger.write(
          "elevenlabs_test: cancel DTMF result error=" +
          err
        );
      }

      pendingDtmf = null;
    }
  }
);

        client.addEventListener(ElevenLabs.AgentsEvents.AgentResponse, function (ev) {
          Logger.write("EL AgentResponse RAW: " + JSON.stringify(ev));
          if (agentOutputConnected) {
            pushTranscript("client", extractTextDeep(ev));
          } else {
            Logger.write("elevenlabs_test: suppressed agent response before live person confirmation");
            try {
              client.clearMediaBuffer();
            } catch (err) {}
          }
        });

        client.addEventListener(ElevenLabs.AgentsEvents.Interruption, function () {
          Logger.write("elevenlabs_test: interruption");
          /*
           * Do not clear the Voximplant media buffer here. Hold music and
           * road/radio noise frequently produce false ElevenLabs interruption
           * events; clearing the buffer cuts a valid agent phrase after its
           * first word. ElevenLabs already handles its own turn cancellation
           * and emits AgentResponseCorrection when a real interruption occurs.
           */
        });

        client.addEventListener(ElevenLabs.AgentsEvents.ClientToolCall, function (ev) {
  var payload = getPayload(ev);
  var tool =
    payload.client_tool_call ||
    payload.clientToolCall ||
    payload;

  var toolName =
    tool.tool_name ||
    tool.toolName ||
    tool.name;

  var toolCallId =
    tool.tool_call_id ||
    tool.toolCallId ||
    tool.id;

  var args = parseArgs(
    tool.parameters ||
    tool.args ||
    tool.arguments
  );

  Logger.write(
    "elevenlabs_test: tool_call=" +
    toolName +
    ", args=" +
    JSON.stringify(args)
  );

  /*
   * IVR / DTMF
   */
  if (toolName === "send_dtmf") {
  var digit = String(
    args.digit == null ? "" : args.digit
  ).trim();

  Logger.write(
    "elevenlabs_test: requested DTMF=" + digit
  );

  var hasRecentDtmfInstruction =
    lastExplicitDtmfInstructionAt > 0 &&
    Date.now() - lastExplicitDtmfInstructionAt <= 15000;

  if (!digit || !hasRecentDtmfInstruction || lastInputKind === "background_noise") {
    Logger.write(
      "elevenlabs_test: ignored DTMF without explicit IVR instruction, input_kind=" +
        lastInputKind
    );

    try {
      client.clientToolResult({
        tool_call_id: toolCallId,
        tool_name: toolName,
        result: {
          ok: true,
          ignored: true,
          reason: "no_explicit_ivr_digit",
        },
      });
    } catch (err) {}

    return;
  }

  if (!/^[0-9*#]$/.test(digit)) {
    try {
      client.clientToolResult({
        tool_call_id: toolCallId,
        tool_name: toolName,
        result: {
          ok: false,
          error: "invalid_digit",
        },
      });
    } catch (err) {}

    return;
  }

  /*
   * Валидный вызов send_dtmf означает, что ElevenLabs
   * обнаружил IVR. Отправляем этот webhook только один раз
   * за весь звонок.
   */
  markIvrDetected();

  /*
   * На всякий случай отменяем предыдущий pending.
   */
  if (pendingDtmf) {
    clearTimeout(pendingDtmf.timer);

    try {
      client.clientToolResult({
        tool_call_id: pendingDtmf.toolCallId,
        tool_name: "send_dtmf",
        result: {
          ok: false,
          cancelled: true,
          reason: "replaced_by_new_decision",
        },
      });
    } catch (err) {}

    pendingDtmf = null;
  }

  Logger.write(
    "elevenlabs_test: DTMF scheduled=" +
    digit +
    ", guard=" +
    dtmfGuardMs +
    "ms"
  );

  var scheduled = {
    digit: digit,
    toolCallId: toolCallId,
    timer: null,
  };

  scheduled.timer = setTimeout(function () {
    /*
     * Проверяем, что это всё ещё актуальное решение.
     */
    if (pendingDtmf !== scheduled) {
      return;
    }

    pendingDtmf = null;

    try {
      Logger.write(
        "elevenlabs_test: DTMF guard passed, sending=" +
        digit
      );

      call.sendDigits(digit);

      Logger.write(
        "elevenlabs_test: DTMF sent=" + digit
      );

      /*
       * The digit has actually been sent to the remote IVR.
       * Only now record it and notify the server.
       */
      ivrPath.push(digit);

      postEvent(eventUrl, {
        call_id: callId,
        vox_session_id: voxSessionId,
        to: to,
        event: "ivr_selected",
        ts: new Date().toISOString(),
        ivr: true,
        digit: digit,
        level: ivrPath.length,
        path: ivrPath.slice(),
        details: {
          ivr: true,
          digit: digit,
          level: ivrPath.length,
          path: ivrPath.slice(),
        },
      });

      Logger.write(
        "elevenlabs_test: IVR selection webhook sent, digit=" +
        digit +
        ", path=" +
        ivrPath.join("->")
      );

      client.clientToolResult({
        tool_call_id: toolCallId,
        tool_name: toolName,
        result: {
          ok: true,
          digit: digit,
        },
      });
    } catch (err) {
      Logger.write(
        "elevenlabs_test: sendDigits error=" +
        err
      );

      try {
        client.clientToolResult({
          tool_call_id: toolCallId,
          tool_name: toolName,
          result: {
            ok: false,
            error: String(err),
          },
        });
      } catch (resultErr) {}
    }
  }, dtmfGuardMs);

  pendingDtmf = scheduled;

  return;
}

  /*
   * END CALL
   */
  if (toolName === "end_call") {
    var reason =
      args.reason ||
      "agent_end_call";

    try {
      client.clientToolResult({
        tool_call_id: toolCallId,
        tool_name: toolName,
        result: {
          ok: true,
        },
      });
    } catch (err) {}

    setTimeout(function () {
      if (reason === "voicemail") {
        finishWithEvent("no_answer", {
          reason: "voicemail",
          detected_by: "elevenlabs_agent",
        });

        return;
      }

      finish({
        reason: reason,
      });
    }, 10000);

    return;
  }

  /*
   * Неизвестный tool
   */
  Logger.write(
    "elevenlabs_test: unknown tool=" +
    toolName
  );
});

        try {
          /*
           * AgentsClient needs the regular bidirectional bridge to initialize
           * its conversational audio pipeline. A standalone
           * call.sendMediaTo(client) keeps the socket alive but produces no
           * UserTranscript events. Start the supported bridge first, then stop
           * only the agent -> PSTN direction until a live human is confirmed.
           */
          VoxEngine.sendMediaBetween(call, client);
          agentOutputConnected = true;
          muteAgentOutput("awaiting_live_person");
          Logger.write(
            "elevenlabs_test: media bridge initialized; agent output remains muted"
          );
        } catch (err) {
          Logger.write("elevenlabs_test: sendMediaBetween error: " + err);
          finish({ error: String(err) });
        }
      })
      .catch(function (err) {
        Logger.write(
          "elevenlabs_test: createAgentsClient error: " +
            (err && err.message ? err.message : err)
        );

        finish({
          error: String(err && err.message ? err.message : err),
        });
      });
  });

  function mapEndEvent(ev) {
  ev = ev || {};

  var code = Number(ev.code || 0);
  var reason = String(ev.reason || "").toLowerCase();

  if (code === 486 || reason.indexOf("busy") !== -1) {
    return "busy";
  }

  if (
    code === 480 ||
    code === 408 ||
    code === 487 ||
    reason.indexOf("no answer") !== -1 ||
    reason.indexOf("timeout") !== -1 ||
    reason.indexOf("cancel") !== -1
  ) {
    return "no_answer";
  }

  return "failed";
}

  call.addEventListener(CallEvents.Failed, function (ev) {
  ev = ev || {};

  var eventName = mapEndEvent(ev);

  Logger.write(
    "elevenlabs_test: call failed, event=" +
      eventName +
      ", code=" +
      ev.code +
      ", reason=" +
      ev.reason
  );

  postEvent(eventUrl, {
    call_id: callId,
    vox_session_id: voxSessionId,
    to: to,
    event: eventName,
    ts: new Date().toISOString(),
    details: {
      code: ev.code,
      reason: ev.reason,
    },
  }, function () {
    VoxEngine.terminate();
  });

  setTimeout(function () {
    VoxEngine.terminate();
  }, 1500);
  });

  call.addEventListener(CallEvents.Disconnected, function (ev) {
    ev = ev || {};

    if (!callConnected) {
      var eventName = mapEndEvent(ev);

      Logger.write(
        "elevenlabs_test: call disconnected before connected, event=" +
          eventName +
          ", code=" +
          ev.code +
          ", reason=" +
          ev.reason
      );

      postEvent(eventUrl, {
        call_id: callId,
        vox_session_id: voxSessionId,
        to: to,
        event: eventName,
        ts: new Date().toISOString(),
        details: {
          code: ev.code,
          reason: ev.reason,
        },
      }, function () {
        VoxEngine.terminate();
      });

      setTimeout(function () {
        VoxEngine.terminate();
      }, 1500);

      return;
    }

    finish(ev ? { code: ev.code, reason: ev.reason } : {});
  });

  call.addEventListener(CallEvents.Disconnected, function (ev) {
    finish(ev ? { code: ev.code, reason: ev.reason } : {});
  });
});
