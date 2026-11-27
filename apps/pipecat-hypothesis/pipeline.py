"""Isolated Pipecat pipeline. Imports target the exact SHA in pyproject.toml."""
import asyncio
import base64
from collections import deque
from dataclasses import dataclass
import json
import inspect
from functools import wraps
import os
import re
import time
import uuid
import copy
from typing import Literal, get_args, get_origin, get_type_hints

from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame, Frame, FunctionCallResultProperties, InputAudioRawFrame, InterruptionFrame,
    LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMRunFrame,
    LLMTextFrame, MetricsFrame, OutputAudioRawFrame, TTSStartedFrame, TTSStoppedFrame, TTSSpeakFrame, EndFrame,
    UserStartedSpeakingFrame, UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame, TTSTextFrame,
    FunctionCallsStartedFrame, AggregatedTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.services.elevenlabs.dialogue.tts import ElevenLabsDialogueTTSService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.realtime import events
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from policy import OPENAI_PROVIDERS, PROVIDERS, SUSTAINED_MS, is_backchannel, is_overlap_fragment, REALTIME_TRANSCRIPTION_MODEL, realtime_transcription_config, unsupported_transcript_script
from input_quality import TurnAudio,InputQuality,suspicion
from network import elevenlabs_proxy
from gemini_provider import GEMINI_PROVIDERS, STT_INSTRUCTION, create_gemini_service
from conversation import adapt_prompt, continuation_prefix
from speech_filter import SpeechFilter
from realtime_failure import RealtimeFailureNotice
from conversation_tuning import ToolTurnBudget


class DialogueTTS(ElevenLabsDialogueTTSService):
    """Preserve the project's ElevenLabs-specific proxy for the TTD socket."""
    async def _websocket_connect(self, uri, **kwargs):
        reservation = getattr(self, "reservation", None)
        if reservation:
            self.reservation = None
            return await reservation.claim()
        for attempt in (1, 2):
            try:
                return await self.open_socket(uri, **{**kwargs, "open_timeout": 4, "close_timeout": 1})
            except Exception as exc:
                if getattr(self, "evidence", None):
                    self.evidence.event("tts_reconnect_failed", attempt=attempt, error_type=type(exc).__name__)
                if attempt == 2:
                    raise

    async def open_socket(self, uri, **kwargs):
        if elevenlabs_proxy():
            kwargs["proxy"] = elevenlabs_proxy()
        return await super()._websocket_connect(uri, **kwargs)

    async def process_frame(self, frame, direction):
        response_id = frame.metadata.get("diagnostic_response_id")
        if response_id:
            self.incoming_response_id = response_id
        if isinstance(frame, LLMTextFrame) and frame.metadata.get("tts_presegmented"):
            converted = AggregatedTextFrame(frame.text, "sentence", raw_text=frame.text)
            converted.metadata.update(frame.metadata)
            frame = converted
        await super().process_frame(frame, direction)

    async def run_tts(self, text, context_id):
        evidence = getattr(self, "evidence", None)
        if evidence:
            incoming=getattr(self,'incoming_response_id',None)
            original=evidence.delivery.contexts.get(context_id)
            # A cached backchannel never owns a provider TTS context. Repair
            # that initial mislabel only; delayed text from older native turns
            # must retain its original owner even if a newer turn has started.
            if incoming and evidence.delivery.responses.get(original,{}).get('kind')=='backchannel':
                evidence.delivery.contexts[context_id]=incoming
            else:evidence.delivery.contexts.setdefault(context_id,incoming)
        async for frame in super().run_tts(text, context_id):
            yield frame

    async def _send_text(self, text, context_id):
        evidence = getattr(self, "evidence", None)
        context = self._contexts.get(context_id)
        if not self._websocket or not context or not context.registered:
            if evidence:
                evidence.event("tts_text_send_skipped", context_id=context_id, reason="context_not_registered")
            return await super()._send_text(text, context_id)
        if evidence:
            evidence.event("tts_text_send_started", context_id=context_id,
                response_id=evidence.delivery.contexts.get(context_id), characters=len(text))
        await super()._send_text(text, context_id)
        if evidence:
            evidence.event("tts_text_sent", context_id=context_id,
                response_id=evidence.delivery.contexts.get(context_id), characters=len(text))
        if getattr(self, "speech_mode", "sentence") == "fast_sentence" and context_id not in getattr(self, "first_flushes", set()):
            self.first_flushes = getattr(self, "first_flushes", set())
            self.first_flushes.add(context_id)
            await self.flush_audio(context_id)
            if evidence:
                evidence.event("tts_first_sentence_flushed", context_id=context_id,
                    response_id=evidence.delivery.contexts.get(context_id))

    async def on_turn_context_created(self, context_id):
        if getattr(self, "evidence", None):
            self.evidence.delivery.contexts[context_id] = getattr(self, "incoming_response_id", None)
        await super().on_turn_context_created(context_id)


def create_tts(session):
    tts = DialogueTTS(api_key=os.environ["ELEVENLABS_API_KEY"], sample_rate=16000,
        settings=ElevenLabsDialogueTTSService.Settings(model=session.tts_model, voice=session.voice_id, language="ru", stability=0.5))
    tts.evidence = session.evidence
    tts.speech_mode = getattr(session, "speech_mode", "sentence")
    return tts


