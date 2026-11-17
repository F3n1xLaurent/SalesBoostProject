"""Synthetic Vox WebSocket audio through the real live pipeline; never dials PSTN.

Unlike text regression this exercises Silero/SmartTurn, initial session setup,
manual audio commit, real Realtime transcription and the paced audio output.
"""
import argparse
import asyncio
import base64
import json
import os
from contextlib import ExitStack
from uuid import uuid4
from unittest.mock import patch

import httpx
from starlette.websockets import WebSocket

from controller_audio import voice_clip, quiet_clip
from network import elevenlabs_http_options
from pipeline import GatedRealtime, run_pipeline
from service import Session, prepare_call_audio, release_call_audio


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--delay-session-ms', type=int, default=4000)
    parser.add_argument('--semantic-wait',action='store_true')
    parser.add_argument('--stt-recovery',action='store_true')
    parser.add_argument('--provider',choices=('openai','openai_mini'))
    args = parser.parse_args()
    semantic=args.semantic_wait or args.stt_recovery
    voice = os.getenv('ELEVENLABS_VOICE_ID')
    if not voice:
        async with httpx.AsyncClient(timeout=20, **elevenlabs_http_options()) as client:
            response = await client.get('https://api.elevenlabs.io/v1/voices', headers={'xi-api-key': os.environ['ELEVENLABS_API_KEY']})
            response.raise_for_status()
            voice = response.json()['voices'][0]['voice_id']
    session = Session(id=str(uuid4()), provider=args.provider or ('openai_mini' if semantic else 'openai'), tts_model='eleven_v4_turbo', voice_id=voice,
                      prompt='Актуальный ли пробег? [обязательная тема]'+('\nПороги целые? [обязательная тема]' if semantic else ''),
                      context={'subjectTitle': 'Лира Седан'}, to='', dialogue_mode='semantic' if semantic else 'controller',backchannel=semantic)
    session.is_simulation = True
    await prepare_call_audio(session)
    greeting = quiet_clip(await voice_clip(session, 'Пробег актуальный, всё верно.' if semantic else 'Добрый день, слушаю вас.'))
    if semantic:
        c=session.controller;c.started=True;c.current='mileage';c.asked['mileage']=1
        c.last_question={'text':c.texts['mileage'],'response_id':'seed-question','topic':'mileage','kind':'plan','turn':0}
        c.last_clip={'text':c.texts['mileage'],'response_id':'seed-question','pcm':c.clips['mileage']}
        c.question_ledger['plan:mileage']={'response_id':'seed-question','text':c.texts['mileage'],'state':'queued','turn':0}
    session.evidence.event('audio_startup_probe', phone_calls=0, input='synthetic ElevenLabs greeting',
                           delayed_session_confirmation_ms=args.delay_session_ms,
                           manager_audio_ms=len(greeting)/32, playback_ack='simulated')
    incoming = asyncio.Queue()
    await incoming.put({'type': 'websocket.connect'})
    audio_bytes = 0

    async def enqueue(message):
        await incoming.put({'type': 'websocket.receive', 'text': json.dumps(message)})

    async def send(message):
        nonlocal audio_bytes
        if message['type'] != 'websocket.send' or not message.get('text'):
            return
        data = json.loads(message['text'])
        if data.get('event') == 'start':
            await enqueue({'customEvent': 'playback', 'action': 'started', 'tag': data['start']['tag']})
        elif data.get('event') == 'media':
            audio_bytes += len(base64.b64decode(data['media']['payload']))
        elif data.get('event') == 'stop':
            await enqueue({'customEvent': 'playback', 'action': 'ended', 'tag': data['stop']['tag']})

    ws = WebSocket({'type': 'websocket', 'path': '/synthetic-audio-probe', 'headers': [],
                    'query_string': b'', 'scheme': 'ws', 'client': ('127.0.0.1', 0),
                    'server': ('127.0.0.1', 8093), 'subprotocols': []}, incoming.get, send)
    await ws.accept()
    session.status = 'connected'
    original = GatedRealtime._handle_evt_session_updated
    delayed = False

    async def delayed_confirmation(llm, event):
        nonlocal delayed
        if not delayed:
            delayed = True
            await asyncio.sleep(args.delay_session_ms/1000)
        await original(llm, event)

    async def feed_audio():
        await enqueue({'event': 'start', 'start': {'mediaFormat': {'encoding': 'PCM16', 'sampleRate': 16000, 'channels': 1}}})
        # Start speaking immediately; do not wait for provider/context readiness.
        pcm = b'\0\0' * 1600 + greeting + b'\0\0' * 32000
        async def send_pcm():
            for offset in range(0,len(pcm),640):
                await enqueue({'event':'media','media':{'payload':base64.b64encode(pcm[offset:offset+640]).decode()}})
                await asyncio.sleep(.02)
        await send_pcm();repeated=False
        while True:
            if args.stt_recovery and not repeated and any(e['event']=='stt_recovery_succeeded' for e in session.evidence.events):
                # Let the prepared recovery notice finish, then repeat exactly
                # the same synthetic manager answer into the new connection.
                if session.playback.busy:await asyncio.sleep(.02);continue
                repeated=True;await send_pcm()
            await enqueue({'event': 'media', 'media': {'payload': base64.b64encode(b'\0'*640).decode()}})
            await asyncio.sleep(.02)

    result = {'id': 'paudio-' + str(uuid4()), 'diagnosticId': 'pc-' + session.id,
              'phoneCalls': 0, 'scope': 'synthetic audio; real live pipeline and providers; simulated Vox playback ACK'}
    from semantic_controller import interpret as original_interpret
    async def slow_interpret(*args):
        await asyncio.sleep(2.2)
        return await original_interpret(*args)
    original_stt=GatedRealtime.handle_evt_input_audio_transcription_completed
    dropped=False
    async def drop_first_stt(llm,event):
        nonlocal dropped
        if not dropped:
            dropped=True;session.evidence.event('probe_stt_final_withheld',item_id=event.item_id)
            return
        await original_stt(llm,event)
    with ExitStack() as patches:
        patches.enter_context(patch.object(GatedRealtime, '_handle_evt_session_updated', delayed_confirmation))
        if args.semantic_wait:patches.enter_context(patch('semantic_controller.interpret',new=slow_interpret))
        if args.stt_recovery:patches.enter_context(patch.object(GatedRealtime,'handle_evt_input_audio_transcription_completed',drop_first_stt))
        running = asyncio.create_task(run_pipeline(session, ws))
        feeding = asyncio.create_task(feed_audio())
        try:
            async with asyncio.timeout(35):
                while not any(e['event']=='response_phone_confirmed' and session.evidence.delivery.responses.get(e.get('response_id'),{}).get('kind') not in ('recovery','backchannel') for e in session.evidence.events):
                    if running.done() or getattr(session, 'failure_reason', None):
                        raise RuntimeError('Live audio pipeline failed before a confirmed reply')
                    await asyncio.sleep(.05)
        except Exception as exc:
            result.update(errorType=type(exc).__name__, error=str(exc))
        finally:
            feeding.cancel()
            await asyncio.gather(feeding, return_exceptions=True)
            await incoming.put({'type': 'websocket.disconnect', 'code': 1000})
            try:
                await asyncio.wait_for(running, 15)
            except asyncio.TimeoutError:
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)
            await release_call_audio(session)
    events = session.evidence.events
    first = lambda name: next((e['seq'] for e in events if e['event'] == name), None)
    committed, ready = first('turn_committed'), first('initial_response_suppressed')
    checks = {
        'contextPrimed': first('realtime_context_primed') is not None,
        'speechCommittedBeforeContextReady': bool(committed and ready and committed < ready),
        'audioCommitSent': first('response_gate_decision') is not None,
        'finalTranscription': any(e['event'] == 'user_transcript' and e.get('text', '').strip() for e in events),
        'replyGenerated': first('controller_audio_queued') is not None,
        'audioSent': audio_bytes > 0,
        'playbackConfirmed': first('response_phone_confirmed') is not None,
        'noPipelineErrors': not any(e['event'] in ('pipeline_error', 'realtime_transport_failed') for e in events),
        'noUnsolicitedModelResponse': not any(e['event'] == 'provider_response_created' for e in events),
    }
    if semantic:checks.pop('speechCommittedBeforeContextReady')
    if args.semantic_wait:
        emitted=[e for e in events if e['event']=='thinking_pause_emitted']
        main=[e for e in events if e['event']=='controller_audio_queued' and e.get('kind')!='backchannel']
        checks.update(fillerWhileWaiting=any(e.get('source')=='turn_wait' for e in emitted),
            actualTransportFillerOwner=any(e['event']=='playback_segment_created'
                and session.evidence.delivery.responses.get(e.get('response_id'),{}).get('kind')=='backchannel' for e in events),
            fillerBeforeMain=bool(emitted and main and emitted[0]['seq']<main[0]['seq']),
            progressedToNextQuestion=session.controller.asked.get('rust')==1,
            noRepeatedQuestion=session.controller.asked.get('mileage')==1)
        result['injectedSemanticDelayMs']=2200
    if args.stt_recovery:
        checks.update(firstFinalWithheld=dropped,
            connectionRecovered=first('stt_recovery_succeeded') is not None,
            recoveriesBounded=sum(e['event']=='stt_recovery_started' for e in events)==1,
            noticePlayed=any(e['event']=='response_phone_confirmed' and session.evidence.delivery.responses.get(e.get('response_id'),{}).get('kind')=='recovery' for e in events),
            noFailureHangup=not any(e['event'] in ('hangup_after_playback','realtime_transport_failed') for e in events),
            progressedToNextQuestion=session.controller.asked.get('rust')==1,
            noRepeatedQuestion=session.controller.asked.get('mileage')==1)
        result['injectedFault']='first final STT event deliberately withheld'
    result.update(checks=checks, passed=all(checks.values()) and 'errorType' not in result, audioBytes=audio_bytes)
    session.finalized = True
    session.evidence.event('audio_startup_probe_complete', checks=checks)
    session.persist()
    path = session.archive.root / (result['id'] + '.json')
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    path.chmod(0o600)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
