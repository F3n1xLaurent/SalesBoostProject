import unittest

from customer_grammar import customer_gender,agree_first_person,grammar_instruction


class CustomerGrammarTests(unittest.TestCase):
    def test_voice_profile_overrides_a_legacy_gender_example(self):
        self.assertEqual(customer_gender('Ты Андрей, мужчина.\nГолос клиента: Женский, Разговорный.'),'female')
        self.assertEqual(customer_gender('Ты Анна, женщина.\nГолос клиента: Мужской.'),'male')
        self.assertEqual(customer_gender('Ты Дарья, женщина.'),'female')

    def test_employee_and_vehicle_gender_do_not_define_customer_gender(self):
        self.assertEqual(customer_gender('Менеджер Анна. Машина новая. Клиенту нужна машина.'),'unspecified')
        self.assertIn('нейтральные',grammar_instruction('Покупка автомобиля'))

    def test_first_person_agreement_preserves_vehicle_details_and_case(self):
        for source,gender,expected in [
                ('Понял.','female','Поняла.'),
                ('Я не расслышал последнюю часть.','female','Я не расслышала последнюю часть.'),
                ('Извините, я хотел уточнить цену.','female','Извините, я хотела уточнить цену.'),
                ('Я посмотрел белый Renault Duster 2016 года.','female','Я посмотрела белый Renault Duster 2016 года.'),
                ('Я хотела узнать пробег 130000 км.','male','Я хотел узнать пробег 130000 км.'),
                ('Готов рассмотреть покупку.','female','Готова рассмотреть покупку.'),
                ('Я готова подъехать.','male','Я готов подъехать.')]:
            with self.subTest(source=source,gender=gender):
                self.assertEqual(agree_first_person(source,gender),expected)

    def test_other_speakers_quotes_and_car_agreement_are_preserved(self):
        for text in ['Менеджер понял вопрос.', 'Она готова показать машину.',
                '«Я понял», — сказал менеджер.', 'Готова машина к осмотру.',
                'Понял? Вы на связи?']:
            with self.subTest(text=text):self.assertEqual(agree_first_person(text,'female'),text)
        self.assertEqual(agree_first_person('Я понял.','unspecified'),'Я понял.')
