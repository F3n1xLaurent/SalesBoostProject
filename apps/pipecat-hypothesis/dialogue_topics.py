"""Conservative routing hints. Never writes business facts or approves closing."""
import re

PATTERNS = {
    "mileage": r"пробег|километр",
    "ownership": r"владел|владени|сколько.{0,25}(?:ездил|пользовал)",
    "rust": r"порог|корроз|ржав|гнил",
    "accidents": r"дтп|авари",
    "discount": r"скид|торг",
    "spare": r"запаск|запасно[её] колес",
    "documents": r"документ|птс",
    "availability": r"актуальн|наличи|прода[её]тся|в\s+продаже|не ушла",
}
ANSWERS = {
    "mileage": r"пробег|километр|тысяч|\d",
    "ownership": r"год|лет|месяц|недел",
    "rust": r"порог|корроз|ржав|гнил|целые|целы",
    "accidents": r"дтп|авари|не было|не-не|были",
    "discount": r"скид|торг|салон|рубл|процент|можно|нельзя",
    "availability": r"актуальн|наличи|прода[её]тся|в\s+продаже|продан|ушла",
    "spare": r"запаск|запасно[её] колес|имеется|имеются",
    "documents": r"документ|птс|оригинал|дубликат",
}


def topic(text):
    return next((key for key, pattern in PATTERNS.items() if re.search(pattern, text, re.I)), None)


def requests_customer_name(text):
    """Personal address/identity requests, not enquiries about another employee."""
    patterns=(
        r'\bкак\s+(?:вас|тебя)\s+(?:зовут|звать|представить)\b',
        r'\bкак\s+(?:(?:я|мы)\s+)?(?:(?:могу|можем|можно)\s+)?к\s+(?:вам|тебе)\s+(?:(?:можно|могу|можем)\s+)?обращаться\b',
        r'\bкак\s+(?:(?:я|мы)\s+)?(?:могу|можем|можно)\s+обращаться\b',
        r'\bк\s+кому\s+(?:(?:я|мы)\s+)?(?:могу|можем|можно)\s+обращаться\b',
        r'\bс\s+кем\s+(?:(?:я|мы)\s+)?(?:говорю|говорим|разговариваю|разговариваем|общаюсь|общаемся)\b',
        r'\b(?:ваше|тво[её])\s+имя\b',
        r'\b(?:назовите|скажите|напомните)\s+(?:(?:пожалуйста|сво[её]|ваше)\s+){0,2}имя\b',
        r'\bпредставьтесь\b',
    )
    return any(re.search(pattern,text,re.I) for pattern in patterns)


class DialogueTopics:
    def __init__(self, prompt):
        self.required=[]
        for line in prompt.splitlines():
            match=re.match(r"\s*(?:\d+[.)]\s*)?(.+?)\s*\[обязательная тема\]",line,re.I)
            if match:
                question=match[1].strip()
                key=topic(question) or "custom:"+str(len(self.required))
                if not any(r["key"]==key for r in self.required):
                    self.required.append({"key":key,"question":question})
        self.answers={}
        self.introduced=False
        self.name_requested=False
        self.manager_question=False

    def heard(self,text,name):
        if re.search(r"\b(?:меня зовут|я)\s+"+re.escape(name)+r"\b",text,re.I):
            self.introduced=True

    def user(self,text,turn,open_question):
        self.name_requested=requests_customer_name(text)
        self.manager_question="?" in text
        # Corrections reopen the affected topic; an old hint is no longer valid.
        if re.search(r"ошиб|поправ|неактуальн|не актуальн",text,re.I):
            key=topic(text)
            if key:self.answers.pop(key,None)
        if not open_question or not text.strip():return
        questions=re.findall(r"[^.!?\n]*\?",open_question.get("text",""))
        if not questions:return
        question=questions[-1].strip()
        key=topic(question)
        if not key:return
        normalized=" ".join(re.sub(r"[^а-яё\w ]"," ",text.lower()).split())
        acknowledgement=normalized in {"да","нет","да да","да всё верно","да да всё верно","всё верно","верно","конечно","нет не было"}
        unknown=bool(re.search(r"не знаю|нет.{0,12}информац|не могу сказать|неизвест|нужно уточнить",text,re.I))
        if re.search(r"подожд|уточню|сейчас проверю",text,re.I) and not unknown:return
        # A question on its own is not an answer. Accept an explicit declarative
        # first clause before a follow-up question, e.g. availability + name.
        clauses=re.findall(r"[^.!?]+[.!?]?",text)
        evidence=" ".join(c for c in clauses if not c.rstrip().endswith("?"))
        explicit=bool(evidence.strip() and re.search(ANSWERS.get(key,r"(?!)"),evidence,re.I))
        if key=="mileage" and re.search(r"цен|рубл|стоит",evidence,re.I) and not re.search(r"пробег|километр",evidence,re.I):
            explicit=False
        if unknown or explicit or (acknowledgement and key!="ownership"):
            self.answers[key]={"status":"unknown" if unknown else "answered","evidence":text,"turn":turn,
                "question":question,"source":"conservative_transcript_routing_hint_not_crm_fact"}

    def pending(self):
        return [r for r in self.required if r["key"] not in self.answers]

    def safe_next_question(self):
        pending=self.pending()
        return pending[0]["question"] if pending and not self.manager_question else None

    def snapshot(self):
        return {"introduced_phone_confirmed":self.introduced,"name_requested":self.name_requested,
            "answers":self.answers,"pending_required":self.pending(),
            "scope":"routing hints with quotes; unknown is not a verified fact"}
