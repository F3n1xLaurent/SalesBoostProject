"""Isolated, paced audio benchmark. No phone calls, CRM, or output TTS.

Requires the prototype Python environment plus deepgram-sdk>=6.1.1,<8.
Use a synthetic PCM16 mono 16k WAV containing one uninterrupted utterance.
"""
import argparse
import asyncio
from array import array
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import time
from uuid import uuid4
import wave

ROOT = Path(__file__).resolve().parents[2]
VARIANTS = ("realtime", "nova3", "flux")
AVAILABLE_VARIANTS = VARIANTS + ("gemini_audio",)
REALTIME_STT_MODELS = ("gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-live-transcribe")
PROMPT = "Ты телефонный помощник. Отвечай на русском, кратко, одним предложением. Учитывай только то, что сказал собеседник."


def fixture(path):
    with wave.open(str(path)) as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
            raise ValueError("Expected PCM16 mono 16000 Hz WAV")
        pcm = wav.readframes(wav.getnframes())
    # Shared acoustic reference, independent of all three endpoint detectors.
    samples = array("h", pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    active = [i for i in range(0, len(samples), 160)
              if max(map(abs, samples[i:i + 160]), default=0) >= 300]
    if not active:
        raise ValueError("Fixture contains no audible speech")
    end = min(len(samples), active[-1] + 160) / 16000
    return pcm, end


def summarize(rows, variants=VARIANTS):
    result = {}
    for variant in variants:
        attempted = [r for r in rows if r["variant"] == variant]
        valid = [r for r in attempted if r.get("status") == "measured"]
        result[variant] = {"attempts": len(attempted), "valid": len(valid),
            "medianMs": {name: (round(statistics.median(values), 2) if values else None)
                for name in ("endToBoundaryMs", "endToFinalTranscriptMs", "endToFirstTextMs", "llmRequestToFirstTextMs")
                for values in [[r[name] for r in valid if r.get(name) is not None]]}}
    return result


async def run_one(variant, pcm, acoustic_end, transcription_model="gpt-4o-transcribe", gemini_provider="gemini_proxyapi", gemini_model=None):
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams
    from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
    from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
    from pipecat.frames.frames import (InputAudioRawFrame, LLMTextFrame, LLMFullResponseEndFrame,
        LLMRunFrame, LLMContextFrame, UserStoppedSpeakingFrame, TranscriptionFrame, ErrorFrame, StartFrame)
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
    from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
    from pipecat.turns.user_start import VADUserTurnStartStrategy
    from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies
    from pipecat.transcriptions.language import Language
    from pipecat.workers.runner import WorkerRunner
    from gemini_provider import create_gemini_service, gemini_connection, MODEL

    result = {"variant": variant, "status": "error", "events": [], "transcript": "", "text": ""}
    clock = time.monotonic
    timestamps = {}
    ready, started, done = asyncio.Event(), asyncio.Event(), asyncio.Event()
    origin = None
    def mark(name, **extra):
        now = clock()
        timestamps.setdefault(name, now)
        result["events"].append({"name": name, "at": now, **extra})

    class Recorder(FrameProcessor):
        def __init__(self, stage):
            super().__init__()
            self.stage = stage
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if direction == FrameDirection.DOWNSTREAM:
                if isinstance(frame, StartFrame) and self.stage == "output":
                    started.set()
                if isinstance(frame, ErrorFrame):
                    mark("error", errorType=type(frame).__name__)
                    done.set()
                if isinstance(frame, TranscriptionFrame) and self.stage == "stt":
                    result["transcript"] += " " + frame.text
                    mark("final_transcript", text=frame.text)
                    timestamps["final_transcript"] = clock()
                if isinstance(frame, UserStoppedSpeakingFrame) and self.stage == "boundary":
                    mark("boundary")
                if isinstance(frame, LLMContextFrame) and self.stage == "boundary":
                    mark("llm_request")
                if isinstance(frame, LLMTextFrame) and self.stage == "output" and frame.text.strip():
                    mark("first_text")
                    result["text"] += frame.text
                if isinstance(frame, LLMFullResponseEndFrame) and result["text"]:
                    done.set()
            await self.push_frame(frame, direction)

    stt = None
    session = None
    monitor = None
    if variant == "flux":
        from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
        stt = DeepgramFluxSTTService(api_key=os.environ["DEEPGRAM_API_KEY"], sample_rate=16000,
            should_interrupt=False, enable_eager_end_of_turn=False,
            settings=DeepgramFluxSTTService.Settings(model="flux-general-multi",
                language_hints=[Language.RU], eot_threshold=0.7, eot_timeout_ms=5000))
        user_params = LLMUserAggregatorParams(vad_analyzer=None,
            user_turn_strategies=stt.recommended_user_turn_strategies(enable_interruptions=False))
    else:
        user_params = LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(start_secs=0.1, stop_secs=0.2)),
            user_turn_strategies=UserTurnStrategies(start=[VADUserTurnStartStrategy(enable_interruptions=False)],
                stop=[TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=1.5)),
                    wait_for_transcript=variant not in {"realtime", "gemini_audio"})]))
        if variant == "nova3":
            from pipecat.services.deepgram.stt import DeepgramSTTService
            stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"], sample_rate=16000,
                settings=DeepgramSTTService.Settings(model="nova-3", language=Language.RU,
                    endpointing=False, interim_results=True, punctuate=True))

    context = LLMContext([{"role": "system", "content": PROMPT}])
    user, assistant = LLMContextAggregatorPair(context, realtime_service_mode=variant in {"realtime", "gemini_audio"},
        user_params=user_params)
    if variant == "realtime":
        result["transcriptionModel"] = transcription_model
        from pipeline import GatedRealtime, TurnMonitor
        from service import Session
        from pipecat.services.openai.realtime import events
        session = Session(id=str(uuid4()), provider="openai", tts_model="eleven_v3", voice_id="benchmark",
            prompt=PROMPT, context={}, to="", transcription_model=transcription_model)
        session.is_simulation = True
        monitor = TurnMonitor(session)
        class BenchmarkRealtime(GatedRealtime):
            async def _handle_evt_input_audio_transcription_delta(self, evt):
                mark("partial_transcript")
                await super()._handle_evt_input_audio_transcription_delta(evt)

            async def handle_evt_input_audio_transcription_completed(self, evt):
                mark("final_transcript", text=evt.transcript)
                result["transcript"] = evt.transcript
                await super().handle_evt_input_audio_transcription_completed(evt)

        transcription = events.InputAudioTranscription(model=transcription_model,
            **({"languages": ["ru"]} if transcription_model == "gpt-live-transcribe" else {"language": "ru"}))
        llm = BenchmarkRealtime(session, monitor, wait_for_user=True, api_key=os.environ["OPENAI_API_KEY"],
            user_audio_preroll_secs=1.5, settings=GatedRealtime.Settings(model="gpt-realtime-2.1",
                session_properties=events.SessionProperties(reasoning=events.Reasoning(effort="low"),
                    output_modalities=["text"], audio=events.AudioConfiguration(input=events.AudioInput(
                        turn_detection=False, transcription=transcription)))))
    else:
        if gemini_model and gemini_model != MODEL:
            # Model override belongs only to this isolated benchmark.
            from pipecat.services.google.llm import GoogleLLMService
            llm = GoogleLLMService(**gemini_connection(gemini_provider), settings=GoogleLLMService.Settings(
                model=gemini_model, max_tokens=1024,
                thinking=GoogleLLMService.ThinkingConfig(thinking_level="low")))
        else:
            llm = create_gemini_service(gemini_provider)
        result["geminiProvider"] = gemini_provider
        result["geminiModel"] = gemini_model or MODEL
        result["streaming"] = True
        if stt:
            @stt.event_handler("on_connected")
            async def connected(service):
                ready.set()

    audio_frames = []

    class AudioCollector(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if direction == FrameDirection.DOWNSTREAM and isinstance(frame, InputAudioRawFrame):
                audio_frames.append(frame)
            await self.push_frame(frame, direction)

    class AudioRequest(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if direction == FrameDirection.DOWNSTREAM:
                if isinstance(frame, (InputAudioRawFrame, LLMContextFrame)):
                    return  # One audio request below owns this turn's context.
                if isinstance(frame, UserStoppedSpeakingFrame) and audio_frames:
                    frames = list(audio_frames)
                    audio_frames.clear()
                    await context.add_audio_frames_message(audio_frames=frames)
                    mark("llm_request", inputMode="one_pass_audio",
                         audioMs=round(sum(len(f.audio) for f in frames) / 32, 2))
                    await self.push_frame(frame, direction)
                    await self.push_frame(LLMContextFrame(context))
                    return
            await self.push_frame(frame, direction)

    processors = ([stt, Recorder("stt")] if stt else []) + [user]
    if variant == "gemini_audio":
        processors.insert(0, AudioCollector())
    if monitor:
        processors.append(monitor)
    processors += [Recorder("boundary")]
    if variant == "gemini_audio":
        processors.append(AudioRequest())
        result["inputMode"] = "single_audio_request_after_smart_turn"
    processors += [llm, Recorder("output"), assistant]
    worker = PipelineWorker(Pipeline(processors), params=PipelineParams(audio_in_sample_rate=16000,
        audio_out_sample_rate=16000, enable_metrics=True), enable_rtvi=False,
        processor_unusable_policy=ProcessorUnusablePolicy.END)
    @worker.event_handler("on_pipeline_error")
    async def pipeline_error(worker, frame):
        mark("pipeline_error", phase="measurement" if origin is not None else "connection",
             fatal=frame.fatal, category=str(frame.category),
             httpStatus=getattr(frame.exception, "code", None),
             errorType=type(frame.exception).__name__ if frame.exception else None)
        if origin is not None:
            done.set()
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    if variant == "realtime":
        await worker.queue_frames([LLMRunFrame()])
    running = asyncio.create_task(runner.run())
    try:
        async with asyncio.timeout(60):
            await started.wait()
            if variant == "realtime":
                await llm.context_ready.wait()
                confirmations = [e["session"] for e in session.evidence.events
                    if e.get("event") == "provider_session_confirmed"]
                effective = confirmations[-1].get("audio", {}).get("input", {}) if confirmations else {}
                result["confirmedTranscription"] = effective.get("transcription")
                result["confirmedTurnDetection"] = effective.get("turn_detection")
                if (effective.get("transcription") or {}).get("model") != transcription_model:
                    raise RuntimeError("Transcription model not confirmed by server")
            elif variant == "nova3":
                # This pinned Nova SDK service awaits its handshake in start(),
                # but does not emit the base STT on_connected event.
                if stt._connection is None:
                    raise ConnectionError("Nova connection did not open")
            elif stt:
                await ready.wait()
            mark("ready")
            # 0.5s lead-in and 8s tail, same input and 80ms pacing in every arm.
            audio = bytes(16000) + pcm + bytes(256000)
            origin = clock()
            reference = origin + 0.5 + acoustic_end
            for offset in range(0, len(audio), 2560):
                await asyncio.sleep(max(0, origin + offset / 32000 - clock()))
                if done.is_set():
                    break
                await worker.queue_frames([InputAudioRawFrame(audio[offset:offset + 2560], 16000, 1)])
            await done.wait()
            # Native ASR is parallel to generation; allow its final event to arrive.
            if session:
                deadline = clock() + 5
                while "final_transcript" not in timestamps and clock() < deadline:
                    await asyncio.sleep(0.05)
            result["status"] = "measured" if "first_text" in timestamps and "boundary" in timestamps else "error"
            if any(e["name"] == "pipeline_error" and e.get("phase") == "measurement" for e in result["events"]):
                result["status"] = "error"
            if variant != "gemini_audio" and not result["transcript"].strip():
                result["status"] = "missing_transcript"
            if timestamps.get("boundary", reference) < reference:
                result["status"] = "premature_boundary"
            for key, name in (("endToBoundaryMs", "boundary"), ("endToFinalTranscriptMs", "final_transcript"),
                              ("endToFirstPartialTranscriptMs", "partial_transcript"),
                              ("endToFirstTextMs", "first_text")):
                result[key] = round((timestamps[name] - reference) * 1000, 2) if name in timestamps else None
            if "llm_request" in timestamps and "first_text" in timestamps:
                result["llmRequestToFirstTextMs"] = round((timestamps["first_text"] - timestamps["llm_request"]) * 1000, 2)
            if session:
                requests = [e for e in session.evidence.events if e.get("event") == "response_requested"]
                if requests:
                    request_at = session.evidence.started + requests[0]["ms"] / 1000
                    result["endToResponseRequestMs"] = round((request_at - reference) * 1000, 2)
                    result["responseRequestedBeforeFinalTranscript"] = request_at < timestamps.get("final_transcript", float("inf"))
                result["diagnosticId"] = "pc-" + session.id
            result["reference"] = "last 10ms PCM window with peak >=300; includes 0.5s lead-in"
    except Exception as exc:
        result["errorType"] = type(exc).__name__  # Never serialize SDK messages containing credentials.
        result["httpStatus"] = getattr(exc, "code", None)
    finally:
        await runner.cancel()
        await asyncio.gather(running, return_exceptions=True)
    return result


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, default=ROOT / ".env")
    parser.add_argument("--input-wav", type=Path)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--output", type=Path, default=ROOT / "storage/pipecat-benchmarks/turns.json")
    parser.add_argument("--check", action="store_true", help="Local configuration check; makes no API requests")
    parser.add_argument("--compare-realtime-stt", action="store_true",
        help="Compare 3 input transcription models with the same native Realtime pipeline")
    parser.add_argument("--gemini-provider", choices=("gemini", "gemini_proxyapi"), default="gemini_proxyapi",
        help="gemini uses the direct Google streaming API with GEMINI_API_KEY")
    parser.add_argument("--gemini-model", default="gemini-3.8-flash",
        help="Override the Gemini model only in this benchmark; does not change the service")
    parser.add_argument("--variants", nargs="+", choices=AVAILABLE_VARIANTS, default=list(VARIANTS))
    parser.add_argument("--request-interval", type=float, default=0,
        help="Minimum seconds between run starts; useful for Free Tier quotas")
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(args.env)
    variants = REALTIME_STT_MODELS if args.compare_realtime_stt else tuple(dict.fromkeys(args.variants))
    required = []
    if args.compare_realtime_stt or "realtime" in variants:
        required.append("OPENAI_API_KEY")
    if not args.compare_realtime_stt and any(v != "realtime" for v in variants):
        required += ["GEMINI_API_KEY" if args.gemini_provider == "gemini" else "PROXYAPI_API_KEY"]
    if not args.compare_realtime_stt and any(v in {"nova3", "flux"} for v in variants):
        required.append("DEEPGRAM_API_KEY")
    missing = [key for key in required if not os.getenv(key)]
    if missing:
        print(json.dumps({"status": "blocked", "missing": missing, "envFile": str(args.env)}))
        return 2
    if args.check:
        print(json.dumps({"status": "configured", "networkChecked": False}))
        return 0
    if not args.input_wav or args.runs < 1 or args.request_interval < 0:
        parser.error("Provide --input-wav (synthetic Russian PCM16 mono 16k) and --runs >=1")
    pcm, acoustic_end = fixture(args.input_wav)
    benchmark_id = "pcb-" + str(uuid4())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    previous_start = None
    for index in range(args.runs):
        order = variants[index % len(variants):] + variants[:index % len(variants)]
        for variant in order:
            if previous_start is not None:
                delay = args.request_interval - (time.monotonic() - previous_start)
                while delay > 0:
                    await asyncio.sleep(min(delay, 30))
                    delay = args.request_interval - (time.monotonic() - previous_start)
            previous_start = time.monotonic()
            try:
                row = (await run_one("realtime", pcm, acoustic_end, transcription_model=variant)
                    if args.compare_realtime_stt else await run_one(variant, pcm, acoustic_end,
                        gemini_provider=args.gemini_provider, gemini_model=args.gemini_model))
                row["variant"] = variant
            except Exception as exc:
                row = {"variant": variant, "status": "error", "errorType": type(exc).__name__}
            row["run"] = index + 1
            rows.append(row)
            report = {"id": benchmark_id, "updatedAt": datetime.now(timezone.utc).isoformat(),
                "fixtureSha256": hashlib.sha256(pcm).hexdigest(),
                "scope": "audio to first text; excludes TTS/telephony; synthetic fixture only; fresh connections; short shared prompt",
                "mode": "realtime_transcription_models" if args.compare_realtime_stt else "pipeline_comparison",
                "geminiProvider": None if args.compare_realtime_stt else args.gemini_provider,
                "geminiStreaming": not args.compare_realtime_stt and any(v != "realtime" for v in variants),
                "requestIntervalSeconds": args.request_interval,
                "models": ({model: "gpt-realtime-2.1 (low) + " + model for model in variants}
                    if args.compare_realtime_stt else {"realtime": "gpt-realtime-2.1 (low)", "nova3": "nova-3 + " + args.gemini_model,
                    "flux": "flux-general-multi + " + args.gemini_model,
                    "gemini_audio": "Silero/Smart Turn + one-pass audio + " + args.gemini_model}), "runs": rows, "summary": summarize(rows, variants)}
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            args.output.chmod(0o600)
            print(json.dumps({"variant": variant, "run": index + 1, "status": row["status"]}), flush=True)
    print(json.dumps(summarize(rows, variants), ensure_ascii=False, indent=2))
    return 0 if all(r["status"] == "measured" for r in rows) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
