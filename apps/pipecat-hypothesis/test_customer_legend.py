import unittest
from unittest.mock import patch
from customer_legend import choose_name
from controller_visit import VisitProposal,clock_minutes,same_clock


class LegendTests(unittest.TestCase):
    def test_explicit_name_is_preserved(self):
        self.assertEqual(choose_name('Ты Дарья, женщина. Голос клиента: Женский'),'Дарья')

    def test_voice_gender_selects_name_pool(self):
        with patch('customer_legend.secrets.choice',side_effect=lambda pool:pool[0]):
            self.assertEqual(choose_name('Голос клиента: Женский'),'Анна')
            self.assertEqual(choose_name('Голос клиента: Мужской'),'Алексей')

    def test_call_name_is_selected_instead_of_fixed_andrey(self):
        with patch('customer_legend.secrets.choice',return_value='Сергей') as select:
            self.assertEqual(choose_name('Тестовый план'),'Сергей')
            select.assert_called_once()

    def test_day_options_and_weekday_keep_customer_choice(self):
        for text,day in [('Сегодня или завтра?','сегодня'),('В субботу или в будни?','в субботу')]:
            v=VisitProposal();v.update(text,1)
            self.assertEqual(v.day['value'].casefold(),day);self.assertIsNone(v.time)

    def test_standalone_clock_is_not_misread_from_quantity(self):
        for text in ('Полтора года.','Пробег двадцать тысяч.','Цена двадцать ноль ноль рублей.'):
            v=VisitProposal();v.update(text,1);self.assertIsNone(v.time)
        for text in ('двадцать ноль ноль.','20:00','Сегодня. Двадцать ноль ноль.'):
            v=VisitProposal();v.update(text,1)
            self.assertEqual(clock_minutes(v.time['value']),1200)

    def test_repeated_hour_in_confirmation_is_not_summed(self):
        self.assertTrue(same_clock('двадцать ноль ноль','в двадцать ноль ноль','Да, сегодня в двадцать ноль ноль, ждём.'))
        self.assertEqual(clock_minutes('двадцать один'),1260)
        self.assertIsNone(clock_minutes('25:00'))
