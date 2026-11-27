"""Synthetic answer-coverage evaluation: real Decisions, no audio or phone calls."""
import argparse
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from conversation import ConversationMemory
from pipeline import Turn
from policy import Evidence,Playback
from semantic_controller import SemanticController,SEMANTIC_VERSION
from turn_meaning import interpret,review_answer_coverage,MODEL

RUST='На машине рыжики есть?'
DRIVE='В вашем салоне есть тест-драйв для пробежных авто?'
CASES=[
    ('rust_compound',RUST,True,'Рыжиков нет, подскажите, пожалуйста, сейчас на каком автомобиле ездите?','answered'),
    ('rust_fragmented',RUST,True,'Подскажите, пожалуйста, Рыжиков нет, сейчас на каком-то автомобиле Перемещается?','answered'),
    ('rust_explicit',RUST,True,'Нет, рыжиков нет.','answered'),
    ('rust_unsolicited',RUST,False,'Коррозии на кузове нет.','answered'),
    ('rust_unknown',RUST,True,'Рыжики пока не проверяли, я не могу сказать.','unknown'),
    ('rust_other_fact',RUST,True,'ДТП не было, машина в отличном состоянии.','unanswered'),
    ('rust_quoted_question',RUST,True,'Вы спрашивали, есть ли рыжики на машине?','unanswered'),
    ('rust_reported',RUST,True,'Другой покупатель говорил, что рыжиков нет. Мы сами ещё не проверяли.','unknown'),
    ('rust_partial',RUST,True,'По рыжикам...','unanswered'),
    ('rust_yes_after_name',RUST,False,'Да, конечно.','unanswered'),
    ('drive_yes',DRIVE,True,'Да, конечно.','answered'),
    ('drive_conditional',DRIVE,True,'Тест-драйв возможен только по предварительной записи.','answered'),
    ('mileage_yes','Какой пробег у автомобиля?',True,'Да.','unanswered'),
    ('mileage_value','Какой пробег у автомобиля?',True,'Пробег сто тридцать тысяч километров.','answered'),
    ('mileage_real','Пробег реальный?',True,'Пробег не скручен, подтверждается историей обслуживания.','answered'),
    ('price_fixed','Цену не потеряю, если подумаю недолго?',True,'Можно внести минимальную предоплату и забронировать на несколько дней. Тогда цена останется фиксированной.','answered'),
]


async def evaluate(case):
    name,target,direct,text,expected=case
    questions=list(dict.fromkeys([DRIVE,RUST,target]))
    prompt='\n'.join(q+' [обязательная тема]' for q in questions)
    s=SimpleNamespace(prompt=prompt,context={},backchannel=False,finalized=False,
        evidence=Evidence(),playback=Playback(),dialogue_mode='semantic')
    s.evidence.memory=ConversationMemory(prompt);s.evidence.memory.semantic_mode=True
    s.evidence.turn=s.evidence.output_turn=2
    c=SemanticController(s,None,SimpleNamespace(turn=Turn(False,number=2),segment_start=None))
    c.texts={r['key']:r['question'] for r in s.evidence.memory.topics.required}
    c.texts['opening']='Машина ещё продаётся?';c.started=True
    topic=next(r['key'] for r in s.evidence.memory.topics.required if r['question']==target)
    c.current=topic
    reference={'topic':topic,'response_id':'question','text':target,'kind':'plan'} if direct else {
        'topic':None,'response_id':'name','text':'Меня зовут Андрей.','kind':'identity'}
    c.last_question=reference;c.last_clip=reference
    if direct:
        c.asked[topic]=1
        c.question_ledger['plan:'+topic]={'response_id':'question','text':target,'turn':1,'state':'queued'}
        c.s.evidence.delivery.response('question')['interrupted']=True
    c.latest_input=text;s.evidence.memory.user(text,2)
    stage='primary'
    try:
        meaning=await interpret(c,text)
        stage='review'
        reviewed=await review_answer_coverage(c,{'id':'plan:'+topic,'topic':topic,'text':target},text)
        raw=next(r['answers']['coverage:'+topic] for r in s.evidence.events if r['event']=='semantic_interpretation')
        review=next((r for r in s.evidence.events if r['event']=='semantic_answer_review'),{})
        return {'id':name,'expected':expected,'primary':meaning['coverage'][topic],'review':reviewed,
            'passed':meaning['coverage'][topic]==expected and (reviewed==expected or expected=='unanswered' and reviewed=='uncertain'),
            'primary_raw':raw,'review_raw':review.get('answers'),
            'primary_ms':meaning['latency_ms'],'review_ms':review.get('latency_ms',0)}
    except Exception as exc:return {'id':name,'passed':False,'errorType':type(exc).__name__,'stage':stage}
    finally:await c.close()


async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--repeat',type=int,default=1)
    parser.add_argument('--output',required=True);parser.add_argument('--case',action='append')
    args=parser.parse_args()
    if not 1<=args.repeat<=5:parser.error('repeat must be 1..5')
    if args.case and set(args.case)-{r[0] for r in CASES}:parser.error('unknown case')
    cases=[r for r in CASES if not args.case or r[0] in args.case]
    limit=asyncio.Semaphore(3)
    async def run(case):
        async with limit:
            result=await evaluate(case)
            print(json.dumps({k:result[k] for k in ('id','passed','primary','review','expected','errorType') if k in result},ensure_ascii=False),flush=True)
            return result
    rows=[]
    for _ in range(args.repeat):rows.extend(await asyncio.gather(*(run(case) for case in cases)))
    report={'version':SEMANTIC_VERSION,'model':MODEL,'scope':'synthetic only','phoneCalls':0,'audioUploads':0,'cases':rows}
    Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    if not all(row['passed'] for row in rows):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
