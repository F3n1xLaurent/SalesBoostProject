"""Small literal/narration guard, not a semantic quality judge."""
import re
from dialogue_topics import topic


class SpeechFilter:
    def __init__(self, memory=None, controller=None):
        self.buffer = ""
        self.spoken = ""
        self.removed = []
        self.memory = memory
        self.controller = controller
        self.question_emitted = False
        self.booking_removed = False
        self.pieces = []

    def feed(self, text="", final=False, collect_questions=False):
        self.pieces = []
        self.buffer += text
        output = ""
        while self.buffer:
            boundary = re.search(r"[.!?\n]", self.buffer)
            if not boundary and not final and (self.controller or len(self.buffer) < 200):
                break
            size = boundary.end() if boundary else len(self.buffer)
            sentence, self.buffer = self.buffer[:size], self.buffer[size:]
            marker = re.fullmatch(r"\s*[\[(]?\s*(?:молчание|тишина|пауза|silence)\s*[\])]?\s*[.!]?\s*", sentence, re.I)
            narration = re.search(r"у меня задача|сейчас уточню следующий|следующий важный момент|давайте подумаем над визитом|(?:сейчас|я).{0,70}(?:зафиксирую|завершу разговор|передам.{0,30}завершени)", sentence, re.I)
            narration = narration or re.search(r"перейду к (?:главному|следующему) вопросу|следующий вопрос (?:про|о)\b", sentence, re.I)
            narration = narration or re.search(r"(?:нужно|надо).{0,30}(?:корректно оформить|оформить запись)|доделаю вызов|уточню момент для визита|сейчас уточним точное время|(?:сейчас|я).{0,30}(?:отпрощусь|сделаю вызов)", sentence, re.I)
            # Describing how a reply is being produced is not the reply. Keep
            # ordinary first-person facts (e.g. responsibility for the car).
            if self.controller:
                narration = narration or re.search(r'\b(?:я|сейчас)\b.{0,35}\b(?:отвечаю|реагирую|формулирую|генерирую|озвучиваю)\b.{0,45}\b(?:вопрос\w*|предложени\w*|ответ\w*|реплик\w*)',sentence,re.I)
            state = getattr(self.memory, "topics", None)
            repeated_name = bool(state and state.introduced and not state.name_requested and
                re.fullmatch(r"\s*(?:меня зовут|я)\s+"+re.escape(self.memory.name)+r"\s*[.!]?\s*",sentence,re.I))
            if self.controller:
                memory=self.controller.s.evidence.memory
                repeated_name |= bool(not memory.topics.name_requested and re.search(r"\b(?:меня зовут|я)\s+"+re.escape(memory.name)+r"\b",sentence,re.I))
            if marker or narration or repeated_name:
                self.removed.append(sentence)
                continue
            booking_claim=bool(self.controller and '?' not in sentence and (
                re.search(r'\b(?:подъеду|приеду|встречаемся|буду у вас|планирую приехать)\b.{0,100}\b(?:сегодня|завтра|послезавтра|утром|вечером|половине дня|\d{1,2}:\d{2})\b',sentence,re.I)
                or re.search(r'\b(?:записан|записана)\b.{0,40}\b(?:визит|осмотр|завтра|сегодня|встреч)',sentence,re.I)))
            if booking_claim:
                self.booking_removed=True
                self.removed.append(sentence)
                continue
            native_question=('?' in sentence or bool(re.match(
                r'\s*(?:(?:а|и|ещ[её])\s+)?(?:подскажите|скажите|расскажите|уточните|пришлите|покажите|сколько\b|како(?:й|е|му|го|м)\b|как(?:ая|ие|ую|их|им|ими)\b|как\b(?!\s+(?:правило|раз|минимум|максимум)\b)|когда\b|где\b|куда\b|откуда\b|почему\b|зачем\b|(?:можно|есть|были|будет)\s+ли\b)',sentence,re.I)))
            if self.controller and native_question:
                if collect_questions:
                    self.pieces.append(('question',sentence))
                else:self.removed.append(sentence)
                continue
            if state and state.required and "?" in sentence:
                if self.question_emitted:
                    self.removed.append(sentence)
                    continue
                key = topic(sentence)
                next_question = state.safe_next_question() if not self.memory.visit_pending else None
                if key in state.answers and next_question:
                    self.removed.append(sentence)
                    sentence = next_question
                self.question_emitted = True
            output += sentence
            self.pieces.append(('text',sentence))
        self.spoken += output
        return output
