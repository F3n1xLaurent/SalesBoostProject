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
    async def test_existing_visit_slot_must_be_inside_hours_even_when_in_the_future(self):
        self.s.context['visitSchedule']={'workingHoursFrom':'09:00','workingHoursTo':'21:00','timezoneOffsetMinutes':240}
        for day,clock,allowed in [('Сегодня','20:59',True),('Сегодня','21:00',False),
                ('Сегодня','21:01',False),('Завтра','08:59',False),('Завтра','09:00',True),('Завтра','21:00',False)]:
            with self.subTest(day=day,clock=clock):
                self.c.visit=self.c.candidate(f'{day} в {clock}.',1)
                with patch('semantic_controller.datetime') as now:
                    now.now.return_value=datetime.fromisoformat('2026-11-26T20:21:00+04:00')
                    self.assertEqual(self.c.future_visit(),allowed)

    async def test_call_1526_closing_refusal_cannot_restate_rejected_hour(self):
        self.c.started=True
        self.s.context['visitSchedule']={'workingHoursFrom':'10:00','workingHoursTo':'22:00','timezoneOffsetMinutes':240}
        self.c.visit.update('Сегодня в 21:00.',1);self.c.visit.offered=self.c.visit.proposal()
        self.s.evidence.turn=2
        text='Нет, к сожалению, 21.0 салон закрывается, давайте выберем другое время. Вам удобнее в будни или в выходные дни?'
        with patch('semantic_controller.datetime') as now,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            now.now.return_value=datetime.fromisoformat('2026-11-26T20:21:00+04:00')
            await self.run_turn(text,visit='change',visit_request='details')
        self.assertIsNone(self.c.visit.offered)
        self.assertFalse(self.c.visit_confirmed)
        self.assertTrue(self.c.player.queue_frame.call_args_list)
        self.assertFalse(any('21:00' in call.args[0].text for call in self.c.player.queue_frame.call_args_list))
        # The following turn must not recover the obsolete 22:00 boundary.
        self.assertEqual(self.c.visit_bounds(self.c.candidate('Например, завтра.',3))[1],1260)

    async def test_refusal_without_replacement_discards_the_old_slot(self):
        self.c.started=True;self.c.visit.update('Завтра в 15:00.',1)
        self.c.visit.offered=self.c.visit.proposal();self.s.evidence.turn=2
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Нет, это время не подходит. Давайте выберем другое.',visit='change',visit_request='details')
        self.assertFalse(any('15:00' in call.args[0].text for call in self.c.player.queue_frame.call_args_list))
        self.assertFalse(self.c.visit_confirmed)

    async def test_manager_hours_survive_next_turn_and_override_configured_hours(self):
        self.s.context['visitSchedule']={'workingHoursFrom':'10:00','workingHoursTo':'22:00','timezoneOffsetMinutes':240}
        self.c.started=True
        await self.run_turn('Наш салон работает с девяти до девяти.')
        with patch('semantic_controller.datetime') as now:
            now.now.return_value=datetime.fromisoformat('2026-11-26T20:21:00+04:00')
            candidate=self.c.choose_visit_preference(self.c.candidate('Сегодня или завтра?',2),2)
        self.assertEqual(candidate.day['value'].casefold(),'завтра')
        self.assertEqual(candidate.time['interval_end'],1260)

    async def test_request_to_repeat_a_valid_confirmed_slot_preserves_the_booking(self):
        await self.offer()
        await self.run_turn('Да, ждём завтра после обеда.',visit='accept',acceptance_scope='explicit_visit')
        saved=dict(self.s.evidence.memory.facts)
        self.s.context['visitSchedule']={'workingHoursFrom':'09:00','workingHoursTo':'21:00','timezoneOffsetMinutes':240}
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Повторите, во сколько вас ждать?',visit_request='details')
        self.assertTrue(self.c.visit_confirmed)
        self.assertEqual(self.s.evidence.memory.facts,saved)

    async def test_call_1526_uses_a_different_slot_then_confirms_it(self):
        self.c.started=True
        self.s.context['visitSchedule']={'workingHoursFrom':'10:00','workingHoursTo':'22:00','timezoneOffsetMinutes':240}
        with patch('semantic_controller.datetime') as now,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            now.now.return_value=datetime.fromisoformat('2026-11-26T20:21:00+04:00')
            await self.run_turn('Вы подъедете сегодня или завтра?',visit='offer',visit_request='details')
            self.assertEqual(self.c.visit.offered['time']['value'],'в 21:00')
            self.s.evidence.turn=2;self.c.player.queue_frame.reset_mock()
            await self.run_turn('Нет, к сожалению, 21.0 салон закрывается, давайте выберем другое время. Вам удобнее в будни или в выходные дни?',
                visit='change',visit_request='details')
            self.s.evidence.turn=3
            await self.run_turn('Салон не работает с 21:00. Давайте подберём другое время. Например, завтра. В первой или во второй половине дня?',
                visit='offer',visit_request='details')
            self.assertEqual(self.c.visit.offered['day']['value'].casefold(),'завтра')
            self.assertEqual(self.c.visit.offered['time']['value'],'в 10:00')
            self.assertEqual(self.c.visit.offered['time']['interval_end'],1260)
            self.assertFalse(any('21:00' in call.args[0].text for call in self.c.player.queue_frame.call_args_list))
            self.s.evidence.turn=4
            await self.run_turn('Отлично, будем ждать вас завтра в десять.',visit='accept',acceptance_scope='explicit_visit')
        self.assertTrue(self.c.visit_confirmed)
        self.assertEqual(self.s.evidence.memory.facts['visit_time']['value'],'в 10:00')

    async def test_rejected_clock_on_one_day_can_be_offered_on_another_day(self):
        self.c.started=True;self.c.visit.update('Сегодня в 15:00.',1)
        self.c.visit.offered=self.c.visit.proposal();self.s.evidence.turn=2
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Нет, сегодня не получится. Давайте завтра в 15:00.',visit='change',visit_request='details')
        self.assertEqual(self.c.visit.offered['day']['value'].casefold(),'завтра')
        self.assertEqual(self.c.visit.offered['time']['value'],'в 15:00')

    async def test_closing_statement_does_not_hide_a_later_valid_replacement(self):
        self.c.started=True;self.c.visit.update('Завтра в 21:00.',1)
        self.c.visit.offered=self.c.visit.proposal();self.s.evidence.turn=2
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('В 21:00 салон закрывается, приезжайте завтра в 20:00.',visit='change',visit_request='details')
        self.assertEqual(self.c.visit.offered['time']['value'],'в 20:00')
        self.assertEqual(self.c.visit_bounds(self.c.candidate('Когда можно приехать?',3))[1],1260)

    async def test_closing_boundary_cannot_be_confirmed_from_an_old_proposal(self):
        self.c.visit.update('Завтра в 21:00.',1);self.c.visit.offered=self.c.visit.proposal()
        self.c.visit_offer_response_id='old-slot'
        self.s.context['visitSchedule']={'workingHoursFrom':'09:00','workingHoursTo':'21:00','timezoneOffsetMinutes':240}
        self.assertFalse(self.c.accept_active('Да, ждём.',2,{'acceptance_scope':'explicit_visit'}))
        self.assertEqual(self.c.acceptance_block_reason,'unavailable_slot')
        self.assertFalse(self.c.visit_confirmed)
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_corrected_hours_invalidate_an_incompatible_booking_before_repeating_it(self):
        self.c.started=True;self.c.visit.update('Завтра в 21:00.',1)
        self.c.visit_confirmed=True
        self.s.evidence.memory.facts.update({'visit_day':dict(self.c.visit.day),'visit_time':dict(self.c.visit.time)})
        self.s.context['visitSchedule']={'workingHoursFrom':'10:00','workingHoursTo':'22:00','timezoneOffsetMinutes':240}
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Салон работает до 21:00. Повторите, во сколько вас ждать?',visit_request='details')
        self.assertFalse(self.c.visit_confirmed)
        self.assertNotIn('visit_time',self.s.evidence.memory.facts)
        self.assertEqual(self.c.manager_visit_hours['start'],600)
        self.assertFalse(any('21:00' in call.args[0].text for call in self.c.player.queue_frame.call_args_list))

    async def test_repeating_a_confirmed_booking_does_not_silently_reschedule_it(self):
        self.c.visit.update('Сегодня в 15:00.',1);self.c.visit_confirmed=True
        with patch('semantic_controller.datetime') as now:
            now.now.return_value=datetime.fromisoformat('2026-11-26T15:01:00+04:00')
            self.assertTrue(self.c.future_visit())
        self.assertEqual(self.c.visit.time['value'],'в 15:00')

    async def test_asr_repair_repeats_an_unanswered_question_even_if_playback_was_not_interrupted(self):
        self.c.started=True;await self.c.speak(self.keys[0])
        original=self.c.last_question['response_id']
        self.c.asr_repair_wait=.01;self.c.asr_close_wait=100
        self.c.player.queue_frame.reset_mock()
        await self.c.on_asr_unresolved(self.monitor.turn,'verification_unavailable')
        await asyncio.sleep(.04)
        texts=[call.args[0].text for call in self.c.player.queue_frame.call_args_list]
        self.assertEqual(texts[0],self.c.texts['repeat'])
        self.assertIn(self.c.texts[self.keys[0]],texts[-1])
        self.assertEqual(self.c.question_ledger['plan:'+self.keys[0]]['retry_of'],original)
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_uncertain_asr_asks_once_then_recovers_and_closes_without_inventing_facts(self):
        self.c.started=True;await self.c.speak('visit')
        self.c.asr_repair_wait=.01;self.c.asr_close_wait=.02
        self.c.player.queue_frame.reset_mock()
        await self.c.on_asr_unresolved(self.monitor.turn,'transcript_disagreement')
        await self.c.on_asr_unresolved(self.monitor.turn,'transcript_disagreement')
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['repeat'])
        await asyncio.sleep(.06)
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.s.evidence.memory.closing_reason,'audio_unavailable')
        self.assertFalse(self.s.evidence.memory.facts)
        self.assertFalse(self.s.evidence.memory.users)

    async def test_real_answer_cancels_asr_repair_deadline(self):
        self.c.started=True;await self.c.speak('visit')
        self.c.asr_repair_wait=.01;self.c.asr_close_wait=.02
        await self.c.on_asr_unresolved(self.monitor.turn,'verification_unavailable')
        await self.run_identity_turn('Как вас зовут?')
        await asyncio.sleep(.06)
        self.assertFalse(self.s.playback.finish_requested)
        self.assertNotEqual(self.s.evidence.memory.closing_reason,'audio_unavailable')
        self.assertIsNone(self.c.asr_repair_task)

    async def test_asr_repair_never_speaks_over_physical_speech_or_for_an_old_turn(self):
        self.c.started=True;self.monitor.segment_start=time.monotonic()
        await self.c.on_asr_unresolved(self.monitor.turn,'verification_unavailable')
        self.c.player.queue_frame.assert_not_awaited()
        self.monitor.segment_start=None
        self.monitor.turn=Turn(False,number=2)
        await self.c.on_asr_unresolved(Turn(False,number=1),'verification_unavailable')
        self.c.player.queue_frame.assert_not_awaited()

    async def test_native_answer_continuation_does_not_acknowledge_itself(self):
        self.c.started=True
        self.s.context={'subjectTitle':'Jetour Dashing, I 1.5 AMT Люкс'}
        self.c.native_resume_context={'response_id':'answer','epoch':self.c.epoch,'text':'Для себя.'}
        ledger=self.s.evidence.delivery
        ledger.response('answer').update(generated_done=True,tts_done=True)
        ledger.segment('answer-tag','answer');ledger.ack('answer-tag')
        await self.run_turn('Машина в наличии. Для кого выбираете?',other_questions=True,coverage={'availability':'answered'})
        # The native answer has just played; do not prepend a receipt to the next question.
        await self.c.perform('advance','',self.c.epoch)
        text=self.c.player.queue_frame.call_args.args[0].text
        self.assertFalse(any(text.startswith(self.c.texts[key]) for key in ('receipt_0','receipt_1','receipt_2')))

    async def test_fresh_native_subject_answer_resumes_only_availability_question(self):
        self.c.started=True;self.s.context={'subjectTitle':'Jetour Dashing, I 1.5 AMT Люкс'}
        self.c.texts['opening_body']='Меня интересует Jetour Dashing. Машина ещё продаётся?'
        await self.c.speak('opening')
        self.s.evidence.delivery.response(self.c.last_question['response_id'])['interrupted']=True
        ledger=self.s.evidence.delivery
        ledger.response('subject-answer').update(generated_done=True,tts_done=True)
        ledger.segment('subject-tag','subject-answer');ledger.ack('subject-tag')
        self.c.native_resume_context={'response_id':'subject-answer','text':'Интересует Jetour Dashing.','epoch':self.c.epoch}
        await self.c.replay_question('plan:availability',explicit=False)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['opening_followup'])

    async def test_standalone_listening_invitation_recovers_after_misclassified_fragment(self):
        topic,_=await self.interrupted_plan()
        self.c.active_batch=[{'text':'Незаконченная вводная.','turn':1},{'text':'Я вас слушаю.','turn':1}]
        await self.run_turn('Незаконченная вводная. Я вас слушаю.',control='fragment',contextual_reply=True)
        self.assertIn(self.c.texts[topic],self.c.player.queue_frame.call_args.args[0].text)
        self.assertEqual(self.c.llm.request_turns,[])

    async def test_connection_check_cannot_leave_buffered_buyer_question_in_fragment_wait(self):
        self.c.started=True
        self.c.active_batch=[{'text':'Какой автомобиль у вас сейчас?','turn':1},{'text':'Вас не слышно.','turn':1}]
        await self.run_turn('Какой автомобиль у вас сейчас? Вас не слышно.',control='fragment',other_questions=True,reply_focus='own_vehicle')
        self.assertEqual(self.c.last_meaning['control'],'continue')
        self.assertTrue(self.c.llm.request_turns)

    async def test_beneficiary_focus_answers_only_the_actual_question(self):
        self.c.started=True
        await self.run_turn('Для кого выбираете машину?',reply_focus='beneficiary',name_confirmation=True)
        self.assertFalse(self.c.last_meaning['name_confirmation'])
        self.assertIn('Не рассказывай об изучении модели',self.c.fallback_goal)

    async def test_selected_subject_focus_preserves_permission_to_answer_a_repeated_model_question(self):
        self.c.started=True
        self.s.context={'subjectTitle':'Toyota Corolla, 1.6 AT'}
        self.c.texts['subject']='Меня интересует Тойота Королла.'
        await self.c.speak('subject')
        self.c.player.queue_frame.reset_mock()
        await self.run_turn('Какая машина вас заинтересовала?',reply_focus='selected_subject',subject=True)
        self.assertTrue(self.c.last_meaning['subject'])
        self.assertEqual(self.c.approve_speech_sentence(self.c.texts['subject'],'model-answer'),self.c.texts['subject'])

    async def test_model_question_takes_priority_over_conflicting_plan_navigation(self):
        self.c.started=True
        await self.run_turn('Какая машина вас заинтересовала?',reply_focus='selected_subject',subject=True,next_question=True)
        self.assertFalse(self.c.last_meaning['next_question'])
        self.assertTrue(self.c.last_meaning['other_questions'])
        self.assertTrue(self.c.llm.request_turns)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_repeated_model_answer_can_differ_from_prepared_wording_without_repeating_name(self):
        self.c.started=True
        self.s.context={'subjectTitle':'Toyota Corolla, 1.6 AT'}
        self.c.approve_speech_sentence('Тойота Королла.','previous-answer')
        self.c.approve_speech_sentence('Меня зовут Андрей.','previous-name')
        await self.run_turn('Какая машина вас заинтересовала?',reply_focus='selected_subject')
        self.assertEqual(self.c.approve_speech_sentence('Тойота Королла.','model-answer'),'Тойота Королла.')
        self.assertEqual(self.c.approve_speech_sentence('Меня зовут Андрей.','model-answer'),'')

    async def test_prior_contact_focus_requires_an_answer_even_if_generic_request_intent_is_missed(self):
        self.c.started=True
        await self.run_turn('Раньше с нашими менеджерами общались?',reply_focus='prior_contact',next_question=True)
        self.assertTrue(self.c.last_meaning['other_questions'])
        self.assertFalse(self.c.last_meaning['next_question'])
        self.assertTrue(self.c.llm.request_turns)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_desired_options_do_not_become_a_request_to_repeat_selected_model(self):
        self.c.started=True
        await self.run_turn('Либо скажите, какие опции важны, и тогда я вам помогу подобрать автомобиль.',
            reply_focus='preferences',subject=True,next_question=True)
        self.assertFalse(self.c.last_meaning['subject'])
        self.assertFalse(self.c.last_meaning['next_question'])
        self.assertTrue(self.c.llm.request_turns)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_incomplete_prompt_after_an_answer_cannot_invent_a_buyer_question(self):
        self.c.started=True
        self.c.active_batch=[{'text':'При обмене есть скидка.','turn':1},{'text':'Подскажите, пожалуйста.','turn':1}]
        await self.run_turn('При обмене есть скидка. Подскажите, пожалуйста.',other_questions=True,reply_focus='none')
        self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.c.llm.request_turns,[])
        self.assertEqual(self.c.last_meaning['control'],'fragment')

    async def test_connection_check_repairs_an_unintelligible_pending_question(self):
        self.c.started=True
        self.c.active_batch=[{'text':'Неразборчивая часть.','turn':1},{'text':'Вас не слышно.','turn':1}]
        await self.run_turn('Неразборчивая часть. Вас не слышно.',control='fragment',other_questions=True,reply_focus='other')
        text=self.c.player.queue_frame.call_args.args[0].text
        self.assertIn(self.c.texts['resume'],text)
        self.assertIn(self.c.texts['stt_repair'],text)
        self.assertEqual(self.c.llm.request_turns,[])

    async def test_visit_only_focus_suppresses_unrelated_confirmation_before_proposal(self):
        self.c.started=True
        self.c.llm.send_client_event.reset_mock()
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Удобнее завтра или в выходные?',reply_focus='visit_only',
                confirmation_request=True,acknowledgment_request=True,other_questions=True,
                visit='offer',visit_request='details',buyer_question_parts=[])
        self.assertFalse(self.c.last_meaning['confirmation_request'])
        self.assertEqual(self.c.llm.request_turns,[])
        self.assertEqual(len(self.c.player.queue_frame.call_args_list),1)
        self.assertIn('Могу подъехать завтра',self.c.player.queue_frame.call_args.args[0].text)

    async def test_nonvisit_question_is_not_suppressed_by_conflicting_visit_focus(self):
        self.c.started=True
        self.c.llm.send_client_event.reset_mock()
        await self.run_turn('На чём ездите? Подъедете завтра?',reply_focus='visit_only',
            other_questions=True,visit='offer',visit_request='details',buyer_question_parts=['На чём ездите?'])
        self.assertTrue(self.c.last_meaning['other_questions'])
        self.assertTrue(self.c.llm.request_turns)

    async def test_model_familiarity_and_own_car_do_not_confirm_selected_subject(self):
        self.c.started=True
        for focus,text in [('familiarity','С моделью уже знакомы? Для себя выбираете?'),
                           ('own_vehicle','Свою нынешнюю машину планируете менять?')]:
            await self.run_turn(text,reply_focus=focus,confirmation_request=True,
                name_confirmation=True,subject=True,other_questions=True)
            self.assertFalse(self.c.last_meaning['subject'])
            self.assertFalse(self.c.last_meaning['confirmation_request'])
            self.assertNotIn('subject',self.c.pending_answer_keys)
            self.assertIn('СЕЙЧАС',self.c.fallback_goal)

    async def test_fragment_does_not_save_spurious_subject_or_name_request(self):
        self.c.started=True
        await self.run_turn('Не была. Что',control='fragment',subject=True,name=True)
        self.assertNotIn('subject',self.c.pending_answer_keys)
        self.assertNotIn('name',self.c.pending_answer_keys)
        self.assertEqual(self.c.fragment_input_epoch,self.c.epoch)
        await self.run_turn('ДТП не было. Машина проверена.',coverage={self.keys[0]:'answered'})
        self.assertIsNone(self.c.fragment_input_epoch)
        self.assertTrue(all('интересует' not in call.args[0].text for call in self.c.player.queue_frame.call_args_list))

    async def test_incomplete_tail_waits_even_when_previous_answer_is_complete(self):
        text='Состояние отличное. ДТП автомобиль'
        body=payload(self.c,text)
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['control']={'choice':'continue','probabilities':{'continue':.99}}
        answers['turn_tail']={'choice':'fragment','probabilities':{'fragment':.99}}
        answers['coverage:'+self.keys[0]]={'choice':'answered','probabilities':{'answered':.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,text)
        self.assertEqual(result['control'],'fragment')
        self.assertEqual(result['coverage'][self.keys[0]],'answered')

    async def test_fragment_batch_survives_until_manager_finishes(self):
        self.c.started=True
        self.c.inputs.add('Состояние отличное. ДТП автомобиль',1)
        batch=self.c.inputs.snapshot()
        with patch('semantic_controller.interpret',new=AsyncMock(return_value=meaning(control='fragment'))):
            self.c.receive_batch(batch)
            await self.c.task
        self.assertEqual(self.c.inputs.snapshot(),batch)
        self.c.inputs.add('в авариях не участвовал.',2)
        combined=self.c.inputs.snapshot()
        with patch('semantic_controller.interpret',new=AsyncMock(return_value=meaning())) as model:
            self.c.receive_batch(combined)
            await self.c.task
        self.assertIn('ДТП автомобиль в авариях не участвовал.',model.call_args.args[1])
        self.assertEqual(self.c.inputs.snapshot(),[])

    async def test_explicit_unsolicited_answer_removes_future_question(self):
        self.c.started=True
        topic=self.keys[-1]
        self.assertNotIn(topic,self.c.asked)
        await self.run_turn('Мы работаем и по выходным.',coverage={topic:'answered'})
        self.assertEqual(self.c.answers[topic]['status'],'answered')
        self.assertNotIn(topic,[row['key'] for row in self.c.unasked()])
        self.assertTrue(all(self.c.texts[topic] not in call.args[0].text for call in self.c.player.queue_frame.call_args_list))

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

    async def test_free_invitation_after_visit_question_selects_a_slot_within_hours(self):
        self.c.started=True;await self.c.speak('visit');self.c.player.queue_frame.reset_mock()
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            clock.now.return_value=datetime(2026,11,25,18,39,tzinfo=ZoneInfo('Europe/Moscow'))
            await self.run_turn('В удобное для вас время, мы работаем ежедневно с девяти до девяти.',visit='offer')
        offer=self.c.visit.offered
        self.assertIsNotNone(offer)
        self.assertEqual(offer['day']['value'],'завтра')
        self.assertEqual(offer['time']['value'],'в 10:00')
        self.assertFalse(self.c.visit_confirmed);self.assertFalse(self.s.evidence.memory.facts)
        self.assertIn('Подойдёт?',self.c.player.queue_frame.call_args.args[0].text)

    async def test_partial_day_offer_selects_time_without_asking_manager_to_choose(self):
        self.c.started=True;await self.c.speak('visit')
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            clock.now.return_value=datetime(2026,11,25,18,39,tzinfo=ZoneInfo('Europe/Moscow'))
            await self.run_turn('Можете подъехать сегодня, в любое удобное время. До 21:00 работаем.',visit='offer',visit_request='details')
        self.assertIsNotNone(self.c.visit.offered)
        self.assertEqual(self.c.visit.offered['day']['value'],'сегодня')
        self.assertEqual(self.c.visit.offered['time']['value'],'в 19:00')

    async def test_configured_timezone_and_hours_limit_customer_preference(self):
        self.s.context['visitSchedule']={'timezoneOffsetMinutes':240,'workingHoursFrom':'11:30','workingHoursTo':'20:00'}
        instant=datetime(2026,11,25,15,39,tzinfo=ZoneInfo('UTC'))
        with patch('semantic_controller.datetime') as clock:
            clock.now.side_effect=lambda tz:instant.astimezone(tz)
            v=self.c.choose_visit_preference(self.c.candidate('Сегодня или завтра?',2),2)
        self.assertEqual(v.day['value'],'завтра')
        self.assertEqual(v.time['value'],'в 11:30')

    async def test_options_preserve_opening_window_when_today_has_ended(self):
        self.c.started=True;await self.c.speak('visit')
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            clock.now.return_value=datetime(2026,11,25,20,39,tzinfo=ZoneInfo('Europe/Moscow'))
            await self.run_turn('Сегодня или завтра, как удобно. Мы работаем с одиннадцати до восьми.',visit='offer',visit_request='details')
        self.assertIsNotNone(self.c.visit.offered)
        self.assertEqual(self.c.visit.offered['day']['value'],'завтра')
        self.assertEqual(self.c.visit.offered['time']['value'],'в 11:00')

    async def test_unparsed_restriction_does_not_become_unrestricted_default(self):
        self.c.started=True;await self.c.speak('visit')
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Завтра только после обеда, но не раньше четырёх.',visit='offer',visit_request='details')
        self.assertIsNone(self.c.visit.offered)
        self.assertFalse(self.c.visit_confirmed)

    async def test_same_day_without_time_left_does_not_propose_outside_hours(self):
        self.c.started=True;await self.c.speak('visit')
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            clock.now.return_value=datetime(2026,11,25,20,39,tzinfo=ZoneInfo('Europe/Moscow'))
            await self.run_turn('Сегодня в удобное время, работаем с девяти до девяти.',visit='offer',visit_request='details')
        self.assertIsNone(self.c.visit.offered)
        self.assertFalse(self.c.visit_confirmed)

    async def test_rollover_uses_tomorrows_own_window_instead_of_todays(self):
        self.c.started=True;await self.c.speak('visit')
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            clock.now.return_value=datetime(2026,11,25,19,39,tzinfo=ZoneInfo('Europe/Moscow'))
            await self.run_turn('Сегодня с шестнадцати до восемнадцати или завтра с девяти до двенадцати.',visit='offer',visit_request='details')
        self.assertIsNotNone(self.c.visit.offered)
        self.assertEqual(self.c.visit.offered['day']['value'].casefold(),'завтра')
        self.assertEqual(self.c.visit.offered['time']['value'],'в 9:00')

    async def test_exhausted_today_does_not_roll_over_to_negated_tomorrow(self):
        self.c.started=True;await self.c.speak('visit')
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            clock.now.return_value=datetime(2026,11,25,20,39,tzinfo=ZoneInfo('Europe/Moscow'))
            await self.run_turn('Сегодня с девяти до девятнадцати или завтра нельзя.',visit='offer',visit_request='details')
        self.assertIsNone(self.c.visit.offered)

    async def test_extra_restriction_cannot_be_lost_behind_general_opening_hours(self):
        self.c.started=True;await self.c.speak('visit')
        with patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)):
            await self.run_turn('Завтра работаем с девяти до девяти, но приехать можно только после четырёх.',visit='offer',visit_request='details')
        self.assertIsNone(self.c.visit.offered)
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

    async def test_midcall_name_question_uses_cached_audio_without_semantic_request(self):
        self.c.started=True
        previous=self.c.last_question
        with patch('semantic_controller.interpret',new=AsyncMock(return_value=meaning(name=True))) as model,\
             patch('dialogue_controller.voice_clip',new=AsyncMock()) as synthesize:
            await self.c.handle('Как я могу к вам обращаться?',1,self.c.epoch)
        model.assert_not_awaited();synthesize.assert_not_awaited()
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['name'])
        self.assertEqual(self.c.last_question,previous)
        self.assertEqual(self.c.llm.request_turns,[])
        self.assertIsNone(self.c.thinking.current)

    async def test_repeated_name_question_replays_only_name_without_semantic_request(self):
        self.c.started=True
        self.c.approve_speech_sentence(self.c.texts['name'],'previous-name')
        with patch('semantic_controller.interpret',new=AsyncMock(return_value=meaning(name=True))) as model:
            await self.c.handle('Скажи, пожалуйста, как я могу к вам обращаться?',1,self.c.epoch)
        model.assert_not_awaited()
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,'Меня зовут Андрей.')
        self.assertFalse(any(e['event']=='thinking_pause_emitted' for e in self.s.evidence.events))

    async def test_compound_identity_request_does_not_skip_its_other_question(self):
        self.c.started=True
        await self.run_turn('Как к вам обращаться и для кого подбираете машину?',name=True,other_questions=True)
        self.assertTrue(self.c.llm.request_turns)
        self.assertIn('name',self.c.requested_answers)

    async def test_closing_identity_request_keeps_semantic_closing_decision(self):
        self.c.started=True;self.s.evidence.memory.phase='closing'
        with patch('semantic_controller.interpret',new=AsyncMock(return_value=meaning(name=True))) as model:
            await self.c.handle('Как вас зовут?',1,self.c.epoch)
        model.assert_awaited_once()
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

    async def pending_answer(self):
        self.c.started=True
        await self.run_turn('Машина в наличии. Для кого подбираете?',other_questions=True,
            coverage={'availability':'answered'})
        self.c.llm.spoken_text['native']='Для себя.'
        ledger=self.s.evidence.delivery
        ledger.response('native').update(generated_done=True,tts_done=True)
        ledger.segment('native-tag','native')
        await self.c.fallback_done('native')
        return ledger

    async def test_ignored_backchannel_restores_continuation_after_phone_confirmed_answer(self):
        ledger=await self.pending_answer()
        await self.c.new_input()
        self.s.evidence.turn=2;self.monitor.turn=Turn(True,300,number=2)
        await self.c.on_ignored_input(self.monitor.turn)
        self.c.player.queue_frame.assert_not_awaited()
        ledger.ack('native-tag');await asyncio.sleep(.05)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertIn(self.c.texts[self.keys[0]],self.c.player.queue_frame.call_args.args[0].text)

    async def test_actually_interrupted_answer_cannot_resume_on_late_ack(self):
        ledger=await self.pending_answer()
        await self.c.new_input()
        self.s.evidence.turn=2;self.monitor.turn=Turn(True,1200,interrupted=True,number=2)
        ledger.response('native')['interrupted']=True
        await self.c.on_ignored_input(self.monitor.turn)
        ledger.ack('native-tag');await asyncio.sleep(.04)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_ignored_old_turn_cannot_restore_a_continuation_during_new_input(self):
        ledger=await self.pending_answer()
        await self.c.new_input()
        self.s.evidence.turn=2;self.monitor.turn=Turn(False,number=2)
        await self.c.on_ignored_input(Turn(True,200,number=1))
        ledger.ack('native-tag');await asyncio.sleep(.04)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_backchannel_cannot_resume_old_plan_with_a_new_question_buffered(self):
        ledger=await self.pending_answer()
        await self.c.new_input()
        self.s.evidence.turn=2;self.monitor.turn=Turn(False,number=2)
        self.c.inputs.add('Какие опции важны?',2)
        await self.c.on_ignored_input(self.monitor.turn)
        ledger.ack('native-tag');await asyncio.sleep(.04)
        self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.c.inputs.snapshot()[0]['text'],'Какие опции важны?')

    async def test_backchannel_restores_pending_answer_without_losing_its_original_input(self):
        self.c.inputs.add('Машина в наличии. Для кого подбираете?',1)
        self.c.active_batch=self.c.inputs.snapshot()
        ledger=await self.pending_answer()
        await self.c.new_input()
        self.s.evidence.turn=2;self.monitor.turn=Turn(True,200,number=2)
        await self.c.on_ignored_input(self.monitor.turn)
        self.assertTrue(self.c.inputs.snapshot())
        ledger.ack('native-tag');await asyncio.sleep(.04)
        self.assertEqual(self.c.inputs.snapshot(),[])
        self.assertIsNone(self.c.native_input_epoch)
        self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_original_input_is_not_dispatched_again_after_ignored_backchannel(self):
        self.c.inputs.add('Машина в наличии. Для кого подбираете?',1)
        self.c.active_batch=self.c.inputs.snapshot()
        await self.pending_answer()
        await self.c.new_input()
        self.s.evidence.turn=2;self.monitor.turn=Turn(True,200,number=2)
        await self.c.on_ignored_input(self.monitor.turn)
        gate=GatedRealtime(self.s,self.monitor,api_key='test')
        self.s.playback.generated=True
        gate._handle_interruption=AsyncMock()
        gate.broadcast_frame=AsyncMock(side_effect=lambda *args:self.c.serializer.queue_cleared_event.set())
        with patch.object(self.c,'receive_batch') as receive:
            await gate.dispatch_controller_input()
        receive.assert_not_called()
        gate._handle_interruption.assert_not_awaited()

    async def test_ignored_backchannel_before_generation_done_keeps_native_completion(self):
        self.c.started=True
        self.c.inputs.add('Машина в наличии. Для кого подбираете?',1)
        self.c.active_batch=self.c.inputs.snapshot()
        await self.run_turn('Машина в наличии. Для кого подбираете?',other_questions=True,coverage={'availability':'answered'})
        await self.c.new_input()
        self.s.evidence.turn=2;self.monitor.turn=Turn(True,200,number=2)
        await self.c.on_ignored_input(self.monitor.turn)
        request={'reason':'controller_fallback','turn':1}
        self.assertTrue(self.c.accepts_native_completion('native',request))
        self.assertFalse(self.c.accepts_native_completion('native',{'reason':'controller_fallback','turn':0}))
        self.c.llm.spoken_text['native']='Для себя.'
        ledger=self.s.evidence.delivery
        ledger.response('native').update(generated_done=True,tts_done=True)
        ledger.segment('native-tag','native');ledger.ack('native-tag')
        await self.c.fallback_done('native');await asyncio.sleep(.04)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.inputs.snapshot(),[])

    async def test_transport_discarded_native_request_does_not_block_retained_input(self):
        self.c.started=True
        self.c.inputs.add('Для кого подбираете?',1)
        batch=self.c.inputs.snapshot();self.c.active_batch=batch
        await self.run_turn('Для кого подбираете?',other_questions=True)
        self.c.llm.deferred_response=None
        self.assertFalse(self.c.awaiting_answer_for(batch))
        self.c.llm.wire_pending={'request_id':'pending'}
        self.assertTrue(self.c.awaiting_answer_for(batch))

    async def test_continuation_waits_for_vad_speech_that_precedes_logical_turn(self):
        ledger=await self.pending_answer()
        self.monitor.segment_start=time.monotonic()
        ledger.ack('native-tag');await asyncio.sleep(.03)
        self.c.player.queue_frame.assert_not_awaited()
        self.monitor.segment_start=None
        await asyncio.sleep(.04)
        self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_name_answer_resumes_interrupted_plan_only_after_name_playback(self):
        topic,original=await self.interrupted_plan()
        await self.run_identity_turn('Как вас зовут?')
        frame=self.c.player.queue_frame.call_args.args[0]
        self.assertEqual(frame.text,self.c.texts['name'])
        ledger=self.s.evidence.delivery
        ledger.response(frame.response_id)['tts_done']=True
        ledger.segment('name-tag',frame.response_id)
        await asyncio.sleep(.03)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        ledger.ack('name-tag');await asyncio.sleep(.05)
        self.assertEqual(self.c.player.queue_frame.await_count,2)
        self.assertIn(self.c.texts[topic],self.c.player.queue_frame.call_args.args[0].text)
        self.assertEqual(self.c.asked[topic],1)
        self.assertEqual(self.c.question_ledger['plan:'+topic]['retry_of'],original)

    async def test_completed_meaning_cannot_start_an_answer_during_new_vad_speech(self):
        self.c.started=True
        async def understand(*args):
            self.monitor.segment_start=time.monotonic()
            return meaning(other_questions=True)
        with patch('semantic_controller.interpret',new=AsyncMock(side_effect=understand)):
            await self.c.handle('Для кого подбираете?',1,self.c.epoch)
        self.assertEqual(self.c.llm.request_turns,[])
        self.c.player.queue_frame.assert_not_awaited()
        self.assertEqual(self.c.fragment_input_epoch,self.c.epoch)

    async def test_prepared_audio_is_not_queued_if_manager_starts_during_synthesis(self):
        async def synthesize(*args):
            self.monitor.segment_start=time.monotonic()
            return b'\x01\x00'*1600
        with patch('dialogue_controller.voice_clip',new=AsyncMock(side_effect=synthesize)):
            result=await self.c.speak(text='Для личных поездок.')
        self.assertIsNone(result)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_prepared_audio_is_not_queued_if_manager_starts_during_context_mirroring(self):
        async def mirror(event):
            if event.type=='conversation.item.create':self.monitor.segment_start=time.monotonic()
        self.c.llm.send_client_event=AsyncMock(side_effect=mirror)
        result=await self.c.speak('name')
        self.assertIsNone(result)
        self.c.player.queue_frame.assert_not_awaited()
        self.assertTrue(any(call.args[0].type=='conversation.item.delete' for call in self.c.llm.send_client_event.call_args_list))

    async def test_continuation_deferred_during_context_mirroring_resumes_after_vad_silence(self):
        ledger=await self.pending_answer()
        deferred=False
        async def mirror(event):
            nonlocal deferred
            if event.type=='conversation.item.create' and not deferred:
                deferred=True;self.monitor.segment_start=time.monotonic()
        self.c.llm.send_client_event=AsyncMock(side_effect=mirror)
        ledger.ack('native-tag');await asyncio.sleep(.03)
        self.c.player.queue_frame.assert_not_awaited()
        self.assertIsNotNone(self.c.pending_continuation)
        self.monitor.segment_start=None
        await asyncio.sleep(.05)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.asked[self.keys[0]],1)

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
        answer_review=patch('semantic_controller.review_answer_coverage',new=AsyncMock(return_value='unanswered'))
        answer_review.start();self.addCleanup(answer_review.stop)
        fragment_review=patch('fragment_recovery.review_fragment_question',new=AsyncMock(return_value='clarify'))
        fragment_review.start();self.addCleanup(fragment_review.stop)
        self.s.controller=self.c
        self.c.continuation_quiet_seconds=0.
        self.c.llm=SimpleNamespace(response_id=None,response_items={},spoken_text={},wire_active=None,wire_pending=None,
            request_turns=[],_messages_added_manually={},send_client_event=AsyncMock(),broadcast_frame=AsyncMock(),user_speaking=False)
        self.c.player=SimpleNamespace(queue_frame=AsyncMock())
        texts={r['key']:r['question'] for r in self.s.evidence.memory.topics.required}
        self.keys=list(texts)
        with patch('dialogue_controller.prepare_questions',new=AsyncMock(return_value=texts)),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\xd0\x07'*1600)):
            await self.c.prepare()

    async def asyncTearDown(self):await self.c.close()

    def phone_complete(self,identifier):
        ledger=self.s.evidence.delivery
        ledger.response(identifier).update(generated_done=True,tts_done=True)
        ledger.segment(identifier+'-tag',identifier);ledger.ack(identifier+'-tag')
        self.s.playback.generated=False;self.s.playback.synthesizing=False

    def confirmed_booking(self):
        self.c.started=True;self.c.visit.update('Завтра в 10:00.',1);self.c.visit_confirmed=True
        self.s.evidence.memory.facts.update({'visit_day':dict(self.c.visit.day),'visit_time':dict(self.c.visit.time)})
        self.s.evidence.memory.visit_pending=False

    async def test_call_1529_payment_answer_card_question_and_farewell_form_one_sequence(self):
        self.confirmed_booking();self.c.continuation_quiet_seconds=.01
        card=self.keys[-1];self.c.texts[card]='Оплата картой возможна?'
        self.s.evidence.memory.topics.required[-1]['question']=self.c.texts[card]
        self.c.answers[self.keys[0]]={'status':'answered'}
        await self.run_turn('Покупку планируете в кредит или за наличные?',other_questions=True)
        self.assertEqual(self.c.pending_after_native[0],'advance')
        self.c.llm.spoken_text['payment']='За наличные, документы возьму с собой.'
        ledger=self.s.evidence.delivery;ledger.response('payment').update(generated_done=True,tts_done=True)
        ledger.segment('payment-tag','payment')
        await self.c.fallback_done('payment');await asyncio.sleep(.03)
        self.c.player.queue_frame.assert_not_awaited()
        self.phone_complete('payment');await asyncio.sleep(.04)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[card])
        self.assertFalse(self.s.playback.finish_requested)
        self.phone_complete(self.c.last_clip['response_id']);self.s.evidence.turn=2
        await self.c.new_input()
        await self.run_turn('Да, картой оплатить можно.',coverage={card:'answered'})
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_farewell'])
        self.assertTrue(self.s.playback.finish_requested)
        self.assertEqual(self.s.evidence.memory.closing_reason,'visit_agreed')

    async def test_connection_confirmation_continues_after_phone_playback(self):
        self.confirmed_booking();self.c.continuation_quiet_seconds=.01
        await self.run_turn('Иван, вас не слышно.',control='attention')
        resume=self.c.last_clip['response_id']
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['resume'])
        await asyncio.sleep(.03);self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.phone_complete(resume);await asyncio.sleep(.04)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[self.keys[0]])

    async def test_connection_confirmation_can_finish_a_completed_booking(self):
        self.confirmed_booking();self.c.answers={key:{'status':'answered'} for key in self.keys}
        await self.run_turn('Алло.',control='attention')
        self.phone_complete(self.c.last_clip['response_id']);await asyncio.sleep(.03)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_farewell'])
        self.assertTrue(self.s.playback.finish_requested)

    async def test_new_manager_question_cancels_connection_continuation(self):
        self.confirmed_booking()
        await self.run_turn('Вы на связи?',control='attention');resume=self.c.last_clip['response_id']
        await self.c.new_input();self.s.evidence.turn=2
        await self.run_turn('Свою машину собираетесь продавать?',other_questions=True,reply_focus='own_vehicle')
        self.phone_complete(resume);await asyncio.sleep(.03)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.llm.request_turns,[2])
        self.assertFalse(self.s.playback.finish_requested)

    async def test_brief_ack_after_interruption_restores_question_once_after_silence(self):
        self.c.interruption_resume_wait=.02
        topic,original=await self.interrupted_plan()
        await self.run_turn('Отлично.')
        self.c.player.queue_frame.assert_not_awaited()
        await asyncio.sleep(.06)
        self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.assertEqual(self.c.question_ledger['plan:'+topic]['retry_of'],original)
        self.assertEqual(self.c.asked[topic],1)

    async def test_delayed_question_resume_waits_for_physical_speech(self):
        self.c.interruption_resume_wait=.01
        topic,original=await self.interrupted_plan();await self.run_turn('Угу.')
        self.monitor.segment_start=time.monotonic();await asyncio.sleep(.04)
        self.c.player.queue_frame.assert_not_awaited()
        self.monitor.segment_start=None;await asyncio.sleep(.04)
        self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_explicit_hold_cancels_delayed_interrupted_question_resume(self):
        self.c.interruption_resume_wait=.02
        topic,original=await self.interrupted_plan();await self.run_turn('Отлично.')
        await self.c.new_input()
        await self.run_turn('Мне нужна небольшая пауза.',control='wait')
        await asyncio.sleep(.05)
        self.c.player.queue_frame.assert_not_awaited();self.assertEqual(self.c.line.state,'waiting_operator')

    async def test_accepted_ack_preserves_continuation_after_native_answer(self):
        ledger=await self.pending_answer()
        await self.c.new_input();self.s.evidence.turn=2;self.monitor.turn=Turn(False,number=2)
        await self.run_turn('Отлично.')
        self.phone_complete('native');await asyncio.sleep(.04)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[self.keys[0]])
        self.assertEqual(self.c.llm.request_turns,[1])

    async def test_ack_before_native_completion_does_not_answer_the_original_question_twice(self):
        self.c.started=True
        self.c.inputs.add('Для кого подбираете?',1);self.c.active_batch=self.c.inputs.snapshot()
        await self.run_turn('Для кого подбираете?',other_questions=True,coverage={'availability':'answered'})
        await self.c.new_input();self.s.evidence.turn=2;self.monitor.turn=Turn(False,number=2)
        self.c.inputs.add('Отлично.',2);self.c.active_batch=self.c.inputs.snapshot()
        await self.run_turn('Для кого подбираете? Отлично.')
        self.assertEqual(self.c.latest_input,'Отлично.')
        self.c.llm.spoken_text['native']='Для себя.'
        self.phone_complete('native');await self.c.fallback_done('native');await asyncio.sleep(.04)
        self.assertEqual(self.c.llm.request_turns,[1])
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts[self.keys[0]])

    async def test_scheduled_question_resume_never_repeats_an_answered_topic(self):
        self.c.interruption_resume_wait=.02
        topic,original=await self.interrupted_plan();await self.run_turn('Отлично.')
        await self.c.new_input()
        await self.run_turn('По выходным работаем.',coverage={topic:'answered'})
        await asyncio.sleep(.04)
        self.assertFalse(any(event['event']=='semantic_question_replayed' for event in self.s.evidence.events))
        self.assertEqual(self.c.answers[topic]['status'],'answered')

    async def test_audio_repair_preserves_question_identity_and_uses_the_new_playback_ack(self):
        self.confirmed_booking();self.c.answers[self.keys[0]]={'status':'answered'}
        topic=self.keys[-1];await self.c.speak(topic);original=self.c.last_clip['response_id']
        await self.run_turn('Последний вопрос не расслышала, повторите.',control='audio_repair')
        repeated=self.c.question_ledger['plan:'+topic]['response_id']
        self.assertNotEqual(repeated,original)
        self.assertEqual(self.c.question_ledger['plan:'+topic]['retry_of'],original)
        self.assertEqual(self.c.asked[topic],1)
        self.phone_complete(repeated)
        await self.run_turn('Поняла.',visit='none')
        self.assertTrue(self.s.playback.finish_requested)

    async def test_pending_transcription_blocks_progress_after_a_completed_answer(self):
        self.confirmed_booking()
        await self.run_turn('Вы на связи?',control='attention');resume=self.c.last_clip['response_id']
        self.c.llm.quality_tasks={2:object()};self.phone_complete(resume)
        await asyncio.sleep(.03);self.assertEqual(self.c.player.queue_frame.await_count,1)
        self.c.llm.quality_tasks={};await asyncio.sleep(.03)
        self.assertEqual(self.c.player.queue_frame.await_count,2)

    async def test_completed_manager_statement_resumes_interrupted_question_after_our_reply(self):
        topic,original=await self.interrupted_plan()
        await self.run_turn('На осмотре можем поднять машину на подъёмнике.',contextual_reply=True)
        self.assertEqual(self.c.pending_after_native[0],'advance')
        self.c.llm.spoken_text['receipt']='Хорошо, понял.'
        self.phone_complete('receipt');await self.c.fallback_done('receipt');await asyncio.sleep(.04)
        self.assertEqual(self.c.question_ledger['plan:'+topic]['retry_of'],original)
        self.assertEqual(self.c.asked[topic],1)

    def quick_fragment_recovery(self):
        recovery=self.c.fragment_recovery
        recovery.quiet_seconds=.01;recovery.repair_seconds=.04;recovery.max_wait=.12
        self.c.started=True
        return recovery

    async def test_call_1526_fragmented_tradein_question_recovers_without_connection_check(self):
        self.quick_fragment_recovery()
        self.s.context={'subjectTitle':'Toyota Land Cruiser Prado','customerNeed':'Сдать Весту 2018 года с пробегом 130000 км.'}
        for turn,text in enumerate(['Да, скидка есть. Какую машину планируете?','Задачи.','Придым.'],1):
            self.c.inputs.add(text,turn)
        self.c.active_batch=self.c.inputs.snapshot();self.s.evidence.turn=3;self.monitor.turn=Turn(False,number=3)
        text=' '.join(row['text'] for row in self.c.active_batch)
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock(return_value='own_vehicle')) as review:
            await self.run_turn(text,control='fragment',other_questions=True,reply_focus='selected_subject')
            self.assertFalse(self.c.llm.request_turns)
            await asyncio.sleep(.05)
        review.assert_awaited_once()
        self.assertEqual(self.c.last_meaning['reply_focus'],'own_vehicle')
        self.assertEqual(self.c.llm.request_turns,[3])
        self.assertIn('СЕЙЧАС вопрос о твоей нынешней машине',self.c.fallback_goal)
        self.assertEqual(len(self.c.pending_after_native[3]),3)

    async def test_real_unfinished_tail_requests_repetition_and_keeps_fragments(self):
        self.quick_fragment_recovery();self.c.inputs.add('Состояние отличное. ДТП автомобиль',1)
        self.c.active_batch=self.c.inputs.snapshot()
        await self.run_turn('Состояние отличное. ДТП автомобиль',control='fragment',coverage={self.keys[0]:'answered'})
        await asyncio.sleep(.08)
        self.assertEqual(self.c.llm.request_turns,[])
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['stt_repair'])
        self.assertEqual(len(self.c.inputs.snapshot()),1)
        self.assertEqual(self.c.answers[self.keys[0]]['status'],'answered')
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_fragment_timer_does_not_interrupt_a_short_pause_inside_a_question(self):
        recovery=self.quick_fragment_recovery();recovery.quiet_seconds=.06
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock()) as review:
            await self.run_turn('Какую машину вы',control='fragment')
            await asyncio.sleep(.01)
            await self.c.new_input();self.monitor.turn=Turn(False,number=2);self.s.evidence.turn=2
            await self.run_turn('Какую машину вы хотите сдать в трейд-ин?',other_questions=True,reply_focus='own_vehicle')
            await asyncio.sleep(.08)
        review.assert_not_awaited();self.assertEqual(self.c.llm.request_turns,[2])

    async def test_pending_asr_prevents_fragment_review_and_speech(self):
        self.quick_fragment_recovery();self.c.llm.stt_tasks={1:object()};self.c.llm.quality_tasks={1:object()}
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock()) as review:
            await self.run_turn('Какую машину планируете?',control='fragment')
            await asyncio.sleep(.06)
        review.assert_not_awaited();self.c.player.queue_frame.assert_not_awaited()
        self.assertFalse(self.c.llm.request_turns)

    async def test_physical_speech_blocks_fragment_recovery_even_with_logical_speech_false(self):
        self.quick_fragment_recovery()
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock(return_value='own_vehicle')) as review:
            await self.run_turn('Какую машину планируете?',control='fragment')
            self.monitor.segment_start=time.monotonic()
            await asyncio.sleep(.06)
        review.assert_not_awaited();self.c.player.queue_frame.assert_not_awaited()

    async def test_new_input_during_fragment_review_discards_the_old_result(self):
        self.quick_fragment_recovery();started=asyncio.Event();release=asyncio.Event()
        async def slow(*args):
            started.set();await release.wait();return 'own_vehicle'
        with patch('fragment_recovery.review_fragment_question',new=slow):
            await self.run_turn('Какую машину планируете?',control='fragment')
            await asyncio.wait_for(started.wait(),.2)
            await self.c.new_input();release.set();await asyncio.sleep(.02)
        self.assertFalse(self.c.llm.request_turns);self.c.player.queue_frame.assert_not_awaited()

    async def test_ignored_noise_restores_fragment_recovery_without_losing_the_question(self):
        self.quick_fragment_recovery()
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock(return_value='own_vehicle')):
            await self.run_turn('Какую машину планируете?',control='fragment')
            await self.c.new_input();self.monitor.turn=Turn(False,number=2);self.s.evidence.turn=2
            await self.c.on_ignored_input(self.monitor.turn);await asyncio.sleep(.05)
        self.assertEqual(self.c.llm.request_turns,[2])
        self.assertEqual(self.c.latest_input,'Какую машину планируете?')

    async def test_explicit_semantic_hold_has_no_fragment_deadline(self):
        self.quick_fragment_recovery()
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock()) as review:
            await self.run_turn('Мне нужна небольшая пауза.',control='wait')
            await asyncio.sleep(.06)
        self.assertEqual(self.c.line.state,'waiting_operator')
        review.assert_not_awaited();self.c.player.queue_frame.assert_not_awaited()

    async def test_fragment_review_failure_requests_repetition_instead_of_silence(self):
        self.quick_fragment_recovery()
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock(side_effect=TimeoutError)):
            await self.run_turn('Какую машину вы',control='fragment')
            await asyncio.sleep(.08)
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['stt_repair'])
        self.assertFalse(self.c.llm.request_turns)

    async def test_focused_fragment_hold_prevents_answer_and_repair(self):
        self.quick_fragment_recovery()
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock(return_value='hold')):
            await self.run_turn('Уточню вопрос у коллеги.',control='fragment')
            await asyncio.sleep(.07)
        self.assertEqual(self.c.line.state,'waiting_operator')
        self.c.player.queue_frame.assert_not_awaited();self.assertFalse(self.c.llm.request_turns)

    async def test_same_fragment_does_not_loop_repair_or_api_requests(self):
        self.quick_fragment_recovery()
        with patch('fragment_recovery.review_fragment_question',new=AsyncMock(return_value='clarify')) as review:
            await self.run_turn('Какую машину вы',control='fragment')
            await asyncio.sleep(.08)
            await self.run_turn('Какую машину вы',control='fragment')
            await asyncio.sleep(.08)
        review.assert_awaited_once();self.assertEqual(self.c.player.queue_frame.await_count,1)

    async def test_closing_session_cancels_fragment_recovery(self):
        self.quick_fragment_recovery()
        await self.run_turn('Какую машину вы',control='fragment')
        await self.c.close();await asyncio.sleep(.05)
        self.c.player.queue_frame.assert_not_awaited();self.assertFalse(self.c.llm.request_turns)

    async def test_missed_answer_is_reviewed_before_automatic_question_replay(self):
        topic,original=await self.interrupted_plan()
        self.s.evidence.turn=2
        self.s.evidence.memory.user('По выходным работаем. А вы из какого города?',2)
        self.c.latest_input='По выходным работаем. А вы из какого города?'
        self.c.last_meaning=meaning(other_questions=True)
        with patch('semantic_controller.review_answer_coverage',new=AsyncMock(return_value='answered')) as review:
            await self.c.perform('advance',self.c.latest_input,self.c.epoch)
        review.assert_awaited_once()
        self.assertEqual(self.c.answers[topic]['status'],'answered')
        self.assertNotIn(topic,[row['key'] for row in self.c.unasked()])
        self.assertFalse(any(event['event']=='semantic_question_replayed' for event in self.s.evidence.events))
        self.assertTrue(self.c.player.queue_frame.call_args_list)  # The next plan question proceeds.

    async def test_reviewed_unknown_does_not_become_a_positive_seller_fact(self):
        topic,original=await self.interrupted_plan();self.s.evidence.turn=2
        self.s.evidence.memory.user('Не могу сказать, работают ли коллеги по выходным.',2)
        self.c.latest_input='Не могу сказать, работают ли коллеги по выходным.'
        with patch('semantic_controller.review_answer_coverage',new=AsyncMock(return_value='unknown')):
            await self.c.perform('advance',self.c.latest_input,self.c.epoch)
        self.assertEqual(self.c.answers[topic]['status'],'unknown')
        self.assertFalse(any(event['event']=='semantic_question_replayed' for event in self.s.evidence.events))
        self.assertFalse(self.s.evidence.memory.facts)

    async def test_new_input_during_answer_review_cannot_replay_the_old_question(self):
        topic,original=await self.interrupted_plan();self.s.evidence.turn=2
        self.s.evidence.memory.user('Ответ на вопрос.',2);self.c.latest_input='Ответ на вопрос.'
        async def stale(*args):
            self.c.epoch+=1
            return 'answered'
        with patch('semantic_controller.review_answer_coverage',new=stale):
            await self.c.perform('advance',self.c.latest_input,self.c.epoch)
        self.assertNotIn(topic,self.c.answers)
        self.c.player.queue_frame.assert_not_awaited()

    async def test_answer_review_only_uses_accepted_manager_speech_after_the_question(self):
        self.s.evidence.memory.user('По выходным работаем.',0)
        topic,original=await self.interrupted_plan();self.s.evidence.turn=2
        self.s.evidence.memory.user('А вы из какого города?',2)
        self.c.customer_legend=[{'text':'По выходным я свободен.'}]
        self.c.latest_input='А вы из какого города?'
        row=self.c.unfinished_question()
        with patch('semantic_controller.review_answer_coverage',new=AsyncMock(return_value='unanswered')) as review:
            await self.c.review_before_replay(row,self.c.epoch)
        self.assertEqual(review.call_args.args[2],'А вы из какого города?')
        self.assertNotIn(topic,self.c.answers)

    async def test_answer_review_is_deduplicated_and_has_a_per_call_budget(self):
        topic,original=await self.interrupted_plan();row=self.c.unfinished_question()
        with patch('semantic_controller.review_answer_coverage',new=AsyncMock(return_value='unanswered')) as review:
            for turn in range(2,8):
                self.s.evidence.turn=turn;self.s.evidence.memory.user('Проверяем вариант '+str(turn),turn)
                await self.c.review_before_replay(row,self.c.epoch)
                await self.c.review_before_replay(row,self.c.epoch)
        self.assertEqual(review.await_count,4)
        self.assertFalse(self.c.answers)

    async def test_answer_review_failure_does_not_save_facts_or_disable_the_plan(self):
        topic,original=await self.interrupted_plan();self.s.evidence.turn=2
        self.s.evidence.memory.user('А вы из какого города?',2);self.c.latest_input='А вы из какого города?'
        with patch('semantic_controller.review_answer_coverage',new=AsyncMock(side_effect=TimeoutError)):
            await self.c.perform('advance',self.c.latest_input,self.c.epoch)
        self.assertNotIn(topic,self.c.answers)
        self.assertTrue(any(event['event']=='semantic_question_replayed' for event in self.s.evidence.events))
        self.assertTrue(any(event['event']=='semantic_answer_review_failed' for event in self.s.evidence.events))

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
        for _ in range(3):await self.run_identity_turn('Как к вам обращаться?')
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

    async def run_identity_turn(self,text):
        self.s.evidence.memory.user(text,self.s.evidence.turn)
        with patch('semantic_controller.interpret',new=AsyncMock()) as model:
            await self.c.handle(text,self.s.evidence.turn,self.c.epoch)
        model.assert_not_awaited()

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

    async def test_connection_check_after_exhausted_retry_restores_the_interrupted_question(self):
        topic=await self.exhausted_question()
        await self.run_turn('Слышно меня?',control='attention')
        text=self.c.player.queue_frame.call_args.args[0].text
        self.assertIn(self.c.texts['resume'],text)
        self.assertIn(self.c.texts[topic],text)
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
        self.assertEqual(self.c.pending_after_native[0],'advance')
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
        await self.run_identity_turn('Как вас зовут?')
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
        # This test exercises dialogue after the operator resumes. Line
        # recognition has its own tests and must not make a real API request.
        self.c.line.cancel();self.c.line.state='live'
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
        self.assertIn('О прошлом общении с менеджером отвечай ТОЛЬКО на прямой вопрос',self.c.fallback_goal)

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
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}),patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)) as synthesize:
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
        self.assertIn('другой день',self.c.player.queue_frame.call_args.args[0].text)

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

    async def test_semantic_interpretation_cannot_emit_hesitation_before_meaning(self):
        c=self.c;c.started=True;c.current=self.keys[0]
        c.last_question={'topic':self.keys[0],'text':self.c.texts[self.keys[0]]}
        c.latest_input='В объявлении пробег указан верно.'
        c.thinking.delay_ms=c.thinking.semantic_delay_ms=1
        c.thinking.arm('semantic_interpretation');await asyncio.sleep(.02)
        c.player.queue_frame.assert_not_awaited()
        self.assertFalse(any(e['event']=='thinking_pause_emitted' for e in self.s.evidence.events))
        self.assertIsNone(c.last_clip)

    async def test_semantic_generation_gets_its_own_wait_deadline_after_interpretation(self):
        c=self.c;c.started=True
        old=c.thinking.arm('semantic_interpretation')
        old['started']=time.monotonic()-10
        job=c.thinking.arm('native_reply')
        self.assertIsNot(job,old)
        self.assertEqual(job['source'],'native_reply')
        self.assertLess(time.monotonic()-job['started'],1)
        self.assertFalse(job['emitted'])

    async def test_filler_handoff_waits_for_phone_end_after_sending_finishes(self):
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
        await asyncio.sleep(.02);self.assertFalse(task.done())
        c.s.evidence.delivery.ack('tag-filler')
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
