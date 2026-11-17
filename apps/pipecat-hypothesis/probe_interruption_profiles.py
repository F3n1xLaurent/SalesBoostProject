"""Actual policy timers on simulated VAD events, not ASR/audio quality tests."""
import asyncio
import json
import statistics
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from pipeline import TurnMonitor, Turn
from policy import Evidence, Playback


async def main():
    report={"id":"pbi-"+str(uuid4()),"scope":"five repeats per simulated VAD duration; real asyncio timer; no audio, ASR, model or phone",
        "cases":[],"summary":{}}
    for threshold in (400,600,850):
        for label,duration in (("short_ugu",.3),("slow_ugu",.75),("full_interruption",1.4)):
            for index in range(5):
                s=SimpleNamespace(evidence=Evidence(),playback=Playback(generated=True),interruption_ms=threshold)
                monitor=TurnMonitor(s);monitor.turn=Turn(True,number=1)
                start=time.monotonic();latency=None
                async def interrupt():
                    nonlocal latency
                    latency=round((time.monotonic()-start)*1000,2)
                monitor.interrupt=interrupt;monitor.segment_start=start
                monitor.timer=asyncio.create_task(monitor.sustained())
                await asyncio.sleep(duration+.2)
                monitor.segment_start=None;monitor.cancel_timer()
                await asyncio.sleep(0)
                report["cases"].append({"thresholdMs":threshold,"case":label,"run":index+1,
                    "speechMs":duration*1000,"interrupted":latency is not None,"latencyFromVadStartMs":latency})
        cases=[r for r in report["cases"] if r["thresholdMs"]==threshold]
        values=[r["latencyFromVadStartMs"] for r in cases if r["case"]=="full_interruption"]
        report["summary"][threshold]={"falseBackchannelInterruptions":sum(r["interrupted"] for r in cases if r["case"]!="full_interruption"),
            "backchannelAttempts":10,"fullSpeechMedianMs":round(statistics.median(values),2)}
        print(json.dumps({"threshold":threshold,**report["summary"][threshold]}),flush=True)
    root=Path(__file__).resolve().parents[2]/"storage/pipecat-benchmarks";root.mkdir(parents=True,exist_ok=True)
    path=root/(report["id"]+".json");path.write_text(json.dumps(report,indent=2)+"\n");path.chmod(0o600)
    print(json.dumps({"id":report["id"],"path":str(path),"summary":report["summary"]}),flush=True)

if __name__=="__main__":asyncio.run(main())
