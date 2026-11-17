import asyncio
import base64
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from policy import Evidence, Playback
from pipeline import GatedRealtime, Turn, TurnMonitor, VoxSerializer, run_pipeline, OutputEvidence,bind_vox_output_markers
from pipecat.frames.frames import InputAudioRawFrame, InterruptionFrame, LLMFullResponseEndFrame, OutputAudioRawFrame, UserStartedSpeakingFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,TTSStartedFrame,TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.openai.realtime import events


def session():
    return SimpleNamespace(playback=Playback(), evidence=Evidence(), status="connected")


class SerializerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.s = session()
        self.ws = SimpleNamespace(send_text=AsyncMock())
        self.serializer = VoxSerializer(self.s, self.ws)

    async def test_paced_marker_preserves_filler_owner_when_transport_clones_pcm(self):
        e=self.s.evidence;e.current_response_id='previous-main'
        e.messages['bc']={'turn':2};e.delivery.contexts['ctx-bc']='bc'
        e.delivery.response('bc').update(kind='backchannel',generated_done=True,tts_done=True)
        output=SimpleNamespace(push_frame=AsyncMock())
        bind_vox_output_markers(output,self.serializer,e)
        await output.push_frame(TTSStartedFrame(context_id='ctx-bc'))
        # Pinned FastAPI output creates this plain frame, dropping context_id.
        await self.serializer.serialize(OutputAudioRawFrame(b'\x00\x01'*320,16000,1))
        tag=self.s.playback.active
        self.assertEqual(self.serializer.tag_responses[tag],'bc')
        self.assertEqual(self.serializer.tag_turns[tag],2)
        self.assertFalse(any(row['event']=='speech_to_audio_sent_ms' for row in e.events))
        await output.push_frame(TTSStoppedFrame(context_id='ctx-bc'))
        self.assertIsNone(self.s.playback.active)
        self.assertIsNone(self.serializer.output_response_id)

    async def test_output_only_filler_stop_retains_native_owner_and_completion(self):
        e=self.s.evidence;e.current_response_id='native'
        e.delivery.contexts.update({'ctx-native':'native','ctx-bc':'bc'})
        e.delivery.response('native').update(kind='native',generated_done=True)
        e.delivery.response('bc').update(kind='backchannel',generated_done=True)
        output=SimpleNamespace(push_frame=AsyncMock())
        bind_vox_output_markers(output,self.serializer,e)
        await output.push_frame(TTSStartedFrame(context_id='ctx-native'))
        await output.push_frame(TTSStartedFrame(context_id='ctx-bc'))
        await self.serializer.serialize(OutputAudioRawFrame(b'\x00\x01'*320,16000,1))
        interrupt=InterruptionFrame();interrupt.metadata['backchannel_only']='bc'
        await self.serializer.serialize(interrupt)
        await self.serializer.serialize(OutputAudioRawFrame(b'\x00\x01'*320,16000,1))
        self.assertEqual(self.serializer.tag_responses[self.s.playback.active],'native')
        self.assertFalse(e.delivery.response('native')['interrupted'])
        self.assertTrue(e.delivery.response('bc')['interrupted'])

    async def test_delayed_stop_from_older_context_does_not_clear_current_owner(self):
        e=self.s.evidence;e.delivery.contexts.update({'old':'old-main','new':'new-main'})
        output=SimpleNamespace(push_frame=AsyncMock())
        bind_vox_output_markers(output,self.serializer,e)
        await output.push_frame(TTSStartedFrame(context_id='new'))
        await output.push_frame(TTSStoppedFrame(context_id='old'))
        self.assertEqual(self.serializer.output_response_id,'new-main')

    async def test_vox_pcm_roundtrip_and_confirmed_finish(self):
        pcm = b"\0\1" * 320
        message = json.loads(await self.serializer.serialize(OutputAudioRawFrame(pcm, 16000, 1)))
        self.assertEqual(base64.b64decode(message["media"]["payload"]), pcm)
        first = message["media"]["tag"]
        await self.serializer.seal()
        self.s.playback.finish_requested = True
        self.assertFalse(self.s.playback.can_hangup)
        await self.serializer.deserialize(json.dumps({"customEvent": "playback", "action": "ended", "tag": first}))
        self.assertEqual(self.s.status, "ending")
        control = json.loads(self.ws.send_text.call_args.args[0])
        self.assertEqual(control["action"], "hangup")

    async def test_16_to_24_and_24_to_16_are_not_reinterpreted(self):
        # Actual Pipecat stream resampler, not a fake codec conversion.
        message = json.loads(await self.serializer.serialize(OutputAudioRawFrame(b"\0\0" * 2400, 24000, 1)))
        size = len(base64.b64decode(message["media"]["payload"]))
        self.assertTrue(2500 < size <= 3200)

    async def test_previous_audio_ack_cannot_end_call_before_the_farewell_is_played(self):
        self.s.playback.had_audio = True
        self.s.playback.last_ack = "previous"
        self.s.playback.finish_requested = True
        self.s.finish_response_id = "farewell"
        await self.serializer.maybe_hangup()
        self.ws.send_text.assert_not_awaited()
        self.s.evidence.current_response_id = "farewell"
        self.s.evidence.delivery.response("farewell").update(generated_done=True, tts_done=True)
        await self.serializer.serialize(OutputAudioRawFrame(b"\0\0" * 320, 16000, 1))
        tag = self.s.playback.active
        await self.serializer.seal()
        await self.serializer.deserialize(json.dumps({"customEvent": "playback", "action": "ended", "tag": tag}))
        self.assertEqual(self.s.status, "ending")
        self.assertEqual(json.loads(self.ws.send_text.call_args.args[0])["action"], "hangup")

    async def test_interruption_flushes_vox_and_rejects_old_ack(self):
        await self.serializer.serialize(OutputAudioRawFrame(b"\0\0" * 320, 16000, 1))
        old = self.s.playback.active
        control = json.loads(await self.serializer.serialize(InterruptionFrame()))
        self.assertEqual(control["action"], "clear_media")
        self.assertFalse(self.s.playback.pending)
        await self.serializer.serialize(OutputAudioRawFrame(b"\0\0" * 320, 16000, 1))
        new = self.s.playback.active
        await self.serializer.deserialize(json.dumps({"customEvent": "playback", "action": "ended", "tag": old}))
        self.assertIn(new, self.s.playback.pending)

    async def test_input_format_validation(self):
        for fmt in ({"encoding": "ULAW"}, {"encoding": "PCM16", "sampleRate": 8000}, {"encoding": "PCM16", "channels": 2}):
            with self.assertRaises(ValueError):
                await self.serializer.deserialize(json.dumps({"event": "start", "start": {"mediaFormat": fmt}}))
        frame = await self.serializer.deserialize(json.dumps({"event": "media", "media": {"payload": "AAA="}}))
        self.assertIsInstance(frame, InputAudioRawFrame)
        self.assertEqual(frame.sample_rate, 16000)
        with self.assertRaises(ValueError):
            await self.serializer.deserialize(json.dumps({"event": "media", "media": {"payload": "AA=="}}))

    async def test_playback_ack_before_generation_end_still_completes(self):
        # Engine callback and final pipeline marker can arrive in either order.
        await self.serializer.serialize(OutputAudioRawFrame(b"\0\0" * 320, 16000, 1))
        tag = self.s.playback.active
        await self.serializer.seal()
        self.s.playback.finish_requested = True
        self.s.playback.generated = True
        await self.serializer.deserialize(json.dumps({"customEvent": "playback", "action": "ended", "tag": tag}))
        self.assertEqual(self.s.status, "connected")
        evidence = OutputEvidence(self.s, self.serializer, "tts")
        evidence.push_frame = AsyncMock()
        await evidence.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
        self.assertEqual(self.s.status, "ending")


class RealtimeGateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.s = session()
        self.monitor = SimpleNamespace(turn=Turn(True, 250))
        self.llm = GatedRealtime(self.s, self.monitor, api_key="test",
            settings=GatedRealtime.Settings(model="gpt-realtime-2.1", session_properties=events.SessionProperties(
                output_modalities=["text"], audio=events.AudioConfiguration(input=events.AudioInput(turn_detection=False)))))
        self.llm.send_client_event = AsyncMock()
        self.llm.broadcast_frame = AsyncMock()
        self.llm._handle_interruption = AsyncMock()

    async def test_short_overlap_commits_without_generating_or_interrupting(self):
        await self.llm._handle_user_stopped_speaking(None)
        calls = self.llm.send_client_event.call_args_list
        self.assertEqual(len(calls), 1)
        self.assertIsInstance(calls[0].args[0], events.InputAudioBufferCommitEvent)
        self.llm.broadcast_frame.assert_not_called()

    async def test_acknowledgement_deleted_from_provider_context(self):
        self.llm.items["user-item"] = (Turn(True, 250), True)
        await self.llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id="user-item", transcript="ага"))
        event = self.llm.send_client_event.call_args.args[0]
        self.assertIsInstance(event, events.ConversationItemDeleteEvent)
        self.llm._handle_interruption.assert_not_called()
        self.llm.broadcast_frame.assert_not_called()

    async def test_meaningful_short_overlap_cancels_response_and_tts(self):
        self.llm.items["user-item"] = (Turn(True, 250), True)
        with patch.object(GatedRealtime.__bases__[0], "handle_evt_input_audio_transcription_completed", new=AsyncMock()):
            await self.llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id="user-item", transcript="стоп"))
        self.llm._handle_interruption.assert_awaited_once()
        self.llm.broadcast_frame.assert_awaited_once_with(InterruptionFrame)
        self.assertIsInstance(self.llm.send_client_event.call_args.args[0], events.ResponseCreateEvent)

    async def test_normal_turn_does_not_wait_for_transcription(self):
        self.monitor.turn = Turn(False, 600)
        await self.llm._handle_user_stopped_speaking(None)
        self.assertEqual(len(self.llm.send_client_event.call_args_list), 2)
        self.assertIsInstance(self.llm.send_client_event.call_args.args[0], events.ResponseCreateEvent)

    async def test_server_vad_false_serializes_to_null(self):
        from policy import realtime_transcription_config
        event = events.SessionUpdateEvent(session=events.SessionProperties(output_modalities=["text"], reasoning=events.Reasoning(effort="minimal"),
            audio=events.AudioConfiguration(input=events.AudioInput(turn_detection=False,
                transcription=events.InputAudioTranscription(**realtime_transcription_config())))))
        payload = event.model_dump(exclude_none=True)
        self.assertIsNone(payload["session"]["audio"]["input"]["turn_detection"])
        self.assertEqual(payload["session"]["output_modalities"], ["text"])
        self.assertEqual(payload["session"]["reasoning"]["effort"], "minimal")
        self.assertEqual(payload["session"]["audio"]["input"]["transcription"],
            {"model": "gpt-live-transcribe", "languages": ["ru"]})

    async def test_late_cancelled_text_and_function_calls_cannot_restart_output(self):
        self.llm.cancelled_responses.add("old")
        with patch.object(GatedRealtime.__bases__[0], "_handle_evt_text_delta", new=AsyncMock()) as text, patch.object(GatedRealtime.__bases__[0], "_handle_evt_function_call_arguments_done", new=AsyncMock()) as tool:
            await self.llm._handle_evt_text_delta(SimpleNamespace(response_id="old", delta="late audio text"))
            await self.llm._handle_evt_function_call_arguments_done(SimpleNamespace(response_id="old"))
            text.assert_not_called(); tool.assert_not_called()
            await self.llm._handle_evt_text_delta(SimpleNamespace(response_id="new", delta="new answer."))
            text.assert_awaited_once()


