"""Real API / PCM smoke probe with injected slow synthesis; never calls a phone.

Delays are intentional: this checks overlap and cancellation, not a benchmark.
"""
import asyncio
import argparse
import json
import os
from unittest.mock import patch
from uuid import uuid4

import httpx
from pipecat.frames.frames import OutputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection

from diagnostics import TraceArchive
from dialogue_controller import voice_clip
from network import elevenlabs_http_options
from pipeline import DialogueTTS
from probe_controller import PROMPT
from regression_probe import run_case


async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--scenario',choices=['visit','native']);options=parser.parse_args()
    voice=os.getenv('ELEVENLABS_VOICE_ID')
    if not voice:
        async with httpx.AsyncClient(timeout=20,**elevenlabs_http_options()) as client:
            r=await client.get('https://api.elevenlabs.io/v1/convai/agents/'+os.environ['ELEVENLABS_AGENT_ID'],
                               headers={'xi-api-key':os.environ['ELEVENLABS_API_KEY']})
            r.raise_for_status();voice=r.json()['conversation_config']['tts']['voice_id']
    source={'configuration':{'prompt':PROMPT,'businessContext':{'subjectTitle':'Лира Седан 2024'},
        'speechMode':'fast_sentence','dialogueMode':'controller','backchannel':True},
        'voiceId':voice,'ttsModel':'eleven_v4_turbo'}
    archive=TraceArchive()
    report={'id':'pthink-'+str(uuid4()),'phoneCalls':0,'injectedDelayMs':2200,
            'scope':'real Realtime / ElevenLabs / Decisions; synthetic input and phone ACK; NOT a latency benchmark','cases':[]}
    path=archive.root/(report['id']+'.json')
    native_push=DialogueTTS.push_frame

    for native in (False,True):
        if options.scenario and native!=(options.scenario=='native'):continue
        delayed=False
        audio_gate=asyncio.Event()
        async def delayed_visit(session,text):
            nonlocal delayed
            pcm=await voice_clip(session,text)
            if text.startswith('Могу подъехать') and not delayed:
                delayed=True;await asyncio.sleep(2.2)
            return pcm

        async def delayed_native(service,frame,direction=FrameDirection.DOWNSTREAM):
            nonlocal delayed
            # ElevenLabs streams PCM through its background receiver, not the
            # run_tts generator. Delay only its egress, before PreparedAudioPlayer.
            if isinstance(frame,OutputAudioRawFrame) and getattr(service,'evidence',None) and not delayed:
                delayed=True
                try:await asyncio.sleep(2.2)
                finally:audio_gate.set()
            elif delayed and not audio_gate.is_set():
                await audio_gate.wait()
            return await native_push(service,frame,direction)

        scenario={'id':'thinking_native' if native else 'thinking_visit','checks':[], 'steps':[
            {'text':'Для чего вам машина?', 'native_question_task':'Ответь одним коротким предложением: машина нужна для личных поездок за город. Без вопросов.'},
            {'text':'Спасибо, до свидания.'}]} if native else {
            'id':'thinking_visit','checks':[],'steps':[
                {'text':'Добрый день, слушаю вас.'},{'text':'Да, продаётся.'},
                {'text':'Пробег актуальный.'},{'text':'Пороги целые, ржавчины нет.'},
                {'text':'ДТП не было.'},{'text':'Скидку обсудим на месте.'},
                {'text':'Последний владелец ездил два года.'},
                {'text':'Можно завтра в первой половине дня или послезавтра во второй половине дня. Когда удобно?'},
                {'text':'Да, завтра в десять утра подойдёт.'}]}
        target='pipeline.DialogueTTS.push_frame' if native else 'dialogue_controller.voice_clip'
        with patch(target,new=delayed_native if native else delayed_visit):
            result=await run_case(source,scenario,'openai_mini',audio_tts=True)
        trace=archive.read(result['diagnosticId']);events=trace['events']
        emitted=[e for e in events if e['event']=='thinking_pause_emitted']
        fillers={e['response_id'] for e in events if e['event']=='controller_audio_queued' and e.get('kind')=='backchannel'}
        main_ids={e['response_id'] for e in events if e['event']=='assistant_response' and (
            str(e.get('response_id','')).startswith('resp_') if native else e.get('text','').startswith('Могу подъехать'))}
        checks={'pipeline':result.get('status')!='error' and not result.get('transportErrors'),
                'delayInjected':delayed,'contextualFiller':any(e.get('source')==('native_reply' if native else 'visit_tts') for e in emitted),
                'fillerPCM':any(e['event']=='backchannel_first_frame_ms' and e.get('response_id') in fillers for e in events),
                'mainPCM':any(e['event'] in ('response_tts_first_audio_ms','cached_first_frame_ms') and e.get('response_id') in main_ids for e in events),
                'mainConfirmed':any(e['event']=='response_phone_confirmed' and e.get('response_id') in main_ids for e in events),
                'hangupAfterACK':result.get('simulatedHangup',False)}
        report['cases'].append({**result,'checks':checks,'passed':all(checks.values()),'fillers':emitted})
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
        print(json.dumps({'id':report['id'],'scenario':scenario['id'],'diagnosticId':result['diagnosticId'],'checks':checks},ensure_ascii=False),flush=True)
    if not all(c['passed'] for c in report['cases']):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