async def prepare_tts(session):
    from readiness import WarmSocket
    tts = create_tts(session)
    # The base initializes this only during worker setup. The reserved socket
    # must negotiate the exact same PCM format before setup exists.
    tts._output_format = "pcm_16000"
    tts.reservation = await WarmSocket.prepare(tts.open_socket, tts._build_websocket_url(),
        {"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}, session.voice_id, session.evidence)
    session.prepared_tts = tts


async def release_tts(session):
    tts = getattr(session, "prepared_tts", None)
    if tts and getattr(tts, "reservation", None):
        await tts.reservation.close()
        tts.reservation = None


class DiagnosticSmartTurn(LocalSmartTurnAnalyzerV3):
    def __init__(self, evidence, **kwargs):
        self.evidence = evidence
        super().__init__(**kwargs)

    async def analyze_end_of_turn(self):
        start = time.monotonic()
        silence = getattr(self, "_silence_ms", None)
        state, prediction = await super().analyze_end_of_turn()
        self.evidence.event("smart_turn_decision", decision=state.name, prediction=prediction,
            inference_ms=round((time.monotonic() - start) * 1000, 2), silence_ms=silence,
            reason="silence_fallback" if silence is not None and silence >= 1500 else "model_prediction")
        if state.name=="INCOMPLETE" and getattr(self,"controller",None):self.controller.on_incomplete_pause()
        return state, prediction


class VoxSerializer(FrameSerializer):
    """Vox Media Streams PCM16/16k mono in both directions, no WAV headers."""
    def __init__(self, session, websocket):
        super().__init__(FrameSerializer.InputParams(audio_in_sample_rate=16000, audio_out_sample_rate=16000))
        self.session, self.websocket = session, websocket
        self.sequence = 0
        self.chunk = 0
        self.samples = 0
        self.lock = asyncio.Lock()
        self.tag_turns = {}
        self.tag_responses = {}
        self.queue_cleared_event = asyncio.Event()
        self.telemetry_ready = False
        self.pending_pings = {}
        self.last_rtt = None
        self.clock_offset_ms = None
        self.tag_sent_utc = {}
        self.early_ends = {}
        self.output_response_id = None

    async def measure_rtt(self):
        if not self.telemetry_ready:
            return
        nonce = uuid.uuid4().hex
        self.pending_pings[nonce] = (time.monotonic(), time.time() * 1000)
        self.pending_pings = dict(list(self.pending_pings.items())[-3:])
        await self.send({"customEvent": "control", "action": "diagnostic_ping", "nonce": nonce})

    def envelope(self, event, payload):
        result = {"event": event, "sequenceNumber": self.sequence, event: payload}
        self.sequence += 1
        return json.dumps(result)

    async def send(self, message):
        async with self.lock:
            await self.websocket.send_text(json.dumps(message))

    async def seal(self):
        replay=None
        async with self.lock:
            tag = self.session.playback.seal()
            if tag:
                await self.websocket.send_text(self.envelope("stop", {"tag": tag, "mediaInfo": {}}))
                self.session.evidence.event("playback_sent_end", tag=tag, response_id=self.tag_responses.get(tag), audio_ms=self.samples / 16,
                                            pending_tags=sorted(self.session.playback.pending))
                early=self.early_ends.pop(tag,None)
                if early and early[0]==self.samples:replay=early[1]
        if replay:await self.deserialize(replay)

    async def serialize(self, frame):
        if isinstance(frame, InterruptionFrame):
            self.early_ends.clear()
            self.output_response_id=None
            await self._reset_audio_out()
            e = self.session.evidence
            for response_id, note in e.delivery.interrupt(only=frame.metadata.get('backchannel_only')).items():
                e.memory.delivery_note = (e.memory.delivery_note + [{"response_id": response_id, **note}])[-8:]
            self.session.evidence.event("queue_clear_requested", pending_tags=sorted(self.session.playback.pending),
                                        active_tag=self.session.playback.active, response_id=self.session.evidence.current_response_id)
            self.session.playback.interrupt()
            self.session.evidence.event("queue_cleared")
            self.queue_cleared_event.set()
            return json.dumps({"customEvent": "control", "action": "clear_media"})
        if not isinstance(frame, OutputAudioRawFrame):
            return None
        line=getattr(getattr(self.session,'controller',None),'line',None)
        if line and not line.can_speak:
            self.session.evidence.event('line_audio_blocked',bytes=len(frame.audio),state=line.state)
            return None
        if frame.num_channels != 1:
            raise ValueError("Expected mono TTS")
        audio = await self._resample_audio_out(frame)
        if not audio:
            return None
        self.session.evidence.audio("output", audio, 16000)
        p = self.session.playback
        if p.active is None:
            tag = p.begin()
            self.tag_turns[tag] = self.session.evidence.output_turn
            self.tag_responses[tag] = self.output_response_id or self.session.evidence.current_response_id
            context_id = getattr(frame, "context_id", None)
            self.tag_responses[tag] = self.session.evidence.delivery.contexts.get(context_id, self.tag_responses[tag])
            self.tag_turns[tag] = self.session.evidence.messages.get(self.tag_responses[tag],{}).get("turn",self.tag_turns[tag])
            self.session.evidence.delivery.segment(tag, self.tag_responses[tag])
            self.chunk, self.samples = 0, 0
            # VoxEngine selects the new tag before receiving the start frame.
            await self.send({"customEvent": "control", "action": "begin_output", "tag": tag})
            await self.websocket.send_text(self.envelope("start", {
                "tag": tag, "mediaFormat": {"encoding": "PCM16", "sampleRate": 16000, "channels": 1},
            }))
            self.session.evidence.mark("audio_sent", turn=self.tag_turns[tag])
            self.tag_sent_utc[tag] = time.time() * 1000
            self.session.evidence.event("playback_segment_created", tag=tag, response_id=self.tag_responses[tag], turn=self.tag_turns[tag])
            if self.session.evidence.delivery.responses.get(self.tag_responses[tag],{}).get("kind")!="backchannel":
                self.session.evidence.latency("speech_to_audio_sent_ms", "speech_end", turn=self.tag_turns[tag])
        payload = {"tag": p.active, "chunk": self.chunk, "timestamp": self.samples * 1000 // 16000,
                   "payload": base64.b64encode(audio).decode()}
        self.chunk += 1
        self.samples += len(audio) // 2
        return self.envelope("media", payload)

    async def deserialize(self, data):
        if isinstance(data, bytes):
            raise ValueError("Vox Media Streams requires JSON, not unframed binary")
        message = json.loads(data)
        if message.get('customEvent')=='dtmf_result':
            line=getattr(getattr(self.session,'controller',None),'line',None)
            if line:line.delivered(str(message.get('commandId','')),str(message.get('digit','')),message.get('ok') is True,message.get('path'))
            return None
        if message.get("event") == "start":
            fmt = message.get("start", {}).get("mediaFormat", {})
            encoding = str(fmt.get("encoding", "")).upper()
            self.session.evidence.event("input_format", format=fmt)
            if encoding not in ("PCM16", "PCM16_16KHZ") or int(fmt.get("sampleRate", 16000)) != 16000 or int(fmt.get("channels", 1)) != 1:
                raise ValueError(f"Unsupported Vox input format: {fmt}")
        elif message.get("event") == "media":
            audio = base64.b64decode(message["media"]["payload"], validate=True)
            if len(audio) % 2 or len(audio) > 64000:
                raise ValueError("Invalid PCM16 packet")
            self.session.evidence.audio("input", audio, 16000)
            return InputAudioRawFrame(audio, 16000, 1)
        elif message.get('customEvent')=='breath':
            if message.get('action') in ('started','ended','stopped','failed'):
                self.session.evidence.event('breath_playback',action=message['action'],
                    command_id=str(message.get('commandId',''))[:32])
        elif message.get("customEvent") == "transport_ready":
            self.telemetry_ready = message.get("diagnosticsVersion") == 1
            self.session.evidence.event("transport_telemetry_ready", version=message.get("diagnosticsVersion"))
        elif message.get("customEvent") == "transport_pong":
            sent = self.pending_pings.pop(str(message.get("nonce", "")), None)
            if sent:
                now = time.time() * 1000
                rtt = (time.monotonic() - sent[0]) * 1000
                received, replied = message.get("remoteReceivedUtcMs"), message.get("remoteSentUtcMs")
                if isinstance(received, (int, float)) and isinstance(replied, (int, float)) and 0 <= replied - received <= rtt + 5:
                    self.last_rtt = max(0, rtt - (replied - received))
                    self.clock_offset_ms = ((received - sent[1]) + (replied - now)) / 2
                    self.session.evidence.event("transport_rtt_ms", latency_ms=round(self.last_rtt, 2),
                        remote_processing_ms=round(replied - received, 2), offset_estimate_ms=round(self.clock_offset_ms, 2),
                        uncertainty_ms=round(self.last_rtt / 2, 2))
        elif message.get("customEvent") == "playback":
            p, e = self.session.playback, self.session.evidence
            tag, action = str(message.get("tag", "")), message.get("action")
            turn = self.tag_turns.get(tag, e.output_turn)
            backchannel=e.delivery.responses.get(self.tag_responses.get(tag),{}).get("kind")=="backchannel"
            e.event("playback_callback", action=action, tag=tag, response_id=self.tag_responses.get(tag),
                    accepted=tag in p.pending and (action!="ended" or tag in p.sealed), sealed=tag in p.sealed, pending_tags=sorted(p.pending), simulation=bool(getattr(self.session, "is_simulation", False)))
            if action=="ended" and tag in p.pending and tag not in p.sealed and getattr(self.session,"controller",None):
                self.early_ends[tag]=(self.samples,data)
                e.event("playback_end_deferred_until_seal",tag=tag)
            if action == "started" and tag in p.pending:
                remote_ms = message.get("remoteUtcMs")
                if isinstance(remote_ms, (int, float)) and self.clock_offset_ms is not None and tag in self.tag_sent_utc:
                    e.event("playback_remote_timing", tag=tag, remote_utc_ms=remote_ms,
                        estimated_outbound_start_ms=round(remote_ms - self.clock_offset_ms - self.tag_sent_utc[tag], 2),
                        uncertainty_ms=round(self.last_rtt / 2, 2), scope="clock-offset estimate; not pure media buffering")
                e.event("backchannel_playback_started" if backchannel else "playback_started", tag=tag, turn=turn)
                if not backchannel:
                    e.latency("playback_start_ms", "audio_sent", turn=turn)
                    e.latency("speech_to_playback_ms", "speech_end", turn=turn)
            elif action == "ended" and p.acknowledge(tag):
                response_id = e.delivery.ack(tag)
                if response_id and not backchannel and e.delivery.complete(response_id):
                    message = e.messages.get(response_id, {})
                    spoken = message.get("spoken_text", message.get("text", ""))
                    e.memory.topics.heard(spoken, e.memory.name)
                    if "?" in spoken:
                        e.memory.open_question = {"response_id": response_id, "text": spoken, "scope": "last phone-confirmed question; may already have a reply"}
                    e.event("response_phone_confirmed", response_id=response_id, memory=e.memory.snapshot(), simulation=bool(getattr(self.session, "is_simulation", False)))
                e.event("playback_ended", tag=tag, turn=turn)
                if not backchannel:e.last_playback_end_ms = (e.clock() - e.started) * 1000
                if self.tag_responses.get(tag) and not backchannel:
                    e.last_played_id = self.tag_responses[tag]
                e.latency("playback_duration_ms", "audio_sent", turn=turn)
                await self.maybe_hangup()
        return None

    async def maybe_hangup(self):
        target = getattr(self.session, "finish_response_id", None)
        if self.session.playback.can_hangup and (not target or self.session.evidence.delivery.complete(target)):
            failed = bool(getattr(self.session, "failure_reason", None))
            self.session.status = "failed" if failed else "ending"
            self.session.evidence.memory.phase = "failed" if failed else "ended"
            self.session.evidence.event("hangup_after_playback")
            await self.send({"customEvent": "control", "action": "hangup"})


@dataclass
class Turn:
    overlap: bool
    duration_ms: float = 0
    interrupted: bool = False
    number: int = 0
    speech_end: float | None = None
    question: dict | None = None
    question_audio_sending: bool = False


class TurnMonitor(FrameProcessor):
    """Delay interruption until sustained speech or a meaningful short transcript."""
    def __init__(self, session):
        super().__init__()
        self.session = session
        self.turn = Turn(False)
        self.segment_start = None
        self.timer = None
        self.interrupt = None
        self.interruption_ms = getattr(session, "interruption_ms", SUSTAINED_MS)

    def cancel_timer(self):
        if self.timer:
            self.timer.cancel()
            self.timer = None

    async def confirm(self, turn=None):
        turn = turn or self.turn
        if not self.session.playback.busy:
            turn.overlap = False
            self.session.evidence.event("barge_in_resolved", reason="previous_audio_already_finished")
            return
        if turn.overlap and not turn.interrupted:
            turn.interrupted = True
            self.session.evidence.event("barge_in_confirmed")
            await self.interrupt()

    async def sustained(self):
        # Account for Silero's 200ms stop window so a short acknowledgement
        # followed by silence cannot trip the sustained-speech timer.
        await asyncio.sleep(self.interruption_ms / 1000 + 0.2)
        if self.segment_start is not None:
            await self.confirm()

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)
        e = self.session.evidence
        if (getattr(self.session, "failure_reason", None) and direction == FrameDirection.DOWNSTREAM
                and isinstance(frame, (InputAudioRawFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame,
                                       VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame))):
            return  # The backend failure notice owns the remaining playout.
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, UserStartedSpeakingFrame):
                if getattr(self.session,"controller",None):await self.session.controller.new_input()
                e.turn += 1
                self.turn = Turn(self.session.playback.busy, number=e.turn,
                    question=dict(self.session.controller.last_question) if getattr(self.session,"controller",None) and self.session.controller.last_question else None)
                identifier=(self.turn.question or {}).get('response_id')
                tags=e.delivery.responses.get(identifier,{}).get('tags',set())
                self.turn.question_audio_sending=any(tag in self.session.playback.pending and tag not in self.session.playback.sealed for tag in tags)
                e.mark("speech_start")
                e.reply_reference(e.turn)
                e.event("turn_started", overlap=self.turn.overlap, generated=self.session.playback.generated,
                        synthesizing=self.session.playback.synthesizing, pending_tags=sorted(self.session.playback.pending),
                        question_audio_sending=self.turn.question_audio_sending)
                # UserStarted may precede the originating VAD frame downstream.
                if self.turn.overlap:
                    e.event("barge_in_candidate")
                    if self.segment_start is not None:
                        self.cancel_timer()
                        self.timer = asyncio.create_task(self.sustained())
            elif isinstance(frame, VADUserStartedSpeakingFrame):
                if getattr(self.session,"controller",None):await self.session.controller.stop_backchannel()
                e.event("vad_speech_started", start_secs=frame.start_secs)
                self.segment_start = time.monotonic()
                self.cancel_timer()
                controller=getattr(self.session,'controller',None)
                if getattr(controller,'line',None) and not self.turn.overlap:
                    controller.schedule_backchannel('listen_active',3)
                if self.turn.overlap:
                    self.timer = asyncio.create_task(self.sustained())
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                self.cancel_timer()
                if self.segment_start is not None:
                    self.turn.duration_ms += max(0, (time.monotonic() - self.segment_start - frame.stop_secs) * 1000)
                self.segment_start = None
                # Exclude the VAD silence window from the latency reference.
                e.marks["speech_end"] = time.monotonic() - frame.stop_secs
                e.turn_marks[(e.turn, "speech_end")] = e.marks["speech_end"]
                self.turn.speech_end = e.marks["speech_end"]
                e.event("speech_end", vad_silence_ms=frame.stop_secs * 1000, speech_duration_ms=round(self.turn.duration_ms, 2))
            elif isinstance(frame, UserStoppedSpeakingFrame):
                self.cancel_timer()
                e.latency("turn_detection_ms", "speech_end")
                e.event("turn_committed", detector="Silero + SmartTurnV3", speech_duration_ms=round(self.turn.duration_ms, 2),
                        overlap=self.turn.overlap, interrupted=self.turn.interrupted)
        await self.push_frame(frame, direction)

    async def cleanup(self):
        self.cancel_timer()
        await super().cleanup()


