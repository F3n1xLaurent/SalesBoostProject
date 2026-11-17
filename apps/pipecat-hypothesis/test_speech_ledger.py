import unittest
from speech_ledger import SpeechLedger


class SpeechLedgerTests(unittest.TestCase):
    def setUp(self):self.g=SpeechLedger('Андрей')

    def test_reservation_blocks_concurrent_path_and_release_allows_unqueued_text(self):
        text='По времени пока не определились.'
        self.assertEqual(self.g.reserve(text,'prepared')[0],text)
        self.assertFalse(self.g.reserve(text,'native')[0])
        self.g.release('prepared')
        self.assertEqual(self.g.reserve(text,'retry')[0],text)

    def test_punctuation_case_and_yo_do_not_bypass_call_ledger(self):
        self.g.reserve('Всё ещё уточняю.','a');self.g.commit('a','response')
        self.assertFalse(self.g.reserve('ВСЕ ЕЩЕ УТОЧНЯЮ!','b')[0])

    def test_repeated_intro_removed_without_losing_answer_in_same_sentence(self):
        self.g.reserve('Меня зовут Андрей.','a');self.g.commit('a','first')
        result,blocked=self.g.reserve('Я Андрей, машину выбираю для личных поездок.','native')
        self.assertEqual(result,'машину выбираю для личных поездок.')
        self.assertTrue(blocked)

    def test_repeated_intro_removed_but_new_sentence_kept(self):
        self.g.reserve('Меня зовут Андрей.','a');self.g.commit('a','first')
        result,_=self.g.reserve('Меня зовут Андрей. Актуален ли пробег?','b')
        self.assertEqual(result,'Актуален ли пробег?')

    def test_duplicate_inside_same_generation_is_blocked(self):
        text,_=self.g.reserve('Сведения неизвестны. Сведения неизвестны.','a')
        self.assertEqual(text,'Сведения неизвестны.')

    def test_name_acknowledgment_cannot_reintroduce_name_on_unrelated_answer(self):
        self.g.reserve('Меня зовут Андрей.','intro');self.g.commit('intro','intro')
        text,_=self.g.reserve('Да, Андрей. Сейчас езжу на Шкоде.','answer')
        self.assertEqual(text,'Сейчас езжу на Шкоде.')

    def test_explicit_repair_does_not_open_a_global_bypass(self):
        self.g.reserve('Мне удобно завтра.','a');self.g.commit('a','first')
        self.assertTrue(self.g.reserve('Мне удобно завтра.','repair',repeat=True)[0])
        self.assertFalse(self.g.reserve('Мне удобно завтра.','automatic')[0])
