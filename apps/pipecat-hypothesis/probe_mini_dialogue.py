"""Balanced low/minimal Mini probes with synthetic visits and callbacks only."""
import argparse
import asyncio
import json
import os
import re
import statistics
from uuid import uuid4

import httpx
from diagnostics import TraceArchive
from network import elevenlabs_http_options
from regression_probe import run_case

SCENARIOS = [
    {"id": "visit_confirmation", "checks": [], "steps": [
        {"text": "Добрый день, машина в наличии, всё из объявления актуально. Приезжайте на осмотр."},
        {"text": "Давайте завтра в первой половине дня часиков в одиннадцать, удобно будет вам?"},
        {"text": "Да, отлично, будем вас ждать."}]},
    {"id": "callback", "checks": [], "steps": [
        {"text": "Алло, добрый день, отдел продаж, слушаю вас."},
        {"text": "Я сейчас занят. Перезвоните, пожалуйста, завтра после десяти утра."}]},
]


def evaluate(result, archive, audio):
    facts = archive["callState"]["facts"]
    reason = archive["callState"]["closing_reason"]
    checks = {"pipeline": result.get("status") != "error" and not result.get("transportErrors"),
        "finished": bool(result.get("finishRequested")),
        "reasoning": result.get("reasoningConfirmed") == result.get("reasoningEffort")}
    if audio:
        checks["tts_and_simulated_hangup"] = result.get("audioBytes", 0) > 0 and result.get("simulatedHangup", False)
    if result["scenarioId"] == "visit_confirmation":
        checks["visit"] = (reason == "visit_agreed" and facts.get("visit_day", {}).get("value") == "завтра"
            and "одиннадцать" in facts.get("visit_time", {}).get("value", ""))
    else:
        value = facts.get("callback", {}).get("value", "")
        checks["callback"] = reason == "callback_requested" and "завтра" in value and "десяти" in value
    spoken = [text for step in result.get("steps", []) for text in step.get("replies", [])]
    checks["no_known_narration"] = not any(re.search(r"перейду к|следующий вопрос|сейчас зафиксирую|молчание", t, re.I) for t in spoken)
    checks["no_wrong_addressee"] = not any(re.search(r"(?:^|[.!?]\s*)Андрей[,!]|спасибо[,!]\s*Андрей", t, re.I) for t in spoken)
    checks["no_spoken_field_names"] = not any(re.search(r"\b(?:day|time|prepare_end_call|CALL_STATE)\b", t, re.I) for t in spoken)
    closes = [e for e in archive["events"] if e["event"] == "closing_decision" and e.get("result", {}).get("ok")]
    close_latencies = []
    for close in closes:
        request = next((e for e in archive["events"] if e["event"] == "response_requested"
            and e.get("turn") == close.get("turn") and e.get("reason") == "text_regression_input" and e["ms"] < close["ms"]), None)
        if request:
            close_latencies.append(round(close["ms"] - request["ms"], 2))
    return {**result, "facts": facts, "closingReason": reason, "technicalChecks": checks,
        "technicalPassed": all(checks.values()), "requestToAcceptedCloseMs": close_latencies,
        "reasoningTokens": [e["response"].get("usage", {}).get("output_token_details", {}).get("reasoning_tokens")
            for e in archive["events"] if e["event"] == "provider_response_done"]}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--audio-tts", action="store_true")
    parser.add_argument("--efforts", nargs="+", choices=["low", "minimal"], default=["low", "minimal"])
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("runs must be positive")
    voice = os.getenv("ELEVENLABS_VOICE_ID")
    if not voice:
        async with httpx.AsyncClient(timeout=20, **elevenlabs_http_options()) as client:
            response = await client.get("https://api.elevenlabs.io/v1/convai/agents/" + os.environ["ELEVENLABS_AGENT_ID"], headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
            response.raise_for_status()
            voice = response.json()["conversation_config"]["tts"]["voice_id"]
    source = {"configuration": {"prompt": "Ты Андрей, покупатель тестового автомобиля. Коротко уточни актуальность, затем согласуй визит, если сотрудник предлагает. Если занят — согласись перезвонить в названные день и время. Только русский язык. Один вопрос за раз.", "businessContext": {}},
        "ttsModel": "eleven_v4_turbo", "voiceId": voice}
    report = {"id": "pmd-" + str(uuid4()), "phoneCallsMade": 0, "syntheticOnly": True,
        "mode": "text_tools_real_tts_simulated_playback" if args.audio_tts else "text_tools",
        "scope": "five attempts per effort per scenario; no live audio/VAD/phone latency; semantic quality needs review", "cases": []}
    archive = TraceArchive()
    path = archive.root / (report["id"] + ".json")
    efforts = list(dict.fromkeys(args.efforts))
    for index in range(args.runs):
        order = efforts[index % len(efforts):] + efforts[:index % len(efforts)]
        for effort in order:
            for scenario in SCENARIOS:
                result = await run_case(source, scenario, "openai_mini", audio_tts=args.audio_tts, reasoning_effort=effort)
                result = evaluate(result, archive.read(result["diagnosticId"]), args.audio_tts)
                result["run"] = index + 1
                report["cases"].append(result)
                report["summary"] = {}
                for level in efforts:
                    report["summary"][level] = {}
                    for item in SCENARIOS:
                        cases = [c for c in report["cases"] if c["reasoningEffort"] == level and c["scenarioId"] == item["id"]]
                        values = [v for c in cases if c["technicalPassed"] for v in c["requestToAcceptedCloseMs"]]
                        texts = [v for c in cases if c["technicalPassed"] for v in c.get("ordinaryFirstTextMs", [])]
                        report["summary"][level][item["id"]] = {"attempts": len(cases), "passed": sum(c["technicalPassed"] for c in cases),
                            "requestToAcceptedCloseMedianMs": round(statistics.median(values), 2) if values else None,
                            "ordinaryFirstTextMedianMs": round(statistics.median(texts), 2) if texts else None}
                path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
                path.chmod(0o600)
                print(json.dumps({"id": report["id"], "effort": effort, "scenario": scenario["id"], "run": index + 1,
                    "passed": result["technicalPassed"], "checks": result["technicalChecks"], "diagnosticId": result["diagnosticId"]}), flush=True)
    print(json.dumps({"id": report["id"], "path": str(path), "summary": report["summary"]}), flush=True)
    return 0 if all(c["technicalPassed"] for c in report["cases"]) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
