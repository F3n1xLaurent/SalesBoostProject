"""Synthetic TTS -> independent ASR -> first-contact gate; never dials a phone."""
import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import AsyncMock

from controller_audio import voice_clip
from first_contact import FirstContact
from input_quality import AudioWindow,InputQuality
from policy import Playback


CASES=[
    ('name','Добрый день, компания Первый километр, как я могу к вам обращаться?','name'),
    ('greeting','Добрый день, компания Первый километр.','greeting'),
    ('recording','Вас приветствует Первый километр. Подождите соединения.',None),
    ('business','Первый километр, автомобиль в наличии, цена триста тысяч рублей.',None),
]


async def main():
    results=[]
    for name,text,expected in CASES:
        events=[]
        s=SimpleNamespace(context={'targetLocation':{'name':'Первый километр','city':'Самара'}},
            prompt='',playback=Playback(),evidence=SimpleNamespace(event=lambda event,**data:events.append({'event':event,**data})),
            voice_id=os.getenv('ELEVENLABS_VOICE_ID') or 'AkDFEBceDTNk1RLYPzi1',tts_model='eleven_v4_turbo')
        try:
            pcm=await voice_clip(s,text)
            c=SimpleNamespace(s=s,line=SimpleNamespace(ever_human=False,can_speak=False,state='awaiting_person'),
                monitor=SimpleNamespace(turn=SimpleNamespace(number=1)),epoch=1,
                manager_speaking=lambda:False,unavailable=lambda:False,
                llm=SimpleNamespace(input_quality=InputQuality(),send_client_event=AsyncMock(),
                    reviewed_items=set(),_messages_added_manually={}))
            recovery=FirstContact(c)
            initial='первый километр меня забусили прощаться'
            window=AudioWindow(pcm,16000,-65)
            recovery.capture(initial,1,window,'synthetic-item')
            eligible=recovery.record is not None
            answer=await recovery.recover(initial,1,1)
            actual=answer['intent'] if answer else None
            row=dict(name=name,synthetic_text=text,expected=expected,actual=actual,
                eligible=eligible,ok=eligible and actual==expected,features=window.features(),events=events)
        except Exception as exc:row=dict(name=name,ok=False,error=type(exc).__name__)
        results.append(row)
        print(json.dumps({k:v for k,v in row.items() if k not in ('events','features','synthetic_text')},ensure_ascii=False),flush=True)
    path=Path(os.getenv('PIPECAT_LOG_DIR','/data/logs'))/('first-contact-probe-'+uuid4().hex+'.json')
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps({'phone_calls':0,'audio':'synthetic only','results':results},ensure_ascii=False,indent=2));path.chmod(0o600)
    print(json.dumps({'report':str(path)},ensure_ascii=False))
    if not all(row['ok'] for row in results):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
