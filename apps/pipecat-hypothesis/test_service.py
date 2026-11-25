import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import HTTPException
from fastapi.testclient import TestClient

import service


class ServiceTests(unittest.TestCase):
    def test_media_call_limit_is_configurable_bounded_and_logged(self):
        for configured,expected in [('900',900),('1200',1200),('30',60),('99999',1800)]:
            with self.subTest(configured=configured), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{'PIPECAT_LOG_DIR':directory,'PIPECAT_MAX_CALL_SECONDS':configured}):
                session=service.Session(id='abababab-abab-abab-abab-abababababab',provider='openai',tts_model='eleven_v4_turbo',voice_id='test',prompt='Synthetic',context={},to='')
                self.assertEqual(session.max_call_seconds,expected)
                self.assertEqual(session.archive.read(session.id)['maxCallSeconds'],expected)

    def test_mini_uses_openai_key_and_persists_exact_model_and_live_transcription(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test", "ELEVENLABS_API_KEY": "test"}, clear=True):
            service.validate(service.Options(provider="openai_mini", voiceId="test"))
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"PIPECAT_LOG_DIR": directory}):
            session = service.Session(id="abababab-abab-abab-abab-abababababab", provider="openai_mini",
                tts_model="eleven_v4_turbo", voice_id="test", prompt="Synthetic", context={}, to="")
            saved = session.archive.read(session.id)
            self.assertEqual(saved["model"], "gpt-realtime-2.1-mini")
            self.assertEqual(saved["reasoningEffort"], "low")
            self.assertEqual(saved["transcriptionModel"], "gpt-live-transcribe")
            self.assertFalse(saved["trimIdleAudio"])

    def test_reasoning_selection_is_validated_and_persisted_for_comparison(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            service.Options(voiceId="test", reasoningEffort="xhigh")
        self.assertEqual(service.Options(voiceId="test").reasoningEffort, "low")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"PIPECAT_LOG_DIR": directory}):
            session = service.Session(id="abababab-abab-abab-abab-abababababab", provider="openai", tts_model="eleven_v4_turbo",
                voice_id="test", prompt="Synthetic", context={}, to="", reasoning_effort="minimal")
            saved = session.archive.read(session.id)
            self.assertEqual(saved["reasoningEffort"], "minimal")
            self.assertEqual(saved["configuration"]["reasoningEffort"], "minimal")
            self.assertEqual(saved["transcriptionModel"], "gpt-live-transcribe")
            self.assertEqual(saved["configuration"]["transcriptionModel"], "gpt-live-transcribe")

    def test_transport_probe_requires_auth_and_is_single_use_without_dialing(self):
        with patch.dict(os.environ, {"PIPECAT_HYPOTHESIS_TOKEN": "x" * 32}):
            with TestClient(service.app) as client:
                self.assertEqual(client.post("/transport-probes").status_code, 401)
                with patch("service.start_call", new=AsyncMock()) as dial:
                    response = client.post("/transport-probes", headers={"Authorization": "Bearer " + "x" * 32})
                    probe = response.json()
                    with client.websocket_connect(f"/media/{probe['id']}?token={probe['token']}") as ws:
                        self.assertEqual(ws.receive_json()["event"], "transport_ready")
                        ws.send_json({"payload": "audio-probe"})
                        self.assertEqual(ws.receive_json(), {"event": "transport_echo", "payload": "audio-probe"})
                    self.assertNotIn(probe['id'], service.transport_probes)
                    dial.assert_not_called()

    def test_service_requires_separate_credentials(self):
        with patch.dict(os.environ, {"PIPECAT_HYPOTHESIS_TOKEN": "x" * 32}):
            with TestClient(service.app) as client:
                self.assertEqual(client.get("/health").status_code, 401)
                self.assertEqual(client.get("/health", headers={"Authorization": "Bearer wrong"}).status_code, 401)
                response = client.get("/health", headers={"Authorization": "Bearer " + "x" * 32})
                self.assertTrue(response.json()["isolated"])
                self.assertNotIn("token", response.text)

    def test_invalid_models_and_missing_gemini_key_fail_before_network(self):
        with self.assertRaises(HTTPException):
            service.validate(service.Options(provider="gemini-live", voiceId="v"))
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "test"}, clear=True):
            with self.assertRaises(HTTPException) as result:
                service.validate(service.Options(provider="gemini", voiceId="v"))
            self.assertIn("GEMINI_API_KEY", result.exception.detail)


