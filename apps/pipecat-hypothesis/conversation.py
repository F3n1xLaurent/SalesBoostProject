"""Explicit prototype state; business facts always keep their user evidence."""
import json
import re
from dialogue_topics import DialogueTopics

HOURS = r"(?:двадцать\s+(?:один|одного|два|двум|три|тр[её]м)|одиннадцать|одиннадцати|двенадцать|двенадцати|тринадцать|тринадцати|четырнадцать|четырнадцати|пятнадцать|пятнадцати|шестнадцать|шестнадцати|семнадцать|семнадцати|восемнадцать|восемнадцати|девятнадцать|девятнадцати|двадцать|двадцати|десять|десяти|девять|девяти|восемь|восьми|семь|семи|шесть|шести|пять|пяти|четыре|четыр[её]м|три|тр[её]м|два|двум|один|одному|час|часу)"
CLOCK_HOUR = r"(?:(?:2[0-3]|1\d|0?\d)(?::[0-5]\d)?|" + HOURS + r"(?:\s+ноль\s+ноль)?)"
CLOCK = re.compile(r"\b(?:в|к)\s+(?:(?:часик(?:а|ов)?|часа?)\s+(?:в\s+)?"+CLOCK_HOUR+"|"+CLOCK_HOUR+r")(?![\w:])", re.I)
VISIT_CANCEL = re.compile(r"визит\w*.{0,20}отмен|не приед|не смогу приех|не планирую приезж", re.I)


def continuation_prefix(text):
    return re.sub(r"[^а-яё ]", "", text.lower()).strip() in {"давайте", "ну давайте", "слушайте", "ну слушайте"}


