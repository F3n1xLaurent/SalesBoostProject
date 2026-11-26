"""Synthetic visit negotiation: real Decisions API, mocked phone/audio/clock."""
import argparse
import asyncio
import json
from datetime import datetime,timezone
from pathlib import Path
from unittest.mock import AsyncMock,patch

from controller_visit import clock_minutes
from semantic_controller import SEMANTIC_VERSION
from test_semantic_controller import SemanticTests
from turn_meaning import interpret


CASES=[
    dict(id='free_invitation',text='В удобное для вас время, мы работаем ежедневно с девяти до девяти.',offer=True,bounds=(540,1260)),
    dict(id='original_invitation',text='Приезжайте сегодня или завтра. В удобное для вас время. Мы работаем с девяти до девяти ежедневно.',offer=True,bounds=(540,1260)),
    dict(id='today_partial',text='Приезжайте сегодня, в удобное для вас время. Работаем до 21:00.',offer=True,day='сегодня',bounds=(540,1260)),
    dict(id='tomorrow_when_closed',text='Сегодня или завтра, как удобно. Работаем с одиннадцати до восьми.',offer=True,day='завтра',bounds=(660,1200),utc_hour=17),
    dict(id='configured_branch_hours',text='Когда вам удобнее, сегодня или завтра?',offer=True,day='завтра',bounds=(690,1200)),
    dict(id='unparsed_restriction',text='Завтра только после обеда, но не раньше четырёх.',offer=False),
    dict(id='today_closed',text='Сегодня в удобное время, работаем с девяти до девяти.',offer=False,utc_hour=17),
    dict(id='hours_without_invitation',text='Да, автомобиль ещё продаётся. Работаем с девяти до девяти ежедневно.',offer=False,plan_question=True),
    dict(id='conditional_availability',text='Завтра можно, если автомобиль не заберёт другой покупатель. Пока не могу обещать.',offer=False),
    dict(id='separate_day_windows',text='Сегодня с шестнадцати до восемнадцати или завтра с девяти до двенадцати.',offer=True,day='завтра',bounds=(540,720)),
    dict(id='tomorrow_unavailable',text='Сегодня с девяти до девятнадцати или завтра нельзя.',offer=False,utc_hour=17),
    dict(id='hours_with_extra_restriction',text='Завтра работаем с девяти до девяти, но приехать можно только после четырёх.',offer=False),
]


async def run_case(case):
    fixture=SemanticTests('test_free_invitation_after_visit_question_selects_a_slot_within_hours')
    await fixture.asyncSetUp()
    c=fixture.c;s=fixture.s
    try:
        s.context['visitSchedule']={'timezoneOffsetMinutes':240,'workingHoursFrom':'11:30','workingHoursTo':'20:00'}
        c.started=True
        if case.get('plan_question'):
            await c.speak(fixture.keys[0])
        else:
            c.answers={key:{} for key in fixture.keys}
            await c.speak('visit')
        c.player.queue_frame.reset_mock()
        instant=datetime(2026,11,25,case.get('utc_hour',15),39,tzinfo=timezone.utc)
        s.evidence.memory.user(case['text'],1)
        with patch('semantic_controller.datetime') as clock,patch('dialogue_controller.voice_clip',new=AsyncMock(return_value=b'\x01\x00'*1600)),patch('semantic_controller.interpret',new=AsyncMock(wraps=interpret)) as model:
            clock.now.side_effect=lambda tz:instant.astimezone(tz)
            await c.handle(case['text'],1,c.epoch)
        offer=c.visit.offered
        frames=[call.args[0].text for call in c.player.queue_frame.call_args_list]
        checks={'offerExpected':bool(offer)==case['offer'],'unconfirmed':not c.visit_confirmed,
            'noBookingFacts':not any(key.startswith('visit_') for key in s.evidence.memory.facts),
            'noNativeTimeGeneration':not c.llm.request_turns if case['offer'] else True}
        if offer and case['offer']:
            minute=clock_minutes(offer['time']['value'])
            start,end=case['bounds']
            checks['insideHours']=minute is not None and start<=minute<end
            day=offer['day']['value'].casefold()
            checks['futureClock']=day!='сегодня' or minute>=(case.get('utc_hour',15)+4)*60+40
            checks['specificDay']=day==case['day'] if 'day' in case else True
            checks['asksAgreement']=any('Подойдёт?' in text for text in frames)
        return {'id':case['id'],'input':case['text'],'apiCalls':model.await_count,'meaning':c.last_meaning,
            'proposal':offer,'queued':frames,'checks':checks,'passed':all(checks.values())}
    except Exception as exc:
        return {'id':case['id'],'passed':False,'errorType':type(exc).__name__}
    finally:
        await fixture.asyncTearDown();fixture.doCleanups()


async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True)
    options=parser.parse_args()
    report={'createdAt':datetime.now(timezone.utc).isoformat(),'controllerVersion':SEMANTIC_VERSION,
        'phoneCalls':0,'scope':__doc__,'cases':[]}
    for case in CASES:
        row=await run_case(case);report['cases'].append(row)
        print(json.dumps({key:row.get(key) for key in ('id','passed','proposal','checks','errorType')},ensure_ascii=False),flush=True)
    output=Path(options.output)
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');output.chmod(0o600)
    if not all(row['passed'] for row in report['cases']):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
