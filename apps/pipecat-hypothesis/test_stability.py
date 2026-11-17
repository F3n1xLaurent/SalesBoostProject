import asyncio
import json
import os
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from conversation import ConversationMemory, DeliveryLedger, adapt_prompt
from policy import Evidence, Playback
from readiness import WarmSocket
from pipeline import GatedRealtime, Turn, DialogueTTS, call_context, OutputEvidence
from pipecat.frames.frames import OutputAudioRawFrame, InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.openai.realtime import events
from pipecat.processors.aggregators.llm_context import LLMContext
from websockets.protocol import State
from fastapi import HTTPException
import service


class ConversationTests(unittest.TestCase):
    def test_transport_adaptation_keeps_business_questions_and_removes_conflict(self):
        prompt = "Обязательный вопрос: Что по порогам?\n# Завершение разговора — критично\nНе вызывай end_call напрямую. Используй Finish call.\n# Напоминание\nТы покупатель."
        adapted = adapt_prompt(prompt, "Андрей")
        self.assertIn("Что по порогам?", adapted)
        self.assertIn("Ты покупатель.", adapted)
        self.assertNotIn("Не вызывай end_call напрямую", adapted)
        self.assertNotIn("Finish call", adapted)

    def test_identity_and_facts_have_user_evidence(self):
        memory = ConversationMemory("Голос клиента: Женский, Разговорный")
        self.assertEqual(memory.name, "Анна")
        memory.user("Меня зовут Никита, приезжайте завтра в десять.", 1)
        self.assertFalse(memory.remember("manager_name", "Пётр", "Я Пётр")["ok"])
        self.assertFalse(memory.remember("manager_name", "Пётр", "Меня зовут Никита")["ok"])
        self.assertTrue(memory.remember("manager_name", "Никита", "Меня зовут Никита")["ok"])
        self.assertEqual(memory.facts["manager_name"]["turn"], 1)

    def test_visit_requires_day_and_time_but_callback_and_refusal_can_end(self):
        memory = ConversationMemory()
        memory.user("Приезжайте завтра.", 1)
        memory.remember("visit_day", "завтра", "завтра")
        self.assertFalse(memory.prepare_close("visit_agreed")["ok"])
        self.assertFalse(memory.prepare_close("conversation_complete")["ok"])
        memory.user("Хорошо, в десять утра.", 2)
        memory.remember("visit_time", "в десять утра", "в десять утра")
        self.assertTrue(memory.prepare_close("visit_agreed")["ok"])
        memory = ConversationMemory()
        memory.user("Перезвоните завтра, пожалуйста.", 1)
        self.assertTrue(memory.prepare_close("callback_requested", "Перезвоните завтра")["ok"])
        memory = ConversationMemory()
        self.assertFalse(memory.prepare_close("declined", "Не звоните")["ok"])
        memory.user("Не звоните больше.", 1)
        self.assertTrue(memory.prepare_close("declined", "Не звоните")["ok"])

    def test_local_words_are_not_phone_confirmation_and_stale_ack_cannot_restore_cancelled_reply(self):
        ledger = DeliveryLedger()
        ledger.response("reply")["generated_done"] = True
        ledger.response("reply")["tts_done"] = True
        ledger.segment("tag", "reply")
        ledger.word("reply", "Спасибо.")
        self.assertFalse(ledger.complete("reply"))
        interrupted = ledger.interrupt()
        self.assertEqual(interrupted["reply"]["local_text_estimate"], "Спасибо.")
        ledger.ack("tag")
        self.assertFalse(ledger.complete("reply"))

    def test_complete_audio_survives_later_interruption(self):
        ledger = DeliveryLedger()
        ledger.response("reply").update(generated_done=True, tts_done=True)
        ledger.segment("tag", "reply")
        ledger.ack("tag")
        self.assertTrue(ledger.complete("reply"))
        self.assertEqual(ledger.interrupt(), {})