def legacy_adapt_prompt(prompt, name):
    # Replace transport instructions, retain the selected business scenario.
    prompt = re.sub(r"# Завершение разговора[^\n]*\n.*?(?=\n# |\Z)", "", prompt, flags=re.S)
    prompt = re.sub(r"[^.!?\n]*(?:skip_turn|send_dtmf|Finish call)[^.!?\n]*[.!?]?", "", prompt, flags=re.I)
    prompt = prompt.replace("используй отдельную процедуру завершения voicemail", 'молча вызови prepare_end_call с reason="voicemail" и точной цитатой автоответчика')
    return prompt + f"""

# Правила именно этого телефонного транспорта
Твоё имя: {name}. Сохраняй его весь звонок. Не придумывай другое имя при повторном приветствии.
{name} — это ты, а не сотрудник. Пока сотрудник сам не назвал своё имя, обращайся к нему на «вы», без имени. Представляйся «Я {name}», не обращайся к сотруднику собственным именем.
Сначала дождись осмысленного обращения живого человека. При просьбе подождать молчи до нового обращения.
Доступны только инструменты из текущей схемы API. Не изображай отсутствующие процедуры, нажатия кнопок и переводы.
Состояние CALL_STATE содержит факты с цитатами сотрудника и последний вопрос. Пауза не закрывает вопрос.
Короткий ответ после паузы соотнеси с последним открытым вопросом; при неоднозначности уточни, не меняя тему.
Непрозвучавшая часть прерванного ответа не считается услышанной. DELIVERY_NOTE явно отмечает неопределённость воспроизведения.
Для сохранения договорённости используй remember_call_fact с точной цитатой сотрудника и дословным значением из этой цитаты. Не преобразуй названное время и не записывай собственные догадки.
Если согласуется визит, сначала выясни день и время; они нужны только для договорённости о визите, не для отказа или перезвона.
Когда разговор завершён, вызови prepare_end_call с причиной. Этот ответ должен содержать ТОЛЬКО вызов инструмента, без текста. Не обещай «зафиксировать», не рассказывай о будущем прощании. Транспорт сам подтвердит договорённость, произнесёт одно прощание и завершит звонок после воспроизведения. Дополнительная финальная реплика от тебя не нужна.
Не произноси планы, этапы, «подведу разговор к финалу», «завершаю разговор», имена инструментов и служебные итоги.
После принятого prepare_end_call больше не говори. Транспорт сам дождётся фактического окончания воспроизведения.
Если CALL_STATE.visit_candidates содержит оба поля visit_day и visit_time, для согласия достаточно prepare_end_call(reason="visit_agreed"): backend сам возьмёт их точные цитаты. Не переписывай время цифрами и не добавляй отсутствующие поля. Если кандидатов нет, передай день и время вместе с их точными исходными цитатами. Не нужно отдельно вызывать remember_call_fact для каждого поля.
Одинокое «Давайте» не подтверждает конкретное время из предложенных вариантов. Дождись продолжения; если его нет, уточни время, не выбирая его за сотрудника.
Если нужно молчать, не генерируй текст, скобки, слова «молчание» или «пауза».

# Короткие реплики
Говори сразу собеседнику: одна короткая реакция и один конкретный вопрос. Обычная реплика — одно-два коротких предложения, ориентир до 25 слов; точные условия договорённости не сокращай.
Озвучиваемый текст — только по-русски. Не произноси английские названия полей или процедур: говори «день и время», а поля инструментов используй только в вызовах.
Название автомобиля назови только при первом знакомстве; далее «машина» или короткая модель, без повторения поколения, кода кузова и комплектации.
Вместо описания следующего шага сразу задай вопрос: «Пробег в объявлении актуальный?», «По порогам есть коррозия?», «ДТП были?», «Скидку можно обсудить?».
Не пересказывай каждый полученный ответ. Не добавляй предварительную служебную реплику перед основным ответом, даже отдельным message.
Держи порядок обязательных тем из плана: не пропускай ещё не закрытые темы и не повторяй уже закрытые.
CALL_STATE.dialogue_topics хранит уже раскрытые темы и pending_required. Не переспрашивай answered/unknown; unknown не означает известный факт. Прежде чем самому предлагать визит, проверь оставшиеся обязательные темы. На предложение или вопрос сотрудника сначала ответь по существу. Не повторяй представление, если introduced_phone_confirmed=true, кроме прямого повторного вопроса об имени.
CALL_STATE.visit_pending означает обсуждение визита: conversation_complete не заменяет visit_agreed. Если сотрудник предложил конкретное время с вопросом «удобно?», ответь по существу. При согласии используй visit_agreed с точными цитатами, при альтернативе уточни выбор.
Если предложенные сотрудником день и время подходят, достаточно принять предложение через visit_agreed. Не проси повторно подтвердить то же предложение без противоречия или неясности.
"""


