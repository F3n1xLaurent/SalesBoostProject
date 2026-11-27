"""Synthetic Decisions tests for the direction of permission; never dials."""
import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
from conversation import ConversationMemory
from policy import Evidence,Playback
from semantic_controller import SemanticController
from turn_meaning import interpret,review_answer_coverage,MODEL

CASES=[
    ('booking_and_permission','Да, отлично, будем вас ждать завтра в 10. Сергей, можно я задам вам несколько вопросов?','ask'),
    ('permission','Можно я задам вам несколько вопросов?','ask'),
    ('mixed_payment','Можно уточнить несколько вопросов? Покупку планируете в кредит или за наличные?','mixed'),
    ('polite_name','Можно уточнить, как вас зовут?','none'),
    ('mixed_name','Можно я задам вам пару вопросов? Сначала скажите, как вас зовут?','mixed'),
    ('buyer_invitation','У вас остались ко мне вопросы?','none'),
    ('quoted','Коллега спросил: можно я задам вам несколько вопросов. Я это просто цитирую.','none'),
    ('conditional','Если коллега попросит разрешения задать вопросы, сможете ему ответить?','none'),
    ('refusal','Я не буду задавать вам вопросы, просто приезжайте завтра.','none'),
]

COVERAGE_CASES=[
    ('rust_answer','Рыжики есть?','Пороги целые, рыжиков нет.','answered'),
    ('discount_yes','При сдаче машины по trade-in предусмотрена скидка?','Да, предусмотрена.','answered'),
    ('discount_amount','Какой размер скидки по trade-in?','До трёхсот тысяч рублей.','answered'),
    ('unrelated','Какой размер скидки по trade-in?','Вы лучше приезжайте, на месте обсудим.','unanswered'),
    ('retained_tail','Цену не потеряю, если подумаю недолго?','До трёхсот рублей. Вы когда','not_covered'),
    ('unknown','Какой размер скидки по trade-in?','Не знаю, такой информацией не располагаю.','unknown'),
]

async def main():
    rows=[]
    async with httpx.AsyncClient() as http:
        for name,text,expected in CASES:
            s=SimpleNamespace(prompt='1. Есть скидка по trade-in? [обязательная тема]',context={},
                backchannel=False,finalized=False,evidence=Evidence(),playback=Playback(),dialogue_mode='semantic')
            s.evidence.memory=ConversationMemory(s.prompt);s.evidence.turn=2
            c=SemanticController(s,None,SimpleNamespace(turn=SimpleNamespace(number=2),segment_start=None))
            c.http=http;c.started=True;c.texts={'opening':'Машина продаётся?'}
            c.visit.update('Завтра в 10:00.',1);c.visit.offered=c.visit.proposal();c.visit_offer_response_id='offer'
            c.last_question={'text':'Завтра в 10 подойдёт?','response_id':'offer','topic':None,'kind':'visit_offer'}
            c.last_clip={'text':'Завтра в 10 подойдёт?','response_id':'offer'}
            try:
                result=await interpret(c,text)
                ok=result['seller_permission']==expected and (expected=='none' or not result['next_question'])
                rows.append(dict(name=name,text=text,expected=expected,actual=result['seller_permission'],
                    next_question=result['next_question'],visit=result['visit'],ok=ok,
                    events=[r for r in s.evidence.events if r['event']=='semantic_interpretation']))
            except Exception as exc:rows.append(dict(name=name,ok=False,error=type(exc).__name__))
        for name,question,reply,expected in COVERAGE_CASES:
            s=SimpleNamespace(prompt='1. '+question+' [обязательная тема]',context={},backchannel=False,
                finalized=False,evidence=Evidence(),playback=Playback(),dialogue_mode='semantic')
            s.evidence.memory=ConversationMemory(s.prompt)
            c=SemanticController(s,None,SimpleNamespace(turn=SimpleNamespace(number=2),segment_start=None));c.http=http
            topic=s.evidence.memory.topics.required[0]['key']
            row={'id':'plan:'+topic,'topic':topic,'text':question,'response_id':'question'}
            c.last_question=dict(row);c.last_clip={'response_id':'question','text':question}
            try:
                actual=await review_answer_coverage(c,row,reply)
                ok=actual in ('unanswered','uncertain') if expected=='not_covered' else actual==expected
                rows.append(dict(name=name,expected=expected,actual=actual,ok=ok,
                    events=[r for r in s.evidence.events if r['event']=='semantic_answer_review']))
            except Exception as exc:rows.append(dict(name=name,ok=False,error=type(exc).__name__))
    path=Path(os.getenv('PIPECAT_LOG_DIR','/data/logs'))/('seller-permission-probe-'+uuid4().hex+'.json')
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps({'model':MODEL,'results':rows},ensure_ascii=False,indent=2));path.chmod(0o600)
    print(json.dumps({'report':str(path),'cases':[{k:v for k,v in r.items() if k not in ('events','text')} for r in rows]},ensure_ascii=False))
    if not all(r['ok'] for r in rows):raise SystemExit(1)

if __name__=='__main__':asyncio.run(main())
