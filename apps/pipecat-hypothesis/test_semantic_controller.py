import asyncio
import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock,patch

from conversation import ConversationMemory
from dialogue_controller import DialogueController
from semantic_controller import SemanticController
from pipeline import Turn
from policy import Evidence,Playback
from turn_meaning import interpret,payload,pick,acceptance_scope

PROMPT='1. Возможна доставка по области? [обязательная тема]\n2. Работаете в выходные? [обязательная тема]'


def meaning(**kwargs):
    return {'control':'continue','name':False,'subject':False,'other_questions':False,'next_question':False,
        'visit':'none','acceptance_scope':'other','coverage':{},**kwargs}


class SemanticTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        name=patch('semantic_controller.choose_name',return_value='Андрей');name.start();self.addCleanup(name.stop)
        self.s=SimpleNamespace(prompt=PROMPT,context={'subjectTitle':'Тестовый объект'},backchannel=True,
            tts_model='eleven_v4_turbo',voice_id='test',evidence=Evidence(),playback=Playback(),
            finalized=False,status='connected',dialogue_mode='semantic')
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
        self.assertEqual(self.c.player.queue_frame.call_args.args[0].text,self.c.texts['visit_pending'])
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

    async def test_ordinary_queued_question_is_not_automatically_repeated(self):
        self.c.started=True;await self.c.speak(self.keys[-1])
        self.c.answers={key:{} for key in self.keys[:-1]}
        await self.offer()
        await self.run_turn('Да, удобно.',visit='accept',acceptance_scope='direct_reply')
        self.assertTrue(self.s.playback.finish_requested)

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

    async def test_topic_refusal_cannot_be_used_as_permission_to_end_call(self):
        body=payload(self.c,'Ограничение обсуждения отдельной темы')
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}} for key,q in body['questions'].items()}
        answers['control']={'choice':'decline','probabilities':{'decline':.99,'continue':.01}}
        answers['end_permission']={'choice':'no','probabilities':{'yes':.01,'no':.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,'Ограничение обсуждения отдельной темы')
        self.assertEqual(result['control'],'continue')
