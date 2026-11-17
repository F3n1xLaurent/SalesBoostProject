"""Isolated text latency experiment: real demo plan, fixed matched histories.

No phone, TTS, CRM writes or live hypothesis changes. Tools advertised but never
executed. A deterministic demo-specific state manager adds no second LLM call.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import time
from types import SimpleNamespace
from uuid import uuid4

from websockets.asyncio.client import connect
from conversation import ConversationMemory, legacy_adapt_prompt
from pipeline import call_context
from service import Session
from speech_filter import SpeechFilter

MODEL = "gpt-realtime-2.1-mini"
# Same completed history at every paired turn; generated outputs are recorded
# for review, not fed into the next turn. This is teacher forcing, not a dialog eval.
STEPS = [
    ("opening", "Добрый день, отдел продаж, слушаю вас.", "Здравствуйте! Лира Седан ещё продаётся?"),
    ("mileage", "Да, машина в наличии, продаётся.", "Актуальный ли пробег в объявлении?"),
    ("rust", "Пробег двадцать тысяч километров, в объявлении актуальный.", "Что по порогам, не сильно ли гнилые?"),
    ("accidents", "Пороги целые, без ржавчины, проверяли на подъёмнике.", "Были ли ДТП?"),
    ("discount", "ДТП не было, кузов без серьёзных повреждений.", "Цена высокая, можно ли сделать скидку?"),
    ("ownership", "Скидку обсудим в салоне, максимум десять тысяч рублей.", "Сколько владел автомобилем последний владелец?"),
    ("spare", "Последний владелец ездил на ней больше года.", "Есть ли запаска, запасное колесо?"),
    ("remote", "Да, запасное колесо есть в багажнике.", "Не хочу ехать из другого города, хочу всё обсудить по телефону."),
    ("visit", "Понимаю, но не всё можно обсудить по телефону, лучше посмотреть лично. Приезжайте.", "В какой день и во сколько можно приехать?"),
    ("close", "Давайте завтра в одиннадцать, удобно будет вам?", None),
]


class DemoStateManager:
    """Local finite-state prototype, restricted to explicitly recognized answers.

    No hidden future utterances, expected replies or expected state IDs supplied
    to update(). A general semantic state extractor is outside this speed probe.
    """
    def __init__(self, fixture):
        self.fixture = fixture
        self.done = set()
        self.latest = ""
        self.rules = [
            ("availability", r"машина в наличии|прода[её]тся"),
            ("mileage", r"пробег.{0,90}актуальн"),
            ("rust", r"пороги.{0,70}(?:целые|ржавчин)"),
            ("accidents", r"дтп.{0,25}(?:не было|были)"),
            ("discount", r"скидк[ау].{0,90}(?:тысяч|рубл|нет|невозмож)"),
            ("ownership", r"владелец.{0,60}(?:год|месяц)"),
            ("spare", r"запасное колесо.{0,35}(?:есть|нет)"),
            ("remote", r"не вс[её] можно обсудить по телефону"),
        ]

    def update(self, text):
        self.latest = text
        for key, pattern in self.rules:
            if re.search(pattern, text, re.I):
                self.done.add(key)

    def next_instruction(self):
        questions = self.fixture["questions"]
        objections = self.fixture["objections"]
        tasks = [
            ("availability", "opening", "Один раз поздоровайся, назови Лира Седан и спроси, продаётся ли машина."),
            ("mileage", "mileage", questions[0]["text"]),
            ("rust", "rust", questions[1]["text"]),
            ("accidents", "accidents", questions[2]["text"]),
            ("discount", "discount", questions[3]["text"] + " " + objections[0]["phrase"]),
            ("ownership", "ownership", questions[4]["text"]),
            ("spare", "spare", objections[1]["phrase"]),
            ("remote", "remote", objections[2]["phrase"]),
        ]
        if re.search(r"давайте завтра в одиннадцать", self.latest, re.I):
            return "close", ('Прими предложенный визит. Только вызови prepare_end_call с reason=visit_agreed, '
                'visit_day="завтра", visit_time="в одиннадцать", обе evidence — точная последняя цитата сотрудника. Не произноси прощание сам.')
        for key, stage, task in tasks:
            if key not in self.done:
                return stage, "Следующая реплика: " + task
        return "visit", "Сотрудник приглашает на осмотр. Спроси, в какой день и во сколько можно приехать."

    def base(self):
        return ("Ты Андрей, покупатель, который сам звонит менеджеру. Только русский язык. "
            "Имя менеджера неизвестно. Говори естественно: короткая реакция и один вопрос, без служебных пояснений. "
            "Выполни только текущую задачу NEXT_TURN, не выбирай другие темы. "
            "Не придумывай факты. Не повторяй приветствие и название машины после знакомства. "
            "Вызовы инструментов только по схеме, значения и evidence дословно из слов менеджера. "
            "Для визита нужны день и время; общим завершением их не обходи. Backend озвучивает прощание. "
            "При просьбе подождать молчи; после паузы продолжай последний вопрос. "
            "Контекст: " + self.fixture["context"] + "\nПрофиль: " + json.dumps(self.fixture["profile"], ensure_ascii=False) +
            "\nОбъект: Лира Седан 2024, автомат, пробег 20000 км, цена 1500000 рублей. Компания: Тестовый автосалон.")


def message(role, text):
    return {"type": "message", "role": role, "content": [{"type": "output_text" if role == "assistant" else "input_text", "text": text}]}


async def recv_until(socket, kind):
    while True:
        row = json.loads(await asyncio.wait_for(socket.recv(), 30))
        if row["type"] == "error":
            raise RuntimeError(json.dumps(row["error"]))
        if row["type"] == kind:
            return row


async def one(fixture, mode, run, tools, records):
    state = DemoStateManager(fixture)
    memory = ConversationMemory(fixture["prompt"])
    base = legacy_adapt_prompt(fixture["prompt"], "Андрей") if mode == "fixed" else state.base()
    rows, history = [], []
    async with connect("wss://api.openai.com/v1/realtime?model=" + MODEL,
        additional_headers={"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]}, open_timeout=15) as socket:
        await recv_until(socket, "session.created")
        await socket.send(json.dumps({"type": "session.update", "session": {
            "type": "realtime", "instructions": base, "output_modalities": ["text"],
            "reasoning": {"effort": "low"}, "tools": tools,
            "audio": {"input": {"turn_detection": None}}}}))
        confirmed = (await recv_until(socket, "session.updated"))["session"]
        if confirmed.get("reasoning", {}).get("effort") != "low":
            raise RuntimeError("Provider did not confirm low")
        for index, (expected, text, canonical) in enumerate(STEPS):
            origin = time.perf_counter()
            memory.user(text, index + 1)
            state.update(text)
            stage, instruction = state.next_instruction()
            if stage != expected:
                raise RuntimeError("State fixture mismatch: " + stage + " != " + expected)
            extra = memory.context_text()
            if mode == "dsm":
                extra += "\nNEXT_TURN\n" + instruction + "\nЗакрытые темы: " + ", ".join(sorted(state.done))
            prep_ms = (time.perf_counter() - origin) * 1000
            # Full matched history + current CALL_STATE. No generated output is
            # appended: this prevents response drift changing later A/B inputs.
            inputs = history + [message("system", extra), message("user", text)]
            sent = time.perf_counter()
            await socket.send(json.dumps({"type": "response.create", "response": {
                "conversation": "none", "input": inputs, "output_modalities": ["text"]}}, ensure_ascii=False))
            result = {"mode": mode, "run": run, "stage": expected, "turn": index + 1,
                "preparationMs": round(prep_ms, 3), "instructionChars": len(base) + len(extra),
                "historySha256": hashlib.sha256(json.dumps(history, ensure_ascii=False).encode()).hexdigest(),
                "input": text, "text": "", "firstTextMs": None, "firstSentenceMs": None, "firstActionMs": None}
            guard = SpeechFilter()
            async with asyncio.timeout(35):
                while True:
                    evt = json.loads(await socket.recv())
                    kind = evt["type"]
                    now = time.perf_counter()
                    elapsed = round((now - origin) * 1000, 2)
                    if kind == "error":
                        raise RuntimeError(json.dumps(evt["error"]))
                    if kind in ("response.output_text.delta", "response.text.delta"):
                        result["text"] += evt["delta"]
                        if result["firstTextMs"] is None:
                            result["firstTextMs"] = elapsed
                            result["requestToFirstTextMs"] = round((now - sent) * 1000, 2)
                        if guard.feed(evt["delta"]).strip() and result["firstSentenceMs"] is None:
                            result["firstSentenceMs"] = elapsed
                    if kind == "response.function_call_arguments.delta" and result["firstActionMs"] is None:
                        result["firstActionMs"] = elapsed
                    if kind == "response.done":
                        response = evt["response"]
                        result.update(status=response["status"], totalMs=elapsed,
                            usage=response.get("usage"), output=response.get("output"))
                        if guard.feed(final=True).strip() and result["firstSentenceMs"] is None:
                            result["firstSentenceMs"] = elapsed
                        break
            rows.append(result)
            records.append(result)
            print(json.dumps({k:result[k] for k in ("mode","run","stage","status","firstTextMs","firstSentenceMs","totalMs")}), flush=True)
            history.append(message("user", text))
            if canonical:
                history.append(message("assistant", canonical))
                # Same ACKed prior question for both variants.
                memory.open_question = {"text": canonical, "response_id": "canonical-" + str(index)}
    return rows


def summarize(rows):
    result = {}
    for mode in ("fixed", "dsm"):
        ordinary = [r for r in rows if r["mode"] == mode and r["stage"] != "close" and r.get("status") == "completed"]
        result[mode] = {"completedOrdinaryTurns": len(ordinary)}
        for key in ("firstTextMs", "firstSentenceMs", "totalMs", "preparationMs", "instructionChars"):
            vals = [r[key] for r in ordinary if r.get(key) is not None]
            result[mode][key + "Median"] = round(statistics.median(vals), 2) if vals else None
        result[mode]["byStage"] = {}
        for stage, _, _ in STEPS:
            cases = [r for r in rows if r["mode"] == mode and r["stage"] == stage]
            vals = [r["firstSentenceMs"] for r in cases if r.get("firstSentenceMs") is not None and r.get("status") == "completed"]
            result[mode]["byStage"][stage] = {"attempts":len(cases), "withSentence":len(vals),
                "firstSentenceMedianMs": round(statistics.median(vals), 2) if vals else None}
        usage = [r["usage"] for r in ordinary if r.get("usage")]
        result[mode]["inputTokens"] = sum(u.get("input_tokens",0) for u in usage)
        result[mode]["cachedTokens"] = sum(u.get("input_token_details",{}).get("cached_tokens",0) for u in usage)
        result[mode]["perRun"] = []
        for run in sorted({r["run"] for r in rows if r["mode"] == mode}):
            cases = [r for r in ordinary if r["run"] == run]
            entry = {"run": run, "ordinaryTurns": len(cases)}
            for key in ("firstTextMs", "firstSentenceMs", "totalMs"):
                vals = [r[key] for r in cases if r.get(key) is not None]
                entry[key + "Median"] = round(statistics.median(vals), 2) if vals else None
            result[mode]["perRun"].append(entry)
        complete_runs = [r for r in result[mode]["perRun"] if r["ordinaryTurns"] == len(STEPS)-1 and r["firstSentenceMsMedian"] is not None]
        result[mode]["completeRuns"] = len(complete_runs)
        result[mode]["medianOfRunSentenceMediansMs"] = (round(statistics.median(r["firstSentenceMsMedian"] for r in complete_runs), 2) if complete_runs else None)
    return result


async def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fixture", required=True)
    p.add_argument("--runs", type=int, default=5)
    args = p.parse_args()
    if not 1 <= args.runs <= 10: p.error("runs must be 1..10")
    fixture = json.loads(Path(args.fixture).read_text())
    # The state compiler uses this plan's actual structured topics, fail closed
    # if authors change its structure rather than silently benchmark another plan.
    if len(fixture["questions"]) != 5 or len(fixture["objections"]) != 3:
        raise ValueError("Demo compiler expects five questions and three objections")
    session = Session(id=str(uuid4()),provider="openai_mini",tts_model="eleven_v4_turbo",voice_id="unused",prompt=fixture["prompt"],context={},to="")
    context = call_context(session, SimpleNamespace())
    tools = [{"type":"function", **s.to_default_dict()} for s in context.tools.standard_tools]
    report = {"id":"dsm-"+str(uuid4()),"model":MODEL,"reasoning":"low","planName":fixture["planName"],
        "scope":"text-only matched-history teacher forcing; local demo-specific FSM; no phone/STT/TTS or tool execution",
        "fixtureSha256":hashlib.sha256(Path(args.fixture).read_bytes()).hexdigest(),"toolCount":len(tools),"cases":[],"errors":[]}
    path = Path(os.getenv("PIPECAT_LOG_DIR","/tmp")) / (report["id"]+".json")
    for index in range(args.runs):
        for mode in (("fixed","dsm") if index%2==0 else ("dsm","fixed")):
            try: await one(fixture,mode,index+1,tools,report["cases"])
            except Exception as exc:
                report["errors"].append({"mode":mode,"run":index+1,"error":type(exc).__name__,"message":str(exc)[:1000]})
                print(json.dumps(report["errors"][-1]),flush=True)
            report["summary"]=summarize(report["cases"])
            path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n"); path.chmod(0o600)
    print(json.dumps({"id":report["id"],"summary":report["summary"],"errors":report["errors"]},ensure_ascii=False),flush=True)


if __name__ == "__main__": asyncio.run(main())
