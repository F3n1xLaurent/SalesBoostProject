"""Replay approved call-1517 audio against admission checks; never makes calls."""
import argparse
import asyncio
import json
from pathlib import Path
import time
import wave

from input_quality import AudioWindow,InputQuality


async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--verify-api',action='store_true',help='Send these audio excerpts to configured ASR provider (requires consent).')
    options=parser.parse_args()
    with wave.open(str(Path(options.input_dir)/'channel-0.wav'),'rb') as wav:
        rate=wav.getframerate();audio=wav.readframes(wav.getnframes())
    cases=[
        ('hello',1.7,3.2,'Алло.',276.58,True),
        ('listing_question',12.8,15.,'По какому объявлению?',1191.95,True),
        ('availability',30.7,33.8,'да Да, автомобиль продается в наличии.',2120.44,True),
        ('foreign_noise',38.7,39.6,'学校',160.2,False),
        ('mixed_noise',46.1,47.6,'comes самом начале',757.76,False),
    ]
    async def no_api(window):raise RuntimeError('Offline probe')
    results=[]
    for name,start,end,text,speech,accepted in cases:
        pcm=audio[int(start*rate)*2:int(end*rate)*2]
        window=AudioWindow(pcm,rate,-65)
        gate=InputQuality(None if options.verify_api else no_api)
        begin=time.monotonic();result=await gate.assess(text,window,speech,'Volga K50')
        row={'id':name,'input':text,'status':result.status,'reason':result.reason,'acceptedText':result.text,
            'features':result.features,'ms':round((time.monotonic()-begin)*1000,2),'verificationCalls':gate.calls,
            'passed':(result.status=='accepted')==accepted}
        results.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
    report={'scope':__doc__,'realApi':options.verify_api,'cases':results,'phoneCalls':0}
    output=Path(options.output);output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');output.chmod(0o600)
    if not all(row['passed'] for row in results):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
