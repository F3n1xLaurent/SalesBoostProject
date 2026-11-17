"""Controller-only proposal state; customer choices are not manager quotations."""
import re
from conversation import CLOCK, HOURS


_HOUR_FORMS=(('один одного одному час часу',1),('два двух двум',2),('три трех трём трем трёх',3),
    ('четыре четырех четырёх четырем четырём',4),('пять пяти',5),('шесть шести',6),('семь семи',7),
    ('восемь восьми',8),('девять девяти',9),('десять десяти',10),('одиннадцать одиннадцати',11),
    ('двенадцать двенадцати',12),('тринадцать тринадцати',13),('четырнадцать четырнадцати',14),
    ('пятнадцать пятнадцати',15),('шестнадцать шестнадцати',16),('семнадцать семнадцати',17),
    ('восемнадцать восемнадцати',18),('девятнадцать девятнадцати',19),('двадцать двадцати',20))
_HOUR_VALUES={word:value for forms,value in _HOUR_FORMS for word in forms.split()}
_DAYS=r'послезавтра|завтра|сегодня|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье'


def clock_minutes(phrase):
    number=re.search(r'(?<!\w)(\d{1,2})(?::(\d{2}))?(?![\w:])',phrase)
    minute=0
    if number:hour=int(number[1]);minute=int(number[2] or 0)
    else:
        words=re.findall(r'[а-яё]+',phrase.casefold())
        first=next((i for i,w in enumerate(words) if w in _HOUR_VALUES),None)
        if first is None:return None
        hour=_HOUR_VALUES[words[first]]
        # Only adjacent compounds form 21..23. A second quotation of 20:00
        # in the confirmation context must not turn the first hour into 40.
        if hour==20 and first+1<len(words) and _HOUR_VALUES.get(words[first+1]) in (1,2,3):
            hour+=_HOUR_VALUES[words[first+1]]
    if not 0<=hour<=23 or not 0<=minute<=59:return None
    if hour<12 and re.search(r'дня|вечера|вечером',phrase,re.I):hour+=12
    if hour==12 and re.search(r'ночи',phrase,re.I):hour=0
    return hour*60+minute


def same_clock(expected,actual,context):
    a=clock_minutes(actual+' '+context);e=clock_minutes(expected)
    if a is None or e is None:return False
    if not re.search(r'утра|ночи|дня|вечера|утром|вечером',context,re.I) and a<720 and e>=720:a+=720
    return a==e


def affirmative(text):
    words=re.findall(r"[а-яё]+",text.lower())
    allowed={"да","угу","ага","верно","всё","все","отлично","хорошо","правильно","именно","удобно","я","сказал","уже","подходит","подойдет","подойдёт","договорились","подтверждаю","согласен","согласна"}
    return bool(words and len(words)<=14 and any(w in {"да","угу","ага","верно","отлично","правильно","хорошо","подходит","подойдет","подойдёт","договорились","подтверждаю","согласен","согласна"} for w in words)
        and set(words)<=allowed and "?" not in text)


def goodbye(text):
    return bool(len(text.split())<=25 and "?" not in text
        and re.search(r"(?:до свидания|всего доброго|всего хорошего)[.!\s]*$",text,re.I)
        and not re.search(r"\bне\b|скаж|сказ|слова|цитат|попрос",text,re.I))


def confirms_slot(offer,text):
    if not offer:return False
    if '?' in text or re.search(r'\bне\b|\bнет\b|нельзя|отмен|\bили\b|\bлибо\b|\bно\b|\bесли\b|только|кроме|позже|раньше|уточню|проверю|попробую|может быть|наверное|возможно|постара|надеюсь|думаю|кажется|перенес|перенос|друго[ей]',text,re.I):return False
    day=re.search(r'\b(?:послезавтра|завтра|сегодня)\b',text,re.I)
    if day and day[0].casefold()!=offer['day']['value'].casefold():return False
    times=list(CLOCK.finditer(text));expected=CLOCK.search(offer['time']['value'])
    if times and (len(times)!=1 or not expected or not same_clock(offer['time']['value'],times[0][0],text)):return False
    if affirmative(text):return True
    # An explicit acceptance is about the active, already queued proposal.
    # It cannot create a day or time on its own.
    booking=bool(re.search(r'\b(?:запис(?:ываю|ываем|ал|ала|али)|запишу|запишем)\b|\b(?:будем|буду)\s+(?:вас\s+ждать|ждать\s+вас)\b|\bжд[её]м\s+вас\b',text,re.I))
    if booking:return True
    # A mutual commitment confirms the active slot without repeating its time.
    # Keep this separate from short "yes": it is a statement about the visit,
    # not consent to an unrelated reply. Reject reported/uncertain meetings.
    meeting=bool(re.match(r'\s*(?:да|давайте|верно|отлично|хорошо|тогда|значит|договорились)\b',text,re.I)
        and re.search(r'\b(?:встретимся|увидимся|встречаемся)\b|\bможно\s+(?:будет\s+)?встретиться\b',text,re.I)
        and not re.search(r'\b(?:когда|где|сказал\w*|говорил\w*|цитат\w*)\b',text,re.I))
    if meeting:return True
    if not re.match(r'\s*(?:да\b|давайте\b|верно\b|отлично\b|приезжайте\b|подъезжайте\b)',text,re.I):return False
    return bool(times)



