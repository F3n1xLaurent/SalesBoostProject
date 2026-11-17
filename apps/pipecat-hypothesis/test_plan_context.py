import unittest
from types import SimpleNamespace
from plan_context import plan_need,selected_subject


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
