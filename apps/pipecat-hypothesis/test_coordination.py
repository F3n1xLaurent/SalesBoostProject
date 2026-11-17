import asyncio
import base64
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from conversation import ConversationMemory
from pipeline import GatedRealtime, Turn, validated_tool, call_context
from policy import Evidence, Playback
from speech_filter import SpeechFilter
from pipecat.frames.frames import InputAudioRawFrame
from pipecat.services.openai.realtime import events


class CoordinationTests(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_tool_argument_returns_correction_without_executing(self):
        callback = AsyncMock()
        llm = self.llm()
        params = SimpleNamespace(result_callback=callback, llm=llm)
        called = []

        @validated_tool
        async def tool(params, reason: str, callback_time: str = ""):
            called.append(reason)

        await tool(params, reason="callback_requested", callback="завтра")
        self.assertFalse(called)
        result = callback.call_args.args[0]
        self.assertFalse(result["ok"])
        self.assertIn("callback_time", result["allowed_fields"])
        self.assertEqual(llm.session.evidence.events[-1]["event"], "tool_arguments_rejected")

    def llm(self):
        session = SimpleNamespace(evidence=Evidence(), playback=Playback())
        return GatedRealtime(session, SimpleNamespace(turn=Turn(False, number=1)), api_key="test")

    async def finish(self, llm, identifier):
        response = SimpleNamespace(id=identifier, output=[], status="completed", model_dump=lambda **kw: {"id": identifier})
        with patch.object(GatedRealtime.__bases__[0], "_handle_evt_response_done", new=AsyncMock()):
            await llm._handle_evt_response_done(SimpleNamespace(response=response))

    async def test_parallel_creates_wait_for_provider_done_and_keep_correct_audit(self):
        llm = self.llm()
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as sent:
            await asyncio.gather(llm.send_client_event(events.ResponseCreateEvent()), llm.send_client_event(events.ResponseCreateEvent()))
            self.assertEqual(sum(c.args[0].type == "response.create" for c in sent.call_args_list), 1)
            await llm._handle_evt_response_created(SimpleNamespace(response=SimpleNamespace(id="one")))
            self.assertEqual(llm.audit_responses["one"]["request_id"], "req-1")
            await self.finish(llm, "one")
            self.assertEqual(sum(c.args[0].type == "response.create" for c in sent.call_args_list), 2)
            await llm._handle_evt_response_created(SimpleNamespace(response=SimpleNamespace(id="two")))
            self.assertEqual(llm.audit_responses["two"]["request_id"], "req-2")

    async def test_cancel_before_created_waits_and_does_not_send_next_create_early(self):
        llm = self.llm()
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as sent:
            await llm.send_client_event(events.ResponseCreateEvent())
            await llm.send_client_event(events.ResponseCancelEvent())
            await llm.send_client_event(events.ResponseCreateEvent())
            self.assertFalse(any(c.args[0].type == "response.cancel" for c in sent.call_args_list))
            await llm._handle_evt_response_created(SimpleNamespace(response=SimpleNamespace(id="old")))
            self.assertEqual(sum(c.args[0].type == "response.cancel" for c in sent.call_args_list), 1)
            self.assertEqual(sum(c.args[0].type == "response.create" for c in sent.call_args_list), 1)
            await self.finish(llm, "old")
            self.assertEqual(sum(c.args[0].type == "response.create" for c in sent.call_args_list), 2)

    async def test_rejected_request_does_not_shift_the_next_response(self):
        llm = self.llm()
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()):
            request = events.ResponseCreateEvent()
            await llm.send_client_event(request)
            await llm.reject_response(SimpleNamespace(error=SimpleNamespace(event_id=request.event_id, code="invalid_request_error")))
            self.assertFalse(llm.audit_pending)
            await llm.send_client_event(events.ResponseCreateEvent())
            await llm._handle_evt_response_created(SimpleNamespace(response=SimpleNamespace(id="accepted")))
            self.assertEqual(llm.audit_responses["accepted"]["request_id"], "req-2")

    async def test_late_short_transcript_does_not_interrupt_or_answer_during_next_turn(self):
        llm = self.llm()
        llm.items["old"] = (Turn(True, 300, number=1), True)
        llm.monitor.turn = Turn(False, number=2)
        llm.user_speaking = True
        llm._handle_interruption = AsyncMock()
        with patch.object(GatedRealtime.__bases__[0], "handle_evt_input_audio_transcription_completed", new=AsyncMock()), patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as sent:
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id="old", transcript="Давайте"))
            llm._handle_interruption.assert_not_awaited()
            self.assertFalse(any(c.args[0].type == "response.create" for c in sent.call_args_list))

    async def test_new_speech_cancels_prefix_clarification(self):
        llm = self.llm()
        llm.items["prefix"] = (Turn(False, 300, number=1), True)
        with patch.object(GatedRealtime.__bases__[0], "handle_evt_input_audio_transcription_completed", new=AsyncMock()), patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as sent:
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id="prefix", transcript="Давайте"))
            task = llm.continuation_task
            self.assertIsNotNone(task)
            llm.monitor.turn = Turn(False, number=2)
            await llm._handle_user_started_speaking(None)
            await asyncio.gather(task, return_exceptions=True)
            self.assertFalse(any(c.args[0].type == "response.create" for c in sent.call_args_list))

    async def test_preroll_replays_only_new_audio_even_with_idle_trim_disabled(self):
        llm = self.llm()
        old, new = b"\x11\x11" * 2400, b"\x22\x22" * 1200
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as sent:
            await llm._send_user_audio(InputAudioRawFrame(old, 24000, 1))
            await llm.send_client_event(events.InputAudioBufferCommitEvent())
            self.assertFalse(llm._user_audio_preroll_buffer)
            await llm._send_user_audio(InputAudioRawFrame(new, 24000, 1))
            await llm._replay_user_audio_preroll()
            self.assertEqual(base64.b64decode(sent.call_args.args[0].audio), new)

    async def test_empty_greeting_recovery_is_once_and_not_for_ivr(self):
        llm = self.llm()
        llm.response_id = "empty"
        llm.finalized_responses.add("empty")
        llm.session.evidence.memory.user("Здравствуйте, дождитесь ответа оператора.", 1)
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as sent:
            await llm.recover_first_greeting()
            self.assertFalse(sent.called)
            llm.session.evidence.memory.users = [{"text": "Алло?", "turn": 1}]
            await llm.recover_first_greeting()
            await llm.recover_first_greeting()
            self.assertEqual(sum(c.args[0].type == "response.create" for c in sent.call_args_list), 1)


