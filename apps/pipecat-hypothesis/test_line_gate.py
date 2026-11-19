import asyncio
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock,Mock
from conversation import ConversationMemory
from policy import Evidence,Playback
from line_gate import LineGate,local_type,offered_digits,explicit_hold
from pipeline import VoxSerializer
from pipecat.frames.frames import OutputAudioRawFrame


class LocalLineTests(unittest.TestCase):
    def test_automation_precedes_greetings_and_assistant_questions(self):
        for text in ('Здравствуйте, я голосовой ассистент абонента. Что передать?',
                     'Это автоответчик. Оставьте сообщение.', 'Абонент сейчас недоступен.'):
            self.assertEqual(local_type(text),'terminal')
        self.assertEqual(local_type('Я голосовой помощник, соединю с абонентом, подождите.'),'hold')
        self.assertEqual(local_type('Здравствуйте, для отдела продаж нажмите один.'),'ivr')
        self.assertEqual(local_type('Добрый день, отдел продаж, меня зовут Анна.'),'human')
        self.assertEqual(local_type('Hello?'),'human')
        self.assertIsNone(local_type('Hello, I am a virtual assistant. Leave a message.'))

    def test_only_offered_single_digits_can_be_selected(self):
        text='Для продаж нажмите один. Для сервиса нажмите два.'
        self.assertEqual(offered_digits(text),['1','2'])
        self.assertEqual(offered_digits('Телефон 79991234567, звоните с 9 до 18.'),[])
        self.assertEqual(offered_digits('Нажмите 123, чтобы набрать добавочный.'),[])

    def test_quoted_hold_is_not_transfer(self):
        self.assertFalse(explicit_hold('Другой менеджер сказал подождите.'))
        self.assertTrue(explicit_hold('Пороги целые. Подождите, соединю с коллегой.'))


class LineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        evidence=Evidence();evidence.memory=ConversationMemory()
        self.s=SimpleNamespace(evidence=evidence,playback=Playback(),prompt='Покупатель звонит в отдел продаж.',finalized=False)
        self.c=SimpleNamespace(s=self.s,epoch=1,waiting=False,playing_id=None,
            serializer=SimpleNamespace(send=AsyncMock()),llm=SimpleNamespace(user_speaking=False),
            monitor=SimpleNamespace(segment_start=None),thinking=SimpleNamespace(cancel=Mock()),
            cancel_continuation=Mock(),stop_backchannel=AsyncMock(),clear_audio=AsyncMock(),unavailable=lambda:False)
        self.line=LineGate(self.c);self.c.line=self.line;self.s.controller=self.c
        self.line.dtmf_delay=.002
        self.line.classify=AsyncMock(return_value=('uncertain',None,False))

    async def asyncTearDown(self):
        tasks=[t for t in (self.line.wait_task,self.line.dtmf_task) if t]
        self.line.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)

    async def test_terminal_assistant_hangs_up_silently_without_dialogue(self):
        result=await self.line.route('Здравствуйте, я голосовой ассистент. Что передать?',1,1)
        self.assertEqual(result,'blocked');self.assertEqual(self.line.state,'ended')
        self.assertEqual(self.s.line_outcome,'no_answer')
        self.assertEqual(self.c.serializer.send.call_args.args[0]['action'],'hangup')
        self.line.classify.assert_not_awaited()

    async def test_connecting_assistant_waits_then_allows_employee(self):
        await self.line.route('Я голосовой помощник, подождите, соединю.',1,1)
        self.assertEqual(self.line.state,'waiting_operator')
        self.assertFalse(any(c.args[0]['action']=='hangup' for c in self.c.serializer.send.call_args_list))
        result=await self.line.route('Добрый день, отдел продаж, слушаю.',2,1)
        self.assertEqual(result,'human');self.assertTrue(self.line.can_speak)

    async def test_separate_greeting_does_not_hide_subsequent_keypad_menu(self):
        await self.line.route('Здравствуйте.',1,1)
        self.line.classify.return_value=('ivr','1',True)
        self.assertEqual(await self.line.route('Для продаж нажмите один, для сервиса нажмите два.',2,1),'blocked')
        self.assertFalse(self.line.can_speak)
        self.assertTrue(self.s.ivr_detected)

    async def test_uncertain_or_failed_classifier_never_opens_audio(self):
        self.line.classify.side_effect=TimeoutError()
        await self.line.route('Обрывок неразборчивой фразы',1,1)
        self.assertFalse(self.line.can_speak)
        self.assertFalse(any(c.args[0].get('enabled') is True for c in self.c.serializer.send.call_args_list))

    async def test_stale_terminal_classification_cannot_hang_up_new_turn(self):
        async def old(_):self.c.epoch=2;return ('terminal',None,False)
        self.line.classify.side_effect=old
        await self.line.route('Неоднозначная реплика',1,1)
        self.c.serializer.send.assert_not_awaited()

    async def test_live_line_cannot_be_downgraded_by_noise_or_robot_question(self):
        await self.line.route('Алло, слушаю.',1,1)
        for text in ('[noise]','Вы робот?','Менеджер сказал: подождите.','У вас работает голосовой помощник?'):
            self.assertEqual(await self.line.route(text,2,1),'human')
        self.assertTrue(self.line.can_speak);self.line.classify.assert_not_awaited()

    async def test_late_explicit_assistant_identification_is_silent_terminal(self):
        await self.line.route('Алло',1,1)
        self.assertEqual(await self.line.route('Я голосовой ассистент абонента, что передать?',2,1),'blocked')
        self.assertEqual(self.line.state,'ended')

    async def test_hold_preserves_memory_and_employee_resume(self):
        await self.line.route('Здравствуйте',1,1)
        self.s.evidence.memory.facts['visit_day']={'value':'завтра'}
        result=await self.line.route('Подождите, переведу вас к коллеге.',2,1)
        self.assertEqual(result,'human_hold');self.assertFalse(self.line.can_speak)
        await self.line.route('Добрый день, менеджер Ольга.',3,1)
        self.assertTrue(self.line.resumed)
        self.assertEqual(self.s.evidence.memory.facts['visit_day']['value'],'завтра')

    async def test_transfer_prerequisite_question_stays_in_live_dialogue(self):
        await self.line.route('Здравствуйте',1,1)
        self.line.classify.return_value=('human',None,False)
        text='Я вас соединю для консультации с менеджером отдела продаж. Какую марку и модель рассматриваете?'
        self.assertEqual(await self.line.route(text,2,1),'human')
        self.assertTrue(self.line.can_speak)
        self.c.clear_audio.assert_not_awaited()
        self.assertIsNone(self.line.wait_task)

    async def test_name_before_transfer_is_answered_even_if_transfer_classifier_would_wait(self):
        await self.line.route('Здравствуйте',1,1)
        self.line.classify.return_value=('hold',None,False)
        text='Я сейчас соединю вас с отделом продаж. Уточните, пожалуйста, как могу к вам обращаться?'
        self.assertEqual(await self.line.route(text,2,1),'human')
        self.assertTrue(self.line.can_speak)
        self.c.clear_audio.assert_not_awaited()
        self.line.classify.assert_not_awaited()

    async def test_repeated_name_question_restores_live_line_after_transfer_wait(self):
        await self.line.route('Здравствуйте',1,1)
        await self.line.route('Оставайтесь на линии, соединю с коллегой.',2,1)
        self.assertFalse(self.line.can_speak)
        text='Уточните, пожалуйста, как могу к вам обращаться, как вас зовут?'
        self.assertEqual(await self.line.route(text,3,1),'human')
        self.assertTrue(self.line.can_speak)
        self.assertIsNone(self.line.wait_task)

    async def test_transfer_question_does_not_override_real_hold(self):
        await self.line.route('Здравствуйте',1,1)
        self.line.classify.return_value=('hold',None,False)
        self.assertEqual(await self.line.route('Подождите, переведу вас к коллеге, хорошо?',2,1),'human_hold')
        self.assertFalse(self.line.can_speak)

    async def test_menu_digit_is_sent_once_and_path_requires_transport_confirmation(self):
        text='Для продаж нажмите один. Для сервиса нажмите два.'
        self.line.classify.return_value=('ivr','1',True)
        await self.line.route(text,1,1);await asyncio.sleep(.01)
        commands=[c.args[0] for c in self.c.serializer.send.call_args_list if c.args[0]['action']=='send_dtmf']
        self.assertEqual(len(commands),1);self.assertEqual(self.s.ivr_path,[])
        command=commands[0]
        self.line.delivered(command['commandId'],'2',True,['2'])
        self.assertEqual(self.s.ivr_path,[])
        self.line.delivered(command['commandId'],'1',True,['1'])
        self.line.delivered(command['commandId'],'1',True,['1'])
        self.assertEqual(self.s.ivr_path,['1'])

    async def test_unoffered_digit_or_incomplete_menu_is_never_sent(self):
        for digit,complete in [('9',True),('1',False)]:
            self.line.classify.return_value=('ivr',digit,complete)
            await self.line.route('Для продаж нажмите один.',1,1);await asyncio.sleep(.01)
        self.assertFalse(any(c.args[0]['action']=='send_dtmf' for c in self.c.serializer.send.call_args_list))

    async def test_new_speech_cancels_pending_digit(self):
        self.line.classify.return_value=('ivr','1',True)
        self.line.dtmf_delay=.02
        await self.line.route('Для продаж нажмите один.',1,1)
        self.c.epoch=2
        await asyncio.sleep(.03)
        self.assertFalse(any(c.args[0]['action']=='send_dtmf' for c in self.c.serializer.send.call_args_list))

    async def test_wait_timeout_hangs_up_without_farewell(self):
        self.line.wait_seconds=.005
        await self.line.route('Оставайтесь на линии.',1,1)
        await asyncio.sleep(.02)
        self.assertEqual(self.line.state,'ended');self.assertEqual(self.s.line_terminal_reason,'line_wait_timeout')

    async def test_serializer_blocks_audio_and_ignores_unknown_dtmf_ack(self):
        socket=SimpleNamespace(send_text=AsyncMock())
        serializer=VoxSerializer(self.s,socket)
        self.assertIsNone(await serializer.serialize(OutputAudioRawFrame(b'\0\0'*320,16000,1)))
        socket.send_text.assert_not_awaited()
        await serializer.deserialize(json.dumps({'customEvent':'dtmf_result','commandId':'unknown','digit':'1','ok':True,'path':['1']}))
        self.assertEqual(self.s.ivr_path,[])
