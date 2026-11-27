"""Synthetic invitations versus buyer questions/holds; real Decisions only."""
import argparse
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from conversation import ConversationMemory
from pipeline import Turn
from policy import Evidence,Playback
from semantic_controller import SemanticController,SEMANTIC_VERSION
from turn_meaning import interpret,MODEL

CASES=[
    ('questions_left','Остались ещё какие-либо вопросы?',True),
    ('questions_addressed','Иван, у вас остались ко мне вопросы?',True),
    ('clarify_more','Что ещё хотите уточнить?',True),
    ('ask_more','Спрашивайте, что ещё интересует.',True),
    ('buyer_options','Какие опции вам важны в машине?',False),
    ('buyer_tradein','Какую машину планируете сдать в трейд-ин?',False),
    ('send_address','Вам отправить адрес салона?',False),
    ('sufficiency','Этого объяснения вам достаточно?',False),
    ('my_question','У меня к вам остался ещё один вопрос.',False),
    ('hold','Подождите, пока ничего не спрашивайте.',False),
    ('linking','Значит.',False),
    ('acknowledgment','Отлично.',False),
    ('connection','Вы меня слышите?',False),
]


async def evaluate(case):
    name,text,expected=case
    prompt='Пробег реальный? [обязательная тема]\nОплата картой возможна? [обязательная тема]'
    s=SimpleNamespace(prompt=prompt,context={'subjectTitle':'Chevrolet Tahoe'},backchannel=False,
        finalized=False,evidence=Evidence(),playback=Playback(),dialogue_mode='semantic',prepared_purpose='purchase')
    s.evidence.memory=ConversationMemory(prompt);s.evidence.memory.name='Иван'
    c=SemanticController(s,None,SimpleNamespace(turn=Turn(False,number=2),segment_start=None))
    c.started=True;c.opening_sent=True;c.current='visit';c.visit_confirmed=True
    c.texts={row['key']:row['question'] for row in s.evidence.memory.topics.required}
    c.texts['opening']='Машина ещё продаётся?'
    s.evidence.memory.facts={'visit_day':{'value':'завтра'},'visit_time':{'value':'в 10:00'}}
    c.last_clip={'text':'Планирую за наличные, документы возьму с собой.','response_id':'payment-answer'}
    c.last_question={'text':'Могу приехать завтра в десять. Подойдёт?','response_id':'visit-offer','topic':None,'kind':'followup'}
    s.evidence.memory.user(text,2)
    try:
        result=await interpret(c,text)
        event=next(row for row in s.evidence.events if row['event']=='semantic_interpretation')
        return {'id':name,'expected':expected,'passed':result['next_question']==expected,
            'next_question':result['next_question'],'plan_permission':result['plan_permission'],
            'request_scope':result['request_scope'],'control':result['control'],
            'raw_permission':event['answers']['plan_permission'],'meaning':result,
            'latency_ms':result['latency_ms']}
    except Exception as exc:return {'id':name,'passed':False,'errorType':type(exc).__name__}
    finally:await c.close()


async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--repeat',type=int,default=1)
    parser.add_argument('--output',required=True);parser.add_argument('--case',action='append');args=parser.parse_args()
    if not 1<=args.repeat<=5:parser.error('repeat must be 1..5')
    if args.case and set(args.case)-{row[0] for row in CASES}:parser.error('unknown case')
    limit=asyncio.Semaphore(2)
    async def run(case):
        async with limit:
            row=await evaluate(case)
            print(json.dumps({k:row[k] for k in ('id','passed','next_question','expected','errorType') if k in row}),flush=True)
            return row
    rows=[]
    for _ in range(args.repeat):
        rows.extend(await asyncio.gather(*(run(case) for case in CASES if not args.case or case[0] in args.case)))
    Path(args.output).write_text(json.dumps({'version':SEMANTIC_VERSION,'model':MODEL,
        'scope':'synthetic only','phoneCalls':0,'audioUploads':0,'cases':rows},ensure_ascii=False,indent=2)+'\n')
    if not all(row['passed'] for row in rows):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
