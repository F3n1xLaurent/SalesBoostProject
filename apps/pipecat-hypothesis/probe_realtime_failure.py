"""Injected socket loss -> real ElevenLabs notice -> simulated playback ACK."""
import asyncio
import argparse
import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
from network import elevenlabs_http_options
from service import Session
from pipeline import GatedRealtime, Turn, VoxSerializer, OutputEvidence, prepare_tts
from realtime_failure import RealtimeFailureNotice
from pipecat.frames.frames import OutputAudioRawFrame, TTSStoppedFrame, StartFrame, InterruptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner


async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--stt-timeout',action='store_true');args=parser.parse_args()
    voice = os.getenv("ELEVENLABS_VOICE_ID")
    if not voice:
        async with httpx.AsyncClient(timeout=20, **elevenlabs_http_options()) as client:
            r = await client.get("https://api.elevenlabs.io/v1/convai/agents/" + os.environ["ELEVENLABS_AGENT_ID"], headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
            r.raise_for_status()
            voice = r.json()["conversation_config"]["tts"]["voice_id"]
    s = Session(id=str(uuid4()), provider="openai_mini", tts_model="eleven_v4_turbo", voice_id=voice,
                prompt="Synthetic transport failure probe", context={}, to="")
    s.status = "connected"
    s.is_simulation = True
    started, ended = asyncio.Event(), asyncio.Event()
    audio_bytes = 0
    async def control(text):
        msg = json.loads(text)
        if msg.get("action") == "hangup":
            s.evidence.event("simulated_failure_hangup")
            ended.set()
    serializer = VoxSerializer(s, SimpleNamespace(send_text=control))

    class Emitter(FrameProcessor):
        def cancel_timer(self):
            pass
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            await self.push_frame(frame, direction)

    class Output(FrameProcessor):
        async def process_frame(self, frame, direction):
            nonlocal audio_bytes
            await super().process_frame(frame, direction)
            if isinstance(frame, StartFrame):
                started.set()
            if isinstance(frame, OutputAudioRawFrame):
                audio_bytes += len(frame.audio)
                await serializer.serialize(frame)
            if isinstance(frame, InterruptionFrame):
                await serializer.serialize(frame)
            if isinstance(frame, TTSStoppedFrame):
                tag = s.playback.active
                await serializer.seal()
                if tag:
                    await serializer.deserialize(json.dumps({"customEvent": "playback", "action": "ended", "tag": tag}))
            await self.push_frame(frame, direction)

    emitter = Emitter()
    await prepare_tts(s)
    worker = PipelineWorker(Pipeline([emitter, s.prepared_tts, OutputEvidence(s, serializer, "tts"), Output()]),
        params=PipelineParams(audio_out_sample_rate=16000), enable_rtvi=False)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    llm = GatedRealtime(s, SimpleNamespace(turn=Turn(False, number=1)), api_key="unused-injected-socket")
    llm.push_error = AsyncMock()
    llm._websocket = SimpleNamespace(send=AsyncMock(side_effect=OSError("injected closed socket")))
    s.realtime_failure_handler = RealtimeFailureNotice(s, emitter, emitter, serializer, runner)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(started.wait(), 15)
        s.playback.begin()
        s.playback.seal()
        s.playback.generated = True  # Simulate an unfinished old response.
        if args.stt_timeout:
            s.dialogue_mode='controller'
            s.controller=SimpleNamespace(abort=lambda:None,snapshot=lambda:{'synthetic_probe':True})
            llm.stt_timeout=.05;llm.watch_stt(Turn(False,number=1))
            await asyncio.sleep(.1)
        else:await llm._ws_send({"type": "response.create"})
        for _ in range(100):
            await llm._ws_send({"type": "input_audio_buffer.append"})
        await asyncio.wait_for(ended.wait(), 20)
        names = [e["event"] for e in s.evidence.events]
        passed = (audio_bytes > 0 and names.count("realtime_transport_failed") == 1
            and names.index("playback_ended") < names.index("simulated_failure_hangup")
            and "realtime_failure_close_timeout" not in names and s.status == "failed")
        print(json.dumps({"passed": passed, "diagnosticId": "pc-" + s.id, "audioBytes": audio_bytes,
            "socketSendAttempts": llm._websocket.send.await_count, "phoneCalls": 0, "failureReason": s.failure_reason}), flush=True)
        if not passed:
            raise RuntimeError("Injected failure probe did not satisfy playback/close checks")
    finally:
        llm.cancel_stt_watch()
        if llm.failure_task:
            llm.failure_task.cancel()
            await asyncio.gather(llm.failure_task, return_exceptions=True)
        await runner.cancel()
        await asyncio.gather(running, return_exceptions=True)
        s.status = "failed"
        s.finalized = True
        s.evidence.event("session_ended", status="failed", synthetic_probe=True)
        s.persist()


if __name__ == "__main__":
    asyncio.run(main())
