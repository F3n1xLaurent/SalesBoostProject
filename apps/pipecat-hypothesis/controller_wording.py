"""Conversational voice wording for known plan questions; preserve custom scope."""
import re


def question_key(text):
    return ' '.join(re.sub(r'[^\wа-яё ]',' ',text.casefold()).split())


_PHRASINGS=(
    (("Актуальный ли пробег в объявлении?","Пробег в объявлении актуальный?","Пробег актуальный?"),
        "Скажите, пробег в объявлении актуальный?"),
    (("Что по порогам, не сильно ли гнилые?","Что по порогам, есть коррозия?","Пороги целые?"),
        "А как пороги по состоянию, коррозия есть?"),
    (("Были ли ДТП?",),"Подскажите, пожалуйста, были ли у машины ДТП?"),
    (("Можете ли сделать скидку?","Можно ли обсудить скидку?"),
        "А по цене можно будет немного поторговаться?"),
    (("Сколько владел автомобилем последний владелец?","Как долго последний владелец пользовался автомобилем?"),
        "А последний владелец как долго на ней ездил?"),
)
_KNOWN={question_key(original):spoken for originals,spoken in _PHRASINGS for original in originals}


def conversational_clause(text):
    # Only grammatical question starters are lowercased; names/acronyms remain.
    return re.sub(r'^(Как(?:ой|ая|ое|ие)?|Сколько|Можно|Будет|Были|Есть|Актуальн(?:ый|ая|ое)|Возможн(?:о|а|ая|ый))\b',
                  lambda m:m[0].lower(),text)


def spoken_question(original):
    known=_KNOWN.get(question_key(original))
    if known:return known
    # Do not replace an arbitrary question by a generic template for its topic:
    # the original may contain a price, condition or a specific vehicle part.
    if re.search(r'пожалуйста|подскажите|скажите|хотел.{0,8}уточнить',original,re.I):return original
    return 'Подскажите, пожалуйста, '+conversational_clause(original)
