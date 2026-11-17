"""Five transport ping RTTs per provider, no generated speech or calls."""
import asyncio
import json
import os
import statistics
import time
from uuid import uuid4
from websockets.asyncio.client import connect
from diagnostics import TraceArchive
from pipeline import create_tts
from types import SimpleNamespace
from policy import Evidence

async def samples(socket):
    result=[]
    for _ in range(5):
        start=time.monotonic()
        pong=await socket.ping()
        await asyncio.wait_for(pong,5)
        result.append(round((time.monotonic()-start)*1000,2))
        await asyncio.sleep(.2)
    return {"samplesMs":result,"medianMs":round(statistics.median(result),2)}

async def main():
    report={"id":"pnr-"+str(uuid4()),"scope":"WebSocket ping RTT; not inference latency or Vox playback","providers":{}}
    try:
        async with connect("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini",additional_headers={"Authorization":"Bearer "+os.environ["OPENAI_API_KEY"]},open_timeout=10) as socket:
            await asyncio.wait_for(socket.recv(),10)
            report["providers"]["openai"]=await samples(socket)
    except Exception as exc:
        report["providers"]["openai"]={"errorType":type(exc).__name__}
    try:
        tts=create_tts(SimpleNamespace(evidence=Evidence(),tts_model="eleven_v4_turbo",voice_id="not-used-no-text",speech_mode="sentence"))
        tts._output_format="pcm_16000"
        socket=await tts.open_socket(tts._build_websocket_url(),additional_headers={"xi-api-key":os.environ["ELEVENLABS_API_KEY"]},open_timeout=10)
        try:
            report["providers"]["elevenlabs"]=await samples(socket)
        finally:
            await socket.close()
    except Exception as exc:
        report["providers"]["elevenlabs"]={"errorType":type(exc).__name__}
    path=TraceArchive().root/(report["id"]+".json")
    path.write_text(json.dumps(report,indent=2)+"\n");path.chmod(0o600)
    print(json.dumps(report),flush=True)

if __name__=="__main__":
    asyncio.run(main())
