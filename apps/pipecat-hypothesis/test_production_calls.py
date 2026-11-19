import os
import tempfile
import time
import unittest
from unittest.mock import AsyncMock,patch
from uuid import uuid4
from fastapi.testclient import TestClient
from fastapi import HTTPException
import httpx
import service
from production_calls import snapshot


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        env=patch.dict(os.environ,{'PIPECAT_LOG_DIR':self.directory.name,'PIPECAT_HYPOTHESIS_TOKEN':'x'*32,
            'PIPECAT_HYPOTHESIS_PUBLIC_URL':'https://test.invalid/pipecat','VOX_ACCOUNT_ID':'test','VOX_API_KEY':'test','VOX_APP_ID':'test'})
        env.start();self.addCleanup(env.stop)
        self.headers={'Authorization':'Bearer '+'x'*32}
        self.identifier=str(uuid4())
        self.body={'callId':self.identifier,'to':'+79990000000','voiceId':'plan-voice','prompt':'Тестовый сценарий'}
        self.client=TestClient(service.app)
        self.preflight=AsyncMock(return_value={});self.audio=AsyncMock();self.release=AsyncMock();self.dial=AsyncMock()
        for name,mock in [('preflight',self.preflight),('prepare_call_audio',self.audio),('release_call_audio',self.release),('dial_pipecat',self.dial)]:
            p=patch.object(service,name,new=mock);p.start();self.addCleanup(p.stop)
        self.previous=dict(service.sessions);service.sessions.clear()
        self.addCleanup(self.restore)

    def restore(self):service.sessions.clear();service.sessions.update(self.previous)

    def prepare(self):
        response=self.client.post('/production/sessions',json=self.body,headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def test_prepare_is_authenticated_and_never_dials(self):
        self.assertEqual(self.client.post('/production/sessions',json=self.body).status_code,401)
        prepared=self.prepare()
        self.assertEqual(prepared['profile']['model'],'gpt-realtime-2.1')
        self.assertEqual(prepared['profile']['ttsModel'],'eleven_v4_turbo')
        self.assertEqual(prepared['profile']['dialogueMode'],'semantic')
        self.assertEqual(prepared['profile']['voiceId'],'plan-voice')
        self.assertTrue(prepared['profile']['backchannel']);self.assertFalse(prepared['profile']['trimIdleAudio'])
        self.dial.assert_not_awaited()
        self.prepare();self.preflight.assert_awaited_once()

    def test_preflight_failure_does_not_dial_and_retains_provider_diagnostic(self):
        self.preflight.side_effect=HTTPException(503,'ElevenLabs: ConnectTimeout. Проверка pf-test.')
        response=self.client.post('/production/sessions',json=self.body,headers=self.headers)
        self.assertEqual(response.status_code,503)
        self.assertIn('pf-test',response.json()['detail'])
        self.audio.assert_not_awaited();self.dial.assert_not_awaited()
        self.assertTrue(service.sessions[self.identifier].finalized)
        self.assertIn('preflight',service.sessions[self.identifier].failure_reason)

    def test_audio_connect_timeout_has_safe_reason_and_never_dials_or_reprepares(self):
        self.audio.side_effect=httpx.ConnectTimeout('private proxy password',request=httpx.Request('GET','https://api.elevenlabs.io/v1/models'))
        response=self.client.post('/production/sessions',json=self.body,headers=self.headers)
        self.assertEqual(response.status_code,503)
        self.assertIn('ConnectTimeout',response.json()['detail'])
        self.assertIn('pc-'+self.identifier,response.json()['detail'])
        self.assertIn('Набор номера не запускался',response.json()['detail'])
        self.assertNotIn('private',response.text)
        self.assertEqual(self.audio.await_count,1);self.dial.assert_not_awaited()
        second=self.client.post('/production/sessions',json=self.body,headers=self.headers)
        self.assertEqual(second.json()['status'],'failed')
        self.assertEqual(self.preflight.await_count,1);self.assertEqual(self.audio.await_count,1)

    def test_unexpected_audio_failure_is_diagnosable_and_cleanup_cannot_mask_it(self):
        self.audio.side_effect=ValueError('private upstream text')
        self.release.side_effect=RuntimeError('private cleanup text')
        response=self.client.post('/production/sessions',json=self.body,headers=self.headers)
        self.assertEqual(response.status_code,500)
        self.assertIn('pc-'+self.identifier,response.json()['detail'])
        self.assertNotIn('private',response.text)
        session=service.sessions[self.identifier]
        self.assertIn('audio:ValueError',session.failure_reason)
        self.assertTrue(any(e['event']=='production_preparation_cleanup_failed' for e in session.evidence.events))
        self.dial.assert_not_awaited()

    def test_start_is_idempotent_with_one_actual_dial(self):
        self.prepare()
        url='/production/sessions/'+self.identifier+'/start'
        for _ in range(2):self.assertEqual(self.client.post(url,json={},headers=self.headers).status_code,200)
        self.dial.assert_awaited_once()
        self.assertEqual(service.sessions[self.identifier].status,'dialing')

    def test_start_failure_never_retries_actual_dial(self):
        self.prepare();self.dial.side_effect=RuntimeError('HTTP timeout')
        url='/production/sessions/'+self.identifier+'/start'
        with self.assertRaises(RuntimeError):self.client.post(url,json={},headers=self.headers)
        response=self.client.post(url,json={},headers=self.headers)
        self.assertEqual(response.json()['status'],'failed');self.dial.assert_awaited_once()

    def test_restart_can_recover_result_but_never_relaunch(self):
        self.prepare();service.sessions.clear()
        response=self.client.get('/production/sessions/'+self.identifier,headers=self.headers)
        self.assertEqual(response.json()['failureReason'],'pipecat_process_restarted')
        self.assertEqual(self.client.post('/production/sessions/'+self.identifier+'/start',json={},headers=self.headers).status_code,409)
        self.assertEqual(self.client.post('/production/sessions',json=self.body,headers=self.headers).status_code,409)
        self.dial.assert_not_awaited()

    def test_same_id_cannot_change_phone_or_voice(self):
        self.prepare()
        response=self.client.post('/production/sessions',json={**self.body,'voiceId':'other'},headers=self.headers)
        self.assertEqual(response.status_code,409)

    def test_transcript_does_not_copy_unplayed_generated_answers(self):
        self.prepare();s=service.sessions[self.identifier]
        s.evidence.event('user_transcript',text='Здравствуйте',turn=1)
        s.evidence.assistant('unheard','Скрытая генерация')
        s.evidence.assistant('heard','Озвучено')
        s.evidence.event('response_phone_confirmed',response_id='heard')
        self.assertEqual(snapshot(s)['transcript'],[{'role':'manager','text':'Здравствуйте'},{'role':'client','text':'Озвучено'}])

    def test_full_transcript_survives_more_than_a_thousand_technical_events(self):
        self.prepare();s=service.sessions[self.identifier]
        s.evidence.event('user_transcript',text='Начало разговора',turn=1,item_id='first')
        s.evidence.assistant('first-reply','Первый ответ')
        s.evidence.event('response_phone_confirmed',response_id='first-reply')
        for _ in range(1100):s.evidence.event('audio_window',bytes=32000)
        s.evidence.event('user_transcript',text='Конец разговора',turn=2,item_id='last')
        self.assertEqual(len(s.evidence.events),1000)
        self.assertEqual(snapshot(s)['transcript'],[
            {'role':'manager','text':'Начало разговора'},{'role':'client','text':'Первый ответ'},
            {'role':'manager','text':'Конец разговора'}])

    def test_long_call_lifecycle_and_recording_evidence_survive_six_minutes(self):
        self.prepare();s=service.sessions[self.identifier];s.created=time.time()-420
        url=f'/events/{self.identifier}?token={s.token}'
        response=self.client.post(url,json={'event':'connected','vox_session_id':123,'recording_started':True})
        self.assertEqual(response.status_code,200)
        self.assertTrue(snapshot(s)['recordingStarted']);self.assertEqual(snapshot(s)['voxSessionId'],123)
        self.assertIsNotNone(snapshot(s)['connectedAt'])

    def test_record_started_event_preserves_recording_for_final_snapshot(self):
        self.prepare();s=service.sessions[self.identifier]
        url=f'/events/{self.identifier}?token={s.token}'
        self.assertEqual(self.client.post(url,json={'event':'recording_started','vox_session_id':123,'recording_started':True}).status_code,200)
        self.assertEqual(self.client.post(url,json={'event':'disconnected','vox_session_id':123}).status_code,200)
        result=snapshot(s)
        self.assertTrue(result['recordingStarted']);self.assertEqual(result['voxSessionId'],123)
        self.assertTrue(any(e['event']=='vox_recording' for e in s.evidence.events))

    def test_discard_preparation_never_cancels_already_started_call(self):
        self.prepare()
        self.client.post('/production/sessions/'+self.identifier+'/start',json={},headers=self.headers)
        self.client.post('/production/sessions/'+self.identifier+'/discard',json={},headers=self.headers)
        self.assertEqual(service.sessions[self.identifier].status,'dialing')

    def test_full_capacity_does_not_contact_any_additional_provider(self):
        for _ in range(4):
            self.identifier=str(uuid4());self.body['callId']=self.identifier;self.prepare()
        self.body['callId']=str(uuid4())
        self.assertEqual(self.client.post('/production/sessions',json=self.body,headers=self.headers).status_code,429)
        self.assertEqual(self.preflight.await_count,4);self.dial.assert_not_awaited()

    def test_testing_history_cannot_leak_working_calls(self):
        self.prepare()
        self.assertFalse(self.client.get('/sessions?include_probes=true',headers=self.headers).json()['runs'])
        self.assertEqual(self.client.get('/sessions/'+self.identifier,headers=self.headers).status_code,404)
        self.assertEqual(self.client.get('/production/sessions/'+self.identifier,headers=self.headers).status_code,200)