class VisitProposal:
    def __init__(self):
        self.day=None;self.time=None;self.offered=None;self.selected_option=None

    def update(self,text,turn):
        self.selected_option=None
        # Any substantive reply supersedes a pending confirmation. Retain the
        # explicitly supplied day across the manager's fragmented answer.
        if re.search(r"не (?:приед|смогу|получится|подходит)|неудобно|нельзя|отмен",text,re.I):
            self.day=self.time=self.offered=None;return
        if re.search(r"\bне\s+(?:сегодня|завтра|послезавтра|в|к)\b",text,re.I):
            self.offered=None;self.time=None
            if re.search(r"\bне\s+(?:сегодня|завтра|послезавтра)\b",text,re.I):self.day=None
            return
        alternatives=re.split(r'\b(?:или|либо)\b',text,flags=re.I)
        if len(alternatives)>1:
            # Select one complete offered option; never combine a day from one
            # branch with a time from another. This is a client proposal only.
            common_day=self.day if not re.search(r'\b(?:'+_DAYS+r')\b',text,re.I) else None
            first_day=None
            for option in alternatives:
                candidate=VisitProposal()
                candidate.day=dict(common_day) if common_day else None
                candidate.update(option.strip(' ,.'),turn)
                if candidate.day and first_day is None:first_day=dict(candidate.day)
                if candidate.day and not common_day:common_day=dict(candidate.day)
                proposal=candidate.proposal()
                if proposal:
                    self.day=proposal['day'];self.time=proposal['time'];self.offered=None
                    self.selected_option=option.strip(' ,.');
                    self.time.update(source='client_choice_from_manager_options',selection_evidence=text)
                    return
            if first_day:
                self.day={**first_day,'source':'client_choice_from_manager_options','selection_evidence':text}
            self.time=None;self.offered=None;self.selected_option=None
            return
        day=re.search(r'\b(?:'+_DAYS+r')\b',text,re.I)
        if day:
            value=day[0] if day[0].casefold() in ('сегодня','завтра','послезавтра') else 'в '+day[0].casefold()
            self.day={"value":value,"evidence":text,"turn":turn}
        clock=CLOCK.search(text)
        # ASR often emits a clock as a standalone fragment without the
        # preposition: "двадцать ноль ноль". Match a complete clock-shaped
        # fragment, never a naked quantity embedded in an ordinary sentence.
        standalone=re.fullmatch(r'\s*(?:(?:2[0-3]|[01]?\d):[0-5]\d|(?:'+HOURS+r')\s+ноль\s+ноль)[.!\s]*',text,re.I)
        if not clock and standalone:clock=standalone
        if not clock:
            trailing=re.search(r'(?:^|[.!?]\s*)(?P<clock>(?:'+HOURS+r')\s+ноль\s+ноль)[.!\s]*$',text,re.I)
            if trailing:clock=trailing
        if not clock and re.search(r'во второй половине дня|в первой половине дня|после обеда|утром|вечером',text,re.I) and re.search(r'\bне\b|только|кроме|раньше|позже|\bдо\b|\d',text,re.I) and not re.search(r'\bс(?:о)?\s+[^,.]+\s+до\s+',text,re.I):
            self.time=None;self.offered=None;return
        # A hyphenated interval permits a proposed boundary, never a guessed
        # midpoint. Alternative branches are handled separately above.
        hour=r"(?:(?:2[0-3]|1\d|[0-9])(?::[0-5]\d)?|"+HOURS+r")"
        interval=re.search(r"(?<![\w:])(?:часиков\s+|часов\s+|в\s+)?(?P<first>"+hour+r")\s*[-–—]\s*(?P<last>"+hour+r")(?![\w:])",text,re.I)
        spoken_interval=re.search(r'\bс(?:о)?\s+(?P<first>'+hour+r'|одного|двух|тр[её]х|четыр[её]х)\s+до\s+(?P<last>'+hour+r'|одного|двух|тр[её]х|четыр[её]х)(?![\w:])',text,re.I)
        interval=interval or spoken_interval
        if interval:
            first=interval['first']
            if first.casefold() in _HOUR_VALUES and first.casefold().endswith(('и','ого','ух','ёх','ех')):
                first=str(_HOUR_VALUES[first.casefold()])+':00'
            self.time={"value":"в "+first,"evidence":text,"turn":turn,"source":"client_choice_from_manager_interval"}
        elif clock:
            # Keep the adjacent AM/PM qualifier in the quoted slot. Dropping
            # "дня" turns an unchanged 15:00 confirmation into a false change.
            suffix=re.match(r'\s*(?:час(?:а|ов)?\s+)?(?:утра|дня|вечера|ночи)\b',text[clock.end():],re.I)
            value=text[clock.start():clock.end()+(suffix.end() if suffix else 0)].strip(' .!?')
            self.time={"value":value,"evidence":text,"turn":turn,"source":"manager_quote"}
        elif re.search(r'во второй половине дня|в первой половине дня|после обеда|утром|вечером',text,re.I) and not re.search(r'\bне\b|только|кроме|раньше|позже|\bдо\b|\d',text,re.I):
            when='в три часа дня' if re.search(r'во второй половине дня|после обеда',text,re.I) else 'в десять утра' if re.search('утром|в первой половине дня',text,re.I) else 'в шесть вечера'
            self.time={'value':when,'evidence':text,'turn':turn,'source':'client_choice_from_manager_daypart'}
        if day or clock or interval:self.offered=None

    def proposal(self):
        if self.day and self.time:return {"day":dict(self.day),"time":dict(self.time)}

    def confirmed_facts(self,text,turn):
        if not confirms_slot(self.offered,text):return None
        source='manager_quote_confirmed' if self.offered['time'].get('source')=='manager_quote' else 'client_proposal_confirmed_by_manager'
        return {"visit_"+key:{**entry,"source":source,
            "confirmation_evidence":text,"confirmation_turn":turn} for key,entry in self.offered.items()}
