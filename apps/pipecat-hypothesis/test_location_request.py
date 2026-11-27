import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock,Mock,patch

from turn_meaning import review_location_request


class LocationRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        env=patch.dict(os.environ,{'PROXYAPI_API_KEY':'test-key'});env.start();self.addCleanup(env.stop)
        self.response=Mock()
        self.c=SimpleNamespace(http=SimpleNamespace(post=AsyncMock(return_value=self.response)),
            s=SimpleNamespace(evidence=SimpleNamespace(event=Mock())))

    def answer(self,choice,scores):
        self.response.json.return_value={'answers':{'request':{'choice':choice,'probabilities':scores}}}

    async def test_review_uses_only_the_utterance_without_city_or_history_hints(self):
        self.answer('name_only',{'name_only':.97,'location_only':.01,'other':.01,'unclear':.01})
        text='Компания Первый километр, как я могу к вам обращаться?'
        self.assertEqual(await review_location_request(self.c,text),'name_only')
        body=self.c.http.post.call_args.kwargs['json']
        self.assertEqual(body['state'],{'manager_utterance':text})
        self.assertEqual(self.c.s.evidence.event.call_args.kwargs['result'],'name_only')

    async def test_a_high_confidence_city_question_preserves_the_cached_shortcut(self):
        self.answer('location_only',{'location_only':.97,'name_only':.01,'other':.01,'unclear':.01})
        self.assertEqual(await review_location_request(self.c,'В какой город обращаетесь?'),'location_only')

    async def test_ambiguous_review_does_not_authorize_a_city_answer(self):
        self.answer('location_only',{'location_only':.6,'name_only':.35,'other':.04,'unclear':.01})
        self.assertEqual(await review_location_request(self.c,'Компания, обратиться?'),'unclear')

    async def test_missing_review_choice_is_an_error(self):
        self.response.json.return_value={'answers':{}}
        with self.assertRaises(ValueError):await review_location_request(self.c,'Как к вам обращаться?')
