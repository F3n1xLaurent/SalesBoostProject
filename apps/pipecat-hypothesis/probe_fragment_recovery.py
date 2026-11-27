"""Synthetic fragment-recovery checks against Decisions; no audio or calls."""
import argparse
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from conversation import ConversationMemory
from pipeline import Turn
from policy import Evidence,Playback
from semantic_controller import SemanticController,SEMANTIC_VERSION
from turn_meaning import MODEL,review_fragment_question

CASES=[
    ('tradein_complete','Какую машину планируете сдать в трейд-ин?','own_vehicle'),
    ('tradein_asr_chunks','Да, скидка есть. При обмене вашего автомобиля это выгоднее. Подскажите, пожалуйста, какую машину планируете? Задачи. Придым.','own_vehicle'),
    ('own_vehicle','На каком автомобиле сейчас ездите?','own_vehicle'),
    ('selected_vehicle','Какая машина из наших объявлений вас заинтересовала?','other'),
    ('selected_year','Подскажите год и цвет интересующей вас машины. У нас их несколько.','other'),
    ('beneficiary','Машину выбираете для себя или для семьи?','other'),
    ('preferences','Какие опции вам важнее всего?','other'),
    ('payment','Покупку будете оформлять за наличные или в кредит?','other'),
    ('unfinished_question','Подскажите, какую машину вы','clarify'),
    ('unfinished_fact','Состояние отличное. ДТП автомобиль','clarify'),
    ('unfinished_followup','Какую машину хотите сдать? И ещё, как вы','clarify'),
    ('just_prefix','Подскажите, пожалуйста,','clarify'),
    ('hold','Какую машину будете сдавать? Подождите, я сейчас вернусь.','hold'),
    ('transfer','Я сейчас соединю вас с коллегой, оставайтесь на линии.','hold'),
]


async def evaluate(case):
    name,text,expected=case
    prompt='Есть ли скидка при сдаче моей машины в трейд-ин? [обязательная тема]'
    s=SimpleNamespace(prompt=prompt,context={'subjectTitle':'Toyota Land Cruiser Prado',
        'customerNeed':'Могу сдать Весту 2018 года с пробегом 130000 км.'},backchannel=False,
        finalized=False,evidence=Evidence(),playback=Playback(),dialogue_mode='semantic')
    s.evidence.memory=ConversationMemory(prompt)
    s.prepared_purpose='purchase'
    c=SemanticController(s,None,SimpleNamespace(turn=Turn(False,number=2),segment_start=None))
    c.last_question={'text':'Есть ли скидка при сдаче моей машины в трейд-ин?','topic':'discount','response_id':'question'}
    try:
        result=await review_fragment_question(c,text)
        event=next(r for r in s.evidence.events if r['event']=='semantic_fragment_review')
        return {'id':name,'expected':expected,'result':result,'passed':result==expected,
            'raw':event['answers'],'latency_ms':event['latency_ms']}
    except Exception as exc:return {'id':name,'passed':False,'errorType':type(exc).__name__}
    finally:await c.close()


async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--repeat',type=int,default=1)
    parser.add_argument('--output',required=True);parser.add_argument('--case',action='append')
    args=parser.parse_args()
    if not 1<=args.repeat<=5:parser.error('repeat must be 1..5')
    if args.case and set(args.case)-{row[0] for row in CASES}:parser.error('unknown case')
    limit=asyncio.Semaphore(2)
    async def run(case):
        async with limit:
            row=await evaluate(case)
            print(json.dumps({k:row[k] for k in ('id','expected','result','passed','errorType') if k in row},ensure_ascii=False),flush=True)
            return row
    rows=[]
    for _ in range(args.repeat):
        rows.extend(await asyncio.gather(*(run(case) for case in CASES if not args.case or case[0] in args.case)))
    Path(args.output).write_text(json.dumps({'version':SEMANTIC_VERSION,'model':MODEL,
        'scope':'synthetic only','phoneCalls':0,'audioUploads':0,'cases':rows},ensure_ascii=False,indent=2)+'\n')
    if not all(row['passed'] for row in rows):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