class TurnMonitorTests(unittest.IsolatedAsyncioTestCase):
    async def test_timer_handles_either_vad_frame_order_and_stops_on_silence(self):
        for vad_first in (True, False):
            s = session(); s.playback.generated = True
            monitor = TurnMonitor(s)
            monitor.push_frame = AsyncMock()
            monitor.interrupt = AsyncMock()
            frames = [VADUserStartedSpeakingFrame(), UserStartedSpeakingFrame()]
            if not vad_first:
                frames.reverse()
            for frame in frames:
                await monitor.process_frame(frame, FrameDirection.DOWNSTREAM)
            self.assertIsNotNone(monitor.timer)
            await monitor.process_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2), FrameDirection.DOWNSTREAM)
            self.assertIsNone(monitor.timer)
            monitor.interrupt.assert_not_called()


class AssemblyTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_business_tools_return_results_and_end_waits_for_phone_playback(self):
        import pipeline
        captured = []
        real_context = pipeline.LLMContext
        def context(messages, tools):
            captured.extend(tools)
            result = real_context(messages, tools)
            original = result.set_tools
            def update(next_tools):
                captured.extend(next_tools)
                original(next_tools)
            result.set_tools = update
            return result
        s = session()
        s.provider = "openai"; s.prompt = "Test"; s.context = {"planName": "Test"}
        s.voice_id = "test"; s.tts_model = "eleven_v4_turbo"
        tag = s.playback.begin()
        s.playback.seal()
        ws = SimpleNamespace(send_text=AsyncMock())
        runner = SimpleNamespace(add_workers=AsyncMock(), run=AsyncMock(), cancel=AsyncMock())
        with patch.dict("os.environ", {"OPENAI_API_KEY": "test", "ELEVENLABS_API_KEY": "test"}), patch("pipeline.WorkerRunner", return_value=runner), patch("pipeline.LLMContext", side_effect=context):
            await run_pipeline(s, ws)
        callback = AsyncMock()
        self.assertNotIn("end_call", [tool.__name__ for tool in captured])
        await captured[0](SimpleNamespace(result_callback=callback))
        callback.assert_awaited_once_with(s.context)
        callback.reset_mock()
        prepare = next(tool for tool in captured if tool.__name__ == "prepare_end_call")
        llm = SimpleNamespace(_sync_registered_tool_handlers=lambda tools: None, push_frame=AsyncMock())
        await prepare(SimpleNamespace(result_callback=callback, llm=llm), "conversation_complete")
        farewell_frame = llm.push_frame.call_args.args[0]
        self.assertFalse(farewell_frame.append_to_context)
        self.assertEqual(farewell_frame.metadata["diagnostic_response_id"], s.finish_response_id)
        self.assertTrue(s.finish_response_id.startswith("farewell-"))
        self.assertTrue(s.playback.finish_requested)
        self.assertFalse(s.playback.can_hangup)
        self.assertIn(tag, s.playback.pending)
        ws.send_text.assert_not_awaited()
        self.assertFalse(callback.call_args.kwargs["properties"].run_llm)
        self.assertEqual(callback.call_args.args[0], {"ok": True, "transport_will_say_farewell": True})
        self.assertEqual([e["name"] for e in s.evidence.events if e["event"] == "function_call"], ["get_call_context", "end_call"])

    async def test_both_provider_graphs_construct_with_real_pipecat_services(self):
        # Real constructors and bundled ONNX models; runner mocked to avoid any
        # provider connections or telephone calls in deterministic tests.
        for provider in ("openai", "openai_mini", "gemini", "gemini_proxyapi"):
            s = session()
            s.provider = provider; s.prompt = "Test"; s.context = {}; s.voice_id = "test"; s.tts_model = "eleven_v4_turbo"
            runner = SimpleNamespace(add_workers=AsyncMock(), run=AsyncMock(), cancel=AsyncMock())
            with patch.dict("os.environ", {"OPENAI_API_KEY": "test", "GEMINI_API_KEY": "test", "PROXYAPI_API_KEY": "test", "ELEVENLABS_API_KEY": "test"}), patch("pipeline.WorkerRunner", return_value=runner), patch("pipeline.GatedRealtime", wraps=GatedRealtime) as realtime:
                await run_pipeline(s, SimpleNamespace())
            runner.add_workers.assert_awaited_once()
            if provider in ("openai", "openai_mini"):
                realtime.assert_called_once()
                settings = realtime.call_args.kwargs["settings"]
                self.assertEqual(settings.model, "gpt-realtime-2.1-mini" if provider == "openai_mini" else "gpt-realtime-2.1")
                self.assertEqual(settings.session_properties.output_modalities, ["text"])
                self.assertIs(settings.session_properties.audio.input.turn_detection, False)
                self.assertEqual(settings.session_properties.audio.input.transcription.model, "gpt-live-transcribe")
                configuration = next(e for e in s.evidence.events if e["event"] == "pipeline_configuration")
                self.assertEqual(configuration["settings"]["vad_stop_ms"], 200)
            else:
                realtime.assert_not_called()
            runner.run.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
