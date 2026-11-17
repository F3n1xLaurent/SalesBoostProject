"""Fixed streamed text -> real TTS A/B and injected tool-loop recovery; no calls."""
import argparse
import asyncio
import json
import os
import statistics
import time
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
from diagnostics import TraceArchive
from network import elevenlabs_http_options
from pipeline import GatedRealtime, Turn, VoxSerializer, OutputEvidence, prepare_tts, call_context
from service import Session
from speech_filter import SpeechFilter
from pipecat.frames.frames import (StartFrame, InterruptionFrame, OutputAudioRawFrame,
    TTSStoppedFrame, LLMTextFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner

TEXT="В объявлении указан актуальный пробег? Хотел бы уточнить перед осмотром."

async def one(mode,voice,tool_loop=False):
    s=Session(id=str(uuid4()),provider="openai_mini",tts_model="eleven_v4_turbo",voice_id=voice,
        prompt="Synthetic TTS and tool-budget probe",context={},to="",speech_mode=mode)
    s.status="connected";s.is_simulation=True;s.evidence.turn=s.evidence.output_turn=1
    started,done=asyncio.Event(),asyncio.Event()
    audio=bytearray();first=None;origin=None;sent=[];vendor_text=[];hangups=[]
    async def control(text):
        if json.loads(text).get("action")=="hangup":hangups.append(text)
    serializer=VoxSerializer(s,SimpleNamespace(send_text=control))
    class Emitter(FrameProcessor):
        async def process_frame(self,frame,direction):
            await super().process_frame(frame,direction)
            await self.push_frame(frame,direction)
    class Output(FrameProcessor):
        async def process_frame(self,frame,direction):
            nonlocal first
            await super().process_frame(frame,direction)
            if isinstance(frame,StartFrame):started.set()
            if isinstance(frame,InterruptionFrame):await serializer.serialize(frame)
            if isinstance(frame,OutputAudioRawFrame):
                if first is None:first=time.monotonic()
                audio.extend(frame.audio)
                await serializer.serialize(frame)
            if isinstance(frame,TTSStoppedFrame):
                tag=s.playback.active
                await serializer.seal()
                if tag:await serializer.deserialize(json.dumps({"customEvent":"playback","action":"ended","tag":tag}))
                done.set()
            await self.push_frame(frame,direction)
    emitter=Emitter()
    await prepare_tts(s)
    original_send=s.prepared_tts._send_text
    async def observe_vendor_text(text,context_id):
        vendor_text.append(text)
        await original_send(text,context_id)
    s.prepared_tts._send_text=observe_vendor_text
    worker=PipelineWorker(Pipeline([emitter,OutputEvidence(s,serializer,"llm"),s.prepared_tts,
        OutputEvidence(s,serializer,"tts"),Output()]),params=PipelineParams(audio_out_sample_rate=16000),enable_rtvi=False)
    runner=WorkerRunner(handle_sigint=False);await runner.add_workers(worker)
    running=asyncio.create_task(runner.run());llm=None
    result={"mode":mode,"toolLoop":tool_loop,"diagnosticId":"pc-"+s.id,"status":"error"}
    try:
        await asyncio.wait_for(started.wait(),15)
        origin=time.monotonic()
        if tool_loop:
            llm=GatedRealtime(s,SimpleNamespace(turn=Turn(False,number=1)),api_key="unused-injected-tools")
            llm.push_frame=emitter.push_frame;llm.broadcast_frame=emitter.broadcast_frame
            ctx=call_context(s,serializer)
            tool=next(w.function for w in ctx.tools.direct_functions if w.name=="remember_call_fact")
            s.evidence.memory.user("Приезжайте завтра в одиннадцать.",1)
            params=SimpleNamespace(llm=llm,result_callback=AsyncMock())
            for _ in range(21):await tool(params,key="visit_time",value="неподтверждённое",evidence="неверная цитата")
        else:
            identifier="synthetic-"+s.id
            s.evidence.current_response_id=identifier
            s.evidence.response_text_at[identifier]=origin
            s.evidence.assistant(identifier,TEXT,source="synthetic_stream")
            s.evidence.delivery.response(identifier)["generated_done"]=True
            await emitter.push_frame(LLMFullResponseStartFrame())
            guard=SpeechFilter()
            for offset in range(0,len(TEXT),8):
                await asyncio.sleep(max(0,origin+offset/8*.04-time.monotonic()))
                text=guard.feed(TEXT[offset:offset+8])
                if text:
                    sent.append(text);frame=LLMTextFrame(text)
                    frame.metadata["diagnostic_response_id"]=identifier
                    frame.metadata["tts_presegmented"]=mode=="fast_sentence"
                    await emitter.push_frame(frame)
            text=guard.feed(final=True)
            if text:
                sent.append(text);frame=LLMTextFrame(text)
                frame.metadata["tts_presegmented"]=mode=="fast_sentence"
                frame.metadata["diagnostic_response_id"]=identifier
                await emitter.push_frame(frame)
            await emitter.push_frame(LLMFullResponseEndFrame())
        await asyncio.wait_for(done.wait(),25)
        # Let the final context marker drain before inspecting flags.
        await asyncio.sleep(.1)
        checks={"audio":bool(audio)}
        if tool_loop:
            checks.update(actualRejectedTools=sum(e["event"]=="memory_fact" for e in s.evidence.events)==2,
                oneClarification=sum(e["event"]=="tool_clarification_requested" for e in s.evidence.events)==1,
                noInventedFacts=not s.evidence.memory.facts,noHangup=not hangups)
        else:
            checks["sameText"]="".join(sent)==TEXT
            checks["sameVendorText"]=" ".join(" ".join(vendor_text).split())==" ".join(TEXT.split())
        result.update(status="measured" if all(checks.values()) else "error",checks=checks,
            firstTextToAudioMs=round((first-origin)*1000,2) if first else None,audioBytes=len(audio))
        path=TraceArchive().root/("tts-"+s.id+".wav")
        with wave.open(str(path),"wb") as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(audio)
        path.chmod(0o600);result["audioPath"]=str(path)
    except Exception as exc:result["errorType"]=type(exc).__name__
    finally:
        if llm and llm.clarification_task:
            llm.clarification_task.cancel();await asyncio.gather(llm.clarification_task,return_exceptions=True)
        await runner.cancel();await asyncio.gather(running,return_exceptions=True)
        s.status="disconnected";s.finalized=True;s.persist()
    return result

async def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--runs",type=int,default=5)
    args=parser.parse_args();voice=os.getenv("ELEVENLABS_VOICE_ID")
    if not voice:
        async with httpx.AsyncClient(timeout=20,**elevenlabs_http_options()) as client:
            r=await client.get("https://api.elevenlabs.io/v1/convai/agents/"+os.environ["ELEVENLABS_AGENT_ID"],headers={"xi-api-key":os.environ["ELEVENLABS_API_KEY"]});r.raise_for_status()
            voice=r.json()["conversation_config"]["tts"]["voice_id"]
    report={"id":"pta-"+str(uuid4()),"scope":"synthetic streamed text to TTS audio; no LLM inference, VAD or phone; paired order; 8 characters/40ms","text":TEXT,"cases":[]}
    path=TraceArchive().root/(report["id"]+".json")
    for index in range(args.runs):
        for mode in (("sentence","fast_sentence") if index%2==0 else ("fast_sentence","sentence")):
            result=await one(mode,voice);result["run"]=index+1;report["cases"].append(result)
            path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n");path.chmod(0o600)
            print(json.dumps({"id":report["id"],**result}),flush=True)
    report["toolLoopProbe"]=await one("fast_sentence",voice,tool_loop=True)
    report["summary"]={}
    for mode in ("sentence","fast_sentence"):
        cases=[c for c in report["cases"] if c["mode"]==mode];values=[c["firstTextToAudioMs"] for c in cases if c["status"]=="measured"]
        report["summary"][mode]={"attempts":len(cases),"passed":len(values),"medianMs":round(statistics.median(values),2) if values else None}
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n");path.chmod(0o600)
    print(json.dumps({"id":report["id"],"summary":report["summary"],"toolLoop":report["toolLoopProbe"]}),flush=True)

if __name__=="__main__":asyncio.run(main())