class GatedRealtime(OpenAIRealtimeLLMService):
    """Native audio Realtime; short overlap is transcribed before response.create."""
    def __init__(self, session, monitor, wait_for_user=False, trim_idle_audio=False, **kwargs):
        super().__init__(**kwargs)
        self.session, self.monitor = session, monitor
        self.pending = deque()
        self.items = {}
        self.response_id = None
        self.cancelled_responses = set()
        self.request_turns = deque()
        self.audit_pending = deque()
        self.audit_responses = {}
        self.audit_counter = 0
        self.provider_items = {}
        self.response_text = {}
        self.partial_at = {}
        self.audio_buffer_bytes = 0
        self.request_reason = None
        self.last_audio_commit = None
        self.response_items = {}
        self.pending_repairs = {}
        self.repaired_items = set()
        self.memory_item_id = None
        self.last_interrupted_id = None
        self.wait_for_user = wait_for_user
        self.has_user_commit = False
        self.context_ready = asyncio.Event()
        self.held_responses = set()
        self.responses_with_tools = set()
        self.trim_idle_audio = trim_idle_audio
        self.last_trimmed_turn = None
        self.response_lock = asyncio.Lock()
        self.wire_pending = None
        self.wire_active = None
        self.cancel_on_created = False
        self.cancel_sent = set()
        self.deferred_response = None
        self.user_speaking = False
        self.continuation_task = None
        self.speech_filters = {}
        self.spoken_text = {}
        self.finalized_responses = set()
        self.greeting_recovered = False
        self.clarification_task = None
        self.partial_transcripts = {}
        self.last_user_request_turn = None
        self.tool_call_turns = {}
        self.connection_failed = False
        self.failure_task = None
        self.response_start_task = None
        self.response_start_timeout = 6
        self.stt_tasks = {}
        self.stt_timeout = 6
        self.stt_recovering=False
        self.stt_recovery_task=None
        self.stt_recoveries=0
        self.stt_recovery_limit=2
        self.stt_discard_until_stop=None
        self.context_timeout = 8
        self.context_watch = None
        self.startup_audio = deque()
        self.startup_audio_ms = 0
        self.turn_audio=TurnAudio();self.input_quality=InputQuality(require_audio=bool(getattr(session,'production',False)))
        self.quality_tasks={};self.reviewed_items=set()
        self.pending_quality_result=None;self.latest_accepted_turn=-1
        self.input_quality_closing=False

    def cancel_stt_watch(self,turn=None):
        keys=list(self.stt_tasks) if turn is None else [turn]
        for key in keys:
            task=self.stt_tasks.pop(key,None)
            if task and task is not asyncio.current_task():task.cancel()

    def watch_stt(self,turn):
        if not getattr(self.session,"controller",None):return
        self.cancel_stt_watch(turn.number)
        async def deadline():
            await asyncio.sleep(self.stt_timeout)
            if not self.connection_failed and not self.session.finalized and self.session.status not in {'disconnected','ending'}:
                self.session.evidence.event('stt_deadline_exceeded',turn=turn.number,timeout_seconds=self.stt_timeout,
                    session_ready=self._api_session_ready,pending_commits=len(self.pending),pending_items=len(self.items))
                await self.recover_transcription(turn)
        self.stt_tasks[turn.number]=asyncio.create_task(deadline())

    async def recover_transcription(self,turn):
        controller=getattr(self.session,'controller',None)
        if self.stt_recovering or self.connection_failed:return
        if not controller or not hasattr(controller,'on_stt_recovery') or self.stt_recoveries>=self.stt_recovery_limit:
            await self.fail_connection('transcription_timeout');return
        self.stt_recovering=True;self.stt_recoveries+=1
        self.stt_recovery_task=asyncio.current_task()
        if self.user_speaking or getattr(self.monitor,'segment_start',None) is not None:
            self.stt_discard_until_stop=self.monitor.turn.number
        self.context_ready.clear();self.cancel_stt_watch()
        self.session.evidence.event('stt_recovery_started',source_turn=turn.number,attempt=self.stt_recoveries,
            pending_turns=[t.number for t,_ in self.pending],retained_turns=[r['turn'] for r in controller.inputs.snapshot()])
        try:
            await controller.on_stt_recovery(turn)
            if self.connection_failed or getattr(self.session,'media_disconnected',False):return
            # Rebuild only the provider connection. Local dialogue, question
            # ledger, verified fragments, facts, and the phone stay alive.
            await self._disconnect()
            quality=list(self.quality_tasks.values())
            for task in quality:task.cancel()
            if quality:await asyncio.gather(*quality,return_exceptions=True)
            self.quality_tasks.clear();self.turn_audio.clear();self.reviewed_items.clear();self.pending_quality_result=None
            self.pending.clear();self.items.clear();self.partial_transcripts.clear()
            self.provider_items.clear();self.pending_repairs.clear();self.repaired_items.clear()
            self.wire_active=self.wire_pending=self.deferred_response=None
            self.audit_pending.clear();self.memory_item_id=None;self.response_id=None
            self._messages_added_manually.clear();self._user_audio_preroll_buffer=bytearray()
            self.audio_buffer_bytes=0
            self.has_user_commit=False;self.request_reason=None;self.request_turns.clear()
            self._results_awaiting_response=False
            self._llm_needs_conversation_setup=True
            self._run_llm_when_api_session_ready=True
            await self._connect()
            await asyncio.wait_for(self.context_ready.wait(),self.context_timeout)
            if not self.connection_failed:
                self.session.evidence.event('stt_recovery_succeeded',attempt=self.stt_recoveries,
                    retained_turns=[r['turn'] for r in controller.inputs.snapshot()])
        except asyncio.CancelledError:raise
        except Exception as exc:await self.fail_connection('transcription_recovery_failed',exc)
        finally:
            self.stt_recovering=False
            if self.stt_recovery_task is asyncio.current_task():self.stt_recovery_task=None

    async def _send_user_audio(self,frame):
        if self.connection_failed:return
        self.turn_audio.append(frame.audio,frame.sample_rate,frame.num_channels)
        if self.stt_recovering or self.wait_for_user and not self.context_ready.is_set():
            duration=len(frame.audio)*1000/(frame.sample_rate*frame.num_channels*2)
            self.startup_audio.append(frame)
            self.startup_audio_ms+=duration
            if self.startup_audio_ms>max(10,self.context_timeout+2)*1000:
                await self.fail_connection('context_setup_timeout')
            return
        await super()._send_user_audio(frame)

    async def flush_startup_audio(self):
        buffered=self.startup_audio_ms
        while self.startup_audio and not self.connection_failed:
            frame=self.startup_audio.popleft()
            await super()._send_user_audio(frame)
        self.startup_audio_ms=0
        if buffered:self.session.evidence.event('realtime_startup_audio_flushed',audio_ms=round(buffered,2))

    async def prime_context(self,context):
        # Install the actual context before live audio can enter this processor.
        # Waiting for an aggregator's first context frame deadlocks if that frame
        # is queued behind UserStoppedSpeakingFrame waiting for context_ready.
        if self._context is None:
            await self._handle_context(context,FrameDirection.DOWNSTREAM)
            self.session.evidence.event('realtime_context_primed')

    def watch_context(self):
        if self.context_watch:self.context_watch.cancel()
        async def ready_or_fail():
            try:
                await asyncio.wait_for(self.context_ready.wait(),self.context_timeout)
            except asyncio.TimeoutError as exc:
                self.session.evidence.event('realtime_context_deadline_exceeded',
                    api_session_ready=self._api_session_ready,context_installed=self._context is not None,
                    timeout_seconds=self.context_timeout)
                await self.fail_connection('context_setup_timeout',exc)
        self.context_watch=asyncio.create_task(ready_or_fail())

    async def _connect(self):
        await super()._connect()
        if not self._websocket:
            await self.fail_connection("connect_failed")
        elif self.wait_for_user and not self.context_ready.is_set():self.watch_context()

    def cancel_response_start_timer(self):
        if self.response_start_task and self.response_start_task is not asyncio.current_task():
            self.response_start_task.cancel()
        self.response_start_task = None

    def watch_response_start(self, request):
        self.cancel_response_start_timer()
        async def wait_for_created():
            await asyncio.sleep(self.response_start_timeout)
            if not self.connection_failed and self.wire_pending is request:
                await self.fail_connection("response_start_timeout")
        self.response_start_task = asyncio.create_task(wait_for_created())

    async def fail_connection(self, reason, exc=None):
        if (self.connection_failed or self._disconnecting
                or getattr(self.session, "finalized", False)
                or self.session.status in {"disconnected", "ending"}):
            return
        self.connection_failed = True
        self.startup_audio.clear();self.startup_audio_ms=0
        self.session.failure_reason = ("realtime_stt_timeout" if reason in ("transcription_timeout","transcription_recovery_failed") else
            "realtime_initialization_timeout" if reason=='context_setup_timeout' else "realtime_connection_lost")
        self.cancel_stt_watch()
        if getattr(self.session,"controller",None):self.session.controller.abort()
        self.session.status = "failed"
        self.session.evidence.memory.phase = "failed"
        self.wire_pending = self.wire_active = self.deferred_response = None
        self._response_active = False
        self.cancel_response_start_timer()
        self.audit_pending.clear()
        if self.continuation_task:
            self.continuation_task.cancel()
            self.continuation_task = None
        self.session.evidence.event("realtime_transport_failed", reason=reason,
            error_type=type(exc).__name__ if exc else None,
            close_code=getattr(getattr(exc, "rcvd", None), "code", None) or getattr(self._websocket, "close_code", None))
        handler = getattr(self.session, "realtime_failure_handler", None)
        await self.push_error(error_msg="OpenAI Realtime transport unavailable", exception=exc,
                              force_treat_as_permanent=not bool(handler))
        if handler:
            self.failure_task = asyncio.create_task(handler())

    async def _ws_send(self, message):
        if self.connection_failed or self._disconnecting:
            return
        if not self._websocket:
            if self.context_ready.is_set():
                await self.fail_connection("socket_missing")
            return
        try:
            await self._websocket.send(json.dumps(message))
        except Exception as exc:
            await self.fail_connection("send_failed", exc)

    async def _receive_task_handler(self):
        try:
            await super()._receive_task_handler()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.fail_connection("receive_failed", exc)
        else:
            if not self._disconnecting:
                await self.fail_connection("receive_loop_ended")

    async def _handle_user_started_speaking(self, frame):
        self.user_speaking = True
        self.turn_audio.begin(self.monitor.turn.number)
        if self.stt_discard_until_stop is not None:self.stt_discard_until_stop=self.monitor.turn.number
        if self.continuation_task:
            self.continuation_task.cancel()
            self.continuation_task = None
        if not self.trim_idle_audio or not self._api_session_ready or self.last_trimmed_turn == self.monitor.turn.number:
            return
        self.last_trimmed_turn = self.monitor.turn.number
        # Clear only the uncommitted idle buffer. Server conversation items,
        # local VAD and Smart Turn state are untouched. Keep the full native
        # 1.5s pre-roll, capped at bytes received since the previous commit.
        before = self.audio_buffer_bytes
        size = min(before, len(self._user_audio_preroll_buffer))
        preroll = bytes(self._user_audio_preroll_buffer[-size:]) if size else b""
        await self.send_client_event(events.InputAudioBufferClearEvent())
        if preroll:
            await self.send_client_event(events.InputAudioBufferAppendEvent(audio=base64.b64encode(preroll).decode()))
        self.session.evidence.event("idle_audio_trimmed", discarded_ms=round(max(0, before - len(preroll)) / 48, 2),
            kept_preroll_ms=round(len(preroll) / 48, 2), reason="local_user_turn_started")

    async def _connect(self):
        for attempt in (1, 2):
            try:
                async with asyncio.timeout(6):
                    await super()._connect()
                if self._websocket:
                    self.session.evidence.event("llm_socket_connected", attempt=attempt)
                    return
            except Exception as exc:
                self.session.evidence.event("llm_connect_failed", attempt=attempt, error_type=type(exc).__name__)
            else:
                self.session.evidence.event("llm_connect_failed", attempt=attempt, error_type="ConnectionUnavailable")
        await self.push_error(error_msg="Realtime connection unavailable after bounded attempts", force_treat_as_permanent=True)

    async def _create_response(self):
        if getattr(self.session,"controller",None) and self.has_user_commit and self.request_reason!="controller_fallback":
            self._results_awaiting_response=False;self._response_create_owed=False
            self.session.evidence.event("controller_auto_response_suppressed")
            return
        budget = getattr(self.session, "tool_budget", None)
        if budget and budget.blocked and self.request_reason not in {"text_regression_input", "smart_turn_committed", "meaningful_short_interruption_after_stt", "unfinished_fragment_clarification"}:
            self._results_awaiting_response = False
            self._response_create_owed = False
            return
        if self.wait_for_user and not self.has_user_commit:
            if not self._api_session_ready:
                self._run_llm_when_api_session_ready = True
                return
            # Configure the real session without generating an unsolicited
            # greeting or opening a phantom TTS turn before the first speaker.
            if self._llm_needs_conversation_setup:
                params = await self.get_llm_adapter().get_llm_invocation_params(self._context)
                for item in params["messages"]:
                    event = events.ConversationItemCreateEvent(item=item)
                    self._messages_added_manually[item.id] = True
                    await self.send_client_event(event)
                await self._send_session_update()
                self._llm_needs_conversation_setup = False
            await self.flush_startup_audio()
            if self.connection_failed:return
            self.context_ready.set()
            self.session.evidence.event("initial_response_suppressed", reason="wait_for_first_user_turn")
            return
        if self.session.playback.finish_requested:
            self._response_create_owed = False
            return
        if self.wire_pending or self.wire_active or self.user_speaking or self.continuation_task:
            await self.send_client_event(events.ResponseCreateEvent())
        else:
            await super()._create_response()

    async def flush_response(self):
        deferred = self.deferred_response
        if not deferred or self.wire_pending or self.wire_active or self.user_speaking or self.continuation_task:
            return
        self.deferred_response = None
        event, reason, turn = deferred
        if turn < self.monitor.turn.number:
            self.session.evidence.event("stale_response_discarded", turn=turn, latest_turn=self.monitor.turn.number)
            return
        self.request_reason = reason
        self.request_turns.append(turn)
        await self.send_client_event(event)

    async def recover_first_greeting(self):
        e = self.session.evidence
        if (self.greeting_recovered or e.memory.phase == "closing" or self.session.playback.finish_requested
                or self.monitor.turn.number != 1 or self.user_speaking
                or self.wire_pending or self.wire_active or self.deferred_response
                or self.response_id not in self.finalized_responses
                or self.spoken_text.get(self.response_id, "").strip()):
            return
        text = next((u["text"] for u in e.memory.users if u["turn"] == 1), "")
        if not re.fullmatch(r"\s*(?:алло|здравствуйте|добрый день|hello|hi)[\s,.!?]*", text, re.I):
            return
        self.greeting_recovered = True
        await self.send_client_event(events.ConversationItemCreateEvent(item=events.ConversationItem(
            type="message", role="system", content=[events.ItemContent(type="input_text",
                text="Собеседник поздоровался и ждёт ответа. Ответь коротким приветствием и начни разговор по выбранному предложению. Не произноси маркеры молчания.")])))
        self.request_reason = "first_greeting_recovery"
        self.request_turns.append(1)
        e.event("empty_first_response_recovery", previous_response_id=self.response_id)
        await self.send_client_event(events.ResponseCreateEvent())

    async def reject_response(self, evt):
        event_id = getattr(evt.error, "event_id", None)
        rejected = next((r for r in self.audit_pending if r.get("client_event_id") == event_id), None)
        if rejected:
            self.audit_pending.remove(rejected)
            if self.wire_pending is rejected:
                self.wire_pending = None
            self.session.evidence.event("response_request_rejected", **rejected, code=evt.error.code)
            # Do not retry a failed create blindly or associate its slot with
            # the next response. A later committed utterance can make a new one.
            if not self.wire_active:
                self._response_active = False

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        if isinstance(frame, (LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame)):
            frame.metadata["diagnostic_response_id"] = self.response_id
            if isinstance(frame, LLMTextFrame) and getattr(self.session, "speech_mode", "sentence") == "fast_sentence":
                frame.metadata["tts_presegmented"] = True
        await super().push_frame(frame, direction)

    async def repair_context(self):
        for response_id, note in list(self.pending_repairs.items()):
            item_ids = self.response_items.get(response_id, set())
            for item_id in item_ids - self.repaired_items:
                await self.send_client_event(events.ConversationItemDeleteEvent(item_id=item_id))
                self.repaired_items.add(item_id)
            if item_ids or response_id.startswith("farewell-"):
                memory = self.session.evidence.memory
                memory.delivery_note = (memory.delivery_note + [{"response_id": response_id, **note}])[-8:]
                self.session.evidence.event("interrupted_context_repaired", response_id=response_id, removed_items=sorted(item_ids), **note)
                del self.pending_repairs[response_id]

    async def sync_memory(self):
        if self.memory_item_id:
            await self.send_client_event(events.ConversationItemDeleteEvent(item_id=self.memory_item_id))
        item = events.ConversationItem(type="message", role="system", content=[events.ItemContent(
            type="input_text", text=self.session.controller.context_text() if getattr(self.session,"controller",None) else self.session.evidence.memory.context_text())])
        self.memory_item_id = item.id
        await self.send_client_event(events.ConversationItemCreateEvent(item=item))

    async def send_client_event(self, event):
        if self.connection_failed:
            return
        if event.type == "response.create":
            if getattr(self.session,"controller",None) and self.request_reason!="controller_fallback":
                self.session.evidence.event("controller_auto_response_suppressed")
                self._results_awaiting_response=False;self._response_create_owed=False
                if not self.wire_active and not self.wire_pending:self._response_active=False
                return
            if self.wait_for_user and not self.has_user_commit:
                self.session.evidence.event("initial_response_suppressed", reason="wait_for_first_user_turn")
                return
            reason = self.request_reason or ("function_result" if self._results_awaiting_response else "initial_or_service_request")
            self.request_reason = None
            turn = self.request_turns.pop() if self.request_turns else self.monitor.turn.number
            self.request_turns.clear()
            user_reasons = {"smart_turn_committed", "meaningful_short_interruption_after_stt", "interrupted_audio_without_transcript", "text_regression_input", "unfinished_fragment_clarification", "controller_fallback"}
            budget = getattr(self.session, "tool_budget", None)
            if budget and reason in user_reasons:
                budget.on_user_turn(turn)
                self.last_user_request_turn = turn
            if budget and budget.blocked and reason not in user_reasons:
                self._results_awaiting_response = False
                self._response_create_owed = False
                self.session.evidence.event("response_suppressed_tool_budget", reason=reason, turn=turn)
                return
            if self.session.playback.finish_requested and reason not in user_reasons:
                self.deferred_response = None
                self.session.evidence.event("response_discarded_after_closing", reason=reason)
                return
            async with self.response_lock:
                if turn < self.monitor.turn.number:
                    self.session.evidence.event("stale_response_discarded", turn=turn, latest_turn=self.monitor.turn.number)
                    return
                if self.wire_pending or self.wire_active or self.user_speaking or self.continuation_task:
                    self.deferred_response = (event, reason, turn)
                    self.session.evidence.event("response_deferred", turn=turn, reason=reason,
                        active_response=self.wire_active, waiting_for_create=bool(self.wire_pending), user_speaking=self.user_speaking)
                    return
                # Only actual sends enter audit_pending. Reserve the wire slot
                # before sync_memory yields, so parallel callbacks cannot race.
                self.wire_pending = {"client_event_id": event.event_id}
                try:
                    await self._send_audited_event(event, turn, reason)
                except Exception:
                    self.audit_pending = deque(r for r in self.audit_pending if r.get("client_event_id") != event.event_id)
                    self.wire_pending = None
                    self._response_active = False
                    raise
            return
        await self._send_audited_event(event)

    async def _send_audited_event(self, event, request_turn=None, request_reason=None):
        e = self.session.evidence
        kind = event.type
        if kind == "input_audio_buffer.append":
            self.audio_buffer_bytes += len(event.audio) * 3 // 4 - event.audio.count("=")
        else:
            payload = event.model_dump(exclude_none=True)
            if kind == "response.create":
                if self.wait_for_user and not self.has_user_commit:
                    e.event("initial_response_suppressed", reason="wait_for_first_user_turn")
                    return
                if request_reason in {"smart_turn_committed", "meaningful_short_interruption_after_stt", "text_regression_input", "unfinished_fragment_clarification"} and e.memory.phase == "closing":
                    self.session.playback.finish_requested = False
                    self.session.finish_response_id = None
                    refresh = getattr(self.session, "refresh_call_tools", None)
                    if refresh:
                        await refresh(self, resume=True)
                await self.repair_context()
                await self.sync_memory()
                self.audit_counter += 1
                request = {"request_id": f"req-{self.audit_counter}", "turn": self.monitor.turn.number if request_turn is None else request_turn,
                           "client_event_id": event.event_id,
                           "reason": request_reason or ("function_result" if self._results_awaiting_response else "initial_or_service_request"),
                           "requested_ms": round((e.clock() - e.started) * 1000, 2)}
                self.audit_pending.append(request)
                self.wire_pending = request
                self.watch_response_start(request)
                self._response_active = True
                e.event("response_requested", **request, provider_event=payload,
                        input_audio_ms=round(self.audio_buffer_bytes / 48, 2),
                        last_audio_commit=self.last_audio_commit,
                        pending_user_commits=[{"turn": turn.number, "waiting": waiting} for turn, waiting in self.pending],
                        reply_reference=e.reply_references.get(request["turn"]),
                        provider_conversation=list(self.provider_items.values()),
                        local_context=self._context.get_messages() if self._context else [],
                        context_source="provider event mirror + local Pipecat context; audio may precede final transcription")
            elif kind == "conversation.item.delete":
                removed = self.provider_items.pop(event.item_id, None)
                e.event("provider_item_deleted", item_id=event.item_id, removed_item=removed, reason="client_delete")
            elif kind in {"input_audio_buffer.commit", "input_audio_buffer.clear"}:
                if kind.endswith("commit"):
                    self.last_audio_commit = {"turn": self.monitor.turn.number, "audio_ms": round(self.audio_buffer_bytes / 48, 2), "seq": e.sequence + 1}
                    # A later interruption may replay only uncommitted audio.
                    self._user_audio_preroll_buffer.clear()
                e.event("provider_audio_commit" if kind.endswith("commit") else "provider_audio_clear",
                        input_audio_ms=round(self.audio_buffer_bytes / 48, 2), buffered_bytes=self.audio_buffer_bytes,
                        overlap=self.monitor.turn.overlap, interrupted=self.monitor.turn.interrupted)
                self.audio_buffer_bytes = 0
            elif kind == "conversation.item.create":
                item = payload.get("item", {})
                if item.get("id"):
                    self.provider_items[item["id"]] = item
                e.event("provider_item_sent", item=item)
            elif kind == "session.update":
                e.event("provider_session_update_sent", session=payload.get("session"))
            elif kind == "response.cancel":
                if self.wire_pending and not self.wire_active:
                    self.cancel_on_created = True
                    e.event("provider_cancel_deferred", reason="waiting_for_response_created")
                    return
                identifier = self.wire_active or self.response_id
                if not self.wire_active or not self._response_active or identifier in self.cancel_sent:
                    e.event("provider_cancel_skipped", response_id=self.response_id, reason="generation_already_finished_audio_only_interruption")
                    return
                self.cancel_sent.add(identifier)
                e.event("provider_response_cancel", response_id=self.response_id)
            else:
                e.event("provider_client_event", type=kind, payload=payload)
        await super().send_client_event(event)

    async def _handle_evt_session_updated(self, evt):
        self.session.evidence.event("provider_session_confirmed", session=evt.session.model_dump(exclude_none=True))
        await super()._handle_evt_session_updated(evt)
        if self.wait_for_user and self._context is not None and not self.context_ready.is_set() and not self.connection_failed:
            await self._create_response()

    async def _handle_evt_error(self, evt):
        self.session.evidence.event("provider_error", error=evt.error.model_dump(exclude_none=True), response_id=self.response_id)
        await super()._handle_evt_error(evt)

    async def _maybe_handle_evt_retrieve_conversation_item_error(self, evt):
        # The upstream loop suppresses some concurrency/cancellation errors
        # before _handle_evt_error. Keep those visible for race diagnosis too.
        self.session.evidence.event("provider_error_received", error=evt.error.model_dump(exclude_none=True),
                                    response_id=self.response_id)
        await self.reject_response(evt)
        return await super()._maybe_handle_evt_retrieve_conversation_item_error(evt)

    async def _handle_evt_conversation_item_done(self, evt):
        item = evt.item.model_dump(exclude_none=True)
        if evt.item.id not in self.repaired_items:
            self.provider_items[evt.item.id] = item
        self.session.evidence.event("provider_item_completed", item=item, response_id=self.response_id)
        await super()._handle_evt_conversation_item_done(evt)

    async def _handle_evt_response_created(self, evt):
        if self.connection_failed:
            return
        self.cancel_response_start_timer()
        self.response_id = evt.response.id
        self.wire_active = evt.response.id
        self.wire_pending = None
        request = self.audit_pending.popleft() if self.audit_pending else {"turn": self.session.evidence.output_turn, "request_id": None}
        self.audit_responses[self.response_id] = request
        self.session.evidence.current_response_id = self.response_id
        self.session.evidence.event("provider_response_created", response_id=self.response_id, **request)
        self.session.evidence.output_turn = request.get("turn", self.monitor.turn.number)
        await super()._handle_evt_response_created(evt)
        if self.cancel_on_created:
            self.cancel_on_created = False
            self.cancelled_responses.add(evt.response.id)
            await self.send_client_event(events.ResponseCancelEvent())

    async def _handle_interruption(self):
        if self.wire_pending:
            self.cancel_on_created = True
        if self.response_id and self.last_interrupted_id == self.response_id:
            return
        self.last_interrupted_id = self.response_id
        self.session.evidence.event("interruption_applied", response_id=self.response_id,
                                    provider_item_id=getattr(self._current_assistant_response, "id", None),
                                    text=self.response_text.get(self.response_id, ""))
        affected = self.session.evidence.delivery.interrupt()
        if self.response_id and not self.session.evidence.delivery.complete(self.response_id):
            affected.setdefault(self.response_id, {"local_text_estimate": "", "phone_confirmed_segments": [], "scope": "no confirmed full response; generated tail was interrupted"})
        self.pending_repairs.update(affected)
        if self.response_id in affected and self.response_text.get(self.response_id):
            self.session.evidence.assistant(self.response_id, self.response_text[self.response_id], status="cancelled",
                                            **self.audit_responses.get(self.response_id, {}))
        if affected:
            self.cancelled_responses.update(affected)
            if len(self.cancelled_responses) > 64:
                self.cancelled_responses = {self.response_id}
        await super()._handle_interruption()
        self._response_active = False
        self._current_assistant_response = None
        await self.repair_context()

    async def _handle_evt_text_delta(self, evt):
        if self.connection_failed:
            return
        controller=getattr(self.session,"controller",None)
        if controller and evt.response_id not in self.response_text:
            # Text is not audible yet: retain the waiting clip until real TTS
            # PCM arrives. Its output-only stop must not cancel native synthesis.
            if not controller.thinking.current:
                await controller.stop_backchannel()
                controller.playing_id=None;controller.playing_kind="llm"
            self.session.evidence.current_response_id=evt.response_id
        if evt.response_id not in self.cancelled_responses:
            request = self.audit_responses.get(evt.response_id, {})
            budget = getattr(self.session, "tool_budget", None)
            tool_repair = request.get("reason") == "function_result" and (
                self.session.evidence.memory.visit_pending or bool(budget and budget.failures))
            if evt.response_id not in self.response_text and (self.session.evidence.memory.closing_candidate or tool_repair):
                self.held_responses.add(evt.response_id)
                self.session.evidence.event("closing_text_held", response_id=evt.response_id,
                    reason="tool_repair" if tool_repair else "possible_closing_from_latest_transcript")
            if getattr(evt, "item_id", None):
                self.response_items.setdefault(evt.response_id, set()).add(evt.item_id)
            self.session.evidence.delivery.response(evt.response_id)
            text = self.response_text.get(evt.response_id, "") + evt.delta
            self.response_text[evt.response_id] = text
            self.session.evidence.response_text_at.setdefault(evt.response_id, self.session.evidence.clock())
            request = self.audit_responses.get(evt.response_id, {})
            if evt.response_id not in self.partial_at:
                start = request.get("requested_ms")
                self.session.evidence.event("response_first_text_ms", response_id=evt.response_id,
                    request_id=request.get("request_id"), turn=request.get("turn", self.session.evidence.output_turn),
                    latency_ms=None if start is None else round((self.session.evidence.clock() - self.session.evidence.started) * 1000 - start, 2))
            now = time.monotonic()
            if now - self.partial_at.get(evt.response_id, 0) >= 0.35:
                self.partial_at[evt.response_id] = now
                self.session.evidence.assistant(evt.response_id, text, status="partial", item_id=getattr(evt, "item_id", None),
                                                **self.audit_responses.get(evt.response_id, {}))
            if evt.response_id not in self.held_responses:
                await self.release_speech(evt.response_id, evt.delta)
        else:
            self.session.evidence.event("stale_provider_text_discarded", response_id=evt.response_id, characters=len(evt.delta))

    async def release_speech(self, response_id, text="", final=False):
        controller=getattr(self.session,"controller",None)
        guard = self.speech_filters.setdefault(response_id, SpeechFilter(memory=None if controller else self.session.evidence.memory,controller=controller))
        epoch=controller.epoch if controller else None
        previous=guard.spoken
        removed=len(guard.removed)
        released=guard.feed(text,final=final,collect_questions=bool(controller))
        pieces=guard.pieces if controller else [('text',released)]
        # Streaming answers retain their order. Only complete proposed questions
        # wait for semantic approval; no question bytes reach TTS beforehand.
        guard.spoken=previous
        for kind,sentence in pieces:
            if controller and (epoch!=controller.epoch or controller.unavailable() or response_id in self.cancelled_responses):return
            identity=None
            if kind=='question':
                if guard.question_emitted:
                    guard.removed.append(sentence)
                    self.session.evidence.event('native_question_rejected',response_id=response_id,text=sentence,reason='one_question_per_response')
                    continue
                identity=await controller.native_questions.authorize(sentence,response_id,epoch)
                if not identity:
                    guard.removed.append(sentence)
                    continue
                guard.question_emitted=True
            if controller and (epoch!=controller.epoch or controller.unavailable() or response_id in self.cancelled_responses):return
            if controller and hasattr(controller,'approve_speech_sentence'):
                approved=controller.approve_speech_sentence(sentence,response_id)
                if not approved:
                    guard.removed.append(sentence)
                    continue
                sentence=approved
            previously_spoken=bool(guard.spoken.strip())
            guard.spoken+=sentence
            self.spoken_text[response_id]=guard.spoken
            if response_id in self.session.evidence.messages:
                self.session.evidence.messages[response_id]['spoken_text']=guard.spoken
            if sentence.strip():
                if not previously_spoken:self.session.evidence.event('response_speech_released',response_id=response_id,
                    characters=len(sentence),**self.audit_responses.get(response_id,{}))
                await super()._handle_evt_text_delta(type('Delta',(),{'delta':sentence})())
                if identity:
                    controller.question_ledger[identity]['state']='tts_released'
                    self.session.evidence.event('native_question_released',response_id=response_id,question_id=identity,text=sentence)
        self.spoken_text[response_id]=guard.spoken
        if response_id in self.session.evidence.messages:self.session.evidence.messages[response_id]['spoken_text']=guard.spoken
        for sentence in guard.removed[removed:]:
            self.session.evidence.event('speech_text_filtered',response_id=response_id,text=sentence,
                reason='controller_question_or_speech_policy')

    async def _handle_evt_function_call_arguments_done(self, evt):
        if self.connection_failed:
            return
        if evt.response_id not in self.cancelled_responses:
            self.tool_call_turns[evt.call_id] = self.audit_responses.get(evt.response_id, {}).get("turn", self.session.evidence.output_turn)
            self.responses_with_tools.add(evt.response_id)
            self.session.evidence.event("provider_function_call", response_id=evt.response_id,
                call_id=evt.call_id, arguments=evt.arguments, item_id=evt.item_id)
            await super()._handle_evt_function_call_arguments_done(evt)

    async def _handle_evt_response_done(self, evt):
        if self.connection_failed:
            return
        response_id = evt.response.id
        for item in evt.response.output or []:
            if item.type == "message" and item.role == "assistant":
                self.response_items.setdefault(response_id, set()).add(item.id)
        self.session.evidence.delivery.response(response_id)["generated_done"] = True
        request = self.audit_responses.get(response_id, {})
        start = request.get("requested_ms")
        self.session.evidence.event("response_total_ms", response_id=response_id, request_id=request.get("request_id"),
            turn=request.get("turn", self.session.evidence.output_turn),
            latency_ms=None if start is None else round((self.session.evidence.clock() - self.session.evidence.started) * 1000 - start, 2))
        self.session.evidence.event("provider_response_done", response_id=response_id,
            response=evt.response.model_dump(exclude_none=True), **self.audit_responses.get(response_id, {}))
        text = self.response_text.get(response_id, "")
        if not text:
            text = "".join(content.text or "" for item in evt.response.output or [] for content in item.content or [] if getattr(content, "text", None))
        if text:
            withheld = response_id in self.held_responses and (response_id in self.responses_with_tools or self.session.evidence.memory.phase == "closing")
            self.session.evidence.assistant(response_id, text,
                status="cancelled" if response_id in self.cancelled_responses else "suppressed_closing_narration" if withheld else evt.response.status,
                **self.audit_responses.get(response_id, {}))
            if response_id in self.held_responses and not withheld and response_id not in self.cancelled_responses:
                await self.release_speech(response_id, text, final=True)
        if response_id not in self.held_responses and response_id not in self.cancelled_responses:
            await self.release_speech(response_id, final=True)
        if text and self.spoken_text.get(response_id, "").strip() != text.strip() and response_id not in self.cancelled_responses:
            self.session.evidence.event("response_speech_text", response_id=response_id,
                generated_text=text, spoken_text=self.spoken_text.get(response_id, ""))
        if evt.response.id not in self.cancelled_responses:
            await super()._handle_evt_response_done(evt)
        await self.repair_context()
        if self.wire_active == response_id:
            self.wire_active = None
            self._response_active = False
        self.cancel_sent.discard(response_id)
        self.finalized_responses.add(response_id)
        await self.flush_response()
        await self.recover_first_greeting()
        controller=getattr(self.session,"controller",None)
        if (controller and request.get("reason")=="controller_fallback"
                and (request.get("turn")==self.monitor.turn.number
                    or hasattr(controller,'accepts_native_completion') and controller.accepts_native_completion(response_id,request))):
            await controller.fallback_done(response_id)

    async def _handle_user_stopped_speaking(self, frame):
        self.user_speaking = False
        turn = self.monitor.turn
        self.turn_audio.commit(turn.number)
        if self.connection_failed or getattr(self.session,'media_disconnected',False):return
        if self.wait_for_user:
            try:await asyncio.wait_for(self.context_ready.wait(),timeout=self.context_timeout)
            except asyncio.TimeoutError as exc:
                await self.fail_connection('context_setup_timeout',exc)
                return
        if self.connection_failed or getattr(self.session,'media_disconnected',False):return
        if self.stt_discard_until_stop==turn.number:
            if self.user_speaking or self.monitor.turn.number!=turn.number:
                self.stt_discard_until_stop=self.monitor.turn.number
                return
            # This utterance started on the old connection. Its tail on the
            # new socket is not a complete utterance and cannot approve facts.
            self.stt_discard_until_stop=None
            await self.send_client_event(events.InputAudioBufferClearEvent())
            self._user_audio_preroll_buffer=bytearray()
            self.session.evidence.event('stt_recovery_cut_turn_discarded',source_turn=turn.number)
            await self.session.controller.on_stt_recovery(turn)
            return
        self.has_user_commit = True
        waiting = bool(getattr(self.session,"controller",None)) or (turn.overlap and not turn.interrupted) or (turn.duration_ms < SUSTAINED_MS and self.session.evidence.memory.expecting_visit_details())
        self.pending.append((turn, waiting))
        self.watch_stt(turn)
        self.session.evidence.event("response_gate_decision", turn=turn.number, waiting_for_transcript=waiting,
            overlap=turn.overlap, interrupted=turn.interrupted, speech_duration_ms=round(turn.duration_ms, 2))
        controller=getattr(self.session,'controller',None)
        if controller and hasattr(controller,'on_turn_committed'):controller.on_turn_committed(turn)
        await self.send_client_event(events.InputAudioBufferCommitEvent())
        if not waiting:
            self.request_reason = "smart_turn_committed"
            self.request_turns.append(turn.number)
            self.session.evidence.mark("llm_requested", turn=turn.number)
            self.session.playback.generated = True
            await self.send_client_event(events.ResponseCreateEvent())

    async def _handle_evt_conversation_item_added(self, evt):
        if evt.item.role == "assistant" and evt.item.type == "message" and self.response_id:
            self.response_items.setdefault(self.response_id, set()).add(evt.item.id)
        if evt.item.type == "message" and evt.item.role == "user" and self.pending and evt.item.id not in self.reviewed_items:
            self.items[evt.item.id] = self.pending.popleft()
        self.provider_items[evt.item.id] = evt.item.model_dump(exclude_none=True)
        self.session.evidence.event("provider_item_created", item=self.provider_items[evt.item.id], response_id=self.response_id)
        await super()._handle_evt_conversation_item_added(evt)

    async def _handle_evt_input_audio_transcription_delta(self, evt):
        fragment = (self.partial_transcripts.get(evt.item_id, "") + evt.delta)[-1000:]
        self.partial_transcripts[evt.item_id] = fragment
        saved = self.items.get(evt.item_id)
        if (saved and saved[0].number == self.monitor.turn.number and saved[0].overlap
                and not saved[0].interrupted and not self.connection_failed
                and re.match(r"^\s*(?:стоп|подождите|постойте)(?:\W|$)", fragment, re.I)):
            saved[0].interrupted = True
            self.session.evidence.event("barge_in_urgent_partial", turn=saved[0].number, text=fragment)
            await self._handle_interruption()
            await self.broadcast_frame(InterruptionFrame)
        # Only final transcripts enter the context; partial "ага" can become
        # "ага, но ...". The sustained-speech path remains independent of STT.
        self.session.evidence.event("stt_partial", item_id=evt.item_id, text=evt.delta,
                                    turn=self.items.get(evt.item_id, (self.monitor.turn, False))[0].number)

    async def dispatch_controller_input(self):
        if (self.quality_tasks or self.stt_recovering or self.connection_failed or self.input_quality_closing
                or getattr(self.session,'media_disconnected',False)):return
        await self.resolve_quality_result()
        controller=getattr(self.session,"controller",None)
        # No extra silence window: SmartTurn has already committed the audio.
        # Wait only for real outstanding audio/transcription work.
        if (not controller or self.stt_recovering or self.user_speaking
                or getattr(self.monitor,'segment_start',None) is not None
                or self.stt_tasks or self.pending or self.items):return
        batch=controller.inputs.snapshot()
        if not batch:return
        if hasattr(controller,'awaiting_answer_for') and controller.awaiting_answer_for(batch):return
        turn=self.monitor.turn
        if turn.overlap and not turn.interrupted and self.session.playback.busy:
            turn.interrupted=True
            controller.serializer.queue_cleared_event.clear()
            await self._handle_interruption()
            await self.broadcast_frame(InterruptionFrame)
            await asyncio.wait_for(controller.serializer.queue_cleared_event.wait(),2)
        # Queue clearing awaits the transport. Another speech segment or turn
        # can begin during that await; retain the fragments for its final STT.
        if (self.user_speaking or getattr(self.monitor,'segment_start',None) is not None
                or self.monitor.turn.number!=turn.number or self.stt_tasks or self.pending or self.items):return
        controller.receive_batch(batch)

    async def resolve_quality_result(self):
        pending=self.pending_quality_result
        if not pending or self.quality_tasks:return
        if (self.user_speaking or getattr(self.monitor,'segment_start',None) is not None
                or self.stt_tasks or self.pending or self.items):return
        self.pending_quality_result=None
        turn,status,reason=pending
        if (turn.number!=self.monitor.turn.number or turn.number<=self.latest_accepted_turn
                or self.connection_failed or getattr(self.session,'media_disconnected',False)):return
        controller=getattr(self.session,'controller',None)
        if status=='noise' and not turn.interrupted and hasattr(controller,'on_ignored_input'):await controller.on_ignored_input(turn)
        elif hasattr(controller,'on_asr_unresolved'):await controller.on_asr_unresolved(turn,reason)
        elif hasattr(controller,'on_ignored_input'):await controller.on_ignored_input(turn)

    def retain_quality_result(self,turn,status,reason):
        old=self.pending_quality_result
        if turn.number>self.latest_accepted_turn and (not old or turn.number>=old[0].number):
            self.pending_quality_result=(turn,status,reason)

    async def handle_evt_input_audio_transcription_completed(self, evt):
        self.partial_transcripts.pop(evt.item_id, None)
        if self.connection_failed or getattr(self.session,'media_disconnected',False) or getattr(self.session,'failure_reason',None):
            return
        if getattr(self.session,'controller',None) and evt.item_id not in self.items:
            self.session.evidence.event('stt_unmatched_discarded',item_id=evt.item_id,reason='no_active_audio_item')
            return
        turn, waiting = self.items.pop(evt.item_id, (Turn(False), False))
        self.cancel_stt_watch(turn.number)
        if evt.item_id in self.provider_items:
            self.provider_items[evt.item_id]["final_transcript"] = evt.transcript
        self.session.evidence.event("stt_completed", item_id=evt.item_id, text=evt.transcript, turn=turn.number)
        self.session.evidence.latency("stt_ms", "speech_end", turn=turn.number)
        controller=getattr(self.session,'controller',None)
        window=self.turn_audio.pop(turn.number)
        if controller and evt.transcript.strip():
            known=json.dumps(getattr(self.session,'context',{}),ensure_ascii=False)
            reasons,features=suspicion(evt.transcript,window,turn.duration_ms,known)
            if self.input_quality.require_audio and not window:reasons.append('audio_unavailable')
            self.session.evidence.event('stt_quality',turn=turn.number,reasons=reasons,features=features)
            first_contact=getattr(controller,'first_contact',None)
            if first_contact:
                if reasons:first_contact.clear()
                else:first_contact.capture(evt.transcript,turn.number,window,evt.item_id)
            if reasons:
                task=asyncio.create_task(self.review_transcript(evt,turn,waiting,window,known))
                self.quality_tasks[turn.number]=task
                return
        await self.accept_transcript(evt,turn,waiting)

    async def review_transcript(self,evt,turn,waiting,window,known):
        controller=getattr(self.session,'controller',None)
        try:
            result=await self.input_quality.assess(evt.transcript,window,turn.duration_ms,known)
            if (self.connection_failed or getattr(self.session,'media_disconnected',False) or getattr(self.session,'failure_reason',None) or getattr(self.session,'finalized',False)
                    or getattr(self.session,'status','') in {'ending','disconnected','failed'}):return
            self.session.evidence.event('stt_quality_decision',turn=turn.number,status=result.status,
                reason=result.reason,features=result.features,reviewed_text=result.text)
            # Both accepted replacements and rejected audio are removed from
            # provider history. Only a validated text item may reach generation.
            await self.send_client_event(events.ConversationItemDeleteEvent(item_id=evt.item_id))
            if result.status=='accepted':
                item=events.ConversationItem(type='message',role='user',content=[events.ItemContent(type='input_text',text=result.text)])
                self.reviewed_items.add(item.id);self._messages_added_manually[item.id]=True
                await self.send_client_event(events.ConversationItemCreateEvent(item=item))
                evt.transcript=result.text
                await self.accept_transcript(evt,turn,waiting)
                self.quality_tasks.pop(turn.number,None)
            else:
                self.quality_tasks.pop(turn.number,None)
                self.session.evidence.event('stt_transcript_rejected',turn=turn.number,item_id=evt.item_id,
                    text=evt.transcript,reason=result.reason,speech_duration_ms=turn.duration_ms)
                self.retain_quality_result(turn,result.status,result.reason)
        except asyncio.CancelledError:raise
        except Exception as exc:
            self.session.evidence.event('stt_quality_failed',turn=turn.number,error_type=type(exc).__name__)
            self.quality_tasks.pop(turn.number,None)
            self.retain_quality_result(turn,'uncertain','verification_failed')
        finally:
            self.quality_tasks.pop(turn.number,None)
            await self.dispatch_controller_input()

    async def accept_transcript(self,evt,turn,waiting):
        if evt.transcript.strip():
            self.latest_accepted_turn=max(self.latest_accepted_turn,turn.number)
            if self.pending_quality_result and self.pending_quality_result[0].number<=turn.number:self.pending_quality_result=None
        if not evt.transcript.strip():
            self.session.evidence.event("user_transcript", text="", turn=turn.number, item_id=evt.item_id,
                status="ignored_empty", reply_reference=self.session.evidence.reply_references.get(turn.number))
            self.session.evidence.event("empty_transcript_no_semantic_interruption", turn=turn.number,
                waiting=waiting, already_interrupted=turn.interrupted)
            if getattr(self.session,"controller",None):
                if turn.interrupted:self.session.controller.inputs.add("",turn.number,turn.question)
                if hasattr(self.session.controller,'on_ignored_input'):await self.session.controller.on_ignored_input(turn)
                await self.dispatch_controller_input()
            elif waiting and turn.interrupted and turn.number == self.monitor.turn.number:
                # Real sustained speech already cancelled playback. Native audio
                # remains available even when the parallel STT returned nothing.
                self.request_reason = "interrupted_audio_without_transcript"
                self.request_turns.append(turn.number)
                self.session.playback.generated = True
                await self.send_client_event(events.ResponseCreateEvent())
            return
        controller=getattr(self.session,"controller",None)
        opening_ack=(controller and hasattr(controller,'ignores_opening_ack') and controller.ignores_opening_ack(evt.transcript,turn))
        opening_fragment=(controller and hasattr(controller,'ignores_opening_fragment') and controller.ignores_opening_fragment(evt.transcript,turn))
        if opening_ack or opening_fragment:
            self.session.evidence.event('user_transcript',text=evt.transcript,turn=turn.number,item_id=evt.item_id,
                status='non_interrupting_opening_ack' if opening_ack else 'non_interrupting_opening_fragment',
                reply_reference=self.session.evidence.reply_references.get(turn.number))
            await self.send_client_event(events.ConversationItemDeleteEvent(item_id=evt.item_id))
            self.session.evidence.event('opening_ack_overlap_ignored' if opening_ack else 'opening_fragment_overlap_ignored',
                text=evt.transcript,turn=turn.number,speech_duration_ms=turn.duration_ms,
                scope='short cue while opening audio is being sent; not answer coverage')
            if hasattr(controller,'on_ignored_input'):await controller.on_ignored_input(turn)
            await self.dispatch_controller_input()
            return
        if (controller and hasattr(controller,'ignores_opening_greeting')
                and controller.ignores_opening_greeting(evt.transcript,turn)):
            self.session.evidence.event('user_transcript',text=evt.transcript,turn=turn.number,item_id=evt.item_id,
                status='non_interrupting_opening_greeting',reply_reference=self.session.evidence.reply_references.get(turn.number))
            self.session.evidence.event('opening_greeting_overlap_ignored',text=evt.transcript,turn=turn.number,
                speech_duration_ms=turn.duration_ms)
            if hasattr(controller,'on_ignored_input'):await controller.on_ignored_input(turn)
            await self.dispatch_controller_input()
            return
        if (controller and turn.overlap and not turn.interrupted
                and is_overlap_fragment(evt.transcript,turn.duration_ms)):
            self.session.evidence.event('user_transcript',text=evt.transcript,turn=turn.number,item_id=evt.item_id,
                status='non_interrupting_fragment',reply_reference=self.session.evidence.reply_references.get(turn.number))
            self.session.evidence.event('barge_in_fragment_ignored',text=evt.transcript,turn=turn.number,
                speech_duration_ms=turn.duration_ms)
            if hasattr(controller,'on_ignored_input'):await controller.on_ignored_input(turn)
            await self.dispatch_controller_input()
            return
        short_answer=controller and controller.accepts_short_answer()
        if waiting and (turn.overlap or not controller) and not short_answer and is_backchannel(evt.transcript, turn.duration_ms):
            self.session.evidence.event("user_transcript", text=evt.transcript, turn=turn.number, item_id=evt.item_id,
                status="ignored_backchannel", reply_reference=self.session.evidence.reply_references.get(turn.number))
            await self.send_client_event(events.ConversationItemDeleteEvent(item_id=evt.item_id))
            self.session.evidence.event("barge_in_ignored", text=evt.transcript)
            if controller and hasattr(controller,'on_ignored_input'):await controller.on_ignored_input(turn)
            await self.dispatch_controller_input()
            return
        await super().handle_evt_input_audio_transcription_completed(evt)
        self.session.evidence.memory.user(evt.transcript, turn.number)
        self.session.evidence.event("user_transcript", text=evt.transcript, turn=turn.number, item_id=evt.item_id,
                                    reply_reference=self.session.evidence.reply_references.get(turn.number))
        if controller:
            controller.inputs.add(evt.transcript,turn.number,turn.question)
            self.session.evidence.event("controller_fragment_buffered",turn=turn.number,
                latest_turn=self.monitor.turn.number,question=turn.question,
                manager_speaking=self.user_speaking,pending_stt=sorted(self.stt_tasks))
            await self.dispatch_controller_input()
            return
        if turn.number < self.monitor.turn.number:
            self.session.evidence.event("late_transcript_no_response", turn=turn.number, latest_turn=self.monitor.turn.number)
            return
        await self.recover_first_greeting()
        if waiting:
            # Do not use the current monitor turn: a late transcript belongs to
            # the saved committed turn, even if the next user has begun speaking.
            if turn.overlap and not turn.interrupted:
                turn.interrupted = True
                self.session.evidence.event("barge_in_confirmed", turn=turn.number)
                await self._handle_interruption()
                await self.broadcast_frame(InterruptionFrame)
            if continuation_prefix(evt.transcript):
                self.session.evidence.event("continuation_wait", turn=turn.number, text=evt.transcript, grace_ms=700)
                async def clarify_if_still_quiet():
                    try:
                        await asyncio.sleep(0.7)
                        if self.monitor.turn.number == turn.number and not self.user_speaking:
                            self.continuation_task = None
                            self.request_reason = "unfinished_fragment_clarification"
                            self.request_turns.append(turn.number)
                            await self.send_client_event(events.ResponseCreateEvent())
                    finally:
                        if self.continuation_task is asyncio.current_task():
                            self.continuation_task = None
                self.continuation_task = asyncio.create_task(clarify_if_still_quiet())
                return
            self.session.evidence.mark("llm_requested", turn=turn.number)
            self.request_reason = "meaningful_short_interruption_after_stt"
            self.request_turns.append(turn.number)
            self.session.playback.generated = True
            await self.send_client_event(events.ResponseCreateEvent())

    async def cleanup(self):
        self.input_quality_closing=True
        tasks=list(self.quality_tasks.values())
        for task in tasks:task.cancel()
        if tasks:await asyncio.gather(*tasks,return_exceptions=True)
        self.quality_tasks.clear();self.turn_audio.clear();self.reviewed_items.clear()
        if self.context_watch:
            self.context_watch.cancel()
            await asyncio.gather(self.context_watch,return_exceptions=True)
        self.cancel_stt_watch()
        if self.stt_recovery_task and self.stt_recovery_task is not asyncio.current_task():
            self.stt_recovery_task.cancel()
            await asyncio.gather(self.stt_recovery_task,return_exceptions=True)
        self.cancel_response_start_timer()
        if getattr(self.session,"controller",None):await self.session.controller.close()
        if self.continuation_task:
            self.continuation_task.cancel()
            await asyncio.gather(self.continuation_task, return_exceptions=True)
        if self.failure_task and self.failure_task is not asyncio.current_task():
            self.failure_task.cancel()
            await asyncio.gather(self.failure_task, return_exceptions=True)
        if self.clarification_task:
            self.clarification_task.cancel()
            await asyncio.gather(self.clarification_task, return_exceptions=True)
        await super().cleanup()


