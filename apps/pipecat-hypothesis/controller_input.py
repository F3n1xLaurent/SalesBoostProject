"""Final ASR fragments retained until the controller finishes handling them.

Acoustic turns are not necessarily semantic turns. Arrival order is also not
speech order. Cancellation must not discard a sentence still being assembled.
"""
class ControllerInput:
    def __init__(self):
        self.fragments = {}

    def add(self, text, turn, question=None):
        self.fragments[turn] = {"text": text, "turn": turn, "question": question}

    def snapshot(self):
        return [dict(self.fragments[k]) for k in sorted(self.fragments)]

    def consume(self, batch):
        for row in batch:
            if self.fragments.get(row["turn"]) == row:
                del self.fragments[row["turn"]]
