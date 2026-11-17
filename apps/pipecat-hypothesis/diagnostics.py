"""Persistent, authenticated hypothesis diagnostics. Never stores transport secrets."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import dataclasses
import math
from enum import Enum
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
SECRET_FIELDS = {"api_key", "apikey", "authorization", "password", "token", "stream_token", "webhook_token", "xi-api-key", "x-goog-api-key"}
ACTIVE = {"prepared", "dialing", "connected", "ending"}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def trace_id(value):
    value = str(value).removeprefix("pc-")
    if not UUID.fullmatch(value):
        raise ValueError("Invalid diagnostic ID")
    return value.lower()


def redact(value):
    if isinstance(value, Enum):
        return redact(value.value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return redact(dataclasses.asdict(value))
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in SECRET_FIELDS or lowered.endswith("_api_key"):
                result[key] = "[redacted]"
            elif lowered in {"audio", "data"} and isinstance(item, str) and len(item) > 512:
                result[key] = {"omitted": "binary/base64 payload", "encodedLength": len(item)}
            else:
                result[key] = redact(item)
        return result
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        for key, secret in os.environ.items():
            if len(secret) >= 8 and (key.endswith("_API_KEY") or key.endswith("_TOKEN") or key.endswith("_SECRET")):
                value = value.replace(secret, "[redacted]")
        def scrub_url(match):
            try:
                parsed = urlsplit(match.group())
                host = parsed.netloc.rsplit("@", 1)[-1]
                query = [(key, "[redacted]" if key.lower() in SECRET_FIELDS or key.lower() in {"key", "signature"} else item)
                         for key, item in parse_qsl(parsed.query, keep_blank_values=True)]
                return urlunsplit((parsed.scheme, host, parsed.path, urlencode(query), parsed.fragment))
            except ValueError:
                return "[redacted URL]"
        return re.sub(r"(?:https?|wss?)://[^\s\"<>]+", scrub_url, value)
    if hasattr(value, "model_dump"):
        return redact(value.model_dump(exclude_none=True))
    if isinstance(value, bytes):
        return {"omitted": "binary", "bytes": len(value)}
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return {"objectType": type(value).__name__}


def transcript(events):
    messages = {}
    for event in events:
        kind = event.get("event")
        if kind not in {"user_transcript", "assistant_partial", "assistant_response", "assistant_spoken"}:
            continue
        role = "user" if kind == "user_transcript" else "assistant"
        key = (event.get("response_id") if role == "assistant" else event.get("item_id")) or event.get("item_id") or f"{role}-{event.get('turn', 0)}"
        if kind == "assistant_spoken":
            # Keep playout text separately from model-generated text.
            key = "spoken-" + key
        old = messages.get(key, {})
        messages[key] = {**old, "id": key, "role": role, "text": event.get("text", ""),
                         "turn": event.get("turn", 0), "ms": old.get("ms", event.get("ms")),
                         "at": old.get("at", event.get("at")), "status": event.get("status", "partial" if kind == "assistant_partial" else "completed"),
                         "responseId": event.get("response_id"), "itemId": event.get("item_id"),
                         "source": "playout_words" if kind == "assistant_spoken" else "transcription" if role == "user" else "model",
                         "replyReference": event.get("reply_reference", old.get("replyReference"))}
    return list(messages.values())


def summarize(events):
    slow = []
    precise = any(e.get("event") == "response_first_text_ms" for e in events)
    precise_tts = any(e.get("event") == "response_tts_first_audio_ms" for e in events)
    distributions = {}
    for event in events:
        delay = event.get("latency_ms")
        if event.get("event") == "playback_duration_ms" or (precise and event.get("event") in {"llm_first_text_ms", "llm_total_ms"}):
            continue
        if precise_tts and event.get("event") == "tts_first_audio_ms":
            continue
        if isinstance(delay, (int, float)):
            distributions.setdefault(event["event"], []).append(delay)
        if isinstance(delay, (int, float)) and delay >= 1500:
            slow.append({"event": event["event"], "turn": event.get("turn"), "latencyMs": delay,
                         "seq": event.get("seq"), "responseId": event.get("response_id")})
    references = [e for e in events if e.get("event") == "reply_reference"]
    percentiles = {}
    for name, values in distributions.items():
        values = sorted(values)
        percentiles[name] = {"samples": len(values), "medianMs": round((values[(len(values)-1)//2] + values[len(values)//2]) / 2, 2),
            "p95Ms": values[math.ceil(len(values) * 0.95) - 1], "smallSample": len(values) < 20}
    return {"eventCount": len(events), "latencies": percentiles, "slowStages": sorted(slow, key=lambda row: row["latencyMs"], reverse=True)[:30],
            "errors": [e for e in events if "failed" in e.get("event", "") or e.get("event") in {"pipeline_error", "provider_error", "provider_error_received"}],
            "longReplyPauses": [e for e in references if (e.get("pause_ms") or 0) >= 3000],
            "contextDeletions": [e for e in events if e.get("event") == "provider_item_deleted"],
            "interpretation": "Timing/reference data only; semantic reply matching is not an LLM verdict."}


class TraceArchive:
    def __init__(self, root=None):
        self.root = Path(root or os.environ.get("PIPECAT_LOG_DIR", "../../storage/pipecat-hypothesis"))
        self.root.mkdir(parents=True, exist_ok=True)

    def metadata(self, identifier, data):
        identifier = trace_id(identifier)
        path = self.root / f"{identifier}.meta.json"
        temp = self.root / f"{identifier}.meta.tmp"
        temp.write_text(json.dumps(redact(data), ensure_ascii=False))
        temp.replace(path)

    def append(self, identifier, event):
        with (self.root / f"{trace_id(identifier)}.jsonl").open("a") as stream:
            stream.write(json.dumps(redact(event), ensure_ascii=False) + "\n")

    def read(self, identifier):
        identifier = trace_id(identifier)
        events_path = self.root / f"{identifier}.jsonl"
        meta_path = self.root / f"{identifier}.meta.json"
        if not events_path.exists() and not meta_path.exists():
            raise FileNotFoundError(identifier)
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        events = []
        if events_path.exists():
            for line in events_path.read_text().splitlines():
                try:
                    event = json.loads(line)
                    event.setdefault("seq", len(events) + 1)
                    events.append(event)
                except json.JSONDecodeError:
                    # A crash may leave an incomplete final append.
                    continue
        legacy = not meta
        if legacy:
            preflight = next((e.get("result", {}) for e in events if e.get("event") == "preflight"), {})
            states = [e.get("state") for e in events if e.get("event") == "vox_lifecycle"]
            meta = {"id": identifier, "diagnosticId": "pc-" + identifier, "schemaVersion": 1,
                    "provider": preflight.get("provider", "unknown"), "model": preflight.get("model", "unknown"),
                    "ttsModel": preflight.get("ttsModel", "unknown"), "createdAt": events_path.stat().st_mtime,
                    "status": states[-1] if states and states[-1] not in ACTIVE else "unknown",
                    "limitations": ["Старый журнал: текст агента и снимки контекста не записывались. Восстановить их задним числом невозможно."]}
        meta["legacy"] = legacy
        return {**meta, "events": events, "eventCount": len(events), "transcript": transcript(events), "summary": summarize(events)}

    def history(self, limit=30):
        ids = {p.stem for p in self.root.glob("*.jsonl") if UUID.fullmatch(p.stem)}
        ids.update(p.name.removesuffix(".meta.json") for p in self.root.glob("*.meta.json") if UUID.fullmatch(p.name.removesuffix(".meta.json")))
        records = []
        for identifier in ids:
            path = self.root / f"{identifier}.meta.json"
            record = json.loads(path.read_text()) if path.exists() else self.read(identifier)
            if "kind" not in record:
                name = record.get("planName") or ""
                is_probe = name.startswith(("Текстовая регрессия:", "Синтетическая проверка")) or record.get("configuration", {}).get("prompt") == "Проверка подготовки TTS без звонка"
                record["kind"] = "probe" if is_probe else "call"
            records.append({k: record.get(k) for k in ("id", "diagnosticId", "provider", "model", "ttsModel", "status", "createdAt", "eventCount", "legacy", "planName", "instanceId", "finalized", "kind")})
        return sorted(records, key=lambda row: row.get("createdAt") or 0, reverse=True)[:limit]