class FlashTranscriber(FrameProcessor):
    """Gemini Flash has no Live API: a measured two-pass audio -> text -> LLM path."""
    def __init__(self, session, monitor, context):
        super().__init__()
        self.session, self.monitor, self.context = session, monitor, context
        self.frames = deque()
        self.audio_bytes = 0
        self.job = None
        self.in_turn = False
        self.stt = create_gemini_service(session.provider)

    async def transcribe(self, frames, turn):
        context = LLMContext([{"role": "system", "content": STT_INSTRUCTION}])
        await context.add_audio_frames_message(audio_frames=frames)
        start = time.monotonic()
        text = (await self.stt.run_inference(context) or "").strip()
        self.session.evidence.event("stt_request_ms", latency_ms=round((time.monotonic() - start) * 1000, 2))
        self.session.evidence.latency("stt_ms", "speech_end", turn=turn.number)
        if not text:
            return
        if turn.overlap and not turn.interrupted:
            if is_backchannel(text, turn.duration_ms):
                self.session.evidence.event("barge_in_ignored", text=text)
                return
            await self.monitor.confirm(turn)
        self.session.evidence.event("user_transcript", text=text, turn=turn.number,
                                    reply_reference=self.session.evidence.reply_references.get(turn.number))
        self.session.evidence.memory.user(text, turn.number)
        if self.session.evidence.memory.phase == "closing":
            refresh = getattr(self.session, "refresh_call_tools", None)
            if refresh:
                await refresh(None, resume=True)
        # A mutable state message is replaced, rather than accumulating every
        # snapshot in the local Gemini context.
        messages = self.context.get_messages()
        messages[:] = [message for message in messages if not (isinstance(message, dict) and message.get("role") == "system" and str(message.get("content", "")).startswith("CALL_STATE\n"))]
        self.context.add_message({"role": "system", "content": self.session.evidence.memory.context_text()})
        self.session.evidence.event("context_before_request", turn=turn.number,
            local_context=self.context.get_messages(), incoming_text=text,
            reply_reference=self.session.evidence.reply_references.get(turn.number), provider=self.session.provider)
        self.context.add_message({"role": "user", "content": text})
        self.session.evidence.output_turn = turn.number
        self.session.evidence.mark("llm_requested", turn=turn.number)
        self.session.playback.generated = True
        await self.push_frame(LLMContextFrame(self.context))

    async def safe_transcribe(self, frames, turn):
        try:
            await self.transcribe(frames, turn)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.session.status = "failed"
            self.session.evidence.event("stt_failed", error_type=type(exc).__name__, turn=turn.number)
            await self.push_error(error_msg=f"Gemini STT failed ({type(exc).__name__})", force_treat_as_permanent=True)

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, InputAudioRawFrame):
            self.frames.append(frame)
            self.audio_bytes += len(frame.audio)
            # Keep 300ms pre-roll while idle and at most 30s while speaking.
            limit = 16000 * 2 * (30 if self.in_turn else 0.3)
            while self.frames and self.audio_bytes > limit:
                self.audio_bytes -= len(self.frames.popleft().audio)
            return
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, UserStartedSpeakingFrame):
            self.in_turn = True
            if self.job and not self.job.done():
                self.job.cancel()
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, UserStoppedSpeakingFrame):
            if self.job and not self.job.done():
                self.job.cancel()
            frames = list(self.frames)
            self.frames.clear(); self.audio_bytes = 0
            self.in_turn = False
            if frames:
                self.job = asyncio.create_task(self.safe_transcribe(frames, self.monitor.turn))
            return
        await self.push_frame(frame, direction)

    async def cleanup(self):
        if self.job:
            self.job.cancel()
            await asyncio.gather(self.job, return_exceptions=True)
        await self.stt.cleanup()
        await super().cleanup()


