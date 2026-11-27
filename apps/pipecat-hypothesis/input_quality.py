"""Bounded audio evidence and conservative admission of telephone ASR results.

The live model has no confidence scores. Quiet audio is a reason to verify,
never sufficient evidence to delete a short answer. PCM is kept in RAM only.
"""
import asyncio
from array import array
from collections import deque
from dataclasses import dataclass
import io
import math
import os
import re
import statistics
import sys
import time
import unicodedata
import wave

import httpx


def db(rms):return 20*math.log10(max(rms,1e-9))


def level(pcm):
    samples=array('h');samples.frombytes(pcm[:len(pcm)//2*2])
    if sys.byteorder!='little':samples.byteswap()
    return math.sqrt(sum(x*x for x in samples)/max(1,len(samples)))/32768


@dataclass(frozen=True)
class AudioWindow:
    pcm: bytes
    rate: int
    noise_db: float
    clipped: bool = False

    def features(self):
        size=max(2,self.rate//50*2)
        levels=[db(level(self.pcm[i:i+size])) for i in range(0,len(self.pcm),size) if len(self.pcm[i:i+size])>=2]
        loud=sorted(levels)[int((len(levels)-1)*.9)] if levels else -180
        return {'duration_ms':round(len(self.pcm)/self.rate/2*1000,1),
            'rms_db':round(db(level(self.pcm)),1),'noise_db':round(self.noise_db,1),
            'snr_db':round(loud-self.noise_db,1),
            'energetic_ms':sum(x>=max(-58,self.noise_db+6) for x in levels)*20,
            'clipped':self.clipped}

    def wav(self):
        out=io.BytesIO()
        with wave.open(out,'wb') as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(self.rate);wav.writeframes(self.pcm)
        return out.getvalue()


class TurnAudio:
    """At most 31 seconds of mono PCM plus eight immutable committed windows."""
    def __init__(self):
        self.rate=0;self.blocks=deque();self.total=0;self.bytes=0
        self.noise=deque(maxlen=75);self.active=None;self.starts={};self.windows={}
        self.last_commit=0

    def clear(self):self.__init__()

    def append(self,pcm,rate,channels=1):
        if channels!=1 or rate not in (8000,16000,24000,48000):return
        if self.rate and rate!=self.rate:self.clear()
        self.rate=rate;size=rate//50*2
        for i in range(0,len(pcm),size):
            block=bytes(pcm[i:i+size]);block=block[:len(block)//2*2]
            if not block:continue
            self.blocks.append((self.total,block));self.total+=len(block);self.bytes+=len(block)
            if self.active is None:self.noise.append(db(level(block)))
        while self.blocks and self.bytes>rate*2*31:
            self.bytes-=len(self.blocks.popleft()[1])

    def begin(self,turn):
        if turn in self.starts:return
        values=sorted(self.noise)
        floor=values[int((len(values)-1)*.2)] if values else -65
        self.starts[turn]=(max(self.last_commit,self.total-int(self.rate*.3)*2),floor)
        while len(self.starts)>8:del self.starts[next(iter(self.starts))]
        self.active=turn

    def commit(self,turn):
        if turn not in self.starts:return
        start,floor=self.starts.pop(turn)
        clipped=bool(self.blocks and self.blocks[0][0]>start)
        pcm=b''.join(block[max(0,start-pos):] for pos,block in self.blocks if pos+len(block)>start)
        if pcm and self.rate:self.windows[turn]=AudioWindow(pcm,self.rate,floor,clipped)
        while len(self.windows)>8:del self.windows[next(iter(self.windows))]
        self.last_commit=self.total
        if self.active==turn:self.active=None

    def pop(self,turn):return self.windows.pop(turn,None)


def foreign_script(text):
    return any(unicodedata.name(c,'').startswith(('CJK','HIRAGANA','KATAKANA','ARABIC','DEVANAGARI')) for c in text if c.isalpha())


BRANDS=set('audi bmw volvo volga toyota camry corolla kia hyundai lada haval chery geely mercedes benz volkswagen skoda renault nissan lexus tank omoda jetour trade in cvt amt at mt abs esp vin suv'.split())


def suspicion(text,window,speech_ms,known_words=''):
    reasons=[]
    if foreign_script(text):reasons.append('foreign_script')
    latin=re.findall(r'[a-z]+',text.casefold())
    known=BRANDS|set(re.findall(r'[a-z]+',known_words.casefold()))
    # Explicit mixed-script brand/model strings are checked too, not erased.
    if re.search('[а-яё]',text,re.I) and any(word not in known and len(word)>1 for word in latin):reasons.append('unknown_mixed_word')
    if window and 0<=speech_ms<350 and len(re.findall(r'\w+',text))>=4:reasons.append('speech_text_mismatch')
    features=window.features() if window else None
    if features and (features['rms_db']<-50 or features['rms_db']<-47 and (features['snr_db']<8 or features['energetic_ms']<80)):reasons.append('weak_audio')
    return reasons,features


def tokens(text):return re.findall(r'[\w]+',text.casefold().replace('ё','е'))


@dataclass(frozen=True)
class Admission:
    status: str  # accepted / noise / uncertain
    text: str
    reason: str
    features: dict | None = None


class InputQuality:
    def __init__(self,verify=None,timeout=3.0,require_audio=False):
        self.verify=verify or self.transcribe
        self.require_audio=require_audio
        self.timeout=timeout;self.calls=0;self.limit=8;self.last_call=-1000.;self.lock=asyncio.Lock()

    async def transcribe(self,window):
        key=os.environ.get('PROXYAPI_API_KEY')
        direct=not key
        key=key or os.environ.get('OPENAI_API_KEY')
        if not key:raise RuntimeError('ASR verification unavailable')
        base='https://api.openai.com/v1' if direct else 'https://openai.api.proxyapi.ru/v1'
        model='gpt-4o-mini-transcribe' if direct else 'openai/gpt-4o-mini-transcribe'
        # No automatic retries, no transcript prompt that could bias an answer.
        async with httpx.AsyncClient(timeout=self.timeout,follow_redirects=False) as client:
            response=await client.post(base+'/audio/transcriptions',
                headers={'Authorization':'Bearer '+key},
                data={'model':model,'language':'ru','response_format':'json','include[]':'logprobs'},
                files={'file':('turn.wav',window.wav(),'audio/wav')})
            response.raise_for_status();result=response.json()
        return result

    async def verify_window(self,window):
        """Shared bounded verifier; callers decide which evidence it can admit."""
        if self.lock.locked() or self.calls>=self.limit or time.monotonic()-self.last_call<1:
            return None,'verification_budget'
        async with self.lock:
            self.calls+=1;self.last_call=time.monotonic()
            try:
                async with asyncio.timeout(self.timeout):result=await self.verify(window)
            except asyncio.CancelledError:raise
            except Exception:return None,'verification_unavailable'
        return result,None

    async def assess(self,text,window,speech_ms,known_words=''):
        reasons,features=suspicion(text,window,speech_ms,known_words)
        if self.require_audio and not window:return Admission('uncertain','','verification_audio_unavailable',features)
        if not reasons:return Admission('accepted',text,'normal',features)
        if window and features['rms_db']<-80:return Admission('noise','','digital_silence',features)
        if not window or window.clipped or features['duration_ms']>10000:
            return Admission('uncertain','','verification_audio_unavailable',features)
        result,error=await self.verify_window(window)
        if error:return Admission('uncertain','',error,features)
        if not isinstance(result,dict):return Admission('uncertain','','invalid_verification',features)
        reviewed=result.get('text','')
        if not isinstance(reviewed,str):return Admission('uncertain','','invalid_verification',features)
        reviewed=reviewed.strip()
        if not reviewed:
            return Admission('noise' if 'weak_audio' in reasons else 'uncertain','','empty_verification',features)
        if foreign_script(reviewed):return Admission('uncertain','','unsupported_verification',features)
        text_reasons,_=suspicion(reviewed,None,speech_ms,known_words)
        if text_reasons:return Admission('uncertain','','suspect_verification_text',features)
        first=tokens(text);second=tokens(reviewed)
        # A second recognizer must never silently change an explicit number,
        # yes/no, date or appointment expressed by the first recognizer.
        numbers=lambda s:re.findall(r'\d+',s)
        if numbers(text)!=numbers(reviewed):return Admission('uncertain','','number_disagreement',features)
        protected={'да','нет','не','нельзя','можно','сегодня','завтра','послезавтра','понедельник','вторник','среду','четверг','пятницу','субботу','воскресенье',
            'ноль','один','одного','два','двух','три','трех','четыре','четырех','пять','пяти','шесть','шести','семь','семи','восемь','восьми','девять','девяти','десять','десяти','одиннадцать','одиннадцати','двенадцать','двенадцати','двадцать','двадцати'}
        if set(first)&protected!=set(second)&protected:
            return Admission('uncertain','','answer_disagreement',features)
        rows=result.get('logprobs')
        probabilities=[r.get('logprob') for r in rows if isinstance(r,dict)] if isinstance(rows,list) else []
        finite=[x for x in probabilities if isinstance(x,(float,int)) and math.isfinite(x)]
        if finite:features={**features,'verification_mean_logprob':round(statistics.mean(finite),3)}
        if first==second:
            if features['energetic_ms']<60 and features['snr_db']<6:
                return Admission('uncertain','','insufficient_audio_evidence',features)
            if finite and statistics.mean(finite)<-1:
                return Admission('uncertain','','low_verification_confidence',features)
            return Admission('accepted',reviewed,'verified_agreement',features)
        # Do not "repair" a hallucination into a plausible Russian statement.
        # Call 1517 showed that even a confident second model can do that.
        return Admission('uncertain','','transcript_disagreement',features)
