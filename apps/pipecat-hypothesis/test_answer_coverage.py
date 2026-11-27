import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch

from conversation import ConversationMemory
from pipeline import Turn
from policy import Evidence,Playback
from semantic_controller import SemanticController
from turn_meaning import interpret,payload,review_answer_coverage,review_fragment_question


class CoverageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        prompt='На машине рыжики есть? [обязательная тема]\nТест-драйв возможен? [обязательная тема]'
        self.s=SimpleNamespace(prompt=prompt,context={},backchannel=False,finalized=False,
            evidence=Evidence(),playback=Playback(),dialogue_mode='semantic')
        self.s.evidence.memory=ConversationMemory(prompt)
        self.c=SemanticController(self.s,None,SimpleNamespace(turn=Turn(False,number=2),segment_start=None))
        self.c.texts={r['key']:r['question'] for r in self.s.evidence.memory.topics.required}
        self.c.texts['opening']='Машина ещё продаётся?'
        self.topic=next(iter(self.c.texts))
        self.c.last_question={'topic':self.topic,'response_id':'question','text':self.c.texts[self.topic]}
        self.c.last_clip={'response_id':'question','text':self.c.texts[self.topic]}

    async def asyncTearDown(self):await self.c.close()

    async def decision(self,text,status='answered'):
        body=payload(self.c,text)
        answers={k:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}}
            for k,q in body['questions'].items()}
        for key in answers:
            if key.startswith('coverage:'):answers[key]={'choice':status,'probabilities':{status:.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):return await interpret(self.c,text)

    async def test_short_confirmation_belongs_only_to_the_direct_question(self):
        result=await self.decision('Да, конечно.')
        self.assertEqual(result['coverage'][self.topic],'answered')
        self.assertTrue(all(value=='unanswered' for key,value in result['coverage'].items() if key!=self.topic))

    async def test_confirmation_after_identity_cannot_answer_an_older_question(self):
        self.c.last_clip={'response_id':'name','text':'Меня зовут Андрей.'}
        result=await self.decision('Да, конечно.')
        self.assertTrue(all(value=='unanswered' for value in result['coverage'].values()))
        self.assertEqual(result['response_seen'],[])

    async def test_unknown_without_a_subject_does_not_cover_every_topic(self):
        result=await self.decision('Не знаю.',status='unknown')
        self.assertEqual(result['coverage'][self.topic],'unknown')
        self.assertTrue(all(value=='unanswered' for key,value in result['coverage'].items() if key!=self.topic))

    async def test_explicit_answer_can_cover_an_unasked_topic(self):
        self.c.last_question=None;self.c.last_clip=None
        result=await self.decision('Коррозии на кузове нет.')
        self.assertEqual(result['coverage'][self.topic],'answered')

    async def test_uncertain_review_cannot_save_a_fact(self):
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':{
            'coverage':{'choice':'answered','probabilities':{'answered':.89,'unanswered':.11}}}}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):
            verdict=await review_answer_coverage(self.c,{'id':'plan:'+self.topic,'topic':self.topic,'text':'Есть ли рыжики?'},'ДТП не было.')
        self.assertEqual(verdict,'uncertain')
        self.assertFalse(self.c.answers)

    async def test_review_rejects_invalid_model_output(self):
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':{
            'coverage':{'choice':'invented','probabilities':{'invented':1}}}}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}),self.assertRaises(ValueError):
            await review_answer_coverage(self.c,{'id':'plan:'+self.topic,'topic':self.topic,'text':'Есть ли рыжики?'},'Рыжиков нет.')

    async def test_short_unbound_reply_does_not_make_an_extra_api_request(self):
        self.c.last_clip={'response_id':'identity'};self.c.http.post=AsyncMock()
        verdict=await review_answer_coverage(self.c,{'id':'plan:'+self.topic,'topic':self.topic,'text':'Есть ли рыжики?'},'Да, конечно.')
        self.assertEqual(verdict,'unanswered')
        self.c.http.post.assert_not_awaited()

    async def test_uncertain_fragment_review_requests_clarification(self):
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':{
            'resolution':{'choice':'answer','probabilities':{'answer':.84,'clarify':.16}},
            'own_vehicle':{'choice':'yes','probabilities':{'yes':.99}}}}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):
            result=await review_fragment_question(self.c,'Какую машину планируете?')
        self.assertEqual(result,'clarify')
        self.assertFalse(self.c.answers);self.assertFalse(self.s.evidence.memory.facts)

    async def test_uncertain_vehicle_binding_cannot_force_a_tradein_answer(self):
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':{
            'resolution':{'choice':'answer','probabilities':{'answer':.99}},
            'own_vehicle':{'choice':'yes','probabilities':{'yes':.84,'no':.16}}}}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):
            result=await review_fragment_question(self.c,'Какую машину планируете?')
        self.assertEqual(result,'clarify')

    async def test_invalid_fragment_review_output_is_rejected(self):
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':{
            'resolution':{'choice':'invented','probabilities':{'invented':1}}}}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}),self.assertRaises(ValueError):
            await review_fragment_question(self.c,'Какую машину планируете?')

    async def test_explicit_plan_invitation_is_not_erased_by_a_confirmation_label(self):
        text='Иван, у вас остались ко мне вопросы?';body=payload(self.c,text)
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}}
            for key,q in body['questions'].items()}
        for key,choice in [('other_questions','plan_only'),('plan_permission','yes'),('control','continue'),
                ('turn_tail','complete'),('acknowledgment_request','yes'),('confirmation_request','yes')]:
            answers[key]={'choice':choice,'probabilities':{choice:.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,text)
        self.assertTrue(result['next_question'])
        self.assertFalse(result['acknowledgment_request']);self.assertFalse(result['confirmation_request'])

    async def test_an_actual_buyer_question_keeps_its_acknowledgment_before_plan_navigation(self):
        text='Этого объяснения вам достаточно?';body=payload(self.c,text)
        answers={key:{'choice':next(iter(q['criteria'])),'probabilities':{next(iter(q['criteria'])):.99}}
            for key,q in body['questions'].items()}
        for key,choice in [('other_questions','plan_only'),('plan_permission','yes'),('control','continue'),
                ('turn_tail','complete'),('acknowledgment_request','yes'),('buyer_part:0','yes')]:
            answers[key]={'choice':choice,'probabilities':{choice:.99}}
        self.c.http.post=AsyncMock(return_value=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'answers':answers}))
        with patch.dict(os.environ,{'PROXYAPI_API_KEY':'test'}):result=await interpret(self.c,text)
        self.assertFalse(result['next_question']);self.assertTrue(result['other_questions'])