class OutputEvidence(FrameProcessor):
    def __init__(self, session, serializer, stage):
        super().__init__()
        self.session, self.serializer, self.stage = session, serializer, stage
        self.first_text = False
        self.first_audio = False
        self.text = ""
        self.response_id = None
        self.partial_at = 0
        self.hold_closing = False
        self.has_tools = False
        if stage == "llm":
            session.llm_output_evidence = self

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        p, e = self.session.playback, self.session.evidence
        output_turn = e.output_turn
        if direction == FrameDirection.DOWNSTREAM:
            if self.stage == "llm":
                if isinstance(frame, InterruptionFrame) and self.session.provider not in OPENAI_PROVIDERS and self.text:
                    e.assistant(self.response_id, self.text, status="cancelled", turn=output_turn)
                if isinstance(frame, LLMFullResponseStartFrame):
                    p.generated = True
                    self.first_text = False
                    self.text = ""
                    self.has_tools = False
                    self.hold_closing = self.session.provider not in OPENAI_PROVIDERS and e.memory.closing_candidate
                    if self.session.provider not in OPENAI_PROVIDERS:
                        self.response_id = f"response-{e.sequence + 1}"
                        e.current_response_id = self.response_id
                        e.event("response_started", response_id=self.response_id, turn=output_turn)
                    frame.metadata["diagnostic_response_id"] = e.current_response_id
                elif isinstance(frame, LLMTextFrame):
                    frame.metadata.setdefault("diagnostic_response_id", e.current_response_id)
                    if not self.first_text:
                        self.first_text = True
                        if self.session.provider not in OPENAI_PROVIDERS:
                            e.response_text_at.setdefault(self.response_id, e.clock())
                        e.latency("llm_first_text_ms", "llm_requested", turn=output_turn)
                        e.mark("tts_requested", turn=output_turn)
                    self.text += frame.text
                    if self.session.provider not in OPENAI_PROVIDERS and time.monotonic() - self.partial_at >= 0.35:
                        self.partial_at = time.monotonic()
                        e.assistant(self.response_id, self.text, status="partial", turn=output_turn)
                    if self.hold_closing:
                        return
                elif isinstance(frame, FunctionCallsStartedFrame):
                    self.has_tools = True
                elif isinstance(frame, LLMFullResponseEndFrame):
                    e.latency("llm_total_ms", "llm_requested", turn=output_turn)
                    if self.session.provider not in OPENAI_PROVIDERS and self.text:
                        e.delivery.response(self.response_id)["generated_done"] = True
                        suppressed = self.hold_closing and (self.has_tools or e.memory.phase == "closing")
                        e.assistant(self.response_id, self.text, status="suppressed_closing_narration" if suppressed else "completed", turn=output_turn)
                        if self.hold_closing and not suppressed:
                            released = LLMTextFrame(self.text)
                            released.metadata["diagnostic_response_id"] = self.response_id
                            await self.push_frame(released, direction)
            elif self.stage == "tts":
                if isinstance(frame, LLMFullResponseEndFrame):
                    p.generated = False
                    await self.serializer.maybe_hangup()
                if isinstance(frame, TTSStartedFrame):
                    p.synthesizing = True
                    self.first_audio = False
                    e.event("tts_context_started", context_id=frame.context_id, response_id=e.delivery.contexts.get(frame.context_id, e.current_response_id), turn=output_turn)
                elif isinstance(frame, OutputAudioRawFrame) and not self.first_audio:
                    self.first_audio = True
                    row=e.delivery.responses.get(e.delivery.contexts.get(getattr(frame,"context_id",None)),{})
                    if row.get("kind") not in ("cached","backchannel"):
                        e.latency("tts_first_audio_ms", "tts_requested", turn=output_turn)
                if isinstance(frame, OutputAudioRawFrame):
                    response_id = e.delivery.contexts.get(getattr(frame, "context_id", None))
                    if response_id and e.delivery.response(response_id)['interrupted']:
                        return
                    if response_id and response_id not in e.response_audio_seen and response_id in e.response_text_at:
                        kind=e.delivery.responses.get(response_id,{}).get("kind")
                        controller=getattr(self.session,'controller',None)
                        if controller and kind!='backchannel':
                            epoch=controller.epoch
                            await controller.thinking.main_audio_ready(response_id)
                            if epoch!=controller.epoch or e.delivery.response(response_id)['interrupted']:
                                e.delivery.response(response_id)['interrupted']=True
                                e.event('tts_audio_discarded_after_handoff',response_id=response_id,reason='interrupted_while_waiting')
                                return
                        e.response_audio_seen.add(response_id)
                        e.event("backchannel_first_frame_ms" if kind=="backchannel" else "cached_first_frame_ms" if kind=="cached" else "response_tts_first_audio_ms", response_id=response_id, context_id=getattr(frame, "context_id", None),
                                turn=e.messages.get(response_id, {}).get("turn", output_turn),
                                latency_ms=round((e.clock() - e.response_text_at[response_id]) * 1000, 2))
                if isinstance(frame, TTSStoppedFrame):
                    p.synthesizing = False
                    row=e.delivery.responses.get(e.delivery.contexts.get(frame.context_id,e.current_response_id),{})
                    if row.get("kind") not in ("cached","backchannel"):e.latency("tts_total_ms", "tts_requested", turn=output_turn)
                    e.event("tts_context_stopped", context_id=frame.context_id, response_id=e.delivery.contexts.get(frame.context_id, e.current_response_id), turn=output_turn)
                    response_id = e.delivery.contexts.get(frame.context_id, e.current_response_id)
                    if response_id:
                        e.delivery.response(response_id)["tts_done"] = True
            elif self.stage == "delivery" and isinstance(frame,TTSStoppedFrame) and getattr(self.session,"controller",None):
                # This frame has drained through the paced output queue. Never
                # seal at the upstream TTS producer, where audio is still queued.
                response_id=e.delivery.contexts.get(frame.context_id)
                if response_id and response_id==self.serializer.tag_responses.get(p.active):
                    await self.serializer.seal()
                    await self.serializer.maybe_hangup()
                if response_id==self.serializer.output_response_id:self.serializer.output_response_id=None
            elif self.stage == "delivery" and isinstance(frame, TTSTextFrame):
                response_id = e.delivery.contexts.get(getattr(frame, "context_id", None), e.current_response_id)
                e.delivery.word(response_id, frame.text)
                e.event("tts_word_delivered", text=frame.text, pts=frame.pts, context_id=getattr(frame, "context_id", None),
                        response_id=response_id, turn=output_turn, source="local_output_clock_not_phone_ack")
            if isinstance(frame, MetricsFrame):
                for metric in frame.data:
                    e.event("pipecat_metric", stage=self.stage, data=metric.model_dump())
        if isinstance(frame, BotStoppedSpeakingFrame) and self.stage == "tts" and not getattr(self.session,"controller",None):
            await self.serializer.seal()
            await self.serializer.maybe_hangup()
        await self.push_frame(frame, direction)


