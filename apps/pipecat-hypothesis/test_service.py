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
