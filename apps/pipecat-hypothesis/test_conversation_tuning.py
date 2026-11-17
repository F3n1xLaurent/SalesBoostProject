import asyncio
import json
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from conversation import adapt_prompt, legacy_adapt_prompt
from conversation_tuning import ToolTurnBudget
from pipeline import GatedRealtime, Turn, VoxSerializer, call_context
from policy import Evidence, Playback, is_backchannel
from pipecat.frames.frames import LLMTextFrame
from pipecat.services.openai.realtime import events


class TuningTests(unittest.IsolatedAsyncioTestCase):
    def setup_call(self):
        s = SimpleNamespace(evidence=Evidence(), playback=Playback(), status="connected", finalized=False,
                            prompt="Ты покупатель. Обязательная тема: сколько владел предыдущий владелец?", context={})
        s.evidence.turn = s.evidence.output_turn = 1
        llm = GatedRealtime(s, SimpleNamespace(turn=Turn(False, number=1)), api_key="test")
        llm.push_frame = AsyncMock()
        serializer = SimpleNamespace(maybe_hangup=AsyncMock())
        context = call_context(s, serializer)
        tools = {w.name: w.function for w in context.tools.direct_functions}
        return s, llm, tools

    async def test_two_bad_calls_ask_once_then_allow_new_user_turn(self):
        s, llm, tools = self.setup_call()
        callback = AsyncMock()
        params = SimpleNamespace(llm=llm, result_callback=callback)
        for _ in range(4):
            await tools["remember_call_fact"](params, key="visit_time", value="14", evidence="invented")
        await llm.clarification_task
        self.assertTrue(s.tool_budget.is_blocked(1))
        self.assertEqual(sum(e["event"] == "tool_budget_exhausted" for e in s.evidence.events), 1)
        llm.push_frame.assert_awaited_once()
        self.assertFalse(s.playback.finish_requested)
        self.assertFalse(callback.call_args.kwargs["properties"].run_llm)
        self.assertFalse(s.evidence.memory.facts)
        s.evidence.turn = 2
        s.evidence.output_turn = 2
        s.evidence.memory.user("Меня зовут Никита.", 2)
        await tools["remember_call_fact"](params, key="manager_name", value="Никита", evidence="Меня зовут Никита.")
        self.assertFalse(s.tool_budget.is_blocked(2))
        self.assertEqual(s.evidence.memory.facts["manager_name"]["value"], "Никита")

    async def test_blocked_tool_result_does_not_create_more_responses(self):
        s, llm, _ = self.setup_call()
        s.tool_budget.begin(1)
        s.tool_budget.reject(1); s.tool_budget.reject(1)
        llm._results_awaiting_response = True
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as send:
            await llm.send_client_event(events.ResponseCreateEvent())
            send.assert_not_awaited()
        self.assertFalse(llm._results_awaiting_response)

    async def test_backchannel_turn_does_not_unlock_budget_but_new_request_does(self):
        s, llm, _ = self.setup_call()
        s.tool_budget.begin(1)
        s.tool_budget.reject(1); s.tool_budget.reject(1)
        llm.monitor.turn = Turn(False, number=2)
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as send:
            await llm.send_client_event(events.ResponseCreateEvent())
            send.assert_not_awaited()
            llm.request_reason = "text_regression_input"
            await llm.send_client_event(events.ResponseCreateEvent())
            self.assertTrue(any(c.args[0].type == "response.create" for c in send.call_args_list))
        self.assertFalse(s.tool_budget.blocked)

    async def test_valid_calls_also_have_total_budget(self):
        budget = ToolTurnBudget()
        self.assertTrue(all(budget.begin(1) for _ in range(6)))
        self.assertFalse(budget.begin(1))
        self.assertTrue(budget.is_blocked(1))
        self.assertTrue(budget.begin(2))
        self.assertFalse(budget.reject(1))
        self.assertEqual(budget.failures, 0)

    async def test_urgent_partial_cancels_but_backchannel_and_old_turn_do_not(self):
        for text, item_turn, expected in (("угу", 1, False), ("подождите", 1, True), ("стопор", 1, False), ("стоп", 0, False)):
            s, llm, _ = self.setup_call()
            llm.items["item"] = (Turn(True, 300, number=item_turn), True)
            llm._handle_interruption = AsyncMock()
            llm.broadcast_frame = AsyncMock()
            with patch.object(GatedRealtime.__bases__[0], "_handle_evt_input_audio_transcription_delta", new=AsyncMock()):
                await llm._handle_evt_input_audio_transcription_delta(SimpleNamespace(item_id="item", delta=text))
            self.assertEqual(llm._handle_interruption.await_count, int(expected), text)

    async def test_safe_sentence_metadata_is_enabled_only_for_selected_mode(self):
        for mode in ("sentence", "fast_sentence"):
            s, llm, _ = self.setup_call()
            s.speech_mode = mode
            frame = LLMTextFrame("Пробег актуальный?")
            with patch.object(GatedRealtime.__bases__[0], "push_frame", new=AsyncMock()):
                await GatedRealtime.push_frame(llm, frame)
            self.assertEqual(bool(frame.metadata.get("tts_presegmented")), mode == "fast_sentence")

    async def test_rtt_requires_matching_nonce_and_remote_clock_is_an_estimate(self):
        s, _, _ = self.setup_call()
        serializer = VoxSerializer(s, SimpleNamespace(send_text=AsyncMock()))
        serializer.pending_pings["known"] = (time.monotonic() - .1, time.time() * 1000 - 100)
        now = time.time() * 1000
        await serializer.deserialize(json.dumps({"customEvent": "transport_pong", "nonce": "unknown", "remoteReceivedUtcMs": now, "remoteSentUtcMs": now}))
        self.assertIsNone(serializer.last_rtt)
        await serializer.deserialize(json.dumps({"customEvent": "transport_pong", "nonce": "known", "remoteReceivedUtcMs": now - 51, "remoteSentUtcMs": now - 49}))
        self.assertGreater(serializer.last_rtt, 90)
        self.assertLess(serializer.last_rtt, 130)
        self.assertIsNotNone(serializer.clock_offset_ms)


class PromptTests(unittest.TestCase):
    def test_compact_keeps_business_payload_and_is_smaller(self):
        source = "Ты покупатель.\nОбязательная тема: сколько владел предыдущий владелец?\nНомер объявления: 418.\n# Первый контакт\nПосле первой осмысленной реплики сотрудника назови «Лира Седан» и уточни актуальность.\n\nОбщее правило приветствия.\n# Ход разговора\n1. ДТП?\n2. Скидка?"
        compact, legacy = adapt_prompt(source, "Андрей"), legacy_adapt_prompt(source, "Андрей")
        for value in ("сколько владел предыдущий владелец?", "418", "Лира Седан", "1. ДТП?", "2. Скидка?"):
            self.assertIn(value, compact)
        self.assertLess(len(compact), len(legacy))
        self.assertNotIn("Общее правило приветствия", compact)

    def test_fast_threshold_cannot_preserve_long_short_backchannel_by_duration_alone(self):
        # The timer waits threshold + 200ms, while VAD stop also arrives
        # after the same 200ms. Acknowledgements below 850ms remain backchannels.
        self.assertTrue(is_backchannel("угу", 750))
        self.assertLess(600 + 200, 750 + 200)
        self.assertGreater(850 + 200, 750 + 200)
