import unittest
from types import SimpleNamespace
from plan_context import plan_need,selected_subject,subject_scope,grounded_subject


class PlanContextTests(unittest.TestCase):
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

    def test_a_subject_must_be_a_literal_source_quote_not_a_new_preference(self):
        sources={'selection':{},'need':'Цвет чёрный, покупка в кредит.',
            'script_references':['Toyota RAV4 2018года ещё в продаже?']}
        self.assertTrue(grounded_subject('Toyota RAV4 2018',sources))
        self.assertFalse(grounded_subject('Новый Toyota RAV4 2026',sources))
        self.assertFalse(grounded_subject('Toyota RAV4 2018?',sources))
