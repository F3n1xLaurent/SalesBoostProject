"""Stage 3: ASR-text-to-cached-frame dispatch, not telephone/audio latency.

Real Decisions where the controller needs it; prepared PCM and model transport
are mocked. No telephone calls, TTS API requests or application data writes.
"""
import argparse
import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from semantic_controller import SEMANTIC_VERSION
from test_semantic_controller import SemanticTests
from turn_meaning import interpret

CASES = [
    ('initial_name', 'Как я могу к вам обращаться?', False, False, True),
    ('midcall_name', 'Как я могу к вам обращаться?', True, False, True),
    ('polite_name', 'Скажи, пожалуйста, как я могу к вам обращаться?', True, False, True),
    ('repeat_name', 'Повторите, пожалуйста, как вас зовут?', True, True, True),
    ('trailing_please', 'Скажите ваше имя, пожалуйста.', True, False, True),
    ('compound_name', 'Как к вам обращаться и для кого выбираете машину?', True, False, False),
    ('other_person', 'Как зовут менеджера, с которым я буду общаться?', True, False, False),
    ('contact_not_name', 'Как я могу с вами связаться?', True, False, False),
]


async def run_case(case):
    name, text, started, repeated, expect_fast = case
    fixture = SemanticTests('test_initial_name_question_uses_prepared_voice_without_two_model_roundtrips')
    await fixture.asyncSetUp()
    c = fixture.c
    try:
        c.started = started
        c.opening_sent = started
        c.current = 'availability'
        c.last_question = {'text': 'Машина ещё продаётся?', 'topic': 'availability', 'kind': 'plan', 'response_id': 'opening'}
        c.last_clip = {'text': c.last_question['text'], 'response_id': 'opening'}
        c.asked['availability'] = 1
        if repeated: c.approve_speech_sentence(c.texts['name'], 'previous-name')
        c.s.evidence.memory.user(text, 1)
        times = []
        started_at = time.monotonic()
        async def queued(frame):
            if c.texts['name'] in frame.text: times.append(round((time.monotonic() - started_at) * 1000, 2))
        c.player.queue_frame.side_effect = queued
        with patch('semantic_controller.interpret', new=AsyncMock(wraps=interpret)) as model:
            await c.handle(text, 1, c.epoch)
        frames = [call.args[0] for call in c.player.queue_frame.call_args_list]
        fast = model.await_count == 0
        checks = {'expectedRoute': fast == expect_fast}
        if expect_fast:
            checks.update(nameQueued=bool(times), noOwnQuestion=all('?' not in f.text for f in frames),
                noNativeGeneration=not c.llm.request_turns,
                namePCM=any(c.texts['name'] in f.text and getattr(f, 'pcm', None) for f in frames))
        if name == 'compound_name':
            checks['otherQuestionPreserved'] = bool(c.llm.request_turns or (c.last_meaning or {}).get('other_questions'))
        return {'id': name, 'input': text, 'apiCalls': model.await_count, 'nameQueuedMs': times[0] if times else None,
            'dispatchMs': round((time.monotonic() - started_at) * 1000, 2),
            'queued': [f.text for f in frames], 'checks': checks, 'passed': all(checks.values()),
            'fillers': [e for e in c.s.evidence.events if e['event'] == 'thinking_pause_emitted']}
    except Exception as exc:
        return {'id': name, 'passed': False, 'errorType': type(exc).__name__}
    finally:
        await fixture.asyncTearDown()
        fixture.doCleanups()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    options = parser.parse_args()
    report = {'createdAt': datetime.now(timezone.utc).isoformat(), 'controllerVersion': SEMANTIC_VERSION,
        'phoneCalls': 0, 'scope': 'synthetic ASR text, mocked PCM/transport; real Decisions on fallback', 'cases': []}
    for case in CASES:
        row = await run_case(case)
        report['cases'].append(row)
        print(json.dumps({k: row.get(k) for k in ('id', 'apiCalls', 'nameQueuedMs', 'passed', 'errorType')}, ensure_ascii=False), flush=True)
    output = Path(options.output)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    output.chmod(0o600)
    if not all(row['passed'] for row in report['cases']): raise SystemExit(1)


if __name__ == '__main__': asyncio.run(main())
