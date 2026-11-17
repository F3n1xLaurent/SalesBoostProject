"""Direct streaming availability probes on synthetic text; no phone/CRM/TTS."""
import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from uuid import uuid4

from dotenv import load_dotenv
from google import genai
from google.genai import types

ROOT = Path(__file__).resolve().parents[2]
PROMPT = "Ты покупатель автомобиля. Ответь по-русски одним коротким предложением на сообщение продавца: «Да, автомобиль ещё в наличии и пробег в объявлении указан верно»."


async def probe(model):
    client = genai.Client(vertexai=False, api_key=os.environ["GEMINI_API_KEY"],
        http_options=types.HttpOptions(timeout=25000, retry_options=types.HttpRetryOptions(attempts=1)))
    thinking = (types.ThinkingConfig(thinking_budget=0) if model.startswith("gemini-2.5-")
                else types.ThinkingConfig(thinking_level="low"))
    result = {"model": model, "status": "error", "text": "", "chunks": 0,
              "thinking": thinking.model_dump(exclude_none=True), "firstTextMs": None}
    started = time.monotonic()
    try:
        async with asyncio.timeout(30):
            stream = await client.aio.models.generate_content_stream(model=model, contents=PROMPT,
                config=types.GenerateContentConfig(max_output_tokens=512, thinking_config=thinking))
            async for chunk in stream:
                if chunk.model_version:
                    result["modelVersion"] = chunk.model_version
                # Count only answer parts, never a model's thought summaries.
                for candidate in chunk.candidates or []:
                    for part in (candidate.content.parts if candidate.content else []) or []:
                        if part.text and not part.thought:
                            if result["firstTextMs"] is None:
                                result["firstTextMs"] = round((time.monotonic() - started) * 1000, 2)
                            result["chunks"] += 1
                            result["text"] += part.text
            result["status"] = "ok" if result["text"].strip() else "empty"
    except Exception as exc:
        message = str(exc)
        for key in ("GEMINI_API_KEY", "GEMINI_PROJECT_NUMBER"):
            if os.getenv(key):
                message = message.replace(os.environ[key], "[redacted]")
        result.update(errorType=type(exc).__name__, httpStatus=getattr(exc, "code", None), message=message[:1500])
    finally:
        result["totalMs"] = round((time.monotonic() - started) * 1000, 2)
        await client.aio.aclose()
    return result


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, default=ROOT / ".env")
    parser.add_argument("--models", nargs="+", default=["gemini-3.7-flash", "gemini-3.6-flash",
        "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    load_dotenv(args.env)
    if not os.getenv("GEMINI_API_KEY"):
        raise SystemExit("Missing GEMINI_API_KEY")
    report = {"id": "pgm-" + str(uuid4()), "startedAt": datetime.now(timezone.utc).isoformat(),
              "provider": "google_direct", "streaming": True, "syntheticOnly": True,
              "scope": "one request per model; availability check, not an audio benchmark or latency median",
              "prompt": PROMPT, "results": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for model in args.models:
        result = await probe(model)
        report["results"].append(result)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        args.output.chmod(0o600)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        await asyncio.sleep(2)
    return 0 if any(r["status"] == "ok" for r in report["results"]) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
