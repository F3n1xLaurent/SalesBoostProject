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


def subject_sources(session,questions=None):
    rows=questions if questions is not None else session.evidence.memory.topics.required
    return {'selection':selected_subject(session),'need':plan_need(session),
            'script_references':[r['question'] for r in rows]}


def subject_scope(session):
    sources=subject_sources(session)
    title=sources['selection'].get('subjectTitle') or getattr(session,'prepared_subject',None)
    return {**sources,'subject':title,
            # A verified short subject replaces the question list. On wording
            # failure keep the quoted references as a factual fallback only.
            'script_references':[] if title else sources['script_references'][:1]}


def grounded_subject(value,sources):
    if not isinstance(value,str) or not 3<=len(value.strip())<=160 or re.search(r'[\n?{}]',value):return False
    normalize=lambda text:' '.join(text.casefold().split())
    quotes=[*sources['selection'].values(),sources['need'],*sources['script_references']]
    return any(normalize(value) in normalize(quote) for quote in quotes if quote)
