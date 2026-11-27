import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock,Mock

from first_contact import FirstContact,contact_intent
from input_quality import AudioWindow,InputQuality
from policy import Playback


COMPANY='Первый километр'
DAMAGED='первый километр меня забусили прощаться'
GREETING='Добрый день, компания Первый километр.'
NAME='Добрый день, компания Первый километр, как я могу к вам обращаться?'


class IntentTests(unittest.TestCase):
    def test_only_a_complete_greeting_or_name_question_is_eligible(self):
        self.assertEqual(contact_intent(GREETING,[COMPANY]),'greeting')
        self.assertEqual(contact_intent(NAME,[COMPANY]),'name')
        self.assertEqual(contact_intent('Компания Первый километр, как вас зовут?',[COMPANY]),'name')
        for text in ('Компания Первый километр, машина в наличии.',
                     'Добрый день, компания Первый километр, нажмите один.',
                     'Здравствуйте, вас приветствует компания Первый километр.',
                     'Добрый день, компания Первый километр, подождите.',
                     'Добрый день, компания Первый километр, как вас зовут и какую машину ищете?',
                     'Добрый день, Первый километр. Завтра в десять подъезжайте.',
                     'Первый километр, цена 300 рублей.',
                     'Компания Первый километр, какой город вас интересует?',
                     'Первый километр, да, можно. Как вас зовут?',
                     'Первый километр, нет. Как вас зовут?',
                     DAMAGED):
            self.assertIsNone(contact_intent(text,[COMPANY]),text)


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.verify=AsyncMock(return_value={'text':NAME,'logprobs':[{'logprob':-.02}]})
        self.c=SimpleNamespace(s=SimpleNamespace(context={'targetLocation':{'name':COMPANY,'city':'Самара'}},
            prompt='',playback=Playback(),evidence=SimpleNamespace(event=Mock())),
            line=SimpleNamespace(ever_human=False,can_speak=False,state='awaiting_person'),
            monitor=SimpleNamespace(turn=SimpleNamespace(number=1)),epoch=1,
            manager_speaking=Mock(return_value=False),unavailable=Mock(return_value=False),
            llm=SimpleNamespace(input_quality=InputQuality(self.verify),send_client_event=AsyncMock(),
                reviewed_items=set(),_messages_added_manually={}))
        self.recovery=FirstContact(self.c)
        self.window=AudioWindow(b'\xb8\x0b'*32000,16000,-65)

    def capture(self,text=DAMAGED,window=None):
        self.recovery.capture(text,1,window or self.window,'original-item')

    async def test_strong_audio_restores_only_the_verified_name_request(self):
        self.capture()
        self.assertEqual(await self.recovery.recover(DAMAGED,1,1),{'intent':'name','text':NAME})
        self.verify.assert_awaited_once_with(self.window)
        sent=self.c.llm.send_client_event.call_args_list
        self.assertEqual(sent[0].args[0].item_id,'original-item')
        self.assertEqual(sent[1].args[0].item.content[0].text,NAME)
        self.assertIn(sent[1].args[0].item.id,self.c.llm.reviewed_items)
        correction=self.c.s.evidence.event.call_args
        self.assertEqual(correction.args[0],'user_transcript')
        self.assertEqual(correction.kwargs['item_id'],'original-item')
        self.assertEqual(correction.kwargs['replaces_text'],DAMAGED)
        self.assertIsNone(self.recovery.record)

    async def test_silence_weak_clipped_or_short_audio_never_reaches_the_verifier(self):
        for window in (AudioWindow(b'\x00\x00'*32000,16000,-65),
                       AudioWindow(b'\x14\x00'*32000,16000,-65),
                       AudioWindow(self.window.pcm,16000,-65,True),
                       AudioWindow(self.window.pcm[:3200],16000,-65)):
            self.capture(window=window)
            self.assertIsNone(await self.recovery.recover(DAMAGED,1,1))
        self.verify.assert_not_awaited()

    async def test_primary_number_polarity_or_recording_cannot_be_repaired_into_a_greeting(self):
        for text in ('Первый километр, нет автомобиля.', 'Первый километр завтра в десять.',
                     'Первый километр, цена 300 рублей.', 'Вас приветствует Первый километр.',
                     'Первый километр, нажмите один.', 'Первый километр, подожди.'):
            self.capture(text)
            self.assertIsNone(await self.recovery.recover(text,1,1),text)
        self.verify.assert_not_awaited()

    async def test_reviewed_business_facts_hold_or_different_company_cannot_open_the_line(self):
        for text in ('Первый километр, машина в наличии.',
                     'Первый километр, подождите, соединяю.',
                     'Здравствуйте, вас приветствует Первый километр.',
                     'Добрый день, компания Совсем другая, как вас зовут?',
                     'Первый километр, как вас зовут и когда приедете?'):
            self.recovery=FirstContact(self.c);self.c.llm.input_quality=InputQuality(self.verify)
            self.verify.return_value={'text':text,'logprobs':[{'logprob':-.02}]}
            self.capture()
            self.assertIsNone(await self.recovery.recover(DAMAGED,1,1),text)
        self.c.llm.send_client_event.assert_not_awaited()

    async def test_missing_or_low_confidence_cannot_replace_a_transcript(self):
        for scores in (None,[],[{'logprob':-1.2}],[{'logprob':float('nan')}], [{'logprob':.5}]):
            self.recovery=FirstContact(self.c);self.c.llm.input_quality=InputQuality(self.verify)
            self.verify.return_value={'text':NAME,'logprobs':scores};self.capture()
            self.assertIsNone(await self.recovery.recover(DAMAGED,1,1))
        self.c.llm.send_client_event.assert_not_awaited()

    async def test_a_new_turn_during_review_discards_the_old_result(self):
        async def later(window):
            self.c.epoch=2
            return {'text':NAME,'logprobs':[{'logprob':-.02}]}
        self.verify.side_effect=later;self.capture()
        self.assertIsNone(await self.recovery.recover(DAMAGED,1,1))
        self.c.llm.send_client_event.assert_not_awaited()

    async def test_manager_speech_or_pending_asr_prevents_a_review(self):
        self.capture();self.c.manager_speaking.return_value=True
        self.assertIsNone(await self.recovery.recover(DAMAGED,1,1))
        self.c.manager_speaking.return_value=False
        self.capture();self.c.llm.pending=['next-turn']
        self.assertIsNone(await self.recovery.recover(DAMAGED,1,1))
        self.verify.assert_not_awaited()

    async def test_recovery_has_one_attempt_and_respects_the_shared_budget(self):
        self.c.llm.input_quality.limit=0;self.capture()
        self.assertIsNone(await self.recovery.recover(DAMAGED,1,1))
        self.c.llm.input_quality.limit=8;self.capture()
        self.assertIsNone(await self.recovery.recover(DAMAGED,1,1))
        self.verify.assert_not_awaited()

    async def test_timeout_leaves_the_line_muted_and_does_not_create_a_replacement(self):
        async def stalled(window):await asyncio.sleep(1)
        self.verify.side_effect=stalled;self.c.llm.input_quality.timeout=.01;self.capture()
        self.assertIsNone(await self.recovery.recover(DAMAGED,1,1))
        self.assertFalse(self.c.line.can_speak)
        self.c.llm.send_client_event.assert_not_awaited()

    async def test_missing_company_or_an_already_live_call_is_ineligible(self):
        self.c.s.context={'targetLocation':{'name':'Самара','city':'Самара'}}
        self.capture();self.assertIsNone(self.recovery.record)
        self.c.s.context={'targetLocation':{'name':COMPANY}};self.c.line.ever_human=True
        self.capture();self.assertIsNone(self.recovery.record)