def bind_vox_output_markers(output,serializer,evidence):
    """Bind ownership at the paced output hook, before PCM loses context_id.

    A downstream processor is too late: its queued Started frame may be handled
    after the first PCM has already reached the serializer.
    """
    original=output.push_frame
    async def push(frame,direction=FrameDirection.DOWNSTREAM):
        response_id=evidence.delivery.contexts.get(getattr(frame,'context_id',None))
        if direction==FrameDirection.DOWNSTREAM and isinstance(frame,TTSStartedFrame):serializer.output_response_id=response_id
        elif direction==FrameDirection.DOWNSTREAM and isinstance(frame,TTSStoppedFrame):
            if response_id and response_id==serializer.tag_responses.get(serializer.session.playback.active):
                await serializer.seal();await serializer.maybe_hangup()
            if response_id==serializer.output_response_id:serializer.output_response_id=None
        return await original(frame,direction)
    output.push_frame=push


def validated_tool(function):
    """Return a repairable tool result for malformed arguments, not a pipeline error."""
    signature = inspect.signature(function)

    @wraps(function)
    async def invoke(params, *positional, **arguments):
        session = getattr(getattr(params, "llm", None), "session", None)
        budget = getattr(session, "tool_budget", None)
        turn = (getattr(params.llm, "tool_call_turns", {}).get(getattr(params, "tool_call_id", None), session.evidence.output_turn)
                if session else None)
        original_callback = params.result_callback
        if budget:
            if not budget.begin(turn):
                await original_callback({"ok": False, "reason": "Бюджет инструментов исчерпан; дождись новой реплики."},
                    properties=FunctionCallResultProperties(run_llm=False))
                await session.tool_exhausted(params, turn)
                return
            params = copy.copy(params)
            async def bounded_result(result, *, properties=None):
                current = getattr(params.llm, "last_user_request_turn", None)
                if (session.evidence.turn if current is None else current) != turn:
                    await original_callback(result, properties=FunctionCallResultProperties(run_llm=False))
                    return
                if isinstance(result, dict) and result.get("ok") is False and budget.reject(turn):
                    await original_callback({**result, "waiting_for_user_clarification": True},
                        properties=FunctionCallResultProperties(run_llm=False))
                    await session.tool_exhausted(params, turn)
                else:
                    if properties is None:
                        await original_callback(result)
                    else:
                        await original_callback(result, properties=properties)
            params.result_callback = bounded_result
        try:
            signature.bind(params, *positional, **arguments)
        except TypeError as exc:
            result = {"ok": False, "reason": str(exc), "tool": function.__name__,
                      "allowed_fields": [key for key in signature.parameters if key != "params"],
                      "instruction": "Повтори вызов с полями из схемы. Время перезвона — callback_time, его исходная цитата — evidence. Для визита используй visit_day/day_evidence и visit_time/time_evidence.",
                      "visit_candidates": params.llm.session.evidence.memory.visit_candidates()}
            params.llm.session.evidence.event("tool_arguments_rejected", name=function.__name__, arguments=arguments, result=result)
            await params.result_callback(result)
            return
        return await function(params, *positional, **arguments)

    return invoke


