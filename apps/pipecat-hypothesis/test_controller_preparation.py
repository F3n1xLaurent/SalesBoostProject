import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
from controller_preparation import prepare_questions,valid_shape,varied_fallback,_last
from policy import Evidence

class BankTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _last.clear()
        self.s=SimpleNamespace(id='synthetic-call',evidence=Evidence())
        self.questions=[{'key':'accidents','question':'Были ли ДТП?'},{'key':'mileage','question':'Пробег актуальный?'}]

    async def test_generation_is_per_call_and_only_verified_wording_is_used(self):
        generated={'accidents':'Скажите, ДТП у машины были?','mileage':'Пробег в объявлении актуальный?'}
        verdict={'accidents':{'choice':'safe','probabilities':{'safe':.98,'unsafe':.02}},'mileage':{'choice':'unsafe','probabilities':{'safe':.01,'unsafe':.99}}}
        with patch('controller_preparation.generate_questions',new=AsyncMock(return_value=generated)) as gen,patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)):
            first=await prepare_questions(self.s,self.questions,None)
            second=await prepare_questions(self.s,self.questions,None)
        self.assertEqual(gen.await_count,2)
        self.assertEqual(first['accidents'],generated['accidents'])
        self.assertNotEqual(second['accidents'],first['accidents'])
        self.assertNotEqual(first['mileage'],generated['mileage'])
        self.assertEqual(set(first),{'accidents','mileage'})

    async def test_provider_failure_retains_all_topics_and_conditions(self):
        q=[{'key':'discount','question':'Будет ли скидка 7 процентов при оплате наличными?'}]
        with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=TimeoutError)):
            result=await prepare_questions(self.s,q,None)
        self.assertIn(q[0]['question'].casefold(),result['discount'].casefold())
        self.assertTrue(any(e['event']=='controller_question_generation_fallback' for e in self.s.evidence.events))

    async def test_incomplete_bank_falls_back_without_dropping_topics(self):
        with patch('controller_preparation.generate_questions',new=AsyncMock(return_value={'accidents':'Были ли ДТП?'})):
            result=await prepare_questions(self.s,self.questions,None)
        self.assertEqual(set(result),{'accidents','mileage'})

    async def test_subject_is_extracted_from_plan_questions_in_the_existing_request(self):
        self.s.context={};self.s.prompt='Потребность клиента: Покупка в кредит'
        rows=[{'key':'custom:0','question':'Toyota RAV4 2018года ещё в продаже?'}]
        async def generate(*args,**kwargs):
            self.assertIn('Toyota RAV4',kwargs['subject_data']['script_references'][0])
            kwargs['subject_result']['value']='Toyota RAV4 2018'
            return {'custom:0':'Скажите, Toyota RAV4 2018года ещё в продаже?'}
        verdict={'custom:0':{'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}},
            '__scenario_subject__':{'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}}}
        with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)) as gen,patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)):
            await prepare_questions(self.s,rows,None)
        gen.assert_awaited_once()
        self.assertEqual(self.s.prepared_subject,'Toyota RAV4 2018')

    async def test_subject_invented_outside_sources_is_never_saved(self):
        self.s.context={};self.s.prompt='Потребность клиента: Покупка в кредит'
        rows=[{'key':'custom:0','question':'Toyota RAV4 2018года ещё в продаже?'}]
        async def generate(*args,**kwargs):
            kwargs['subject_result']['value']='Новый Toyota RAV4 2026'
            return {'custom:0':'Toyota RAV4 2018года ещё в продаже?'}
        with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value={})):
            await prepare_questions(self.s,rows,None)
        self.assertIsNone(self.s.prepared_subject)

    async def test_exact_plan_copy_is_not_used_as_a_new_variant(self):
        generated={r['key']:r['question'] for r in self.questions}
        verdict={key:{'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}} for key in generated}
        with patch('controller_preparation.generate_questions',new=AsyncMock(return_value=generated)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)):
            result=await prepare_questions(self.s,self.questions,None)
        for key,text in result.items():self.assertNotEqual(text,generated[key])

    def test_question_wording_rejects_caption_style_but_preserves_clock(self):
        self.assertFalse(valid_shape('Пороги целые?','По порогам: есть коррозия?','rust'))
        self.assertTrue(valid_shape('Можно приехать в 14:00?','Подскажите, можно приехать в 14:00?','custom:0'))

    def test_structural_validation_rejects_changed_numbers_or_topic(self):
        self.assertFalse(valid_shape('Скидка 7 процентов?','Скидка 10 процентов?','discount'))
        self.assertFalse(valid_shape('Были ли ДТП?','Можно ли приехать завтра?','accidents'))
        self.assertFalse(valid_shape('Были ли ДТП?','Были ли ДТП? Как пробег?','accidents'))
        self.assertTrue(valid_shape('Были ли ДТП?','Подскажите, ДТП были?','accidents'))
        self.assertFalse(valid_shape('Пробег актуальный?','Какой пробег у машины сейчас?','mileage'))
        self.assertFalse(valid_shape('Были ли ДТП?','Были ли ДТП и какие повреждения?','accidents'))
        self.assertFalse(valid_shape('Можете сделать скидку?','Какой размер скидки?','discount'))
        self.assertFalse(valid_shape('Скидка при оплате наличными?','Можно обсудить скидку?','discount'))
        self.assertFalse(valid_shape('Сколько владел последний владелец?','Как долго владелец пользовался машиной?','ownership'))
        self.assertFalse(valid_shape('В объявлении пробег актуальный?','Пробег актуальный?','mileage'))
