import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from pipeline import GatedRealtime, Turn, VoxSerializer
from policy import Evidence, Playback
from realtime_failure import RealtimeFailureNotice
from controller_input import ControllerInput
from pipecat.frames.frames import OutputAudioRawFrame, InputAudioRawFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.openai.realtime import events


class RealtimeFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_initial_audio_waits_for_configured_context_and_keeps_order(self):
        llm=self.llm();llm.wait_for_user=True
        frames=[InputAudioRawFrame(bytes([i])*640,16000,1) for i in (1,2,3)]
        with patch.object(GatedRealtime.__bases__[0],'_send_user_audio',new=AsyncMock()) as sent:
            for frame in frames:await llm._send_user_audio(frame)
            sent.assert_not_awaited();self.assertEqual(len(llm.startup_audio),3)
            await llm.flush_startup_audio()
            self.assertEqual([c.args[0].audio for c in sent.call_args_list],[f.audio for f in frames])
            self.assertFalse(llm.startup_audio)
            llm.context_ready.set()
            await llm._send_user_audio(frames[0])
            self.assertEqual(sent.await_count,4)

    async def test_first_audio_commit_before_provider_ready_does_not_deadlock_context(self):
        llm=self.llm();llm.wait_for_user=True
        llm.session.controller=SimpleNamespace(abort=__import__('unittest.mock',fromlist=['Mock']).Mock())
        llm.send_client_event=AsyncMock();llm._send_session_update=AsyncMock();llm.push_frame=AsyncMock()
        await llm.prime_context(LLMContext([{'role':'system','content':'Fictional buyer'}]))
        self.assertTrue(llm._run_llm_when_api_session_ready)
        stopped=asyncio.create_task(llm._handle_user_stopped_speaking(None))
        await asyncio.sleep(0)
        self.assertFalse(stopped.done())
        event=SimpleNamespace(session=SimpleNamespace(model_dump=lambda **_:{}))
        await llm._handle_evt_session_updated(event)
        await asyncio.wait_for(stopped,1)
        self.assertTrue(llm.context_ready.is_set())
        kinds=[c.args[0].type for c in llm.send_client_event.call_args_list]
        self.assertIn('input_audio_buffer.commit',kinds);self.assertNotIn('response.create',kinds)
        self.assertIn(1,llm.stt_tasks);llm.cancel_stt_watch()
        self.assertFalse(llm.connection_failed)

    async def test_context_wait_preserves_original_turn_when_next_speech_starts(self):
        llm=self.llm();llm.wait_for_user=True
        llm.session.controller=SimpleNamespace(abort=__import__('unittest.mock',fromlist=['Mock']).Mock())
        llm.send_client_event=AsyncMock();llm._send_session_update=AsyncMock()
        await llm.prime_context(LLMContext([{'role':'system','content':'Test'}]))
        stopped=asyncio.create_task(llm._handle_user_stopped_speaking(None))
        await asyncio.sleep(0)
        llm.monitor.turn=Turn(False,number=2)
        await llm._handle_user_started_speaking(None)
        await llm._handle_evt_session_updated(SimpleNamespace(session=SimpleNamespace(model_dump=lambda **_:{})))
        await stopped
        self.assertEqual(llm.pending[0][0].number,1)
        self.assertTrue(llm.user_speaking)
        self.assertEqual(set(llm.stt_tasks),{1});llm.cancel_stt_watch()

    async def test_session_ready_initializes_primed_context_even_without_upstream_run_frame(self):
        llm=self.llm();llm.wait_for_user=True
        llm.send_client_event=AsyncMock();llm._send_session_update=AsyncMock()
        await llm.prime_context(LLMContext([{'role':'system','content':'Test'}]))
        llm._run_llm_when_api_session_ready=False
        await llm._handle_evt_session_updated(SimpleNamespace(session=SimpleNamespace(model_dump=lambda **_:{})))
        self.assertTrue(llm.context_ready.is_set())
        self.assertNotIn('response.create',[c.args[0].type for c in llm.send_client_event.call_args_list])

    async def test_context_timeout_starts_one_failure_notice_instead_of_repeated_frame_timeouts(self):
        llm=self.llm();llm.wait_for_user=True;llm.context_timeout=0
        llm.session.realtime_failure_handler=AsyncMock()
        llm.session.controller=SimpleNamespace(abort=__import__('unittest.mock',fromlist=['Mock']).Mock())
        llm.send_client_event=AsyncMock()
        await llm._handle_user_stopped_speaking(None)
        await llm.failure_task
        await llm._handle_user_stopped_speaking(None)
        self.assertEqual(llm.session.failure_reason,'realtime_initialization_timeout')
        llm.session.realtime_failure_handler.assert_awaited_once()
        self.assertFalse(llm.stt_tasks);self.assertFalse(llm.pending)
        self.assertNotIn('input_audio_buffer.commit',[c.args[0].type for c in llm.send_client_event.call_args_list])

    async def test_context_watch_also_bounds_silence_before_first_person_speaks(self):
        llm=self.llm();llm.context_timeout=0
        llm.session.realtime_failure_handler=AsyncMock()
        llm.watch_context();await llm.context_watch
        await llm.failure_task
        self.assertEqual(llm.session.failure_reason,'realtime_initialization_timeout')
        llm.session.realtime_failure_handler.assert_awaited_once()

    async def test_missing_stt_is_bounded_even_when_websocket_is_open(self):
        llm=self.llm();llm.session.controller=SimpleNamespace(abort=__import__('unittest.mock',fromlist=['Mock']).Mock())
        llm.session.realtime_failure_handler=AsyncMock();llm.stt_timeout=0
        llm.watch_stt(Turn(False,number=1))
        await asyncio.sleep(0);await asyncio.sleep(0)
        await llm.failure_task
        self.assertEqual(llm.session.failure_reason,'realtime_stt_timeout')
        llm.session.realtime_failure_handler.assert_awaited_once()
        self.assertFalse(llm.stt_tasks)

    async def test_received_final_stt_cancels_its_deadline(self):
        llm=self.llm();llm.session.controller=SimpleNamespace(inputs=ControllerInput())
        llm.stt_timeout=10;llm.watch_stt(Turn(False,number=1))
        llm.items['i']=(Turn(False,number=1),True)
        await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='i',transcript=''))
        self.assertFalse(llm.stt_tasks);self.assertFalse(llm.connection_failed)

    async def test_one_missing_transcript_reconnects_without_call_failure_or_lost_fragments(self):
        llm=self.llm();inputs=ControllerInput();inputs.add('Будем ждать сегодня.',1,{'response_id':'offer'})
        llm.session.controller=SimpleNamespace(inputs=inputs,on_stt_recovery=AsyncMock())
        llm.session.realtime_failure_handler=AsyncMock()
        llm.pending.append((Turn(False,number=2),True));llm.items['old']=(Turn(False,number=1),True)
        llm.partial_transcripts['old']='непроверенный текст'
        context=LLMContext([{'role':'system','content':'keep policy'}]);llm._context=context
        llm.wait_for_user=True;llm.has_user_commit=True
        async def connect():
            await llm._handle_evt_session_updated(SimpleNamespace(session=SimpleNamespace(model_dump=lambda **_:{})))
        with patch.object(llm,'_disconnect',new=AsyncMock()),patch.object(llm,'_connect',new=AsyncMock(side_effect=connect)),patch.object(llm,'_send_session_update',new=AsyncMock()),patch.object(llm,'send_client_event',new=AsyncMock()):
            await llm.recover_transcription(Turn(False,number=2))
        self.assertFalse(llm.connection_failed);self.assertEqual(llm.session.status,'connected')
        self.assertEqual(inputs.snapshot()[0]['text'],'Будем ждать сегодня.')
        self.assertFalse(llm.items);self.assertFalse(llm.pending);self.assertFalse(llm.partial_transcripts)
        self.assertIs(llm._context,context)
        self.assertTrue(llm.context_ready.is_set());self.assertFalse(llm.has_user_commit)
        llm.session.realtime_failure_handler.assert_not_awaited()

    async def test_stale_completed_item_from_old_connection_cannot_poison_new_turn(self):
        llm=self.llm();llm.session.controller=SimpleNamespace(inputs=ControllerInput())
        llm.stt_timeout=10;llm.watch_stt(Turn(False,number=2))
        await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='old-session-item',transcript='Да'))
        self.assertIn(2,llm.stt_tasks);self.assertFalse(llm.session.controller.inputs.snapshot())
        self.assertTrue(any(e['event']=='stt_unmatched_discarded' for e in llm.session.evidence.events))
        llm.cancel_stt_watch()

    async def test_recovery_limit_keeps_fatal_failure_bounded(self):
        llm=self.llm();llm.stt_recoveries=llm.stt_recovery_limit
        llm.session.controller=SimpleNamespace(inputs=ControllerInput(),on_stt_recovery=AsyncMock(),abort=lambda:None)
        llm.session.realtime_failure_handler=AsyncMock()
        await llm.recover_transcription(Turn(False,number=3));await llm.failure_task
        self.assertTrue(llm.connection_failed)
        llm.session.controller.on_stt_recovery.assert_not_awaited()

    async def test_failed_recovery_returns_to_existing_failure_notice(self):
        llm=self.llm();llm.context_timeout=.01
        llm.session.controller=SimpleNamespace(inputs=ControllerInput(),on_stt_recovery=AsyncMock(),abort=lambda:None)
        llm.session.realtime_failure_handler=AsyncMock()
        with patch.object(llm,'_disconnect',new=AsyncMock()),patch.object(llm,'_connect',new=AsyncMock()):
            await llm.recover_transcription(Turn(False,number=1))
        await llm.failure_task
        self.assertEqual(llm.session.failure_reason,'realtime_stt_timeout')

    async def test_cut_utterance_after_reconnect_is_cleared_not_committed_as_complete(self):
        llm=self.llm();llm.stt_discard_until_stop=1
        llm._user_audio_preroll_buffer=bytearray(b'old truncated speech')
        llm.monitor.turn=Turn(False,number=2)
        await llm._handle_user_started_speaking(None)
        self.assertEqual(llm.stt_discard_until_stop,2)
        llm.session.controller=SimpleNamespace(on_stt_recovery=AsyncMock())
        llm.send_client_event=AsyncMock()
        await llm._handle_user_stopped_speaking(None)
        self.assertIsNone(llm.stt_discard_until_stop)
        self.assertIsInstance(llm.send_client_event.call_args.args[0],events.InputAudioBufferClearEvent)
        self.assertFalse(llm.pending);self.assertFalse(llm.stt_tasks)
        self.assertFalse(llm._user_audio_preroll_buffer)
        llm.session.controller.on_stt_recovery.assert_awaited_once()

    async def test_newer_transcript_does_not_cancel_older_unanswered_commit(self):
        llm=self.llm();llm.session.controller=SimpleNamespace(inputs=ControllerInput())
        llm.watch_stt(Turn(False,number=1));llm.watch_stt(Turn(False,number=2))
        llm.items['i']=(Turn(False,number=2),True)
        await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='i',transcript=''))
        self.assertEqual(set(llm.stt_tasks),{1})
        llm.cancel_stt_watch()

    def llm(self):
        s = SimpleNamespace(evidence=Evidence(), playback=Playback(), status="connected", finalized=False)
        llm = GatedRealtime(s, SimpleNamespace(turn=Turn(False, number=1)), api_key="test")
        llm.push_error = AsyncMock()
        return llm

    async def test_one_failed_send_stops_audio_error_storm_and_new_responses(self):
        llm = self.llm()
        llm._websocket = SimpleNamespace(send=AsyncMock(side_effect=OSError("broken transport")))
        llm.session.realtime_failure_handler = AsyncMock()
        await llm._ws_send({"type": "input_audio_buffer.append"})
        for _ in range(1000):
            await llm._ws_send({"type": "input_audio_buffer.append"})
        await llm.send_client_event(events.ResponseCreateEvent())
        await llm.failure_task
        llm._websocket.send.assert_awaited_once()
        llm.push_error.assert_awaited_once()
        llm.session.realtime_failure_handler.assert_awaited_once()
        self.assertFalse(llm.audit_pending)
        self.assertEqual(llm.session.status, "failed")
        self.assertEqual(llm.session.failure_reason, "realtime_connection_lost")

    async def test_receive_exception_or_clean_eof_fails_active_session(self):
        for failure in (None, OSError("no close frame")):
            llm = self.llm()
            with patch.object(GatedRealtime.__bases__[0], "_receive_task_handler", new=AsyncMock(side_effect=failure)):
                await llm._receive_task_handler()
            self.assertTrue(llm.connection_failed)
            self.assertTrue(llm.push_error.call_args.kwargs["force_treat_as_permanent"])

    async def test_expected_shutdown_is_not_reported_as_provider_failure(self):
        llm = self.llm()
        llm._disconnecting = True
        await llm.fail_connection("receive_loop_ended")
        llm.push_error.assert_not_awaited()
        llm._disconnecting = False
        llm.session.status = "disconnected"
        await llm.fail_connection("receive_loop_ended")
        llm.push_error.assert_not_awaited()

    async def test_cancelled_receive_task_does_not_start_failure_notice(self):
        llm = self.llm()
        with patch.object(GatedRealtime.__bases__[0], "_receive_task_handler", new=AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await llm._receive_task_handler()
        self.assertFalse(llm.connection_failed)

    async def test_missing_response_created_has_deadline_even_without_socket_error(self):
        llm = self.llm()
        llm.response_start_timeout = 0
        request = {"client_event_id": "never-acknowledged"}
        llm.wire_pending = request
        llm.watch_response_start(request)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertTrue(llm.connection_failed)
        self.assertEqual(llm.session.evidence.events[-1]["reason"], "response_start_timeout")

    async def test_late_text_and_tools_cannot_compete_with_failure_notice(self):
        llm = self.llm()
        await llm.fail_connection("send_failed")
        with patch.object(GatedRealtime.__bases__[0], "_handle_evt_function_call_arguments_done", new=AsyncMock()) as tool:
            await llm._handle_evt_function_call_arguments_done(SimpleNamespace())
            tool.assert_not_awaited()
        await llm._handle_evt_text_delta(SimpleNamespace(response_id="late", delta="late answer"))
        self.assertFalse(llm.response_text)

    async def test_failure_notice_waits_for_its_own_playback_ack(self):
        llm = self.llm()
        s = llm.session
        s.failure_reason = "realtime_connection_lost"
        ws = SimpleNamespace(send_text=AsyncMock())
        serializer = VoxSerializer(s, ws)
        async def clear(kind):
            await serializer.serialize(kind())
        monitor = SimpleNamespace(cancel_timer=lambda: None, broadcast_frame=AsyncMock(side_effect=clear))
        runner = SimpleNamespace(cancel=AsyncMock())
        released = asyncio.Event()
        async def emitted(frame):
            released.set()
        llm.push_frame = AsyncMock(side_effect=emitted)
        job = asyncio.create_task(RealtimeFailureNotice(s, llm, monitor, serializer, runner, timeout=10)())
        await asyncio.wait_for(released.wait(), 1)
        frame = llm.push_frame.call_args.args[0]
        self.assertFalse(frame.append_to_context)
        self.assertEqual(frame.metadata["diagnostic_response_id"], s.finish_response_id)
        ws.send_text.assert_not_awaited()
        await serializer.serialize(OutputAudioRawFrame(b"\x00\x00" * 320, 16000, 1))
        tag = s.playback.active
        await serializer.seal()
        s.evidence.delivery.response(s.finish_response_id)["tts_done"] = True
        import json
        await serializer.deserialize(json.dumps({"customEvent": "playback", "action": "ended", "tag": tag}))
        self.assertEqual(json.loads(ws.send_text.call_args.args[0])["action"], "hangup")
        self.assertEqual(s.status, "failed")
        job.cancel()
        await asyncio.gather(job, return_exceptions=True)

    async def test_failure_notice_has_bounded_emergency_close_without_ack(self):
        llm = self.llm()
        llm.push_frame = AsyncMock()
        serializer = SimpleNamespace(maybe_hangup=AsyncMock(), send=AsyncMock())
        monitor = SimpleNamespace(cancel_timer=lambda: None, broadcast_frame=AsyncMock())
        runner = SimpleNamespace(cancel=AsyncMock())
        await RealtimeFailureNotice(llm.session, llm, monitor, serializer, runner, timeout=0)()
        await asyncio.sleep(0)
        serializer.send.assert_awaited_once_with({"customEvent": "control", "action": "hangup"})
        runner.cancel.assert_awaited_once()
        self.assertTrue(any(e["event"] == "realtime_failure_close_timeout" for e in llm.session.evidence.events))

    async def test_notice_is_not_published_until_old_queue_clear_finishes(self):
        llm = self.llm()
        released = asyncio.Event()
        async def emitted(frame):
            released.set()
        llm.push_frame = AsyncMock(side_effect=emitted)
        barrier = asyncio.Event()
        serializer = SimpleNamespace(queue_cleared_event=barrier, maybe_hangup=AsyncMock(), send=AsyncMock())
        monitor = SimpleNamespace(cancel_timer=lambda: None, broadcast_frame=AsyncMock())
        job = asyncio.create_task(RealtimeFailureNotice(llm.session, llm, monitor, serializer, SimpleNamespace(cancel=AsyncMock()))())
        await asyncio.sleep(0)
        llm.push_frame.assert_not_awaited()
        self.assertFalse(llm.session.playback.finish_requested)
        barrier.set()
        await asyncio.wait_for(released.wait(), 1)
        self.assertTrue(llm.session.playback.finish_requested)
        job.cancel()
        await asyncio.gather(job, return_exceptions=True)
