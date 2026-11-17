"""Balanced one-pass Pipecat/audio Gemini comparison; synthetic input only."""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time
from uuid import uuid4

from dotenv import load_dotenv
from benchmark_turns import ROOT, fixture, run_one, summarize


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, default=ROOT / ".env")
    parser.add_argument("--input-wav", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--interval", type=float, default=15)
    parser.add_argument("--models", nargs="+", default=["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])
    args = parser.parse_args()
    if args.runs < 1 or args.interval < 0:
        parser.error("runs must be positive and interval nonnegative")
    load_dotenv(args.env)
    if not os.getenv("GEMINI_API_KEY"):
        raise SystemExit("Missing GEMINI_API_KEY")
    models = list(dict.fromkeys(args.models))
    pcm, acoustic_end = fixture(args.input_wav)
    report = {"id": "pcba-" + str(uuid4()), "startedAt": datetime.now(timezone.utc).isoformat(),
        "fixtureSha256": hashlib.sha256(pcm).hexdigest(), "provider": "gemini_direct",
        "inputMode": "one_pass_audio_after_silero_smart_turn", "streamingOutput": True,
        "thinking": "low", "models": models, "intervalSeconds": args.interval,
        "scope": "synthetic paced audio to first text; excludes TTS/telephony; no separate STT call; fresh connections; short shared prompt",
        "runs": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    previous = None
    for index in range(args.runs):
        order = models[index % len(models):] + models[:index % len(models)]
        for model in order:
            if previous is not None:
                while (delay := args.interval - (time.monotonic() - previous)) > 0:
                    await asyncio.sleep(min(30, delay))
            previous = time.monotonic()
            try:
                row = await run_one("gemini_audio", pcm, acoustic_end, gemini_provider="gemini", gemini_model=model)
            except Exception as exc:
                row = {"status": "error", "errorType": type(exc).__name__, "httpStatus": getattr(exc, "code", None)}
            row.update(variant=model, mechanic="gemini_audio", run=index + 1)
            report["runs"].append(row)
            report["summary"] = summarize(report["runs"], models)
            report["updatedAt"] = datetime.now(timezone.utc).isoformat()
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            args.output.chmod(0o600)
            print(json.dumps({"model": model, "run": index + 1, "status": row["status"],
                "endToFirstTextMs": row.get("endToFirstTextMs")}), flush=True)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    return 0 if all(r["status"] == "measured" for r in report["runs"]) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
