import asyncio
from array import array
import json
import os
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from conversation import ConversationMemory
from controller_audio import PreparedAudioPlayer,PreparedSpeechFrame,quiet_clip
from controller_visit import VisitProposal,affirmative,goodbye
from speech_filter import SpeechFilter
from controller_wording import spoken_question
from dialogue_controller import DialogueController,explicit_polar_answer,controller_prompt
from pipeline import Turn,VoxSerializer,GatedRealtime,OutputEvidence
from policy import Evidence,Playback
from pipecat.frames.frames import BotBackchannelFrame,OutputAudioRawFrame,TTSStartedFrame,TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection

PROMPT="1. Пробег актуальный? [обязательная тема]\n2. Пороги целые? [обязательная тема]"


class ControllerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.voice_patch=patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=array('h',[2000]*1600).tobytes()))
        self.voice_patch.start();self.addCleanup(self.voice_patch.stop)
        self.s=SimpleNamespace(prompt=PROMPT,context={},backchannel=True,tts_model="eleven_v4_turbo",voice_id="test",
            evidence=Evidence(),playback=Playback(),finalized=False,status="connected")
        self.s.prepared_purpose='purchase'
        self.s.evidence.memory=ConversationMemory(PROMPT);self.s.evidence.turn=self.s.evidence.output_turn=1
        self.monitor=SimpleNamespace(turn=Turn(False,number=1),segment_start=None)
        self.serializer=SimpleNamespace(queue_cleared_event=asyncio.Event())
        c=self.c=DialogueController(self.s,self.serializer,self.monitor);self.s.controller=c
        c.llm=SimpleNamespace(response_id=None,response_items={},spoken_text={},wire_active=None,wire_pending=None,request_turns=[],_messages_added_manually={},send_client_event=AsyncMock(),broadcast_frame=AsyncMock())
        c.player=SimpleNamespace(queue_frame=AsyncMock())
        wording={r['key']:spoken_question(r['question']) for r in self.s.evidence.memory.topics.required}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=array('h',[2000]*1600).tobytes())):
            await c.prepare()
        c.choose=AsyncMock(return_value="answer")

    async def asyncTearDown(self):await self.c.close()

    async def test_service_uses_its_first_question_and_service_visit_without_sales_templates(self):
        self.s.prompt=('1. Хочу поставить металлическую защиту на задний двигатель у Zeekr 8X. Сможете сделать? [обязательная тема]\n'
            '2. Что по стоимости? [обязательная тема]\n3. Лист защиты не нарушит охлаждение заднего электромотора? [обязательная тема]')
        self.s.context={'subjectTitle':'Zeekr 8X','customerNeed':'Пробег 67 км, ранее не обслуживался.'}
        self.s.prepared_purpose='service'
        self.s.evidence.memory=ConversationMemory(self.s.prompt)
        rows=self.s.evidence.memory.topics.required
        wording={row['key']:row['question'] for row in rows}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)):
            await self.c.prepare()
        self.assertIn('металлическую защиту',self.c.texts['opening'])
        self.assertIn('обслуживание',self.c.texts['visit'])
        self.assertIn('обслуживанию',self.c.texts['subject'])
        for key in ('opening','opening_body','opening_followup','visit','subject'):
            if key in self.c.texts:
                for forbidden in ('продаётся','продается','посмотреть машину','из объявления'):
                    self.assertNotIn(forbidden,self.c.texts[key])
        await self.c.speak('opening')
        self.assertEqual(self.c.last_question['topic'],rows[0]['key'])
        self.assertEqual(self.c.asked[rows[0]['key']],1)
        await self.c.next_question()
        self.assertEqual(self.c.last_question['topic'],rows[1]['key'])

    async def test_service_request_without_question_mark_prepares_and_keeps_its_topic(self):
        self.s.prompt=('1. Нужна диагностика электропроводки. [обязательная тема]\n'
            '2. Сколько стоит такая работа? [обязательная тема]')
        self.s.context={};self.s.prepared_purpose='service';self.s.dialogue_mode='semantic'
        self.s.evidence.memory=ConversationMemory(self.s.prompt)
        rows=self.s.evidence.memory.topics.required
        wording={row['key']:row['question'] for row in rows}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)):
            await self.c.prepare()
        self.assertIn('диагностика электропроводки',self.c.texts['opening'])
        self.assertEqual(self.c.texts['opening_followup'],'Можете помочь с этим вопросом?')
        self.assertNotIn('продаётся',self.c.texts['opening'])
        self.assertTrue(self.c.clips['named_opening'])
        await self.c.speak('opening')
        self.assertTrue(self.c.opening_sent)
        self.assertEqual(self.c.last_question['topic'],rows[0]['key'])
        await self.c.next_question()
        self.assertEqual(self.c.last_question['topic'],rows[1]['key'])

    async def test_unknown_purpose_fallback_does_not_invent_a_car_purchase(self):
        self.s.prepared_purpose='other';self.s.context={'subjectTitle':'Zeekr 8X'}
        wording={r['key']:r['question'] for r in self.s.evidence.memory.topics.required}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)):
            await self.c.prepare()
        self.assertNotIn('продаётся',self.c.texts['opening'])
        self.assertNotIn('посмотреть машину',self.c.texts['visit'])
        self.assertEqual(self.c.opening_topic,self.s.evidence.memory.topics.required[0]['key'])

    async def test_optional_plan_text_does_not_break_audio_preparation(self):
        wording={r['key']:spoken_question(r['question']) for r in self.s.evidence.memory.topics.required}
        for context in ({},{'subjectTitle':None,'subjectDescription':None},
                        {'subjectTitle':'   ','subjectDescription':''},
                        {'subjectTitle':42,'subjectDescription':{}}):
            with self.subTest(context=context):
                self.s.context=context
                with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)):
                    await self.c.prepare()
                self.assertEqual(self.c.texts['opening'],'Здравствуйте! Звоню по объявлению, машина ещё продаётся?')
                self.assertTrue(self.c.clips['opening'])
                prompt=controller_prompt(self.s)
                self.assertIn('Объект: выбранный автомобиль.',prompt)
                self.assertNotIn('None',prompt)

    async def test_supplied_subject_is_preserved_in_prepared_opening(self):
        self.s.context={'subjectTitle':'  Toyota Camry (седан) VII  ','subjectDescription':'Описание'}
        self.s.prepared_spoken_subject='Toyota Camry'
        wording={r['key']:spoken_question(r['question']) for r in self.s.evidence.memory.topics.required}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)):
            await self.c.prepare()
        self.assertEqual(self.c.texts['opening'],'Здравствуйте! Меня интересует Toyota Camry. Машина ещё продаётся?')
        self.assertIn('Описание: Описание',controller_prompt(self.s))

    async def test_feed_modification_stays_out_of_all_cached_subject_clips(self):
        full='BMW 5-series 520i 2.0 AT Luxury 2024'
        self.s.context={'subjectTitle':full,'subjectDescription':'Бензин, автомат'}
        self.s.prepared_subject=full;self.s.prepared_spoken_subject='BMW 5-series'
        wording={r['key']:spoken_question(r['question']) for r in self.s.evidence.memory.topics.required}
        wording['availability']=full+' ещё в продаже?'
        wording[self.s.evidence.memory.topics.required[0]['key']]=full+' ещё в продаже?'
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)):
            await self.c.prepare()
        for key in ('opening','subject','availability','named_opening','name_then_first'):
            with self.subTest(key=key):
                self.assertIn('BMW 5-series',self.c.texts[key])
                for detail in ('520i','2.0','AT','Luxury','2024'):
                    self.assertNotIn(detail,self.c.texts[key])
        self.assertIn(full,controller_prompt(self.s))
        self.assertEqual(self.s.context['subjectTitle'],full)

    async def test_colloquial_opening_uses_nominative_without_wrong_case_after_po(self):
        self.s.context={'subjectTitle':'BMW 5-series 520i'}
        self.s.prepared_subject='BMW 5-series 520i'
        self.s.prepared_subject_model='BMW 5-series';self.s.prepared_spoken_subject='бэха-пятёрка'
        wording={r['key']:spoken_question(r['question']) for r in self.s.evidence.memory.topics.required}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)):
            await self.c.prepare()
        self.assertEqual(self.c.texts['opening'],'Здравствуйте! Меня интересует бэха-пятёрка. Машина ещё продаётся?')
        self.assertEqual(self.c.texts['subject'],'Меня интересует бэха-пятёрка из объявления.')
        self.assertNotIn('520i',self.c.texts['opening'])

    async def test_opening_identifies_selected_car_by_colour_and_short_engine(self):
        full='BMW 5-series 520i Luxury'
        self.s.context={'subjectTitle':full,'subjectDescription':'Чёрный, 2.0 л, бензин'}
        self.s.prepared_subject=full;self.s.prepared_subject_model='BMW 5-series'
        self.s.prepared_spoken_subject='чёрная бэха-пятёрка, двухлитровая бензиновая'
        wording={r['key']:spoken_question(r['question']) for r in self.s.evidence.memory.topics.required}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)):
            await self.c.prepare()
        self.assertEqual(self.c.texts['opening'],'Здравствуйте! Меня интересует чёрная бэха-пятёрка, двухлитровая бензиновая. Машина ещё продаётся?')
        self.assertNotIn('520i',self.c.texts['opening']);self.assertNotIn('Luxury',self.c.texts['opening'])
        self.assertEqual(self.s.context['subjectTitle'],full)

    def test_customer_name_request_variants_and_other_people(self):
        from dialogue_topics import requests_customer_name
        for text in ('Подскажите, к кому могу обращаться?', 'Как к вам обращаться?',
                     'Как я могу к вам обращаться?', 'Как к тебе можно обращаться?',
                     'Как могу обращаться?', 'С кем я разговариваю?', 'С кем говорю?',
                     'Назовите, пожалуйста, ваше имя.', 'Ваше имя?', 'Представьтесь, пожалуйста.'):
            with self.subTest(text=text):self.assertTrue(requests_customer_name(text))
        for text in ('Здравствуйте, Андрей.', 'Меня зовут Алексей.',
                     'К кому мне обратиться по гарантии?', 'Как обращаться с этой машиной?',
                     'Как зовут вашего менеджера?', 'Как связаться с владельцем?',
                     'К кому можно обратиться в салоне?'):
            with self.subTest(text=text):self.assertFalse(requests_customer_name(text))

    async def test_name_after_availability_uses_known_name_and_first_question_without_llm(self):
        self.c.started=True;self.c.current='availability'
        text='Да, добрый день, машина продаётся. Подскажите, к кому могу обращаться?'
        self.user(text)
        await self.c.handle(text,1,self.c.epoch)
        reply=self.c.player.queue_frame.call_args.args[0].text
        self.assertTrue(reply.startswith('Меня зовут Андрей.'))
        self.assertIn(self.c.texts['mileage'],reply)
        self.c.choose.assert_not_awaited()
        self.assertEqual(self.c.asked['mileage'],1)

    def test_mutual_meeting_commitments_accept_active_slot_without_repeating_time(self):
        from controller_visit import confirms_slot
        offer={'day':{'value':'завтра'},'time':{'value':'в три часа дня'}}
        for text in ('Да, да, да, отлично, давайте, да, тогда встретимся.',
                     'Хорошо, тогда увидимся.', 'Тогда встретимся.',
                     'Давайте встретимся завтра.', 'Да, завтра можно будет встретиться. Давайте так.',
                     'Значит, встречаемся завтра в 15:00.'):
            with self.subTest(text=text):
                self.assertTrue(confirms_slot(offer,text))
                self.assertFalse(confirms_slot(None,text))
        for text in ('Да, тогда встретимся послезавтра.', 'Тогда увидимся в четыре.',
                     'Да, тогда встретимся, если получится.', 'Да, тогда встретимся, но сначала проверю.',
                     'Да, наверное тогда встретимся.', 'Думаю, тогда встретимся.',
                     'Да, вы сказали тогда встретимся.', 'Да, когда встретимся.',
                     'Тогда встретимся?', 'Тогда встретимся или созвонимся.'):
            with self.subTest(text=text):self.assertFalse(confirms_slot(offer,text))

    async def test_meeting_acceptance_saves_once_and_goes_directly_to_farewell(self):
        c=self.c;c.started=True;c.current='visit'
        c.answers={row['key']:{} for row in self.s.evidence.memory.topics.required}
        c.visit.update('Завтра во второй половине дня. Будет удобно?',1)
        await c.ask_visit(c.visit.proposal())
        c.player.queue_frame.reset_mock()
        text='Да, да, да, отлично, давайте, да, тогда встретимся.'
        self.user(text,2);await c.handle(text,2,c.epoch)
        self.assertTrue(c.visit_confirmed)
        self.assertEqual(c.player.queue_frame.await_count,1)
        self.assertEqual(c.player.queue_frame.call_args.args[0].text,c.texts['visit_farewell'])
        self.assertEqual(self.s.evidence.memory.facts['visit_time']['confirmation_evidence'],text)
        self.assertEqual(self.s.evidence.memory.facts['visit_time']['value'],'в три часа дня')
        c.choose.assert_not_awaited()

    async def test_meeting_commitment_after_unrelated_question_retains_active_offer(self):
        c=self.c;c.started=True;c.current='visit'
        c.answers={row['key']:{} for row in self.s.evidence.memory.topics.required}
        c.visit.update('Завтра после обеда.',1)
        await c.ask_visit(c.visit.proposal())
        await c.speak('name')
        text='Хорошо, тогда увидимся.'
        self.user(text,2);await c.handle(text,2,c.epoch)
        self.assertTrue(c.visit_confirmed)
        self.assertEqual(self.s.evidence.memory.closing_reason,'visit_agreed')

    async def test_confirmed_visit_closes_after_asked_but_unanswered_question(self):
        c=self.c;c.started=True
        for row in self.s.evidence.memory.topics.required:await c.speak(row['key'])
        c.answers['mileage']={'evidence':'Пробег актуальный.'}
        c.visit.update('Завтра после обеда.',1)
        await c.ask_visit(c.visit.proposal())
        self.user('Да, завтра в три, хорошо.',2)
        await c.handle('Да, завтра в три, хорошо.',2,c.epoch)
        self.assertEqual(self.s.evidence.memory.closing_reason,'visit_agreed')
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(c.player.queue_frame.call_args.args[0].text,c.texts['visit_farewell'])
        self.assertNotIn('rust',c.answers)
        self.assertEqual(c.snapshot()['asked_without_answer'][0]['key'],'rust')
        self.assertEqual(c.asked['rust'],1)
        self.assertFalse(any(e['event']=='controller_question_blocked' for e in self.s.evidence.events))

    async def test_early_confirmed_visit_still_asks_never_asked_topic(self):
        c=self.c
        await c.speak('mileage')
        self.s.evidence.memory.facts={'visit_day':{'value':'завтра'},'visit_time':{'value':'в три'}}
        await c.accept_visit(saved=True)
        self.assertEqual(c.current,'rust')
        self.assertIn(c.texts['rust'],c.player.queue_frame.call_args.args[0].text)
        self.assertFalse(self.s.playback.finish_requested)
        self.assertEqual(c.asked['mileage'],1)
        self.assertEqual(c.asked['rust'],1)
        self.assertNotIn('mileage',c.answers)

    async def test_next_question_skips_used_question_without_faking_answer(self):
        await self.c.speak('mileage')
        await self.c.next_question()
        self.assertEqual(self.c.current,'rust')
        self.assertEqual(self.c.asked['mileage'],1)
        self.assertNotIn('mileage',self.c.answers)

    async def test_visit_close_guard_keeps_never_asked_topic_mandatory(self):
        await self.c.speak('mileage')
        self.s.evidence.memory.facts={'visit_day':{'value':'завтра'},'visit_time':{'value':'в три'}}
        self.assertFalse(await self.c.close_confirmed_visit())
        self.assertFalse(self.s.playback.finish_requested)
        self.assertNotEqual(self.s.evidence.memory.phase,'closing')

    async def test_all_asked_without_confirmed_visit_does_not_hang_up(self):
        for row in self.s.evidence.memory.topics.required:await self.c.speak(row['key'])
        await self.c.next_question()
        self.assertEqual(self.c.current,'visit')
        self.assertFalse(self.s.playback.finish_requested)
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_early_visit_then_unanswered_last_question_can_close_on_reply(self):
        c=self.c;c.started=True
        await c.speak('mileage')
        self.s.evidence.memory.facts={'visit_day':{'value':'завтра'},'visit_time':{'value':'в три'}}
        await c.accept_visit(saved=True)
        c.choose=AsyncMock(return_value='clarify')
        self.user('Будем вас ждать.',2)
        await c.handle('Будем вас ждать.',2,c.epoch)
        self.assertEqual(self.s.evidence.memory.closing_reason,'visit_agreed')
        self.assertTrue(self.s.playback.finish_requested)
        self.assertNotIn('rust',c.answers)

    async def test_confirmed_visit_does_not_override_request_to_wait(self):
        c=self.c;c.started=True
        for row in self.s.evidence.memory.topics.required:await c.speak(row['key'])
        c.visit_confirmed=True
        self.s.evidence.memory.facts={'visit_day':{'value':'завтра'},'visit_time':{'value':'в три'}}
        self.user('Подождите, пожалуйста.',2)
        await c.handle('Подождите, пожалуйста.',2,c.epoch)
        self.assertTrue(c.waiting)
        self.assertFalse(self.s.playback.finish_requested)

    async def test_thinking_fast_voice_never_emits_filler(self):
        self.c.thinking.delay_ms=40
        await self.c.speak(text='Для личных поездок.')
        await asyncio.sleep(.05)
        self.assertFalse(any(e['event']=='thinking_pause_emitted' for e in self.s.evidence.events))
        self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_whole_turn_timer_keeps_deadline_through_stt_meaning_and_tts(self):
        c=self.c;c.thinking.delay_ms=30
        self.s.evidence.turn_marks[(1,'speech_end')]=time.monotonic()-.02
        job=c.thinking.arm('turn_wait')
        started=job['started']
        self.assertIs(c.thinking.arm('semantic_interpretation'),job)
        await asyncio.sleep(.02)
        self.assertTrue(job['emitted']);self.assertEqual(job['started'],started)
        self.assertIs(c.thinking.arm('visit_tts'),job)
        await asyncio.sleep(.02)
        self.assertEqual(c.player.queue_frame.await_count,1)

    async def test_waiting_clip_survives_until_dynamic_audio_is_ready(self):
        c=self.c;c.thinking.delay_ms=5
        job=c.thinking.arm('turn_wait');await asyncio.sleep(.015)
        self.assertTrue(job['emitted'])
        stopped=AsyncMock(wraps=c.stop_backchannel)
        async def slow(*args):
            stopped.assert_not_awaited()
            await asyncio.sleep(.015)
            return b'\x01\x00'*1600
        with patch.object(c,'stop_backchannel',new=stopped),patch('dialogue_controller.voice_clip',new=slow):
            await c.speak(text='Новая реплика.')
        self.assertGreaterEqual(stopped.await_count,1)
        self.assertIsNone(c.thinking.current)

    async def test_thinking_slow_visit_uses_prepared_contextual_clip_without_question(self):
        self.c.thinking.delay_ms=10
        async def slow(*args):
            await asyncio.sleep(.04)
            return b'\x01\x00'*1600
        with patch('dialogue_controller.voice_clip',new=slow):
            await self.c.speak(text='Могу подъехать завтра в десять. Подойдёт?',question_key='visit-slot:завтра:10:00')
        frames=[call.args[0] for call in self.c.player.queue_frame.call_args_list]
        self.assertEqual(len(frames),2)
        self.assertIsInstance(frames[0],BotBackchannelFrame)
        self.assertIn(frames[0].text,['Дайте подумать…','Сейчас прикину…'])
        self.assertIsInstance(frames[1],PreparedSpeechFrame)
        self.assertEqual(self.c.llm.send_client_event.await_count,1)
        self.assertEqual(len(self.c.question_ledger),2)

    async def test_thinking_native_waits_for_pcm_not_generation_done(self):
        c=self.c;c.thinking.delay_ms=10
        e=self.s.evidence;e.current_response_id='native';e.last_assistant_id='previous'
        e.messages['native']={'turn':1}
        self.s.playback.generated=True;self.s.playback.synthesizing=True
        c.llm.spoken_text['native']='Для личных поездок.'
        c.thinking.arm('native_reply')
        await c.fallback_done('native')
        self.assertIsNotNone(c.thinking.current)
        await asyncio.sleep(.025)
        self.assertIsInstance(c.player.queue_frame.call_args.args[0],BotBackchannelFrame)
        self.assertEqual(e.current_response_id,'native')
        self.assertEqual(e.last_assistant_id,'previous')
        self.assertTrue(self.s.playback.generated)
        c.output_transport=SimpleNamespace(queue_frame=AsyncMock(side_effect=lambda f:self.serializer.queue_cleared_event.set()))
        await c.thinking.main_audio_ready('native')
        self.assertIsNone(c.thinking.current)
        self.assertIsNone(c.playing_id)
        c.llm.broadcast_frame.assert_not_awaited()

    async def test_thinking_new_speech_cancels_pending_timer(self):
        self.c.thinking.delay_ms=20
        self.c.thinking.arm('native_reply')
        await self.c.new_input();await asyncio.sleep(.03)
        self.c.player.queue_frame.assert_not_awaited()
        self.assertIsNone(self.c.thinking.current)

    async def test_thinking_stale_pcm_does_not_stop_current_turn(self):
        self.c.thinking.delay_ms=50
        self.s.evidence.messages['old']={'turn':0}
        job=self.c.thinking.arm('native_reply')
        await self.c.thinking.main_audio_ready('old')
        self.assertIs(self.c.thinking.current,job)

    async def test_thinking_explicit_wait_and_closing_are_silent(self):
        self.c.thinking.delay_ms=1
        for waiting,phase in [(True,'active'),(False,'closing')]:
            self.c.waiting=waiting;self.s.evidence.memory.phase=phase
            self.c.thinking.arm('native_reply');await asyncio.sleep(.01)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_thinking_disabled_and_zero_threshold(self):
        self.s.backchannel=False
        self.assertIsNone(self.c.thinking.arm('native_reply'))
        self.s.backchannel=True;self.c.thinking.delay_ms=0
        self.assertIsNone(self.c.thinking.arm('native_reply'))

    async def test_thinking_rate_limit_and_variation(self):
        c=self.c;c.thinking.delay_ms=1
        for turn in (1,1,2,3):
            self.s.evidence.turn=turn
            if turn==3:c.last_bc=-1000
            c.thinking.arm('visit_tts');await asyncio.sleep(.01)
        frames=[call.args[0] for call in c.player.queue_frame.call_args_list]
        self.assertEqual(len(frames),2)
        self.assertNotEqual(frames[0].text,frames[1].text)
        self.assertIsNone(c.last_question)
        self.assertFalse(c.asked)

    async def test_waiting_voice_cannot_acknowledge_unparsed_input_and_respects_longer_cooldown(self):
        c=self.c;c.thinking.delay_ms=1;c.thinking.cooldown=25
        for turn,stage,seconds_since_last in ((1,'turn_wait',1000),(2,'semantic_interpretation',12),
                                               (3,'native_reply',26)):
            self.s.evidence.turn=turn;c.last_bc=time.monotonic()-seconds_since_last
            c.thinking.arm(stage);await asyncio.sleep(.01)
        frames=[call.args[0] for call in c.player.queue_frame.call_args_list]
        self.assertEqual([f.text for f in frames],['Секунду…','Секунду…'])
        skipped=[e for e in self.s.evidence.events if e['event']=='thinking_pause_skipped']
        self.assertEqual(skipped[-1]['reason'],'rate_limit')

    async def test_thinking_does_not_overlap_phone_audio_or_user_speech(self):
        self.c.thinking.delay_ms=1
        self.monitor.segment_start=time.monotonic()
        self.c.thinking.arm('native_reply');await asyncio.sleep(.01)
        self.monitor.segment_start=None
        self.s.playback.pending.add('phone-audio')
        self.c.thinking.arm('native_reply');await asyncio.sleep(.01)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_thinking_main_output_flush_preserves_native_context(self):
        self.c.thinking.delay_ms=1
        self.c.thinking.arm('native_reply');await asyncio.sleep(.01)
        native=self.s.evidence.delivery.response('native')
        native.update(generated_done=True,kind='native')
        self.s.evidence.messages['native']={'turn':1}
        self.c.output_transport=SimpleNamespace(queue_frame=AsyncMock(side_effect=lambda f:self.serializer.queue_cleared_event.set()))
        await self.c.thinking.main_audio_ready('native')
        frame=self.c.output_transport.queue_frame.call_args.args[0]
        self.assertTrue(frame.metadata['backchannel_only'].startswith('backchannel-'))
        self.assertFalse(native.get('interrupted'))
        self.c.llm.broadcast_frame.assert_not_awaited()

    async def semantic_answer(self,text,action='advance',reply_needed=False,coverage_score=.78,coverage_choice='answered'):
        from unittest.mock import Mock
        self.c.choose=DialogueController.choose.__get__(self.c)
        response=Mock();response.json.return_value={'answers':{
            'action':{'choice':action,'probabilities':{action:.97}},
            'coverage':{'choice':coverage_choice,'probabilities':{'answered':coverage_score,'unanswered':1-coverage_score}},
            'reply_needed':{'choice':'yes' if reply_needed else 'no','probabilities':{'yes':.98 if reply_needed else .02}}}}
        self.c.http.post=AsyncMock(return_value=response)
        self.user(text)
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):
            await self.c.handle(text,self.s.evidence.turn,self.c.epoch)

    async def test_first_name_request_keeps_opening_and_listing(self):
        self.user('Здравствуйте. Как к вам обращаться?')
        await self.c.handle('Здравствуйте. Как к вам обращаться?',1,0)
        text=self.c.player.queue_frame.call_args.args[0].text
        self.assertIn('Меня зовут',text);self.assertIn('Здравствуйте',text)
        self.assertIn('продаётся?',text);self.assertTrue(self.c.opening_sent)

    async def test_cannot_hear_replays_audio_without_business_state_or_llm(self):
        await self.c.speak('mileage')
        previous=self.c.player.queue_frame.call_args.args[0]
        count=dict(self.c.asked)
        self.user('Вас не слышно.')
        await self.c.handle('Вас не слышно.',1,0)
        replay=self.c.player.queue_frame.call_args.args[0]
        self.assertEqual(replay.text,'Я на связи.')
        self.assertNotEqual(replay.text,previous.text)
        self.assertEqual(self.c.asked,count);self.c.choose.assert_not_awaited()
        self.assertFalse(self.c.answers);self.assertFalse(self.s.evidence.memory.facts)

    async def test_acknowledgement_does_not_repeat_or_close_question(self):
        self.c.started=True
        await self.c.speak('mileage');self.c.player.queue_frame.reset_mock()
        self.user('Хорошо.')
        await self.c.handle('Хорошо.',1,0)
        self.c.player.queue_frame.assert_not_awaited();self.c.choose.assert_not_awaited()
        self.assertNotIn('mileage',self.c.answers)

    async def test_answer_saved_even_with_counterquestion_on_unrelated_plan(self):
        self.c.started=True;self.c.current='custom:0'
        self.c.last_question={'text':'Возможна доставка в выходные?','topic':'custom:0','kind':'plan'}
        await self.semantic_answer('Да, но только после обеда. Какой район вам нужен?',action='answer')
        self.assertIn('custom:0',self.c.answers)
        self.assertIn('после обеда',self.c.answers['custom:0']['evidence'])
        self.assertEqual(self.c.llm.request_reason,'controller_fallback')
        body=self.c.http.post.call_args.kwargs['json']
        self.assertIn('coverage',body['questions'])

    async def test_counterquestion_overrides_clarify_without_losing_covered_answer(self):
        self.c.started=True;self.c.current='custom:0'
        self.c.last_question={'text':'Работаете в выходные?','topic':'custom:0','kind':'plan'}
        await self.semantic_answer('Да, до обеда. В какое время вам удобно?',action='clarify',reply_needed=True)
        self.assertIn('custom:0',self.c.answers)
        self.assertEqual(self.c.llm.request_reason,'controller_fallback')
        self.assertFalse(self.c.fallback_allow_question)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_descriptive_answer_to_paraphrased_question_keeps_plan_reference(self):
        self.c.started=True;self.c.current='mileage'
        self.c.last_question={'text':'Километры в объявлении верные?','topic':None,'kind':'followup'}
        await self.semantic_answer('Да, указаны настоящие 45000 километров.')
        self.assertIn('mileage',self.c.answers)
        self.assertEqual(self.c.current,'rust')
        body=self.c.http.post.call_args.kwargs['json']
        self.assertEqual(body['state']['planned_question'],'Пробег актуальный?')

    async def test_late_fragments_are_assembled_in_speech_order_without_early_reply(self):
        self.c.handle=AsyncMock()
        llm=GatedRealtime(self.s,self.monitor,api_key='test')
        question={'text':'Условия доставки?','topic':'custom:0','kind':'plan'}
        self.monitor.turn=Turn(False,number=2,question=question)
        llm.items={'a':(Turn(False,number=1,question=question),True),
                   'b':(self.monitor.turn,True)}
        llm.user_speaking=True
        with patch.object(GatedRealtime.__bases__[0],'handle_evt_input_audio_transcription_completed',new=AsyncMock()):
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='b',transcript='Но только после оплаты.'))
            self.c.handle.assert_not_awaited()
            llm.user_speaking=False
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='a',transcript='Доставка возможна.'))
            await self.c.task
        self.assertEqual(self.c.handle.call_args.args[0],'Доставка возможна. Но только после оплаты.')
        self.assertEqual(self.c.handle.call_args.args[1],2)
        self.assertFalse(self.c.inputs.snapshot())
        self.assertFalse(any(e['event']=='late_transcript_no_response' for e in self.s.evidence.events))

    async def test_cancelled_handling_retains_fragments_for_next_commit(self):
        async def blocked(*_):await asyncio.sleep(10)
        self.c.handle=AsyncMock(side_effect=blocked)
        self.c.inputs.add('Условия действуют.',1)
        self.c.receive_batch(self.c.inputs.snapshot());await asyncio.sleep(0)
        await self.c.new_input();await self.c.task
        self.assertEqual(len(self.c.inputs.snapshot()),1)
        self.c.inputs.add('Только при предоплате.',2)
        self.c.handle=AsyncMock()
        self.c.receive_batch(self.c.inputs.snapshot());await self.c.task
        self.assertEqual(self.c.handle.call_args.args[0],'Условия действуют. Только при предоплате.')
        self.assertFalse(self.c.inputs.snapshot())

    def user(self,text,turn=1):
        self.s.evidence.turn=self.s.evidence.output_turn=turn
        self.s.evidence.memory.user(text,turn)

    async def test_hard_guard_blocks_reworded_same_plan_id_without_closing_topic(self):
        await self.c.speak('mileage')
        self.c.player.queue_frame.reset_mock()
        identifier=await self.c.speak(text='А километры действительно верные?',question_key='mileage')
        self.assertIsNone(identifier);self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.c.asked['mileage'],1)
        self.assertNotIn('mileage',self.c.answers)
        self.assertIn('mileage',[r['key'] for r in self.c.pending()])
        self.assertIn('plan:mileage',self.c.question_ledger)

    async def test_blocked_question_in_compound_response_preserves_requested_name_answer(self):
        await self.c.speak('mileage');self.c.player.queue_frame.reset_mock()
        await self.c.speak_parts(['name','mileage'])
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['name'])
        self.assertEqual(self.c.asked['mileage'],1)

    async def test_visit_field_question_cannot_bypass_guard_with_another_cached_wording(self):
        await self.c.speak('clarify_day');self.c.player.queue_frame.reset_mock()
        self.assertIsNone(await self.c.speak('clarify_day_short'))
        self.c.player.queue_frame.assert_not_awaited()
        self.assertIn('visit-field:day',self.c.question_ledger)

    async def test_hard_guard_reserves_question_before_concurrent_synthesis(self):
        entered=asyncio.Event();release=asyncio.Event()
        async def delayed(*_):entered.set();await release.wait();return b'\0\0'*1600
        with patch('dialogue_controller.voice_clip',new=delayed):
            first=asyncio.create_task(self.c.speak(text='А километры настоящие?',question_key='mileage'))
            await entered.wait()
            second=await self.c.speak('mileage')
            self.assertIsNone(second);release.set();await first
        self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_cancel_before_audio_queue_releases_reservation(self):
        entered=asyncio.Event()
        async def delayed(*_):entered.set();await asyncio.sleep(20)
        self.c.llm.send_client_event=AsyncMock(side_effect=delayed)
        self.c.task=asyncio.create_task(self.c.speak('mileage'))
        await entered.wait();await self.c.new_input()
        await asyncio.gather(self.c.task,return_exceptions=True)
        self.assertFalse(self.c.question_reservations);self.assertFalse(self.c.question_ledger)
        self.c.llm.send_client_event=AsyncMock()
        self.assertIsNotNone(await self.c.speak('mileage'))
        self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_cancel_during_enqueue_keeps_conservative_duplicate_lock(self):
        entered=asyncio.Event()
        async def accepted_then_delayed(*_):entered.set();await asyncio.sleep(20)
        self.c.player.queue_frame=AsyncMock(side_effect=accepted_then_delayed)
        self.c.task=asyncio.create_task(self.c.speak('mileage'))
        await entered.wait();await self.c.new_input()
        await asyncio.gather(self.c.task,return_exceptions=True)
        self.assertIsNone(await self.c.speak('mileage'))
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.question_ledger['plan:mileage']['state'],'enqueuing')

    async def test_native_service_cannot_ask_even_with_old_permission_flag(self):
        self.c.fallback_allow_question=True
        for question in ['Сколько времени вы пользовались вещью?','А возможность уступить по цене есть?',
                         'Сколько времени пользовались вещью.', 'Скажите, можно сделать доставку.']:
            with self.subTest(question=question):
                guard=SpeechFilter(controller=self.c)
                self.assertEqual(guard.feed('Для себя. '+question,final=True),'Для себя.')
                self.assertTrue(guard.removed)

    async def test_filtered_native_question_cannot_trigger_same_cached_question(self):
        await self.c.speak('mileage');self.c.player.queue_frame.reset_mock()
        guard=SpeechFilter(controller=self.c);guard.feed('А километры настоящие?',final=True)
        self.c.llm.speech_filters={'native':guard}
        await self.c.fallback_done('native')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['rust'])
        self.assertEqual(self.c.current,'rust');self.assertNotIn('mileage',self.c.answers)
        self.assertEqual(self.c.asked['mileage'],1)

    async def test_discourse_prefixes_with_name_do_not_generate_or_reask(self):
        self.c.started=True;await self.c.speak('mileage')
        self.c.player.queue_frame.reset_mock()
        for index,text in enumerate(['Тогда','Так, Андрей.','Ну, хорошо.'],1):
            self.user(text,index);await self.c.handle(text,index,0)
        self.c.choose.assert_not_awaited();self.c.player.queue_frame.assert_not_awaited()
        self.assertNotIn('mileage',self.c.answers)

    async def test_uncertain_answer_does_not_become_fake_coverage_after_two_turns(self):
        self.c.started=True;await self.c.speak('mileage');self.c.choose.return_value='clarify'
        self.c.player.queue_frame.reset_mock()
        for turn,text in [(1,'Неразборчивый ответ.'),(2,'Ещё неразборчивый ответ.')]:
            self.user(text,turn);await self.c.handle(text,turn,0)
        self.assertNotIn('mileage',self.c.answers)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['repeat'])
        self.assertEqual(self.c.asked['mileage'],1)

    async def test_alternative_windows_create_client_choice_then_booking_ack_closes(self):
        self.c.started=True;self.c.current='visit'
        self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        await self.c.speak('visit');self.c.player.queue_frame.reset_mock()
        text='Можно завтра во второй половине дня или послезавтра в первой половине дня.'
        self.user(text,1);await self.c.handle(text,1,0)
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIn('завтра',frame.text);self.assertIn('в три часа дня',frame.text)
        self.assertFalse(self.s.evidence.memory.facts);self.assertIsNotNone(self.c.visit.offered)
        self.assertEqual(self.c.visit.offered['time']['source'],'client_choice_from_manager_options')
        text='Я вас запишу на завтра, будем вас ждать.'
        self.user(text,2);await self.c.handle(text,2,0)
        self.assertEqual(self.s.evidence.memory.closing_reason,'visit_agreed')
        self.assertEqual(self.s.evidence.memory.facts['visit_time']['value'],'в три часа дня')
        self.assertEqual(self.s.evidence.memory.facts['visit_time']['confirmation_evidence'],text)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_farewell'])
        self.assertTrue(self.s.playback.finish_requested);self.assertFalse(self.s.playback.can_hangup)

    async def test_short_good_ack_confirms_active_offer_before_discourse_filter(self):
        self.c.started=True;self.c.current='visit';self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.c.visit.update('Завтра после обеда.',1)
        await self.c.ask_visit(self.c.visit.proposal())
        self.user('Хорошо.',2);await self.c.handle('Хорошо.',2,0)
        self.assertTrue(self.c.visit_confirmed);self.assertEqual(self.s.evidence.memory.closing_reason,'visit_agreed')

    async def test_acknowledgement_of_an_unrelated_reply_does_not_confirm_visit(self):
        self.c.started=True;self.c.current='visit';self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.c.visit.update('Завтра после обеда.',1)
        await self.c.ask_visit(self.c.visit.proposal())
        await self.c.speak('name')
        self.user('Хорошо.',2);await self.c.handle('Хорошо.',2,0)
        self.assertFalse(self.c.visit_confirmed);self.assertFalse(self.s.evidence.memory.facts)
        self.user('Запишу вас, будем ждать.',3);await self.c.handle('Запишу вас, будем ждать.',3,0)
        self.assertTrue(self.c.visit_confirmed)

    async def test_confirmation_without_any_active_offer_does_not_invent_booking(self):
        self.c.started=True;self.c.current='visit'
        self.user('Хорошо, будем вас ждать.',1)
        await self.c.handle('Хорошо, будем вас ждать.',1,0)
        self.assertFalse(self.s.evidence.memory.facts);self.assertFalse(self.c.visit_confirmed)
        self.assertFalse(self.s.playback.finish_requested)

    async def test_unrelated_question_preserves_active_offer_until_confirmation(self):
        self.c.started=True;self.c.current='visit';self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.c.visit.update('Завтра после обеда.',1)
        await self.c.ask_visit(self.c.visit.proposal())
        offer=self.c.visit.offered
        self.user('Вам отправить адрес?',2);await self.c.handle('Вам отправить адрес?',2,0)
        self.assertEqual(self.c.visit.offered,offer)
        self.user('Хорошо, будем вас ждать.',3);await self.c.handle('Хорошо, будем вас ждать.',3,0)
        self.assertTrue(self.c.visit_confirmed)

    async def test_blocked_visit_field_gives_audible_status_without_repeating_question(self):
        self.c.started=True;self.c.current='visit';self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        await self.c.speak('visit');self.c.player.queue_frame.reset_mock()
        self.user('В подходящее время.',1);await self.c.ask_visit()
        text=self.c.player.queue_frame.call_args.args[0].text
        self.assertEqual(text,self.c.texts['visit_pending']);self.assertNotIn('?',text)
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_receipt_prefix_cannot_bypass_visit_question_ids(self):
        await self.c.speak_parts(['receipt_0','visit']);self.c.player.queue_frame.reset_mock()
        self.assertIsNone(await self.c.speak('clarify_time_short'))
        self.c.player.queue_frame.assert_not_awaited()
        self.assertIn('visit-field:time',self.c.question_ledger)

    async def test_native_arrival_claim_returns_to_controller_proposal(self):
        self.c.started=True;self.c.current='visit';self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.c.visit.update('Завтра после обеда.',1)
        guard=SpeechFilter(controller=self.c)
        self.assertEqual(guard.feed('Подъеду завтра после обеда.',final=True),'')
        self.c.llm.speech_filters={'native':guard};self.c.llm.response_items={'native':set()}
        await self.c.fallback_done('native')
        self.assertIn('в три часа дня',self.c.player.queue_frame.call_args.args[0].text)
        self.assertIsNotNone(self.c.visit.offered);self.assertFalse(self.s.evidence.memory.facts)

    def test_options_do_not_mix_days_and_times_between_branches(self):
        v=VisitProposal();v.update('Завтра или послезавтра в пять.',1)
        self.assertEqual(v.proposal()['day']['value'],'послезавтра')
        self.assertEqual(v.proposal()['time']['value'],'в пять')
        v=VisitProposal();v.update('Завтра утром либо послезавтра вечером.',1)
        self.assertEqual(v.proposal()['day']['value'],'Завтра')
        self.assertEqual(v.proposal()['time']['value'],'в десять утра')

    def test_first_half_and_spoken_ranges_stay_inside_offered_window(self):
        v=VisitProposal();v.update('Завтра в первой половине дня.',1)
        self.assertEqual(v.proposal()['time']['value'],'в десять утра')
        v=VisitProposal();v.update('Завтра с десяти до двенадцати.',1)
        self.assertEqual(v.proposal()['time']['value'],'в 10:00')
        v.offered=v.proposal()
        self.assertTrue(v.confirmed_facts('Да, приезжайте завтра в десять.',2))

    def test_clear_acceptance_variants_bind_only_an_existing_slot(self):
        from controller_visit import confirms_slot
        offer={'day':{'value':'завтра'},'time':{'value':'в три часа дня'}}
        for text in ('Подходит.','Подойдёт.','Договорились.','Будем ждать вас.','Ждём вас завтра.','Записываю вас на завтра.'):
            self.assertTrue(confirms_slot(offer,text),text)
            self.assertFalse(confirms_slot(None,text),text)

    def test_booking_confirmation_rejects_counterproposal_and_conditions(self):
        from controller_visit import confirms_slot
        offer={'day':{'value':'завтра'},'time':{'value':'в три часа дня'}}
        self.assertTrue(confirms_slot(offer,'Хорошо, запишу вас на завтра.'))
        self.assertTrue(confirms_slot(offer,'Да, завтра в 15:00.'))
        for text in ('Будем вас ждать, если будет свободно.','Запишу вас послезавтра.','Нет, будем вас ждать завтра.','Запишу вас завтра в четыре.','Хорошо, но сначала проверю.'):
            self.assertFalse(confirms_slot(offer,text),text)
        self.assertFalse(confirms_slot(None,'Будем вас ждать.'))

    async def test_initial_question_is_prepared_and_mirrored_without_generation(self):
        self.user("Добрый день, слушаю вас.")
        await self.c.handle("Добрый день, слушаю вас.",1,0)
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIsInstance(frame,PreparedSpeechFrame);self.assertIn("продаётся",frame.text)
        self.assertNotIn('Андрей',frame.text)
        self.assertNotIn('меня зовут',frame.text.casefold())
        self.c.choose.assert_not_awaited()
        item=self.c.llm.send_client_event.call_args.args[0].item
        self.assertEqual(item.content[0].text,frame.text)

    async def test_first_hello_is_greeting_not_attention_after_farewell(self):
        self.user("Алло.")
        await self.c.handle("Алло.",1,0)
        self.assertEqual(self.c.current,"availability")
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['opening'])

    async def test_name_and_first_question_after_availability(self):
        self.c.started=True;self.c.current="availability"
        text="Да, актуально. Как к вам обращаться?";self.user(text)
        await self.c.handle(text,1,0)
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIn("Андрей",frame.text);self.assertIn("пробег",frame.text.casefold())
        self.assertEqual(self.c.current,"mileage")

    async def test_clear_answer_advances_once_without_decisions_or_crm_fact(self):
        self.c.started=True;self.c.current="mileage"
        self.s.evidence.memory.open_question={"text":"Пробег актуальный?"}
        self.user("Пробег актуальный.")
        await self.c.handle("Пробег актуальный.",1,0)
        self.assertEqual(self.c.current,"rust");self.assertFalse(self.s.evidence.memory.facts)
        self.c.choose.assert_not_awaited()

    async def test_old_hint_does_not_advance_unrelated_current_answer(self):
        self.c.started=True;self.c.current="mileage"
        self.s.evidence.memory.topics.answers["mileage"]={"turn":0,"evidence":"old"}
        self.user("А вы в кредит хотите?",1)
        await self.c.handle("А вы в кредит хотите?",1,0)
        self.c.choose.assert_awaited_once()
        self.assertFalse(self.c.answers)
        self.assertEqual(self.c.llm.request_reason,"controller_fallback")

    async def test_stale_remote_result_never_queues_audio(self):
        self.c.started=True;self.c.current="mileage"
        async def delayed(_):await asyncio.sleep(20)
        self.c.choose.side_effect=delayed
        self.user("А кредит возможен?");self.c.receive("А кредит возможен?",1)
        await asyncio.sleep(0)
        await self.c.new_input();await asyncio.sleep(0)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_transport_failure_aborts_pending_controller_and_cached_audio(self):
        self.c.started=True;self.c.current="mileage"
        async def delayed(_):await asyncio.sleep(20)
        self.c.choose.side_effect=delayed
        self.user("А кредит есть?");self.c.receive("А кредит есть?",1)
        await asyncio.sleep(0)
        self.c.playing_id="old"
        llm=GatedRealtime(self.s,self.monitor,api_key="test")
        llm.push_error=AsyncMock()
        await llm.fail_connection("test")
        await asyncio.sleep(0)
        await self.c.speak("repeat")
        self.assertIsNone(self.c.playing_id)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_explicit_wait_suppresses_backchannels_until_next_reply(self):
        self.c.started=True;self.c.current="mileage";self.c.choose.return_value="wait"
        self.user("Подождите.")
        await self.c.handle("Подождите.",1,0)
        self.c.schedule_backchannel("listen",0)
        self.assertTrue(self.c.waiting);self.assertIsNone(self.c.bc_task)
        self.c.choose.return_value="answer"
        self.user("Пробег актуальный.",2)
        await self.c.handle("Пробег актуальный.",2,0)
        self.assertFalse(self.c.waiting)

    async def test_uncertain_visit_never_tells_fallback_to_accept_or_say_goodbye(self):
        self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.c.started=True;self.c.current="mileage";self.c.choose.return_value="clarify"
        self.user("Приезжайте завтра в одиннадцать, удобно?")
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\0\0'*1600)):
            await self.c.handle("Приезжайте завтра в одиннадцать, удобно?",1,0)
        self.assertIn("Правильно понял",self.c.player.queue_frame.call_args.args[0].text)
        self.assertIsNone(self.c.fallback_turn)
        self.assertFalse(self.s.evidence.memory.facts)
        self.assertTrue(self.c.awaiting_confirmation)
        self.user("Да, всё верно.",2)
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\0\0'*1600)):
            await self.c.handle("Да, всё верно.",2,0)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.s.evidence.memory.facts['visit_time']['value'],'в одиннадцать')

    async def test_visit_uses_original_quote_and_waits_for_phone_ack(self):
        self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.c.started=True;self.c.current="visit";self.c.choose.return_value="visit"
        m=self.s.evidence.memory;m.open_question={"text":"Когда можно подъехать?"};m.visit_pending=True
        text="Можно сегодня во второй половине дня, типа часиков в пять? Вам будет удобно?"
        self.user(text)
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\0\0'*1600)):
            await self.c.handle(text,1,0)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(m.facts['visit_day']['value'],'сегодня')
        self.assertIn(m.facts['visit_time']['value'],text)
        self.assertFalse(self.s.playback.can_hangup)

    async def test_early_booking_cannot_bypass_required_questions(self):
        self.c.started=True;self.c.current='visit';self.c.choose.return_value='visit'
        text='Приезжайте завтра в одиннадцать, удобно?';self.user(text)
        await self.c.handle(text,1,0)
        m=self.s.evidence.memory
        self.assertEqual(m.facts['visit_time']['value'],'в одиннадцать')
        self.assertFalse(self.s.playback.finish_requested)
        self.assertFalse(m.prepare_close('visit_agreed')['ok'])
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertEqual(frame.text,'Договорились. '+self.c.texts['mileage'])
        self.assertEqual(frame.pcm,self.c.clips['visit_ack']+self.c.clips['mileage'])
        self.assertEqual(self.c.current,'mileage')
        self.user('Пробег актуальный.',2);await self.c.handle('Пробег актуальный.',2,0)
        self.assertEqual(self.c.current,'rust');self.assertFalse(self.s.playback.finish_requested)
        self.user('Пороги целые, коррозии нет.',3);await self.c.handle('Пороги целые, коррозии нет.',3,0)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(m.closing_reason,'visit_agreed')
        self.assertFalse(self.c.pending());self.assertEqual(self.c.asked.get('visit',0),0)

    async def test_subject_answer_is_cached_and_does_not_jump_to_visit(self):
        self.c.started=True;self.c.current='availability'
        self.c.texts['subject']='По Лира Седан 2024 из объявления.';self.c.clips['subject']=b'\0\0'*1600
        text='Добрый день, по какому объявлению звоните?';self.user(text)
        await self.c.handle(text,1,0)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['subject'])
        self.assertEqual(self.c.current,'availability');self.c.choose.assert_not_awaited()

    async def test_name_and_listing_questions_are_answered_in_one_cached_response(self):
        self.c.texts['subject']='По Лира Седан 2024 из объявления.';self.c.clips['subject']=b'\0\0'*1600
        text='Вот скажите, как я могу к вам обращаться и по какому объявлению звоните?';self.user(text)
        await self.c.handle(text,1,0)
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIn('Андрей',frame.text);self.assertIn('Лира Седан',frame.text)
        self.assertEqual(frame.pcm,self.c.clips['name']+self.c.clips['subject'])
        self.assertTrue(self.c.started);self.assertNotIn('?',frame.text)
        self.user('Угу, хорошо. Подскажите, что вас интересует?',2)
        await self.c.handle('Угу, хорошо. Подскажите, что вас интересует?',2,0)
        self.assertEqual(self.c.current,'mileage');self.c.choose.assert_not_awaited()

    async def test_name_and_purpose_request_goes_to_one_answer_task(self):
        text='Как к вам обращаться и для чего вам нужен автомобиль?';self.user(text)
        await self.c.handle(text,1,0)
        self.assertEqual(self.c.llm.request_reason,'controller_fallback')
        self.assertEqual(self.c.requested_answers['name'],'Меня зовут Андрей.')
        self.assertIn('все вопросы',self.c.fallback_goal)
        self.c.player.queue_frame.assert_not_awaited();self.c.choose.assert_not_awaited()

    async def test_discount_pronoun_and_offline_condition_do_not_change_to_visit(self):
        self.c.started=True;self.c.current='discount'
        text='Да, можно, но только по поводу неё надо в Sloan обращаться, то есть к нам он будет приехать обсудить на месте.'
        await self.semantic_answer(text)
        self.assertIn('discount',self.c.answers)
        self.assertEqual(self.c.current,'mileage')
        self.assertEqual(self.c.asked.get('visit',0),0)
        self.assertFalse(self.c.visit_input('Чтобы обсудить скидку, надо приехать к нам.'))

    async def test_daypart_proposal_accepts_exact_slot_repetition_without_reconfirmation(self):
        self.c.started=True;self.c.current='visit'
        self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.user('Завтра во второй половине дня можно будет.',1)
        await self.c.handle('Завтра во второй половине дня можно будет.',1,0)
        self.assertIn('в три часа дня',self.c.player.queue_frame.call_args.args[0].text)
        self.assertFalse(self.s.evidence.memory.facts)
        self.user('Да, давайте в три завтра.',2)
        await self.c.handle('Да, давайте в три завтра.',2,0)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.s.evidence.memory.facts['visit_time']['value'],'в три часа дня')
        self.assertIsNone(self.c.awaiting_confirmation);self.c.choose.assert_not_awaited()

    async def test_confirmation_compares_slot_values_instead_of_quote_identity(self):
        self.c.started=True;self.c.current='visit';self.c.choose.return_value='clarify'
        self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.user('Приезжайте завтра в три.',1)
        await self.c.handle('Приезжайте завтра в три.',1,0)
        self.user('Да, завтра в три.',2)
        await self.c.handle('Да, завтра в три.',2,0)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertIsNone(self.c.awaiting_confirmation)
        self.assertEqual(self.c.choose.await_count,1)

    async def test_unanswered_time_confirmation_has_a_limit_without_inventing_booking(self):
        self.c.started=True;self.c.current='visit'
        self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        for turn in range(1,4):
            self.user('Завтра во второй половине дня.',turn)
            await self.c.handle('Завтра во второй половине дня.',turn,0)
        self.assertIsNone(self.s.evidence.memory.closing_reason)
        self.assertFalse(self.s.playback.finish_requested)
        self.assertTrue(self.c.waiting)
        self.assertFalse(self.s.evidence.memory.facts)
        texts=[c.args[0].text for c in self.c.player.queue_frame.call_args_list]
        self.assertEqual(sum('Подойдёт?' in text for text in texts),1)
        self.assertTrue(all('завтра' in text.casefold() and 'в три' in text.casefold() for text in texts if '?' in text))
        self.assertTrue(any('Мне подойдёт' in text for text in texts))
        self.assertNotIn('Это время вам подходит?',texts)

    async def test_cancelled_visit_proposal_does_not_consume_attempt_or_confirm_unsaid_time(self):
        self.c.visit.update('Приезжайте завтра после обеда.',1)
        proposal=self.c.visit.proposal()
        async def slow(*_):await asyncio.sleep(10)
        with patch('dialogue_controller.voice_clip',new=slow):
            self.c.task=asyncio.create_task(self.c.ask_visit(proposal))
            await asyncio.sleep(0)
            await self.c.new_input()
            await asyncio.gather(self.c.task,return_exceptions=True)
        self.assertFalse(self.c.visit_attempts);self.assertIsNone(self.c.visit.offered)
        await self.c.ask_visit(proposal)
        text=self.c.player.queue_frame.call_args.args[0].text
        self.assertIn('завтра',text);self.assertIn('в три',text)
        self.assertNotEqual(text,'Это время вам подходит?')
        self.assertEqual(list(self.c.visit_attempts.values()),[1])

    async def test_generation_filler_is_disabled_but_listening_backchannel_remains(self):
        self.c.current='mileage'
        self.c.schedule_backchannel('work',0)
        self.assertIsNone(self.c.bc_task);self.assertNotIn('bc_work',self.c.texts)
        self.c.schedule_backchannel('listen',0)
        await self.c.bc_task
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,'Мгм.')

    async def test_conditional_polar_reply_is_saved_before_uncertain_visit_classification(self):
        self.c.started=True;self.c.current='custom:0'
        self.s.evidence.memory.topics.required=[{'key':'custom:0','question':'Можно ли заказать доставку?'}]
        self.c.last_question={'text':'Возможна ли доставка?','topic':'custom:0','kind':'plan'}
        await self.semantic_answer('Да, но условия определим при встрече. Приезжайте, согласуем время.',action='clarify',coverage_score=.57)
        self.assertIn('custom:0',self.c.answers)
        self.assertIn('условия',self.c.answers['custom:0']['evidence'])
        self.assertNotIn('custom:0',[r['key'] for r in self.c.pending()])

    async def test_explicit_polar_plan_answer_survives_opposing_semantic_vote(self):
        self.c.started=True;self.c.current='custom:0'
        self.s.evidence.memory.topics.required=[{'key':'custom:0','question':'Можно ли заказать доставку?'}]
        self.c.last_question={'text':'Возможна ли доставка?','topic':'custom:0','kind':'plan'}
        await self.semantic_answer('Да, но условия согласуем при встрече. Приезжайте, согласуем время.',action='clarify',coverage_score=.29,coverage_choice='unanswered')
        self.assertIn('custom:0',self.c.answers)
        self.assertEqual(self.c.answers['custom:0']['scope'],'explicit polar answer to referenced plan question')
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_yes_does_not_corroborate_weak_vote_for_quantity_question(self):
        self.assertTrue(explicit_polar_answer('Есть ли доставка?','Да, но только после оплаты.'))
        self.assertFalse(explicit_polar_answer('Сколько стоит доставка?','Да, но условия определим при встрече.'))
        self.assertFalse(explicit_polar_answer('Когда можно подъехать?','Да.'))
        self.c.started=True;self.c.current='custom:0'
        self.s.evidence.memory.topics.required=[{'key':'custom:0','question':'Сколько стоит доставка?'}]
        self.c.last_question={'text':'Сколько стоит доставка?','topic':'custom:0','kind':'plan'}
        await self.semantic_answer('Да.',action='answer',coverage_score=.57)
        self.assertNotIn('custom:0',self.c.answers)

    async def test_visit_invitation_does_not_lose_answer_or_repeat_current_plan_question(self):
        self.c.started=True;self.c.current='mileage'
        await self.c.speak('mileage');self.c.player.queue_frame.reset_mock()
        await self.semantic_answer('Да, значение подтверждено. Приезжайте, договоримся о времени.',action='clarify')
        self.assertIn('mileage',self.c.answers)
        self.assertEqual(self.c.current,'rust');self.assertEqual(self.c.asked['mileage'],1)
        self.assertFalse(self.s.playback.finish_requested)
        self.assertFalse(self.c.visit_attempts)

    async def test_stt_after_transport_disconnect_cannot_generate_goodbye(self):
        self.s.media_disconnected=True
        llm=GatedRealtime(self.s,self.monitor,api_key='test')
        llm.items['late']=(Turn(False,number=1),True)
        with patch.object(GatedRealtime.__bases__[0],'handle_evt_input_audio_transcription_completed',new=AsyncMock()) as parent:
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='late',transcript='Около года.'))
        parent.assert_not_awaited();self.c.player.queue_frame.assert_not_awaited()
        self.assertFalse(self.c.answers);self.assertIsNone(self.s.evidence.memory.closing_reason)

    async def test_unresolved_visit_cannot_close_before_required_topics(self):
        m=self.s.evidence.memory;m.controller_visit_unresolved=True
        self.assertFalse(m.prepare_close('visit_unresolved')['ok'])

    def test_slot_confirmation_rejects_changed_time_or_extra_condition(self):
        from controller_visit import confirms_slot
        offer={'day':{'value':'завтра'},'time':{'value':'в три часа дня'}}
        self.assertTrue(confirms_slot(offer,'Да, завтра в три.'))
        for text in ('Да, завтра в четыре.','Да, не завтра в три.','Да, завтра в три, но только по предоплате.','Завтра в три?'):
            self.assertFalse(confirms_slot(offer,text),text)

    def test_daypart_with_deadline_never_chooses_outside_manager_conditions(self):
        v=VisitProposal();v.update('Завтра во второй половине дня, но до двух.',1)
        self.assertIsNone(v.proposal())
        v.update('Завтра во второй половине дня.',2);self.assertIsNotNone(v.proposal())
        v.offered=v.proposal();v.update('Завтра во второй половине дня, но до двух.',3)
        self.assertIsNone(v.proposal());self.assertIsNone(v.offered)

    async def test_fallback_cannot_ask_visit_before_required_topics(self):
        f=SpeechFilter(controller=self.c)
        self.assertEqual(f.feed('По машине из объявления. Какой день и время визита вам удобны?',final=True),'По машине из объявления.')

    async def test_ambiguous_offer_cannot_close_even_if_classifier_says_visit(self):
        self.c.started=True;self.c.current="visit";self.c.choose.return_value="visit"
        m=self.s.evidence.memory;m.visit_pending=True;m.open_question={"text":"Когда можно подъехать?"}
        text="Давайте завтра в четыре или в пять?";self.user(text)
        await self.c.handle(text,1,0)
        self.assertFalse(m.facts);self.assertFalse(self.s.playback.finish_requested)
        self.assertIn('завтра',self.c.player.queue_frame.call_args.args[0].text)
        self.assertIn('в четыре',self.c.player.queue_frame.call_args.args[0].text)
        self.assertTrue(self.c.visit.offered)

    async def test_interrupted_farewell_attention_resumes_without_model(self):
        m=self.s.evidence.memory;m.phase="closing";m.closing_reason="visit_agreed"
        m.facts={"visit_day":{"value":"завтра"}}
        self.s.playback.finish_requested=True
        self.user("Вы тут?")
        await self.c.handle("Вы тут?",1,0)
        self.assertEqual(m.phase,"dialogue");self.assertIsNone(m.closing_reason)
        self.assertFalse(self.s.playback.finish_requested);self.assertTrue(m.facts)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['resume'])
        self.c.choose.assert_not_awaited()

    async def test_historical_visit_cannot_turn_new_personal_question_into_booking(self):
        self.c.started=True;self.c.current="mileage"
        self.user("Приезжайте завтра в одиннадцать, удобно?",1)
        self.assertTrue(self.c.visit_input("Приезжайте завтра в одиннадцать, удобно?"))
        self.c.choose.return_value="visit"
        self.user("Для чего вам нужен автомобиль?",2)
        self.assertFalse(self.c.visit_input("Для чего вам нужен автомобиль?"))
        await self.c.handle("Для чего вам нужен автомобиль?",2,0)
        self.assertFalse(self.s.playback.finish_requested)
        self.assertEqual(self.c.llm.request_reason,"controller_fallback")
        self.c.player.queue_frame.assert_not_awaited()

    async def test_general_invitation_to_ask_goes_to_first_question_without_llm(self):
        self.c.started=True;self.c.current='availability'
        text='Да, машина продается, подскажите, что вас интересует?';self.user(text)
        await self.c.handle(text,1,0)
        self.assertEqual(self.c.current,'mileage');self.c.choose.assert_not_awaited()
        self.user('Да, пробег актуальный.',2)
        await self.c.handle('Да, пробег актуальный.',2,0)
        self.assertEqual(self.c.current,'rust')
        self.assertEqual(self.c.asked['mileage'],1)
        self.assertEqual(self.s.evidence.messages[self.c.playing_id]['turn'],2)

    async def test_floor_return_after_counterquestion_asks_next_pending_once(self):
        self.c.started=True;self.c.current='mileage';self.c.answers['mileage']={'status':'answered'}
        text='Что ещё хотите уточнить?';self.user(text)
        await self.c.handle(text,1,0)
        self.assertEqual(self.c.current,'rust');self.c.choose.assert_not_awaited()
        self.assertEqual(self.c.asked.get('mileage',0),0)
        self.assertEqual(self.c.asked['rust'],1)

    async def test_native_followup_does_not_reassign_plan_topic(self):
        self.c.started=True;self.c.current='availability'
        self.c.llm.spoken_text['native']='Интересует пробег: актуальны ли километры в объявлении?'
        await self.c.fallback_done('native')
        self.assertEqual(self.c.current,'availability')
        self.assertIsNone(self.c.last_question)
        await self.c.speak('mileage')
        self.assertEqual(self.c.last_question['topic'],'mileage')
        self.user('Пробег актуальный.',2)
        await self.c.handle('Пробег актуальный.',2,0)
        self.assertEqual(self.c.current,'rust')

    async def test_conditional_discount_is_answer_not_a_repeated_question(self):
        self.c.started=True;self.c.current='discount'
        self.c.answers={'mileage':{},'rust':{}}
        text='А скидку можем сделать? Но только если будем обсуждать эту штуку в салоне.'
        await self.semantic_answer(text)
        self.assertIn('discount',self.c.answers)

    async def test_fragmented_day_and_interval_then_repeated_yes_closes_once(self):
        self.c.answers={r['key']:{} for r in self.s.evidence.memory.topics.required}
        self.c.started=True;self.c.current='mileage'
        self.user('Приехать можно сегодня во второй половине дня.',1)
        await self.c.handle('Приехать можно сегодня во второй половине дня.',1,0)
        self.assertEqual(self.c.current,'visit')
        self.user('Часиков четырнадцать-пятнадцать.',2)
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\0\0'*1600)):
            await self.c.handle('Часиков четырнадцать-пятнадцать.',2,0)
        self.assertTrue(self.c.visit.offered)
        self.assertIn('в четырнадцать',self.c.player.queue_frame.call_args.args[0].text)
        self.assertFalse(self.s.evidence.memory.facts)
        self.user('Да, да, да, отлично, отлично.',3)
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\0\0'*1600)):
            await self.c.handle('Да, да, да, отлично, отлично.',3,0)
        m=self.s.evidence.memory
        self.assertEqual(m.closing_reason,'visit_agreed')
        self.assertEqual(m.facts['visit_time']['source'],'client_proposal_confirmed_by_manager')
        self.assertEqual(m.facts['visit_time']['confirmation_evidence'],'Да, да, да, отлично, отлично.')
        self.assertFalse(self.s.playback.can_hangup)

    async def test_direct_goodbye_closes_without_inventing_visit(self):
        self.c.started=True;self.c.current='visit';self.s.evidence.memory.visit_pending=True
        text='Да вроде всё. Диалог закончился, до свидания.'
        self.user(text);await self.c.handle(text,1,0)
        self.assertEqual(self.s.evidence.memory.closing_reason,'manager_goodbye')
        self.assertFalse(self.s.evidence.memory.facts)
        self.assertTrue(self.s.playback.finish_requested)
        self.c.choose.assert_not_awaited()

    async def test_filtered_duplicate_never_survives_in_provider_history(self):
        self.c.current='rust';self.c.answers={'mileage':{}}
        f=SpeechFilter(controller=self.c);self.assertEqual(f.feed('Пробег актуальный?',final=True),'')
        self.c.llm.speech_filters={'native':f};self.c.llm.response_items={'native':{'old-item'}}
        await self.c.fallback_done('native')
        self.assertTrue(any(c.args[0].type=='conversation.item.delete' and c.args[0].item_id=='old-item' for c in self.c.llm.send_client_event.call_args_list))
        self.assertEqual(self.c.current,'rust')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['rust'])

    async def test_actual_paced_websocket_output_seals_cached_audio_before_ack(self):
        from pipecat.transports.websocket.fastapi import FastAPIWebsocketTransport,FastAPIWebsocketParams
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.worker import PipelineWorker,PipelineParams
        from pipecat.workers.runner import WorkerRunner
        from starlette.websockets import WebSocketState
        messages=[];stopped=asyncio.Event()
        async def send(text):
            m=json.loads(text);messages.append(m)
            if m.get('event')=='stop':stopped.set()
        ws=SimpleNamespace(send_text=send,client_state=WebSocketState.CONNECTED,application_state=WebSocketState.CONNECTED,close=AsyncMock())
        serializer=VoxSerializer(self.s,ws);self.c.serializer=serializer
        transport=FastAPIWebsocketTransport(ws,FastAPIWebsocketParams(audio_out_enabled=True,audio_out_sample_rate=16000,audio_out_10ms_chunks=2,serializer=serializer,allowed_origins=[]))
        player=PreparedAudioPlayer(self.s);self.c.player=player
        worker=PipelineWorker(Pipeline([player,OutputEvidence(self.s,serializer,'tts'),transport.output(),OutputEvidence(self.s,serializer,'delivery')]),params=PipelineParams(audio_out_sample_rate=16000),enable_rtvi=False)
        runner=WorkerRunner(handle_sigint=False);await runner.add_workers(worker)
        running=asyncio.create_task(runner.run())
        try:
            await asyncio.sleep(.1)
            await self.c.speak('opening',closing=True)
            await asyncio.wait_for(stopped.wait(),3)
            tag=next(m['stop']['tag'] for m in messages if m.get('event')=='stop')
            self.assertIn(tag,self.s.playback.sealed)
            self.assertFalse(any(m.get('action')=='hangup' for m in messages))
            self.assertEqual(sum(len(__import__('base64').b64decode(m['media']['payload'])) for m in messages if m.get('event')=='media'),len(self.c.clips['opening']))
            await serializer.deserialize(json.dumps({'customEvent':'playback','action':'ended','tag':tag}))
            self.assertFalse(self.s.playback.busy)
            self.assertTrue(any(m.get('action')=='hangup' for m in messages))
        finally:
            await runner.cancel();await asyncio.gather(running,return_exceptions=True)

    async def test_early_phone_end_is_replayed_only_without_later_audio(self):
        ws=SimpleNamespace(send_text=AsyncMock());v=VoxSerializer(self.s,ws)
        self.s.evidence.current_response_id='r'
        await v.serialize(OutputAudioRawFrame(b'\0\0'*320,16000,1))
        tag=self.s.playback.active
        await v.deserialize(json.dumps({'customEvent':'playback','action':'ended','tag':tag}))
        self.assertIn(tag,self.s.playback.pending)
        await v.seal()
        self.assertNotIn(tag,self.s.playback.pending)
        await v.serialize(OutputAudioRawFrame(b'\0\0'*320,16000,1))
        tag=self.s.playback.active
        await v.deserialize(json.dumps({'customEvent':'playback','action':'ended','tag':tag}))
        await v.serialize(OutputAudioRawFrame(b'\0\0'*320,16000,1))
        await v.seal()
        self.assertIn(tag,self.s.playback.pending)
        await v.deserialize(json.dumps({'customEvent':'playback','action':'ended','tag':tag}))
        self.assertNotIn(tag,self.s.playback.pending)

    async def test_short_answer_survives_stale_overlap_after_question_has_ended(self):
        self.c.started=True;self.c.current='visit';self.c.last_question={'text':'Подойдет?'}
        self.c.receive=__import__('unittest.mock',fromlist=['Mock']).Mock()
        llm=GatedRealtime(self.s,self.monitor,api_key='test')
        llm.items['ack']=(Turn(True,300,number=1),True)
        llm._handle_interruption=AsyncMock()
        with patch.object(GatedRealtime.__bases__[0],'handle_evt_input_audio_transcription_completed',new=AsyncMock()):
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='ack',transcript='Угу.'))
        self.assertEqual(self.c.receive.call_args.args,('Угу.',1))
        self.assertEqual(self.c.receive.call_args.kwargs['batch'][0]['turn'],1)
        llm._handle_interruption.assert_not_awaited()

    async def test_zero_duration_pronoun_overlap_does_not_clear_opening(self):
        self.c.receive=__import__('unittest.mock',fromlist=['Mock']).Mock()
        llm=GatedRealtime(self.s,self.monitor,api_key='test')
        llm.items['prefix']=(Turn(True,0,number=1),True)
        llm._handle_interruption=AsyncMock();llm.broadcast_frame=AsyncMock()
        await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='prefix',transcript='Вы'))
        self.c.receive.assert_not_called()
        llm._handle_interruption.assert_not_awaited();llm.broadcast_frame.assert_not_awaited()
        self.assertTrue(any(e['event']=='barge_in_fragment_ignored' for e in self.s.evidence.events))

    async def test_short_complete_stop_still_clears_audio_with_controller(self):
        from pipecat.frames.frames import InterruptionFrame
        self.c.receive=__import__('unittest.mock',fromlist=['Mock']).Mock()
        turn=Turn(True,250,number=1);self.monitor.turn=turn
        self.s.playback.pending.add('playing')
        llm=GatedRealtime(self.s,self.monitor,api_key='test')
        llm.items['stop']=(turn,True);llm._handle_interruption=AsyncMock()
        async def broadcast(*_):self.c.serializer.queue_cleared_event.set()
        llm.broadcast_frame=AsyncMock(side_effect=broadcast)
        with patch.object(GatedRealtime.__bases__[0],'handle_evt_input_audio_transcription_completed',new=AsyncMock()):
            await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='stop',transcript='Стоп.'))
        llm._handle_interruption.assert_awaited_once()
        llm.broadcast_frame.assert_awaited_once_with(InterruptionFrame)
        self.c.receive.assert_called_once()

    async def test_negative_or_changed_time_does_not_confirm_old_proposal(self):
        self.c.started=True;self.c.current='visit'
        self.c.visit.day={'value':'завтра','evidence':'завтра','turn':1}
        self.c.visit.time={'value':'в четыре','evidence':'в четыре','turn':1}
        self.c.visit.offered=self.c.visit.proposal()
        text='Нет, не завтра, перезвоните позже.';self.user(text,2)
        self.c.choose.return_value='answer'
        await self.c.handle(text,2,0)
        self.assertFalse(self.s.evidence.memory.facts)
        self.assertFalse(self.s.playback.finish_requested)

    async def test_question_filter_keeps_answer_but_removes_closed_topic(self):
        self.c.answers={'mileage':{}}
        f=SpeechFilter(controller=self.c)
        self.assertEqual(f.feed('Для личных поездок. Пробег актуальный?',final=True),'Для личных поездок.')
        self.assertEqual(f.spoken,'Для личных поездок.')

    async def test_quoting_farewell_is_not_a_hangup_instruction(self):
        self.assertFalse(goodbye('Он сказал до свидания.'))
        self.assertFalse(goodbye('Не говорите до свидания.'))
        self.assertFalse(affirmative('Да, но не завтра.'))

    async def test_backchannel_frame_is_interruptible_and_never_in_model_context(self):
        self.c.current="mileage"
        self.c.schedule_backchannel("listen",0)
        await self.c.bc_task
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIsInstance(frame,BotBackchannelFrame)
        self.assertTrue(frame.interruptible);self.assertFalse(frame.append_to_context)
        self.c.llm.send_client_event.assert_not_awaited()
        self.c.player.queue_frame.reset_mock()
        self.c.schedule_backchannel("listen",0);await self.c.bc_task
        self.c.player.queue_frame.assert_not_awaited()

    async def test_cancel_backchannel_does_not_interrupt_main_tts_or_delivery(self):
        v=VoxSerializer(self.s,SimpleNamespace(send_text=AsyncMock()));self.c.serializer=v
        self.c.output_transport=SimpleNamespace(queue_frame=AsyncMock(side_effect=v.serialize))
        self.c.playing_kind='backchannel';self.c.playing_id='bc';self.c.llm.wire_active='native'
        self.s.playback.generated=True
        self.s.evidence.delivery.response('bc')['kind']='backchannel'
        self.s.evidence.delivery.response('native')
        await self.c.stop_backchannel()
        self.c.llm.broadcast_frame.assert_not_awaited()
        self.assertEqual(self.c.output_transport.queue_frame.await_count,1)
        self.assertTrue(self.s.playback.generated)
        self.assertFalse(self.s.evidence.delivery.response('native')['interrupted'])
        self.assertTrue(self.s.evidence.delivery.response('bc')['interrupted'])

    async def test_native_text_corrects_context_owner_created_during_backchannel(self):
        from pipeline import DialogueTTS
        tts=DialogueTTS(api_key='test',sample_rate=16000)
        tts.evidence=self.s.evidence;tts.incoming_response_id='native'
        self.s.evidence.delivery.contexts['ctx']='bc'
        self.s.evidence.delivery.response('bc')['kind']='backchannel'
        async def fake_tts(service,text,context_id):
            yield None
        with patch.object(DialogueTTS.__bases__[0],'run_tts',new=fake_tts):
            frames=[f async for f in tts.run_tts('Для личных поездок.','ctx')]
        self.assertEqual(self.s.evidence.delivery.contexts['ctx'],'native')

    async def test_incomplete_callback_accounts_for_upstream_vad_stop_order(self):
        self.c.current="mileage";self.monitor.segment_start=time.monotonic()-2.5
        self.c.on_incomplete_pause()
        self.assertIsNotNone(self.c.bc_task)
        self.monitor.segment_start=None
        await self.c.bc_task
        self.assertIsInstance(self.c.player.queue_frame.call_args.args[0],BotBackchannelFrame)

    async def test_no_backchannel_during_visit_or_disabled_or_speaking(self):
        self.c.current="visit";self.c.schedule_backchannel("listen",0)
        self.assertIsNone(self.c.bc_task)
        self.c.current="mileage";self.s.backchannel=False
        self.c.schedule_backchannel("listen",0);self.assertIsNone(self.c.bc_task)
        self.s.backchannel=True;self.monitor.segment_start=1.
        self.c.schedule_backchannel("listen",0);await self.c.bc_task
        self.c.player.queue_frame.assert_not_awaited()
        reasons=[e.get('reason') for e in self.s.evidence.events if e['event']=='backchannel_skipped']
        self.assertIn('greeting_or_visit',reasons)
        self.assertIn('disabled',reasons)
        self.assertIn('manager_speaking',reasons)

    async def test_native_name_is_not_spoken_without_manager_request(self):
        f=SpeechFilter(controller=self.c)
        self.assertEqual(f.feed('Я Андрей. Для личных поездок.',final=True),' Для личных поездок.')
        self.s.evidence.memory.topics.name_requested=True
        f=SpeechFilter(controller=self.c)
        self.assertEqual(f.feed('Меня зовут Андрей.',final=True),'Меня зовут Андрей.')

    async def test_natural_questions_keep_topic_and_are_cached_before_call(self):
        self.assertEqual(self.c.texts['mileage'],'Скажите, пробег в объявлении актуальный?')
        self.assertEqual(self.c.texts['rust'],'А как пороги по состоянию, коррозия есть?')
        self.assertIn('Скажите, пробег',self.c.texts['name_then_first'])
        self.assertEqual(set(self.c.clips),set(self.c.texts))

    async def test_checking_visit_keeps_day_and_waits_without_question(self):
        self.c.started=True;self.c.current='visit'
        text='Сегодня можно посмотреть. Сейчас я посмотрю секундочку';self.user(text)
        await self.c.handle(text,1,0)
        self.assertTrue(self.c.waiting);self.assertEqual(self.c.visit.day['value'],'Сегодня')
        self.c.player.queue_frame.assert_not_awaited();self.c.choose.assert_not_awaited()

    async def test_cached_player_uses_same_pcm_format_and_no_context_append(self):
        p=PreparedAudioPlayer(self.s);p.push_frame=AsyncMock();self.c.playing_id="r"
        await p.process_frame(PreparedSpeechFrame("Пробег?",b'\0\0'*640,"r"),FrameDirection.DOWNSTREAM)
        frames=[c.args[0] for c in p.push_frame.call_args_list]
        self.assertIsInstance(frames[0],TTSStartedFrame);self.assertFalse(frames[0].append_to_context)
        self.assertEqual(b''.join(f.audio for f in frames if isinstance(f,OutputAudioRawFrame)),b'\0\0'*640)
        self.assertIsInstance(frames[-1],TTSStoppedFrame)

    async def test_backchannel_ack_preserves_question_and_excludes_main_latency(self):
        e=self.s.evidence;m=e.memory;m.open_question={"text":"Пробег?"}
        v=VoxSerializer(self.s,SimpleNamespace(send_text=AsyncMock()))
        tag=self.s.playback.begin();self.s.playback.seal();v.tag_responses[tag]="bc"
        e.delivery.segment(tag,"bc");e.delivery.response("bc").update(kind="backchannel",generated_done=True,tts_done=True)
        await v.deserialize(json.dumps({"customEvent":"playback","action":"started","tag":tag}))
        await v.deserialize(json.dumps({"customEvent":"playback","action":"ended","tag":tag}))
        self.assertEqual(m.open_question['text'],'Пробег?')
        self.assertFalse(any(r['event']=='speech_to_playback_ms' for r in e.events))

    async def test_controller_suppresses_unrequested_native_generations(self):
        llm=GatedRealtime(self.s,self.monitor,api_key="test")
        from pipecat.services.openai.realtime import events
        with patch.object(GatedRealtime.__bases__[0],'send_client_event',new=AsyncMock()) as sent:
            await llm.send_client_event(events.ResponseCreateEvent())
            sent.assert_not_awaited()

    async def test_auto_generation_cannot_open_phantom_response_before_gate(self):
        llm=GatedRealtime(self.s,self.monitor,api_key="test");llm.has_user_commit=True
        with patch.object(GatedRealtime.__bases__[0],'_create_response',new=AsyncMock()) as create:
            await llm._create_response()
            create.assert_not_awaited()
        self.assertFalse(llm._response_active)

    async def test_mirrored_assistant_item_does_not_open_phantom_speech_turn(self):
        llm=GatedRealtime(self.s,self.monitor,api_key="test")
        from pipecat.services.openai.realtime import events
        item=events.ConversationItem(type="message",role="assistant",content=[events.ItemContent(type="output_text",text="Пробег?")])
        llm._messages_added_manually[item.id]=True
        llm._call_event_handler=AsyncMock();llm.push_frame=AsyncMock()
        await llm._handle_evt_conversation_item_added(SimpleNamespace(item=item))
        llm.push_frame.assert_not_awaited()


