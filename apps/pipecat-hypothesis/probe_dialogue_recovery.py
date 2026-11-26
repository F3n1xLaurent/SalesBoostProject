"""Stage 4: real model answers with synthetic speech/playback events.

No phone calls, live STT/VAD, external TTS or application data writes. PCM and
phone ACK are simulated; the actual controller and its speech filters run.
"""
import argparse
import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from pipeline import Turn
from controller_audio import PreparedSpeechFrame
from probe_buyer_answers import render
from semantic_controller import SEMANTIC_VERSION
from test_semantic_controller import SemanticTests


def main_texts(c):
    return [call.args[0].text for call in c.player.queue_frame.call_args_list
        if isinstance(call.args[0], PreparedSpeechFrame)]


async def native_answer(c,early_ack=False):
    c.started = True
    c.s.context = {'customerNeed': 'Покупаю машину для себя.', 'subjectTitle': 'Toyota Corolla, 1.6 AT'}
    c.current = 'availability'
    c.last_question = {'text': 'Машина ещё продаётся?', 'topic': 'availability', 'kind': 'plan', 'response_id': 'opening'}
    c.last_clip = {'text': c.last_question['text'], 'response_id': 'opening'}
    c.asked['availability'] = 1
    c.inputs.add('Да, машина в наличии. Машину подбираете для себя?', 1, c.last_question)
    c.probe_stage='meaning'
    c.receive_batch(c.inputs.snapshot())
    await c.task
    if not c.llm.request_turns: raise RuntimeError('No buyer answer requested')
    if early_ack:
        await c.new_input()
        c.s.evidence.turn=2;c.monitor.turn=Turn(True,250,number=2)
        await c.on_ignored_input(c.monitor.turn)
        if not c.accepts_native_completion('native-answer',{'reason':'controller_fallback','turn':1}):
            raise RuntimeError('Generation completion lost after ignored acknowledgment')
    c.probe_stage='render'
    raw = await render(c)
    delivered = []
    for sentence in c.speech.sentences(raw):
        if '?' in sentence and not await c.native_questions.authorize(sentence, 'native-answer', c.epoch): continue
        approved = c.approve_speech_sentence(sentence, 'native-answer')
        if approved: delivered.append(approved)
    reply = ' '.join(delivered)
    if 'себ' not in reply.casefold(): raise RuntimeError('Buyer answer missing')
    c.llm.spoken_text['native-answer'] = reply
    c.s.evidence.assistant('native-answer',reply,turn=c.s.evidence.turn)
    # Model generation and the first main PCM would finish the filler handoff
    # in the real pipeline. Mirror those events before simulating more speech.
    await c.thinking.main_audio_ready('native-answer')
    c.s.playback.generated=False
    c.playing_id='native-answer';c.playing_kind='llm'
    ledger = c.s.evidence.delivery
    ledger.response('native-answer').update(generated_done=True, tts_done=True)
    ledger.segment('answer-tag', 'native-answer')
    c.probe_stage='answer_done'
    await c.fallback_done('native-answer')
    return reply, ledger


async def run_case(name):
    fixture = SemanticTests('test_initial_name_question_uses_prepared_voice_without_two_model_roundtrips')
    await fixture.asyncSetUp()
    c = fixture.c
    async def cleared(*args):c.serializer.queue_cleared_event.set()
    c.llm.broadcast_frame.side_effect=cleared
    try:
        if name == 'identity_interrupt':
            topic, original = await fixture.interrupted_plan()
            await c.new_input()
            c.s.evidence.turn = 2
            c.monitor.turn = Turn(True, 1200, interrupted=True, number=2)
            c.s.evidence.memory.user('Как вас зовут?', 2)
            await c.handle('Как вас зовут?', 2, c.epoch)
            identity = c.player.queue_frame.call_args.args[0]
            ledger = c.s.evidence.delivery
            ledger.response(identity.response_id)['tts_done'] = True
            ledger.segment('identity-tag', identity.response_id)
            await asyncio.sleep(.03)
            before = len(main_texts(c))
            ledger.ack('identity-tag')
            await asyncio.sleep(.05)
            texts = main_texts(c)
            checks = {'nameFirst': before == 1 and texts[0] == c.texts['name'],
                'resumeAfterACK': len(texts) == 2 and c.texts[topic] in texts[1],
                'sameQuestionIdentity': c.asked[topic] == 1 and c.question_ledger['plan:' + topic].get('retry_of') == original}
            return {'id': name, 'checks': checks, 'queued': texts, 'passed': all(checks.values())}

        reply, ledger = await native_answer(c,early_ack=name=='ack_before_generation_done')
        retained = c.inputs.snapshot()
        c.probe_stage='simulated_playback'
        if name == 'physical_speech':
            c.monitor.segment_start = time.monotonic()
            ledger.ack('answer-tag')
            await asyncio.sleep(.03)
            before = len(main_texts(c))
            c.monitor.segment_start = None
        elif name == 'ack_before_generation_done':
            before = len(main_texts(c))
            ledger.ack('answer-tag')
        else:
            await c.new_input()
            c.s.evidence.turn = 2
            c.monitor.turn = Turn(True, 1200 if name == 'interrupted_late_ack' else 250,
                interrupted=name == 'interrupted_late_ack', number=2)
            if name == 'interrupted_late_ack': ledger.response('native-answer')['interrupted'] = True
            await c.on_ignored_input(c.monitor.turn)
            before = len(main_texts(c))
            ledger.ack('answer-tag')
        await asyncio.sleep(.05)
        texts = main_texts(c)
        if name == 'interrupted_late_ack':
            checks = {'noStaleResume': not texts, 'unansweredInputRetained': c.inputs.snapshot() == retained}
        else:
            checks = {'noPrematureQuestion': before == 0,
                'resumeOnce': len(texts) == 1 and c.texts[fixture.keys[0]] in texts[0],
                'inputConsumedAfterACK': c.inputs.snapshot() == []}
        return {'id': name, 'reply': reply, 'queued': texts, 'checks': checks, 'passed': all(checks.values()),
            'fillers': [e['text'] for e in c.s.evidence.events if e['event'] == 'thinking_pause_emitted']}
    except Exception as exc:
        return {'id': name, 'passed': False, 'errorType': type(exc).__name__, 'stage': getattr(c,'probe_stage',None)}
    finally:
        await fixture.asyncTearDown()
        fixture.doCleanups()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--case',action='append')
    options = parser.parse_args()
    report = {'createdAt': datetime.now(timezone.utc).isoformat(), 'controllerVersion': SEMANTIC_VERSION,
        'phoneCalls': 0, 'scope': 'real Decisions/Realtime; synthetic speech and phone ACK', 'cases': []}
    for name in ('ignored_short_ack', 'physical_speech', 'interrupted_late_ack', 'identity_interrupt', 'ack_before_generation_done'):
        if options.case and name not in options.case:continue
        row = await run_case(name)
        report['cases'].append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    output = Path(options.output)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    output.chmod(0o600)
    if not all(row['passed'] for row in report['cases']): raise SystemExit(1)


if __name__ == '__main__': asyncio.run(main())
