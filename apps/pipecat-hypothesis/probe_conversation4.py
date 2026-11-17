"""Synthetic native Mini/tools + real TTS, simulated phone ACK; no CRM data."""
import asyncio
import json
import os
from uuid import uuid4
import httpx
from diagnostics import TraceArchive
from network import elevenlabs_http_options
from regression_probe import run_case
from test_conversation4 import PROMPT


async def main():
    voice=os.getenv("ELEVENLABS_VOICE_ID")
    if not voice:
        async with httpx.AsyncClient(timeout=20,**elevenlabs_http_options()) as client:
            r=await client.get("https://api.elevenlabs.io/v1/convai/agents/"+os.environ["ELEVENLABS_AGENT_ID"],headers={"xi-api-key":os.environ["ELEVENLABS_API_KEY"]});r.raise_for_status()
            voice=r.json()["conversation_config"]["tts"]["voice_id"]
    prompt="Ты Андрей, покупатель вымышленной Лиры Седан. Коротко задай обязательные вопросы по порядку. Начни с пробега. Не пропускай срок владения. Затем согласуй визит, если предложен.\n"+PROMPT
    source={"configuration":{"prompt":prompt,"businessContext":{},"promptMode":"legacy","speechMode":"fast_sentence"},"voiceId":voice,"ttsModel":"eleven_v4_turbo"}
    scenarios=[
        {"id":"topics_and_colloquial_visit","checks":[],"steps":[{"text":t} for t in (
            "Добрый день, машина продаётся, что хотели уточнить?",
            "Пробег двадцать тысяч километров, в объявлении актуальный.",
            "Пороги целые, без ржавчины.","ДТП не было.","Скидка возможна, обсудим в салоне.",
            "Последний владелец ездил больше года. Приезжайте на осмотр.","Приезжайте завтра в часик четыре, удобно?")]},
        {"id":"ambiguous_clock","checks":[],"steps":[{"text":"Машина в наличии. Приезжайте завтра в часик четыре или в пять, как вам удобно?"}]},
    ]
    archive=TraceArchive();report={"id":"pc4-"+str(uuid4()),"phoneCalls":0,"scope":"synthetic text + real Mini/TTS; playback ACK simulated","cases":[]}
    for scenario in scenarios:
        result=await run_case(source,scenario,"openai_mini",audio_tts=True,reasoning_effort="low")
        record=archive.read(result["diagnosticId"]);memory=record["callState"]
        spoken=[t for step in result.get("steps",[]) for t in step.get("replies",[])]
        checks={"pipeline":result.get("status")!="error" and not result.get("transportErrors"),"audio":result.get("audioBytes",0)>0,
            "reasoningLow":result.get("reasoningConfirmed")=="low"}
        if scenario["id"]=="topics_and_colloquial_visit":
            checks.update(visit=memory.get("closing_reason")=="visit_agreed" and memory.get("facts",{}).get("visit_time",{}).get("value","").lower()=="в часик четыре",
                ownership=any("владел" in t.lower() for t in spoken),
                pendingEmpty=not memory["dialogue_topics"]["pending_required"],hangupAfterAck=result.get("simulatedHangup",False))
        else:
            checks.update(noInventedTime="visit_time" not in memory.get("facts",{}),noHangup=not result.get("finishRequested"))
        report["cases"].append({**result,"callState":memory,"checks":checks,"passed":all(checks.values())})
        path=archive.root/(report["id"]+".json");path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n");path.chmod(0o600)
        print(json.dumps({"id":report["id"],"case":scenario["id"],"diagnosticId":result["diagnosticId"],"checks":checks}),flush=True)


if __name__=="__main__":asyncio.run(main())
