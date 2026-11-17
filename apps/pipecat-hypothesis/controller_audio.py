"""Prepared voice clips through the regular Pipecat output and phone ACK path."""
import asyncio
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import wave
from array import array


def quiet_clip(pcm):
    """Trim only quiet edge windows; never truncate a spoken word to fit a limit."""
    samples=array("h",pcm)
    voiced=[i for i in range(0,len(samples),160) if any(abs(v)>120 for v in samples[i:i+160])]
    if not voiced:return b""
    start=max(0,voiced[0]-640);end=min(len(samples),voiced[-1]+800)
    return array("h",(int(v*.6) for v in samples[start:end])).tobytes()

from pipecat.frames.frames import DataFrame, BotBackchannelFrame, TTSStartedFrame, TTSStoppedFrame, TTSAudioRawFrame, AggregatedTextFrame, TextType
from pipecat.processors.frame_processor import FrameProcessor

_locks={}


@dataclass
class PreparedSpeechFrame(DataFrame):
    text: str
    pcm: bytes
    response_id: str


async def voice_clip(session,text):
    key=hashlib.sha256(f"controller-v1|{session.tts_model}|{session.voice_id}|16000|{text}".encode()).hexdigest()
    root=Path(os.getenv("PIPECAT_LOG_DIR","/tmp"))/"controller-clips"
    root.mkdir(exist_ok=True,mode=0o700)
    path=root/(key+".wav")
    async with _locks.setdefault(key,asyncio.Lock()):
        if not path.exists():
            from pipeline import probe_tts_service
            temp=path.with_suffix(".tmp.wav")
            try:
                await probe_tts_service(session.tts_model,session.voice_id,audio_path=temp,text=text)
                temp.chmod(0o600);temp.replace(path)
            finally:
                temp.unlink(missing_ok=True)
        with wave.open(str(path),"rb") as wav:
            if (wav.getframerate(),wav.getnchannels(),wav.getsampwidth())!=(16000,1,2):
                raise ValueError("Invalid prepared voice format")
            pcm=wav.readframes(wav.getnframes())
        if not pcm or len(pcm)%2:raise ValueError("Empty or malformed voice clip")
    return pcm


class PreparedAudioPlayer(FrameProcessor):
    """Placed after TTS. Backchannels bypass TTS but use supported frame semantics."""
    def __init__(self,session):
        super().__init__();self.session=session

    async def process_frame(self,frame,direction):
        await super().process_frame(frame,direction)
        if isinstance(frame,PreparedSpeechFrame):
            pcm,identifier=frame.pcm,frame.response_id
        elif isinstance(frame,BotBackchannelFrame) and "prepared_pcm" in frame.metadata:
            pcm=frame.metadata["prepared_pcm"];identifier=frame.metadata["diagnostic_response_id"]
        else:
            await self.push_frame(frame,direction);return
        control=self.session.controller
        if identifier!=control.playing_id:return
        context="prepared-"+identifier
        self.session.evidence.delivery.contexts[context]=identifier
        await self.push_frame(TTSStartedFrame(context_id=context,append_to_context=False),direction)
        if isinstance(frame,BotBackchannelFrame):
            notice=AggregatedTextFrame(frame.text,TextType.BACKCHANNEL,raw_text=frame.text)
            notice.append_to_context=False;notice.context_id=context
            await self.push_frame(notice,direction)
        for offset in range(0,len(pcm),640):
            if identifier!=control.playing_id:return
            audio=TTSAudioRawFrame(pcm[offset:offset+640],16000,1,context_id=context)
            await self.push_frame(audio,direction)
        await self.push_frame(TTSStoppedFrame(context_id=context),direction)
