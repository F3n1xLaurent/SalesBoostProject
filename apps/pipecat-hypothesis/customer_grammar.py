"""Customer voice agreement; never derive gender from a car or an employee."""
import re


def customer_gender(prompt):
    voice=re.findall(r'^\s*Голос клиента:\s*(Женский|Мужской)\b',prompt,re.I|re.M)
    if voice:return 'female' if voice[-1].casefold()=='женский' else 'male'
    explicit=re.findall(r'\b[Тт]ы\s+[А-ЯЁ][а-яё-]+\s*,\s*(женщина|мужчина)\b',prompt)
    if explicit:return 'female' if explicit[-1]=='женщина' else 'male'
    return 'unspecified'


def grammar_instruction(prompt):
    gender=customer_gender(prompt)
    if gender=='female':
        return 'Клиент говорит в женском роде: «я поняла», «не расслышала», «хотела», «я готова». '
    if gender=='male':
        return 'Клиент говорит в мужском роде: «я понял», «не расслышал», «хотел», «я готов». '
    return 'Род голоса клиента не указан: используй нейтральные формы без прошедшего времени первого лица. '


PAIRS=(('понял','поняла'),('расслышал','расслышала'),('услышал','услышала'),
    ('хотел','хотела'),('смотрел','смотрела'),('посмотрел','посмотрела'),('изучил','изучила'),
    ('уточнил','уточнила'),('звонил','звонила'),('планировал','планировала'),
    ('собирался','собиралась'),('говорил','говорила'),('готов','готова'),('заинтересован','заинтересована'))
FORMS={form:pair for pair in PAIRS for form in pair}
HEAD=re.compile(r'^(?P<prefix>\s*(?:(?:извините|простите)[,!]?\s+)?(?:я\s+)?'
    r'(?:(?:не|уже|раньше|просто)\s+){0,2})(?P<form>'+ '|'.join(sorted(FORMS,key=len,reverse=True))+r')\b',re.I)


def agree_first_person(text,gender):
    if gender not in ('female','male'):return text
    match=HEAD.match(text)
    if not match:return text
    prefix=match['prefix'];source=match['form'];explicit=bool(re.search(r'\bя\b',prefix,re.I))
    # Do not change a question addressed to the employee or a ready car.
    if not explicit and '?' in text:return text
    if source.casefold() in ('готов','готова','заинтересован','заинтересована') and not explicit:
        if not re.match(r'\s+[а-яё]+(?:ть|ться)\b',text[match.end():],re.I):return text
    target=FORMS[source.casefold()][1 if gender=='female' else 0]
    if source.isupper():target=target.upper()
    elif source[:1].isupper():target=target.capitalize()
    return text[:match.start('form')]+target+text[match.end('form'):]