class VisitAndSpeechTests(unittest.TestCase):
    def test_saved_fact_cannot_survive_new_ambiguous_or_partial_clock_offer(self):
        for newer in ("Давайте завтра в одиннадцать тридцать.", "Давайте завтра в одиннадцать или в четырнадцать, удобно вам?"):
            memory = ConversationMemory()
            memory.user("Приезжайте завтра в десять.", 1)
            self.assertTrue(memory.save_visit()["ok"])
            memory.user(newer, 2)
            self.assertFalse(memory.save_visit()["ok"])
            self.assertNotIn("visit_time", memory.facts)

    def test_price_question_does_not_start_visit_and_minutes_are_not_truncated(self):
        memory = ConversationMemory()
        memory.open_question = {"text": "Во сколько обойдётся ремонт?"}
        memory.user("В сто тысяч рублей.", 1)
        self.assertFalse(memory.visit_pending)
        self.assertTrue(memory.prepare_close("conversation_complete")["ok"])
        memory = ConversationMemory()
        memory.user("Приезжайте завтра в одиннадцать тридцать.", 1)
        self.assertNotIn("visit_time", memory.visit_candidates())
        self.assertFalse(memory.save_visit()["ok"])

    def test_concrete_offer_with_confirmation_question_cannot_bypass_visit_guard(self):
        memory = ConversationMemory()
        memory.open_question = {"text": "Сегодня или завтра вам удобнее, чтобы назначить встречу?"}
        memory.user("Давайте завтра в первой половине дня часиков в одиннадцать, удобно будет вам?", 1)
        self.assertTrue(memory.visit_pending)
        self.assertEqual(memory.visit_candidates()["visit_time"]["value"], "в одиннадцать")
        memory.user("Да, отлично, будем вас ждать.", 2)
        self.assertFalse(memory.prepare_close("conversation_complete")["ok"])
        self.assertTrue(memory.save_visit()["ok"])
        self.assertTrue(memory.prepare_close("visit_agreed")["ok"])

    def test_alternative_and_unsupported_time_need_clarification_not_generic_close(self):
        for text in ("Давайте завтра в одиннадцать или в четырнадцать, удобно вам?", "Давайте завтра, во сколько вам удобно?"):
            memory = ConversationMemory()
            memory.open_question = {"text": "Во сколько удобно приехать?"}
            memory.user(text, 1)
            self.assertFalse(memory.save_visit()["ok"])
            self.assertFalse(memory.prepare_close("conversation_complete")["ok"])

    def test_cancelled_visit_does_not_hold_unrelated_goodbye(self):
        memory = ConversationMemory()
        memory.open_question = {"text": "Во сколько удобно приехать?"}
        memory.user("Давайте завтра в одиннадцать.", 1)
        self.assertTrue(memory.save_visit()["ok"])
        memory.user("Визит отменяется, не приеду.", 2)
        self.assertFalse(memory.visit_pending)
        self.assertFalse(memory.facts)
        self.assertFalse(memory.visit_candidates())
        self.assertTrue(memory.prepare_close("conversation_complete")["ok"])

    def test_callback_does_not_become_a_visit(self):
        memory = ConversationMemory()
        memory.user("Давайте завтра в одиннадцать перезвоните, удобно вам?", 1)
        self.assertFalse(memory.visit_pending)
        self.assertFalse(memory.visit_candidates())
        self.assertTrue(memory.prepare_close("callback_requested", memory.users[-1]["text"])["ok"])

    def test_narrated_transition_is_removed_without_losing_actual_question(self):
        guard = SpeechFilter()
        self.assertEqual(guard.feed("Хорошо, перейду к главному вопросу — хочу уточнить пробег.Пробег актуальный?", final=True), "Пробег актуальный?")
        self.assertEqual(SpeechFilter().feed("Следующий вопрос про цену. Скидку можно обсудить?", final=True).strip(), "Скидку можно обсудить?")

    def test_actual_context_advertises_enums_with_pinned_pipecat(self):
        session = SimpleNamespace(prompt="test", evidence=Evidence(), context={})
        context = call_context(session, SimpleNamespace())
        schemas = {s.name: s for s in context.tools.standard_tools}
        self.assertIn("visit_time", schemas["remember_call_fact"].properties["key"]["enum"])
        self.assertNotIn("visit_agreed", schemas["remember_call_fact"].properties["key"]["enum"])
        self.assertIn("visit_agreed", schemas["prepare_end_call"].properties["reason"]["enum"])

    def test_complete_visit_buffers_closing_and_exposes_exact_candidates(self):
        memory = ConversationMemory()
        memory.open_question = {"text": "Какой диапазон вам подходит?"}
        memory.user("Давайте завтра во второй половине дня.", 1)
        self.assertFalse(memory.closing_candidate)
        memory.user("Давайте к шестнадцати ноль ноль.", 2)
        self.assertTrue(memory.closing_candidate)
        self.assertEqual(memory.snapshot()["visit_candidates"]["visit_time"]["value"], "к шестнадцати ноль ноль")
        rejected = memory.save_visit(when="к шестнадцать ноль ноль", time_evidence="к шестнадцать ноль ноль")
        self.assertFalse(rejected["ok"])
        self.assertIn("visit_candidates", rejected)
        self.assertFalse(memory.facts)

    def test_visit_saved_atomically_from_exact_quotes_without_separate_tool_calls(self):
        memory = ConversationMemory()
        memory.user("Давайте завтра во второй половине дня.", 16)
        memory.user("Давайте к шестнадцати ноль ноль.", 18)
        memory.user("Да, хорошо, ладно.", 19)
        self.assertTrue(memory.save_visit()["ok"])
        self.assertEqual(memory.facts["visit_day"]["value"], "завтра")
        self.assertEqual(memory.facts["visit_time"]["value"], "к шестнадцати ноль ноль")
        self.assertTrue(memory.prepare_close("visit_agreed")["ok"])

    def test_missing_or_false_evidence_rolls_back_both_facts(self):
        memory = ConversationMemory()
        memory.user("Давайте завтра.", 1)
        memory.user("Всё верно.", 2)
        self.assertFalse(memory.save_visit("завтра", "Давайте завтра.", "в четыре", "Всё верно.")["ok"])
        self.assertEqual(memory.facts, {})
        self.assertFalse(memory.save_visit()["ok"])
        self.assertEqual(memory.facts, {})

    def test_question_and_alternative_are_not_inferred_as_visit(self):
        memory = ConversationMemory()
        memory.user("Давайте завтра в 14:00 или в 16:00?", 1)
        self.assertFalse(memory.save_visit()["ok"])
        self.assertFalse(memory.facts)

    def test_chunked_silence_and_narration_are_not_speech(self):
        guard = SpeechFilter()
        self.assertEqual(guard.feed("(мол"), "")
        self.assertEqual(guard.feed("чание)", final=True), "")
        guard = SpeechFilter()
        text = "Хорошо, я сейчас зафиксирую договорённость и завершу разговор. Во сколько вам удобно?"
        output = "".join(guard.feed(text[i:i + 4]) for i in range(0, len(text), 4)) + guard.feed(final=True)
        self.assertEqual(output.strip(), "Во сколько вам удобно?")
        self.assertEqual(len(guard.removed), 1)

    def test_real_confirmation_question_is_preserved(self):
        text = "Чтобы зафиксировать, подтвердите: завтра в 16:00?"
        self.assertEqual(SpeechFilter().feed(text, final=True), text)

    def test_negative_correction_does_not_reuse_old_time(self):
        memory = ConversationMemory()
        memory.user("Давайте завтра в 16:00.", 1)
        self.assertTrue(memory.save_visit()["ok"])
        memory.user("Нет, не в 16:00.", 2)
        self.assertFalse(memory.save_visit()["ok"])
        self.assertNotIn("visit_time", memory.facts)

    def test_day_from_positive_clause_and_late_asr_order(self):
        memory = ConversationMemory()
        memory.user("Сегодня уже не получится, давайте завтра во второй половине дня.", 10)
        memory.user("Да, давайте в четыре.", 11)
        memory.user("Перезвоните.", 5)
        self.assertFalse(memory.closing_candidate)
        self.assertTrue(memory.save_visit()["ok"])
        self.assertEqual(memory.facts["visit_day"]["value"], "завтра")

    def test_old_time_quote_cannot_override_new_explicit_proposal(self):
        memory = ConversationMemory()
        memory.user("Давайте завтра в 14:00.", 1)
        memory.user("Давайте в 16:00.", 2)
        self.assertFalse(memory.save_visit("завтра", "Давайте завтра в 14:00.", "14:00", "Давайте завтра в 14:00.")["ok"])
        self.assertFalse(memory.facts)
        self.assertTrue(memory.save_visit()["ok"])
        self.assertEqual(memory.facts["visit_time"]["value"], "в 16:00")
