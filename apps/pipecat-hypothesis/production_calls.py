"""Authenticated two-phase call-plan adapter; never exposed by the public gateway."""
import asyncio
import time
import uuid
from datetime import datetime,timezone
from fastapi import HTTPException,Depends
from pydantic import BaseModel,Field

PROFILE={'provider':'openai','ttsModel':'eleven_v4_turbo','dialogueMode':'semantic',
         'backchannel':True,'reasoningEffort':'low','trimIdleAudio':False}
TERMINAL={'disconnected','failed','busy','no_answer','cancelled'}


def snapshot(s):
    events=s.evidence.events
    dialogue=getattr(s.evidence,'dialogue_events',events)
    heard={e.get('response_id') for e in dialogue if e['event']=='response_phone_confirmed'}
    turns={}
    for e in dialogue:
        if e['event']=='user_transcript' and e.get('text','').strip():
            key=('user',e.get('item_id') or e.get('turn'))
            turns[key]={'role':'manager','text':e['text'].strip(),'seq':e['seq']}
        elif e['event']=='assistant_response' and e.get('response_id') in heard:
            identifier=e['response_id'];message=s.evidence.messages.get(identifier,e)
            text=message.get('spoken_text',message.get('text','')).strip()
            if text:turns[('assistant',identifier)]={'role':'client','text':text,'seq':e['seq']}
    connected=getattr(s,'production_connected_at',None)
    ended=getattr(s,'production_ended_at',None)
    metrics=[{k:v for k,v in e.items() if k in ('event','turn','latency_ms','response_id')}
             for e in events if isinstance(e.get('latency_ms'),(int,float))]
    return {'callId':s.id,'diagnosticId':'pc-'+s.id,'status':s.status,'finalized':s.finalized,
        'to':s.to,'createdAt':datetime.fromtimestamp(s.created,timezone.utc).isoformat(),
        'connectedAt':connected,'endedAt':ended,'voxSessionId':getattr(s,'production_vox_id',None),
        'recordingStarted':getattr(s,'production_recording',False),'failureReason':getattr(s,'failure_reason',None) or
            (getattr(s,'line_terminal_reason',None) if getattr(s,'line_outcome',None) in ('busy','no_answer') else None),
        'ivrDetected':getattr(s,'ivr_detected',False),'ivrPath':list(getattr(s,'ivr_path',[])),
        'lineState':getattr(getattr(getattr(s,'controller',None),'line',None),'state',None),
        'lineTerminalReason':getattr(s,'line_terminal_reason',None),
        'transcript':[{k:r[k] for k in ('role','text')} for r in sorted(turns.values(),key=lambda r:r['seq'])],
        'profile':{**PROFILE,'voiceId':s.voice_id,'model':'gpt-realtime-2.1'},'metrics':metrics,
        'usage':[e for e in events if e['event'] in ('pipecat_metric','tts_text_sent')],
        'callState':s.evidence.memory.snapshot()}


class Prepare(BaseModel):
    callId:uuid.UUID
    to:str=Field(pattern=r'^\+[1-9]\d{9,14}$')
    voiceId:str=Field(min_length=1,max_length=100)
    prompt:str=Field(min_length=1,max_length=100000)
    context:dict=Field(default_factory=dict)


def register(service):
    app=service.app
    locks={}
    def lock(identifier):return locks.setdefault(identifier,asyncio.Lock())

    @app.post('/production/sessions',dependencies=[Depends(service.auth)])
    async def prepare(options:Prepare):
        identifier=str(options.callId)
        async with lock(identifier):
            if identifier in service.sessions:
                s=service.sessions[identifier]
                if not s.production or (s.to,s.prompt,s.voice_id)!=(options.to,options.prompt,options.voiceId):
                    raise HTTPException(409,'Call ID is already assigned')
                return snapshot(s)
            try:existing=service.TraceArchive().read(identifier)
            except FileNotFoundError:existing=None
            if existing:
                raise HTTPException(409,'Call ID already exists; dialing is never repeated')
            for old in list(service.sessions.values()):
                if old.production and old.status=='prepared' and time.time()-old.created>180:
                    old.status='cancelled';old.finalized=True;old.production_ended_at=service.utc_now();old.persist()
                    await service.release_call_audio(old)
                if old.production and old.finalized and time.time()-old.created>3600:
                    await service.release_call_audio(old)
                    service.sessions.pop(old.id,None)
            if sum(s.status in {'prepared','dialing','connected','ending'} for s in service.sessions.values())>=4:
                raise HTTPException(429,'Pipecat concurrency limit reached')
            public=service.production_public_url()
            call=service.Call(**PROFILE,to=options.to,voiceId=options.voiceId,prompt=options.prompt,context=options.context)
            # Reserve capacity before awaiting any upstream provider.
            s=service.Session(identifier,call.provider,call.ttsModel,call.voiceId,call.prompt,call.context,call.to,
                reasoning_effort='low',dialogue_mode='semantic',backchannel=True,production=True)
            service.sessions[identifier]=s
            try:
                result=await service.preflight(call)
                s.evidence.event('preflight',result=result)
                await service.prepare_call_audio(s)
                s.persist()
                return snapshot(s)
            except Exception:
                s.status='failed';s.finalized=True;s.failure_reason='preparation_failed';s.persist()
                await service.release_call_audio(s)
                raise

    @app.post('/production/sessions/{identifier}/start',dependencies=[Depends(service.auth)])
    async def start(identifier:uuid.UUID):
        identifier=str(identifier)
        async with lock(identifier):
            s=service.sessions.get(identifier)
            if not s or not s.production:raise HTTPException(409,'Prepared call unavailable; never redial after restart')
            if s.status!='prepared':return snapshot(s)
            if time.time()-s.created>180:
                s.status='cancelled';s.finalized=True;s.production_ended_at=service.utc_now();s.persist()
                await service.release_call_audio(s)
                raise HTTPException(409,'Preparation expired; dialing was not started')
            # Durable intent before StartScenarios. Repeated requests cannot dial
            # again even if the first HTTP response or process was lost.
            s.status='dialing';s.persist()
            try:
                await service.dial_pipecat(s,service.production_public_url())
            except Exception:
                s.status='failed';s.finalized=True;s.failure_reason='dial_failed_or_uncertain'
                s.production_ended_at=service.utc_now();s.persist()
                await service.release_call_audio(s)
                raise
            return snapshot(s)

    @app.post('/production/sessions/{identifier}/discard',dependencies=[Depends(service.auth)])
    async def discard(identifier:uuid.UUID):
        async with lock(str(identifier)):
            s=service.sessions.get(str(identifier))
            if s and s.production and s.status=='prepared':
                s.status='cancelled';s.finalized=True;s.production_ended_at=service.utc_now();s.persist()
                await service.release_call_audio(s)
            return {'ok':True}

    @app.get('/production/sessions/{identifier}',dependencies=[Depends(service.auth)])
    async def read(identifier:uuid.UUID):
        identifier=str(identifier)
        s=service.sessions.get(identifier)
        if s and s.production:return snapshot(s)
        try:record=service.TraceArchive().read(identifier)
        except FileNotFoundError:raise HTTPException(404,'Production call not found')
        result=record.get('productionSnapshot') if record else None
        if not result:raise HTTPException(404,'Production call not found')
        if not result['finalized']:
            result={**result,'status':'failed','finalized':True,'endedAt':service.utc_now(),
                'failureReason':'pipecat_process_restarted'}
        return result
