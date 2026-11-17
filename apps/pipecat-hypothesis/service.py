"""Separate process and dedicated VoxEngine rule; never imports production code."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import hmac
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlencode, urlparse
import uuid
from typing import Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket
from fastapi.responses import FileResponse
import httpx
from pydantic import BaseModel, Field, StrictBool
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from policy import OPENAI_PROVIDERS, Evidence, Playback, PROVIDERS, TTS_MODELS, REALTIME_TRANSCRIPTION_MODEL, realtime_transcription_config
from network import elevenlabs_http_options, elevenlabs_proxy, voximplant_http_options
from diagnostics import TraceArchive, trace_id, transcript, ACTIVE, utc_now
from conversation import ConversationMemory
from conversation_tuning import interruption_default, speech_default
from background_audio import select_background,asset_file
from breath import select_breath,enabled as breath_enabled

load_dotenv()
app = FastAPI(title="Pipecat hypothesis (isolated)")
sessions = {}
transport_probes = {}
INSTANCE_ID = str(uuid.uuid4())


def auth(authorization: str = Header(default="")):
    token = os.environ.get("PIPECAT_HYPOTHESIS_TOKEN", "")
    if len(token) < 32 or not hmac.compare_digest(authorization, f"Bearer {token}"):
        raise HTTPException(401, "Invalid prototype credentials")


class Options(BaseModel):
    provider: str = "openai"
    ttsModel: str = "eleven_v3"
    voiceId: str = Field(min_length=1, max_length=100)
    reasoningEffort: Literal["low", "minimal"] = "low"
    trimIdleAudio: StrictBool = False
    dialogueMode: Literal["legacy", "controller", "semantic"] = "legacy"
    backchannel: StrictBool = False


class Call(Options):
    to: str = Field(pattern=r"^\+[1-9]\d{9,14}$")
    prompt: str = Field(min_length=1, max_length=100000)
    context: dict = Field(default_factory=dict)


def validate(options, provider_check=True):
    if getattr(options,"backchannel",False) and getattr(options,"dialogueMode","legacy") not in ("controller","semantic"):
        raise HTTPException(400,"Короткие реакции доступны в режиме контроллера")
    if getattr(options,"dialogueMode","legacy") in ("controller","semantic") and options.provider not in OPENAI_PROVIDERS:
        raise HTTPException(400,"Контроллер пока поддерживает только OpenAI Realtime")
    if options.provider not in PROVIDERS or options.ttsModel not in TTS_MODELS:
        raise HTTPException(400, "Unsupported experiment variant")
    required = ["ELEVENLABS_API_KEY"]
    if getattr(options,"dialogueMode","legacy") in ("controller","semantic"):required.append("PROXYAPI_API_KEY")
    if provider_check:
        required.append({"openai": "OPENAI_API_KEY", "openai_mini": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY", "gemini_proxyapi": "PROXYAPI_API_KEY"}[options.provider])
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise HTTPException(503, "Missing: " + ", ".join(missing))


@asynccontextmanager
async def preflight_websocket(provider, uri, **kwargs):
    """Name the failing upstream; retry only a failed transient handshake."""
    kwargs.setdefault("close_timeout", 1)
    for attempt in (1, 2):
        try:
            socket = await connect(uri, **kwargs)
            break
        except InvalidStatus as exc:
            status = exc.response.status_code
            if attempt == 1 and status in {429, 500, 502, 503, 504}:
                await asyncio.sleep(0.2)
                continue
            raise HTTPException(503, f"{provider}: WebSocket-подключение отклонено, HTTP {status}.") from None
        except Exception as exc:
            proxy = " через настроенный прокси" if kwargs.get("proxy") else ""
            reason = "истекло время подключения" if isinstance(exc, TimeoutError) else type(exc).__name__
            raise HTTPException(503, f"{provider}: {reason}{proxy}.") from None
    try:
        yield socket
    except HTTPException:
        raise
    except Exception as exc:
        reason = "истекло время ожидания ответа" if isinstance(exc, TimeoutError) else type(exc).__name__
        raise HTTPException(503, f"{provider}: {reason} после подключения WebSocket.") from None
    finally:
        await socket.close()


async def check_compatibility(options, synthesize=False, provider_check=True):
    """No automatic substitutions; API access errors are evidence, not success."""
    validate(options, provider_check=provider_check)
    from pipeline import ElevenLabsDialogueTTSService, SileroVADAnalyzer, LocalSmartTurnAnalyzerV3
    # Fail before dialing if pinned imports, model assets or constructor API broke.
    SileroVADAnalyzer()
    LocalSmartTurnAnalyzerV3()
    tts = ElevenLabsDialogueTTSService(api_key=os.environ["ELEVENLABS_API_KEY"], sample_rate=16000,
        settings=ElevenLabsDialogueTTSService.Settings(model=options.ttsModel, voice=options.voiceId, language="ru", stability=0.5))
    await tts.cleanup()
    result = {"provider": options.provider, "model": PROVIDERS[options.provider], "ttsModel": options.ttsModel,
              "reasoningEffort": options.reasoningEffort if options.provider in OPENAI_PROVIDERS else None,
              "audio": "PCM16 little-endian mono 16000 Hz; OpenAI resampled to 24000 Hz",
              "nativeTts": False if provider_check else None, "serverVad": False if provider_check else None,
              "checks": [], "synthesisProbed": False}
    if provider_check and options.dialogueMode in ("controller","semantic"):
        from turn_meaning import MODEL as semantic_model
        async with httpx.AsyncClient(timeout=3) as client:
            check=await client.post("https://api.proxyapi.ru/v1/decisions",headers={"Authorization":"Bearer "+os.environ["PROXYAPI_API_KEY"]},json={
                "model":semantic_model if options.dialogueMode=='semantic' else "openai/gpt-6-luna-decisions","state":{"text":"Добрый день"},"questions":{"kind":{"type":"choice","instructions":"Это приветствие?","criteria":{"greeting":"Приветствие","other":"Другая реплика"}}}})
            if check.status_code!=200:raise HTTPException(503,f"Decisions ProxyAPI HTTP {check.status_code}")
            if check.json().get("answers",{}).get("kind",{}).get("choice") not in ("greeting","other"):
                raise HTTPException(503,"Decisions ProxyAPI: неподдерживаемый ответ")
        result["checks"].append("controller_decisions_access")
    async with httpx.AsyncClient(timeout=20, **elevenlabs_http_options()) as client:
        response = await client.get("https://api.elevenlabs.io/v1/models", headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
        response.raise_for_status()
        if options.ttsModel not in {m["model_id"] for m in response.json()}:
            raise HTTPException(503, f"ElevenLabs model not available: {options.ttsModel}")
        response = await client.get(f"https://api.elevenlabs.io/v1/voices/{options.voiceId}", headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
        response.raise_for_status()
        result["checks"].append("elevenlabs_model_and_voice_access")
    if provider_check and options.provider == "gemini":
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash",
                headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
            response.raise_for_status()
            result["checks"].append("gemini_flash_model_access_buffered_api")
    if provider_check and options.provider == "gemini_proxyapi":
        from gemini_provider import create_gemini_service
        from pipecat.processors.aggregators.llm_context import LLMContext
        llm = create_gemini_service(options.provider, max_tokens=256)
        try:
            text = await llm.run_inference(LLMContext([{"role": "user", "content": "Ответь одним словом: готово."}]))
            if not text or not text.strip():
                raise HTTPException(503, "Gemini ProxyAPI returned no text")
            result["checks"].append("gemini_proxyapi_native_google_api_text_response")
            result["upstream"] = "proxyapi"
        finally:
            await llm.cleanup()
    if provider_check and options.provider in OPENAI_PROVIDERS:
        async with preflight_websocket("OpenAI Realtime", f"wss://api.openai.com/v1/realtime?model={PROVIDERS[options.provider]}",
            additional_headers={"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]}, open_timeout=15) as ws:
            await ws.send(json.dumps({"type": "session.update", "session": {"type": "realtime", "model": PROVIDERS[options.provider], "output_modalities": ["text"],
                "reasoning": {"effort": options.reasoningEffort},
                "audio": {"input": {"turn_detection": None, "transcription": realtime_transcription_config(),
                    "format": {"type": "audio/pcm", "rate": 24000}}}}}))
            async with asyncio.timeout(15):
                async for raw in ws:
                    event = json.loads(raw)
                    if event["type"] == "error":
                        raise HTTPException(503, "OpenAI session rejected: " + str(event.get("error", {}).get("code", "unknown")))
                    if event["type"] == "session.updated":
                        effective = event["session"]
                        if effective.get("model") != PROVIDERS[options.provider]:
                            raise HTTPException(503, "OpenAI did not confirm selected Realtime model")
                        if effective.get("output_modalities") != ["text"] or effective["audio"]["input"].get("turn_detection") is not None:
                            raise HTTPException(503, "OpenAI did not apply text-only / VAD-off settings")
                        if (effective.get("reasoning") or {}).get("effort") != options.reasoningEffort:
                            raise HTTPException(503, "OpenAI did not confirm requested reasoning effort")
                        transcription = effective["audio"]["input"].get("transcription") or {}
                        if transcription.get("model") != REALTIME_TRANSCRIPTION_MODEL or transcription.get("languages") != ["ru"]:
                            raise HTTPException(503, "OpenAI did not confirm live transcription in Russian")
                        result["transcriptionModel"] = transcription["model"]
                        result["checks"].append("openai_live_transcription_ru_confirmed")
                        result["checks"].append("openai_realtime_text_only_vad_disabled")
                        break
        if "openai_realtime_text_only_vad_disabled" not in result["checks"]:
            raise HTTPException(503, "OpenAI closed before confirming session settings")
    if synthesize:
        query = urlencode({"model_id": options.ttsModel, "output_format": "pcm_16000", "sync_alignment": "true"})
        async with preflight_websocket("ElevenLabs TTS", "wss://api.elevenlabs.io/v1/text-to-dialogue/multi-stream-input?" + query,
            additional_headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}, open_timeout=15,
            **({"proxy": elevenlabs_proxy()} if elevenlabs_proxy() else {})) as ws:
            await ws.send(json.dumps({"context_id": "probe", "voices": [options.voiceId]}))
            start = time.monotonic()
            await ws.send(json.dumps({"context_id": "probe", "inputs": [{"text": "Здравствуйте. Проверяем качество голоса и задержку ответа.", "voice_id": options.voiceId}], "flush": True}))
            async with asyncio.timeout(30):
                async for raw in ws:
                    event = json.loads(raw)
                    if event.get("error") or event.get("message"):
                        raise HTTPException(503, "ElevenLabs synthesis rejected")
                    if event.get("audio"):
                        import base64
                        audio = base64.b64decode(event["audio"], validate=True)
                        if len(audio) % 2 or not audio:
                            raise HTTPException(503, "Invalid PCM16 from ElevenLabs")
                        result["synthesisProbed"] = True
                        result["ttsFirstAudioMs"] = round((time.monotonic() - start) * 1000, 2)
                        result["checks"].append("elevenlabs_ttd_pcm16000_first_audio")
                        break
    if synthesize and not result["synthesisProbed"]:
        raise HTTPException(503, "ElevenLabs closed the stream before sending audio")
    result["scope"] = "full_preflight" if provider_check else "tts_only"
    return result


@dataclass
class Session:
    id: str
    provider: str
    tts_model: str
    voice_id: str
    prompt: str
    context: dict
    to: str
    reasoning_effort: str = "low"
    trim_idle_audio: bool = False
    transcription_model: str = REALTIME_TRANSCRIPTION_MODEL
    interruption_ms: int = field(default_factory=interruption_default)
    speech_mode: str = field(default_factory=speech_default)
    prompt_mode: str = "legacy"
    dialogue_mode: str = "legacy"
    backchannel: bool = False
    production: bool = False
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    status: str = "prepared"
    created: float = field(default_factory=time.time)
    connected: bool = False
    playback: Playback = field(default_factory=Playback)
    evidence: Evidence = field(init=False)

    def __post_init__(self):
        self.archive = TraceArchive()
        self.diagnostic_error = None
        self._saved_status = None
        self.finalized = False
        self.media_disconnected = False
        self.max_call_seconds = max(60,min(1800,int(os.getenv("PIPECAT_MAX_CALL_SECONDS","900"))))
        def emit(event):
            try:
                self.archive.append(self.id, event)
                if self._saved_status != self.status:
                    self.persist()
            except Exception as exc:
                self.diagnostic_error = type(exc).__name__
        self.evidence = Evidence(emit)
        self.evidence.memory = ConversationMemory(self.prompt)
        self.evidence.memory.semantic_mode = self.dialogue_mode=="semantic"
        self.persist()
        self.evidence.event("session_created", diagnostic_id="pc-" + self.id)

    def persist(self):
        self.archive.metadata(self.id, {"id": self.id, "diagnosticId": "pc-" + self.id, "schemaVersion": 2,
            "instanceId": INSTANCE_ID, "provider": self.provider, "model": PROVIDERS[self.provider],
            "runtimeRevision": "pipecat-semantic-17" if self.dialogue_mode=="semantic" else "pipecat-controller-13" if self.dialogue_mode=="controller" else "pipecat-conversation-4", "callState": {**self.evidence.memory.snapshot(),**({"controller":self.controller.snapshot()} if getattr(self,"controller",None) else {})},
            "failureReason": getattr(self, "failure_reason", None), "maxCallSeconds":self.max_call_seconds,
            "kind": "production_call" if self.production else "call" if self.to else "probe",
            "ttsModel": self.tts_model, "voiceId": self.voice_id, "status": self.status,
            "reasoningEffort": self.reasoning_effort if self.provider in OPENAI_PROVIDERS else None,
            "transcriptionModel": self.transcription_model if self.provider in OPENAI_PROVIDERS else None,
            "trimIdleAudio": self.trim_idle_audio if self.provider in OPENAI_PROVIDERS else None,
            "createdAt": self.created, "updatedAt": utc_now(), "planName": self.context.get("planName"),
            "eventCount": self.evidence.sequence, "finalized": self.finalized,
            "configuration": {"prompt": self.prompt, "businessContext": self.context, "provider": self.provider,
                "model": PROVIDERS[self.provider], "ttsModel": self.tts_model, "voiceId": self.voice_id,
                "reasoningEffort": self.reasoning_effort if self.provider in OPENAI_PROVIDERS else None,
                "transcriptionModel": self.transcription_model if self.provider in OPENAI_PROVIDERS else None,
                "trimIdleAudio": self.trim_idle_audio if self.provider in OPENAI_PROVIDERS else None,
                "pipecatCommit": "7cf75afc37f321ecce1822901351bc5fdc372e0b", "inputSampleRate": 16000,
                "outputSampleRate": 16000, "vadStartMs": 100, "vadStopMs": 200, "smartTurnStopMs": 1500,
                "sustainedInterruptionMs": self.interruption_ms, "speechMode": self.speech_mode,
                "dialogueMode": self.dialogue_mode,"backchannel": self.backchannel,"breathExperiment":breath_enabled(),
                "promptRevision": "semantic-17" if self.dialogue_mode=="semantic" else "controller-13" if self.dialogue_mode=="controller" else self.prompt_mode, "nativeTts": False, "openaiServerVad": False},
            "diagnosticError": self.diagnostic_error,
            **({'productionSnapshot':__import__('production_calls').snapshot(self)} if self.production else {})})
        self._saved_status = self.status

    def public(self):
        self.persist()
        return {"id": self.id, "provider": self.provider, "model": PROVIDERS[self.provider],
                "diagnosticId": "pc-" + self.id, "schemaVersion": 2,
                "finalized": self.finalized,
                "ttsModel": self.tts_model, "voiceId": self.voice_id, "status": self.status,
                "createdAt": self.created, "events": self.evidence.events, "eventCount": self.evidence.sequence,
                "transcript": transcript(self.evidence.events), "diagnosticError": self.diagnostic_error}


@app.get("/health", dependencies=[Depends(auth)])
async def health():
    return {"ok": True, "isolated": True, "providers": PROVIDERS, "ttsModels": TTS_MODELS,
            "dialogueModes": ["legacy","controller","semantic"],
            "runtimeRevision": "pipecat-conversation-4", "realtimeTranscriptionModel": REALTIME_TRANSCRIPTION_MODEL,
            "conversationProfile": {"interruptionMs": interruption_default(), "speechMode": speech_default(),
                "promptMode": "legacy", "maxToolFailuresPerTurn": 2, "maxToolAttemptsPerTurn": 6},
            "configured": {key: bool(os.environ.get(key)) for key in
                ("OPENAI_API_KEY", "GEMINI_API_KEY", "PROXYAPI_API_KEY", "ELEVENLABS_API_KEY", "PIPECAT_HYPOTHESIS_PUBLIC_URL", "VOX_ACCOUNT_ID", "VOX_API_KEY", "VOX_APP_ID")}}


@app.post("/preflight", dependencies=[Depends(auth)])
async def preflight(options: Options):
    identifier = "pf-" + str(uuid.uuid4())
    started = time.monotonic()
    record = {"id": identifier, "at": utc_now(), "provider": options.provider, "ttsModel": options.ttsModel}
    try:
        async with asyncio.timeout(75):
            result = await check_compatibility(options, synthesize=True)
            record["status"] = "passed"
            return {**result, "preflightId": identifier}
    except httpx.HTTPStatusError as exc:
        provider = "ElevenLabs" if exc.request.url.host == "api.elevenlabs.io" else options.provider
        record.update(status="failed", errorType=type(exc).__name__, httpStatus=exc.response.status_code,
            reason=f"{provider}: HTTP {exc.response.status_code}")
        raise HTTPException(503, f"{record['reason']}. Проверка {identifier}.") from None
    except httpx.RequestError as exc:
        provider = "ElevenLabs" if exc.request.url.host == "api.elevenlabs.io" else options.provider
        route = " через настроенный прокси" if provider == "ElevenLabs" and elevenlabs_proxy() else ""
        record.update(status="failed", errorType=type(exc).__name__,
            reason=f"{provider}: сетевая ошибка {type(exc).__name__}{route}")
        raise HTTPException(503, f"{record['reason']}. Проверка {identifier}.") from None
    except HTTPException as exc:
        record.update(status="failed", errorType=type(exc).__name__, reason=str(exc.detail))
        raise HTTPException(exc.status_code, f"{exc.detail} Проверка {identifier}.") from None
    except Exception as exc:
        record.update(status="failed", errorType=type(exc).__name__)
        raise HTTPException(503, f"Проверка не завершена ({type(exc).__name__}). ID {identifier}.") from None
    finally:
        record["elapsedMs"] = round((time.monotonic() - started) * 1000, 2)
        try:
            root = Path(os.environ.get("PIPECAT_LOG_DIR", "../../storage/pipecat-hypothesis"))
            root.mkdir(parents=True, exist_ok=True)
            with os.fdopen(os.open(root / (identifier + ".json"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
                json.dump(record, output, ensure_ascii=False)
        except OSError as exc:
            record["logError"] = type(exc).__name__
        print(json.dumps({"event": "preflight_result", **record}, ensure_ascii=False), flush=True)


async def prepare_call_audio(session):
    from pipeline import prepare_tts
    if session.dialogue_mode in ("controller","semantic"):
        from dialogue_controller import DialogueController
        from semantic_controller import SemanticController
        cls=SemanticController if session.dialogue_mode=="semantic" else DialogueController
        session.controller=cls(session,None,None)
        async with asyncio.timeout(65):await session.controller.prepare()
    await prepare_tts(session)


async def release_call_audio(session):
    from pipeline import release_tts
    await release_tts(session)
    if getattr(session,"controller",None):await session.controller.close()


@app.post("/transport-probes", dependencies=[Depends(auth)])
async def create_transport_probe():
    """Single-use 30-second WSS check. Never dials or contacts AI providers."""
    for key, value in list(transport_probes.items()):
        if value[1] < time.time():
            del transport_probes[key]
    if len(transport_probes) >= 4:
        raise HTTPException(429, "Transport probe limit")
    key, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
    transport_probes[key] = (token, time.time() + 30)
    return {"id": key, "token": token}


def production_public_url():
    public=os.environ.get("PIPECAT_HYPOTHESIS_PUBLIC_URL", "").rstrip("/")
    if urlparse(public).scheme!="https" or not urlparse(public).hostname:
        raise HTTPException(503,"Pipecat public HTTPS URL is required")
    if any(not os.environ.get(k) for k in ("VOX_ACCOUNT_ID","VOX_API_KEY","VOX_APP_ID")):
        raise HTTPException(503,"Missing Voximplant configuration")
    return public


async def dial_pipecat(s,public):
    background=await select_background(s,public)
    breath=await select_breath(s,public)
    custom = {"call_id": s.id, "to": s.to, "caller_id": os.environ.get("VOX_CALLER_ID", ""),
              "stream_url": public.replace("https:", "wss:", 1) + f"/media/{s.id}?token={s.token}",
              "event_url": public + f"/events/{s.id}?token={s.token}","max_call_seconds":s.max_call_seconds,
              "line_gate":s.dialogue_mode=='semantic'}
    if s.production:custom["record_call"]=True
    if background:custom['background_audio']=background
    if breath:custom['breath_audio']=breath
    async with httpx.AsyncClient(timeout=25, **voximplant_http_options()) as client:
        response = await client.post("https://api.voximplant.com/platform_api/StartScenarios", data={
            "account_id": os.environ["VOX_ACCOUNT_ID"], "api_key": os.environ["VOX_API_KEY"],
            "application_id": os.environ["VOX_APP_ID"],
            "rule_name": os.environ.get("PIPECAT_PRODUCTION_VOX_RULE", "voice_pipecat_rule") if s.production else os.environ.get("PIPECAT_VOX_RULE", "voice_pipecat_hypothesis_rule"),
            "script_name": "voice_pipecat" if s.production else "voice_pipecat_hypothesis", "output": "json", "phone": s.to,
            "script_custom_data": json.dumps(custom),
        })
        response.raise_for_status()
        payload = response.json()
        s.evidence.event("vox_start_result", result={k: v for k, v in payload.items() if k != "script_custom_data"})
        if payload.get("error") or not payload.get("result"):
            raise HTTPException(502, "Voximplant rejected prototype scenario")
    if s.production:
        result=payload.get("result")
        row=result[0] if isinstance(result,list) and result else result if isinstance(result,dict) else {}
        identifier=payload.get("call_session_history_id") or row.get("call_session_history_id")
        if identifier is not None:s.production_vox_id=identifier
        s.persist()


@app.post("/sessions", dependencies=[Depends(auth)])
async def start_call(options: Call):
    public = os.environ.get("PIPECAT_HYPOTHESIS_PUBLIC_URL", "").rstrip("/")
    if urlparse(public).scheme != "https" or not urlparse(public).hostname:
        raise HTTPException(503, "Для звонка нужен публичный HTTPS/WSS адрес Pipecat. Укажите PUBLIC_BASE_URL backend и запустите npm run pipecat:up.")
    required = ("VOX_ACCOUNT_ID", "VOX_API_KEY", "VOX_APP_ID")
    if any(not os.environ.get(key) for key in required):
        raise HTTPException(503, "Missing Voximplant configuration")
    # Bounded in-memory history, raw evidence remains in the separate log directory.
    for key, old in list(sessions.items()):
        if time.time() - old.created > 3600:
            await release_call_audio(old)
            del sessions[key]
    if sum(s.status in {"prepared", "dialing", "connected", "ending"} for s in sessions.values()) >= 4:
        raise HTTPException(429, "Prototype concurrency limit reached")
    evidence = await preflight(options)
    s = Session(str(uuid.uuid4()), options.provider, options.ttsModel, options.voiceId, options.prompt, options.context, options.to,
                reasoning_effort=options.reasoningEffort, trim_idle_audio=options.trimIdleAudio,
                dialogue_mode=options.dialogueMode,backchannel=options.backchannel)
    sessions[s.id] = s
    s.evidence.event("preflight", result=evidence)
    try:
        await prepare_call_audio(s)
        await dial_pipecat(s,public)
        if s.status == "prepared":
            s.status = "dialing"
        return s.public()
    except Exception as exc:
        await release_call_audio(s)
        s.status = "failed"
        s.finalized = True
        s.evidence.event("dial_failed", error_type=type(exc).__name__, message=str(exc))
        raise HTTPException(502, f"Prototype call could not be started; diagnostic pc-{s.id}") from None


def load_diagnostic(session_id):
    try:
        identifier = trace_id(session_id)
        current = sessions.get(identifier)
        if current:
            current.persist()
        record = TraceArchive().read(identifier)
        if record.get('kind')=='production_call':raise HTTPException(404,'Use call-plan diagnostics')
        if not current and record.get("instanceId") != INSTANCE_ID and record.get("status") in ACTIVE:
            record["originalStatus"] = record["status"]
            record["status"] = "interrupted"
            record["finalized"] = True
            record.setdefault("limitations", []).append("Сессия прервалась при перезапуске сервиса. Архив сохранён; соединение не восстановлено.")
        return record
    except ValueError:
        raise HTTPException(400, "Invalid diagnostic ID") from None
    except FileNotFoundError:
        raise HTTPException(404, "Diagnostic not found") from None


@app.get("/sessions", dependencies=[Depends(auth)])
async def history(include_probes: bool = False):
    records = TraceArchive().history(limit=200)
    records = [record for record in records if record.get('kind')!='production_call' and (include_probes or record.get("kind") != "probe")][:30]
    for record in records:
        if record.get("id") not in sessions and record.get("instanceId") != INSTANCE_ID and record.get("status") in ACTIVE:
            record["status"] = "interrupted"
    return {"runs": records}


@app.get("/sessions/{session_id}", dependencies=[Depends(auth)])
async def get_session(session_id: str):
    return load_diagnostic(session_id)


@app.get("/sessions/{session_id}/diagnostics", dependencies=[Depends(auth)])
async def diagnostic_events(session_id: str, after: int = 0, limit: int = 500):
    if after < 0 or not 1 <= limit <= 1000:
        raise HTTPException(400, "Invalid diagnostic cursor")
    record = load_diagnostic(session_id)
    rows = [event for event in record["events"] if event["seq"] > after]
    page = rows[:limit]
    return {"run": {k: v for k, v in record.items() if k not in {"events", "configuration"}}, "events": page,
            "nextCursor": page[-1]["seq"] if page else after, "hasMore": len(rows) > limit, "totalEvents": record["eventCount"]}


@app.get("/sessions/{session_id}/summary", dependencies=[Depends(auth)])
async def diagnostic_summary(session_id: str):
    try:
        current = sessions.get(trace_id(session_id))
    except ValueError:
        raise HTTPException(400, "Invalid diagnostic ID") from None
    if current:
        return {"id": current.id, "status": current.status, "finalized": current.finalized}
    record = load_diagnostic(session_id)
    return {key: record.get(key) for key in ("id", "status", "finalized")}


@app.get("/sessions/{session_id}/export", dependencies=[Depends(auth)])
async def diagnostic_export(session_id: str):
    return {"exportedAt": utc_now(), "format": "salesboost-pipecat-diagnostics-v2", **load_diagnostic(session_id)}


def media_session(session_id, token, lifecycle=False):
    s = sessions.get(session_id)
    if not s or not hmac.compare_digest(token, s.token) or time.time() - s.created > (s.max_call_seconds+600 if lifecycle else 360):
        return None
    return s


@app.post("/events/{session_id}")
async def lifecycle(session_id: str, token: str, event: dict):
    s = media_session(session_id, token, lifecycle=True)
    if not s:
        raise HTTPException(403, "Invalid call credentials")
    name = event.get("event")
    line=getattr(getattr(s,'controller',None),'line',None)
    if event.get('ivr') is True:s.ivr_detected=True
    if line and isinstance(event.get('ivr_path'),list):line.note_path(event['ivr_path'])
    if s.production:
        if event.get('vox_session_id'):s.production_vox_id=event['vox_session_id']
        if event.get('recording_started') is True:s.production_recording=True
        if name=='connected' and not getattr(s,'production_connected_at',None):s.production_connected_at=utc_now()
        if name in {'disconnected','failed','busy','no_answer','cancelled'}:s.production_ended_at=utc_now()
        s.persist()
    if name in {'background_started','background_failed','background_restarted','background_stopped'}:
        s.evidence.event('background_playback',state=name,reason=str(event.get('reason') or '')[:160])
        return {'ok':True}
    if name in {'recording_started','recording_failed'}:
        s.evidence.event('vox_recording',state=name,reason=str(event.get('reason') or '')[:160])
        return {'ok':True}
    if name in {"connected", "disconnected", "failed", "busy", "no_answer", "cancelled"}:
        s.status = getattr(s,'line_outcome',None) or name
        reason=event.get('reason')
        if reason in {'max_call_duration','websocket_closed','websocket_error'}:
            s.failure_reason='voximplant_'+reason
        if name in {'disconnected','failed','busy','no_answer','cancelled'}:
            s.media_disconnected=True
            if getattr(s,'controller',None):s.controller.abort()
        if name in {"disconnected", "failed", "busy", "no_answer", "cancelled"} and not s.connected:
            s.finalized = True
            await release_call_audio(s)
        s.evidence.event("vox_lifecycle", state=name,reason=reason if reason in {"max_call_duration","websocket_closed","websocket_error"} else None)
    return {"ok": True}


@app.api_route('/background/{asset}',methods=['GET','HEAD'])
async def background_asset(asset:str,token:str=''):
    return FileResponse(asset_file(asset,token),media_type='audio/wav',headers={'Cache-Control':'private, max-age=1209600'})


@app.websocket("/media/{session_id}")
async def media(websocket: WebSocket, session_id: str, token: str = ""):
    probe = transport_probes.get(session_id)
    if probe and probe[1] >= time.time() and hmac.compare_digest(token, probe[0]):
        del transport_probes[session_id]
        await websocket.accept()
        await websocket.send_json({"event": "transport_ready"})
        message = await asyncio.wait_for(websocket.receive_json(), timeout=5)
        await websocket.send_json({"event": "transport_echo", "payload": message.get("payload")})
        await websocket.close()
        return
    s = media_session(session_id, token)
    if not s or s.connected or s.status not in {"prepared", "dialing", "connected"}:
        await websocket.close(code=1008)
        return
    s.connected = True
    await websocket.accept()
    try:
        from pipeline import run_pipeline
        await run_pipeline(s, websocket)
    except Exception as exc:
        s.status = "failed"
        s.evidence.event("pipeline_failed", error_type=type(exc).__name__)
    finally:
        await release_call_audio(s)
        if getattr(s,'line_outcome',None):s.status=s.line_outcome
        if s.status not in {"failed", "busy", "no_answer", "cancelled"}:
            s.status = "disconnected"
        s.finalized = True
        if s.production and not getattr(s,'production_ended_at',None):s.production_ended_at=utc_now()
        s.evidence.event("session_ended", status=s.status)
        s.persist()
        try:
            await websocket.close()
        except RuntimeError:
            pass


import sys
from production_calls import register as register_production_calls
register_production_calls(sys.modules[__name__])
