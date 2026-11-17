"""Synthetic compact/legacy prompt comparison on Mini; no CRM or phone."""
import argparse
import asyncio
import json
import re
import statistics
from uuid import uuid4
from diagnostics import TraceArchive
from regression_probe import run_case
from conversation import adapt_prompt

PROMPT = "Ты Андрей, покупатель вымышленного автомобиля Лира Седан 2024 года. Объявление: пробег 20000 км. Коротко уточни актуальность, затем согласуй визит, если сотрудник предлагает. Если занят — согласись перезвонить в названные день и время. Только русский язык. Один вопрос за реплику."
SCENARIOS = [
    {"id": "visit", "checks": [], "steps": [{"text": "Добрый день. Машина в наличии, пробег актуальный. Приезжайте на осмотр."},
        {"text": "Давайте завтра в первой половине дня часиков в одиннадцать, удобно будет вам?"}, {"text": "Да, отлично, будем вас ждать."}]},
    {"id": "callback", "checks": [], "steps": [{"text": "Алло, добрый день, отдел продаж, слушаю вас."},
        {"text": "Я сейчас занят. Перезвоните, пожалуйста, завтра после десяти утра."}]},
]

async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs",type=int,default=5)
    args=parser.parse_args()
    archive=TraceArchive()
    report={"id":"ppp-"+str(uuid4()),"phoneCalls":0,"mode":"text_tools_only","cases":[],
        "promptChars":{m:len(adapt_prompt(PROMPT,"Андрей",mode=m)) for m in ("legacy","compact")}}
    path=archive.root/(report["id"]+".json")
    for index in range(args.runs):
        for mode in (("legacy","compact") if index%2==0 else ("compact","legacy")):
            for scenario in SCENARIOS:
                source={"configuration":{"prompt":PROMPT,"businessContext":{},"promptMode":mode},"voiceId":"unused","ttsModel":"eleven_v4_turbo"}
                result=await run_case(source,scenario,"openai_mini",reasoning_effort="low")
                data=archive.read(result["diagnosticId"]); facts=data["callState"]["facts"]
                spoken=[t for s in result.get("steps",[]) for t in s["replies"]]
                business=(all(k in facts for k in ("visit_day","visit_time")) if scenario["id"]=="visit"
                    else "завтра" in facts.get("callback",{}).get("value","") and "десяти" in facts.get("callback",{}).get("value",""))
                result.update(promptMode=mode,run=index+1,facts=facts,
                    businessPassed=bool(business and result.get("finishRequested") and result.get("status")!="error"),
                    knownStyleFlags=[t for t in spoken if re.search(r"перейду к|следующий вопрос|Спасибо, Андрей|Музыка|\b(?:day|time)\b",t,re.I)],
                    maxReplyWords=max((len(t.split()) for t in spoken),default=0))
                report["cases"].append(result)
                report["summary"]={}
                for profile in ("legacy","compact"):
                    cases=[c for c in report["cases"] if c["promptMode"]==profile]
                    values=[v for c in cases for v in c.get("ordinaryFirstTextMs",[])]
                    report["summary"][profile]={"attempts":len(cases),"businessPassed":sum(c["businessPassed"] for c in cases),
                        "knownStyleFlagCases":sum(bool(c["knownStyleFlags"]) for c in cases),
                        "firstTextMedianMs":round(statistics.median(values),2) if values else None}
                path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n");path.chmod(0o600)
                print(json.dumps({"id":report["id"],"mode":mode,"scenario":scenario["id"],"run":index+1,
                    "passed":result["businessPassed"],"styleFlags":len(result["knownStyleFlags"])}),flush=True)
    print(json.dumps({"id":report["id"],"summary":report["summary"],"promptChars":report["promptChars"]}),flush=True)

if __name__=="__main__":
    asyncio.run(main())