def adapt_prompt(prompt, name, mode="compact"):
    if mode == "legacy":
        return legacy_adapt_prompt(prompt, name)
    if mode != "compact":
        raise ValueError("Unknown prompt mode")
    # Retain business data and required questions verbatim. Only a known
    # transport-conflict section and generated first-contact boilerplate shrink.
    scenario = re.sub(r"# Завершение разговора[^\n]*\n.*?(?=\n# |\Z)", "", prompt, flags=re.S)
    scenario = re.sub(r"[^.!?\n]*(?:skip_turn|send_dtmf|Finish call)[^.!?\n]*[.!?]?", "", scenario, flags=re.I)
    def first_contact(match):
        lines = [line for line in match[1].strip().splitlines() if line.strip()]
        if lines and lines[0].startswith("После первой осмысленной реплики сотрудника"):
            return "# Первый контакт\n" + lines[0] + "\n"
        return match[0]
    scenario = re.sub(r"# Первый контакт\s*\n(.*?)(?=\n# |\Z)", first_contact, scenario, flags=re.S)
    return f"""# Телефонный разговор
Ты {name}, клиент из сценария ниже. Говори по-русски непосредственно сотруднику. Его имя неизвестно, пока он сам не представился; твоё имя не является его именем.
Дождись обращения живого человека. При просьбе подождать молчи до нового обращения; молчание не обозначай словами или скобками.
Обычный ответ: короткая реакция и один вопрос, одно-два предложения. Сразу переходи к сути. Не описывай планы и этапы, работу инструментов и собственные рассуждения. Не инструктируй сотрудника, как ему отвечать.
Следуй роли, фактам и обязательным темам сценария. Не повторяй закрытые темы и длинное название объекта после первого знакомства. Не придумывай детали.
CALL_STATE содержит факты, исходные цитаты и последний услышанный вопрос. После паузы продолжай этот вопрос. DELIVERY_NOTE отмечает неуслышанную часть прерванной реплики.
Инструменты: используй только объявленные схемы. Значения и evidence копируй дословно из цитат сотрудника; не меняй падежи, не добавляй кавычки внутри значений. Названия полей не произноси.
Завершение: один вызов prepare_end_call без сопроводительного текста. Backend сам произнесёт подтверждение и прощание и дождётся воспроизведения.
Для согласованного визита нужны день и время: reason=visit_agreed, оба значения и обе исходные цитаты вместе. Конкретное предложение «удобно?» можно принять, неопределённый выбор уточни. Одинокое «давайте» не выбирает время. visit_pending нельзя закрыть через conversation_complete.
Для перезвона укажи callback_requested, исходную цитату и все названные день/время; для отказа — declined с цитатой. После принятого завершения больше не говори. Если инструмент просит уточнение, задай один короткий вопрос, не повторяй одинаковый неверный вызов.

# Сценарий и исходные данные
{scenario.strip()}
"""