class RealtimeStabilityTests(unittest.IsolatedAsyncioTestCase):
    def create_llm(self, **kwargs):
        self.s = SimpleNamespace(evidence=Evidence(), playback=Playback())
        return GatedRealtime(self.s, SimpleNamespace(turn=Turn(False, number=1)), api_key="test", **kwargs)

    async def test_idle_trim_preserves_speech_onset_and_never_replays_previously_committed_audio(self):
        llm = self.create_llm(trim_idle_audio=True, user_audio_preroll_secs=1.5,
            settings=GatedRealtime.Settings(session_properties=events.SessionProperties(audio=events.AudioConfiguration(input=events.AudioInput(turn_detection=False)))))
        llm._api_session_ready = True
        buffer = bytearray(); committed = []
        async def server(instance, event):
            import base64
            if event.type == "input_audio_buffer.clear": buffer.clear()
            elif event.type == "input_audio_buffer.append": buffer.extend(base64.b64decode(event.audio))
            elif event.type == "input_audio_buffer.commit": committed.append(bytes(buffer)); buffer.clear()
        onset = b"\x11\x11" * 2400
        rest = b"\x22\x22" * 48000
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=server):
            await llm._send_user_audio(InputAudioRawFrame(b"\0\0" * 192000, 24000, 1))
            await llm._send_user_audio(InputAudioRawFrame(onset, 24000, 1))
            await llm._handle_user_started_speaking(None)
            await llm._send_user_audio(InputAudioRawFrame(rest, 24000, 1))
            await llm.send_client_event(events.InputAudioBufferCommitEvent())
            self.assertTrue(committed[0].endswith(onset + rest))
            self.assertEqual(len(committed[0]), 48000 * 3.5)
            self.assertFalse(llm._user_audio_preroll_buffer)
            llm.monitor.turn = Turn(False, number=2)
            next_onset = b"\x33\x33" * 2400
            await llm._send_user_audio(InputAudioRawFrame(next_onset, 24000, 1))
            await llm._handle_user_started_speaking(None)
            self.assertEqual(bytes(buffer), next_onset)
            await llm._handle_user_started_speaking(None)
            self.assertEqual(bytes(buffer), next_onset)
        self.assertEqual(len([e for e in self.s.evidence.events if e["event"] == "idle_audio_trimmed"]), 2)

    async def test_closing_reuses_already_streamed_text_but_held_text_gets_one_backend_farewell(self):
        for held in (False, True):
            self.create_llm()
            self.s.provider = "openai"; self.s.prompt = "Test"; self.s.context = {}
            self.s.evidence.current_response_id = "model-final"
            functions = {}
            def build(messages, tools):
                functions.update({tool.__name__: tool for tool in tools})
                return LLMContext(messages, tools)
            serializer = SimpleNamespace(maybe_hangup=AsyncMock())
            with patch("pipeline.LLMContext", side_effect=build):
                call_context(self.s, serializer)
            llm = SimpleNamespace(response_id="model-final", response_text={"model-final": "Спасибо, я подумаю."},
                held_responses={"model-final"} if held else set(), _sync_registered_tool_handlers=lambda tools: None, push_frame=AsyncMock())
            callback = AsyncMock()
            await functions["prepare_end_call"](SimpleNamespace(llm=llm, result_callback=callback), "conversation_complete")
            self.assertFalse(callback.call_args.kwargs["properties"].run_llm)
            if held:
                self.assertTrue(self.s.finish_response_id.startswith("farewell-"))
                llm.push_frame.assert_awaited_once()
            else:
                self.assertEqual(self.s.finish_response_id, "model-final")
                self.assertEqual(self.s.evidence.current_response_id, "model-final")
                llm.push_frame.assert_not_awaited()
                self.assertFalse(any(key.startswith("farewell-") for key in self.s.evidence.messages))

    async def test_tts_latency_uses_audio_contexts_response_even_if_new_response_was_generated(self):
        self.create_llm()
        clock = [100.0]
        e = self.s.evidence = Evidence(clock=lambda: clock[0])
        e.response_text_at["original"] = 100.0
        e.current_response_id = "new"
        e.delivery.contexts["original-context"] = "original"
        clock[0] = 100.9
        e.mark("tts_requested", turn=0)
        monitor = OutputEvidence(self.s, SimpleNamespace(maybe_hangup=AsyncMock()), "tts")
        monitor.push_frame = AsyncMock()
        frame = OutputAudioRawFrame(b"\0\0" * 320, 16000, 1)
        frame.context_id = "original-context"
        clock[0] = 101.0
        await monitor.process_frame(frame, FrameDirection.DOWNSTREAM)
        metric = next(event for event in e.events if event["event"] == "response_tts_first_audio_ms")
        self.assertEqual(metric["response_id"], "original")
        self.assertEqual(metric["latency_ms"], 1000)

    async def test_completed_generation_unfinished_audio_is_removed_before_next_request(self):
        llm = self.create_llm()
        llm.response_id = "old"
        llm.response_text["old"] = "Спасибо. Были ли ДТП?"
        llm.response_items["old"] = {"item-old"}
        llm.provider_items["item-old"] = {"id": "item-old", "role": "assistant", "content": [{"text": llm.response_text["old"]}]}
        self.s.evidence.delivery.response("old")["generated_done"] = True
        self.s.evidence.delivery.segment("tag-old", "old")
        self.s.evidence.delivery.word("old", "Спасибо.")
        llm._current_assistant_response = None  # Real failure case from the call.
        llm._response_active = False
        with patch.object(GatedRealtime.__bases__[0], "_handle_interruption", new=AsyncMock()), patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as send:
            await llm._handle_interruption()
            await llm.send_client_event(events.ResponseCreateEvent())
        self.assertIn("old", llm.cancelled_responses)
        self.assertNotIn("item-old", llm.provider_items)
        payloads = [call.args[0].model_dump(exclude_none=True) for call in send.call_args_list]
        self.assertEqual(payloads[0]["type"], "conversation.item.delete")
        state = next(p["item"]["content"][0]["text"] for p in payloads if p["type"] == "conversation.item.create")
        self.assertIn("Спасибо.", state)
        self.assertNotIn("Были ли ДТП?", state)
        self.assertIn("approximate", state)

    async def test_phone_confirmed_reply_is_not_cancelled_or_deleted(self):
        llm = self.create_llm()
        llm.response_id = "heard"
        llm.response_text["heard"] = "Ваш вопрос?"
        ledger = self.s.evidence.delivery
        ledger.response("heard").update(generated_done=True, tts_done=True)
        ledger.segment("tag", "heard"); ledger.ack("tag")
        with patch.object(GatedRealtime.__bases__[0], "_handle_interruption", new=AsyncMock()):
            await llm._handle_interruption()
        self.assertNotIn("heard", llm.cancelled_responses)
        self.assertFalse(llm.pending_repairs)

    async def test_initial_session_setup_emits_no_response_or_phantom_tts_start(self):
        llm = self.create_llm(wait_for_user=True)
        llm._context = LLMContext([{"role": "system", "content": "Business prompt"}])
        llm._api_session_ready = True
        llm._send_session_update = AsyncMock()
        llm.push_frame = AsyncMock()
        llm.send_client_event = AsyncMock()
        await llm._create_response()
        self.assertTrue(llm.context_ready.is_set())
        self.assertFalse(llm._response_active)
        llm.push_frame.assert_not_awaited()
        self.assertTrue(all(call.args[0].type != "response.create" for call in llm.send_client_event.call_args_list))

    async def test_response_latency_is_measured_from_each_request_not_old_turn(self):
        llm = self.create_llm()
        clock = [100.0]
        self.s.evidence = Evidence(clock=lambda: clock[0])
        self.s.evidence.mark("llm_requested", turn=1)
        clock[0] += 10
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()), patch.object(GatedRealtime.__bases__[0], "_handle_evt_text_delta", new=AsyncMock()):
            await llm.send_client_event(events.ResponseCreateEvent())
            llm.audit_responses["new"] = llm.audit_pending.popleft()
            clock[0] += 0.4
            await llm._handle_evt_text_delta(SimpleNamespace(response_id="new", item_id="item", delta="Спасибо"))
        metric = next(e for e in self.s.evidence.events if e["event"] == "response_first_text_ms")
        self.assertEqual(metric["latency_ms"], 400)

    async def test_possible_closing_does_not_stream_technical_narration_before_tool_decision(self):
        llm = self.create_llm()
        self.s.evidence.memory.user("Перезвоните завтра после десяти утра.", 1)
        with patch.object(GatedRealtime.__bases__[0], "_handle_evt_text_delta", new=AsyncMock()) as output:
            await llm._handle_evt_text_delta(SimpleNamespace(response_id="closing", item_id="item", delta="Сейчас зафиксирую и завершим разговор."))
            output.assert_not_awaited()
        self.assertIn("closing", llm.held_responses)

    async def test_failed_realtime_connection_stops_after_two_attempts(self):
        llm = self.create_llm()
        llm.push_error = AsyncMock()
        with patch.object(GatedRealtime.__bases__[0], "_connect", new=AsyncMock()) as connect:
            await llm._connect()
        self.assertEqual(connect.await_count, 2)
        self.assertTrue(llm.push_error.call_args.kwargs["force_treat_as_permanent"])