def apply_tool_enums(tools):
    # This pinned Pipecat does not convert Literal annotations itself.
    if not hasattr(tools, "standard_tools"):
        return  # Closing state advertises no tools (NOT_GIVEN).
    schemas = {schema.name: schema for schema in tools.standard_tools}
    for wrapper in tools.direct_functions:
        for field, hint in get_type_hints(wrapper.function).items():
            if get_origin(hint) is Literal:
                schemas[wrapper.name].properties[field] = {"type": "string", "enum": list(get_args(hint))}


def call_context(session, serializer):
    session.tool_budget = ToolTurnBudget()
    session.tool_clarified_turns = set()

    async def clarify_after_tools(params, turn):
        def current_turn():
            value = getattr(params.llm, "last_user_request_turn", None)
            return session.evidence.turn if value is None else value
        if turn in session.tool_clarified_turns or turn != current_turn():
            return
        session.tool_clarified_turns.add(turn)
        e = session.evidence
        e.event("tool_budget_exhausted", turn=turn, attempts=session.tool_budget.attempts,
                failures=session.tool_budget.failures)
        llm = params.llm
        async def speak_when_response_ends():
            deadline = time.monotonic() + 2
            while getattr(llm, "wire_active", None) and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            if (current_turn() != turn or getattr(llm, "connection_failed", False)
                    or getattr(session, "finalized", False) or session.playback.finish_requested):
                return
            barrier = getattr(serializer, "queue_cleared_event", None)
            if barrier:
                barrier.clear()
                await llm.broadcast_frame(InterruptionFrame)
                await asyncio.wait_for(barrier.wait(), 2)
            if current_turn() != turn:
                return
            memory = e.memory
            candidates = memory.visit_candidates()
            if memory.visit_pending:
                day = candidates.get("visit_day", {}).get("value")
                when = candidates.get("visit_time", {}).get("value")
                day = day or memory.facts.get("visit_day", {}).get("value")
                when = when or memory.facts.get("visit_time", {}).get("value")
                text = (f"Подтвердите, пожалуйста: {day}, {when}?" if day and when else
                        f"{day.capitalize()} — во сколько вам удобно приехать?" if day else
                        "Подскажите, пожалуйста, в какой день вам удобно приехать?" if when else
                        "Подскажите, пожалуйста, в какой день и во сколько вам удобно приехать?")
            elif any("перезвон" in u["text"].lower() for u in memory.users[-2:]):
                text = "Подскажите, пожалуйста, когда вам удобно, чтобы я перезвонил?"
            else:
                text = "Повторите, пожалуйста, последнее условие."
            identifier = "clarification-" + uuid.uuid4().hex
            e.current_response_id = identifier
            e.response_text_at[identifier] = e.clock()
            e.assistant(identifier, text, source="backend_tool_clarification")
            e.delivery.response(identifier)["generated_done"] = True
            session.playback.generated = False
            e.event("tool_clarification_requested", turn=turn, response_id=identifier, text=text)
            frame = TTSSpeakFrame(text)
            frame.append_to_context = False
            frame.metadata["diagnostic_response_id"] = identifier
            await llm.push_frame(frame)
        async def safe_clarification():
            try:
                await speak_when_response_ends()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                e.event("tool_clarification_failed", error_type=type(exc).__name__, normal_completion=False)
                session.failure_reason = "tool_clarification_failed"
                session.status = "failed"
                if hasattr(serializer, "send"):
                    await serializer.send({"customEvent": "control", "action": "hangup"})
        llm.clarification_task = asyncio.create_task(safe_clarification())

    session.tool_exhausted = clarify_after_tools
    @validated_tool
    async def get_call_context(params: FunctionCallParams):
        """Получить контекст выбранного плана из существующего backend."""
        session.evidence.event("function_call", name="get_call_context")
        session.evidence.event("function_result", name="get_call_context", result=session.context)
        await params.result_callback(session.context)

    @validated_tool
    async def remember_call_fact(params: FunctionCallParams, key: Literal["manager_name", "visit_day", "visit_time", "callback", "vehicle", "price", "mileage"], value: str, evidence: str):
        """Сохранить факт (manager_name, visit_day, visit_time, callback, vehicle, price, mileage) с точной цитатой сотрудника."""
        result = session.evidence.memory.remember(key, value, evidence)
        session.evidence.event("memory_fact", key=key, result=result)
        await params.result_callback(result)

    @validated_tool
    async def prepare_end_call(params: FunctionCallParams, reason: Literal["conversation_complete", "visit_agreed", "callback_requested", "declined", "voicemail"], evidence: str = "", callback_time: str = "",
                               visit_day: str = "", day_evidence: str = "", visit_time: str = "", time_evidence: str = ""):
        """Закончить разговор БЕЗ речи модели. Причины: conversation_complete, visit_agreed, callback_requested, declined, voicemail. Если CALL_STATE.visit_candidates содержит visit_day и visit_time, достаточно reason=visit_agreed, backend сохранит их дословно. Иначе передай visit_day, day_evidence, visit_time, time_evidence вместе: значения дословно из цитат. Не добавляй поля callback или visit_agreed. Для callback_requested/declined/voicemail нужна точная цитата evidence; callback_time — дословное время перезвона. Транспорт произнесёт одно прощание после сохранения фактов."""
        e = session.evidence
        if reason == "visit_agreed":
            result = e.memory.save_visit(visit_day, day_evidence, visit_time, time_evidence)
            e.event("visit_facts_saved", result=result, facts=e.memory.facts)
            if not result["ok"]:
                await params.result_callback(result)
                return
        if callback_time:
            fact = e.memory.remember("callback", callback_time, evidence)
            if not fact["ok"]:
                await params.result_callback(fact)
                return
        result = e.memory.prepare_close(reason, evidence)
        if result["ok"]:
            await refresh_tools(getattr(params, "llm", None))
        e.event("closing_decision", result=result, memory=e.memory.snapshot())
        if not result["ok"]:
            await params.result_callback(result)
            return
        llm = getattr(params, "llm", None)
        existing_id = getattr(llm, "response_id", None) or e.current_response_id
        existing_text = (llm.spoken_text.get(existing_id, "") if hasattr(llm, "spoken_text")
            else getattr(llm, "response_text", {}).get(existing_id, "") or e.messages.get(existing_id, {}).get("text", ""))
        monitor = getattr(session, "llm_output_evidence", None)
        held = existing_id in getattr(llm, "held_responses", set()) or (session.provider not in OPENAI_PROVIDERS and bool(monitor and monitor.hold_closing))
        if reason != "voicemail" and existing_text.strip() and not held:
            # Text already released to TTS must finish as this turn's closing.
            # Adding a second backend utterance both repeats the goodbye and
            # switches response IDs while the first context is still playing.
            session.playback.finish_requested = True
            session.finish_response_id = existing_id
            e.event("closing_existing_response_selected", response_id=existing_id, text=existing_text)
            await params.result_callback({"ok": True, "using_existing_response": existing_id},
                                         properties=FunctionCallResultProperties(run_llm=False))
            await serializer.maybe_hangup()
            return
        await params.result_callback({"ok": True, "transport_will_say_farewell": True},
                                     properties=FunctionCallResultProperties(run_llm=False))
        if reason == "voicemail":
            e.event("voicemail_hangup", speech=False)
            if hasattr(serializer, "send"):
                await serializer.send({"customEvent": "control", "action": "hangup"})
            return
        facts = e.memory.facts
        if reason == "callback_requested":
            when = facts.get("callback", {}).get("value", "")
            text = f"Хорошо, перезвоню{' ' + when if when else ''}. До свидания."
        elif reason == "visit_agreed":
            text = f"Договорились: {facts['visit_day']['value']}, {facts['visit_time']['value']}. До свидания."
        else:
            text = "Спасибо за информацию. Всего доброго."
        response_id = "farewell-" + uuid.uuid4().hex
        e.current_response_id = response_id
        e.response_text_at[response_id] = e.clock()
        e.assistant(response_id, text, source="backend_guarded_farewell")
        e.delivery.response(response_id)["generated_done"] = True
        session.playback.finish_requested = True
        session.finish_response_id = response_id
        e.event("function_call", name="end_call", source="backend_guarded_farewell")
        e.event("function_result", name="end_call", result={"ok": True, "waiting_for_playback": True})
        e.mark("tts_requested", turn=e.output_turn)
        llm = getattr(params, "llm", None)
        if llm:
            frame = TTSSpeakFrame(text)
            # The backend owns this final utterance. Committing it through
            # the native Realtime assistant aggregator could request another
            # model response after the tool deliberately set run_llm=False.
            frame.append_to_context = False
            frame.metadata["diagnostic_response_id"] = response_id
            await llm.push_frame(frame)
        await serializer.maybe_hangup()

    dialogue_tools = [get_call_context, remember_call_fact, prepare_end_call]
    context = LLMContext([{"role": "system", "content": adapt_prompt(session.prompt, session.evidence.memory.name,
        mode=getattr(session, "prompt_mode", "compact"))}], dialogue_tools)
    apply_tool_enums(context.tools)

    async def refresh_tools(llm, resume=False):
        if resume:
            session.evidence.memory.phase = "dialogue"
            session.evidence.memory.closing_reason = None
        context.set_tools([] if session.evidence.memory.phase == "closing" else dialogue_tools)
        apply_tool_enums(context.tools)
        if llm:
            llm._sync_registered_tool_handlers(context.tools)
            if isinstance(llm, GatedRealtime):
                await llm._send_session_update()
        session.evidence.event("call_tools_changed", phase=session.evidence.memory.phase,
                               tools=[] if session.evidence.memory.phase == "closing" else [tool.__name__ for tool in dialogue_tools])

    session.refresh_call_tools = refresh_tools
    return context


