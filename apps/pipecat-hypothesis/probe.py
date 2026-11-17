"""Probe providers without dialing. Emits JSON evidence; never prints API keys."""
import argparse
import asyncio
import json
import os
from pathlib import Path
from dotenv import load_dotenv
from fastapi import HTTPException
import httpx
from policy import PROVIDERS, TTS_MODELS
from service import Options, check_compatibility
from network import elevenlabs_http_options


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", default="../../.env")
    parser.add_argument("--provider", choices=list(PROVIDERS), default="openai")
    parser.add_argument("--tts", choices=["all", *TTS_MODELS], default="all")
    parser.add_argument("--voice")
    parser.add_argument("--output")
    parser.add_argument("--tts-only", action="store_true", help="Probe ElevenLabs independently of LLM connectivity")
    parser.add_argument("--pipecat-tts", action="store_true", help="Also synthesize through the real Pipecat service and worker")
    args = parser.parse_args()
    load_dotenv(args.env)
    voice = args.voice or os.environ.get("ELEVENLABS_VOICE_ID", "")
    setup_error = None
    if not voice and os.environ.get("ELEVENLABS_AGENT_ID") and os.environ.get("ELEVENLABS_API_KEY"):
        try:
            async with httpx.AsyncClient(timeout=15, **elevenlabs_http_options()) as client:
                response = await client.get("https://api.elevenlabs.io/v1/convai/agents/" + os.environ["ELEVENLABS_AGENT_ID"],
                    headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
                response.raise_for_status()
                voice = response.json().get("conversation_config", {}).get("tts", {}).get("voice_id", "")
        except Exception as exc:
            setup_error = "Resolve current Agent voice: " + type(exc).__name__
    if not voice and not setup_error:
        raise SystemExit("Set ELEVENLABS_VOICE_ID or --voice (no phone call is made)")
    results = []
    for model in TTS_MODELS if args.tts == "all" else [args.tts]:
        try:
            if setup_error:
                raise HTTPException(503, setup_error)
            async with asyncio.timeout(60):
                result = await check_compatibility(Options(provider=args.provider, ttsModel=model, voiceId=voice), synthesize=True, provider_check=not args.tts_only)
                if args.pipecat_tts:
                    from pipeline import probe_tts_service
                    result["pipecatTts"] = await probe_tts_service(model, voice)
            results.append({"status": "passed", **result})
        except Exception as exc:
            reason = exc.detail if isinstance(exc, HTTPException) else f"HTTP {exc.response.status_code}" if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__
            results.append({"status": "blocked", "provider": args.provider, "ttsModel": model, "reason": reason})
    output = json.dumps({"checks": results, "phoneCallsMade": 0}, ensure_ascii=False, indent=2)
    print(output)
    if args.output:
        Path(args.output).write_text(output + "\n")


if __name__ == "__main__":
    asyncio.run(main())
