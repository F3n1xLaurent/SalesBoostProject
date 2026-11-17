"""Prepare an immutable, attenuated WAV for VoxEngine's independent loop player."""
import asyncio
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import subprocess
from uuid import uuid4

from fastapi import HTTPException

FORMATS={'.wav','.mp3','.ogg','.flac','.m4a','.aac','.opus'}
ASSET=re.compile(r'^[a-f0-9]{64}\.wav$')
MAX_SOURCE=100*1024*1024
MAX_OUTPUT=10_000_000  # VoxEngine URLPlayer limit, including WAV header.


def source_root():
    configured=os.getenv('PIPECAT_BACKGROUND_DIR')
    return Path(configured).resolve() if configured else Path(__file__).resolve().parent.parent.parent/'call-background'


def cache_root():
    return Path(os.getenv('PIPECAT_LOG_DIR','/tmp'))/'background-audio'


def sources():
    root=source_root()
    if not root.is_dir():return []
    return [p for p in root.iterdir() if not p.name.startswith('.') and p.suffix.lower() in FORMATS
            and p.is_file() and p.resolve().is_relative_to(root) and p.stat().st_size<=MAX_SOURCE]


def signature(asset):
    key=os.getenv('PIPECAT_HYPOTHESIS_TOKEN','')
    if len(key)<32:raise ValueError('Background signing key is not configured')
    return hmac.new(key.encode(),('pipecat-background-v1:'+asset).encode(),hashlib.sha256).hexdigest()


def asset_file(asset,token):
    if not ASSET.fullmatch(asset) or not hmac.compare_digest(token,signature(asset)):
        raise HTTPException(403,'Invalid background credentials')
    path=cache_root()/asset
    if not path.is_file():raise HTTPException(404,'Background not found')
    return path


def prepare_file(source,volume):
    root=source_root()
    if not source.resolve().is_relative_to(root) or source.stat().st_size>MAX_SOURCE:
        raise ValueError('Invalid background file')
    content=source.read_bytes()
    asset=hashlib.sha256(f'background-v1|pcm16|16000|mono|{volume}|'.encode()+content).hexdigest()+'.wav'
    root=cache_root();root.mkdir(parents=True,exist_ok=True,mode=0o700)
    output=root/asset
    if not output.exists():
        # Snapshot bytes to avoid reading a file while the user replaces it.
        original=root/(uuid4().hex+source.suffix.lower())
        temporary=root/(uuid4().hex+'.wav')
        try:
            original.write_bytes(content);original.chmod(0o600)
            subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-i',str(original),
                '-vn','-ac','1','-ar','16000','-af',f'volume={volume}',
                '-c:a','pcm_s16le','-fs',str(MAX_OUTPUT+65536),str(temporary)],
                check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            # -fs bounds disk usage; a truncated oversized clip is rejected.
            if not 44<temporary.stat().st_size<MAX_OUTPUT:
                raise ValueError('Background must fit a 10 MB PCM WAV')
            temporary.chmod(0o600);temporary.replace(output)
        finally:
            original.unlink(missing_ok=True);temporary.unlink(missing_ok=True)
    return asset


async def select_background(session,public):
    if os.getenv('PIPECAT_BACKGROUND_ENABLED','true').lower() in ('false','0','no'):return None
    try:
        volume=float(os.getenv('PIPECAT_BACKGROUND_VOLUME','0.2'))
        if not 0<=volume<=1:raise ValueError('Invalid background volume')
        if volume==0:return None
        files=await asyncio.to_thread(sources)
        if not files:
            session.evidence.event('background_not_configured',reason='empty_directory')
            return None
        # A bad track must not block the phone call or hide valid alternatives.
        for _ in range(min(3,len(files))):
            source=secrets.choice(files);files.remove(source)
            try:asset=await asyncio.to_thread(prepare_file,source,volume)
            except (OSError,ValueError,subprocess.SubprocessError) as exc:
                session.evidence.event('background_prepare_failed',file=source.name,error_type=type(exc).__name__)
                continue
            session.evidence.event('background_selected',file=source.name,asset=asset,volume=volume,loop=True)
            return {'url':public+'/background/'+asset+'?token='+signature(asset),'asset':asset,'volume':volume}
    except (OSError,ValueError) as exc:
        session.evidence.event('background_prepare_failed',error_type=type(exc).__name__)
    return None
