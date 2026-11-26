import asyncio
import base64
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from conversation import ConversationMemory
from controller_input import ControllerInput
from pipeline import GatedRealtime, Turn, validated_tool, call_context
from policy import Evidence, Playback
from speech_filter import SpeechFilter
from pipecat.frames.frames import InputAudioRawFrame
from pipecat.services.openai.realtime import events


class CoordinationTests(unittest.IsolatedAsyncioTestCase):
    async def test_verified_agreement_reaches_memory_and_controller_as_a_text_item(self):
        from input_quality import AudioWindow
        from test_input_quality import pcm
        llm=self.llm();llm.session.evidence.memory=ConversationMemory('1. Вопрос?')
        llm.session.context={};llm.session.finalized=False
        controller=SimpleNamespace(inputs=ControllerInput(),receive_batch=Mock(),accepts_short_answer=lambda:False)
        llm.session.controller=controller
        llm.monitor.turn=Turn(False,160,number=1)
        llm.items['original']=(llm.monitor.turn,True)
        llm.turn_audio.windows[1]=AudioWindow(pcm(.8),16000,-65)
        text='Да автомобиль в наличии'
        llm.input_quality.verify=AsyncMock(return_value={'text':text,'logprobs':[{'logprob':-.1}]})
        with patch.object(GatedRealtime.__bases__[0],'handle_evt_input_audio_transcription_completed',new=AsyncMock()),patch.object(GatedRealtime.__bases__[0],'send_client_event',new=AsyncMock()) as sent:
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='original',transcript=text))
            await asyncio.gather(*list(llm.quality_tasks.values()))
        llm.input_quality.verify.assert_awaited_once()
        self.assertEqual([row['text'] for row in llm.session.evidence.memory.users],[text])
        self.assertEqual(controller.receive_batch.call_args.args[0][0]['text'],text)
        self.assertTrue(any(c.args[0].type=='conversation.item.delete' and c.args[0].item_id=='original' for c in sent.call_args_list))
        inserted=[c.args[0].item for c in sent.call_args_list if c.args[0].type=='conversation.item.create']
        self.assertEqual(inserted[-1].role,'user');self.assertEqual(inserted[-1].content[0].text,text)

    async def test_reviewed_text_item_does_not_steal_another_audio_turn(self):
        llm=self.llm();turn=Turn(False,500,number=2);llm.pending.append((turn,True))
        reviewed=events.ConversationItem(type='message',role='user',content=[events.ItemContent(type='input_text',text='Нет.')])
        llm.reviewed_items.add(reviewed.id)
        with patch.object(GatedRealtime.__bases__[0],'_handle_evt_conversation_item_added',new=AsyncMock()):
            await llm._handle_evt_conversation_item_added(SimpleNamespace(item=reviewed))
            self.assertEqual(len(llm.pending),1);self.assertNotIn(reviewed.id,llm.items)
            real=events.ConversationItem(type='message',role='user',content=[])
            await llm._handle_evt_conversation_item_added(SimpleNamespace(item=real))
        self.assertEqual(llm.items[real.id],(turn,True));self.assertFalse(llm.pending)

    async def test_slow_verification_does_not_block_new_input_or_promote_an_old_uncertain_result(self):
        from input_quality import AudioWindow,Admission
        from test_input_quality import pcm
        llm=self.llm();llm.session.evidence.memory=ConversationMemory('1. Вопрос?')
        llm.session.context={};llm.session.finalized=False
        controller=SimpleNamespace(inputs=ControllerInput(),receive_batch=Mock(),on_asr_unresolved=AsyncMock(),on_ignored_input=AsyncMock(),accepts_short_answer=lambda:False)
        llm.session.controller=controller
        release=asyncio.Event()
        async def check(*args):
            await release.wait();return Admission('uncertain','','transcript_disagreement')
        llm.input_quality.assess=check
        llm.turn_audio.windows[1]=AudioWindow(pcm(),16000,-60)
        llm.items['suspect']=(Turn(False,600,number=1),True)
        with patch.object(GatedRealtime.__bases__[0],'handle_evt_input_audio_transcription_completed',new=AsyncMock()),patch.object(GatedRealtime.__bases__[0],'send_client_event',new=AsyncMock()):
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='suspect',transcript='comes самом начале'))
            self.assertTrue(llm.quality_tasks);self.assertFalse(llm.session.evidence.memory.users)
            llm.monitor.turn=Turn(False,300,number=2);llm.items['real']=(llm.monitor.turn,True)
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='real',transcript='Нет.'))
            controller.receive_batch.assert_not_called()
            tasks=list(llm.quality_tasks.values());release.set();await asyncio.gather(*tasks)
        controller.on_asr_unresolved.assert_not_awaited()
        self.assertEqual([row['text'] for row in llm.session.evidence.memory.users],['Нет.'])
        self.assertEqual(controller.receive_batch.call_args.args[0][0]['text'],'Нет.')

    async def test_unsupported_script_never_enters_manager_memory_or_the_production_transcript(self):
        from production_calls import snapshot
        llm=self.llm();llm.session.evidence.memory=ConversationMemory('1. Вопрос?')
        before=llm.session.evidence.memory.snapshot()
        turn=Turn(True,160.2,number=8)
        llm.items['noise']=(turn,True);llm.monitor.turn=turn
        controller=SimpleNamespace(on_ignored_input=AsyncMock(),inputs=ControllerInput(),receive_batch=Mock())
        llm.session.controller=controller;llm.dispatch_controller_input=AsyncMock(wraps=llm.dispatch_controller_input)
        with patch.object(GatedRealtime.__bases__[0],'handle_evt_input_audio_transcription_completed',new=AsyncMock()) as accepted,patch.object(GatedRealtime.__bases__[0],'send_client_event',new=AsyncMock()) as sent:
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='noise',transcript='学校'))
            await asyncio.gather(*list(llm.quality_tasks.values()))
        accepted.assert_not_awaited()
        self.assertEqual(llm.session.evidence.memory.snapshot(),before)
        self.assertTrue(any(c.args[0].type=='conversation.item.delete' for c in sent.call_args_list))
        controller.on_ignored_input.assert_awaited_once_with(turn)
        llm.dispatch_controller_input.assert_awaited_once()
        self.assertTrue(any(e['event']=='stt_completed' and e.get('text')=='学校' for e in llm.session.evidence.events))
        self.assertFalse(any(e['event']=='user_transcript' and e.get('text')=='学校' for e in llm.session.evidence.events))
        llm.session.id='noise-test';llm.session.to='';llm.session.voice_id='test'
        llm.session.status='connected';llm.session.finalized=False;llm.session.created=0
        self.assertEqual(snapshot(llm.session)['transcript'],[])

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

    async def test_dispatch_waits_for_physical_speech_before_logical_turn_start(self):
        llm=self.llm();llm.monitor.segment_start=1.
        controller=SimpleNamespace(inputs=ControllerInput(),receive_batch=Mock())
        controller.inputs.add('Предыдущая фраза.',1)
        llm.session.controller=controller
        await llm.dispatch_controller_input()
        controller.receive_batch.assert_not_called()
        self.assertTrue(controller.inputs.snapshot())

    async def test_dispatch_rechecks_new_speech_after_waiting_for_queue_clear(self):
        llm=self.llm();llm.monitor.segment_start=None;llm.monitor.turn=Turn(True,1000,number=1)
        controller=SimpleNamespace(inputs=ControllerInput(),receive_batch=Mock(),
            serializer=SimpleNamespace(queue_cleared_event=asyncio.Event()))
        controller.inputs.add('Предыдущая фраза.',1)
        llm.session.controller=controller;llm.session.playback.generated=True
        llm._handle_interruption=AsyncMock()
        async def clear(*args):
            llm.monitor.turn=Turn(False,number=2);llm.user_speaking=True
            controller.serializer.queue_cleared_event.set()
        llm.broadcast_frame=AsyncMock(side_effect=clear)
        await llm.dispatch_controller_input()
        controller.receive_batch.assert_not_called()
        self.assertTrue(controller.inputs.snapshot())

    async def test_old_native_completion_requires_controller_approval_after_ignored_turn(self):
        for accepted in (True,False):
            llm=self.llm();llm.monitor.turn=Turn(False,number=2)
            controller=SimpleNamespace(accepts_native_completion=Mock(return_value=accepted),fallback_done=AsyncMock())
            llm.session.controller=controller
            llm.audit_responses['native']={'reason':'controller_fallback','turn':1}
            llm.release_speech=AsyncMock()
            await self.finish(llm,'native')
            controller.accepts_native_completion.assert_called_once_with('native',llm.audit_responses['native'])
            self.assertEqual(controller.fallback_done.await_count,int(accepted))

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

    async def test_idle_trim_discards_long_pause_but_keeps_speech_onset_and_never_replays_committed_audio(self):
        llm=self.llm();llm.trim_idle_audio=True;llm._api_session_ready=True
        llm._is_turn_detection_disabled=lambda:True
        speech=b'\x22\x22'*7200
        with patch.object(GatedRealtime.__bases__[0],'send_client_event',new=AsyncMock()) as sent:
            await llm._send_user_audio(InputAudioRawFrame(b'\x00\x00'*240000+speech,24000,1))
            sent.reset_mock()
            await llm._handle_user_started_speaking(None)
            calls=[c.args[0] for c in sent.call_args_list]
            self.assertEqual([c.type for c in calls],['input_audio_buffer.clear','input_audio_buffer.append'])
            kept=base64.b64decode(calls[-1].audio)
            self.assertTrue(kept.endswith(speech));self.assertLessEqual(len(kept),72000)
            self.assertLess(len(kept),240000*2)
            await llm.send_client_event(events.InputAudioBufferCommitEvent())
            llm.monitor.turn=Turn(False,number=2)
            fresh=b'\x33\x33'*2400
            await llm._send_user_audio(InputAudioRawFrame(fresh,24000,1))
            await llm._handle_user_started_speaking(None)
            self.assertEqual(base64.b64decode(sent.call_args.args[0].audio),fresh)

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
