import os
import unittest
from unittest.mock import patch
from gemini_provider import gemini_connection, create_gemini_service, MODEL
from service import Options, validate


class GeminiProviderTests(unittest.TestCase):
    def test_proxyapi_uses_its_own_key_and_native_google_format(self):
        with patch.dict(os.environ, {"PROXYAPI_API_KEY": "proxy-key", "GEMINI_API_KEY": "google-key"}, clear=True):
            connection = gemini_connection("gemini_proxyapi")
            self.assertEqual(connection["api_key"], "proxy-key")
            self.assertEqual(connection["http_options"].base_url, "https://api.proxyapi.ru")
            self.assertEqual(connection["http_options"].api_version, "v1beta")
            native = gemini_connection("gemini")
            self.assertEqual(native["api_key"], "google-key")

    def test_proxyapi_needs_no_google_key_and_never_falls_back_to_it(self):
        with patch.dict(os.environ, {"PROXYAPI_API_KEY": "test", "ELEVENLABS_API_KEY": "test"}, clear=True):
            validate(Options(provider="gemini_proxyapi", voiceId="voice"))
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test", "ELEVENLABS_API_KEY": "test"}, clear=True):
            with self.assertRaises(Exception) as result:
                validate(Options(provider="gemini_proxyapi", voiceId="voice"))
            self.assertIn("PROXYAPI_API_KEY", result.exception.detail)

    def test_credentials_cannot_be_embedded_in_endpoint(self):
        for base in ("http://example.com", "https://user:password@example.com", "https://example.com?key=secret"):
            with patch.dict(os.environ, {"PROXYAPI_API_KEY": "test", "PIPECAT_GEMINI_PROXYAPI_BASE_URL": base}):
                with self.assertRaises(ValueError):
                    gemini_connection("gemini_proxyapi")

    def test_model_is_preserved_with_low_thinking(self):
        with patch.dict(os.environ, {"PROXYAPI_API_KEY": "test"}), patch("gemini_provider.GoogleLLMService") as service:
            create_gemini_service("gemini_proxyapi")
            self.assertEqual(service.call_args.kwargs["api_key"], "test")
            self.assertEqual(service.Settings.call_args.kwargs["model"], MODEL)
            service.ThinkingConfig.assert_called_once_with(thinking_level="low")


if __name__ == "__main__":
    unittest.main()
