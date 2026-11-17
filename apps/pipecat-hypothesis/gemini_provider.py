"""Explicit Gemini routes: credentials never fall back between providers."""
import os
from urllib.parse import urlparse
from google.genai.types import HttpOptions
from pipecat.services.google.llm import GoogleLLMService

MODEL = "gemini-3.8-flash"
GEMINI_PROVIDERS = ("gemini", "gemini_proxyapi")
STT_INSTRUCTION = "Точно расшифруй речь на русском. Только дословная расшифровка, без ответа собеседнику. При тишине верни пустую строку."


def gemini_connection(provider):
    if provider == "gemini_proxyapi":
        base = os.environ.get("PIPECAT_GEMINI_PROXYAPI_BASE_URL", "https://api.proxyapi.ru").rstrip("/")
        parsed = urlparse(base)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Gemini ProxyAPI base URL must use HTTPS without credentials")
        return {"api_key": os.environ["PROXYAPI_API_KEY"], "http_options": HttpOptions(base_url=base, api_version="v1beta", timeout=30000)}
    if provider == "gemini":
        return {"api_key": os.environ["GEMINI_API_KEY"]}
    raise ValueError("Unsupported Gemini provider")


def create_gemini_service(provider, max_tokens=1024):
    return GoogleLLMService(**gemini_connection(provider), settings=GoogleLLMService.Settings(
        model=MODEL, max_tokens=max_tokens,
        thinking=GoogleLLMService.ThinkingConfig(thinking_level="low"),
    ))
