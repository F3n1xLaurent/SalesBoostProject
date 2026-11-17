"""Real Mini + real Pipecat/ElevenLabs vs prepared text/audio, no phone.

The local router is intentionally conservative and demo-specific. Histories are
fixed, misses use the identical baseline generation path, no tools are executed.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import time
from types import SimpleNamespace
from uuid import uuid4
import wave

import httpx
from websockets.asyncio.client import connect
from pipecat.frames.frames import (StartFrame, OutputAudioRawFrame, TTSStoppedFrame,
    LLMTextFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.workers.runner import WorkerRunner
from conversation import ConversationMemory, legacy_adapt_prompt
from network import elevenlabs_http_options
from pipeline import VoxSerializer, OutputEvidence, prepare_tts, call_context
from service import Session
from speech_filter import SpeechFilter
from probe_dialogue_state import MODEL, STEPS, message, recv_until

MODES = ("current", "prepared_text", "prepared_audio")


def cases():
    # The second tuple entry is the complete preceding fixed-history prefix.
    return [
        {"id":"opening", "prefix":0,"input":STEPS[0][1],"expected":"opening","group":"hit"},
        {"id":"mileage", "prefix":1,"input":STEPS[1][1],"expected":"mileage","group":"hit"},
        {"id":"rust", "prefix":2,"input":STEPS[2][1],"expected":"rust","group":"hit"},
        {"id":"multi_answer", "prefix":2,"input":"Пробег актуальный, пороги целые, ДТП не было. А какой у вас бюджет?","expected":"fallback","group":"miss"},
        {"id":"manager_question", "prefix":1,"input":"Вы за наличные или в кредит хотите купить?","expected":"fallback","group":"miss"},
        {"id":"correction", "prefix":2,"input":"Нет, я ошибся: пробег в объявлении неактуальный, сейчас уже тридцать тысяч километров.","expected":"fallback","group":"miss"},
        {"id":"wait", "prefix":2,"input":"Подождите минуту, пожалуйста.","expected":"wait","group":"wait"},
    ]


def select_candidate(text, last_question):
    """No expected label or future manager answers are available to this gate."""
    if re.search(r"подождите|оставайтесь на линии|соединяю", text, re.I):
        return "wait"
    if re.search(r"\?|ошиб|неактуальн|не актуальн|поправ|неверн|не прода|уже продан|дтп|пороги", text, re.I):
        return "fallback"
    if not last_question and re.fullmatch(r"\s*(?:добрый день[, .]*)?отдел продаж[, .]*слушаю вас[.! ]*", text, re.I):
        return "opening"
    if re.search(r"прода[её]тся|наличии",last_question,re.I) and re.fullmatch(r"\s*да[, .]*машина в наличии[, .]*прода[её]тся[.! ]*",text,re.I):
        return "mileage"
    if re.search(r"пробег",last_question,re.I) and re.fullmatch(r"\s*пробег двадцать тысяч километров[, .]*в объявлении актуальный[.! ]*",text,re.I):
        return "rust"
    return "fallback"


class AudioHarness:
    def __init__(self, session):
        self.s=session
        self.current=None
        self.audio=bytearray()
        self.done=asyncio.Event()
        self.started=asyncio.Event()

    async def start(self):
        async def control(text):
            pass  # No Vox connection or phone; ACK is simulated below.
        self.serializer=VoxSerializer(self.s,SimpleNamespace(send_text=control))
        owner=self
        class Emitter(FrameProcessor):
            async def process_frame(self,frame,direction):
                await super().process_frame(frame,direction)
                await self.push_frame(frame,direction)
        class Sink(FrameProcessor):
            async def process_frame(self,frame,direction):
                await super().process_frame(frame,direction)
                if isinstance(frame,StartFrame): owner.started.set()
                current=owner.current
                if current and isinstance(frame,(OutputAudioRawFrame,TTSStoppedFrame)):
                    mapped=owner.s.evidence.delivery.contexts.get(getattr(frame,"context_id",None))
                    if mapped and mapped!=current["responseId"]:
                        current["lateFramesIgnored"]=current.get("lateFramesIgnored",0)+1
                        return
                if current and isinstance(frame,OutputAudioRawFrame):
                    if frame.sample_rate!=16000 or frame.num_channels!=1 or len(frame.audio)%2:
                        raise ValueError("Expected PCM16 mono 16000")
                    if current["firstAudioMs"] is None:
                        current["firstAudioMs"]=round((time.perf_counter()-current["origin"])*1000,3)
                    owner.audio.extend(frame.audio)
                    payload=await owner.serializer.serialize(frame)
                    if payload and current.get("firstSerializedMs") is None:
                        current["firstSerializedMs"]=round((time.perf_counter()-current["origin"])*1000,3)
                if current and isinstance(frame,TTSStoppedFrame):
                    await owner.finish_audio()
                await self.push_frame(frame,direction)
        self.emitter=Emitter();self.sink=Sink()
        await prepare_tts(self.s)
        self.worker=PipelineWorker(Pipeline([self.emitter,OutputEvidence(self.s,self.serializer,"llm"),
            self.s.prepared_tts,OutputEvidence(self.s,self.serializer,"tts"),self.sink]),
            params=PipelineParams(audio_out_sample_rate=16000),enable_rtvi=False)
        self.runner=WorkerRunner(handle_sigint=False)
        await self.runner.add_workers(self.worker)
        self.running=asyncio.create_task(self.runner.run())
        await asyncio.wait_for(self.started.wait(),15)

    async def finish_audio(self):
        tag=self.s.playback.active
        await self.serializer.seal()
        if tag:
            await self.serializer.deserialize(json.dumps({"customEvent":"playback","action":"ended","tag":tag}))
        self.done.set()

    def begin(self,result):
        self.current=result;self.audio=bytearray();self.done.clear()
        e=self.s.evidence
        e.current_response_id=result["responseId"]
        e.response_text_at[result["responseId"]]=time.monotonic()
        e.output_turn=e.turn=e.turn+1

    async def text(self,text):
        if not text.strip(): return
        frame=LLMTextFrame(text)
        frame.metadata.update(tts_presegmented=True,diagnostic_response_id=self.current["responseId"])
        await self.emitter.push_frame(frame)

    async def cached(self,pcm):
        # Same output serializer and audio checks, bypass provider generation.
        # No real-time playback is simulated; first-packet availability only.
        for offset in range(0,len(pcm),640):
            await self.sink.process_frame(OutputAudioRawFrame(pcm[offset:offset+640],16000,1),FrameDirection.DOWNSTREAM)
        await self.finish_audio()

    async def settle(self,has_text):
        if has_text:
            await asyncio.wait_for(self.done.wait(),30)
        await asyncio.sleep(.15)  # Drain markers outside the first-audio metric.
        if self.current:
            self.current["audioBytes"]=len(self.audio)

    async def close(self):
        await self.runner.cancel()
        await asyncio.gather(self.running,return_exceptions=True)


def trial_record(mode,case,run):
    return {"mode":mode,"case":case["id"],"group":case["group"],"run":run,"input":case["input"],
        "responseId":"prepared-probe-"+uuid4().hex,"origin":time.perf_counter(),"firstAudioMs":None,"audioBytes":0}


def inputs_for(fixture,case):
    memory=ConversationMemory(fixture["prompt"]);history=[]
    for index,(_,user,canonical) in enumerate(STEPS[:case["prefix"]]):
        memory.user(user,index+1)
        history.extend([message("user",user),message("assistant",canonical)])
        memory.open_question={"text":canonical,"response_id":"canonical-"+str(index)}
    last_question=(memory.open_question or {}).get("text","")
    memory.user(case["input"],case["prefix"]+1)
    return history+[message("system",memory.context_text()),message("user",case["input"])],last_question


async def generate(socket,inputs,harness,result):
    await harness.emitter.push_frame(LLMFullResponseStartFrame())
    await socket.send(json.dumps({"type":"response.create","response":{"conversation":"none","input":inputs,"output_modalities":["text"]}},ensure_ascii=False))
    guard=SpeechFilter();text="";emitted=False
    async with asyncio.timeout(40):
        while True:
            evt=json.loads(await socket.recv());kind=evt["type"]
            if kind=="error":raise RuntimeError(json.dumps(evt["error"]))
            if kind in ("response.output_text.delta","response.text.delta"):
                text+=evt["delta"]
                if "firstTextMs" not in result:
                    result["firstTextMs"]=round((time.perf_counter()-result["origin"])*1000,3)
                ready=guard.feed(evt["delta"])
                if ready.strip():
                    emitted=True;await harness.text(ready)
            if kind=="response.done":
                response=evt["response"]
                result.update(providerStatus=response["status"],usage=response.get("usage"),
                    toolCalls=[o for o in response.get("output",[]) if o["type"]=="function_call"])
                if response["status"]!="completed": raise RuntimeError("Incomplete model response")
                ready=guard.feed(final=True)
                if ready.strip():emitted=True;await harness.text(ready)
                break
    result.update(text=text,filteredText=guard.spoken)
    await harness.emitter.push_frame(LLMFullResponseEndFrame())
    return emitted


def summary(rows):
    out={}
    for mode in MODES:
        out[mode]={}
        for group in ("hit","miss","all_speaking","wait"):
            selected=[r for r in rows if r["mode"]==mode and (r["group"]==group or group=="all_speaking" and r["group"]!="wait")]
            vals=[r["firstAudioMs"] for r in selected if r.get("status")=="measured" and r.get("firstAudioMs") is not None]
            out[mode][group]={"attempts":len(selected),"withAudio":len(vals),
                "firstAudioMedianMs":round(statistics.median(vals),3) if vals else None,
                "errors":sum(r.get("status")=="error" for r in selected),
                "waitSpeechObserved":sum(bool(r.get("waitSpeechObserved")) for r in selected)}
        out[mode]["perRun"]=[]
        for run in sorted({r["run"] for r in rows if r["mode"]==mode}):
            selected=[r for r in rows if r["mode"]==mode and r["run"]==run and r["group"]!="wait"]
            vals=[r["firstAudioMs"] for r in selected if r.get("status")=="measured" and r.get("firstAudioMs") is not None]
            out[mode]["perRun"].append({"run":run,"attempts":len(selected),"withAudio":len(vals),
                "medianMs":round(statistics.median(vals),3) if vals else None})
    return out


async def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--fixture",required=True);p.add_argument("--runs",type=int,default=5)
    args=p.parse_args()
    if not 1<=args.runs<=10:p.error("runs must be 1..10")
    fixture=json.loads(Path(args.fixture).read_text())
    voice=os.getenv("ELEVENLABS_VOICE_ID")
    if not voice:
        async with httpx.AsyncClient(timeout=20,**elevenlabs_http_options()) as client:
            r=await client.get("https://api.elevenlabs.io/v1/convai/agents/"+os.environ["ELEVENLABS_AGENT_ID"],headers={"xi-api-key":os.environ["ELEVENLABS_API_KEY"]});r.raise_for_status()
            voice=r.json()["conversation_config"]["tts"]["voice_id"]
    session=Session(id=str(uuid4()),provider="openai_mini",tts_model="eleven_v4_turbo",voice_id=voice,
        prompt=fixture["prompt"],context={},to="",speech_mode="fast_sentence")
    session.is_simulation=True;session.status="connected"
    ctx=call_context(session,SimpleNamespace())
    tools=[{"type":"function",**s.to_default_dict()} for s in ctx.tools.standard_tools]
    root=Path(os.getenv("PIPECAT_LOG_DIR","/tmp"))
    report={"id":"ppr-"+str(uuid4()),"model":MODEL,"reasoning":"low","ttsModel":session.tts_model,
        "planName":fixture["planName"],"phoneCalls":0,"toolExecution":False,"sttVadPlaybackMeasured":False,
        "scope":"transcript-ready to first local PCM16 frame; strict demo-only local routing; misses use Mini+TTS; prepared buffers resident in RAM",
        "fixtureSha256":hashlib.sha256(Path(args.fixture).read_bytes()).hexdigest(),"preparation":[],"cases":[]}
    path=root/(report["id"]+".json")
    def save():
        report["summary"]=summary(report["cases"])
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n");path.chmod(0o600)
    harness=AudioHarness(session)
    warmup=time.perf_counter()
    await harness.start()
    report["ttsWarmupMs"]=round((time.perf_counter()-warmup)*1000,3)
    templates={"opening":"Здравствуйте! Лира Седан ещё продаётся?","mileage":fixture["questions"][0]["text"],"rust":fixture["questions"][1]["text"]}
    cache={}
    try:
        for key,text in templates.items():
            result=trial_record("prepare",{"id":key,"group":"prepare","input":""},0)
            harness.begin(result)
            await harness.emitter.push_frame(LLMFullResponseStartFrame())
            await harness.text(text)
            await harness.emitter.push_frame(LLMFullResponseEndFrame())
            await harness.settle(True)
            pcm=bytes(harness.audio)
            if not pcm:raise RuntimeError("Empty prepared audio")
            wav_path=root/(report["id"]+"-"+key+".wav")
            with wave.open(str(wav_path),"wb") as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(pcm)
            wav_path.chmod(0o600)
            cache[key]={"text":text,"pcm":pcm,"sha256":hashlib.sha256(pcm).hexdigest()}
            result.update(text=text,pcmSha256=cache[key]["sha256"],audioPath=str(wav_path),
                synthesisReadyMs=round((time.perf_counter()-result.pop("origin"))*1000,3))
            report["preparation"].append(result);save()
        print(json.dumps({"id":report["id"],"prepared":len(cache)}),flush=True)
        async with connect("wss://api.openai.com/v1/realtime?model="+MODEL,
            additional_headers={"Authorization":"Bearer "+os.environ["OPENAI_API_KEY"]},open_timeout=15) as socket:
            await recv_until(socket,"session.created")
            await socket.send(json.dumps({"type":"session.update","session":{"type":"realtime",
                "instructions":legacy_adapt_prompt(fixture["prompt"],"Андрей"),"output_modalities":["text"],
                "reasoning":{"effort":"low"},"tools":tools,"audio":{"input":{"turn_detection":None}}}}))
            conf=(await recv_until(socket,"session.updated"))["session"]
            if conf.get("reasoning",{}).get("effort")!="low":raise RuntimeError("low not confirmed")
            for run in range(1,args.runs+1):
                for case in cases():
                    # Rotate order at each fixture and round, not all baseline first.
                    offset=(run-1+cases().index(case))%len(MODES)
                    for mode in MODES[offset:]+MODES[:offset]:
                        result=trial_record(mode,case,run)
                        harness.begin(result)
                        try:
                            inputs,last_question=inputs_for(fixture,case)
                            result["historySha256"]=hashlib.sha256(json.dumps(inputs,ensure_ascii=False).encode()).hexdigest()
                            selected="generate" if mode=="current" else select_candidate(case["input"],last_question)
                            result.update(selection=selected,selectorMs=round((time.perf_counter()-result["origin"])*1000,3),
                                selectionCorrect=None if mode=="current" else selected==case["expected"])
                            if mode!="current" and selected!=case["expected"]:
                                raise RuntimeError("Wrong selection: "+selected)
                            if selected=="wait":
                                emitted=False;result["text"]=""
                            elif selected in cache:
                                cached=cache[selected]
                                result["text"]=cached["text"]
                                if mode=="prepared_audio":
                                    if hashlib.sha256(cached["pcm"]).hexdigest()!=cached["sha256"]:raise RuntimeError("Cache corruption")
                                    await harness.cached(cached["pcm"])
                                    result["cachePcmMatches"]=bytes(harness.audio)==cached["pcm"]
                                    emitted=False
                                else:
                                    await harness.emitter.push_frame(LLMFullResponseStartFrame())
                                    await harness.text(cached["text"])
                                    await harness.emitter.push_frame(LLMFullResponseEndFrame())
                                    emitted=True
                            else:
                                emitted=await generate(socket,inputs,harness,result)
                            await harness.settle(emitted)
                            result["waitSpeechObserved"]=case["group"]=="wait" and bool(harness.audio)
                            result["status"]="measured" if case["group"]=="wait" or result["firstAudioMs"] is not None else "no_audio"
                        except Exception as exc:
                            result.update(status="error",errorType=type(exc).__name__,error=str(exc)[:1000])
                        finally:
                            result["trialWallMs"]=round((time.perf_counter()-result.pop("origin"))*1000,3)
                            report["cases"].append(result);save()
                            print(json.dumps({"id":report["id"],**{k:result.get(k) for k in ("mode","case","run","selection","status","firstAudioMs")}}),flush=True)
                        if result["status"]=="error":raise RuntimeError("Aborting after failed trial to prevent stream contamination")
    finally:
        await harness.close()
        report["selectorChecks"]={"attempts":sum(r["mode"]!="current" for r in report["cases"]),
            "wrong":sum(r.get("selectionCorrect") is False for r in report["cases"])}
        save()
        print(json.dumps({"id":report["id"],"summary":report["summary"],"selectorChecks":report["selectorChecks"]}),flush=True)


if __name__=="__main__":asyncio.run(main())
