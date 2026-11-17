"""Optional independent Vox cue: never part of TTS, transcript or finish ACKs."""
import asyncio
from array import array
import hashlib
import math
import os
from pathlib import Path
import time
from uuid import uuid4
import wave
from background_audio import cache_root,signature


def enabled():return os.getenv('PIPECAT_BREATH_EXPERIMENT','false').casefold() in ('true','1','yes')


def prepare_asset():
    source=Path(__file__).parent/'audio'/'breath.wav'
    volume=float(os.getenv('PIPECAT_BREATH_VOLUME','0.18'))
    if not 0<volume<=.5:raise ValueError('Breath volume must be between 0 and 0.5')
    with wave.open(str(source),'rb') as f:
        if (f.getframerate(),f.getnchannels(),f.getsampwidth())!=(16000,1,2):raise ValueError('Invalid breath WAV')
        pcm=f.readframes(f.getnframes())
    if not 0<len(pcm)<=32000:raise ValueError('Breath must be at most one second')
    samples=array('h',pcm)
    rms=math.sqrt(sum(v*v for v in samples)/len(samples))
    peak=max(map(abs,samples))
    if rms<1:raise ValueError('Silent breath source')
    # Generated effects have arbitrary source loudness. Apply the user volume
    # to a consistent RMS reference, with a conservative peak ceiling.
    gain=min(6500*volume/rms,8192/peak)
    quiet=array('h',(int(v*gain) for v in samples)).tobytes()
    asset=hashlib.sha256(b'breath-v2-rms|'+quiet).hexdigest()+'.wav'
    root=cache_root();root.mkdir(parents=True,exist_ok=True,mode=0o700)
    target=root/asset
    if not target.exists():
        temporary=root/(uuid4().hex+'.wav')
        try:
            with wave.open(str(temporary),'wb') as f:
                f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(quiet)
            temporary.chmod(0o600);temporary.replace(target)
        finally:temporary.unlink(missing_ok=True)
    return asset,volume,len(pcm)/32


async def select_breath(session,public):
    if not enabled() or session.dialogue_mode!='semantic':return None
    try:
        asset,volume,duration=await asyncio.to_thread(prepare_asset)
        session.breath_asset=asset
        with wave.open(str(cache_root()/asset),'rb') as f:samples=array('h',f.readframes(f.getnframes()))
        level=20*math.log10(max(1,math.sqrt(sum(v*v for v in samples)/len(samples)))/32768)
        session.evidence.event('breath_configured',asset=asset,volume=volume,duration_ms=duration,loop=False,
            normalization='rms-v2',rms_dbfs=round(level,1))
        return {'url':public+'/background/'+asset+'?token='+signature(asset),'asset':asset}
    except (OSError,ValueError,wave.Error) as exc:
        session.evidence.event('breath_unavailable',error_type=type(exc).__name__)
        return None


class BreathCue:
    def __init__(self,controller):
        self.c=controller;self.task=None;self.active=False;self.last_at=-1000.
        self.delay=.3;self.cooldown=20

    def cancel_pending(self):
        if self.task and self.task is not asyncio.current_task():self.task.cancel()
        self.task=None

    def arm(self,turn):
        c=self.c
        if (not enabled() or not getattr(c.s,'breath_asset',None) or not c.line.can_speak
                or c.unavailable() or c.waiting or not c.started or turn.overlap and not turn.interrupted
                or c.s.playback.busy or c.s.playback.finish_requested
                or c.s.evidence.memory.phase in ('closing','ended','failed')
                or time.monotonic()-self.last_at<self.cooldown):return
        self.cancel_pending();epoch=c.epoch
        async def play():
            try:
                await asyncio.sleep(self.delay)
                if (epoch!=c.epoch or c.unavailable() or not c.line.can_speak or c.waiting
                        or c.monitor.segment_start is not None or getattr(c.llm,'user_speaking',False)
                        or c.s.playback.pending or c.s.playback.finish_requested):return
                command=uuid4().hex
                self.active=True;self.last_at=time.monotonic()
                await c.serializer.send({'customEvent':'control','action':'play_breath','commandId':command})
                c.s.evidence.event('breath_requested',command_id=command,source_turn=turn.number)
            except asyncio.CancelledError:pass
            except Exception as exc:c.s.evidence.event('breath_failed',error_type=type(exc).__name__)
        self.task=asyncio.create_task(play())

    async def stop(self,reason='agent_audio_ready'):
        self.cancel_pending()
        if not self.active:return
        self.active=False
        try:await self.c.serializer.send({'customEvent':'control','action':'stop_breath'})
        except Exception as exc:self.c.s.evidence.event('breath_stop_failed',error_type=type(exc).__name__)
        self.c.s.evidence.event('breath_stop_requested',reason=reason)
