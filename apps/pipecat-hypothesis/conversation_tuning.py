"""Per-call experimental profiles and bounded tool work; no provider imports."""
from dataclasses import dataclass
import os


def interruption_default():
    value = int(os.getenv("PIPECAT_INTERRUPTION_MS", "850"))
    if value not in (400, 600, 850):
        raise ValueError("PIPECAT_INTERRUPTION_MS must be 400, 600 or 850")
    return value


def speech_default():
    value = os.getenv("PIPECAT_SPEECH_MODE", "fast_sentence")
    if value not in ("sentence", "fast_sentence"):
        raise ValueError("PIPECAT_SPEECH_MODE must be sentence or fast_sentence")
    return value


@dataclass
class ToolTurnBudget:
    turn: int = -1
    attempts: int = 0
    failures: int = 0
    blocked: bool = False
    max_attempts: int = 6
    max_failures: int = 2

    def is_blocked(self, turn):
        return self.turn == turn and self.blocked

    def begin(self, turn):
        if turn < self.turn:
            return False
        if turn != self.turn:
            self.turn, self.attempts, self.failures, self.blocked = turn, 0, 0, False
        if self.blocked:
            return False
        self.attempts += 1
        if self.attempts > self.max_attempts:
            self.blocked = True
            return False
        return True

    def on_user_turn(self, turn):
        if turn > self.turn:
            self.turn, self.attempts, self.failures, self.blocked = turn, 0, 0, False

    def reject(self, turn):
        # A late result cannot consume the next customer's budget.
        if turn != self.turn:
            return False
        self.failures += 1
        if self.failures >= self.max_failures:
            self.blocked = True
        return self.blocked
