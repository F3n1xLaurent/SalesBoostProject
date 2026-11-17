"""Read the buyer's need independently from an optional imported data row."""
import re


def plan_need(session):
    value=session.context.get('customerNeed')
    if isinstance(value,str) and value.strip():return value.strip()
    # Backwards compatibility for already prepared/replayed calls. The canonical
    # prompt stores the need as a multiline block, not necessarily one line.
    match=re.search(r'^Потребность клиента:[ \t]*(.*)',session.prompt,re.M|re.S)
    if not match:return ''
    return re.split(r'\n\s*\n(?=(?:Основа разговора:|Предмет обращения:|Название сценария |Данные выборки/описание:|Дополнительное описание отсутствует\.|# |Личный адрес клиента|Номер назначения:))',match.group(1),maxsplit=1)[0].strip()


def selected_subject(session):
    return {key:value.strip() for key in ('subjectTitle','subjectDescription')
            if isinstance(value:=session.context.get(key),str) and value.strip()}
