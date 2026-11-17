import asyncio
from array import array
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

from fastapi import HTTPException
from fastapi.testclient import TestClient

import background_audio as bg
from policy import Evidence
from service import app


class BackgroundTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.source=self.root/'source';self.source.mkdir()
        env=patch.dict(os.environ,{'PIPECAT_BACKGROUND_DIR':str(self.source),'PIPECAT_LOG_DIR':str(self.root),
            'PIPECAT_HYPOTHESIS_TOKEN':'t'*40,'PIPECAT_BACKGROUND_ENABLED':'true','PIPECAT_BACKGROUND_VOLUME':'0.2'})
        env.start();self.addCleanup(env.stop)
        self.s=SimpleNamespace(evidence=Evidence())

    async def test_empty_or_disabled_pack_is_optional(self):
        self.assertIsNone(await bg.select_background(self.s,'https://test/pipecat'))
        with patch.dict(os.environ,{'PIPECAT_BACKGROUND_ENABLED':'false'}),patch.object(bg,'sources') as scan:
            self.assertIsNone(await bg.select_background(self.s,'https://test/pipecat'))
            scan.assert_not_called()

    def test_docker_source_root_does_not_evaluate_host_checkout_default(self):
        with patch.object(bg,'__file__','/app/background_audio.py'):
            self.assertEqual(bg.source_root(),self.source.resolve())

    async def test_failed_track_falls_back_to_valid_file(self):
        (self.source/'bad.mp3').write_bytes(b'bad');(self.source/'valid.wav').write_bytes(b'valid')
        asset='a'*64+'.wav'
        with patch.object(bg.secrets,'choice',side_effect=lambda files:sorted(files)[0]),patch.object(bg,'prepare_file',side_effect=[ValueError('bad'),asset]):
            result=await bg.select_background(self.s,'https://test/pipecat')
        self.assertEqual(result['volume'],.2)
        self.assertIn('/pipecat/background/'+asset,result['url'])
        self.assertNotIn('t'*40,result['url'])
        self.assertEqual(sum(e['event']=='background_prepare_failed' for e in self.s.evidence.events),1)

    def test_scan_rejects_symlink_escape_and_non_audio(self):
        outside=self.root/'outside.wav';outside.write_bytes(b'outside')
        (self.source/'escape.wav').symlink_to(outside)
        (self.source/'README.md').write_text('notes')
        (self.source/'sound.MP3').write_bytes(b'audio')
        self.assertEqual([p.name for p in bg.sources()],['sound.MP3'])

    def test_signed_media_get_head_range_and_credentials(self):
        asset='a'*64+'.wav';bg.cache_root().mkdir();pcm=b'RIFF'+bytes(range(100))
        (bg.cache_root()/asset).write_bytes(pcm)
        token=bg.signature(asset)
        with TestClient(app) as client:
            url='/background/'+asset+'?token='+token
            self.assertEqual(client.get(url).content,pcm)
            self.assertEqual(client.head(url).headers['content-length'],str(len(pcm)))
            r=client.get(url,headers={'Range':'bytes=4-13'})
            self.assertEqual(r.status_code,206);self.assertEqual(r.content,pcm[4:14])
            self.assertEqual(client.get('/background/'+asset+'?token=wrong').status_code,403)
            self.assertEqual(client.get('/background/'+'b'*64+'.wav?token='+token).status_code,403)
        with self.assertRaises(HTTPException):bg.asset_file('../secret',token)

    async def test_bad_volume_never_prepares_or_breaks_call(self):
        with patch.dict(os.environ,{'PIPECAT_BACKGROUND_VOLUME':'nan'}),patch.object(bg,'prepare_file') as prepare:
            self.assertIsNone(await bg.select_background(self.s,'https://test/pipecat'))
            prepare.assert_not_called()

    @unittest.skipUnless(shutil.which('ffmpeg'),'Real conversion runs inside Docker (ffmpeg installed there)')
    def test_actual_conversion_applies_twenty_percent_and_caches_by_content(self):
        source=self.source/'tone.wav'
        with wave.open(str(source),'wb') as wav:
            wav.setparams((1,2,16000,0,'NONE','not compressed'))
            wav.writeframes(array('h',[10000,-10000]*8000).tobytes())
        asset=bg.prepare_file(source,.2)
        with wave.open(str(bg.cache_root()/asset),'rb') as wav:
            self.assertEqual((wav.getnchannels(),wav.getsampwidth(),wav.getframerate()),(1,2,16000))
            pcm=array('h',wav.readframes(wav.getnframes()))
        self.assertTrue(all(abs(v)==2000 for v in pcm))
        with patch.object(bg.subprocess,'run') as convert:
            self.assertEqual(bg.prepare_file(source,.2),asset);convert.assert_not_called()
        self.assertNotEqual(bg.prepare_file(source,.1),asset)
