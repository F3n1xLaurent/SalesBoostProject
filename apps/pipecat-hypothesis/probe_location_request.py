"""Synthetic name/city distinctions via Decisions; no recordings or phone calls."""
import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
from turn_meaning import review_location_request,MODEL


CASES=[
    ('company_name','Добрый день, компания Первый километр, как я могу к вам обращаться?','name_only'),
    ('damaged_prefix','Компания первый километр меня как я могу к вам обращаться?','name_only'),
    ('surname','Здравствуйте, назовите ваше имя, пожалуйста.','name_only'),
    ('city','В какой город обращаетесь?','location_only'),
    ('city_confirmation','Вы обращаетесь в Омск?','location_only'),
    ('branch','В какой из наших салонов вы звоните?','location_only'),
    ('mixed','Как вас зовут и в какой город обращаетесь?','other'),
    ('residence','Вы сами в каком городе живёте?','other'),
    ('delivery','На какой адрес оформить доставку?','other'),
    ('car','Компания Первый километр. Какой автомобиль вас интересует?','other'),
    ('garbled','Но в одной компании первый километр меня запрещают и могу сама обратиться','unclear'),
    ('statement','Компания Первый километр.','unclear'),
]


async def main():
    results=[]
    async with httpx.AsyncClient() as http:
        for name,text,expected in CASES:
            events=[]
            c=SimpleNamespace(http=http,s=SimpleNamespace(evidence=SimpleNamespace(
                event=lambda event,**data:events.append({'event':event,**data}))))
            try:
                actual=await review_location_request(c,text)
                results.append(dict(name=name,text=text,expected=expected,actual=actual,ok=actual==expected,events=events))
            except Exception as exc:results.append(dict(name=name,ok=False,error=type(exc).__name__))
    path=Path(os.getenv('PIPECAT_LOG_DIR','/data/logs'))/('location-request-probe-'+uuid4().hex+'.json')
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps({'model':MODEL,'results':results},ensure_ascii=False,indent=2));path.chmod(0o600)
    print(json.dumps({'report':str(path),'cases':[{k:v for k,v in row.items() if k not in ('events','text')} for row in results]},ensure_ascii=False))
    if not all(row['ok'] for row in results):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
