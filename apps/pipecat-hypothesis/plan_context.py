"""Read the buyer's need independently from an optional imported data row."""
import re
import json


def target_location(session):
    """Only the dialled branch is authoritative, never a company-wide address."""
    location=session.context.get('targetLocation')
    if isinstance(location,dict):
        return {key:value.strip() for key in ('name','city','address')
                if isinstance(value:=location.get(key),str) and value.strip()}
    # Older prepared calls and hypothesis clients carry the canonical block.
    match=re.search(r'^=== ЦЕЛЕВАЯ ТОЧКА ЗВОНКА \(КРИТИЧНО\) ===\s*\n(.*?)\n=== КОНЕЦ ЦЕЛЕВОЙ ТОЧКИ ===',session.prompt,re.M|re.S)
    if not match:return {}
    result={}
    for key,label in [('name','Целевая точка'),('city','Целевой город звонка'),('address','Адрес целевой точки')]:
        row=re.search(r'^'+label+r':[^\S\n]*([^\n]+)',match[1],re.M)
        if row:
            value=row[1].strip().removesuffix('.')
            if value and value not in ('название не указано','не указан'):result[key]=value
    return result


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
            if isinstance(value:=getattr(session,'context',{}).get(key),str) and value.strip()}


def subject_sources(session,questions=None):
    rows=questions if questions is not None else session.evidence.memory.topics.required
    match=re.search(r'^Название скрипта \(справочный источник\): (.+)$',session.prompt,re.M)
    title=None
    if match:
        try:title=json.loads(match[1])
        except (ValueError,TypeError):pass
    return {'selection':selected_subject(session),'need':plan_need(session),
            'script_title':title if isinstance(title,str) else None,
            'script_references':[r['question'] for r in rows]}


def subject_scope(session):
    sources=subject_sources(session)
    title=sources['selection'].get('subjectTitle') or getattr(session,'prepared_subject',None)
    return {**sources,'subject':title,'spoken_subject':spoken_subject(session),'purpose':call_purpose(session),
            # A verified short subject replaces the question list. On wording
            # failure keep the quoted references as a factual fallback only.
            'script_references':[] if title else sources['script_references'][:1]}


def spoken_subject(session):
    """The feed title stays intact for reasoning; speech uses a verified label."""
    return getattr(session,'prepared_spoken_subject',None) or (
        ('авто' if call_purpose(session)=='service' else 'авто из объявления')
        if selected_subject(session).get('subjectTitle') or getattr(session,'prepared_subject',None) else '')


def shorten_subject_mentions(session,text):
    # Embedded questions may require a different grammatical case. Keep their
    # invariant catalogue model; the opening and native replies use spoken_name.
    short=getattr(session,'prepared_subject_model',None) or spoken_subject(session)
    if not short:return text
    titles={selected_subject(session).get('subjectTitle'),getattr(session,'prepared_subject',None)}-{None,''}
    for title in sorted(titles,key=len,reverse=True):
        text=re.sub(r'(?<!\w)'+re.escape(title)+r'(?!\w)',lambda _:short,text,flags=re.I)
    return text


def grounded_subject(value,sources):
    if not isinstance(value,str) or not 3<=len(value.strip())<=160 or re.search(r'[\n?{}]',value):return False
    normalize=lambda text:' '.join(text.casefold().split())
    quotes=[*sources['selection'].values(),sources['need'],*sources['script_references'],sources.get('script_title')]
    return any(normalize(value) in normalize(quote) for quote in quotes if quote)


def call_purpose(session):
    """Only preparation-verified purpose may enable purchase-specific defaults."""
    kind=getattr(session,'prepared_purpose',None)
    return kind if kind in ('purchase','service','other') else 'other'