class DialTests(unittest.IsolatedAsyncioTestCase):
    async def test_synthesis_probe_starts_and_flushes_the_selected_voice_like_runtime(self):
        from urllib.parse import urlparse,parse_qs
        sent=[]
        class Socket:
            close=AsyncMock()
            async def send(self,raw):sent.append(json.loads(raw))
            async def responses(self):
                self_test.assertEqual(len(sent),3)
                self_test.assertTrue(sent[1]['inputs'][0]['new_turn'])
                self_test.assertNotIn('flush',sent[1])
                self_test.assertEqual(sent[2],{'context_id':'probe','flush':True})
                yield json.dumps({'context_id':'probe','audio':'AQACAAMA'})
            def __aiter__(self):return self.responses()
        self_test=self
        with patch.dict(os.environ,{'ELEVENLABS_API_KEY':'synthetic-key'}), \
             patch('service.elevenlabs_proxy',return_value='socks5://proxy.test:1080'), \
             patch('service.connect',new=AsyncMock(return_value=Socket())) as opener:
            result=await service.probe_elevenlabs_synthesis(service.Options(voiceId='synthetic-voice',ttsModel='eleven_v4_turbo'))
        self.assertEqual(parse_qs(urlparse(opener.call_args.args[0]).query),{
            'model_id':['eleven_v4_turbo'],'output_format':['pcm_16000'],'sync_alignment':['true'],'language_code':['ru']})
        self.assertEqual(opener.call_args.kwargs['proxy'],'socks5://proxy.test:1080')
        self.assertEqual(sent[0]['voices'],['synthetic-voice'])
        self.assertEqual(sent[0]['voice_settings'],{'stability':0.5})
        self.assertEqual(sent[1]['inputs'][0]['voice_id'],'synthetic-voice')
        self.assertTrue(result['synthesisProbed'])
        self.assertGreaterEqual(result['ttsFirstAudioMs'],0)

    async def test_synthesis_probe_rejects_final_context_without_audio_immediately(self):
        class Socket:
            close=AsyncMock();send=AsyncMock()
            async def responses(self):
                yield json.dumps({'context_id':'probe','is_final':True})
                raise AssertionError('Must not wait on a context that is already closed')
            def __aiter__(self):return self.responses()
        with patch.dict(os.environ,{'ELEVENLABS_API_KEY':'synthetic-key'}), \
             patch('service.connect',new=AsyncMock(return_value=Socket())):
            with self.assertRaises(HTTPException) as result:
                await service.probe_elevenlabs_synthesis(service.Options(voiceId='synthetic-voice'))
        self.assertIn('без аудио',result.exception.detail)

    async def test_synthesis_probe_never_treats_an_open_socket_or_malformed_audio_as_success(self):
        for event in (None,{'audio':'AQ=='},{'error':'quota_exceeded'}):
            class Socket:
                close=AsyncMock();send=AsyncMock()
                async def responses(self):
                    if event is not None:yield json.dumps(event)
                def __aiter__(self):return self.responses()
            with self.subTest(event=event),patch.dict(os.environ,{'ELEVENLABS_API_KEY':'synthetic-key'}), \
                 patch('service.connect',new=AsyncMock(return_value=Socket())):
                with self.assertRaises(HTTPException):
                    await service.probe_elevenlabs_synthesis(service.Options(voiceId='synthetic-voice'))

    async def test_production_dial_requests_recording_and_preserves_start_scenarios_session_id(self):
        for payload,expected in [
            ({'result':1,'call_session_history_id':123},123),
            ({'result':[{'call_session_history_id':456}]},456),
            ({'result':{'call_session_history_id':789}},789),
            ({'result':1},999),
        ]:
            with self.subTest(payload=payload):
                session=SimpleNamespace(id='test',to='+79990000000',token='test',production=True,
                    max_call_seconds=900,dialogue_mode='semantic',production_vox_id=999,
                    evidence=MagicMock(),persist=MagicMock())
                client=AsyncMock()
                client.post.return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:payload)
                with patch.dict(os.environ,{'VOX_ACCOUNT_ID':'test','VOX_API_KEY':'test','VOX_APP_ID':'test'}), \
                     patch('service.select_background',new=AsyncMock(return_value=None)), \
                     patch('service.select_breath',new=AsyncMock(return_value=None)), \
                     patch('service.voximplant_http_options',return_value={}), \
                     patch('service.httpx.AsyncClient') as constructor:
                    constructor.return_value.__aenter__=AsyncMock(return_value=client)
                    constructor.return_value.__aexit__=AsyncMock(return_value=False)
                    await service.dial_pipecat(session,'https://test.invalid/pipecat')
                data=client.post.call_args.kwargs['data']
                self.assertTrue(json.loads(data['script_custom_data'])['record_call'])
                self.assertEqual(data['script_name'],'voice_pipecat')
                self.assertEqual(session.production_vox_id,expected)

    async def test_already_disconnected_media_socket_does_not_raise_during_finalization(self):
        from fastapi import WebSocketDisconnect
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'PIPECAT_LOG_DIR':directory}):
            session=service.Session(id='abababab-abab-abab-abab-abababababab',provider='openai',tts_model='eleven_v4_turbo',voice_id='test',prompt='Synthetic',context={},to='')
            websocket=SimpleNamespace(accept=AsyncMock(),close=AsyncMock(side_effect=WebSocketDisconnect(code=1006)))
            with patch('service.media_session',return_value=session),patch('pipeline.run_pipeline',new=AsyncMock()),patch('service.release_call_audio',new=AsyncMock()):
                await service.media(websocket,session.id,'test')
            self.assertTrue(session.finalized)
            self.assertEqual(session.status,'disconnected')
            self.assertTrue(any(event['event']=='session_ended' for event in session.evidence.events))

    async def test_preflight_names_websocket_provider_and_status_without_retrying_auth_failure(self):
        from websockets.exceptions import InvalidStatus
        from websockets.http11 import Response
        from websockets.datastructures import Headers
        with patch("service.connect", new=AsyncMock(side_effect=InvalidStatus(Response(403, "Forbidden", Headers())))) as opener:
            with self.assertRaises(HTTPException) as result:
                async with service.preflight_websocket("ElevenLabs TTS", "wss://example.test"):
                    self.fail("A rejected handshake cannot yield a socket")
            self.assertIn("ElevenLabs TTS", result.exception.detail)
            self.assertIn("HTTP 403", result.exception.detail)
            self.assertEqual(opener.await_count, 1)

    async def test_preflight_retries_transient_handshake_but_never_replays_synthesis(self):
        from websockets.exceptions import InvalidStatus
        from websockets.http11 import Response
        from websockets.datastructures import Headers
        socket = SimpleNamespace(close=AsyncMock())
        with patch("service.connect", new=AsyncMock(side_effect=[InvalidStatus(Response(502, "Bad Gateway", Headers())), socket])) as opener:
            with patch("service.asyncio.sleep", new=AsyncMock()):
                with self.assertRaises(HTTPException):
                    async with service.preflight_websocket("ElevenLabs TTS", "wss://example.test"):
                        raise TimeoutError()
            self.assertEqual(opener.await_count, 2)
            socket.close.assert_awaited_once()

    async def test_websocket_connect_timeout_retries_handshake_without_replaying_synthesis(self):
        socket=SimpleNamespace(close=AsyncMock(),send=AsyncMock())
        with patch('service.connect',new=AsyncMock(side_effect=[TimeoutError(),socket])) as opener,patch('service.asyncio.sleep',new=AsyncMock()):
            async with service.preflight_websocket('ElevenLabs TTS','wss://example.test',proxy='socks5://test.invalid:1080') as ready:
                await ready.send('one synthetic probe')
        self.assertEqual(opener.await_count,2)
        socket.send.assert_awaited_once_with('one synthetic probe')
        socket.close.assert_awaited_once()

    async def test_failed_preflight_has_persistent_id_and_provider_reason(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"PIPECAT_LOG_DIR": directory}):
            with patch("service.check_compatibility", new=AsyncMock(side_effect=HTTPException(503, "ElevenLabs TTS: WebSocket HTTP 403."))):
                with self.assertRaises(HTTPException) as result:
                    await service.preflight(service.Options(voiceId="test"))
            records = list(Path(directory).glob("pf-*.json"))
            self.assertEqual(len(records), 1)
            record = json.loads(records[0].read_text())
            self.assertIn(record["id"], result.exception.detail)
            self.assertEqual(record["status"], "failed")
            self.assertIn("ElevenLabs TTS", record["reason"])
            self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)

    async def test_http_network_failure_names_provider_without_exposing_exception_message(self):
        import httpx
        failure = httpx.ConnectError("private proxy details", request=httpx.Request("GET", "https://api.elevenlabs.io/v1/models"))
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"PIPECAT_LOG_DIR": directory}):
            with patch("service.check_compatibility", new=AsyncMock(side_effect=failure)):
                with self.assertRaises(HTTPException) as result:
                    await service.preflight(service.Options(voiceId="test"))
            self.assertIn("ElevenLabs", result.exception.detail)
            self.assertIn("ConnectError", result.exception.detail)
            self.assertNotIn("private proxy details", result.exception.detail)

    async def test_decisions_connect_timeout_is_not_mislabeled_as_openai(self):
        import httpx
        request = httpx.Request("POST", "https://api.proxyapi.ru/v1/decisions")
        failures = [httpx.ConnectTimeout("private connection details", request=request),
                    httpx.HTTPStatusError("private response", request=request, response=httpx.Response(503, request=request))]
        for failure in failures:
            with self.subTest(error=type(failure).__name__), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"PIPECAT_LOG_DIR": directory}):
                with patch("service.check_compatibility", new=AsyncMock(side_effect=failure)):
                    with self.assertRaises(HTTPException) as result:
                        await service.preflight(service.Options(provider="openai", voiceId="test"))
                self.assertIn("Decisions ProxyAPI", result.exception.detail)
                self.assertNotIn("openai", result.exception.detail)
                self.assertNotIn("private", result.exception.detail)
                record = json.loads(next(Path(directory).glob("pf-*.json")).read_text())
                self.assertIn("Decisions ProxyAPI", record["reason"])

    async def test_dial_uses_dedicated_scenario_and_keeps_media_secret_private(self):
        response = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"result": 1})
        client = SimpleNamespace(post=AsyncMock(return_value=response))
        context = MagicMock()
        context.__aenter__ = AsyncMock(return_value=client)
        context.__aexit__ = AsyncMock(return_value=False)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "PIPECAT_HYPOTHESIS_PUBLIC_URL": "https://prototype.example", "VOX_ACCOUNT_ID": "test", "VOX_API_KEY": "test",
            "VOX_APP_ID": "test", "PIPECAT_LOG_DIR": directory,
        }), patch("service.preflight", new=AsyncMock(return_value={"checks": ["passed"]})), patch("service.prepare_call_audio", new=AsyncMock()) as ready, patch("service.httpx.AsyncClient", return_value=context), patch('service.select_background',new=AsyncMock(return_value={'url':'https://prototype.example/background/test.wav?token=signed','volume':.2})):
            service.sessions.clear()
            result = await service.start_call(service.Call(to="+79991234567", voiceId="v", prompt="Test"))
            data = client.post.call_args.kwargs["data"]
            ready.assert_awaited_once()
            self.assertEqual(data["script_name"], "voice_pipecat_hypothesis")
            self.assertEqual(data["rule_name"], "voice_pipecat_hypothesis_rule")
            custom = json.loads(data["script_custom_data"])
            self.assertIn("/media/", custom["stream_url"])
            self.assertEqual(custom['background_audio']['volume'],.2)
            self.assertTrue(custom['background_audio']['url'].startswith('https://prototype.example/background/'))
            self.assertNotIn("token", result)
            self.assertNotIn("prompt", result)
            self.assertNotIn("test", result["id"])
            s = service.sessions[result["id"]]
            self.assertIsNone(service.media_session(s.id, "wrong"))
            self.assertIs(service.media_session(s.id, s.token), s)
            s.created = time.time() - 400
            self.assertIsNone(service.media_session(s.id, s.token))
            self.assertEqual(len(list(Path(directory).glob("*.jsonl"))), 1)
            service.sessions.clear()

    async def test_failed_preflight_never_dials(self):
        with patch.dict(os.environ, {"PIPECAT_HYPOTHESIS_PUBLIC_URL": "https://prototype.example", "VOX_ACCOUNT_ID": "test", "VOX_API_KEY": "test", "VOX_APP_ID": "test"}), patch("service.preflight", new=AsyncMock(side_effect=HTTPException(503, "Model unavailable"))), patch("service.httpx.AsyncClient") as client:
            with self.assertRaises(HTTPException):
                await service.start_call(service.Call(to="+79991234567", voiceId="v", prompt="Test"))
            client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