async def run_pipeline(session, websocket):
    serializer = VoxSerializer(session, websocket)
    transport = FastAPIWebsocketTransport(websocket=websocket, params=FastAPIWebsocketParams(
        audio_in_enabled=True, audio_out_enabled=True, audio_out_sample_rate=16000,
        audio_out_channels=1, audio_out_10ms_chunks=2, add_wav_header=False, serializer=serializer,
        allowed_origins=[], session_timeout=getattr(session,"max_call_seconds",900),
    ))
    bind_vox_output_markers(transport.output(),serializer,session.evidence)
    monitor = TurnMonitor(session)
    controller=getattr(session,"controller",None)
    if controller:
        from dialogue_controller import controller_prompt
        from controller_audio import PreparedAudioPlayer
        controller.serializer=serializer;controller.monitor=monitor
        context=LLMContext([{"role":"system","content":controller_prompt(session)}],tools=[])
        controller.player=PreparedAudioPlayer(session)
        controller.output_transport=transport.output()
    else:context = call_context(session, serializer)
    session.evidence.event("pipeline_configuration", context=context.get_messages(), provider=session.provider,
        settings={"vad_start_ms": 100, "vad_stop_ms": 200, "smart_turn_stop_ms": 1500,
                  "transcription": realtime_transcription_config(getattr(session, "transcription_model", REALTIME_TRANSCRIPTION_MODEL)) if session.provider in OPENAI_PROVIDERS else None,
                  "server_vad": False, "native_tts": False,
                  "interruption_sustained_ms": getattr(session, "interruption_ms", SUSTAINED_MS),
                  "speech_mode": getattr(session, "speech_mode", "sentence"),
                  "prompt_mode": getattr(session, "prompt_mode", "compact")})
    if session.provider in OPENAI_PROVIDERS:
        llm = GatedRealtime(session, monitor, wait_for_user=True, trim_idle_audio=getattr(session, "trim_idle_audio", False), api_key=os.environ["OPENAI_API_KEY"], user_audio_preroll_secs=1.5,
            settings=OpenAIRealtimeLLMService.Settings(model=PROVIDERS[session.provider], session_properties=events.SessionProperties(
                reasoning=events.Reasoning(effort=getattr(session, "reasoning_effort", "low")),
                output_modalities=["text"], audio=events.AudioConfiguration(input=events.AudioInput(
                    turn_detection=False, transcription=events.InputAudioTranscription(**realtime_transcription_config(getattr(session, "transcription_model", REALTIME_TRANSCRIPTION_MODEL))),
                )),
            )))
    else:
        llm = create_gemini_service(session.provider)
    llm.session = session
    if session.provider in OPENAI_PROVIDERS:await llm.prime_context(context)
    if controller:
        controller.llm=llm
        if getattr(controller,'line',None):controller.line.arm_wait()
    async def interrupt():
        await monitor.broadcast_frame(InterruptionFrame)
    monitor.interrupt = interrupt
    smart=DiagnosticSmartTurn(session.evidence, params=SmartTurnParams(stop_secs=1.5))
    smart.controller=controller
    user, assistant = LLMContextAggregatorPair(context, realtime_service_mode=True,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer(params=VADParams(start_secs=0.1, stop_secs=0.2)),
            user_turn_strategies=UserTurnStrategies(
                start=[VADUserTurnStartStrategy(enable_interruptions=False)],
                stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=smart, wait_for_transcript=False)],
            )))
    tts = getattr(session, "prepared_tts", None) or create_tts(session)
    @tts.event_handler("on_connection_error")
    async def tts_connection_error(service, error):
        await service.push_error(error_msg="ElevenLabs connection unavailable after bounded attempts", force_treat_as_permanent=True)
    processors = [transport.input(), user, monitor]
    if session.provider in GEMINI_PROVIDERS:
        processors.append(FlashTranscriber(session, monitor, context))
    processors += [llm, OutputEvidence(session, serializer, "llm"), tts]
    if controller:processors.append(controller.player)
    processors += [OutputEvidence(session, serializer, "tts"), transport.output(), OutputEvidence(session, serializer, "delivery"), assistant]
    worker = PipelineWorker(Pipeline(processors), params=PipelineParams(
        audio_in_sample_rate=16000, audio_out_sample_rate=16000, enable_metrics=True, enable_usage_metrics=True),
        enable_rtvi=False, processor_unusable_policy=ProcessorUnusablePolicy.END)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    if session.provider in OPENAI_PROVIDERS:
        session.realtime_failure_handler = RealtimeFailureNotice(session, llm, monitor, serializer, runner)
    telemetry_task = None

    @worker.event_handler("on_pipeline_error")
    async def pipeline_error(worker, frame):
        session.evidence.event("pipeline_error", processor=type(frame.processor).__name__, message=frame.error,
                               error_type=type(frame.exception).__name__ if frame.exception else None,
                               unusable=bool(frame.processor and not frame.processor.is_usable))
        if frame.processor and not frame.processor.is_usable:
            session.status = "failed"
            session.evidence.memory.phase = "failed"
            if not session.playback.had_audio:
                await serializer.send({"customEvent": "control", "action": "hangup"})

    @transport.event_handler("on_client_connected")
    async def connected(transport, client):
        nonlocal telemetry_task
        session.status = "connected"
        session.evidence.event("waiting_for_person")
        if session.provider in OPENAI_PROVIDERS:
            await worker.queue_frames([LLMRunFrame()])
        async def ping_transport():
            for _ in range(3):
                await asyncio.sleep(3)
                try:
                    await serializer.measure_rtt()
                except Exception as exc:
                    session.evidence.event("transport_rtt_unavailable", error_type=type(exc).__name__)
                    return
        telemetry_task = asyncio.create_task(ping_transport())

    @transport.event_handler("on_client_disconnected")
    async def disconnected(transport, client):
        session.status = "failed" if getattr(session, "failure_reason", None) else "disconnected"
        session.media_disconnected=True
        if getattr(session,'controller',None):session.controller.abort()
        session.evidence.event("transport_disconnected")
        await runner.cancel()

    @transport.event_handler("on_session_timeout")
    async def timeout(transport, client):
        session.status = "failed"
        session.failure_reason='media_session_timeout'
        session.media_disconnected=True
        if getattr(session,'controller',None):session.controller.abort()
        session.evidence.event("test_timeout", normal_completion=False,limit_seconds=getattr(session,'max_call_seconds',900))
        await runner.cancel()

    try:
        await runner.run()
    finally:
        monitor.cancel_timer()
        if controller:await controller.close()
        if telemetry_task:
            telemetry_task.cancel()
            await asyncio.gather(telemetry_task, return_exceptions=True)


async def probe_tts_service(model, voice, audio_path=None, text="Здравствуйте. Проверяем качество голоса и задержку ответа.", tts_service=None):
    """Live Pipecat TTD synthesis without Voximplant or a phone call."""
    measured = {"audioBytes": 0, "firstAudioMs": None, "sampleRate": None}
    start = time.monotonic()
    audio = bytearray()

    class Collector(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, OutputAudioRawFrame):
                if frame.sample_rate != 16000 or frame.num_channels != 1 or len(frame.audio) % 2:
                    raise ValueError("Pipecat TTS output format mismatch")
                measured["audioBytes"] += len(frame.audio)
                if audio_path:
                    audio.extend(frame.audio)
                measured["sampleRate"] = frame.sample_rate
                if measured["firstAudioMs"] is None:
                    measured["firstAudioMs"] = round((time.monotonic() - start) * 1000, 2)
            await self.push_frame(frame, direction)

    tts = tts_service or DialogueTTS(api_key=os.environ["ELEVENLABS_API_KEY"], sample_rate=16000,
        settings=ElevenLabsDialogueTTSService.Settings(model=model, voice=voice, language="ru", stability=0.5))
    worker = PipelineWorker(Pipeline([tts, Collector()]), params=PipelineParams(audio_out_sample_rate=16000),
        enable_rtvi=False, processor_unusable_policy=ProcessorUnusablePolicy.END)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await worker.queue_frames([TTSSpeakFrame(text), EndFrame()])
    try:
        async with asyncio.timeout(45):
            await runner.run()
    finally:
        await runner.cancel()
    if measured["audioBytes"] == 0:
        raise RuntimeError("Pipecat produced no audio")
    if audio_path:
        import wave
        with wave.open(str(audio_path), "wb") as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            wav.writeframes(audio)
    return measured