class FakeSocket:
    def __init__(self):
        self.state = State.OPEN
        self.send = AsyncMock()
        self.close = AsyncMock()
    async def ping(self):
        future = asyncio.get_running_loop().create_future(); future.set_result(None)
        return future
    def __aiter__(self):
        return self
    async def __anext__(self):
        await asyncio.Event().wait()


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def test_delayed_tts_generation_keeps_contexts_original_response(self):
        tts = DialogueTTS(api_key="test", sample_rate=16000,
            settings=DialogueTTS.Settings(model="eleven_v4_turbo", voice="test"))
        tts.evidence = Evidence()
        tts.incoming_response_id = "first"
        with patch.object(DialogueTTS.__bases__[0], "on_turn_context_created", new=AsyncMock()):
            await tts.on_turn_context_created("context-first")
        tts.incoming_response_id = "second"
        async def generate(*args):
            yield None
        with patch.object(DialogueTTS.__bases__[0], "run_tts", new=generate):
            async for frame in tts.run_tts("Первый ответ", "context-first"):
                pass
        self.assertEqual(tts.evidence.delivery.contexts["context-first"], "first")

    async def test_same_ready_socket_is_reused_and_warmup_never_sends_speech(self):
        socket = FakeSocket()
        opener = AsyncMock(return_value=socket)
        warm = await WarmSocket.prepare(opener, "wss://tts.example", {}, "voice", Evidence())
        claimed = await warm.claim()
        self.assertIs(claimed, socket)
        self.assertEqual(opener.await_count, 1)
        self.assertTrue(all("text" not in json.loads(call.args[0]) for call in socket.send.call_args_list))
        await warm.close()
        socket.close.assert_not_awaited()  # Ownership is now with Pipecat.

    async def test_connection_retries_are_bounded_and_failed_calls_do_not_dial(self):
        opener = AsyncMock(side_effect=TimeoutError())
        with self.assertRaises(RuntimeError):
            await WarmSocket.prepare(opener, "wss://tts.example", {}, "voice", Evidence())
        self.assertEqual(opener.await_count, 2)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "PIPECAT_LOG_DIR": directory, "PIPECAT_HYPOTHESIS_PUBLIC_URL": "https://test.example",
            "VOX_ACCOUNT_ID": "test", "VOX_API_KEY": "test", "VOX_APP_ID": "test",
        }), patch("service.preflight", new=AsyncMock(return_value={})), patch("service.prepare_call_audio", new=AsyncMock(side_effect=RuntimeError("not ready"))), patch("service.httpx.AsyncClient") as dial:
            with self.assertRaises(HTTPException):
                await service.start_call(service.Call(to="+79991234567", voiceId="v", prompt="test"))
            dial.assert_not_called()
            service.sessions.clear()

    async def test_stale_socket_cannot_be_handed_to_pipeline(self):
        socket = FakeSocket()
        warm = await WarmSocket.prepare(AsyncMock(return_value=socket), "wss://tts.example", {}, "voice", Evidence())
        socket.state = State.CLOSED
        with self.assertRaises(RuntimeError):
            await warm.claim()
        await warm.close()
        socket.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
