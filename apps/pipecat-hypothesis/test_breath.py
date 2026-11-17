import asyncio
from array import array
import os
import math
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import AsyncMock,patch
import wave
from breath import BreathCue,select_breath,prepare_asset
from background_audio import asset_file
from policy import Evidence,Playback


class BreathTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env=patch.dict(os.environ,{'PIPECAT_BREATH_EXPERIMENT':'true','PIPECAT_HYPOTHESIS_TOKEN':'x'*40});self.env.start()
        self.s=SimpleNamespace(evidence=Evidence(),playback=Playback(),dialogue_mode='semantic',breath_asset='fixture')
        self.c=SimpleNamespace(s=self.s,line=SimpleNamespace(can_speak=True),epoch=1,waiting=False,started=True,
            unavailable=lambda:False,monitor=SimpleNamespace(segment_start=None),llm=SimpleNamespace(user_speaking=False),
            serializer=SimpleNamespace(send=AsyncMock()))
        self.b=BreathCue(self.c);self.b.delay=.001
        self.turn=SimpleNamespace(overlap=False,interrupted=False,number=1)
    async def asyncTearDown(self):
        self.b.cancel_pending();self.env.stop();await asyncio.sleep(0)

    async def test_manager_speech_keeps_playing_breath_but_audio_ready_stops_it(self):
        self.b.arm(self.turn);await self.b.task
        self.assertTrue(self.b.active)
        # This is the only breath hook in SemanticController.new_input().
        self.c.epoch+=1;self.b.cancel_pending()
        self.assertTrue(self.b.active)
        self.assertEqual(self.c.serializer.send.await_count,1)
        await self.b.stop('tts_ready')
        self.assertFalse(self.b.active)
        self.assertEqual(self.c.serializer.send.call_args.args[0]['action'],'stop_breath')
        self.assertFalse(self.s.playback.pending)
        self.assertFalse(self.s.playback.finish_requested)

    async def test_disabled_ivr_speech_and_closing_do_not_start_breath(self):
        with patch.dict(os.environ,{'PIPECAT_BREATH_EXPERIMENT':'false'}):
            self.b.arm(self.turn);self.assertIsNone(self.b.task)
        self.c.line.can_speak=False;self.b.arm(self.turn);self.assertIsNone(self.b.task)
        self.c.line.can_speak=True;self.s.evidence.memory.phase='closing'
        self.b.arm(self.turn);self.assertIsNone(self.b.task)
        self.s.evidence.memory.phase='dialogue';self.c.monitor.segment_start=time.monotonic()
        self.b.arm(self.turn);await self.b.task
        self.c.serializer.send.assert_not_awaited()

    async def test_stale_pending_timer_and_cooldown(self):
        self.b.arm(self.turn);self.c.epoch+=1;await self.b.task
        self.c.serializer.send.assert_not_awaited()
        self.b.arm(self.turn);await self.b.task
        self.b.arm(self.turn);await asyncio.sleep(.01)
        self.assertEqual(self.c.serializer.send.await_count,1)

    async def test_signed_asset_is_quiet_short_pcm_and_unavailable_asset_does_not_fail_call(self):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'PIPECAT_LOG_DIR':directory}):
            config=await select_breath(self.s,'https://example.test/pipecat')
            self.assertIsNotNone(config)
            from urllib.parse import urlsplit,parse_qs
            token=parse_qs(urlsplit(config['url']).query)['token'][0]
            target=asset_file(config['asset'],token)
            with wave.open(str(target),'rb') as f:
                self.assertEqual((f.getframerate(),f.getnchannels(),f.getsampwidth()),(16000,1,2))
                self.assertLessEqual(f.getnframes()/16000,1)
                quiet=array('h',f.readframes(f.getnframes()))
            with wave.open(str(Path(__file__).parent/'audio'/'breath.wav'),'rb') as f:original=array('h',f.readframes(f.getnframes()))
            self.assertGreater(max(map(abs,quiet)),0)
            self.assertLess(max(map(abs,quiet)),max(map(abs,original)))
            rms=math.sqrt(sum(v*v for v in quiet)/len(quiet))
            self.assertGreater(rms,1000)
            self.assertLess(rms,1300)
            self.assertLessEqual(max(map(abs,quiet)),8192)
            with patch('breath.prepare_asset',side_effect=OSError):self.assertIsNone(await select_breath(self.s,'https://example.test'))