class AudioTests(unittest.TestCase):
    def test_business_hours_without_ampm_end_in_the_evening(self):
        for text,end in [('Мы работаем с восьми до восьми.',1200),('С девяти до девяти.',1260),('С 10 до 8.',1200)]:
            with self.subTest(text=text):
                v=VisitProposal();v.update(text,1)
                self.assertEqual(v.time['interval_end'],end)
                self.assertEqual(v.time['source'],'client_choice_from_manager_interval')
    def test_custom_question_preserves_conditions_and_numbers(self):
        question='Будет ли скидка 7 процентов при оплате наличными?'
        self.assertIn(question.casefold(),spoken_question(question).casefold())
        polite='Подскажите, пожалуйста, были ли ДТП с повреждением силовых элементов?'
        self.assertEqual(spoken_question(polite),polite)
        self.assertEqual(spoken_question('Были ли ДТП?'),'Подскажите, пожалуйста, были ли у машины ДТП?')

    def test_interval_minutes_are_not_misread_as_hour_and_cancellation_clears_offer(self):
        v=VisitProposal();v.update('Сегодня в 14:00-15:00.',1)
        self.assertEqual(v.proposal()['time']['value'],'в 14:00')
        v.offered=v.proposal();v.update('Сегодня не получится.',2)
        self.assertIsNone(v.offered);self.assertIsNone(v.proposal())

    def test_backchannel_edges_trimmed_without_cutting_speech_and_volume_lowered(self):
        pcm=array('h',[0]*1600+[2000]*3200+[0]*1600).tobytes()
        clipped=quiet_clip(pcm)
        self.assertLess(len(clipped),len(pcm))
        self.assertEqual(max(array('h',clipped)),1200)
        self.assertEqual(sum(v!=0 for v in array('h',clipped)),3200)
        self.assertEqual(quiet_clip(b'\0\0'*1600),b'')
