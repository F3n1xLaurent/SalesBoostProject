import asyncio
from array import array
import math
import unittest
from unittest.mock import AsyncMock,patch

from input_quality import AudioWindow,TurnAudio,InputQuality,suspicion


def pcm(seconds=.4,amplitude=6000,rate=16000):
    return array('h',(int(amplitude*math.sin(2*math.pi*230*i/rate)) for i in range(int(rate*seconds)))).tobytes()


class AudioTests(unittest.TestCase):
    def test_window_contains_current_turn_onset_and_never_a_previous_commit(self):
        collector=TurnAudio();collector.append(pcm(2,20),16000)
        collector.begin(1);first=pcm(.2,3000);collector.append(first,16000);collector.commit(1)
        one=collector.pop(1)
        self.assertTrue(one.pcm.endswith(first));self.assertLess(len(one.pcm),16000*2)
        collector.append(b'\x01\x00'*1000,16000);collector.begin(2)
        fresh=pcm(.1,6000);collector.append(fresh,16000);collector.commit(2)
        two=collector.pop(2)
        self.assertTrue(two.pcm.endswith(fresh));self.assertNotIn(first,two.pcm)
        self.assertIsNone(collector.pop(2))

    def test_long_turn_is_bounded_and_cannot_be_replaced_with_a_truncated_tail(self):
        collector=TurnAudio();collector.append(pcm(.4),16000);collector.begin(1)
        for _ in range(40):collector.append(pcm(1,20),16000)
        collector.commit(1);window=collector.pop(1)
        self.assertLessEqual(collector.bytes,16000*2*31)
        self.assertTrue(window.clipped)

    def test_ordinary_short_answers_and_vehicle_names_take_the_fast_path(self):
        strong=AudioWindow(pcm(.25),16000,-60)
        for text in ('Да','Нет.','Алло','Михаил','4','BMW X5','Toyota Camry','Вольга K50'):
            with self.subTest(text=text):self.assertFalse(suspicion(text,strong,250)[0])
        self.assertFalse(suspicion('Рассматриваю CustomBrand X1',strong,600,'CustomBrand X1')[0])

    def test_mixed_garbage_and_quiet_audio_need_verification(self):
        strong=AudioWindow(pcm(),16000,-60)
        for text in ('学校','確認','いい','这个','的 твоей','comes самом начале'):
            with self.subTest(text=text):self.assertTrue(suspicion(text,strong,600)[0])
        quiet=AudioWindow(pcm(.3,25),16000,-65)
        self.assertIn('weak_audio',suspicion('финансы',quiet,160)[0])


class AdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_extra_request_for_a_clean_short_negative_answer(self):
        verify=AsyncMock()
        result=await InputQuality(verify).assess('Нет.',AudioWindow(pcm(.2),16000,-60),200)
        self.assertEqual(result.status,'accepted');self.assertEqual(result.text,'Нет.');verify.assert_not_awaited()

    async def test_numeric_and_polarity_changes_never_become_booking_facts(self):
        strong=AudioWindow(pcm(),16000,-60)
        for first,second in [('的 завтра в 10','Завтра в 11'),('comes да','Нет'),('comes можно приехать завтра','Можно приехать сегодня'),
                ('comes не подходит','Подходит'),('comes завтра в десять','Завтра в одиннадцать')]:
            with self.subTest(first=first):
                gate=InputQuality(AsyncMock(return_value={'text':second,'logprobs':[{'logprob':-.01}]}))
                result=await gate.assess(first,strong,600)
                self.assertEqual(result.status,'uncertain');self.assertFalse(result.text)

    async def test_call_1517_mixed_artifact_is_not_rewritten_as_a_plausible_statement(self):
        verify=AsyncMock(return_value={'text':'В самом начале','logprobs':[{'logprob':-.1}]})
        result=await InputQuality(verify).assess('comes самом начале',AudioWindow(pcm(),16000,-60),600)
        self.assertEqual(result.status,'uncertain');self.assertEqual(result.reason,'transcript_disagreement')
        result=await InputQuality(verify).assess('comes самом начале',AudioWindow(pcm(.3,25),16000,-65),160)
        self.assertEqual(result.status,'uncertain')
        result=await InputQuality(verify).assess('学校',AudioWindow(pcm(),16000,-60),600)
        self.assertEqual(result.status,'uncertain')

    async def test_similar_sentences_cannot_change_a_product_property(self):
        gate=InputQuality(AsyncMock(return_value={'text':'Да автомобиль в наличии и цвет белый','logprobs':[{'logprob':-.01}]}))
        result=await gate.assess('Да автомобиль в наличии и цвет черный',AudioWindow(pcm(.4,25),16000,-65),600)
        self.assertEqual(result.status,'uncertain')

    async def test_empty_second_pass_distinguishes_noise_from_unrecognised_clear_speech(self):
        verify=AsyncMock(return_value={'text':''})
        quiet=await InputQuality(verify).assess('comes самом начале',AudioWindow(pcm(.3,20),16000,-65),160)
        clear=await InputQuality(verify).assess('学校',AudioWindow(pcm(),16000,-65),600)
        self.assertEqual(quiet.status,'noise');self.assertEqual(clear.status,'uncertain')

    async def test_timeout_and_malformed_response_do_not_block_or_accept_primary_garbage(self):
        async def stalled(window):await asyncio.Event().wait()
        result=await InputQuality(stalled,timeout=.01).assess('学校',AudioWindow(pcm(),16000,-60),600)
        self.assertEqual(result.status,'uncertain');self.assertEqual(result.reason,'verification_unavailable')
        for result in (None,[],{'text':[]},{'text':'Другие слова','logprobs':None}):
            gate=InputQuality(AsyncMock(return_value=result))
            self.assertEqual((await gate.assess('学校',AudioWindow(pcm(),16000,-60),600)).status,'uncertain')

    async def test_verification_is_once_per_audio_and_bounded_per_call(self):
        verify=AsyncMock(return_value={'text':''})
        gate=InputQuality(verify);gate.limit=2
        with patch('input_quality.time.monotonic',side_effect=lambda:clock[0]):
            clock=[1000.]
            for _ in range(5):
                await gate.assess('学校',AudioWindow(pcm(),16000,-60),600);clock[0]+=2
        self.assertEqual(verify.await_count,2)

    async def test_truncated_audio_and_digital_silence_never_make_paid_requests(self):
        verify=AsyncMock()
        gate=InputQuality(verify)
        result=await gate.assess('学校',AudioWindow(pcm(),16000,-60,True),600)
        self.assertEqual(result.status,'uncertain')
        result=await gate.assess('Да',AudioWindow(b'\x00\x00'*8000,16000,-80),500)
        self.assertEqual(result.status,'noise');verify.assert_not_awaited()

    async def test_production_never_trusts_a_transcript_without_its_audio_window(self):
        verify=AsyncMock()
        result=await InputQuality(verify,require_audio=True).assess('Да, приезжайте завтра в 10.',None,500)
        self.assertEqual(result.status,'uncertain');self.assertFalse(result.text);verify.assert_not_awaited()

    async def test_http_verification_has_no_retry_or_dialogue_prompt(self):
        import httpx
        original=httpx.AsyncClient;requests=[]
        def respond(request):
            requests.append(request)
            self.assertEqual(request.url.host,'openai.api.proxyapi.ru')
            self.assertEqual(request.url.path,'/v1/audio/transcriptions')
            body=request.content
            self.assertIn(b'openai/gpt-4o-mini-transcribe',body)
            self.assertIn(b'name="language"',body)
            self.assertNotIn(b'name="prompt"',body)
            return httpx.Response(200,json={'text':'Алло','logprobs':[{'logprob':-.1}]})
        with patch.dict('os.environ',{'PROXYAPI_API_KEY':'synthetic-test-key'}),patch('input_quality.httpx.AsyncClient',side_effect=lambda **kw:original(transport=httpx.MockTransport(respond),**kw)):
            result=await InputQuality().transcribe(AudioWindow(pcm(),16000,-60))
        self.assertEqual(result['text'],'Алло');self.assertEqual(len(requests),1)
