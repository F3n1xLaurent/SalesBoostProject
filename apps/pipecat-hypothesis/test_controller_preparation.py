import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
from controller_preparation import prepare_questions,derive_scenario_topics,valid_shape,varied_fallback,_last
from policy import Evidence

class BankTests(unittest.IsolatedAsyncioTestCase):
    async def test_colour_and_engine_from_selected_feed_can_enrich_spoken_name(self):
        full='BMW 5-series 520i Luxury'
        rows=[{'key':'availability','question':full+' ещё в продаже?'}]
        safe={'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}}
        cases=[('Цвет: чёрный. Двигатель: 2.0 л, бензин.','чёрная бэха-пятёрка, двухлитровая бензиновая',True),
               ('Цвет: чёрный.','чёрная бэха-пятёрка',True),
               ('Двигатель: 2.0 л.','бэха-пятёрка, двухлитровая',True),
               ('Топливо: дизель.','БМВ пятой серии, дизельная',True),
               ('','БМВ пятой серии',True),
               ('Цвет: белый.','чёрная бэха-пятёрка',False),
               ('','бэха-пятёрка, двухлитровая бензиновая',False)]
        for description,name,approved in cases:
            with self.subTest(description=description,name=name):
                self.s.context={'subjectTitle':full,'subjectDescription':description}
                self.s.prompt='Покупка автомобиля. Нынешняя машина клиента красная, с мотором 3.0 л.'
                async def generate(*args,**kwargs):
                    self.assertEqual(kwargs['subject_data']['selection'].get('subjectDescription',''),description)
                    kwargs['subject_result'].update(value=full,spoken='BMW 5-series',spoken_name=name,purpose='purchase')
                    return {'availability':full+' ещё в продаже?'}
                verdict={key:safe for key in ('__scenario_subject__','__spoken_subject__','__call_purpose__')}
                verdict['__spoken_name__']=safe if approved else {'choice':'unsafe','probabilities':{'safe':.01,'unsafe':.99}}
                with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)) as verify:
                    await prepare_questions(self.s,rows,None)
                self.assertEqual(verify.await_args.kwargs['subject_data']['selection']['subjectTitle'],full)
                self.assertEqual(self.s.prepared_spoken_subject,name if approved else 'BMW 5-series')
                self.assertEqual(self.s.prepared_subject_model,'BMW 5-series')
                self.assertEqual(self.s.context['subjectDescription'],description)

    async def test_colloquial_name_is_separately_verified_against_exact_model(self):
        full='BMW 5-series 520i 2.0 AT Luxury'
        self.s.context={'subjectTitle':full};self.s.prompt='Покупка автомобиля. Манера клиента: неформальная.'
        rows=[{'key':'availability','question':full+' ещё в продаже?'}]
        safe={'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}}
        for name,approved in [('бэха-пятёрка',True),('БМВ пятой серии',True),('бэха',False),
                              ('БМВ с двухлитровым мотором',False),('БМВ седьмой серии',False)]:
            with self.subTest(name=name):
                async def generate(*args,**kwargs):
                    kwargs['subject_result'].update(value=full,spoken='BMW 5-series',spoken_name=name,purpose='purchase')
                    return {'availability':'Подскажите, '+full+' ещё в продаже?'}
                verdict={key:safe for key in ('availability','__scenario_subject__','__spoken_subject__','__call_purpose__')}
                verdict['__spoken_name__']=safe if approved else {'choice':'unsafe','probabilities':{'safe':.01,'unsafe':.99}}
                with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)) as verify:
                    result=await prepare_questions(self.s,rows,None)
                self.assertEqual(verify.await_args.kwargs['spoken_name'],name)
                self.assertEqual(self.s.prepared_spoken_subject,name if approved else 'BMW 5-series')
                self.assertEqual(self.s.prepared_subject_model,'BMW 5-series')
                self.assertEqual(self.s.prepared_subject,full)
                self.assertIn('BMW 5-series',result['availability'])
                self.assertNotIn('520i',result['availability'])

    async def test_colloquial_name_cannot_bypass_failed_model_verification(self):
        self.s.context={'subjectTitle':'BMW 5-series 520i'};self.s.prompt='Покупка автомобиля'
        async def generate(*args,**kwargs):
            kwargs['subject_result'].update(value='BMW 5-series 520i',spoken='BMW 5-series',spoken_name='бэха-пятёрка')
            return {'availability':'BMW 5-series 520i ещё в продаже?'}
        safe={'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}}
        with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value={'__scenario_subject__':safe,'__spoken_name__':safe})):
            await prepare_questions(self.s,[{'key':'availability','question':'BMW 5-series 520i ещё в продаже?'}],None)
        self.assertIsNone(self.s.prepared_spoken_subject)
        self.assertIsNone(self.s.prepared_subject_model)

    async def test_spoken_brand_model_is_verified_and_full_feed_is_preserved(self):
        for full,short in [('BMW 5-series 520i 2.0 AT Luxury 2024','BMW 5-series'),
                           ('Land Rover Range Rover Sport 3.0 AT HSE','Land Rover Range Rover Sport'),
                           ('TANK 300 Premium','TANK 300')]:
            with self.subTest(full=full):
                self.s.context={'subjectTitle':full,'subjectDescription':'Бензин, автомат'};self.s.prompt='Покупка автомобиля'
                rows=[{'key':'availability','question':full+' ещё в продаже?'}]
                async def generate(*args,**kwargs):
                    kwargs['subject_result'].update(value=full,spoken=short,purpose='purchase')
                    return {'availability':'Подскажите, '+full+' ещё в продаже?'}
                safe={'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}}
                verdict={key:safe for key in ('availability','__scenario_subject__','__spoken_subject__','__call_purpose__')}
                with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)):
                    result=await prepare_questions(self.s,rows,None)
                self.assertEqual(self.s.prepared_subject,full)
                self.assertEqual(self.s.context['subjectTitle'],full)
                self.assertEqual(self.s.context['subjectDescription'],'Бензин, автомат')
                self.assertEqual(self.s.prepared_spoken_subject,short)
                self.assertIn(short,result['availability']);self.assertNotIn(full,result['availability'])

    async def test_unverified_or_invented_spoken_name_never_leaks_long_feed_into_speech(self):
        full='BMW 5-series 520i 2.0 AT Luxury'
        self.s.context={'subjectTitle':full};self.s.prompt='Покупка автомобиля'
        rows=[{'key':'availability','question':full+' ещё в продаже?'}]
        for short,approved in [('BMW 5-series',False),('BMW 7-series',True),(full,False)]:
            async def generate(*args,**kwargs):
                kwargs['subject_result'].update(value=full,spoken=short)
                return {'availability':'Подскажите, '+full+' ещё в продаже?'}
            safe={'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}}
            verdict={'__scenario_subject__':safe,'__spoken_subject__':safe if approved else {}}
            with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)):
                result=await prepare_questions(self.s,rows,None)
            self.assertIsNone(self.s.prepared_spoken_subject)
            self.assertNotIn(full,result['availability'])
            self.assertNotIn('BMW 7-series',result['availability'])

    async def test_derived_scenario_prepares_short_subject_without_second_generation(self):
        self.s.context={'subjectTitle':'TANK 300 Premium'};self.s.prompt='Покупка автомобиля'
        async def generate(*args,**kwargs):
            kwargs['subject_result'].update(value='TANK 300 Premium',spoken='TANK 300',purpose='purchase')
            return {'topic0':'TANK 300 Premium ещё в продаже?','topic1':'Есть скидка при оплате наличными?'}
        safe={'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}}
        verdict={key:safe for key in ('__scenario_subject__','__spoken_subject__','__call_purpose__')}
        with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)) as gen,patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)):
            rows=await derive_scenario_topics(self.s,None)
        gen.assert_awaited_once()
        self.assertEqual(self.s.prepared_spoken_subject,'TANK 300')
        self.assertNotIn('Premium',rows[0]['question'])

    async def test_subject_from_script_title_requires_both_literal_quote_and_semantic_approval(self):
        self.s.context={}
        self.s.prompt='Название скрипта (справочный источник): "Москвич 3, 2024 года — наличные"\nПотребность клиента: Для жены.'
        rows=[{'key':'availability','question':'Автомобиль ещё в продаже?'}]
        async def generate(*args,**kwargs):
            self.assertEqual(kwargs['subject_data']['script_title'],'Москвич 3, 2024 года — наличные')
            kwargs['subject_result']['value']='Москвич 3, 2024 года'
            return {'availability':'Скажите, автомобиль ещё в продаже?'}
        for approved in (True,False):
            verdict={'availability':{'choice':'safe','probabilities':{'safe':.99,'unsafe':.01}},
                '__scenario_subject__':{'choice':'safe' if approved else 'unsafe',
                    'probabilities':{'safe':.99 if approved else .01,'unsafe':.01 if approved else .99}}}
            with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)):
                await prepare_questions(self.s,rows,None)
            self.assertEqual(self.s.prepared_subject,'Москвич 3, 2024 года' if approved else None)

    async def asyncSetUp(self):
        _last.clear()
        self.s=SimpleNamespace(id='synthetic-call',evidence=Evidence())
        self.questions=[{'key':'accidents','question':'Были ли ДТП?'},{'key':'mileage','question':'Пробег актуальный?'}]

    async def test_service_purpose_is_accepted_only_with_independent_scenario_validation(self):
        self.s.context={'customerNeed':'Zeekr 8X, ранее не обслуживался.'};self.s.prompt='Потребность клиента: обслуживание'
        rows=[{'key':'custom:0','question':'Хочу установить защиту двигателя. Сможете сделать?'}]
        async def generate(*args,**kwargs):
            kwargs['subject_result']['purpose']='service'
            return {'custom:0':'Сможете установить защиту двигателя?'}
        for approved in (True,False):
            verdict={'__call_purpose__':{'choice':'safe' if approved else 'unsafe',
                'probabilities':{'safe':.99 if approved else .01,'unsafe':.01 if approved else .99}}}
            with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=generate)),patch('controller_preparation.verify_questions',new=AsyncMock(return_value=verdict)):
                await prepare_questions(self.s,rows,None)
            self.assertEqual(self.s.prepared_purpose,'service' if approved else 'other')

    async def test_purpose_failure_does_not_default_to_purchase(self):
        self.s.prepared_purpose='purchase'
        with patch('controller_preparation.generate_questions',new=AsyncMock(side_effect=TimeoutError)):
            await prepare_questions(self.s,self.questions,None)
        self.assertEqual(self.s.prepared_purpose,'other')

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
