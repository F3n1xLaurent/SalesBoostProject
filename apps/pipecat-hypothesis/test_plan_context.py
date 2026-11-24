import unittest
from types import SimpleNamespace
from plan_context import plan_need,selected_subject,subject_scope,grounded_subject,target_location,subject_sources,spoken_subject


class PlanContextTests(unittest.TestCase):
    def test_failed_short_name_validation_keeps_a_literal_model_before_technical_suffix(self):
        s=SimpleNamespace(context={'subjectTitle':'Toyota Land Cruiser Prado 150 Series Рестайлинг 3 4.0 AT 4WD TXL'},prepared_spoken_subject=None)
        self.assertEqual(spoken_subject(s),'Toyota Land Cruiser Prado')
        self.assertEqual(s.context['subjectTitle'],'Toyota Land Cruiser Prado 150 Series Рестайлинг 3 4.0 AT 4WD TXL')
        s.context={'subjectTitle':'BMW 5-series 2.0 AT Luxury'}
        self.assertEqual(spoken_subject(s),'BMW 5-series')
        s.context={'subjectTitle':'Неопределённое название'}
        self.assertEqual(spoken_subject(s),'автомобиль')
    def test_script_title_reaches_subject_sources_without_overwriting_the_need(self):
        s=SimpleNamespace(context={},prompt='Название скрипта (справочный источник): "Skoda Octavia — наличные"\n'
            'Потребность клиента: Пробег 29 650 км.\n\nОснова разговора: потребность клиента.',
            evidence=SimpleNamespace(memory=SimpleNamespace(topics=SimpleNamespace(required=[]))))
        sources=subject_sources(s)
        self.assertEqual(sources['script_title'],'Skoda Octavia — наличные')
        self.assertEqual(sources['need'],'Пробег 29 650 км.')
        self.assertTrue(grounded_subject('Skoda Octavia',sources))
        self.assertFalse(grounded_subject('Skoda Kodiaq',sources))
        s.prompt='Название скрипта (справочный источник): invalid json'
        self.assertIsNone(subject_sources(s)['script_title'])

    def test_1361_vehicle_and_year_survive_multiline_need_and_title(self):
        need='Москвич 3, 2024 года\nпробег - 29 650 км;\nцена - 1 494 700 ₽\nпокупка за наличные\nпокупка для жены'
        s=SimpleNamespace(context={},prompt='Название скрипта (справочный источник): "Москвич 3, 2024 года"\n'
            'Потребность клиента: '+need+'\n\nОснова разговора: потребность клиента.',
            evidence=SimpleNamespace(memory=SimpleNamespace(topics=SimpleNamespace(required=[]))))
        self.assertEqual(plan_need(s),need)
        self.assertEqual(subject_scope(s)['script_title'],'Москвич 3, 2024 года')
        self.assertTrue(grounded_subject('Москвич 3, 2024 года',subject_sources(s)))


    def test_target_location_reads_only_the_explicit_branch_block(self):
        prompt=('Компания: адрес другого филиала: ул. Другая, 99.\n'
            '=== ЦЕЛЕВАЯ ТОЧКА ЗВОНКА (КРИТИЧНО) ===\n'
            'Целевая точка: Балашиха.\nЦелевой город звонка: Москва.\n'
            'Адрес целевой точки: ш. Энтузиастов, д. 12А.\n'
            '=== КОНЕЦ ЦЕЛЕВОЙ ТОЧКИ ===\nЛичный адрес клиента: ул. Домашняя, 1.')
        self.assertEqual(target_location(SimpleNamespace(context={},prompt=prompt)),
            {'name':'Балашиха','city':'Москва','address':'ш. Энтузиастов, д. 12А'})

    def test_structured_location_takes_precedence_and_empty_address_stays_unknown(self):
        s=SimpleNamespace(context={'targetLocation':{'name':'Новая точка','address':None}},prompt=
            '=== ЦЕЛЕВАЯ ТОЧКА ЗВОНКА (КРИТИЧНО) ===\nАдрес целевой точки: Старый адрес.\n=== КОНЕЦ ЦЕЛЕВОЙ ТОЧКИ ===')
        self.assertEqual(target_location(s),{'name':'Новая точка'})
        s.context={};s.prompt='Компания: ул. Другая, 99.\nАдрес целевой точки: подставной адрес.'
        self.assertEqual(target_location(s),{})

    def test_structured_need_takes_precedence_over_prompt_parsing(self):
        s=SimpleNamespace(context={'customerNeed':' Нужна доставка мебели. '},prompt='Потребность клиента: старые данные')
        self.assertEqual(plan_need(s),'Нужна доставка мебели.')

    def test_multiline_need_is_not_cut_at_first_line_or_mixed_with_other_sections(self):
        need='Нужен автомобиль для семьи.\nVolkswagen Touareg 2019\n\nБюджет 4 560 000 рублей.'
        for following in ['Основа разговора: потребность клиента.', 'Предмет обращения: объект из выборки.', '# Первый контакт']:
            s=SimpleNamespace(context={'customerNeed':None},prompt='Потребность клиента: '+need+'\n\n'+following+'\nДругие инструкции.')
            self.assertEqual(plan_need(s),need)

    def test_missing_or_null_selection_does_not_fabricate_a_subject(self):
        s=SimpleNamespace(context={'subjectTitle':None,'subjectDescription':' '},prompt='Сценарий без потребности')
        self.assertEqual(plan_need(s),'');self.assertEqual(selected_subject(s),{})

    def test_selection_is_kept_separate_from_need(self):
        s=SimpleNamespace(context={'subjectTitle':' Товар из выборки ','subjectDescription':'Описание','customerNeed':'Другой запрос'},prompt='')
        self.assertEqual(selected_subject(s),{'subjectTitle':'Товар из выборки','subjectDescription':'Описание'})
        self.assertEqual(plan_need(s),'Другой запрос')

    def test_verified_subject_is_fixed_and_not_replaced_by_other_source_references(self):
        s=SimpleNamespace(context={'customerNeed':'Покупка в кредит'},prompt='',prepared_subject='Toyota RAV4 2018',
            evidence=SimpleNamespace(memory=SimpleNamespace(topics=SimpleNamespace(required=[{'question':'Toyota RAV4 2018 ещё в продаже?'}]))))
        self.assertEqual(subject_scope(s)['subject'],'Toyota RAV4 2018')
        self.assertEqual(subject_scope(s)['script_references'],[])
        s.context['subjectTitle']='Другая явно выбранная модель'
        self.assertEqual(subject_scope(s)['subject'],'Другая явно выбранная модель')

    def test_speech_label_does_not_remove_internal_modification(self):
        full='BMW 5-series 520i 2.0 AT Luxury'
        s=SimpleNamespace(context={'subjectTitle':full,'subjectDescription':'Бензин, автомат'},prompt='',
            prepared_subject=full,prepared_spoken_subject='BMW 5-series',
            evidence=SimpleNamespace(memory=SimpleNamespace(topics=SimpleNamespace(required=[]))))
        scope=subject_scope(s)
        self.assertEqual(scope['subject'],full)
        self.assertEqual(scope['selection']['subjectDescription'],'Бензин, автомат')
        self.assertEqual(scope['spoken_subject'],'BMW 5-series')

    def test_a_subject_must_be_a_literal_source_quote_not_a_new_preference(self):
        sources={'selection':{},'need':'Цвет чёрный, покупка в кредит.',
            'script_references':['Toyota RAV4 2018года ещё в продаже?']}
        self.assertTrue(grounded_subject('Toyota RAV4 2018',sources))
        self.assertFalse(grounded_subject('Новый Toyota RAV4 2026',sources))
        self.assertFalse(grounded_subject('Toyota RAV4 2018?',sources))
