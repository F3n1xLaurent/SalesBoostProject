"""Synthetic text/tools/TTS checks for both Realtime models; never places calls."""
import argparse
import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4

import httpx
from diagnostics import TraceArchive
from network import elevenlabs_http_options
from regression_probe import run_case


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["openai", "openai_mini"], required=True)
    parser.add_argument("--audio-tts", action="store_true")
    args = parser.parse_args()
    voice = os.getenv("ELEVENLABS_VOICE_ID")
    if not voice:
        async with httpx.AsyncClient(timeout=20, **elevenlabs_http_options()) as client:
            response = await client.get("https://api.elevenlabs.io/v1/convai/agents/" + os.environ["ELEVENLABS_AGENT_ID"], headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
            response.raise_for_status()
            voice = response.json()["conversation_config"]["tts"]["voice_id"]
    source = {"configuration": {"prompt": "Ты покупатель, звонишь по тестовому автомобилю. Коротко уточни наличие, затем согласуй визит, если сотрудник предлагает. Если занят, согласись перезвонить в названное время. Только русский язык. Один вопрос за раз.", "businessContext": {}},
              "ttsModel": "eleven_v4_turbo", "voiceId": voice}
    scenarios = [
        {"id": "callback", "checks": [], "steps": [{"text": "Алло, добрый день, отдел продаж, слушаю вас."},
            {"text": "Я сейчас занят. Перезвоните, пожалуйста, завтра после десяти утра."}]},
        {"id": "visit_atomic", "checks": [], "steps": [
            {"text": "Добрый день. Автомобиль в наличии, пробег актуальный. Приезжайте посмотреть."},
            {"text": "Давайте завтра во второй половине дня."},
            {"text": "Давайте к шестнадцати ноль ноль."},
            {"text": "Да, всё верно. До свидания."}]},
    ]
    report = {"id": "ptf-" + str(uuid4()), "provider": args.provider, "phoneCallsMade": 0,
              "mode": "text_tools_real_tts_simulated_playback" if args.audio_tts else "text_tools", "cases": []}
    for scenario in scenarios:
        result = await run_case(source, scenario, args.provider, audio_tts=args.audio_tts)
        archive = TraceArchive().read(result["diagnosticId"])
        result["facts"] = archive["callState"]["facts"]
        result["technicalPassed"] = (result.get("status") != "error" and not result.get("transportErrors")
            and result.get("finishRequested", False) and (not args.audio_tts or (result.get("audioBytes", 0) > 0 and result.get("simulatedHangup"))))
        if scenario["id"] == "visit_atomic":
            result["technicalPassed"] &= all(key in result["facts"] for key in ("visit_day", "visit_time"))
        report["cases"].append(result)
        print(json.dumps({"scenario": scenario["id"], "technicalPassed": result["technicalPassed"], "diagnosticId": result["diagnosticId"]}), flush=True)
    report["technicalPassed"] = all(case["technicalPassed"] for case in report["cases"])
    path = TraceArchive().root / (report["id"] + ".json")
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)
    print(json.dumps({"id": report["id"], "path": str(path), "technicalPassed": report["technicalPassed"]}), flush=True)
    if not report["technicalPassed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
