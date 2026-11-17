import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from conversation import ConversationMemory
from pipeline import GatedRealtime, Turn, VoxSerializer, call_context
from policy import Evidence, Playback
from speech_filter import SpeechFilter

PROMPT="""1. Актуальный ли пробег в объявлении? [обязательная тема]
2. Что по порогам, не сильно ли гнилые? [обязательная тема]
3. Были ли ДТП? [обязательная тема]
4. Можете ли сделать скидку? [обязательная тема]
5. Сколько владел автомобилем последний владелец? [обязательная тема]"""


class MemoryTests(unittest.TestCase):
    def test_conversational_clock_preserves_quote_and_supports_atomic_visit(self):
        for when in ("в часик четыре", "в часика четыре", "в часика в четыре", "в четыре"):
            m=ConversationMemory();quote=f"Давайте завтра во второй половине дня. {when.capitalize()} удобно будет?"
            m.user(quote,1)
            self.assertEqual(m.visit_candidates()["visit_time"]["value"].casefold(),when)
            self.assertTrue(m.save_visit()["ok"])
            self.assertIn(m.facts["visit_time"]["value"],quote)
            self.assertEqual(m.facts["visit_time"]["evidence"],quote)

    def test_clock_does_not_invent_24_or_choose_alternatives_or_drop_minutes(self):
        for quote in ("Давайте завтра. Двадцать четыре.","Давайте завтра в часик четыре или в пять?",
                      "Давайте завтра в часик четыре тридцать.","Давайте завтра в 24 часа.",
                      "Давайте завтра в двадцать четыре.","Давайте завтра в часик двадцать пять."):
            m=ConversationMemory();m.user(quote,1)
            self.assertNotIn("visit_time",m.visit_candidates(),quote)
            self.assertFalse(m.save_visit()["ok"])
            self.assertFalse(m.facts)

    def test_answer_closes_routing_topic_without_inventing_crm_facts(self):
        m=ConversationMemory(PROMPT);m.open_question={"text":"Пробег в объявлении актуальный?"}
        m.user("Да, всё верно.",1)
        self.assertEqual(m.topics.answers["mileage"]["evidence"],"Да, всё верно.")
        self.assertFalse(m.facts)
        guard=SpeechFilter(memory=m)
        spoken=guard.feed("Пробег актуальный? А скидку можно?",final=True)
        self.assertEqual(spoken,PROMPT.splitlines()[1].split(". ",1)[1].replace(" [обязательная тема]",""))
        self.assertEqual(spoken.count("?"),1)

    def test_pending_ownership_not_replaced_by_extra_question(self):
        m=ConversationMemory(PROMPT)
        for turn,(question,answer) in enumerate((("Пробег актуальный?","Пробег актуальный."),
            ("Пороги целые?","Пороги целые."),("ДТП были?","Не было."),("Скидку можно?","Да, в салоне.")),1):
            m.open_question={"text":question};m.user(answer,turn)
        self.assertEqual([q["key"] for q in m.topics.pending()],["ownership"])
        spoken=SpeechFilter(memory=m).feed("А скидку можно?",final=True)
        self.assertIn("последний владелец",spoken)

    def test_wait_question_and_unclear_reply_do_not_close_topic(self):
        for text in ("Подождите, я проверю.","Вы за наличные или в кредит?","Не они сильно делают","Цена — сорок тысяч рублей."):
            m=ConversationMemory(PROMPT);m.open_question={"text":"Пробег актуальный?" if "делают" not in text else "Пороги целые?"}
            m.user(text,1)
            self.assertFalse(m.topics.answers,text)

    def test_unknown_answer_keeps_evidence_without_claiming_known_fact(self):
        m=ConversationMemory(PROMPT);m.open_question={"text":"Сколько владел последний владелец?"}
        m.user("Не знаю, нет этой информации.",1)
        self.assertEqual(m.topics.answers["ownership"]["status"],"unknown")
        self.assertFalse(m.facts)

    def test_late_transcript_does_not_rewind_routing_state(self):
        m=ConversationMemory(PROMPT);m.open_question={"text":"Пробег актуальный?"}
        m.user("Пробег актуальный.",3)
        m.user("Я ошибся, пробег неактуальный.",2)
        self.assertEqual(m.topics.answers["mileage"]["turn"],3)

    def test_repeat_name_is_removed_but_direct_name_question_is_answered(self):
        m=ConversationMemory(PROMPT);m.topics.heard("Меня зовут Андрей.",m.name)
        self.assertEqual(SpeechFilter(memory=m).feed("Я Андрей. По порогам есть коррозия?",final=True).strip(),"По порогам есть коррозия?")
        m.user("Как я могу к вам обращаться?",1)
        self.assertEqual(SpeechFilter(memory=m).feed("Я Андрей.",final=True),"Я Андрей.")

    def test_transport_narration_does_not_consume_question_budget(self):
        m=ConversationMemory(PROMPT)
        spoken=SpeechFilter(memory=m).feed("Окей, я уточню момент для визита. Сейчас уточним точное время. Нужно корректно оформить запись? Во сколько удобно приехать?",final=True)
        self.assertEqual(spoken.strip(),"Во сколько удобно приехать?")


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    def call(self):
        s=SimpleNamespace(evidence=Evidence(),playback=Playback(),prompt=PROMPT,context={},status="connected",finalized=False)
        s.evidence.memory=ConversationMemory(PROMPT);s.evidence.turn=s.evidence.output_turn=1
        llm=GatedRealtime(s,SimpleNamespace(turn=Turn(False,number=1)),api_key="test")
        return s,llm

    async def test_empty_stt_never_confirms_semantic_interruption(self):
        for waiting,interrupted,requests in ((True,False,0),(True,True,1),(False,False,0)):
            s,llm=self.call();t=Turn(True,900 if interrupted else 0,number=1);t.interrupted=interrupted
            llm.items["item"]=(t,waiting)
            llm.send_client_event=AsyncMock();llm._handle_interruption=AsyncMock();llm.broadcast_frame=AsyncMock()
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id="item",transcript="  "))
            llm._handle_interruption.assert_not_awaited();llm.broadcast_frame.assert_not_awaited()
            self.assertEqual(llm.send_client_event.await_count,requests)
            self.assertFalse(s.evidence.memory.users)
            self.assertFalse(any(e["event"]=="barge_in_confirmed" for e in s.evidence.events))
            if requests:self.assertEqual(llm.request_reason,"interrupted_audio_without_transcript")

    async def test_introduction_requires_complete_phone_ack(self):
        for cancelled in (True,False):
            s,llm=self.call();v=VoxSerializer(s,SimpleNamespace(send_text=AsyncMock()))
            tag=s.playback.begin();s.playback.seal();v.tag_responses[tag]="r"
            s.evidence.delivery.segment(tag,"r");s.evidence.delivery.response("r").update(generated_done=True,tts_done=True)
            s.evidence.assistant("r","Я Андрей. Пробег актуальный?")
            if cancelled:s.playback.interrupt()
            self.assertFalse(s.evidence.memory.topics.introduced)
            await v.deserialize(json.dumps({"customEvent":"playback","action":"ended","tag":tag}))
            self.assertEqual(s.evidence.memory.topics.introduced,not cancelled)

    async def test_tool_budget_clarifies_only_unknown_visit_time(self):
        s,llm=self.call();llm.push_frame=AsyncMock()
        context=call_context(s,SimpleNamespace(maybe_hangup=AsyncMock()))
        tool=next(w.function for w in context.tools.direct_functions if w.name=="remember_call_fact")
        s.evidence.memory.user("Приезжайте завтра после обеда.",1)
        params=SimpleNamespace(llm=llm,result_callback=AsyncMock())
        for _ in range(2):await tool(params,key="visit_time",value="invented",evidence="wrong")
        await llm.clarification_task
        text=llm.push_frame.call_args.args[0].text
        self.assertIn("Завтра",text);self.assertIn("во сколько",text);self.assertNotIn("в какой день",text)
        self.assertFalse(s.evidence.memory.facts);self.assertFalse(s.playback.finish_requested)

    async def test_tool_repair_text_is_held_before_tool_result(self):
        s,llm=self.call();s.evidence.memory.visit_pending=True
        llm.audit_responses["r"]={"reason":"function_result","turn":1}
        llm.release_speech=AsyncMock()
        await llm._handle_evt_text_delta(SimpleNamespace(response_id="r",delta="Понял, нужно корректно оформить запись.",item_id="i"))
        self.assertIn("r",llm.held_responses);llm.release_speech.assert_not_awaited()