class ConversationMemory:
    def __init__(self, prompt=""):
        explicit = re.findall(r"[Тт]ы\s+([А-ЯЁ][а-яё-]+)\s*,\s*(?:женщина|мужчина)", prompt)
        self.name = explicit[-1] if explicit else "Анна" if "Голос клиента: Женский" in prompt else "Андрей"
        self.phase = "waiting_for_person"
        self.facts = {}
        self.users = []
        self.open_question = None
        self.delivery_note = []
        self.closing_reason = None
        self.closing_candidate = False
        self.unfinished_fragment = None
        self.visit_pending = False
        self.topics = DialogueTopics(prompt)

    def user(self, text, turn):
        latest = max((u["turn"] for u in self.users), default=turn)
        self.users.append({"text": text, "turn": turn})
        self.users = sorted(self.users, key=lambda u: u["turn"])[-12:]
        if turn < latest:
            return  # Late ASR may add evidence, but cannot rewind current state.
        if getattr(self,'semantic_mode',False):
            return  # The semantic controller alone updates intent/booking state.
        self.topics.user(text, turn, self.open_question)
        # Routes only a closing safety buffer, never approves a hangup.
        self.closing_candidate = bool(re.search(r"перезвон|до свидания|всего доброго|не звоните", text, re.I)) or self.phase == "closing"
        self.unfinished_fragment = text if continuation_prefix(text) else None
        if re.search(r"\bне\s+(?:в|к)\s+(?:\d|четыр|шестнадцат|десят|два|двум|три|тр[её]м|пят)", text, re.I):
            self.facts.pop("visit_time", None)
        if re.search(r"\bне\s+(?:завтра|сегодня|послезавтра)\b", text, re.I):
            self.facts.pop("visit_day", None)
        if re.search(r"\bне\s+(?:в|к)\s+", text, re.I) and CLOCK.search(text):
            self.facts.pop("visit_time", None)
        new_proposal = re.search(r"\b(?:давайте|приезжайте|жд[её]м)\b(.*)", text, re.I)
        if new_proposal and not re.search(r"перезвон", new_proposal[1], re.I):
            if CLOCK.search(new_proposal[1]):
                self.facts.pop("visit_time", None)
            if re.search(r"\b(?:послезавтра|завтра|сегодня)\b", new_proposal[1], re.I):
                self.facts.pop("visit_day", None)
        if VISIT_CANCEL.search(text):
            self.visit_pending = False
            self.facts.pop("visit_day", None)
            self.facts.pop("visit_time", None)
        elif not re.search(r"перезвон", text, re.I) and (
            (self.expecting_visit_details() and (self.visit_candidates() or re.search(r"прие|подъе|визит|встре|осмотр", (self.open_question or {}).get("text", ""), re.I)))
            or re.search(r"приезжайте|жд[её]м.{0,25}(?:вас|визит)|давайте.{0,30}(?:визит|встрет|осмотр)", text, re.I)):
            self.visit_pending = True
        if text.strip() and self.phase == "waiting_for_person":
            self.phase = "dialogue"
        # Buffer a potential closing until tools decide; a normal question is
        # released at response.done if no closing tool was called.
        if self.visit_pending and all(key in self.visit_candidates() or key in self.facts for key in ("visit_day", "visit_time")):
            self.closing_candidate = True

    def expecting_visit_details(self):
        question = (self.open_question or {}).get("text", "").lower()
        return bool(re.search(r"во сколько|в какое время|конкретное время|какой диапазон|когда.*(?:прие|подъе|визит)|(?:день|время|завтра).*(?:визит|встре|осмотр)|завтра.*(?:четыр|16|14)|уточним время", question))

    def visit_candidates(self):
        """Only explicit proposals in customer quotes; no inferred clock conversion."""
        candidates = {}
        for user in self.users:
            text = user["text"]
            if VISIT_CANCEL.search(text):
                candidates.clear()
                continue
            if re.search(r"\bне\s+(?:в|к)\s+", text, re.I):
                candidates.pop("visit_time", None)
            if re.search(r"\bне\s+(?:завтра|сегодня|послезавтра)\b", text, re.I):
                candidates.pop("visit_day", None)
            proposal = re.search(r"\b(?:давайте|приезжайте|жд[её]м)\b(?P<body>.*)", text, re.I)
            controller_slots=getattr(self,"controller_slots",False)
            if not proposal and controller_slots and (self.visit_pending or self.expecting_visit_details()):
                proposal=re.search(r"\bможно\b(?P<body>.*)",text,re.I)
                if not proposal and (CLOCK.search(text) or re.search(r"\b(?:завтра|сегодня|послезавтра)\b",text,re.I)):
                    proposal=re.match(r"(?P<body>.*)",text)
            if not proposal:
                continue
            body = proposal["body"]
            # A concrete offer may end with a confirmation question. Other
            # questions and alternatives remain ambiguous; preserve full quote.
            if controller_slots:
                body=re.sub(r"[?.,—\s]*(?:(?:вам|тебе)\s+)?(?:будет\s+)?удобно(?:\s+будет)?(?:\s+(?:вам|тебе))?\s*\?\s*$","",body,flags=re.I)
                if CLOCK.search(body) and not re.search(r"когда|какой|сколько",body,re.I):body=body.rstrip("? ")
            body = re.sub(r"[,—\s]*(?:(?:вам|тебе)\s+)?(?:удобно(?:\s+будет)?(?:\s+(?:вам|тебе))?|(?:вам|тебе)\s+подойд[её]т)\s*\?\s*$", "", body, flags=re.I)
            # A negative earlier clause ("сегодня не получится, давайте завтра")
            # does not negate the subsequent explicit proposal.
            if re.search(r"\?|\b(?:или|не|может|наверное|перезвон\w*)\b", body, re.I):
                if CLOCK.search(body):
                    candidates.pop("visit_time", None)
                if re.search(r"\b(?:послезавтра|завтра|сегодня)\b", body, re.I):
                    candidates.pop("visit_day", None)
                continue
            day = re.search(r"\b(?:послезавтра|завтра|сегодня)\b", body, re.I)
            if day:
                candidates["visit_day"] = {"value": day[0], "evidence": text}
            when = CLOCK.search(body)
            if when:
                if re.match(r"\s+(?:\d|нол|один|одна|два|две|три|четыр|пят|шест|сем|восем|девят|десят|одиннадцат|двенадцат|тринадцат|двадцат|тридцат|сорок|половин|четверт)", body[when.end():], re.I):
                    candidates.pop("visit_time", None)
                    continue  # Never silently truncate an unsupported minute phrase.
                candidates["visit_time"] = {"value": when[0], "evidence": text}
        return candidates

    def save_visit(self, day="", day_evidence="", when="", time_evidence=""):
        candidates = self.visit_candidates()
        supplied = {"visit_day": {"value": day, "evidence": day_evidence},
                    "visit_time": {"value": when, "evidence": time_evidence}}
        saved = dict(self.facts)
        for key, entry in supplied.items():
            candidate = candidates.get(key)
            if entry["value"] and candidate and entry["value"].casefold() != candidate["value"].casefold():
                index = lambda quote: max((i for i, u in enumerate(self.users) if quote and quote in u["text"]), default=-1)
                if index(entry["evidence"]) < index(candidate["evidence"]):
                    self.facts = saved
                    return {"ok": False, "reason": "Есть более новое предложение сотрудника. Передай актуальное значение и его цитату.",
                            "visit_candidates": candidates}
            entry = entry if entry["value"] else candidates.get(key)
            if not entry:
                continue
            result = self.remember(key, entry["value"], entry["evidence"])
            if not result["ok"]:
                self.facts = saved
                return {**result, "visit_candidates": candidates,
                        "instruction": "Исправь prepare_end_call: возьми значения и evidence дословно из visit_candidates. Не меняй падежи и не объединяй цитаты."}
        if "visit_day" not in self.facts or "visit_time" not in self.facts:
            self.facts = saved
            return {"ok": False, "reason": "Нужны день и время визита с исходными цитатами; передай их вместе в prepare_end_call."}
        return {"ok": True}

    def remember(self, key, value, evidence):
        allowed = {"manager_name", "visit_day", "visit_time", "callback", "vehicle", "price", "mileage"}
        source = next((u for u in reversed(self.users) if evidence.strip() and evidence in u["text"]), None)
        if key not in allowed or not source or not value.strip() or len(value) > 300 or value.casefold() not in evidence.casefold():
            return {"ok": False, "reason": "Нужны допустимое поле, значение и точная цитата из последних реплик сотрудника.",
                    "recent_user_quotes": self.users[-3:],
                    "allowed_keys": sorted(allowed), "visit_candidates": self.visit_candidates(),
                    "instruction": "Для согласованного визита вызови prepare_end_call(reason='visit_agreed') с visit_day/day_evidence и visit_time/time_evidence из visit_candidates. Поля visit_agreed нет."}
        self.facts[key] = {"value": value, "evidence": evidence, "turn": source["turn"], "source": "user_quote_model_extraction"}
        return {"ok": True, "fact": self.facts[key]}

    def prepare_close(self, reason, evidence=""):
        if reason=='visit_unresolved' and getattr(self,'controller_slots',False):
            if getattr(self,'controller_visit_unresolved',False) and not getattr(self,'controller_pending_required',lambda:[])():
                self.phase,self.closing_reason='closing',reason
                return {'ok':True}
            return {'ok':False,'reason':'Сначала обязательные темы и ограниченное уточнение визита.'}
        if reason=='visit_agreed' and getattr(self,'controller_slots',False):
            pending=getattr(self,'controller_unasked_required',getattr(self,'controller_pending_required',lambda:[]))()
            if pending:return {'ok':False,'reason':'Остались обязательные темы. Сохрани визит и продолжи диалог.','pending_required':pending}
        if reason=="manager_goodbye" and getattr(self,"controller_slots",False):
            from controller_visit import goodbye
            if goodbye(evidence) and any(evidence==u['text'] for u in self.users[-3:]):
                self.phase,self.closing_reason="closing",reason
                return {"ok":True}
            return {"ok":False,"reason":"Нужно явное прощание собеседника с исходной цитатой."}
        if reason not in {"conversation_complete", "visit_agreed", "callback_requested", "declined", "voicemail"}:
            return {"ok": False, "reason": "Неизвестная причина завершения."}
        if reason in {"callback_requested", "declined", "voicemail"} and not any(evidence.strip() and evidence in u["text"] for u in self.users[-3:]):
            return {"ok": False, "reason": "Нужна точная цитата сотрудника или автоответчика.", "recent_user_quotes": self.users[-3:]}
        visit = "visit_day" in self.facts or "visit_time" in self.facts
        complete = "visit_day" in self.facts and "visit_time" in self.facts
        if reason == "conversation_complete" and self.visit_pending:
            return {"ok": False, "reason": "Обсуждался визит. Если согласован, вызови prepare_end_call(reason='visit_agreed') с цитатами дня и времени. Если визит отменён — declined с цитатой; при перезвоне — callback_requested. Не закрывай согласование общей причиной.",
                    "visit_candidates": self.visit_candidates(), "recent_user_quotes": self.users[-3:]}
        if (reason == "visit_agreed" or (visit and reason == "conversation_complete")) and not complete:
            return {"ok": False, "reason": "Визит не согласован: уточни недостающие день или время либо явный отказ от визита."}
        self.phase, self.closing_reason = "closing", reason
        return {"ok": True, "instruction": "Транспорт произнесёт прощание и завершит звонок. Дополнительная генерация не нужна."}

    def snapshot(self):
        return {"phase": self.phase, "customer_name": self.name, "facts": self.facts,
                "visit_pending": self.visit_pending,
                "visit_candidates": self.visit_candidates(),
                "dialogue_topics": self.topics.snapshot(),
                "recent_user_quotes": self.users[-3:],
                "unfinished_fragment": self.unfinished_fragment,
                "last_open_question": self.open_question, "delivery_note": self.delivery_note,
                "closing_reason": self.closing_reason}

    def context_text(self):
        return "CALL_STATE\n" + json.dumps(self.snapshot(), ensure_ascii=False)


