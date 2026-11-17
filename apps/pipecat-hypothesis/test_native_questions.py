import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from conversation import ConversationMemory
from dialogue_controller import DialogueController
from pipeline import GatedRealtime, Turn
from semantic_controller import SemanticController
from policy import Evidence, Playback


class NativeQuestionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        prompt = 'Можно заказать доставку? [обязательная тема]\nКаков срок доставки? [обязательная тема]'
        evidence = Evidence()
        evidence.memory = ConversationMemory(prompt)
        evidence.turn = evidence.output_turn = 1
        self.s = SimpleNamespace(evidence=evidence, playback=Playback(), finalized=False, backchannel=False, prompt=prompt)
        self.monitor = SimpleNamespace(turn=Turn(False, number=1), segment_start=None)
        self.c = DialogueController(self.s, SimpleNamespace(queue_cleared_event=asyncio.Event()), self.monitor)
        self.s.controller = self.c
        self.llm = GatedRealtime(self.s, self.monitor, api_key='test')
        self.c.llm = self.llm
        self.c.player = SimpleNamespace(queue_frame=AsyncMock())
        self.c.texts = {r['key']: r['question'] for r in evidence.memory.topics.required}
        self.c.clips = {k: b'\0\0' * 1600 for k in self.c.texts}
        self.c.latest_input = 'Доставку выполняет курьер.'
        self.gate = self.c.native_questions
        self.gate.classify = AsyncMock(return_value=self.decision())

    async def asyncTearDown(self):
        await self.c.close()

    async def test_native_stream_cannot_repeat_prepared_status_but_releases_new_answer(self):
        serializer=self.c.serializer;await self.c.close()
        self.c=SemanticController(self.s,serializer,self.monitor);self.s.controller=self.c
        self.c.line.state='live';self.c.line.ever_human=True
        self.c.llm=self.llm;self.c.player=SimpleNamespace(queue_frame=AsyncMock())
        self.c.texts={'status':'По времени пока не определились.'};self.c.clips={'status':b'\xd0\x07'*1600}
        self.llm.send_client_event=AsyncMock()
        await self.c.speak('status')
        with patch.object(GatedRealtime.__bases__[0],'_handle_evt_text_delta',new=AsyncMock()) as emitted:
            await self.llm.release_speech('native','По времени пока не определились. Со способом оплаты ещё не определился.',final=True)
        self.assertEqual(emitted.await_count,1)
        self.assertIn('Со способом оплаты',emitted.call_args.args[0].delta)
        self.assertNotIn('По времени',self.llm.spoken_text['native'])

    async def test_spoken_reply_excludes_generation_narration_but_keeps_actual_answer(self):
        with patch.object(GatedRealtime.__bases__[0],'_handle_evt_text_delta',new=AsyncMock()) as emitted:
            await self.llm.release_speech('r','Я сейчас коротко реагирую на предложение и своё решение по осмотру. Идея подходит, пробная поездка поможет определиться.',final=True)
        self.assertEqual(emitted.await_count,1)
        self.assertEqual(self.llm.spoken_text['r'],' Идея подходит, пробная поездка поможет определиться.')

    async def test_first_person_fact_is_not_mistaken_for_generation_narration(self):
        with patch.object(GatedRealtime.__bases__[0],'_handle_evt_text_delta',new=AsyncMock()) as emitted:
            await self.llm.release_speech('r','Я отвечаю за подготовку автомобиля.',final=True)
        self.assertEqual(emitted.await_count,1)

    @staticmethod
    def decision(relation='new', suitability='appropriate', probability=.98):
        return {'relation': {'choice': relation, 'probabilities': {relation: probability}},
                'suitability': {'choice': suitability, 'probabilities': {suitability: .98}}}

    async def release(self, text, response_id='r', final=True):
        with patch.object(GatedRealtime.__bases__[0], '_handle_evt_text_delta', new=AsyncMock()) as emitted:
            await self.llm.release_speech(response_id, text, final=final)
        return [call.args[0].delta for call in emitted.call_args_list]

    async def test_native_first_text_keeps_thinking_clip_until_pcm(self):
        self.s.backchannel=True;self.c.thinking.delay_ms=500
        job=self.c.thinking.arm('native_reply')
        self.c.playing_id='backchannel-test';self.c.playing_kind='backchannel'
        with patch.object(self.c,'stop_backchannel',new=AsyncMock()) as stop, patch.object(GatedRealtime.__bases__[0], '_handle_evt_text_delta',new=AsyncMock()):
            await self.llm._handle_evt_text_delta(SimpleNamespace(response_id='native',item_id='item',delta='Для личных поездок.'))
        stop.assert_not_awaited()
        self.assertEqual(self.c.playing_id,'backchannel-test')
        self.assertIs(self.c.thinking.current,job)
        self.assertEqual(self.s.evidence.current_response_id,'native')

    async def test_new_appropriate_question_is_released_and_registered(self):
        emitted = await self.release('Можно получить номер отслеживания?')
        self.assertEqual(emitted, ['Можно получить номер отслеживания?'])
        identity = self.c.last_question['question_id']
        self.assertTrue(identity.startswith('native:'))
        self.assertEqual(self.c.question_ledger[identity]['state'], 'tts_released')
        self.assertIsNone(self.c.last_question['topic'])
        self.assertFalse(self.c.answers)

    async def test_exact_repeated_native_question_is_blocked_without_classifier(self):
        await self.release('Можно отследить курьера?', 'first')
        self.gate.classify.reset_mock()
        self.assertEqual(await self.release('Можно отследить курьера?', 'second'), [])
        self.gate.classify.assert_not_awaited()

    async def test_exact_cached_plan_repeat_is_blocked_without_classifier(self):
        await self.c.speak('custom:0', mirror=False)
        self.assertEqual(await self.release(self.c.texts['custom:0']), [])
        self.gate.classify.assert_not_awaited()

    async def test_unpunctuated_question_and_request_also_require_approval(self):
        self.gate.classify.return_value = self.decision(suitability='inappropriate')
        for text in ['Как получить номер отслеживания.', 'Какая стоимость подъёма.', 'Пришлите протокол.']:
            with self.subTest(text=text):
                self.assertEqual(await self.release(text, response_id=text), [])
        self.assertEqual(self.gate.classify.await_count, 3)

    async def test_declarative_answer_is_not_delayed_by_question_validation(self):
        self.assertEqual(await self.release('Как правило, езжу за город.'), ['Как правило, езжу за город.'])
        self.gate.classify.assert_not_awaited()

    async def test_paraphrase_of_asked_plan_question_never_reaches_tts(self):
        await self.c.speak('custom:0', mirror=False)
        self.gate.classify.return_value = self.decision('known_0')
        self.assertEqual(await self.release('Доставка возможна?'), [])
        self.assertEqual(self.c.asked['custom:0'], 1)
        self.assertNotIn('custom:0', self.c.answers)
        self.assertEqual(self.s.evidence.events[-2]['reason'], 'already_asked_or_reserved')

    async def test_unasked_plan_question_shares_identity_with_cached_path(self):
        self.gate.classify.return_value = self.decision('known_0')
        self.assertEqual(await self.release('Доставка возможна?'), ['Доставка возможна?'])
        self.assertIn('plan:custom:0', self.c.question_ledger)
        self.assertIsNone(await self.c.speak('custom:0', mirror=False))
        self.assertEqual(self.c.asked['custom:0'], 1)

    async def test_native_time_question_blocks_same_cached_visit_question(self):
        self.c.answers={r['key']:{} for r in self.c.pending()}
        index=next(i for i,r in enumerate(self.gate.known_questions()) if r['id']=='visit-field:time')
        self.gate.classify.return_value=self.decision('known_'+str(index))
        self.assertEqual(await self.release('Во сколько можно приехать?'), ['Во сколько можно приехать?'])
        self.c.texts['visit']='Когда можно подъехать посмотреть?';self.c.clips['visit']=b'\0\0'*1600
        self.assertIsNone(await self.c.speak('visit',mirror=False))

    async def test_visit_question_is_rejected_while_required_topics_remain(self):
        index=next(i for i,r in enumerate(self.gate.known_questions()) if r['id']=='visit-field:time')
        self.gate.classify.return_value=self.decision('known_'+str(index))
        self.assertEqual(await self.release('Во сколько можно приехать?'), [])
        self.assertFalse(self.c.question_ledger)

    async def test_later_plan_topic_is_not_requested_prematurely(self):
        self.gate.classify.return_value = self.decision('known_1')
        self.assertEqual(await self.release('Когда доставят?'), [])
        self.assertFalse(self.c.question_ledger)

    async def test_already_answered_fact_and_irrelevant_question_are_rejected(self):
        for suitability in ('inappropriate', 'unclear'):
            with self.subTest(suitability=suitability):
                self.gate.classify.return_value = self.decision(suitability=suitability)
                self.assertEqual(await self.release('Сколько стоит подъём на этаж?', response_id=suitability), [])
        self.assertFalse(self.c.question_ledger)

    async def test_novelty_and_suitability_have_distinct_acceptance_thresholds(self):
        decision=self.decision()
        decision['suitability']['probabilities']['appropriate']=.84
        self.gate.classify.return_value=decision
        self.assertEqual(await self.release('Можно отследить курьера?'),['Можно отследить курьера?'])
        decision=self.decision()
        decision['suitability']['probabilities']={'appropriate':.51,'inappropriate':.40,'unclear':.09}
        self.gate.classify.return_value=decision
        self.assertEqual(await self.release('Как связаться с диспетчером?','second'),[])

    async def test_uncertain_and_malformed_matches_fail_closed(self):
        for relation, probability in [('unclear', .98), ('new', .84), ('known_-1', .99), ('known_99', .99)]:
            with self.subTest(relation=relation):
                self.gate.classify.return_value = self.decision(relation, probability=probability)
                self.assertEqual(await self.release('Можно отследить курьера?', response_id=relation), [])
        self.assertFalse(self.c.question_ledger)

    async def test_provider_timeout_keeps_answer_and_discards_question(self):
        self.gate.classify.side_effect = httpx.ReadTimeout('test')
        self.assertEqual(await self.release('Спасибо. Можно отследить курьера?'), ['Спасибо.'])
        self.assertEqual(self.llm.spoken_text['r'], 'Спасибо.')
        self.assertFalse(self.c.question_ledger)

    async def test_answer_streams_before_question_validation_and_order_is_preserved(self):
        entered, resume = asyncio.Event(), asyncio.Event()

        async def classify(*_):
            entered.set()
            await resume.wait()
            return self.decision()

        self.gate.classify.side_effect = classify
        with patch.object(GatedRealtime.__bases__[0], '_handle_evt_text_delta', new=AsyncMock()) as emitted:
            task = asyncio.create_task(self.llm.release_speech('r', 'Спасибо. Можно отследить курьера? Это важно.', final=True))
            await entered.wait()
            self.assertEqual([c.args[0].delta for c in emitted.call_args_list], ['Спасибо.'])
            resume.set()
            await task
        self.assertEqual(self.llm.spoken_text['r'], 'Спасибо. Можно отследить курьера? Это важно.')

    async def test_long_partial_question_cannot_leak_before_its_final_punctuation(self):
        partial='Можно получить '+('подробный ' * 25)+'протокол'
        self.assertGreater(len(partial),200)
        self.assertEqual(await self.release('Спасибо. '+partial,final=False),['Спасибо.'])
        self.gate.classify.assert_not_awaited()
        self.assertEqual(await self.release('?',final=True),[' '+partial+'?'])
        self.gate.classify.assert_awaited_once()

    async def test_partial_question_is_not_submitted_or_released_early(self):
        self.assertEqual(await self.release('Спасибо. Можно отследить', final=False), ['Спасибо.'])
        self.gate.classify.assert_not_awaited()
        self.assertEqual(await self.release(' курьера?', final=False), [' Можно отследить курьера?'])
        self.gate.classify.assert_awaited_once()

    async def test_new_user_turn_during_validation_discards_question_and_stale_suffix(self):
        async def classify(*_):
            await self.c.new_input()
            return self.decision()

        self.gate.classify.side_effect = classify
        self.assertEqual(await self.release('Спасибо. Можно отследить курьера? Договорились.'), ['Спасибо.'])
        self.assertFalse(self.c.question_ledger)

    async def test_concurrent_cached_question_invalidates_semantic_snapshot(self):
        async def classify(*_):
            await self.c.speak('custom:0', mirror=False)
            return self.decision()

        self.gate.classify.side_effect = classify
        self.assertEqual(await self.release('Можно отследить курьера?'), [])
        self.assertEqual(len([k for k in self.c.question_ledger if k.startswith('native:')]), 0)

    async def test_only_one_question_can_be_released_in_a_response(self):
        self.assertEqual(await self.release('Можно отследить курьера? Как получить номер?'), ['Можно отследить курьера?'])
        self.gate.classify.assert_awaited_once()

    async def test_second_native_paraphrase_is_matched_to_dynamic_history(self):
        await self.release('Можно отследить курьера?', 'first')
        native_index=next(i for i,r in enumerate(self.gate.known_questions()) if r['id'].startswith('native:'))
        self.gate.classify.return_value = self.decision('known_'+str(native_index))
        self.assertEqual(await self.release('Как посмотреть, где сейчас курьер?', 'second'), [])
        known = self.gate.classify.call_args.args[1]
        self.assertEqual(known[native_index]['text'], 'Можно отследить курьера?')

    async def test_closing_does_not_start_question_validation(self):
        self.s.playback.finish_requested = True
        self.assertEqual(await self.release('Можно отследить курьера?'), [])
        self.gate.classify.assert_not_awaited()

    async def test_native_followup_does_not_take_over_plan_topic_by_keyword(self):
        self.c.current = 'custom:0'
        await self.release('Где вход для осмотра?')
        self.assertEqual(self.c.current, 'custom:0')
        self.assertIsNone(self.c.last_question['topic'])

    async def test_answer_to_followup_does_not_close_parent_plan_question(self):
        from unittest.mock import Mock
        self.c.started = True
        self.c.current = 'custom:0'
        self.c.asked['custom:0']=1
        await self.release('Можно получить отчёт курьера?')
        reference = dict(self.c.last_question)
        self.c.input_reference = reference
        response = Mock()
        response.json.return_value = {'answers': {
            'action': {'choice': 'advance', 'probabilities': {'advance': .98}},
            'coverage': {'choice': 'answered', 'probabilities': {'answered': .98}},
            'parent_coverage': {'choice':'answered','probabilities':{'answered':.98}},
        }}
        self.c.http.post = AsyncMock(return_value=response)
        self.s.evidence.memory.user('Да.', 1)
        with patch.dict('os.environ', {'PROXYAPI_API_KEY': 'test'}):
            await self.c.handle('Да.', 1, 0)
        self.assertNotIn('custom:0', self.c.answers)
        self.assertIn(reference['question_id'], self.c.followup_answers)

    async def test_descriptive_parent_answer_is_saved_alongside_followup_answer(self):
        from unittest.mock import Mock
        self.c.started=True;self.c.current='custom:0';self.c.asked['custom:0']=1
        self.c.speak=AsyncMock(return_value=None)
        await self.release('Можно получить отчёт курьера?')
        self.c.input_reference=dict(self.c.last_question)
        response=Mock();response.json.return_value={'answers':{
            'action':{'choice':'advance','probabilities':{'advance':.98}},
            'coverage':{'choice':'answered','probabilities':{'answered':.98}},
            'parent_coverage':{'choice':'answered','probabilities':{'answered':.98}}}}
        self.c.http.post=AsyncMock(return_value=response)
        text='Отчёт пришлём. Доставка доступна во все районы города.'
        self.s.evidence.memory.user(text,1)
        with patch.dict('os.environ',{'PROXYAPI_API_KEY':'test'}):
            await self.c.handle(text,1,0)
        self.assertIn('custom:0',self.c.answers)
        self.assertIn(self.c.input_reference['question_id'],self.c.followup_answers)
        self.assertEqual(self.c.current,'custom:1')
