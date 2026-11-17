"""Dependency-free policy shared by the real pipeline and deterministic checks."""
from dataclasses import dataclass, field
import re
import time
from diagnostics import utc_now, redact
from array import array
from conversation import ConversationMemory, DeliveryLedger

TTS_MODELS = ("eleven_v3", "eleven_v4", "eleven_v4_turbo")
OPENAI_PROVIDERS = ("openai", "openai_mini")
PROVIDERS = {"openai": "gpt-realtime-2.1", "openai_mini": "gpt-realtime-2.1-mini", "gemini": "gemini-3.8-flash", "gemini_proxyapi": "gemini-3.8-flash"}
REALTIME_TRANSCRIPTION_MODEL = "gpt-live-transcribe"
SUSTAINED_MS = 850


def realtime_transcription_config(model=REALTIME_TRANSCRIPTION_MODEL):
    return {"model": model, **({"languages": ["ru"]} if model == "gpt-live-transcribe" else {"language": "ru"})}


def is_backchannel(text: str, duration_ms: float) -> bool:
    words = re.findall(r"[\w]+", text.lower(), flags=re.UNICODE)
    return (0 < duration_ms < SUSTAINED_MS and 0 < len(words) <= 3
            and all(word in {"угу", "ага", "мгм", "uh", "huh", "mhm"} for word in words))


def is_overlap_fragment(text: str, duration_ms: float) -> bool:
    """A short grammatical prefix alone cannot justify clearing agent audio.

    This does not suppress complete short answers or stop commands. The raw
    transcript remains in diagnostics/provider history for later context.
    """
    words=re.findall(r'[\w]+',text.casefold(),flags=re.UNICODE)
    return (0 <= duration_ms < SUSTAINED_MS and 0 < len(words) <= 3 and
            all(word in {'вы','ты','я','мы','он','она','они','это','и','а','но','ну','в','на','по','к','с','если',
                         'you','i','we','the','and','but','if'} for word in words))


@dataclass
class Playback:
    """Only VoxEngine acknowledgements confirm playout, never a local timer."""
    counter: int = 0
    active: str | None = None
    pending: set[str] = field(default_factory=set)
    sealed: set[str] = field(default_factory=set)
    generated: bool = False
    synthesizing: bool = False
    finish_requested: bool = False
    had_audio: bool = False
    last_ack: str | None = None

    def begin(self) -> str:
        self.counter += 1
        self.active = f"pc-{self.counter}"
        self.pending.add(self.active)
        self.had_audio = True
        return self.active

    def seal(self) -> str | None:
        tag, self.active = self.active, None
        if tag:
            self.sealed.add(tag)
        return tag

    def acknowledge(self, tag: str) -> bool:
        if tag not in self.pending or tag not in self.sealed:
            return False
        self.pending.remove(tag)
        self.sealed.remove(tag)
        self.last_ack = tag
        return True

    def interrupt(self) -> None:
        # A cancelled segment's late mediaended must never drain a newer one.
        self.active = None
        self.pending.clear()
        self.sealed.clear()
        self.finish_requested = False
        self.generated = False
        self.synthesizing = False
        self.last_ack = None

    @property
    def busy(self) -> bool:
        return self.generated or self.synthesizing or bool(self.pending)

    @property
    def can_hangup(self) -> bool:
        return (self.finish_requested and self.had_audio and self.last_ack is not None
                and not self.busy)


class Evidence:
    def __init__(self, emit=lambda event: None, clock=time.monotonic):
        self.events = []
        self.clock, self.emit = clock, emit
        self.started = clock()
        self.turn = 0
        self.output_turn = 0
        self.marks = {}
        self.turn_marks = {}
        self.sequence = 0
        self.messages = {}
        self.last_assistant_id = None
        self.last_played_id = None
        self.last_playback_end_ms = None
        self.current_response_id = None
        self.reply_references = {}
        self.audio_windows = {}
        self.memory = ConversationMemory()
        self.delivery = DeliveryLedger()
        self.response_text_at = {}
        self.response_audio_seen = set()

    def event(self, event_name, **data):
        self.sequence += 1
        event = redact({"event": event_name, "turn": self.turn, "seq": self.sequence, "at": utc_now(),
                 "ms": round((self.clock() - self.started) * 1000, 2), **data})
        self.events.append(event)
        self.events = self.events[-1000:]
        self.emit(event)
        return event

    def assistant(self, response_id, text, status="completed", **data):
        is_new = response_id not in self.messages
        self.messages[response_id] = {"response_id": response_id, "text": text, "status": status, "turn": self.output_turn, **data}
        if is_new and status != "cancelled":
            self.last_assistant_id = response_id
        return self.event("assistant_partial" if status == "partial" else "assistant_response", **self.messages[response_id])

    def reply_reference(self, turn):
        now_ms = (self.clock() - self.started) * 1000
        previous = self.messages.get(self.last_assistant_id)
        played = self.messages.get(self.last_played_id)
        questions = [m for m in self.messages.values() if "?" in m.get("text", "") and m.get("status") != "cancelled"][-3:]
        reference = {"previous_assistant": previous, "last_acknowledged_segment_assistant": played,
                     "candidate_question": questions[-1] if questions else None, "recent_questions": questions,
                     "pause_ms": None if self.last_playback_end_ms is None else round(now_ms - self.last_playback_end_ms, 2),
                     "association": "chronological/question-mark heuristic, not semantic classification",
                     "playback_scope": "pause since last phone-confirmed segment; response association uses active response at segment creation, not proof the full generated text was heard"}
        self.reply_references[turn] = reference
        self.event("reply_reference", turn=turn, **reference)
        return reference

    def audio(self, direction, data, sample_rate):
        now = self.clock()
        window = self.audio_windows.setdefault(direction, {"start": now, "last": now, "frames": 0, "bytes": 0, "max_gap_ms": 0, "peak": 0})
        window["max_gap_ms"] = max(window["max_gap_ms"], (now - window["last"]) * 1000)
        window["last"] = now
        window["frames"] += 1
        window["bytes"] += len(data)
        samples = array("h", data)
        window["peak"] = max(window["peak"], max((abs(value) for value in samples), default=0))
        if now - window["start"] >= 1:
            self.event("audio_window", direction=direction, frames=window["frames"], bytes=window["bytes"],
                       audio_ms=round(window["bytes"] / (sample_rate * 2) * 1000, 2),
                       window_ms=round((now - window["start"]) * 1000, 2), max_gap_ms=round(window["max_gap_ms"], 2), peak=window["peak"])
            del self.audio_windows[direction]

    def mark(self, name, turn=None):
        turn = self.turn if turn is None else turn
        self.marks[name] = self.clock()
        self.turn_marks[(turn, name)] = self.marks[name]
        self.event(name, turn=turn)

    def latency(self, name, since, turn=None):
        turn = self.turn if turn is None else turn
        start = self.turn_marks.get((turn, since))
        self.event(name, turn=turn, latency_ms=None if start is None else round((self.clock() - start) * 1000, 2))