class DeliveryLedger:
    """Phone ACK confirms a segment; local word release is only an estimate."""
    def __init__(self):
        self.responses = {}
        self.tags = {}
        self.contexts = {}

    def response(self, identifier):
        return self.responses.setdefault(identifier, {"tags": set(), "confirmed": set(), "words": [], "interrupted": False})

    def segment(self, tag, response_id):
        if response_id:
            self.tags[tag] = response_id
            self.response(response_id)["tags"].add(tag)

    def word(self, response_id, text):
        if response_id and not self.response(response_id)["interrupted"]:
            self.response(response_id)["words"].append(text)

    def ack(self, tag):
        response_id = self.tags.get(tag)
        if response_id:
            self.response(response_id)["confirmed"].add(tag)
        return response_id

    def complete(self, response_id):
        row = self.responses.get(response_id, {})
        return (bool(row.get("tags")) and row["tags"] <= row["confirmed"] and not row["interrupted"]
                and row.get("generated_done", False) and row.get("tts_done", False))

    def interrupt(self,only=None):
        affected = {}
        for identifier, row in self.responses.items():
            if only is not None and identifier!=only:continue
            if not row["interrupted"] and not self.complete(identifier):
                row["interrupted"] = True
                if row.get("kind")=="backchannel":continue
                affected[identifier] = {"local_text_estimate": " ".join(row["words"]),
                    "phone_confirmed_segments": sorted(row["confirmed"]),
                    "scope": "local text is approximate, not proof of words heard on the phone; interrupted tail was not delivered"}
        return affected
