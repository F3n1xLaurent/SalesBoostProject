"""Real Realtime logging probe with synthetic audio; never dials a phone."""
import asyncio
import base64
import json
import os
import wave
from pathlib import Path
from uuid import uuid4

from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import EndFrame, LLMFullResponseEndFrame, LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.services.openai.realtime import events
from pipecat.workers.runner import WorkerRunner

from pipeline import GatedRealtime, Turn, OutputEvidence
from service import Session


async def main():
    session = Session(id=str(uuid4()), provider="openai", tts_model="eleven_v4_turbo", voice_id="diagnostic-probe",
        prompt="Спроси по-русски: проверяем ли мы качество голоса? Затем коротко отреагируй на ответ.",
        context={"planName": "Синтетическая проверка журнала — без звонка"}, to="")
    session.status = "connected"
    session.evidence.event("diagnostic_probe", phone_calls=0, tts_tested=False, phone_playback_tested=False)
    monitor = type("Monitor", (), {"turn": Turn(False, number=0)})()
    llm = GatedRealtime(session, monitor, api_key=os.environ["OPENAI_API_KEY"],
        settings=GatedRealtime.Settings(model="gpt-realtime-2.1", session_properties=events.SessionProperties(
            output_modalities=["text"], audio=events.AudioConfiguration(input=events.AudioInput(
                turn_detection=False, transcription=events.InputAudioTranscription(model="gpt-4o-transcribe", language="ru"))))))
    context = LLMContext([{"role": "system", "content": session.prompt}])
    user, assistant = LLMContextAggregatorPair(context, realtime_service_mode=True)
    done = asyncio.Event()

    class Collector(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if direction == FrameDirection.DOWNSTREAM and isinstance(frame, LLMFullResponseEndFrame):
                done.set()
            await self.push_frame(frame, direction)

    worker = PipelineWorker(Pipeline([user, llm, OutputEvidence(session, None, "llm"), Collector(), assistant]),
        params=PipelineParams(audio_in_sample_rate=24000, enable_metrics=True), enable_rtvi=False,
        processor_unusable_policy=ProcessorUnusablePolicy.END)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    async def feed_audio():
        await done.wait()
        done.clear()
        # Deliberate gap in the same provider session. No fake phone-playback ACK.
        await asyncio.sleep(4)
        monitor.turn = Turn(False, duration_ms=4000, number=1)
        session.evidence.turn = 1
        session.evidence.reply_reference(1)
        fixture = Path(os.environ.get("PIPECAT_LOG_DIR", "/data/logs")) / "gemini-probe-input.wav"
        with wave.open(str(fixture)) as audio:
            assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
            pcm = await create_stream_resampler().resample(audio.readframes(audio.getnframes()), 16000, 24000)
        await llm.send_client_event(events.InputAudioBufferAppendEvent(audio=base64.b64encode(pcm).decode()))
        session.evidence.mark("speech_end", turn=1)
        await llm._handle_user_stopped_speaking(None)
        await done.wait()
        await asyncio.sleep(1)
        await worker.queue_frames([EndFrame()])

    feed = asyncio.create_task(feed_audio())
    await worker.queue_frames([LLMRunFrame()])
    try:
        async with asyncio.timeout(45):
            await runner.run()
            await feed
        kinds = {event["event"] for event in session.evidence.events}
        required = {"provider_session_confirmed", "response_requested", "provider_response_created", "assistant_response", "user_transcript", "reply_reference"}
        assert required <= kinds, f"Missing diagnostics: {required - kinds}"
        snapshots = [event for event in session.evidence.events if event["event"] == "response_requested"]
        assert len(snapshots) >= 2 and snapshots[-1]["provider_conversation"]
        assert snapshots[-1]["last_audio_commit"]["audio_ms"] > 0
        print(json.dumps({"status": "passed", "diagnosticId": "pc-" + session.id, "phoneCallsMade": 0,
            "events": session.evidence.sequence, "responses": len(snapshots)}, ensure_ascii=False))
    finally:
        feed.cancel()
        await asyncio.gather(feed, return_exceptions=True)
        await runner.cancel()
        session.status = "disconnected"
        session.finalized = True
        session.evidence.event("session_ended", reason="diagnostic_probe")
        session.persist()


if __name__ == "__main__":
    asyncio.run(main())
