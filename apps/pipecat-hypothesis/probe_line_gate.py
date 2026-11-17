"""Synthetic line classification via the real Decisions API; never dials a phone."""
import asyncio
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
import httpx
from line_gate import LineGate


CASES=[
    ('sales','Хочу купить автомобиль, звоню в отдел продаж.',
     'Для отдела продаж нажмите один. Для сервиса нажмите два. Для оператора нажмите ноль.',('ivr','1',True)),
    ('incomplete','Хочу купить автомобиль.',
     'Для сервиса нажмите один, а для отдела продаж...',('ivr',None,False)),
    ('different_purpose','Хочу записаться на техническое обслуживание автомобиля.',
     'Для покупки автомобиля нажмите один. Для записи в сервис нажмите два.',('ivr','2',True)),
    ('operator_fallback','Хочу узнать условия покупки автомобиля.',
     'Для бухгалтерии нажмите один. Для соединения с оператором нажмите ноль.',('ivr','0',True)),
    ('return_after_hold','Хочу купить автомобиль.',
     'Проверила, автомобиль в наличии, можем договориться о просмотре.',('human',None,False)),
    ('message_assistant','Хочу купить автомобиль.',
     'С вами цифровой секретарь владельца номера. Расскажите, что ему передать, я сохраню запись.',('terminal',None,False)),
    ('connecting_assistant','Хочу купить автомобиль.',
     'С вами цифровой секретарь. Сейчас попробую связаться с владельцем, не кладите трубку.',('hold',None,False)),
]


async def main():
    results=[]
    async with httpx.AsyncClient() as http:
        for name,purpose,text,expected in CASES:
            await asyncio.sleep(2)
            events=[]
            c=SimpleNamespace(s=SimpleNamespace(prompt=purpose,evidence=SimpleNamespace(
                event=lambda event,**data:events.append({'event':event,**data}))),http=http)
            line=LineGate(c);line.history=[text]
            if name=='return_after_hold':line.state='waiting_operator';line.ever_human=True
            start=time.monotonic()
            try:
                actual=await line.classify(text)
                # A non-menu must never supply a navigation digit; the
                # completeness label is irrelevant outside an IVR.
                ok=(actual==expected if expected[0]=='ivr' else actual[:2]==expected[:2])
                results.append(dict(name=name,expected=expected,actual=actual,ok=ok,
                    elapsed_ms=round((time.monotonic()-start)*1000),events=events))
            except Exception as exc:results.append(dict(name=name,ok=False,error=type(exc).__name__,
                http_status=exc.response.status_code if isinstance(exc,httpx.HTTPStatusError) else None))
    path=Path(os.getenv('PIPECAT_LOG_DIR','/data/logs'))/('line-gate-probe-'+uuid4().hex+'.json')
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(results,ensure_ascii=False,indent=2));path.chmod(0o600)
    print(json.dumps({'report':str(path),'cases':[{k:v for k,v in r.items() if k!='events'} for r in results]},ensure_ascii=False))
    if not all(r['ok'] for r in results):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
