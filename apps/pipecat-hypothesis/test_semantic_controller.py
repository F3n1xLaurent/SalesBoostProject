import asyncio
import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock,Mock,patch

from conversation import ConversationMemory
from dialogue_controller import DialogueController
from semantic_controller import SemanticController
from pipeline import Turn,GatedRealtime
from policy import Evidence,Playback
from turn_meaning import interpret,payload,pick,acceptance_scope

PROMPT='1. Возможна доставка по области? [обязательная тема]\n2. Работаете в выходные? [обязательная тема]'


def meaning(**kwargs):
    return {'control':'continue','name':False,'subject':False,'other_questions':False,'next_question':False,
        'visit':'none','acceptance_scope':'other','coverage':{},**kwargs}


class SemanticTests(unittest.IsolatedAsyncioTestCase):
    async def test_vehicle_year_and_tradein_mileage_use_separate_known_sources(self):
        self.c.started=True
        self.s.context={'subjectTitle':'Toyota Land Cruiser Prado', 'subjectDescription':'Год выпуска: 2022. Пробег: 60005 км.',
            'customerNeed':'Могу сдать Весту 2018 года с пробегом 130000 км.'}
        await self.run_turn('Какой год автомобиля? У нас их несколько.',subject=True)
        self.assertTrue(self.c.last_meaning['other_questions'])
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertIn('2022',state['buyer_information']['selected_subject']['subjectDescription'])
        self.assertIn('130000',state['buyer_information']['provided_need'])
        self.c.player.queue_frame.assert_not_awaited()
        await self.run_turn('А какой пробег у вашей машины в trade-in?',other_questions=True)
        self.assertIn('trade-in',self.c.latest_input)
        self.assertIn('про неё',self.c.fallback_goal)

    async def test_day_choice_inside_opening_hours_is_answered_with_a_proposal_not_a_counterquestion(self):
        self.c.started=True
        class Afternoon(datetime):
            @classmethod
            def now(cls,tz=None):return cls(2026,11,24,14,30,tzinfo=tz)
        with patch('semantic_controller.datetime',Afternoon),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Мы работаем с восьми до восьми. Вы подъедете сегодня или завтра?',
                visit='offer',visit_request='details',transfer_reply=True)
        self.assertFalse(self.c.last_meaning['transfer_reply'])
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,'Могу подъехать сегодня, в 15:00. Подойдёт?')
        self.assertFalse(self.c.visit_confirmed)

    async def test_open_beneficiary_question_is_not_a_yes_no_confirmation(self):
        self.c.started=True
        await self.run_turn('Алло, для кого выбираете автомобиль?',confirmation_request=True)
        self.assertFalse(self.c.last_meaning['confirmation_request'])
        self.assertTrue(self.c.last_meaning['other_questions'])
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertFalse(state['confirmation_requested'])
    async def test_initial_name_question_uses_prepared_voice_without_two_model_roundtrips(self):
        self.c.opening_sent=False;self.c.started=False
        with patch('semantic_controller.interpret',new=AsyncMock()) as interpret_name:
            await self.c.handle('Алло, вас не слышно. Подскажите, пожалуйста, как я могу к вам обращаться?',1,self.c.epoch)
        interpret_name.assert_not_awaited()
        self.assertIn('Меня зовут Андрей',self.c.player.queue_frame.call_args.args[0].text)
        self.assertFalse(self.c.opening_sent)
        self.assertNotIn('интересует',self.c.player.queue_frame.call_args.args[0].text)
    async def test_false_transfer_cannot_mute_ordinary_status_payment_or_visit_questions(self):
        self.c.started=True
        for text in ('Как физическое лицо или от организации?', 'Покупку планируете в кредит или за наличные?'):
            await self.run_turn(text,transfer_reply=True,other_questions=True)
            self.assertFalse(self.c.last_meaning['transfer_reply'])
            self.assertNotEqual(self.c.pending_after_native[0],'wait_transfer')
            self.assertTrue(self.c.line.can_speak)

    async def test_confirmed_visit_with_payment_question_does_not_reenter_transfer_or_booking(self):
        self.c.answers={key:{} for key in self.keys};await self.offer()
        await self.run_turn('Ждём вас завтра в три часа дня. Покупку планируете в кредит или за наличные?',
            visit='accept',acceptance_scope='explicit_visit',other_questions=True,transfer_reply=True)
        self.assertTrue(self.c.visit_confirmed)
        self.assertFalse(self.c.last_meaning['transfer_reply'])
        self.assertNotEqual(self.c.pending_after_native[0],'wait_transfer')
        self.c.llm.spoken_text['payment']='Планирую покупку в кредит.'
        ledger=self.s.evidence.delivery
        ledger.response('payment').update(generated_done=True,tts_done=True)
        ledger.segment('payment-tag','payment');ledger.ack('payment-tag')
        await self.c.fallback_done('payment');await asyncio.sleep(.05)
        self.assertTrue(self.c.visit_confirmed)
        self.assertTrue(all('Могу подъехать' not in call.args[0].text for call in self.c.player.queue_frame.call_args_list))

    async def test_native_question_remains_buffered_until_answer_is_phone_confirmed(self):
        self.c.started=True
        self.c.inputs.add('В какой срок планируете покупку?',1)
        batch=self.c.inputs.snapshot()
        with patch('semantic_controller.interpret',new=AsyncMock(return_value=meaning(other_questions=True))):
            self.c.receive_batch(batch)
            await self.c.task
        self.assertEqual(self.c.inputs.snapshot(),batch)
        self.c.llm.spoken_text['native']='Планирую в течение недели.'
        ledger=self.s.evidence.delivery
        ledger.response('native').update(generated_done=True,tts_done=True)
        ledger.segment('native-tag','native')
        await self.c.fallback_done('native');await asyncio.sleep(.03)
        self.assertEqual(self.c.inputs.snapshot(),batch)
        ledger.ack('native-tag');await asyncio.sleep(.05)
        self.assertEqual(self.c.inputs.snapshot(),[])

    async def test_afternoon_opening_hours_allow_a_future_visit_instead_of_past_clock_error(self):
        self.c.started=True;self.c.visit.update('Сегодня.',1)
        self.c.visit=self.c.candidate('Как вам удобно, мы работаем с восьми до восьми.',2)
        class Afternoon(datetime):
            @classmethod
            def now(cls,tz=None):return cls(2026,11,24,14,30,tzinfo=tz)
        with patch('semantic_controller.datetime',Afternoon):
            self.assertTrue(self.c.future_visit())
        self.assertEqual(self.c.visit.time['value'],'в 15:00')

    async def asyncSetUp(self):
        name=patch('semantic_controller.choose_name',return_value='Андрей');name.start();self.addCleanup(name.stop)
        self.s=SimpleNamespace(prompt=PROMPT,context={'subjectTitle':'Тестовый объект'},backchannel=True,
            tts_model='eleven_v4_turbo',voice_id='test',evidence=Evidence(),playback=Playback(),
            finalized=False,status='connected',dialogue_mode='semantic')
        self.s.prepared_purpose='purchase'
        self.s.evidence.memory=ConversationMemory(PROMPT);self.s.evidence.memory.semantic_mode=True
        self.s.evidence.turn=self.s.evidence.output_turn=1
        self.monitor=SimpleNamespace(turn=Turn(False,number=1),segment_start=None)
        self.c=SemanticController(self.s,SimpleNamespace(queue_cleared_event=asyncio.Event(),send=AsyncMock()),self.monitor)
        # These tests exercise business dialogue after line verification.
        self.c.line.state='live';self.c.line.ever_human=True
        self.c.opening_sent=True
        review=patch('semantic_controller.review_acceptance',new=AsyncMock(return_value=False))
        review.start();self.addCleanup(review.stop)
        self.s.controller=self.c
        self.c.llm=SimpleNamespace(response_id=None,response_items={},spoken_text={},wire_active=None,wire_pending=None,
            request_turns=[],_messages_added_manually={},send_client_event=AsyncMock(),broadcast_frame=AsyncMock(),user_speaking=False)
        self.c.player=SimpleNamespace(queue_frame=AsyncMock())
        texts={r['key']:r['question'] for r in self.s.evidence.memory.topics.required}
        self.keys=list(texts)
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=texts)),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\xd0\x07'*1600)):
            await self.c.prepare()

    async def asyncTearDown(self):await self.c.close()

    async def test_service_context_keeps_owned_vehicle_and_disables_purchase_preference(self):
        self.s.prepared_purpose='service';self.s.context={'subjectTitle':'Zeekr 8X','customerNeed':'Установить защиту заднего двигателя.'}
        await self.run_turn('Вас интересует сервисное обслуживание или кузовной ремонт?',other_questions=True)
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertEqual(state['SCENARIO_SCOPE']['purpose'],'service')
        self.assertIsNone(state['buyer_information']['default_condition_preference'])
        self.assertIn('Не предлагай купить его',self.c.fallback_goal)
        self.assertEqual(payload(self.c,self.c.latest_input)['state']['roles']['call_purpose'],'service')

    async def test_subject_question_without_selection_is_answered_from_need_before_advancing(self):
        self.s.context={'subjectTitle':None,'subjectDescription':None,'customerNeed':'Интересует Volkswagen Touareg 2019, пробег 104 060 км.'}
        self.c.texts.pop('subject',None)
        self.c.started=True
        await self.run_turn('Как к вам обращаться и какой автомобиль вас интересует?',name=True,subject=True)
        self.assertTrue(self.c.last_meaning['other_questions'])
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertEqual(state['buyer_information']['provided_need'],self.s.context['customerNeed'])
        self.assertEqual(state['buyer_information']['selected_subject'],{})
        self.assertIn('name',state['requested_answers'])
        self.assertIn('selected_subject',self.c.fallback_goal)
        self.assertIn('provided_need',self.c.fallback_goal)
        self.c.llm.send_client_event.assert_awaited()
        self.assertFalse(self.c.asked)

    async def test_native_answer_receives_subject_from_script_even_when_need_has_only_payment(self):
        self.s.context={'subjectTitle':None,'subjectDescription':None,'customerNeed':'Покупка в кредит. Цвет чёрный.'}
        self.s.evidence.memory.topics.required=[{'key':'custom:0','question':'Toyota RAV4 2018года ещё в продаже?'}]
        self.c.texts.pop('subject',None)
        await self.run_turn('Автомобиль новый? Какую модель рассматриваете?',subject=True,other_questions=True)
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertIn('Toyota RAV4 2018',state['SCENARIO_SCOPE']['script_references'][0])
        self.assertIn('Цвет чёрный',state['SCENARIO_SCOPE']['need'])
        self.assertIn('SCENARIO_SCOPE имеет приоритет',self.c.fallback_goal)

    async def test_branch_address_request_uses_known_location_before_plan_questions(self):
        self.s.context['targetLocation']={'name':'Тестовый салон','city':'Москва','address':'ш. Энтузиастов, д. 12А'}
        await self.run_turn('Уточните номер объявления или адрес салона, где стоит автомобиль, я вас соединю.',other_questions=True)
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertEqual(state['target_location']['address'],'ш. Энтузиастов, д. 12А')
        self.assertEqual(payload(self.c,self.c.latest_input)['state']['target_location'],state['target_location'])
        self.assertIn('target_location.address',self.c.fallback_goal)
        self.assertFalse(self.c.asked)
        self.c.llm.send_client_event.assert_awaited()

    async def test_geography_comes_from_target_city_not_free_customer_legend(self):
        self.s.context['targetLocation']={'name':'Солонцы','city':'Красноярск','address':'п. Солонцы, пр-кт Котельникова, стр. 11/5'}
        self.c.customer_legend=[{'response_id':'old','question':'Откуда вы?','text':'Я из Москвы.'}]
        await self.run_turn('А вы сами территориально где находитесь?',other_questions=True)
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertEqual(state['target_location']['city'],'Красноярск')
        self.assertIn('География клиента не является свободной легендой',self.c.fallback_goal)
        self.assertIn('ранее ошибочно созданной легенды',self.c.fallback_goal)

    async def test_short_opening_greetings_preserve_audio_but_real_questions_interrupt(self):
        self.c.opening_sent=False
        await self.c.speak('opening')
        turn=Turn(True,400,question=dict(self.c.last_question))
        for text in ('Алло.', 'Здрасьте', 'Здравствуйте, Андрей.'):
            self.assertTrue(self.c.ignores_opening_greeting(text,turn))
        for text in ('Стоп.', 'Алло, вас не слышно.', 'Новый или с пробегом?'):
            self.assertFalse(self.c.ignores_opening_greeting(text,turn))
        turn.interrupted=True
        self.assertFalse(self.c.ignores_opening_greeting('Алло.',turn))
        turn.interrupted=False;turn.overlap=False
        self.assertFalse(self.c.ignores_opening_greeting('Алло.',turn))
        turn.overlap=True;turn.question={'topic':'discount','response_id':'other'}
        self.assertFalse(self.c.ignores_opening_greeting('Алло.',turn))

    async def test_opening_greeting_transcript_does_not_clear_playback_or_restart_controller(self):
        self.c.opening_sent=False
        await self.c.speak('opening')
        turn=Turn(True,400,number=1,question=dict(self.c.last_question))
        self.monitor.turn=turn;self.s.playback.pending.add('opening-audio')
        self.c.receive=Mock()
        llm=GatedRealtime(self.s,self.monitor,api_key='test')
        llm.items['greeting']=(turn,True)
        llm._handle_interruption=AsyncMock();llm.broadcast_frame=AsyncMock()
        await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id='greeting',transcript='Алло.'))
        self.c.receive.assert_not_called()
        llm._handle_interruption.assert_not_awaited();llm.broadcast_frame.assert_not_awaited()
        self.assertIn('opening-audio',self.s.playback.pending)
        self.assertTrue(any(e['event']=='opening_greeting_overlap_ignored' for e in self.s.evidence.events))

    async def test_verified_script_subject_is_prepared_for_opening_and_direct_replies(self):
        self.s.context={'subjectTitle':None,'subjectDescription':None}
        async def prepared(*args,**kwargs):
            self.s.prepared_subject='Toyota RAV4 2018'
            self.s.prepared_spoken_subject='Toyota RAV4'
            return {r['key']:r['question'] for r in self.s.evidence.memory.topics.required}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(side_effect=prepared)),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.c.prepare()
        self.assertIn('Toyota RAV4',self.c.texts['opening'])
        self.assertIn('Toyota RAV4',self.c.texts['subject'])
        self.assertNotIn('2018',self.c.texts['opening'])

    async def test_1361_verified_title_subject_is_named_when_operator_asks_model(self):
        self.s.context={}
        self.s.prompt='Название скрипта (справочный источник): "Москвич 3, 2024 года"\nПотребность клиента: Покупка для жены, наличные.'
        async def prepared(*args,**kwargs):
            self.s.prepared_subject='Москвич 3, 2024 года'
            self.s.prepared_spoken_subject='Москвич 3'
            return {r['key']:r['question'] for r in self.s.evidence.memory.topics.required}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(side_effect=prepared)),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.c.prepare()
        self.assertIn('Москвич 3',self.c.texts['opening'])
        self.assertNotIn('2024 года',self.c.texts['opening'])
        await self.run_turn('Какую марку и модель рассматриваете?',subject=True)
        answer=self.c.player.queue_frame.call_args.args[0].text
        self.assertIn('Москвич 3',answer)
        self.assertNotIn('2024 года',answer)

    async def test_named_sale_question_opens_with_the_model_even_without_extraction(self):
        self.s.prompt='Потребность клиента: Покупка в кредит\n\n1. Toyota RAV4 2018года ещё в продаже? [обязательная тема]'
        self.s.context={};self.s.evidence.memory=ConversationMemory(self.s.prompt)
        self.assertEqual(self.s.evidence.memory.topics.required[0]['key'],'availability')
        wording={'availability':'Подскажите, Toyota RAV4 2018года ещё в продаже?'}
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=wording)),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.c.prepare()
        self.assertIn('Toyota RAV4 2018',self.c.texts['opening'])

    async def test_explicit_subject_repetition_allows_generated_need_answer(self):
        self.s.context={'customerNeed':'Нужен Volkswagen Touareg 2019.'}
        self.c.texts.pop('subject',None);self.c.last_meaning=meaning(subject=True)
        answer='Меня интересует Volkswagen Touareg две тысячи девятнадцатого года.'
        self.assertEqual(self.c.approve_speech_sentence(answer,'first'),answer)
        self.assertEqual(self.c.approve_speech_sentence(answer,'repeat'),answer)
        self.c.last_meaning=meaning()
        self.assertEqual(self.c.approve_speech_sentence(answer,'unrequested-repeat'),'')

    async def test_need_based_opening_reuses_prepared_subject_question(self):
        self.s.context={'subjectTitle':None,'customerNeed':'Нужен Volkswagen Touareg 2019.'}
        rows=[{'key':'availability','question':'Звоню по Volkswagen Touareg 2019. Ещё в наличии?'}]
        self.s.evidence.memory.topics.required=rows
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value={'availability':rows[0]['question']})),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.c.prepare()
        self.assertIn('Volkswagen Touareg 2019',self.c.texts['opening'])
        self.assertEqual(self.c.texts['opening'].count('?'),1)
        self.assertEqual(self.c.texts['opening'].count('Здравствуйте'),1)

    async def test_short_greeting_opens_from_prepared_audio_without_decisions(self):
        self.c.opening_sent=False;self.c.line.state='awaiting_person';self.c.line.ever_human=False
        with patch('semantic_controller.interpret',new=AsyncMock()) as interpret:
            await self.c.handle('Hello?',1,self.c.epoch)
        interpret.assert_not_awaited()
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['opening'])
        self.assertTrue(self.c.opening_sent)
        self.assertEqual(self.s.evidence.memory.phase,'dialogue')

    async def test_interrupted_native_first_answer_does_not_lose_opening(self):
        self.c.started=True;self.c.opening_sent=False
        await self.run_turn('По какому вопросу звоните?')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['opening'])
        self.assertEqual(self.c.last_question['topic'],'availability')

    async def test_connection_repair_before_opening_says_purpose_not_empty_resume(self):
        self.c.started=True;self.c.opening_sent=False
        await self.run_turn('Вы на связи?',control='attention')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['opening'])

    async def test_native_first_answer_has_continuation_until_opening_is_asked(self):
        self.c.opening_sent=False
        await self.run_turn('Для чего вам автомобиль?',other_questions=True)
        self.assertEqual(self.c.pending_after_native[0],'open')

    async def test_first_native_answer_greets_before_need_and_does_not_restart_opening(self):
        self.c.opening_sent=False
        await self.run_turn('Здравствуйте, отдел продаж. Чем могу помочь? Алло.',subject=True,other_questions=True)
        identifier='first-answer'
        answer=self.c.approve_speech_sentence('Меня интересует Тестовый объект.',identifier)
        self.assertEqual(answer,'Здравствуйте! Меня интересует Тестовый объект.')
        self.assertNotIn('Здравствуйте',self.c.approve_speech_sentence('Рассматриваю покупку в кредит.',identifier))
        delivery=self.s.evidence.delivery
        delivery.segment('first-tag',identifier);delivery.ack('first-tag')
        delivery.response(identifier).update(generated_done=True,tts_done=True)
        self.c.native_resume_context={'response_id':identifier,'text':answer,'epoch':self.c.epoch}
        await self.c.perform('open','',self.c.epoch)
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertEqual(frame.text,'Машина ещё продаётся?')
        self.assertTrue(self.c.opening_sent)
        self.assertEqual(self.c.last_question['topic'],'availability')
        self.assertIn('plan:availability',self.c.question_ledger)

    async def test_initial_native_answer_keeps_generated_greeting_once(self):
        self.c.opening_sent=False
        self.assertEqual(self.c.approve_speech_sentence('Здравствуйте! Меня интересует машина.','first'),
            'Здравствуйте! Меня интересует машина.')

    async def test_initial_payment_answer_does_not_lose_subject_in_followup(self):
        self.c.opening_sent=False
        identifier='payment-first'
        answer=self.c.approve_speech_sentence('Планирую покупку в кредит.',identifier)
        delivery=self.s.evidence.delivery
        delivery.segment('payment-tag',identifier);delivery.ack('payment-tag')
        delivery.response(identifier).update(generated_done=True,tts_done=True)
        self.c.native_resume_context={'response_id':identifier,'text':answer,'epoch':self.c.epoch}
        await self.c.perform('open','',self.c.epoch)
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIn('автомобиль',frame.text)
        self.assertNotIn('Здравствуйте',frame.text)
        self.assertEqual(self.c.last_question['topic'],'availability')

    async def test_existing_availability_answer_does_not_trigger_missing_opening(self):
        self.c.started=True;self.c.opening_sent=False;self.c.answers['availability']={'status':'answered'}
        await self.run_turn('Вы на связи?',control='attention')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['resume'])

    async def test_purpose_answer_restores_interrupted_opening_question_once(self):
        self.c.started=True;self.c.opening_sent=False
        await self.c.speak('opening')
        original=self.c.last_question['response_id']
        self.s.evidence.delivery.response(original)['interrupted']=True
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Зачем звоните?',subject=True)
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIn(self.c.texts['subject'],frame.text)
        self.assertEqual(frame.text.count('?'),1)
        self.assertEqual(self.c.asked['availability'],1)
        self.assertIn('plan:availability',self.c.auto_replayed_questions)

    def test_direct_binding_groups_two_compatible_scope_labels(self):
        state={'active_visit_response_id':'offer','last_assistant_response_id':'offer','last_question':{'response_id':'offer'}}
        row={'choice':'explicit_visit','probabilities':{'explicit_visit':.7953,'direct_reply':.1775,'other':.0272}}
        self.assertEqual(acceptance_scope({'acceptance_scope':row},state),'direct_reply')
        state['last_assistant_response_id']='different'
        self.assertEqual(acceptance_scope({'acceptance_scope':row},state),'other')
        row['probabilities']={'explicit_visit':.4,'direct_reply':.2,'other':.4}
        self.assertEqual(acceptance_scope({'acceptance_scope':row},state),'other')

    async def test_first_confirmation_with_split_scope_finishes_without_extra_question(self):
        self.c.answers={key:{} for key in self.keys};await self.offer()
        state=payload(self.c,'Да, отлично. Будем вас ждать.')['state']
        scope=acceptance_scope({'acceptance_scope':{'choice':'explicit_visit','probabilities':{'explicit_visit':.7953,'direct_reply':.1775,'other':.0272}}},state)
        await self.run_turn('Да, отлично. Будем вас ждать.',visit='accept',acceptance_scope=scope)
        self.assertTrue(self.c.visit_confirmed);self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_farewell'])

    async def test_ambiguous_binding_review_can_confirm_only_existing_proposal(self):
        self.c.answers={key:{} for key in self.keys};await self.offer()
        with patch('semantic_controller.review_acceptance',new=AsyncMock(return_value=True)) as review:
            await self.run_turn('Договорённость подтверждаю.',visit='accept',acceptance_scope='other')
        review.assert_awaited_once();self.assertTrue(self.c.visit_confirmed)
        self.assertEqual(self.s.evidence.memory.closing_reason,'visit_agreed')

    async def test_inconclusive_binding_is_audible_without_invented_conditions(self):
        self.c.answers={key:{} for key in self.keys};await self.offer()
        await self.run_turn('Требуется разъяснение.',visit='unclear')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['receipt_0'])
        self.assertFalse(self.c.visit_confirmed);self.assertFalse(self.s.playback.finish_requested)
        self.assertFalse(hasattr(self.c.llm,'request_reason'))

    async def test_turn_wait_starts_only_after_committed_nonoverlap_turn(self):
        self.c.started=True;self.c.thinking.delay_ms=500
        self.c.on_turn_committed(Turn(True,number=1))
        self.assertIsNone(self.c.thinking.current)
        self.c.on_turn_committed(Turn(False,number=1))
        job=self.c.thinking.current;self.assertEqual(job['source'],'turn_wait')
        self.c.thinking.arm('semantic_interpretation');self.assertIs(self.c.thinking.current,job)

    async def test_status_cannot_repeat_four_times(self):
        for _ in range(4):await self.c.prepared(['visit_pending'])
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertTrue(any(e['event']=='speech_repeat_blocked' for e in self.s.evidence.events))

    async def test_name_confirmation_does_not_repeat_introduction_or_lose_next_question(self):
        self.c.started=True;await self.run_turn('Назовите себя',name=True)
        first=self.c.player.queue_frame.call_args.args[0].text
        self.assertIn(self.c.texts['name'],first)
        await self.run_turn('Верно расслышал имя? Ответ на первый вопрос.',name_confirmation=True,
            coverage={self.keys[0]:'answered'})
        answer=self.c.player.queue_frame.call_args.args[0].text
        self.assertNotIn(self.c.texts['name'],answer)
        self.assertIn(self.c.texts['identity_ack'],answer)
        self.assertIn(self.c.texts[self.keys[1]],answer)

    async def test_name_value_requested_again_is_spoken_again_not_replaced_by_ack(self):
        self.c.started=True
        for _ in range(3):await self.run_turn('Как к вам обращаться?',name=True)
        replies=[c.args[0].text for c in self.c.player.queue_frame.call_args_list]
        self.assertEqual(replies,[self.c.texts['name']]*3)
        self.assertEqual(sum(e['event']=='speech_repeat_authorized' for e in self.s.evidence.events),2)

    async def test_name_request_after_farewell_is_audible_and_finishes_on_its_ack(self):
        await self.c.speak('name')
        target=await self.start_farewell()
        self.s.evidence.delivery.response(target)['interrupted']=True;self.s.playback.interrupt()
        await self.c.new_input();self.c.player.queue_frame.reset_mock()
        await self.run_turn('Ещё подскажите ваше имя',name=True)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['name'])
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.s.finish_response_id,self.c.last_clip['response_id'])

    async def test_requested_native_name_repetition_does_not_allow_status_repetition(self):
        self.c.approve_speech_sentence(self.c.texts['name'],'initial')
        self.c.approve_speech_sentence(self.c.texts['visit_pending'],'status')
        self.c.name_repeat_requested=True
        self.assertEqual(self.c.approve_speech_sentence(self.c.texts['name'],'repeat'),self.c.texts['name'])
        self.assertFalse(self.c.approve_speech_sentence(self.c.texts['visit_pending'],'repeat'))
        await self.c.new_input()
        self.assertFalse(self.c.approve_speech_sentence(self.c.texts['name'],'unsolicited'))

    def test_named_opening_contains_exact_separate_name_audio(self):
        name=next(p for p in self.c.clip_components['named_opening'] if p['key']=='name')
        start=int(name['offset_ms']*32);size=int(name['duration_ms']*32)
        self.assertEqual(self.c.clips['named_opening'][start:start+size],self.c.clips['name'])

    async def test_stt_recovery_notice_preserves_verified_fragments_and_question_anchor(self):
        await self.offer()
        reference=dict(self.c.last_question);clip=self.c.last_clip
        row={'text':'Да, будем ждать.','turn':1,'question':reference}
        self.c.inputs.add(row['text'],1,reference);self.c.active_batch=[row]
        self.c.llm.send_client_event.reset_mock()
        await self.c.on_stt_recovery(Turn(False,number=2))
        self.assertEqual(self.c.inputs.snapshot(),[row])
        self.assertEqual(self.c.last_question,reference);self.assertIs(self.c.last_clip,clip)
        self.assertFalse(self.s.playback.finish_requested)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['stt_repair'])
        self.c.llm.send_client_event.assert_not_awaited()

    async def test_stt_recovery_notice_waits_for_person_to_finish(self):
        self.c.llm.user_speaking=True
        await self.c.on_stt_recovery(Turn(False,number=2))
        self.c.player.queue_frame.assert_not_awaited()
        self.assertFalse(self.s.playback.finish_requested)

    async def test_daypart_qualifier_is_not_lost_and_rejected_as_changed_time(self):
        self.c.visit.update('Приезжайте завтра в три часа дня.',1)
        self.assertEqual(self.c.visit.time['value'],'в три часа дня')
        self.c.visit.offered=self.c.visit.proposal();self.c.visit_offer_response_id='offer'
        self.c.last_question={'response_id':'offer'};self.c.last_clip={'response_id':'offer'}
        self.assertTrue(self.c.accept_active('Да, ждём завтра в три часа дня.',2,{'acceptance_scope':'direct_reply'}))

    async def test_native_introduction_also_blocks_prepared_reintroduction(self):
        self.c.approve_speech_sentence('Меня зовут Андрей.','native')
        await self.c.prepared(['name',self.keys[0]])
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[self.keys[0]])

    async def test_prepared_status_also_blocks_native_duplicate(self):
        await self.c.prepared(['visit_pending'])
        self.assertFalse(self.c.approve_speech_sentence(self.c.texts['visit_pending'],'native'))

    async def test_visit_question_answers_saved_slot_without_review_or_reasking(self):
        await self.offer()
        question_count=dict(self.c.asked)
        with patch('semantic_controller.review_acceptance',new=AsyncMock()) as review,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\xd0\x07'*1600)):
            await self.run_turn('Какое время?',visit='unclear',visit_request='details')
            await self.run_turn('Когда вам удобно?',visit='unclear',visit_request='details')
        review.assert_not_awaited()
        replies=[c.args[0].text for c in self.c.player.queue_frame.call_args_list]
        self.assertEqual(len(replies),2);self.assertTrue(all('Мне удобно завтра' in t and '?' not in t for t in replies))
        self.assertFalse(self.c.visit_confirmed);self.assertEqual(self.c.asked,question_count)

    async def test_duplicate_farewell_finishes_on_last_actual_reply_instead_of_replaying(self):
        self.c.started=True
        await self.c.prepared(['visit_farewell'],closing=True)
        await self.c.speak('resume')
        last=self.c.last_clip['response_id'];self.s.playback.finish_requested=False
        self.c.player.queue_frame.reset_mock()
        await self.c.prepared(['visit_farewell'],closing=True)
        self.c.player.queue_frame.assert_not_awaited()
        self.assertTrue(self.s.playback.finish_requested);self.assertEqual(self.s.finish_response_id,last)

    async def test_slow_interpretation_does_not_emit_wait_before_meaning(self):
        self.c.started=True;self.c.thinking.delay_ms=self.c.thinking.semantic_delay_ms=5
        async def slow(*args):
            await asyncio.sleep(.025)
            return meaning(next_question=True)
        with patch('semantic_controller.interpret',new=slow):await self.c.handle('Можно дальше',1,self.c.epoch)
        frames=[call.args[0] for call in self.c.player.queue_frame.call_args_list]
        self.assertEqual(len(frames),1)
        self.assertEqual(frames[0].text,self.c.texts[self.keys[0]])
        self.assertIsNone(self.c.thinking.current)

    async def test_next_question_invitation_uses_one_prepared_question_without_llm(self):
        self.c.started=True
        await self.run_turn('Приглашение продолжить вопросы',next_question=True)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[self.keys[0]])
        self.c.llm.send_client_event.assert_awaited_once()
        self.assertFalse(hasattr(self.c.llm,'request_reason'))

    async def test_general_visit_invitation_defers_scheduling_until_plan_questions(self):
        self.c.started=True
        await self.run_turn('Можете приехать посмотреть.',visit='offer')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[self.keys[0]])
        self.assertFalse(hasattr(self.c.llm,'request_reason'))
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_unscheduled_visit_condition_does_not_add_an_unrelated_question(self):
        self.c.started=True
        await self.run_turn('Условия можно обсудить при осмотре.',visit='conditional')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[self.keys[0]])
        self.assertFalse(hasattr(self.c.llm,'request_reason'))
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_unscheduled_visit_after_plan_uses_one_prepared_clarification(self):
        self.c.started=True;self.c.answers={key:{} for key in self.keys}
        await self.run_turn('Есть возможность осмотра.',visit='offer')
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['clarify_day'])
        self.assertFalse(hasattr(self.c.llm,'request_reason'))

    async def test_answer_with_attention_check_advances_instead_of_connection_only(self):
        self.c.started=True;await self.c.speak(self.keys[0]);self.c.player.queue_frame.reset_mock()
        await self.run_turn('Ответ получен, вы слышали?',control='attention',coverage={self.keys[0]:'answered'})
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIn(self.c.texts[self.keys[1]],frame.text)
        self.assertEqual(frame.text.count('?'),1)
        self.assertIn(self.keys[0],self.c.answers)

    async def test_unresolved_complete_reply_can_progress_without_inventing_answer(self):
        self.c.started=True;await self.c.speak(self.keys[0]);self.c.player.queue_frame.reset_mock()
        await self.run_turn('Полная, но искажённая транскрипция ответа.')
        self.assertIn(self.c.texts[self.keys[1]],self.c.player.queue_frame.call_args.args[0].text)
        self.assertNotIn(self.keys[0],self.c.answers)
        self.assertEqual(self.c.asked[self.keys[0]],1)

    async def test_fragment_does_not_exhaust_a_waiting_question(self):
        self.c.started=True;await self.c.speak(self.keys[0]);self.c.player.queue_frame.reset_mock()
        await self.run_turn('Продолжение следует',control='fragment')
        self.c.player.queue_frame.assert_not_awaited();self.assertNotIn(self.keys[0],self.c.answers)

    async def test_voice_answer_does_not_receive_whole_plan_or_permission_to_ask(self):
        self.c.started=True
        await self.run_turn('Сколько вам лет и зачем вам товар?',other_questions=True)
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertNotIn('pending',state);self.assertNotIn('question_catalog',state)
        self.assertNotIn(self.c.texts[self.keys[1]],self.c.context_text())
        self.assertEqual(self.c.native_question_policy,'answer_only')
        self.c.native_questions.classify=AsyncMock()
        self.assertIsNone(await self.c.native_questions.authorize('Какая гарантия?', 'native',self.c.epoch))
        self.c.native_questions.classify.assert_not_awaited()

    async def test_prepared_utterance_cannot_contain_two_questions(self):
        with self.assertRaises(ValueError):await self.c.prepared(self.keys)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_request_scope_distinguishes_plan_navigation_from_real_buyer_questions(self):
        body=payload(self.c,'Текст')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        for scope,other in [('plan_only',False),('both',True)]:
            answers['other_questions']={'choice':scope,'probabilities':{scope:.95,'no':.05}}
            answers['plan_permission']={'choice':'yes','probabilities':{'yes':.99,'no':.01}}
            with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,'Текст')
            self.assertEqual(result['other_questions'],other);self.assertTrue(result['next_question'])

    async def run_turn(self,text,**kwargs):
        self.s.evidence.memory.user(text,self.s.evidence.turn)
        with patch('semantic_controller.interpret',new=AsyncMock(return_value=meaning(**kwargs))) as model:
            await self.c.handle(text,self.s.evidence.turn,self.c.epoch)
        model.assert_awaited_once()

    async def offer(self):
        self.c.started=True;self.c.visit.update('Завтра после обеда.',1)
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.c.ask_visit(self.c.visit.proposal())
        self.c.player.queue_frame.reset_mock()

    async def interrupted_plan(self):
        self.c.started=True
        topic=self.keys[-1]
        await self.c.speak(topic)
        original=self.c.last_question['response_id']
        self.s.evidence.delivery.response(original)['interrupted']=True
        self.c.player.queue_frame.reset_mock()
        return topic,original

    async def test_recall_older_interrupted_question_after_visit_confirmation(self):
        topic,original=await self.interrupted_plan()
        self.c.answers={key:{} for key in self.keys if key!=topic}
        await self.offer()
        await self.run_turn('Да, удобно. Вы хотели что-то уточнить?',visit='accept',
            acceptance_scope='direct_reply',question_recall='plan:'+topic,next_question=True)
        self.assertTrue(self.c.visit_confirmed)
        self.assertFalse(self.s.playback.finish_requested)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[topic])
        self.assertEqual(self.c.asked[topic],1)
        replacement=self.c.last_question['response_id']
        self.assertNotEqual(replacement,original)
        self.assertEqual(self.c.question_ledger['plan:'+topic]['response_id'],replacement)
        await self.run_turn('Ответ на вопрос.',coverage={topic:'answered'})
        self.assertTrue(self.s.playback.finish_requested)

    async def test_advance_restores_unanswered_interruption_before_farewell(self):
        topic,original=await self.interrupted_plan()
        self.c.answers={key:{} for key in self.keys if key!=topic}
        await self.offer()
        await self.run_turn('Да, удобно.',visit='accept',acceptance_scope='direct_reply')
        self.assertFalse(self.s.playback.finish_requested)
        self.assertEqual(self.c.last_question['topic'],topic)
        self.assertEqual(self.c.asked[topic],1)
        self.assertIn('plan:'+topic,self.c.auto_replayed_questions)
        await self.c.speak(topic)
        self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_interrupted_question_with_answer_is_not_automatically_repeated(self):
        topic,_=await self.interrupted_plan()
        self.c.answers={key:{} for key in self.keys}
        await self.offer()
        await self.run_turn('Да, удобно.',visit='accept',acceptance_scope='direct_reply')
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_farewell'])

    async def test_ordinary_queued_question_is_not_repeated_or_treated_as_delivered(self):
        self.c.started=True;await self.c.speak(self.keys[-1])
        self.c.answers={key:{} for key in self.keys[:-1]}
        await self.offer()
        await self.run_turn('Да, удобно.',visit='accept',acceptance_scope='direct_reply')
        self.assertFalse(self.s.playback.finish_requested)
        self.assertTrue(self.c.waiting)

    async def test_explicit_recall_can_repeat_again_but_automatic_retry_is_bounded(self):
        topic,_=await self.interrupted_plan()
        identity='plan:'+topic
        await self.c.replay_question(identity,explicit=False)
        retry=self.c.last_question['response_id']
        self.s.evidence.delivery.response(retry)['interrupted']=True
        await self.c.replay_question(identity,explicit=False)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        await self.c.replay_question(identity)
        self.assertEqual(self.c.player.queue_frame.await_count,2)
        self.assertEqual(self.c.asked[topic],1)

    async def test_twice_interrupted_credit_question_does_not_trigger_visit_farewell(self):
        topic,original=await self.interrupted_plan()
        self.c.answers={key:{} for key in self.keys if key!=topic}
        await self.c.replay_question('plan:'+topic,explicit=False)
        retry=self.c.last_question['response_id']
        self.s.evidence.delivery.response(retry)['interrupted']=True
        await self.offer()
        await self.run_turn('Да, удобно.',visit='accept',acceptance_scope='direct_reply')
        self.assertFalse(self.s.playback.finish_requested)
        self.assertTrue(self.c.waiting)
        self.assertFalse(any(call.args[0].text==self.c.texts['visit_farewell'] for call in self.c.player.queue_frame.call_args_list))

    async def exhausted_question(self):
        topic,_=await self.interrupted_plan()
        await self.c.replay_question('plan:'+topic,explicit=False)
        self.s.evidence.delivery.response(self.c.last_question['response_id'])['interrupted']=True
        self.c.player.queue_frame.reset_mock()
        return topic

    async def test_transfer_after_thank_you_resumes_exhausted_question_for_new_employee(self):
        topic=await self.exhausted_question()
        self.s.evidence.memory.facts['retained_fact']={'value':'known','turn':1}
        await self.run_turn('Спасибо за обращение, оставайтесь на линии, соединяем. Хорошего вам дня.',control='wait')
        self.assertEqual(self.c.line.state,'waiting_operator')
        self.c.player.queue_frame.assert_not_awaited()
        with patch('semantic_controller.interpret',new=AsyncMock()) as model:
            await self.c.handle('[music]',1,self.c.epoch)
        model.assert_not_awaited()
        await self.run_turn('Добрый день, сервис, слушаю вас.')
        self.assertTrue(self.c.line.can_speak)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.last_question['topic'],topic)
        self.assertNotIn('plan:'+topic,self.c.auto_replayed_questions)
        self.assertEqual(self.s.evidence.memory.facts['retained_fact']['value'],'known')
        self.assertFalse(self.s.playback.finish_requested)

    async def test_listening_invitation_repairs_exhausted_question_without_marking_answer(self):
        topic=await self.exhausted_question()
        await self.run_turn('Я вас внимательно слушаю.',listening_ready=True)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.last_question['topic'],topic)
        self.assertNotIn(topic,self.c.answers)
        self.assertEqual(self.c.asked[topic],1)
        self.assertIn('plan:'+topic,self.c.auto_replayed_questions)
        self.assertFalse(self.s.playback.finish_requested)

    async def test_connection_check_after_exhausted_retry_receives_acknowledgment(self):
        topic=await self.exhausted_question()
        await self.run_turn('Слышно меня?',control='attention')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['resume'])
        self.assertIn('plan:'+topic,self.c.auto_replayed_questions)
        self.assertNotIn(topic,self.c.answers)

    async def test_ordinary_acknowledgment_does_not_reset_replay_budget(self):
        topic=await self.exhausted_question()
        await self.run_turn('Угу.')
        self.c.player.queue_frame.assert_not_awaited()
        self.assertIn('plan:'+topic,self.c.auto_replayed_questions)
        self.assertTrue(self.c.waiting)

    async def test_deduplicating_greeting_preserves_opening_identity_and_interrupted_recovery(self):
        self.c.opening_sent=False
        await self.c.speak('greeting')
        with patch('dialogue_controller.voice_clip',new=AsyncMock(side_effect=AssertionError('prepared opening must reuse cached body'))):
            await self.c.speak('opening')
        self.assertTrue(self.c.opening_sent)
        self.assertEqual(self.c.last_question['topic'],self.c.opening_topic)
        self.assertIn('plan:'+self.c.opening_topic,self.c.question_ledger)
        self.s.evidence.delivery.response(self.c.last_question['response_id'])['interrupted']=True
        self.c.player.queue_frame.reset_mock()
        await self.run_turn('Алло.',control='attention')
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.last_question['topic'],self.c.opening_topic)
        self.assertIn('Меня интересует',self.c.player.queue_frame.call_args.args[0].text)

    async def test_semantic_hold_mutes_output_even_without_literal_transfer_match(self):
        self.c.started=True
        await self.run_turn('Оставать на линии, вас соединяет коллега.',control='wait')
        self.assertEqual(self.c.line.state,'waiting_operator')
        self.assertFalse(self.c.line.can_speak)
        self.c.player.queue_frame.assert_not_awaited()
        await self.c.speak(self.keys[-1])
        self.c.player.queue_frame.assert_not_awaited()
        await self.run_turn('Алло, слушаю вас.',listening_ready=True)
        self.assertTrue(self.c.line.can_speak)
        self.c.player.queue_frame.assert_awaited()

    async def test_confirmation_is_answered_before_new_plan_question(self):
        self.c.started=True
        await self.c.speak('opening')
        self.c.player.queue_frame.reset_mock()
        self.s.context['targetLocation']={'name':'Тестовая точка','city':'Омск','address':'Тестовая улица, 1'}
        await self.run_turn('В город Омск обращаетесь.',confirmation_request=True,other_questions=True)
        self.c.player.queue_frame.assert_not_awaited()
        self.c.llm.send_client_event.assert_awaited()
        self.assertIsNone(self.c.pending_after_native[0])
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertTrue(state['confirmation_requested'])
        self.assertEqual(state['target_location']['city'],'Омск')

    async def test_unclassified_compound_reply_is_answered_before_advancing(self):
        self.c.started=True
        await self.c.speak('opening')
        self.c.player.queue_frame.reset_mock()
        await self.run_turn('Товар в наличии. Впервые обратились в компанию.',
            contextual_reply=True,coverage={self.keys[0]:'answered'})
        self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.c.pending_after_native[0],'advance')
        self.c.llm.send_client_event.assert_awaited()
        self.assertNotIn(self.keys[-1],self.c.asked)
        self.assertIn('коротко попроси повторить',self.c.fallback_goal)

    async def test_unclassified_noisy_subject_does_not_turn_into_silence(self):
        self.c.started=True
        await self.c.speak('opening')
        self.c.player.queue_frame.reset_mock()
        await self.run_turn('Алло. Искажённое название интересует.',contextual_reply=True)
        self.c.player.queue_frame.assert_not_awaited()
        self.c.llm.send_client_event.assert_awaited()
        self.assertIsNone(self.c.pending_after_native[0])
        self.assertIn('Искажённое название сверяй с SCENARIO_SCOPE',self.c.fallback_goal)

    async def test_plain_acknowledgment_does_not_trigger_contextual_generation(self):
        await self.exhausted_question()
        self.c.llm.send_client_event.reset_mock()
        await self.run_turn('Угу.',contextual_reply=True)
        self.c.llm.send_client_event.assert_not_awaited()
        self.c.player.queue_frame.assert_not_awaited()

    async def test_invitation_after_our_slot_is_reviewed_without_repeating_the_time(self):
        await self.offer()
        self.s.evidence.turn=2
        self.c.answers={key:{} for key in self.keys}
        with patch('semantic_controller.review_acceptance',new=AsyncMock(return_value=True)) as review:
            await self.run_turn('Приезжайте.',visit='offer')
        review.assert_awaited_once()
        self.assertTrue(self.c.visit_confirmed)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_farewell'])

    async def test_unverified_invitation_does_not_repeat_slot_or_confirm_it(self):
        await self.offer()
        self.s.evidence.turn=2
        identifier=self.c.visit_offer_response_id
        await self.run_turn('Приезжайте.',visit='offer')
        self.assertFalse(self.c.visit_confirmed)
        self.assertEqual(self.c.visit_offer_response_id,identifier)
        self.assertFalse(any('Мне подойдёт' in call.args[0].text for call in self.c.player.queue_frame.call_args_list))
        self.assertNotIn('visit_day',self.s.evidence.memory.facts)

    async def test_same_clock_spoken_differently_does_not_replace_active_proposal(self):
        await self.offer();self.s.evidence.turn=2
        original=self.c.visit_offer_response_id
        with patch('semantic_controller.review_acceptance',new=AsyncMock(return_value=False)) as review:
            await self.run_turn('Завтра в три часа дня я вас ожидаю.',visit='offer')
        review.assert_awaited_once()
        self.assertEqual(self.c.visit_offer_response_id,original)
        self.assertFalse(self.c.visit_confirmed)
        self.assertFalse(any('По времени пока не определились' in call.args[0].text for call in self.c.player.queue_frame.call_args_list))

    async def test_confirmed_visit_cannot_be_described_as_undetermined(self):
        await self.offer();self.s.evidence.turn=2
        await self.run_turn('Да, удобно.',visit='accept',acceptance_scope='direct_reply')
        self.assertTrue(self.c.visit_confirmed)
        self.s.playback.finish_requested=False
        self.c.player.queue_frame.reset_mock()
        await self.c.perform('acceptance_unresolved','Как передать адрес?',self.c.epoch)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_ack'])
        self.assertTrue(self.c.visit_confirmed)

    async def test_legal_status_before_transfer_is_answered_then_hold_waits_for_phone_ack(self):
        self.c.started=True
        self.c.line.classify=AsyncMock(return_value=('hold',None,False))
        await self.run_turn('Я соединю вас с менеджером. Вы как частное лицо или от организации?',
            control='wait',transfer_reply=True)
        self.assertTrue(self.c.line.can_speak)
        self.assertEqual(self.c.pending_after_native[0],'wait_transfer')
        self.c.llm.spoken_text['native']='Как частное лицо.'
        ledger=self.s.evidence.delivery
        ledger.response('native').update(generated_done=True,tts_done=True)
        ledger.segment('native-tag','native')
        await self.c.fallback_done('native');await asyncio.sleep(.03)
        self.assertTrue(self.c.line.can_speak)
        ledger.ack('native-tag');await asyncio.sleep(.05)
        self.assertFalse(self.c.line.can_speak)
        self.assertEqual(self.c.line.state,'waiting_operator')
        self.c.player.queue_frame.assert_not_awaited()

    async def test_location_only_uses_known_branch_city_instead_of_free_generation(self):
        self.c.started=True
        self.c.texts['target_city']='Я обращаюсь в город Омск.'
        self.c.clips['target_city']=self.c.clips['name']
        await self.run_turn('Вы обращаетесь в Омск?',location_only=True,other_questions=True)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,'Я обращаюсь в город Омск.')
        self.c.llm.send_client_event.reset_mock();self.c.player.queue_frame.reset_mock()
        await self.run_turn('Так в какой город обращаетесь?',location_only=True,other_questions=True)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,'Я обращаюсь в город Омск.')
        # Mirroring the cached clip is permitted; no native response is created.
        self.assertFalse(any(type(call.args[0]).__name__=='ResponseCreateEvent' for call in self.c.llm.send_client_event.call_args_list))

    async def test_repeated_explicit_connection_checks_receive_audible_answers(self):
        self.c.started=True
        await self.run_turn('Алло, вы меня слышите?',control='attention')
        self.s.evidence.turn=2
        await self.run_turn('Вы ещё на связи?',control='attention')
        self.assertEqual(self.c.player.queue_frame.await_count,2)
        self.assertTrue(all(call.args[0].text==self.c.texts['resume'] for call in self.c.player.queue_frame.call_args_list))

    async def test_identity_question_does_not_replay_interrupted_intro(self):
        self.c.started=True
        await self.c.speak('opening')
        original=self.c.last_question['response_id']
        self.s.evidence.delivery.response(original)['interrupted']=True
        self.c.player.queue_frame.reset_mock()
        await self.run_turn('Как вас зовут?',name=True)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['name'])
        self.assertEqual(self.c.last_question['response_id'],original)

    async def test_plain_acknowledgment_does_not_automatically_replay_documents(self):
        topic,original=await self.interrupted_plan()
        await self.run_turn('Угу.')
        self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.c.last_question['response_id'],original)
        self.assertNotIn('plan:'+topic,self.c.auto_replayed_questions)

    async def test_incomplete_linking_word_cannot_authorize_document_replay(self):
        topic,original=await self.interrupted_plan()
        body=payload(self.c,'Значит.')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        for key in ('name','subject','visit_accepted'):
            answers[key]={'choice':'no','probabilities':{'no':.99}}
        answers['visit_request']={'choice':'none','probabilities':{'none':.99}}
        answers['other_questions']={'choice':'plan_only','probabilities':{'plan_only':.99,'no':.01}}
        answers['plan_permission']={'choice':'wait','probabilities':{'wait':.99,'no':.01}}
        for key in answers:
            if key.startswith('coverage:'):answers[key]={'choice':'unanswered','probabilities':{'unanswered':.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,'Значит.')
        self.assertEqual(result['control'],'fragment')
        self.assertFalse(result['next_question'])
        await self.run_turn('Значит.',**result)
        self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.c.last_question['response_id'],original)
        self.assertNotIn('plan:'+topic,self.c.auto_replayed_questions)

    async def test_acknowledgment_request_cannot_become_plan_navigation(self):
        body=payload(self.c,'Этого объяснения достаточно?')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['acknowledgment_request']={'choice':'yes','probabilities':{'yes':.95,'no':.05}}
        answers['other_questions']={'choice':'plan_only','probabilities':{'plan_only':.95,'no':.05}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,'Этого объяснения достаточно?')
        self.assertTrue(result['other_questions'])
        self.assertFalse(result['next_question'])

    async def test_duplicate_proposal_does_not_paraphrase_the_same_time(self):
        await self.offer()
        await self.c.propose([])
        self.c.player.queue_frame.assert_not_awaited()
        self.assertFalse(self.c.visit_confirmed)

    async def test_listening_invitation_does_not_override_wait_or_an_answer(self):
        topic=await self.exhausted_question()
        await self.run_turn('Проверю информацию.',control='wait',listening_ready=True)
        self.c.player.queue_frame.assert_not_awaited()
        await self.run_turn('Да, работаем.',listening_ready=True,coverage={topic:'answered'})
        self.assertIn(topic,self.c.answers)
        self.assertFalse(any(call.args[0].text==self.c.texts[topic] for call in self.c.player.queue_frame.call_args_list))

    async def test_excellent_then_time_question_does_not_confirm_a_visit(self):
        await self.offer()
        self.assertFalse(self.c.direct_slot_acceptance('Отлично. Во сколько?',1))
        self.assertFalse(self.c.visit_confirmed)
        self.assertNotIn('visit_time',self.s.evidence.memory.facts)

    async def test_transfer_name_request_overrides_wait_without_silencing_the_buyer(self):
        self.c.started=True
        await self.run_turn('Я сейчас соединю вас с отделом продаж. Уточните, пожалуйста, как могу к вам обращаться?',name=True,control='wait')
        self.assertTrue(self.c.line.can_speak)
        self.assertIn('Меня зовут Андрей.',self.c.player.queue_frame.call_args.args[0].text)
        self.assertFalse(self.s.playback.finish_requested)

    async def test_default_visit_preference_uses_prepared_audio_not_midcall_synthesis(self):
        self.c.visit.day={'value':'Завтра','source':'client_preference','turn':1}
        self.c.visit.time={'value':'в 10:00','source':'client_preference','turn':1}
        with patch('dialogue_controller.voice_clip',new=AsyncMock(side_effect=AssertionError('unexpected mid-call TTS'))):
            await self.c.propose([])
        self.assertIn('Могу подъехать Завтра',self.c.player.queue_frame.call_args.args[0].text)
        self.assertFalse(self.c.visit_confirmed)

    async def test_condition_and_prior_contact_questions_keep_direct_answer_instructions(self):
        self.c.started=True
        await self.run_turn('Вас интересует новый автомобиль или с пробегом?',other_questions=True)
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertIn('предпочтение покупателя',state['buyer_information']['default_condition_preference'])
        self.assertIn('не утверждая, что товар продавца действительно новый',self.c.fallback_goal)
        await self.run_turn('Не общались ранее с менеджером по автомобилю?',other_questions=True)
        self.assertIn('Не заменяй ответ «да/нет» повтором марки',self.c.fallback_goal)

    async def interrupted_preamble(self):
        topic=self.keys[-1]
        self.s.evidence.memory.topics.required[-1]['question']='Нас пятеро, иногда с бабушкой. Машина просторная?'
        self.c.texts[topic]='Скажите, для пятерых и иногда с бабушкой места хватает?'
        await self.interrupted_plan()
        delivery=self.s.evidence.delivery
        delivery.segment('native-tag','native-answer');delivery.ack('native-tag')
        delivery.response('native-answer').update(generated_done=True,tts_done=True)
        self.c.native_resume_context={'response_id':'native-answer','epoch':self.c.epoch,
            'text':'Для семьи: нас пятеро, иногда ездим с бабушкой.'}
        return topic

    async def test_auto_resume_omits_approved_personal_preamble_already_answered(self):
        topic=await self.interrupted_preamble()
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,
            json=lambda:{'answers':{'shorten':{'choice':'short','probabilities':{'short':.99,'full':.01}}}}))
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)) as synthesize:
            await self.c.replay_question('plan:'+topic,explicit=False)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,'Машина просторная?')
        synthesize.assert_awaited_once_with(self.s,'Машина просторная?')
        self.assertEqual(self.c.asked[topic],1)

    async def test_auto_resume_keeps_conditions_when_shortening_is_not_approved(self):
        topic=await self.interrupted_preamble()
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,
            json=lambda:{'answers':{'shorten':{'choice':'full','probabilities':{'short':.01,'full':.99}}}}))
        await self.c.replay_question('plan:'+topic,explicit=False)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[topic])

    async def test_auto_resume_never_omits_preamble_based_on_interrupted_native_answer(self):
        topic=await self.interrupted_preamble()
        self.s.evidence.delivery.response('native-answer')['interrupted']=True
        self.c.http.post=AsyncMock()
        await self.c.replay_question('plan:'+topic,explicit=False)
        self.c.http.post.assert_not_awaited()
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[topic])

    async def test_recall_does_not_override_explicit_callback(self):
        topic,_=await self.interrupted_plan()
        await self.run_turn('Перезвоните позже.',control='callback',question_recall='plan:'+topic)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.s.evidence.memory.closing_reason,'callback_requested')

    async def test_recalled_native_question_preserves_its_answer_identity(self):
        self.c.question_ledger['native:details']={'response_id':'original-native','text':'Можно получить отчёт?', 'turn':1,'state':'queued'}
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.c.replay_question('native:details')
        self.assertEqual(self.c.last_question['question_id'],'native:details')
        self.assertEqual(self.c.last_question['kind'],'followup')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,'Можно получить отчёт?')

    async def test_visit_preference_before_any_slot_chooses_instead_of_looping(self):
        self.c.started=True
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Когда вам удобно, сегодня или завтра?',visit='offer',visit_request='details')
        self.assertIsNotNone(self.c.visit.offered)
        self.assertEqual(self.c.visit.offered['day']['value'],'сегодня')
        self.assertFalse(self.c.visit_confirmed)
        self.assertFalse(self.s.evidence.memory.facts)
        self.assertIn('Могу подъехать',self.c.player.queue_frame.call_args.args[0].text)

    async def test_spoken_clock_without_preposition_yields_real_slot_after_generic_visit_question(self):
        self.c.started=True;await self.c.speak('visit')
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Предлагаю вам подъехать сегодня. двадцать ноль ноль.',visit='offer')
        self.assertEqual(self.c.visit.offered['day']['value'],'сегодня')
        self.assertEqual(self.c.visit.offered['time']['value'],'двадцать ноль ноль')
        self.assertIn('Могу подъехать',self.c.player.queue_frame.call_args.args[0].text)

    async def test_literal_new_clock_overrides_mistaken_acceptance_with_uncertain_scope(self):
        self.c.answers={key:{} for key in self.keys};await self.offer()
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Предлагаю сегодня. двадцать ноль ноль.',visit='accept',acceptance_scope='other')
        self.assertEqual(self.c.visit.offered['day']['value'],'сегодня')
        self.assertEqual(self.c.visit.offered['time']['value'],'двадцать ноль ноль')
        self.assertFalse(self.c.visit_confirmed)
        await self.run_turn('Да, сегодня в двадцать ноль ноль, ждём.',visit='accept',acceptance_scope='explicit_visit')
        self.assertTrue(self.c.visit_confirmed);self.assertTrue(self.s.playback.finish_requested)

    async def test_rejection_of_old_slot_does_not_erase_later_replacement(self):
        await self.offer()
        text='Нет, сегодня в десять утра не подойдёт, сейчас уже двадцать часов вечера. Давайте завтра. Завтра в десять часов сможете подъехать?'
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn(text,visit='change',visit_request='details')
        self.assertEqual(self.c.visit.offered['day']['value'].casefold(),'завтра')
        self.assertEqual(self.c.visit.offered['time']['value'],'в десять')
        self.assertNotIn('сегодня',self.c.player.queue_frame.call_args.args[0].text.casefold())

    async def test_confirmed_visit_survives_unrelated_answer_misclassified_as_acceptance(self):
        await self.offer()
        await self.run_turn('Да, ждём завтра после обеда.',visit='accept',acceptance_scope='explicit_visit')
        self.assertTrue(self.c.visit_confirmed)
        facts=dict(self.s.evidence.memory.facts)
        self.c.player.queue_frame.reset_mock()
        await self.run_turn('Скидки обсудим в автосалоне.',visit='accept',acceptance_scope='other',coverage={self.keys[0]:'answered'})
        self.assertTrue(self.c.visit_confirmed);self.assertEqual(self.s.evidence.memory.facts,facts)
        self.assertFalse(any(call.args[0].text==self.c.texts['visit_pending'] for call in self.c.player.queue_frame.call_args_list))
        state=json.loads(self.c.context_text().split('\n',1)[1])
        self.assertIsNotNone(state['confirmed_visit'])

    async def test_visit_default_never_chooses_past_hour_today(self):
        with patch('semantic_controller.datetime') as clock:
            clock.now.return_value=datetime(2026,11,16,20,10,tzinfo=ZoneInfo('Europe/Moscow'))
            candidate=self.c.choose_visit_preference(self.c.candidate('Сегодня или завтра?',1),1)
        self.assertEqual(candidate.time['value'],'в 21:00')

    async def test_inherited_opening_hour_is_replaced_with_a_future_proposal(self):
        self.c.visit.update('Работаем с девяти до девятнадцати.',1)
        self.c.visit.update('Можно подъехать сегодня.',2)
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            clock.now.return_value=datetime(2026,11,18,10,14,tzinfo=ZoneInfo('Europe/Moscow'))
            await self.c.propose([])
        self.assertIn('в 11:00',self.c.player.queue_frame.call_args.args[0].text)
        self.assertFalse(self.c.visit_confirmed)

    async def test_past_hour_does_not_produce_a_proposal_after_closing_hours(self):
        self.c.visit.update('Сегодня с девяти до девятнадцати.',1)
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            clock.now.return_value=datetime(2026,11,18,19,14,tzinfo=ZoneInfo('Europe/Moscow'))
            await self.c.propose([])
        self.assertIsNone(self.c.visit.offered)
        self.assertIn('уже прошло',self.c.player.queue_frame.call_args.args[0].text)

    async def test_direct_acceptance_followed_by_documents_preserves_booking(self):
        await self.offer()
        await self.run_turn('Да, конечно. С собой водительское удостоверение необходимо будет взять. Паспорт.',visit='none',acceptance_scope='other')
        self.assertTrue(self.c.visit_confirmed)
        facts=dict(self.s.evidence.memory.facts)
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Напомните, во сколько вы приедете?',visit='change',visit_request='details')
        self.assertTrue(self.c.visit_confirmed)
        self.assertEqual(self.s.evidence.memory.facts,facts)

    async def test_unanswered_slot_does_not_reopen_a_generic_visit_question(self):
        await self.offer()
        self.c.asked.update({row['key']:1 for row in self.s.evidence.memory.topics.required})
        self.c.player.queue_frame.reset_mock()
        await self.c.perform('advance','Возьмите паспорт.',self.c.epoch)
        self.c.player.queue_frame.assert_not_awaited()
        self.assertIsNotNone(self.c.visit.offered)

    async def test_direct_acceptance_survives_cancellation_of_interpretation(self):
        await self.offer()
        with patch('semantic_controller.interpret',new=AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await self.c.handle('Да, конечно.',self.s.evidence.turn,self.c.epoch)
        self.assertTrue(self.c.visit_confirmed)
        self.assertIn('visit_time',self.s.evidence.memory.facts)

    async def test_confirmed_booking_requires_independent_evidence_before_reset(self):
        self.c.visit_confirmed=True
        self.s.evidence.memory.facts={'visit_day':{'value':'завтра'},'visit_time':{'value':'в 10:00'}}
        text='С собой водительское удостоверение и паспорт.'
        body=payload(self.c,text)
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['visit']={'choice':'change','probabilities':{'change':.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,text)
        self.assertNotIn(result['visit'],('change','cancel'))
        self.assertTrue(any(e['event']=='semantic_booking_revision_blocked' for e in self.s.evidence.events))


    async def test_independent_question_parts_retain_a_payment_question(self):
        text='Для кого подбираете автомобиль? Планируете кредит с первоначальным взносом?'
        body=payload(self.c,text)
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['other_questions']={'choice':'no','probabilities':{'no':.95}}
        answers['buyer_part:1']={'choice':'yes','probabilities':{'yes':.98,'no':.02}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,text)
        self.assertTrue(result['other_questions'])
        self.assertIn('Планируете кредит с первоначальным взносом?',result['buyer_question_parts'])

    async def test_visit_preference_question_is_not_lost_after_a_long_invitation(self):
        text='Мы проведём пробную поездку всей семьёй. Подберём кредит. Вы подъедете сегодня или завтра?'
        body=payload(self.c,text)
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['visit_request']={'choice':'none','probabilities':{'none':.99}}
        answers['buyer_part:2']={'choice':'visit','probabilities':{'visit':.99,'no':.01,'yes':0}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,text)
        self.assertEqual(result['visit_request'],'details')


    async def test_specific_object_repair_does_not_repeat_name(self):
        self.c.started=True
        await self.run_turn('Не расслышал модель.',control='audio_repair',subject=True)
        text=self.c.player.queue_frame.call_args.args[0].text
        self.assertEqual(text,self.c.texts['subject']);self.assertNotIn('Меня зовут',text)

    async def test_explicit_repeated_object_request_is_allowed_without_reintroducing_name(self):
        self.c.started=True
        for _ in range(2):await self.run_turn('Повторите, какая машина?',subject=True)
        frames=[call.args[0].text for call in self.c.player.queue_frame.call_args_list]
        self.assertEqual(frames,[self.c.texts['subject'],self.c.texts['subject']])

    async def test_scenario_without_question_list_uses_prepared_scenario_topics(self):
        self.s.evidence.memory.topics.required=[]
        rows=[{'key':'custom:scenario:0','question':'Сколько времени занимает оформление?','origin':'derived_from_scenario'},
              {'key':'custom:scenario:1','question':'Можно заранее подготовить документы?','origin':'derived_from_scenario'}]
        with patch('dialogue_controller.derive_scenario_topics',new=AsyncMock(return_value=rows)) as derive,patch('dialogue_controller.prepare_questions',new=AsyncMock()) as rewrite,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.c.prepare()
        derive.assert_awaited_once();rewrite.assert_not_awaited()
        self.assertEqual(self.s.evidence.memory.topics.required,rows)
        self.c.started=True
        await self.run_turn('Да, продаётся.',coverage={'availability':'answered'})
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertTrue(frame.text.endswith(rows[0]['question']))
        self.assertEqual(frame.text.count('?'),1)

    async def test_topic_match_does_not_grant_permission_to_repeat(self):
        await self.c.speak(self.keys[0])
        body=payload(self.c,'Ответ на вопрос.')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['question_recall']={'choice':'repeat_0','probabilities':{'repeat_0':.99,'none':.01}}
        answers['repeat_permission']={'choice':'no','probabilities':{'no':.99,'yes':.01}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):
            result=await interpret(self.c,'Ответ на вопрос.')
            self.assertIsNone(result['question_recall'])
            answers['repeat_permission']={'choice':'yes','probabilities':{'yes':.99,'no':.01}}
            result=await interpret(self.c,'Повторите предыдущий вопрос.')
            self.assertEqual(result['question_recall'],'plan:'+self.keys[0])

    async def test_plan_invitation_does_not_repeat_already_named_object(self):
        self.c.started=True
        await self.run_turn('Что именно вас интересует?',subject=True,next_question=True)
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertNotIn(self.c.texts['subject'],frame.text)
        self.assertIn(self.c.texts[self.keys[0]],frame.text)

    async def test_repeated_prior_fact_does_not_skip_the_active_question(self):
        self.c.started=True
        self.c.answers[self.keys[0]]={'status':'answered'}
        await self.c.speak(self.keys[1]);self.c.player.queue_frame.reset_mock()
        await self.run_turn('Ещё раз подтверждаю предыдущий факт.',coverage={self.keys[0]:'answered'})
        self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.c.current,self.keys[1])
        self.assertNotIn(self.keys[1],self.c.answers)

    async def test_general_visit_question_does_not_block_missing_time_clarification(self):
        self.c.started=True
        await self.c.speak('visit')
        self.c.visit.day={'value':'завтра','turn':1,'source':'manager'}
        await self.c.ask_visit()
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['clarify_visit'])
        self.assertIn('visit-general',self.c.question_ledger)
        self.assertIn('visit-field:time',self.c.question_ledger)
        self.assertIsNone(await self.c.speak('clarify_time_short'))

    async def test_answer_and_visit_condition_use_one_generation(self):
        self.c.started=True;self.c.answers={key:{} for key in self.keys}
        await self.run_turn('Что думаете об условии?',visit='conditional',other_questions=True)
        self.assertEqual(self.c.native_question_policy,'clarification')
        self.assertIsNone(self.c.pending_after_native[0])
        self.assertEqual(len(self.c.llm.request_turns),1)
        self.assertIn('ВСЕ вопросы',self.c.fallback_goal)
        self.assertIn('Не придумывай',self.c.fallback_goal)

    async def test_callback_closes_with_acknowledgment_without_waiting_for_a_visit(self):
        self.c.started=True;self.c.current='visit'
        await self.run_turn('Я сам вам перезвоню после проверки.',control='callback')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['callback_farewell'])
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.s.evidence.memory.closing_reason,'callback_requested')

    async def test_complete_confirmation_overrides_fragment_label_only_with_coverage(self):
        self.c.started=True;await self.c.speak(self.keys[0]);self.c.player.queue_frame.reset_mock()
        await self.run_turn('Угу всё верно',control='fragment',coverage={self.keys[0]:'answered'})
        self.assertIn(self.c.texts[self.keys[1]],self.c.player.queue_frame.call_args.args[0].text)
        self.assertTrue(any(e['event']=='semantic_complete_confirmation' for e in self.s.evidence.events))

    async def test_manager_input_preserves_breath_and_prepared_voice_stops_it(self):
        self.c.breath.active=True
        await self.c.new_input()
        self.assertTrue(self.c.breath.active)
        self.assertFalse(any(call.args[0].get('action')=='stop_breath' for call in self.c.serializer.send.call_args_list))
        await self.c.speak('resume')
        self.assertFalse(self.c.breath.active)
        self.assertTrue(any(call.args[0].get('action')=='stop_breath' for call in self.c.serializer.send.call_args_list))

    async def test_incomplete_confirmation_and_explicit_wait_do_not_advance(self):
        self.c.started=True;await self.c.speak(self.keys[0]);self.c.player.queue_frame.reset_mock()
        await self.run_turn('Да, но',control='fragment',coverage={self.keys[0]:'answered'})
        self.c.player.queue_frame.assert_not_awaited()
        await self.run_turn('Да, подождите.',control='wait',coverage={self.keys[0]:'answered'})
        self.c.player.queue_frame.assert_not_awaited()

    async def test_neutral_wait_voice_can_cover_slow_meaning_without_agreement(self):
        c=self.c;c.started=True;c.current=self.keys[0]
        c.last_question={'topic':self.keys[0],'text':self.c.texts[self.keys[0]]}
        c.latest_input='В объявлении пробег указан верно.'
        c.thinking.delay_ms=c.thinking.semantic_delay_ms=1
        c.thinking.arm('semantic_interpretation');await asyncio.sleep(.02)
        self.assertEqual(c.player.queue_frame.call_args.args[0].text,c.texts['think_reply_0'])
        self.assertIsNone(c.last_clip)

    async def test_filler_handoff_finishes_sending_without_clearing_media_or_waiting_for_phone_end(self):
        c=self.c;c.output_transport=SimpleNamespace()
        c.playing_id='filler';c.playing_kind='backchannel'
        c.s.evidence.delivery.segment('tag-filler','filler')
        c.s.playback.pending.add('tag-filler')
        job={'source':'native_reply','epoch':c.epoch,'turn':1,'started':time.monotonic(),
             'emitted':True,'response_id':'filler'}
        c.thinking.current=job
        c.stop_backchannel=AsyncMock()
        task=asyncio.create_task(c.thinking.finish(job))
        await asyncio.sleep(.02);self.assertFalse(task.done())
        c.s.playback.sealed.add('tag-filler')
        await asyncio.wait_for(task,.2)
        c.stop_backchannel.assert_not_awaited()
        self.assertIn('tag-filler',c.s.playback.pending)
        self.assertIsNone(c.playing_id)

    async def test_active_listening_backchannel_requires_ongoing_speech_and_is_rate_limited(self):
        self.c.current=self.keys[0];self.c.waiting=False
        self.monitor.segment_start=time.monotonic()-4
        self.c.schedule_backchannel('listen_active',0)
        await self.c.bc_task
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['bc_listen'])
        self.s.evidence.turn+=1
        self.c.schedule_backchannel('listen_active',0)
        await self.c.bc_task
        self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_finished_short_speech_does_not_receive_listening_backchannel(self):
        self.c.current=self.keys[0];self.c.waiting=False
        self.monitor.segment_start=None
        self.c.schedule_backchannel('listen_active',0)
        await self.c.bc_task
        self.c.player.queue_frame.assert_not_awaited()

    async def test_receipt_only_after_known_answer_and_not_every_question(self):
        self.c.started=True
        await self.run_turn('Первый ответ',coverage={'availability':'answered'})
        self.assertTrue(self.c.player.queue_frame.call_args.args[0].text.startswith(self.c.texts['receipt_0']))
        self.s.evidence.turn+=1
        await self.run_turn('Второй ответ',coverage={self.keys[0]:'answered'})
        self.assertFalse(self.c.player.queue_frame.call_args.args[0].text.startswith(self.c.texts['receipt_2']))

    async def test_terminal_line_never_reaches_business_interpretation_or_tts(self):
        self.c.line.state='awaiting_person';self.c.line.ever_human=False
        with patch('semantic_controller.interpret',new=AsyncMock()) as interpret:
            await self.c.handle('Здравствуйте, я голосовой ассистент абонента. Что передать?',1,self.c.epoch)
        interpret.assert_not_awaited();self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.s.line_outcome,'no_answer');self.assertFalse(self.c.asked)

    async def test_transfer_greeting_restores_open_question_and_preserves_identity(self):
        self.c.started=True
        await self.c.speak(self.keys[0]);self.c.player.queue_frame.reset_mock()
        self.c.clear_audio=AsyncMock()
        await self.run_turn('Подождите, переведу вас к коллеге.',control='wait')
        self.assertFalse(self.c.line.can_speak);self.c.player.queue_frame.assert_not_awaited()
        self.c.playing_id=None
        await self.run_turn('Добрый день, отдел продаж, слушаю.')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[self.keys[0]])
        self.assertEqual(self.c.asked[self.keys[0]],1)
        self.assertEqual(self.s.evidence.memory.name,'Андрей')

    async def test_hold_does_not_lose_answer_in_same_utterance(self):
        self.c.started=True
        await self.run_turn('Доставляем по области. Подождите, сейчас соединю.',coverage={self.keys[0]:'answered'})
        self.assertIn(self.keys[0],self.c.answers)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_old_menu_in_cancelled_batch_cannot_enter_human_meaning(self):
        self.c.line.state='awaiting_person';self.c.line.ever_human=False
        self.c.active_batch=[{'text':'Для продаж нажмите один.','turn':1},{'text':'Добрый день, отдел продаж.','turn':2}]
        self.s.evidence.turn=2
        with patch('semantic_controller.interpret',new=AsyncMock(return_value=meaning())) as interpret:
            await self.c.handle('Для продаж нажмите один. Добрый день, отдел продаж.',2,self.c.epoch)
        self.assertEqual(interpret.call_args.args[1],'Добрый день, отдел продаж.')
        self.assertTrue(self.c.line.can_speak)

    async def test_semantic_fillers_wait_for_meaning_and_have_per_call_budget(self):
        c=self.c;c.thinking.delay_ms=c.thinking.semantic_delay_ms=2
        c.thinking.arm('semantic_interpretation');await asyncio.sleep(.01)
        self.c.player.queue_frame.assert_not_awaited()
        c.thinking.arm('native_reply');await asyncio.sleep(.01)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        for turn,stage in ((2,'native_reply'),(3,'visit_tts'),(4,'visit_tts')):
            self.s.evidence.turn=turn;c.last_bc=time.monotonic()-61
            c.thinking.arm(stage);await asyncio.sleep(.01)
        self.assertEqual(self.c.player.queue_frame.await_count,2)
        texts=[call.args[0].text for call in self.c.player.queue_frame.call_args_list]
        self.assertEqual(len(texts),len(set(texts)))

    async def test_changed_requested_slot_does_not_repeat_old_proposal(self):
        await self.offer()
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Сегодня в восемь вечера удобно?',visit='offer',visit_request='details')
        self.assertIn('сегодня',self.c.player.queue_frame.call_args.args[0].text.casefold())
        self.assertEqual(self.c.visit.offered['time']['value'],'в восемь вечера')

    async def test_wrong_name_is_corrected_without_renaming_customer(self):
        self.c.started=True;await self.c.speak('name');self.c.player.queue_frame.reset_mock()
        await self.run_turn('Михаил?',control='attention',name=True)
        self.assertEqual(self.s.evidence.memory.name,'Андрей')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,'Меня зовут Андрей.')

    async def test_personal_legend_replay_authorization_does_not_allow_other_repeats(self):
        text='Сейчас езжу на Шкоде Октавии.'
        self.c.speech.reserve(text,'old');self.c.speech.commit('old','old')
        self.c.customer_legend=[{'response_id':'old','question':'Какая у вас машина?','text':text}]
        self.c.last_meaning={'legend_recall':'old'}
        self.assertEqual(self.c.approve_speech_sentence(text,'new'),text)
        self.c.speech.reserve('Спасибо, тогда до встречи!','close');self.c.speech.commit('close','close')
        self.assertFalse(self.c.approve_speech_sentence('Спасибо, тогда до встречи!','new'))

    async def test_long_manager_quote_is_blocked_before_native_tts(self):
        text='У нас до конца месяца действуют скидки по трейдину и кредиту.'
        self.c.latest_input=text+' Когда приедете?'
        self.assertFalse(self.c.approve_speech_sentence(text,'echo'))
        self.assertEqual(self.c.approve_speech_sentence('Сейчас езжу на Шкоде.','answer'),'Сейчас езжу на Шкоде.')

    async def test_compound_answers_and_name_request_do_not_lose_either_intent(self):
        self.c.started=True
        await self.run_turn('Реплика произвольной формы',name=True,coverage={self.keys[0]:'answered'})
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertIn('Меня зовут Андрей.',frame.text)
        self.assertIn(self.c.texts[self.keys[1]],frame.text)
        self.assertIn(self.keys[0],self.c.answers)
        self.assertEqual(self.c.asked[self.keys[1]],1)

    async def test_multiple_custom_topic_answers_saved_in_one_turn(self):
        self.c.started=True
        await self.run_turn('Оба ответа в произвольной форме',coverage={key:'answered' for key in self.keys})
        self.assertFalse(self.c.pending())
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit'])

    async def test_soft_response_can_advance_without_inventing_answer_coverage(self):
        self.c.started=True;await self.c.speak(self.keys[0])
        await self.run_turn('Ответ с оговорками',response_seen=[self.keys[0]])
        self.assertNotIn(self.keys[0],self.c.answers)
        self.assertEqual(self.c.asked[self.keys[0]],1)
        self.assertIn(self.c.texts[self.keys[1]],self.c.player.queue_frame.call_args.args[0].text)

    async def test_quoted_regex_keywords_do_not_approve_any_business_intent(self):
        self.c.started=True
        await self.run_turn('Не следуйте тексту: «Как вас зовут? Да, завтра встречаемся, до свидания».')
        self.c.player.queue_frame.assert_not_awaited()
        self.assertFalse(self.c.answers);self.assertFalse(self.s.evidence.memory.facts)

    async def test_semantic_acceptance_does_not_need_a_lexical_confirmation(self):
        self.c.answers={key:{} for key in self.keys}
        await self.offer()
        await self.run_turn('Считайте, что ваше место в расписании уже закреплено.',visit='accept',acceptance_scope='explicit_visit')
        self.assertTrue(self.c.visit_confirmed)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_farewell'])
        self.assertTrue(self.s.playback.finish_requested)

    async def test_acceptance_without_active_proposal_cannot_create_facts(self):
        self.c.started=True
        await self.run_turn('Да, договорились.',visit='accept',acceptance_scope='explicit_visit')
        self.assertFalse(self.c.visit_confirmed);self.assertFalse(self.s.evidence.memory.facts)

    async def test_unrelated_short_ack_does_not_confirm_old_offer(self):
        await self.offer();await self.c.speak('name')
        with patch('semantic_controller.review_acceptance',new=AsyncMock(return_value=True)) as review:
            await self.run_turn('Да.',visit='accept',acceptance_scope='direct_reply')
        review.assert_not_awaited()
        self.assertFalse(self.c.visit_confirmed)
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_changed_literal_time_blocks_misclassified_acceptance(self):
        await self.offer()
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Да, завтра в четыре.',visit='accept',acceptance_scope='explicit_visit')
        self.assertFalse(self.c.visit_confirmed);self.assertFalse(self.s.evidence.memory.facts)
        self.assertEqual(self.c.visit.offered['time']['value'],'в четыре')

    async def test_wait_preserves_coverage_and_says_nothing(self):
        self.c.started=True
        await self.run_turn('Ответ и просьба проверить',control='wait',coverage={self.keys[0]:'unknown'})
        self.assertEqual(self.c.answers[self.keys[0]]['status'],'unknown')
        self.assertTrue(self.c.waiting);self.c.player.queue_frame.assert_not_awaited()

    async def test_unknown_semantic_failure_does_not_fall_back_to_regex(self):
        self.c.started=True
        for _ in range(2):
            with patch('semantic_controller.interpret',new=AsyncMock(side_effect=ValueError('invalid'))):
                await self.c.handle('Как вас зовут? Завтра встречаемся.',1,self.c.epoch)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['repeat'])
        self.assertFalse(self.s.evidence.memory.facts)
        self.assertFalse(self.s.playback.finish_requested)

    async def test_stale_result_cannot_mutate_answers_or_speak(self):
        async def stale(*args):
            self.c.epoch+=1
            return meaning(name=True,coverage={self.keys[0]:'answered'})
        with patch('semantic_controller.interpret',new=stale):await self.c.handle('Данные',1,self.c.epoch)
        self.assertFalse(self.c.answers);self.c.player.queue_frame.assert_not_awaited()

    async def test_confirmation_and_question_answer_before_farewell_ack(self):
        self.c.answers={key:{} for key in self.keys}
        await self.offer()
        await self.run_turn('Запись подтверждаю. Вам отправить адрес?',visit='accept',acceptance_scope='explicit_visit',other_questions=True)
        self.assertTrue(self.c.visit_confirmed)
        self.assertFalse(self.s.playback.finish_requested)
        self.c.llm.spoken_text['native']='Да, отправьте, пожалуйста.'
        ledger=self.s.evidence.delivery
        ledger.response('native').update(generated_done=True,tts_done=True)
        ledger.segment('native-tag','native')
        await self.c.fallback_done('native')
        await asyncio.sleep(.03)
        self.assertFalse(self.s.playback.finish_requested)
        ledger.ack('native-tag')
        await asyncio.sleep(.05)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_farewell'])

    async def test_user_speech_cancels_deferred_farewell(self):
        self.c.answers={key:{} for key in self.keys};self.c.visit_confirmed=True
        self.c.pending_after_native=('advance','text',self.c.epoch)
        self.c.llm.spoken_text['native']='Ответ.'
        await self.c.fallback_done('native')
        await self.c.new_input();await asyncio.sleep(.03)
        self.assertIsNone(self.c.continuation_task);self.assertFalse(self.s.playback.finish_requested)

    async def start_farewell(self):
        self.c.answers={key:{} for key in self.keys};await self.offer()
        await self.run_turn('Встречу подтверждаю',visit='accept',acceptance_scope='direct_reply')
        self.assertTrue(self.s.playback.finish_requested)
        return self.s.finish_response_id

    async def test_closing_ack_preserves_existing_farewell_instead_of_repeating(self):
        target=await self.start_farewell();self.c.player.queue_frame.reset_mock()
        await self.c.new_input()
        self.assertFalse(self.s.playback.finish_requested)
        await self.run_turn('Хорошо',closing_intent='acknowledgment')
        self.assertTrue(self.s.playback.finish_requested);self.assertEqual(self.s.finish_response_id,target)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_ambiguous_address_cannot_restore_hangup_even_if_farewell_was_not_interrupted(self):
        await self.start_farewell();await self.c.new_input()
        await self.run_turn('Андрей',closing_intent='continuation')
        self.assertFalse(self.s.playback.finish_requested);self.assertTrue(self.c.closing_suspended)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['resume'])

    async def test_interrupted_farewell_address_and_ack_do_not_loop(self):
        target=await self.start_farewell()
        self.s.evidence.delivery.response(target)['interrupted']=True
        self.s.playback.interrupt();self.c.player.queue_frame.reset_mock()
        await self.c.new_input();await self.run_turn('Андрей')
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['resume'])
        self.c.player.queue_frame.reset_mock()
        await self.c.new_input();await self.run_turn('Okay')
        self.c.player.queue_frame.assert_not_awaited()
        self.assertFalse(self.s.playback.finish_requested);self.assertTrue(self.c.waiting)

    async def test_new_buyer_question_reopens_closing_and_answers_before_final_audio(self):
        target=await self.start_farewell()
        self.s.evidence.delivery.response(target)['interrupted']=True;self.s.playback.interrupt()
        await self.c.new_input()
        await self.run_turn('Какие сроки принятия решения?',other_questions=True)
        self.assertFalse(self.s.playback.finish_requested)
        self.assertEqual(self.c.pending_after_native[0],'advance')
        self.assertIn('Какие сроки',self.c.latest_input)
        self.assertFalse(self.c.closing_suspended)

    async def test_closing_wait_never_hangs_up_after_farewell_ack(self):
        await self.start_farewell();await self.c.new_input()
        await self.run_turn('Минуточку, ещё уточню',control='wait')
        self.assertFalse(self.s.playback.finish_requested);self.assertTrue(self.c.waiting)

    async def test_goodbye_after_closing_address_finishes_on_actual_reply_ack_without_replaying(self):
        target=await self.start_farewell()
        self.s.evidence.delivery.response(target)['interrupted']=True;self.s.playback.interrupt()
        await self.c.new_input();await self.run_turn('Андрей')
        resume=self.c.last_clip['response_id']
        self.c.player.queue_frame.reset_mock()
        await self.c.new_input();await self.run_turn('Спасибо за звонок',control='goodbye')
        self.assertTrue(self.s.playback.finish_requested);self.assertEqual(self.s.finish_response_id,resume)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_final_ack_after_closing_address_can_finish_without_another_farewell(self):
        target=await self.start_farewell()
        self.s.evidence.delivery.response(target)['interrupted']=True;self.s.playback.interrupt()
        await self.c.new_input();await self.run_turn('Андрей',closing_intent='continuation')
        resume=self.c.last_clip['response_id'];self.c.player.queue_frame.reset_mock()
        await self.c.new_input();await self.run_turn('Okay',closing_intent='acknowledgment')
        self.assertTrue(self.s.playback.finish_requested);self.assertEqual(self.s.finish_response_id,resume)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_ignored_short_backchannel_releases_hold_without_replaying_farewell(self):
        target=await self.start_farewell();await self.c.new_input()
        self.c.player.queue_frame.reset_mock()
        await self.c.on_ignored_input(self.monitor.turn)
        self.assertTrue(self.s.playback.finish_requested);self.assertEqual(self.s.finish_response_id,target)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_ignored_old_input_cannot_end_call_during_new_question(self):
        await self.start_farewell();await self.c.new_input()
        await self.c.on_ignored_input(Turn(True,number=0))
        self.assertFalse(self.s.playback.finish_requested)
        self.c.inputs.add('Новый вопрос',1)
        await self.c.on_ignored_input(self.monitor.turn)
        self.assertFalse(self.s.playback.finish_requested)

    async def test_semantic_goodbye_does_not_require_matching_goodbye_regex(self):
        await self.run_turn('На этом завершаем, благодарю за разговор.',control='goodbye')
        self.assertEqual(self.s.evidence.memory.closing_reason,'manager_goodbye')
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['goodbye'])

    async def test_semantic_memory_does_not_apply_old_regex_updates(self):
        m=self.s.evidence.memory
        m.facts={'visit_day':{'value':'завтра'},'visit_time':{'value':'в три'}}
        m.user('Не завтра в три, давайте послезавтра в пять.',1)
        self.assertEqual(m.facts['visit_day']['value'],'завтра')
        self.assertFalse(m.topics.name_requested)

    async def test_full_payload_is_one_call_and_missing_fields_rejected(self):
        body=payload(self.c,'Текст')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['other_questions']={'choice':'yes','probabilities':{'yes':.63,'no':.37}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):
            result=await interpret(self.c,'Текст')
        self.assertEqual(self.c.http.post.await_count,1)
        self.assertIn('coverage:'+self.keys[0],self.c.http.post.call_args.kwargs['json']['questions'])
        self.assertIn('coverage',result)
        self.assertTrue(result['other_questions'])
        del answers['visit']
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):
            with self.assertRaises(ValueError):await interpret(self.c,'Текст')

    def test_uncertain_or_nonfinite_scores_cannot_approve_a_transition(self):
        for scores in ({'yes':.51,'no':.49},{'yes':float('nan'),'no':0}):
            self.assertEqual(pick({'name':{'choice':'yes','probabilities':scores}},'name','no'),'no')

    async def test_listening_invitation_requires_confident_semantic_decision(self):
        body=payload(self.c,'Расскажите, с каким вопросом обращаетесь.')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        for probability,expected in ((.96,True),(.72,False)):
            answers['listening_ready']={'choice':'yes','probabilities':{'yes':probability,'no':1-probability}}
            with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):
                result=await interpret(self.c,'Расскажите, с каким вопросом обращаетесь.')
            self.assertEqual(result['listening_ready'],expected)

    async def test_confirmation_overrides_mistaken_plan_navigation(self):
        body=payload(self.c,'Уточняете именно этот объект.')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['confirmation_request']={'choice':'yes','probabilities':{'yes':.95,'no':.05}}
        answers['subject']={'choice':'plan','probabilities':{'plan':.95,'no':.05}}
        answers['visit_request']={'choice':'none','probabilities':{'none':.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,'Уточняете именно этот объект.')
        self.assertTrue(result['other_questions'])
        self.assertFalse(result['next_question'])

    async def test_unrecognized_continuation_requests_contextual_reply(self):
        body=payload(self.c,'Искажённая реплика.')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        for key in ('name','subject','other_questions','visit_accepted'):
            answers[key]={'choice':'no','probabilities':{'no':.99}}
        answers['subject']={'choice':'plan','probabilities':{'plan':.95,'no':.05}}
        answers['visit_request']={'choice':'none','probabilities':{'none':.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,'Искажённая реплика.')
        self.assertTrue(result['contextual_reply'])
        self.assertFalse(result['next_question'])

    async def test_topic_refusal_cannot_be_used_as_permission_to_end_call(self):
        body=payload(self.c,'Ограничение обсуждения отдельной темы')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['control']={'choice':'decline','probabilities':{'decline':.99,'continue':.01}}
        answers['end_permission']={'choice':'no','probabilities':{'yes':.01,'no':.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,'Ограничение обсуждения отдельной темы')
        self.assertEqual(result['control'],'continue')
