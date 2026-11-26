"""Stage 2: synthetic manager questions, real Decisions, optional Realtime text.

Prepared audio and telephone delivery are mocked. No phone calls or CRM writes.
"""
import argparse
import asyncio
import json
import os
import re
from pathlib import Path

from test_semantic_controller import SemanticTests
from turn_meaning import MODEL
from dialogue_controller import controller_prompt

CASES = [
    ('selected_before_opening', 'Какая машина вас заинтересовала?', True, True, 'answer'),
    ('selected_without_feed', 'Какая машина вас заинтересовала?', False, True, 'answer'),
    ('selected_after_opening', 'Так, у нас очень много авто на складе, какая машина вас заинтересовала?', True, False, 'answer'),
    ('selected_repeated', 'Какая машина вас заинтересовала?', True, False, 'answer'),
    ('beneficiary', 'Машину подбираете для себя?', True, False, 'answer'),
    ('beneficiary_asr', 'Машина подбираете для себя.', True, False, 'answer'),
    ('options', 'Что важно в автомобиле? Какими опциями пользуетесь?', True, False, 'answer'),
    ('options_indirect', 'Либо скажите, какие опции важны, и тогда я вам помогу подобрать автомобиль.', True, False, 'answer'),
    ('model_and_options', 'Какая машина вас заинтересовала и какие опции важны?', True, False, 'answer'),
    ('answer_and_question', 'Да, тест-драйв проводим. Машину подбираете для себя?', True, False, 'answer'),
    ('plan_invitation', 'Что ещё хотели бы узнать по машине?', True, False, 'plan'),
    ('incomplete_options', 'Либо скажите, какие опции важны, и тогда я вам', True, False, 'wait'),
]


async def render(c):
    # Same text-only Realtime contract as controller_preparation.py.
    from websockets.asyncio.client import connect
    async with asyncio.timeout(30):
        async with connect('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
            additional_headers={'Authorization': 'Bearer ' + os.environ['OPENAI_API_KEY']},
            open_timeout=8, close_timeout=1) as ws:
            await ws.send(json.dumps({'type': 'session.update', 'session': {
                'type': 'realtime', 'output_modalities': ['text'], 'reasoning': {'effort': 'low'},
                'instructions': controller_prompt(c.s), 'audio': {'input': {'turn_detection': None}}}}))
            async for message in ws:
                event = json.loads(message)
                if event['type'] == 'error': raise RuntimeError('Realtime session rejected')
                if event['type'] == 'session.updated': break
            await ws.send(json.dumps({'type': 'response.create', 'response': {
                'conversation': 'none', 'output_modalities': ['text'], 'input': [
                    {'type': 'message', 'role': 'system', 'content': [{'type': 'input_text', 'text': c.context_text()}]},
                    {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': c.latest_input}]},
                ]}}))
            parts = []
            async for message in ws:
                event = json.loads(message)
                if event['type'] == 'error': raise RuntimeError('Realtime response rejected')
                if event['type'] in ('response.output_text.delta', 'response.text.delta'): parts.append(event['delta'])
                if event['type'] == 'response.done':
                    if event['response'].get('status') != 'completed': raise RuntimeError('Realtime response incomplete')
                    return ''.join(parts).strip()


async def run_case(case, with_render):
    name, text, selection, opening_pending, expected = case
    fixture = SemanticTests('test_beneficiary_focus_answers_only_the_actual_question')
    await fixture.asyncSetUp()
    c = fixture.c
    try:
        c.started = True
        c.opening_sent = not opening_pending
        c.s.context = {'customerNeed': 'Студент. Машина для себя. Бюджет ограничен. Важны кондиционер и подогрев сидений.'}
        if selection:
            c.s.context.update(subjectTitle='Toyota Corolla, 1.6 AT', subjectDescription='Белая, бензин, один и шесть литра, автомат.')
            c.s.prepared_spoken_subject = 'Тойота Королла'
            c.texts['subject'] = 'Меня интересует Тойота Королла.'
        else:
            c.texts.pop('subject', None)
        c.current = 'availability'
        c.last_question = {'text': 'Машина ещё продаётся?', 'topic': 'availability', 'kind': 'plan', 'response_id': 'opening'}
        c.last_clip = {'text': c.last_question['text'], 'response_id': 'opening'}
        c.asked['availability'] = 1
        if name == 'selected_repeated':
            c.approve_speech_sentence(c.texts['subject'], 'previous-model-answer')
            c.approve_speech_sentence('Тойота Королла.', 'previous-short-model-answer')
        c.player.queue_frame.reset_mock()
        c.s.evidence.memory.user(text, 1)
        await c.handle(text, 1, c.epoch)
        queued = [call.args[0].text for call in c.player.queue_frame.call_args_list]
        native = bool(c.llm.request_turns)
        route = 'answer' if native else 'plan' if any('?' in row for row in queued) else 'answer' if queued else 'wait'
        row = {'id': name, 'input': text, 'expected': expected, 'route': route, 'passed': route == expected,
            'meaning': c.last_meaning, 'queued': queued,
            'raw': next((e['answers'] for e in c.s.evidence.events if e['event'] == 'semantic_interpretation'), None)}
        if native and with_render:
            row['generated_reply'] = await render(c)
            delivered = []
            for sentence in c.speech.sentences(row['generated_reply']):
                if '?' in sentence and not await c.native_questions.authorize(sentence, 'probe-answer', c.epoch): continue
                approved = c.approve_speech_sentence(sentence, 'probe-answer')
                if approved: delivered.append(approved)
            row['reply'] = ' '.join(delivered)
            row['passed'] = row['passed'] and bool(row['reply']) and '?' not in row['reply']
            if name.startswith('selected_') and selection:
                row['passed'] = row['passed'] and bool(re.search('королл', row['reply'], re.I))
            if name.startswith('beneficiary'):
                row['passed'] = row['passed'] and bool(re.search('себ', row['reply'], re.I))
            if name.startswith('options') or name == 'model_and_options':
                row['passed'] = row['passed'] and bool(re.search('кондиционер|подогрев', row['reply'], re.I))
        return row
    except Exception as exc:
        return {'id': name, 'passed': False, 'errorType': type(exc).__name__}
    finally:
        await fixture.asyncTearDown()
        fixture.doCleanups()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--render', action='store_true')
    parser.add_argument('--case', action='append')
    options = parser.parse_args()
    cases = [case for case in CASES if not options.case or case[0] in options.case]
    if not cases: raise ValueError('No matching probe cases')
    report = {'model': MODEL, 'phoneCalls': 0, 'scope': 'synthetic text; real Decisions; mocked audio and phone', 'cases': []}
    for case in cases:
        row = await run_case(case, options.render)
        report['cases'].append(row)
        print(json.dumps({key: row.get(key) for key in ('id', 'route', 'passed', 'reply', 'errorType')}, ensure_ascii=False), flush=True)
    output = Path(options.output)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    output.chmod(0o600)
    if not all(row['passed'] for row in report['cases']): raise SystemExit(1)


if __name__ == '__main__': asyncio.run(main())
