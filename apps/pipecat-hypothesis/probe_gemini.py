"""Real audio -> Gemini STT -> streaming Gemini + tool -> ElevenLabs. No calls."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import time
import wave

from dotenv import load_dotenv
import httpx

from gemini_provider import MODEL, STT_INSTRUCTION, create_gemini_service
from network import elevenlabs_http_options
from pipecat.frames.frames import EndFrame, InputAudioRawFrame, LLMContextFrame, LLMFullResponseEndFrame, LLMRunFrame, LLMTextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.services.llm_service import FunctionCallParams
from pipecat.workers.runner import WorkerRunner


async def stream_and_call_tool(provider):
    measured = {"toolCalled": False, "firstTextMs": None, "text": ""}
    start = time.monotonic()
    answer = "Проверка пройдена. Спасибо, до свидания."

    async def get_probe_context(params: FunctionCallParams):
        """Получить проверочный контекст. Только чтение, без записи в CRM."""
        measured["toolCalled"] = True
        await params.result_callback({"answer": answer})

    context = LLMContext([
        {"role": "system", "content": "Сначала обязательно вызови get_probe_context. Затем ответь в точности текстом поля answer результата функции, без дополнений."},
        {"role": "user", "content": "Получи проверочный контекст и ответь."},
    ], [get_probe_context])
    user, assistant = LLMContextAggregatorPair(context, realtime_service_mode=False)
    llm = create_gemini_service(provider, max_tokens=512)

    class Collector(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if direction == FrameDirection.DOWNSTREAM:
                if isinstance(frame, LLMTextFrame):
                    if measured["firstTextMs"] is None:
                        measured["firstTextMs"] = round((time.monotonic() - start) * 1000, 2)
                    measured["text"] += frame.text
                if isinstance(frame, LLMFullResponseEndFrame) and measured["toolCalled"] and answer in measured["text"]:
                    await worker.queue_frames([EndFrame()])
            await self.push_frame(frame, direction)

    worker = PipelineWorker(Pipeline([user, llm, Collector(), assistant]),
        params=PipelineParams(enable_metrics=True), enable_rtvi=False, processor_unusable_policy=ProcessorUnusablePolicy.END)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await worker.queue_frames([LLMRunFrame()])
    try:
        async with asyncio.timeout(45):
            await runner.run()
    finally:
        await runner.cancel()
    if not measured["toolCalled"] or answer not in measured["text"]:
        raise RuntimeError("Gemini streaming/function calling probe did not complete")
    measured["totalMs"] = round((time.monotonic() - start) * 1000, 2)
    return measured


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", default="../../.env")
    parser.add_argument("--provider", choices=["gemini", "gemini_proxyapi"], default="gemini_proxyapi")
    parser.add_argument("--voice")
    parser.add_argument("--input-wav")
    parser.add_argument("--output")
    args = parser.parse_args()
    load_dotenv(args.env)
    result = {"provider": args.provider, "model": MODEL, "status": "blocked", "phoneCallsMade": 0}
    stage = "voice"
    try:
        root = Path(os.environ.get("PIPECAT_LOG_DIR", "../../storage/pipecat-hypothesis"))
        root.mkdir(parents=True, exist_ok=True)
        voice = args.voice or os.environ.get("ELEVENLABS_VOICE_ID")
        if not voice:
            async with httpx.AsyncClient(timeout=15, **elevenlabs_http_options()) as client:
                response = await client.get("https://api.elevenlabs.io/v1/convai/agents/" + os.environ["ELEVENLABS_AGENT_ID"],
                    headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
                response.raise_for_status()
                voice = response.json()["conversation_config"]["tts"]["voice_id"]
        fixture = Path(args.input_wav) if args.input_wav else root / "gemini-probe-input.wav"
        from pipeline import probe_tts_service
        if not args.input_wav and not fixture.exists():
            stage = "fixture_tts"
            result["inputFixtureTts"] = await probe_tts_service("eleven_v4_turbo", voice, audio_path=fixture)
        with wave.open(str(fixture)) as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise ValueError("Probe fixture must be PCM16 mono 16000 Hz")
            audio = wav.readframes(wav.getnframes())
        stage = "audio_stt"
        stt = create_gemini_service(args.provider, max_tokens=512)
        try:
            context = LLMContext([{"role": "system", "content": STT_INSTRUCTION}])
            await context.add_audio_frames_message(audio_frames=[InputAudioRawFrame(audio, 16000, 1)])
            start = time.monotonic()
            text = (await stt.run_inference(context) or "").strip()
            result["stt"] = {"text": text, "requestMs": round((time.monotonic() - start) * 1000, 2)}
            if not text or (not args.input_wav and not all(word in text.lower() for word in ("голос", "задерж"))):
                raise RuntimeError("Audio transcription did not match the synthetic fixture")
        finally:
            await stt.cleanup()
        stage = "streaming_and_function_call"
        result["llm"] = await stream_and_call_tool(args.provider)
        stage = "output_tts"
        result["outputTts"] = await probe_tts_service("eleven_v4_turbo", voice, text=result["llm"]["text"])
        result["status"] = "passed"
    except Exception as exc:
        result["failedStage"] = stage
        result["reason"] = type(exc).__name__
        if isinstance(exc, httpx.HTTPStatusError):
            result["httpStatus"] = exc.response.status_code
    output = json.dumps(result, ensure_ascii=False, indent=2)
    print(output)
    if args.output:
        Path(args.output).write_text(output + "\n")


if __name__ == "__main__":
    asyncio.run(main())
