import unittest
from policy import Playback, Evidence, is_backchannel, TTS_MODELS


class PolicyTests(unittest.TestCase):
    def test_introductory_greeting_is_bounded_and_not_a_real_interruption(self):
        from policy import is_introductory_greeting
        for text in ('Алло.', 'Здрасьте', 'Здравствуйте, Дмитрий.', 'Добрый день'):
            self.assertTrue(is_introductory_greeting(text,400,'Дмитрий'))
        for text in ('Алло, вас не слышно.', 'Здравствуйте, какой автомобиль?', 'Стоп', 'Подождите', 'Нет'):
            self.assertFalse(is_introductory_greeting(text,400,'Дмитрий'))
        self.assertFalse(is_introductory_greeting('Алло',1000,'Дмитрий'))

    def test_short_unfinished_question_prefix_is_not_a_barge_in(self):
        from policy import is_overlap_fragment
        for text in ('Для кого','Какой у вас','А для'):
            self.assertTrue(is_overlap_fragment(text,400))
        for text in ('Для кого?', 'Планируете кредит с первоначальным взносом?', 'Да, конечно.'):
            self.assertFalse(is_overlap_fragment(text,400))

    def test_function_name_does_not_collide_with_event_type(self):
        evidence = Evidence()
        event = evidence.event("function_call", name="end_call")
        self.assertEqual(event["event"], "function_call")
        self.assertEqual(event["name"], "end_call")

    def test_short_acknowledgements_do_not_interrupt(self):
        for text in ("угу", "Ага!", "угу, ага", "мгм"):
            self.assertTrue(is_backchannel(text, 300), text)
        for text in ("ага, но цена другая", "стоп", "нет", "да", "", "ага не надо"):
            self.assertFalse(is_backchannel(text, 300), text)
        self.assertFalse(is_backchannel("угу", 850))

    def test_no_hangup_on_tts_completion_or_unsealed_ack(self):
        p = Playback(finish_requested=True)
        tag = p.begin()
        p.synthesizing = False
        self.assertFalse(p.can_hangup)
        self.assertFalse(p.acknowledge(tag))
        p.seal()
        self.assertFalse(p.can_hangup)
        self.assertTrue(p.acknowledge(tag))
        self.assertTrue(p.can_hangup)

    def test_all_audio_and_generation_must_finish(self):
        p = Playback(finish_requested=True)
        first = p.begin(); p.seal()
        second = p.begin(); p.seal()
        p.acknowledge(second)
        self.assertFalse(p.can_hangup)
        p.acknowledge(first)
        p.generated = True
        self.assertFalse(p.can_hangup)
        p.generated = False
        p.synthesizing = True
        self.assertFalse(p.can_hangup)
        p.synthesizing = False
        self.assertTrue(p.can_hangup)

    def test_interruption_clears_queue_and_invalidates_late_ack(self):
        p = Playback(finish_requested=True)
        old = p.begin(); p.seal(); p.interrupt()
        new = p.begin(); p.seal()
        self.assertFalse(p.acknowledge(old))
        self.assertIn(new, p.pending)
        self.assertFalse(p.finish_requested)
        self.assertFalse(p.can_hangup)

    def test_silent_call_never_reports_playout(self):
        self.assertFalse(Playback(finish_requested=True).can_hangup)

    def test_metrics_missing_stage_is_null(self):
        now = [1.0]
        e = Evidence(clock=lambda: now[0])
        e.latency("stt_ms", "speech_end")
        self.assertIsNone(e.events[-1]["latency_ms"])
        e.mark("speech_end"); now[0] += 0.125
        e.latency("stt_ms", "speech_end")
        self.assertEqual(e.events[-1]["latency_ms"], 125)

    def test_v4_variants_are_separate_experiments(self):
        self.assertEqual(TTS_MODELS, ("eleven_v3", "eleven_v4", "eleven_v4_turbo"))


if __name__ == "__main__":
    unittest.main()
