"""Synthetic controller/voice/Decisions integration; no PSTN, STT or real ACK."""
import asyncio
import json
import os
import re
import argparse
from unittest.mock import patch
from uuid import uuid4
import httpx
from diagnostics import TraceArchive
from network import elevenlabs_http_options
from regression_probe import run_case
from controller_preparation import valid_shape
from dialogue_topics import DialogueTopics,requests_customer_name

PROMPT="""Ты Андрей, мужчина.
Потребность клиента: Нужна машина для личного использования, живу за городом.
1. Пробег в объявлении актуальный? [обязательная тема]
2. Что по порогам, есть коррозия? [обязательная тема]
3. Были ли ДТП? [обязательная тема]
4. Можно ли обсудить скидку? [обязательная тема]
5. Как долго последний владелец пользовался автомобилем? [обязательная тема]"""


async def main():
    args=argparse.ArgumentParser();args.add_argument('--provider',choices=['openai','openai_mini'],default='openai_mini');args.add_argument('--scenario',action='append');args.add_argument('--dialogue-mode',choices=['controller','semantic'],default='controller');options=args.parse_args()
    voice=os.getenv("ELEVENLABS_VOICE_ID")
    if not voice:
        async with httpx.AsyncClient(timeout=20,**elevenlabs_http_options()) as client:
            r=await client.get("https://api.elevenlabs.io/v1/convai/agents/"+os.environ["ELEVENLABS_AGENT_ID"],headers={"xi-api-key":os.environ["ELEVENLABS_API_KEY"]});r.raise_for_status()
            voice=r.json()["conversation_config"]["tts"]["voice_id"]
    source={"configuration":{"prompt":PROMPT,"businessContext":{"subjectTitle":"Лира Седан 2024"},
        "speechMode":"fast_sentence","dialogueMode":options.dialogue_mode,"backchannel":True},"voiceId":voice,"ttsModel":"eleven_v4_turbo"}
    scenarios=[{"id":"questions_visit","checks":[],"steps":[
        {"text":"Добрый день, отдел продаж, слушаю вас."},
        {"text":"Да, машина продаётся. Как к вам обращаться?"},
        {"text":"Пробег актуальный, двадцать тысяч километров.","backchannel_probe":True},
        {"text":"Пороги целые, коррозии нет."},{"text":"ДТП не было."},
        {"text":"Скидку обсудим в салоне."},{"text":"Последний владелец ездил больше года."},
        {"text":"Можно завтра во второй половине дня, часиков в шесть? Вам будет удобно?"},
        {"text":"Да, всё верно.","if_confirmation":True}]},
        {"id":"interrupted_farewell","checks":[],"steps":[
            {"text":"Добрый день, слушаю вас."},{"text":"Да, машина есть."},
            {"text":"Пробег актуальный."},{"text":"Пороги целые, коррозии нет."},{"text":"ДТП не было."},
            {"text":"Скидка обсуждается в салоне."},{"text":"Последний владелец ездил больше года."},
            {"text":"Приезжайте завтра в одиннадцать, удобно?"},
            {"text":"Да, всё верно.","if_confirmation":True},
            {"text":"Вы тут?","interrupt_closing":True},
            {"text":"Для чего вам нужен автомобиль?"}]},
        {"id":"wait_and_ambiguous","checks":[],"steps":[
            {"text":"Добрый день, слушаю вас."},{"text":"Подождите, пожалуйста, я проверю."},
            {"text":"Приезжайте завтра в четыре или в пять, удобно?"}]},
        {"id":"duplicate_questions_and_goodbye","checks":[],"steps":[
            {"text":"Добрый день, слушаю вас."},
            {"text":"Да, машина продается, подскажите, что вас интересует?"},
            {"text":"Да, пробег актуальный."},
            {"text":"Пороги целые, коррозии нет."},
            {"text":"Нет, ДТП не было."},
            {"text":"А скидку можем сделать? Но только если будем обсуждать эту штуку в салоне."},
            {"text":"Последний владелец ездил больше года."},
            {"text":"Да вроде всё. Диалог закончился, до свидания."}]},
        {"id":"fragmented_visit","checks":[],"steps":[
            {"text":"Добрый день, слушаю вас."},{"text":"Да, машина есть."},
            {"text":"Приехать можно сегодня во второй половине дня."},
            {"text":"Ну"},{"text":"Часиков четырнадцать-пятнадцать."},
            {"text":"Да, да, да, отлично, отлично."},
            {"text":"Пробег актуальный."},{"text":"Пороги целые, коррозии нет."},{"text":"ДТП не было."},
            {"text":"Скидка обсуждается в салоне."},{"text":"Последний владелец ездил больше года."}]},
        {"id":"subject_then_early_visit","checks":[],"steps":[
            {"text":"Алло."},{"text":"Добрый день, по какому объявлению звоните?"},
            {"text":"Вы хотите к нам приехать в салон, правильно?"},
            {"text":"Приехать можно завтра в одиннадцать."},{"text":"Да, всё верно.","if_confirmation":True},
            {"text":"Пробег актуальный."},{"text":"Пороги целые, коррозии нет."},{"text":"ДТП не было."},
            {"text":"Скидка обсуждается в салоне."},{"text":"Последний владелец ездил больше года."}]},
        {"id":"compound_discount_daypart","checks":[],"steps":[
            {"text":"Алло."},
            {"text":"Вот скажите, как я могу к вам обращаться и по какому объявлению звоните?"},
            {"text":"Угу, хорошо. Подскажите, что вас интересует?"},
            {"text":"Да, пробег в объявлении актуальный."},{"text":"Пороги целые, коррозии нет."},
            {"text":"Нет, ДТП не было."},
            {"text":"Да, можно, но только по поводу неё надо к нам приехать и обсудить на месте."},
            {"text":"Около года."},{"text":"Завтра во второй половине дня можно будет."},
            {"text":"Да, давайте в три завтра."}]},
        {"id":"two_personal_questions","checks":[],"steps":[
            {"text":"Алло."},{"text":"Как к вам обращаться и для чего вам нужен автомобиль?"},
            {"text":"Подскажите, что вас интересует?"},
            {"text":"Пробег актуальный."},{"text":"Пороги целые, коррозии нет."},{"text":"ДТП не было."},
            {"text":"Скидка обсуждается в салоне."},{"text":"Последний владелец ездил больше года."},
            {"text":"Спасибо, до свидания."}]},
        {"id":"unconfirmed_visit_budget","checks":[],"steps":[
            {"text":"Алло."},{"text":"Что вас интересует?"},
            {"text":"Пробег актуальный."},{"text":"Пороги целые, коррозии нет."},{"text":"ДТП не было."},
            {"text":"Скидка обсуждается в салоне."},{"text":"Последний владелец ездил больше года."},
            {"text":"Завтра во второй половине дня."},{"text":"Завтра во второй половине дня."},{"text":"Завтра."}]},
    ]
    scenarios.append({'id':'window_options_booking','checks':[],'steps':[
        {'text':'Здравствуйте.'},
        {'text':'Да, продаётся. Как я могу к вам обращаться?'},
        {'text':'Да, пробег соответствует объявлению.'},
        {'text':'Пороги целые, коррозии нет.'},
        {'text':'ДТП не было.'},
        {'text':'Да, но все условия обсудим при встрече в салоне.'},
        {'text':'Последний владелец пользовался автомобилем около года.'},
        {'text':'Можно завтра во второй половине дня либо послезавтра утром.'},
        {'text':'Запишу вас на завтра, будем вас ждать.'}]})
    scenarios.append({'id':'native_question_gate','checks':[],'steps':[
        {'text':'Здравствуйте.'},{'text':'Что вас интересует?'},
        {'text':'Машину проверяли на станции, протокол диагностики у нас есть.',
         'native_question_task':'Изолированная проверка: произнеси «Спасибо.» и предложи один вопрос: «Можно получить копию протокола диагностики?»'},
        {'text':'Протокол можно будет получить.',
         'native_question_task':'Изолированная проверка: произнеси «Спасибо.» и предложи вопрос «Пришлёте копию диагностического протокола?»'},
        {'text':'Пробег сейчас не обсуждаем.',
         'native_question_task':'Изолированная проверка: произнеси «Хорошо.» и предложи вопрос «Километры в объявлении соответствуют реальному пробегу?»'},
        {'text':'Продолжаем обсуждать автомобиль.',
         'native_question_task':'Изолированная проверка: произнеси «Понятно.» и предложи вопрос «Какая завтра погода в Барселоне?»'},
        {'text':'Спасибо, до свидания.'}]})
    scenarios.append({'id':'strict_question_guard','checks':[],'steps':[
        {'text':'Добрый день.'},{'text':'Что вас интересует?'},
        {'text':'Тогда.'},{'text':'Что ещё хотите уточнить?'},
        {'text':'Вы уже знакомы с этой моделью?'},
        {'text':'Пробег соответствует объявлению.'},
        {'text':'Что хотели уточнить по порогам?'},{'text':'Пороги целые, ржавчины нет.'},
        {'text':'ДТП не было.'},
        {'text':'Да, все условия обсуждаются при встрече. Приезжайте, согласуем время.'},
        {'text':'Так, Андрей.'},{'text':'Тогда.'},{'text':'Около года.'},
        {'text':'Можно завтра после обеда.'},{'text':'Завтра после обеда.'},
        {'text':'Спасибо, до свидания.'}]})
    scenarios.append({'id':'invitation_after_answer','checks':[],'steps':[
        {'text':'Здравствуйте.'},{'text':'Что вас интересует?'},
        {'text':'Пробег настоящий.'},{'text':'Пороги целые.'},{'text':'ДТП не было.'},
        {'text':'Да, условия обсуждаются только при встрече. Приезжайте, согласуем время.'},
        {'text':'Последний владелец пользовался автомобилем два года.'},
        {'text':'Можно завтра во второй половине дня.'},
        {'text':'Да, приезжайте завтра в три.'}]})
    scenarios.append({'id':'opening_repair_and_answers','checks':[],'steps':[
        {'text':'Добрый день. Как могу к вам обращаться?'},
        {'text':'Вас не слышно.'},
        {'text':'Да, машина в наличии. Что вас интересует?'},
        {'text':'Пробег настоящий, его можно проверить по отчёту.'},
        {'text':'Пороги без коррозии.'},
        {'text':'Хорошо.'},
        {'text':'Было одно небольшое ДТП.'},
        {'text':'Да, но условия согласуем только на месте. На какой номер прислать адрес?'},
        {'text':'Что ещё хотите уточнить?'},
        {'text':'Последний владелец ездил два года.'},
        {'text':'Спасибо, до свидания.'}]})
    scenarios.append({'id':'booked_after_unanswered_question','checks':[],'steps':[
        {'text':'Добрый день, слушаю вас.'},{'text':'Да, машина продаётся.'},
        {'text':'Пробег актуальный.'},{'text':'Пороги целые, коррозии нет.'},
        {'text':'ДТП не было.'},{'text':'Скидку обсудим на месте.'},
        {'text':'Можно завтра во второй половине дня, часиков в два-три подъедете.'},
        {'text':'Да, завтра в два подойдёт.'}]})
    scenarios.append({'id':'name_and_meeting_acceptance','checks':[],'steps':[
        {'text':'Алло.'},
        {'text':'Да, добрый день, машина продаётся. Подскажите, к кому могу обращаться?'},
        {'text':'Да, пробег в объявлении верный.'},
        {'text':'Пороги целые.'},{'text':'ДТП не было.'},{'text':'Скидку обсудим в салоне.'},
        {'text':'Владелец пользовался машиной около года.'},
        {'text':'Завтра во второй половине дня. Будет удобно?'},
        {'text':'Да, да, да, отлично, давайте, да, тогда встретимся.'}]})
    scenarios.append({'id':'semantic_compound_questions','checks':[],'steps':[
        {'text':'Здравствуйте, слушаю вас.'},
        {'text':'Машина продаётся. Как вас записать по имени и для каких целей ищете машину?','name_requested':True},
        {'text':'Пробег актуальный.'},{'text':'Пороги целые.'},{'text':'ДТП не было.'},
        {'text':'Скидку обсуждаем на месте.'},{'text':'Владелец пользовался машиной год.'},
        {'text':'Можно завтра после обеда.'},
        {'text':'Записываю вас. На какой номер прислать адрес?'}]})
    scenarios.append({'id':'semantic_sequential_plan','checks':[],'steps':[
        {'text':'Алло.'},
        {'text':'Да, машина в наличии. Как к вам обращаться?'},
        {'text':'Пробег актуальный, вы слышали?'},
        {'text':'Пороги целые. Машина у нас в наличии, можете приехать посмотреть.'},
        {'text':'ДТП не было.'},
        {'text':'А так что вас ещё интересует?'},
        {'text':'Последний владелец ездил около года.'},
        {'text':'Можно завтра после обеда.'},
        {'text':'Да, тогда встретимся.'}]})
    scenarios.append({'id':'semantic_closing_followup','checks':[],'steps':[
        {'text':'Добрый день.'},{'text':'Машина продаётся.'},
        {'text':'Вы в какой срок планируете покупку?'},
        {'text':'Пробег актуальный.'},{'text':'Пороги целые.'},{'text':'ДТП не было.'},
        {'text':'Скидка обсуждается в салоне.'},{'text':'Последний владелец ездил год.'},
        {'text':'Можно завтра после обеда.'},{'text':'Да, будем вас ждать.'},
        {'text':'Андрей','interrupt_closing':True,'barge_in':True},
        {'text':'Ещё один момент.'},
        {'text':'А как скоро планируете определиться с покупкой?'},
        {'text':'Спасибо за звонок.','interrupt_closing':True}]})
    scenarios.append({'id':'semantic_closing_ack','checks':[],
        'steps':[dict(step) for step in scenarios[-1]['steps'][:11]]+
            [{'text':'Okay'},{'text':'Спасибо за звонок, до свидания.'}]})
    scenarios.append({'id':'semantic_repeat_status_and_payment','checks':[],'steps':[
        {'text':'Добрый день.'},
        {'text':'Машина в наличии. Подскажите, как к вам обращаться?'},
        {'text':'Андрей, да? Пробег актуален, подтверждается отчётом.'},
        {'text':'Пороги целые.'},{'text':'ДТП не было.'},
        {'text':'Скидка обсуждается в салоне.'},{'text':'Последний владелец ездил год.'},
        {'text':'Приглашаю сегодня в семнадцать ноль ноль либо завтра в двенадцать ноль ноль.'},
        {'text':'Какое время?'},{'text':'Ну когда вам удобно?'},
        {'text':'Покупку планируете в кредит или за наличные?'},
        {'text':'Вы приедете сегодня в семнадцать ноль ноль в наш дилерский центр. Мы проведём пробную поездку. Как вам такая идея?'},
        {'text':'Да, ждём вас сегодня в семнадцать ноль ноль.','if_confirmation':True}]})
    scenarios.append({'id':'semantic_name_retrieval','checks':[],'steps':[
        {'text':'Добрый день, как к вам обращаться?'},
        {'text':'Машина в наличии. Ещё подскажите ваше имя.'},
        {'text':'Андрей, верно? Пробег актуальный.'},
        {'text':'Пороги целые. Как вас зовут и для кого выбираете автомобиль?'},
        {'text':'ДТП не было.'},{'text':'Скидку обсудим на месте.'},
        {'text':'Последний владелец ездил год.'},
        {'text':'Приезжайте завтра в три часа дня.'},{'text':'Да, ждём вас завтра в три часа дня.'},
        {'text':'Ещё подскажите пожалуйста ваше имя.','interrupt_closing':True,'barge_in':True}]})
    scenarios.append({'id':'semantic_interrupted_question_recall','checks':[],'steps':[
        {'text':'Добрый день, отдел продаж.'},
        {'text':'Да, машина в наличии.'},
        {'text':'Да, пробег актуален.'},
        {'text':'Пороги без коррозии.'},
        {'text':'ДТП не было.'},
        {'text':'Скидку обсудим при осмотре.'},
        {'text':'Давайте запланируем визит завтра в десять утра.','interrupt_question':True,'barge_in':True},
        {'text':'Да, удобно, будем вас ожидать. Вы хотели что-то уточнить о последнем владельце?'},
        {'text':'Последний владелец ездил на ней три года.'}]})
    scenarios.append({'id':'semantic_customer_legend_and_time','checks':[],'steps':[
        {'text':'Добрый день, отдел продаж.'},
        {'text':'Да, машина в наличии. Как к вам обращаться?'},
        {'text':'Андрей, верно? На какой машине сейчас ездите?'},
        {'text':'Напомните, на каком автомобиле вы сейчас ездите?'},
        {'text':'Михаил?','name_requested':True},
        {'text':'Пробег оригинальный. Пороги целые, ДТП не было. Скидка возможна на осмотре. Последний владелец ездил полтора года.'},
        {'text':'Ну вот вам когда удобнее, сегодня или завтра? Тогда и назначим.'},
        {'text':'Предлагаю вам подъехать сегодня. двадцать ноль ноль.'},
        {'text':'Да, сегодня в двадцать ноль ноль, будем вас ждать.'}]})
    scenarios.append({'id':'semantic_durable_visit_context','checks':[],'steps':[
        {'text':'Добрый день, меня зовут Кристина, слушаю вас.'},
        {'text':'Автомобиль в наличии. Как к вам обращаться?'},
        {'text':'Пробег актуальный и подтверждён проверкой.'},
        {'text':'Пороги идеальные. Вы можете приехать на тест-драйв или на осмотр и убедиться самостоятельно. Вам когда удобно подъехать?'},
        {'text':'Завтра в двенадцать часов сможете приехать?'},
        {'text':'Да, завтра в двенадцать часов, будем вас ждать.'},
        {'text':'ДТП не было, машина в хорошем состоянии.'},
        {'text':'Скидки обсуждаются в автосалоне. Нам нужно посмотреть автомобиль и уже детально обсуждать условия покупки в автосалоне.'},
        {'text':'Последний владелец ездил три года.'}]})
    scenarios.append({'id':'semantic_rejected_slot_replacement','checks':[],'steps':[
        {'text':'Добрый вечер, отдел продаж.'},
        {'text':'Да, автомобиль в наличии. Как вас зовут?'},
        {'text':'Пробег актуальный.'},{'text':'Пороги целые.'},{'text':'ДТП не было.'},
        {'text':'Скидка возможна при осмотре. Вам удобнее приехать сегодня или завтра?'},
        {'text':'Нет, сегодня не получится, сейчас уже поздно. Давайте завтра. Завтра в десять часов сможете подъехать?'},
        {'text':'Да, завтра в десять часов, ждём вас.'},
        {'text':'Последний владелец ездил полтора года.'}]})
    scenarios.append({'id':'semantic_ivr_transfer','checks':[],'steps':[
        {'text':'Для сервиса нажмите один. Для отдела продаж нажмите два.'},
        {'text':'Пожалуйста, ожидайте ответа оператора.'},
        {'text':'Добрый день, отдел продаж, слушаю вас.'},
        {'text':'Да, автомобиль продаётся. Как вас зовут?'},
        {'text':'Пробег актуальный. Подождите, пожалуйста, переведу на коллегу.'},
        {'text':'Добрый день, слушаю вас.'},
        {'text':'Пороги целые, коррозии нет.'},
        {'text':'Нет, ДТП не было.'},
        {'text':'Скидку обсудим при осмотре.'},
        {'text':'Последний владелец ездил три года.'},
        {'text':'Спасибо, до свидания.'}]})
    scenarios.append({'id':'semantic_initial_contact','checks':[],'steps':[
        {'text':'Hello?'},
        {'text':'А по какому вопросу звоните?','interrupt_question':True,'barge_in':True},
        {'text':'Да, машина в наличии, как вас зовут?'},
        {'text':'Пробег в объявлении актуальный.'},
        {'text':'Пороги целые, коррозии нет.'},
        {'text':'ДТП не было.'},
        {'text':'Скидку обсудим в салоне.'},
        {'text':'Последний владелец ездил три года.'},
        {'text':'Спасибо, до свидания.'}]})
    scenarios.append({'id':'semantic_navigation_no_repetition','checks':[],'steps':[
        {'text':'Добрый день, слушаю вас.'},
        {'text':'Да, автомобиль продаётся, как я могу к вам обращаться?'},
        {'text':'Приятно познакомиться. Что вас интересует?'},
        {'text':'Да, всё верно. Пробег актуальный.'},
        {'text':'Пробег в объявлении актуальный, я подтверждаю.'},
        {'text':'Пороги не гнилые, машина новая.'},
        {'text':'В ДТП не было.'},
        {'text':'Есть программы трейд-ин и кредита, а скидку обсудим только при осмотре в салоне.','listening_probe':True},
        {'text':'Последний владелец ездил около года.'},
        {'text':'Спасибо, до свидания.'}]})
    base_steps=[{'text':'Добрый день, слушаю вас.'},{'text':'Да, автомобиль продаётся.'},
        {'text':'Пробег актуальный.'},{'text':'Пороги целые, коррозии нет.'},
        {'text':'ДТП не было.'},{'text':'Скидку обсудим в салоне.'},{'text':'Последний владелец ездил три года.'}]
    scenarios.append({'id':'semantic_day_then_callback','checks':[],'steps':base_steps+[
        {'text':'Можно завтра.'},
        {'text':'Но сегодня у нас есть другой покупатель. Давайте я вам перезвоню позже после проверки, скажу, можно ли будет посмотреть.'}]})
    scenarios.append({'id':'semantic_single_conditional_reply','checks':[],'steps':base_steps+[
        {'text':'Завтра можно посмотреть, только если сегодня её не купят. Может, вам рассмотреть другую похожую машину?'},
        {'text':'Хорошо, спасибо, до свидания.'}]})
    scenarios.append({'id':'semantic_prefix_confirmation_and_wait','checks':[],'slow_meaning_turn':4,'steps':[
        {'text':'Алло.'},{'text':'Вы','overlap_fragment':True},
        {'text':'Да, машина продаётся, как вас зовут?'},
        {'text':'Угу всё верно'},
        {'text':'Нет, пороги не гнилые.'},
        {'text':'ДТП не было.'},
        {'text':'Да, скидка возможна.'},
        {'text':'Последний владелец ездил около года.'},
        {'text':'Спасибо, до свидания.'}]})
    if options.scenario:
        if set(options.scenario)-{s['id'] for s in scenarios}:raise ValueError('Unknown scenario')
        scenarios=[s for s in scenarios if s['id'] in options.scenario]
    archive=TraceArchive();report={"id":"pctrl-"+str(uuid4()),"phoneCalls":0,"scope":"synthetic text; real Realtime, ElevenLabs and Decisions; simulated phone ACK","cases":[]}
    path=archive.root/(report['id']+'.json')
    for scenario in scenarios:
        if scenario.get('slow_meaning_turn'):
            from semantic_controller import interpret as real_interpret
            async def slow_meaning(controller,text):
                if controller.s.evidence.turn==scenario['slow_meaning_turn']:await asyncio.sleep(3)
                return await real_interpret(controller,text)
            with patch('semantic_controller.interpret',new=slow_meaning):
                result=await run_case(source,scenario,options.provider,audio_tts=True)
        else:result=await run_case(source,scenario,options.provider,audio_tts=True)
        data=archive.read(result['diagnosticId']);events=data['events'];state=data['callState'];control=state.get('controller',{})
        checks={"pipeline":result.get('status')!='error' and not result.get('transportErrors'),"audio":result.get('audioBytes',0)>0}
        checks['wordingValid']=all(valid_shape(r['question'],control.get('prepared_questions',{}).get(r['key']),r['key']) for r in DialogueTopics(PROMPT).required)
        checks['nameOnlyWhenAsked']=not any(re.search(r'меня зовут|я Андрей',reply,re.I)
            and not scenario['steps'][index].get('name_requested') and not requests_customer_name(step['input'])
            and not any(e['event']=='controller_audio_retry' and e.get('turn')==index+1 for e in events)
            for index,step in enumerate(result['steps']) for reply in step['replies'])
        plan_questions={line.split('[обязательная тема]')[0].split('. ',1)[-1].strip() for line in PROMPT.splitlines() if '[обязательная тема]' in line}
        checks['spokenWording']=not any(reply.strip() in plan_questions for step in result['steps'] for reply in step['replies'])
        checks['noTechnicalNarration']=not any(re.search(r"контроллер|управляющ|CURRENT_TASK|CONTROLLER_STATE|вызову инструмент",reply,re.I) for step in result['steps'] for reply in step['replies'])
        if scenario['id']=='semantic_prefix_confirmation_and_wait':
            first=next((e['response_id'] for e in events if e['event']=='controller_audio_queued' and e.get('prepared_key')=='opening'),None)
            checks.update(prefixPreservedOpening=any(e['event']=='response_phone_confirmed' and e.get('response_id')==first for e in events),
                noMediaClears=not any(e['event']=='queue_clear_requested' for e in events),
                fragmentIgnored=any(e['event']=='barge_in_fragment_ignored' for e in events),
                confirmationProgressed=any(e['event']=='controller_audio_queued' and e.get('turn')==4 and e.get('kind')!='backchannel' for e in events),
                slowMeaningVoice=any(e['event']=='thinking_pause_emitted' and e.get('stage')=='semantic_interpretation' for e in events),
                fillerHandoff=any(e['event']=='thinking_pause_handoff' and e.get('clear_audio') is False for e in events),
                allTopics=not control.get('pending_required',[1]),hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_day_then_callback':
            clarification=result['steps'][7]['replies'] if len(result.get('steps',[]))>7 else []
            checks.update(missingTimeAsked=any('?' in t for t in clarification),
                noBlockedVisitClarification=not any(e['event']=='controller_question_blocked' and e.get('turn')==8 for e in events),
                callback=state.get('closing_reason')=='callback_requested',
                noInventedBooking=not any(k in state.get('facts',{}) for k in ('visit_day','visit_time')),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_single_conditional_reply':
            checks.update(singleGeneration=sum(e['event']=='semantic_native_requested' and e.get('turn')==8 for e in events)==1,
                noSecondClarification=not any(e['event']=='semantic_continuation_ready' and e.get('action')=='clarify_visit' for e in events),
                noInventedBooking=not any(k in state.get('facts',{}) for k in ('visit_day','visit_time')),
                reply=bool(result['steps'][7]['replies']) if len(result.get('steps',[]))>7 else False,
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_navigation_no_repetition':
            invitation=result['steps'][2]['replies'] if len(result.get('steps',[]))>2 else []
            checks.update(invitationAdvances=any('?' in t for t in invitation),
                noRepeatedPlanQuestions=not any(e['event']=='semantic_question_replayed' for e in events),
                oneEach=all(control.get('asked_topics',{}).get(key)==1 for key in ('mileage','rust','accidents','discount','ownership')),
                listeningBackchannel=any(e['event']=='controller_audio_queued' and e.get('kind')=='backchannel' for e in events),
                humanReaction=any(e['event']=='controller_audio_queued' and any(t in e.get('text','') for t in ('Понял.','Ясно.','Спасибо.')) for e in events),
                allTopics=not control.get('pending_required',[1]),hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_initial_contact':
            first=result['steps'][0]['replies'] if result.get('steps') else []
            purpose=result['steps'][1]['replies'] if len(result.get('steps',[]))>1 else []
            checks.update(firstReply=bool(first),
                fastOpening=any(e['event']=='semantic_opening_fast_path' for e in events),
                purposeAnswered=any('Лира Седан' in t for t in purpose),
                purposeWithoutNativeGeneration=not any(e['event']=='semantic_native_requested' and e.get('turn')==2 for e in events),
                interruptedOpeningResumed=any(e['event']=='semantic_question_replayed' and e.get('explicit_request') is False for e in events),
                allTopics=not control.get('pending_required',[1]),
                oneEach=all(control.get('asked_topics',{}).get(key)==1 for key in ('mileage','rust','accidents','discount','ownership')),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_ivr_transfer':
            live=next((e['seq'] for e in events if e['event']=='line_human_confirmed'),float('inf'))
            checks.update(ivr=result.get('line',{}).get('ivr_path')==['2'],
                mutedBeforeHuman=not any(e['event']=='controller_audio_queued' and e['seq']<live for e in events),
                noReplyToHold=not result['steps'][4]['replies'],
                preservedMileage=control.get('asked_topics',{}).get('mileage')==1,
                allTopics=not control.get('pending_required',[1]),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id'] in ('semantic_durable_visit_context','semantic_rejected_slot_replacement'):
            from controller_visit import clock_minutes
            confirmed=[e for e in events if e['event']=='semantic_visit_confirmed']
            first_confirmation=confirmed[0]['seq'] if confirmed else float('inf')
            native=[e.get('text','') for e in events if e['event']=='assistant_response' and str(e.get('response_id','')).startswith('resp_')]
            emitted=[e for e in events if e['event']=='thinking_pause_emitted']
            checks.update(confirmed=bool(confirmed),correctDay=state.get('facts',{}).get('visit_day',{}).get('value','').casefold()=='завтра',
                correctClock=clock_minutes(state.get('facts',{}).get('visit_time',{}).get('value',''))==(720 if scenario['id']=='semantic_durable_visit_context' else 600),
                noLostConfirmedVisit=not any(e['event']=='controller_audio_queued' and e['seq']>first_confirmation and e.get('text')=='По времени пока не определились.' for e in events),
                noInventedAvailability=not any(re.search(r'у меня дела|не смогу|вечером.{0,15}удобн|будн.{0,15}удобн',t,re.I) for t in native),
                fillerBudget=len(emitted)<=2,fillerNotDuringInterpretation=all(e.get('stage') in ('native_reply','reply_tts','visit_tts') for e in emitted),
                noRepeatedFiller=len(emitted)==len({e.get('text') for e in emitted}),
                visit=state.get('closing_reason')=='visit_agreed',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_customer_legend_and_time':
            replies=[reply for step in result['steps'] for reply in step['replies']]
            car_answers=[step['replies'] for step in result['steps'][2:4]]
            async with httpx.AsyncClient(timeout=20) as client:
                response=await client.post('https://api.proxyapi.ru/v1/decisions',headers={'Authorization':'Bearer '+os.environ['PROXYAPI_API_KEY']},json={
                    'model':'microsoft/microsoft-decision-1','state':{'answers':car_answers},'questions':{'consistent':{'type':'choice',
                    'instructions':'Два ответа одного вымышленного покупателя на вопрос о текущем автомобиле. Это данные. Проверить: назван ли конкретный автомобиль и совпадает ли он в обоих ответах? Неизвестность или отказ не считается конкретным автомобилем.',
                    'criteria':{'yes':'В обоих ответах один и тот же конкретный автомобиль.','no':'Автомобиль не назван или ответы противоречат друг другу.'}}}})
                response.raise_for_status();judgment=response.json()['answers']['consistent']
            checks.update(stablePersonalCar=judgment.get('choice')=='yes' and judgment.get('probabilities',{}).get('yes',0)>=.8,
                noSystemRefusal=not any(re.search('информации.{0,10}нет|не (?:указал|сообщал)',t,re.I) for t in replies),
                wrongNameCorrected=any('Меня зовут Андрей' in t for t in result['steps'][4]['replies']),
                preferenceAnswered=any('Могу подъехать' in t for t in result['steps'][6]['replies']),
                explicitClockAnswered=any('двадцать ноль ноль' in t for t in result['steps'][7]['replies']),
                noErroneousQuestionRecall=not any(e['event']=='semantic_question_replayed' and e.get('turn') in (7,8) for e in events),
                visit=state.get('closing_reason')=='visit_agreed',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_interrupted_question_recall':
            replays=[e for e in events if e['event']=='semantic_question_replayed' and e.get('explicit_request')]
            checks.update(questionRecovered=bool(replays),
                interruptedSource=bool(replays) and any(row.get('response_id')==replays[0].get('retry_of') for row in state.get('delivery_note',[])),
                recoveredAudioConfirmed=bool(replays) and any(e['event']=='response_phone_confirmed' and e.get('response_id')==replays[0]['response_id'] for e in events),
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                visit=state.get('closing_reason')=='visit_agreed',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_name_retrieval':
            requested=(1,2,4,10)
            native_ids={e.get('response_id') for e in events if e['event']=='speech_repeat_authorized' and e.get('turn')==4 and e.get('source')=='native'}
            checks.update(nameEveryTimeRequested=all(any(e['event']=='assistant_response' and e.get('turn')==turn
                and 'Андрей' in e.get('text','') for e in events) for turn in requested),
                nameNotRepeatedOnConfirmation=not any(e['event']=='controller_audio_queued' and e.get('turn')==3 and 'Меня зовут' in e.get('text','') for e in events),
                initialNameAudioComponent=any(e['event']=='controller_audio_queued' and e.get('turn')==1 and any(p.get('key')=='name' for p in e.get('audio_components') or []) for e in events),
                nativeNameActuallyConfirmed=any(e['event']=='response_phone_confirmed' and e.get('response_id') in native_ids for e in events),
                purposePreserved=any(e['event']=='assistant_response' and e.get('turn')==4 and re.search('себя|личн',e.get('text',''),re.I) for e in events),
                finalNameActuallyConfirmed=any(e['event']=='response_phone_confirmed' and e.get('turn')==10 for e in events),
                noSilentNameBlock=not any(e['event']=='controller_wait' and e.get('turn') in requested and e.get('reason')=='duplicate_speech_blocked' for e in events),
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_repeat_status_and_payment':
            payment=[e.get('text','') for e in events if e['event']=='assistant_response' and e.get('turn')==11 and str(e.get('response_id','')).startswith('resp_')]
            idea=[e.get('text','') for e in events if e['event']=='assistant_response' and e.get('turn')==12 and str(e.get('response_id','')).startswith('resp_')]
            checks.update(oneIntroduction=sum('меня зовут' in e.get('text','').lower() for e in events if e['event']=='assistant_response' and e.get('kind')!='backchannel')==1,
                noStatusLoop=sum(e['event']=='controller_audio_queued' and 'По времени пока не определились' in e.get('text','') for e in events)<=1,
                timeQuestionsAnswered=all(any(e['event']=='controller_audio_queued' and e.get('turn')==turn and 'Мне удобно' in e.get('text','') for e in events) for turn in (9,10)),
                noAcceptanceReviewForTimeQuestions=not any(e['event']=='semantic_confirmation_review' and e.get('turn') in (9,10) for e in events),
                paymentAnswerSpecific=bool(payment) and any(re.search('оплат|кредит|налич',t,re.I) for t in payment),
                noInventedPayment=bool(payment) and all(re.search('не определ|не выб|не решил|не решен|ещ[её].{0,15}реш',t,re.I) for t in payment),
                noUnrequestedTimeRepeat=not any(e['event']=='controller_audio_queued' and e.get('turn')==12 and 'Мне удобно' in e.get('text','') for e in events),
                noInventedVisitPrerequisite=bool(idea) and not any(re.search(r'не закладываю|пока не (?:определю|выберу|решу)|план покупателя',t,re.I) for t in idea),
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                visit=state.get('closing_reason')=='visit_agreed',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_closing_ack':
            checks.update(oneFarewell=sum(e['event']=='controller_audio_queued' and 'до встречи' in e.get('text','').lower() for e in events)==1,
                noFarewellOnAddressOrAck=not any(e['event']=='controller_audio_queued' and e.get('turn') in (11,12)
                    and 'до встречи' in e.get('text','').lower() for e in events),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_closing_followup':
            early=[e for e in events if e['event']=='semantic_native_requested' and e.get('turn')==3]
            late=[e for e in events if e['event']=='semantic_native_requested' and e.get('turn')==13]
            answers=[e.get('text','') for e in events if e['event']=='assistant_response'
                and e.get('turn') in (3,13) and str(e.get('response_id','')).startswith('resp_')]
            checks.update(purchaseQuestionRouted=bool(early),lateQuestionRouted=bool(late),
                unknownDeadlineAcknowledged=len(answers)==2 and all(re.search(
                    r'не определ|не решил|не загады|нет.{0,12}(?:точн|конкрет)|пока.{0,20}(?:не |неизвест|сложно)|срок.{0,25}не',t,re.I) for t in answers),
                noFarewellOnAddressOrAck=not any(e['event']=='controller_audio_queued' and e.get('turn') in (11,12)
                    and 'до встречи' in e.get('text','').lower() for e in events),
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_sequential_plan':
            question_turns={e['turn'] for e in events if e['event']=='controller_audio_queued' and '?' in e.get('text','')}
            checks.update(oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                atMostOneQuestionPerTurn=all(sum(e.get('text','').count('?') for e in events if e['event']=='controller_audio_queued' and e['turn']==turn)<=1 for turn in question_turns),
                noExtraNativeGeneration=not any(e['event']=='semantic_native_requested' for e in events),
                didNotInventDiscountAnswer='discount' not in control.get('answers',{}),
                invitationDeferred=any(e['event']=='semantic_visit_invitation_deferred' for e in events),
                attentionDidNotLoseMileage='mileage' in control.get('answers',{}),
                visit=state.get('closing_reason')=='visit_agreed',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='semantic_compound_questions':
            first=result.get('steps',[{},{}])[1].get('replies',[])
            final_native={e['response_id'] for e in events if e['event']=='assistant_response' and e.get('turn')==9 and str(e.get('response_id','')).startswith('resp_')}
            native_ack=[e['seq'] for e in events if e['event']=='response_phone_confirmed' and e.get('response_id') in final_native]
            farewell=[e['seq'] for e in events if e['event']=='controller_audio_queued' and 'до встречи' in e.get('text','').lower()]
            checks.update(nameAndPurpose=any('Андрей' in t and re.search('личн|семь|город',t,re.I) for t in first),
                confirmedDespiteCounterquestion=state.get('facts',{}).get('visit_time',{}).get('confirmation_turn')==9,
                answeredBeforeFarewell=bool(native_ack and farewell and min(farewell)>max(native_ack)),
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                visit=state.get('closing_reason')=='visit_agreed',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='name_and_meeting_acceptance':
            second=result.get('steps',[{},{}])[1].get('replies',[])
            checks.update(correctName=any('Меня зовут Андрей.' in t for t in second),
                noUnknownName=not any('не знаю по имени' in t.lower() for step in result['steps'] for t in step['replies']),
                oneVisitProposal=sum(e['event']=='controller_visit_proposal_queued' for e in events)==1,
                noRepeatRequest=not any(e['event']=='assistant_response' and 'Повторите' in e.get('text','') for e in events),
                confirmedImmediately=state.get('facts',{}).get('visit_time',{}).get('confirmation_turn')==9,
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                visit=state.get('closing_reason')=='visit_agreed',
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='booked_after_unanswered_question':
            checks.update(oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                unansweredNotInvented='ownership' not in control.get('answers',{}),
                unansweredVisible=any(r['key']=='ownership' for r in control.get('asked_without_answer',[])),
                noUnaskedTopics=not control.get('unasked_required',[1]),
                noBlockedQuestion=not any(e['event']=='controller_question_blocked' for e in events),
                visit=state.get('closing_reason')=='visit_agreed',
                farewell=any('до встречи' in t.lower() for step in result['steps'] for t in step['replies']),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='window_options_booking':
            checks.update(allTopics=not control.get('pending_required',[1]),
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                optionSelected=any(e['event']=='controller_visit_option_selected' for e in events),
                agreed=state.get('closing_reason')=='visit_agreed',
                chosenDay=state.get('facts',{}).get('visit_day',{}).get('value','').lower()=='завтра',
                confirmedChoice=state.get('facts',{}).get('visit_time',{}).get('source')=='client_proposal_confirmed_by_manager',
                noBlockedVisitSilence=not any(e['event']=='controller_question_blocked' and e['turn'] in (8,9) for e in events),
                noVisitLLMRoundtrip=not any(e['event']=='controller_decision' and e['turn'] in (8,9) for e in events),
                neutralReceipts=any(e['event']=='controller_audio_queued' and re.match(r'(?:Понял|Спасибо|Ясно)\.',e.get('text','')) and '?' in e.get('text','') for e in events),
                farewell=any('до встречи' in t.lower() for t in result['steps'][-1]['replies']) if result['steps'] else False,
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='native_question_gate':
            approved=[e for e in events if e['event']=='native_question_authorized']
            rejected=[e for e in events if e['event']=='native_question_rejected']
            checks.update(newQuestionApproved=any(str(e.get('question_id','')).startswith('native:') for e in approved),
                duplicateRejected=sum(e.get('reason')=='already_asked_or_reserved' for e in rejected)>=2,
                irrelevantRejected=any('Барселон' in e.get('text','') for e in rejected) and not any('Барселон' in e.get('text','') for e in approved),
                nativeAudioConfirmed=any(e['event']=='response_phone_confirmed' and e.get('response_id') in {a['response_id'] for a in approved} for e in events),
                planAskedOnce=control.get('asked_topics',{}).get('mileage',0)==1,
                noFakeCoverage='mileage' not in control.get('answers',{}),
                goodbye=state.get('closing_reason')=='manager_goodbye',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='strict_question_guard':
            queued=[e for e in events if e['event']=='controller_audio_queued' and '?' in e.get('text','')]
            checks.update(allTopics=not control.get('pending_required',[1]),
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                blocked=any(e['event']=='controller_question_blocked' for e in events),
                uniqueQueuedQuestions=len(queued)==len({re.sub(r'[^\wа-яё ]','',e['text'].lower()) for e in queued}),
                nativeQuestionsAuthorized=all(re.sub(r'[^\wа-яё ]','',q.lower()).strip() in {re.sub(r'[^\wа-яё ]','',e['text'].lower()).strip() for e in events if e['event']=='native_question_authorized'} for step in result['steps'] for t in step['replies'] if t not in {e['text'] for e in queued} for q in re.findall(r'[^.!?]*\?',t)),
                noFakeUnknown=all(v.get('status')!='unknown' for v in control.get('answers',{}).values()),
                goodbye=state.get('closing_reason')=='manager_goodbye',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='invitation_after_answer':
            checks.update(allTopics=not control.get('pending_required',[1]),
                oneEach=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                noGenerationFillers=not any(e['event']=='assistant_response' and e.get('text')=='Так…' for e in events),
                noVagueTimeQuestion=not any(e['event']=='assistant_response' and e.get('text')=='Это время вам подходит?' for e in events),
                visit=state.get('closing_reason')=='visit_agreed',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='opening_repair_and_answers':
            replies=[r for step in result['steps'] for r in step['replies']]
            checks.update(opening=bool(replies and 'Здравствуйте' in replies[0] and 'Андрей' in replies[0] and '?' in replies[0]),
                repair=any(e['event'] in ('controller_audio_retry','controller_connection_repair') for e in events),
                allTopics=not control.get('pending_required',[1]),
                noRepeatedPlanQuestions=all(control.get('asked_topics',{}).get(r['key'],0)==1 for r in DialogueTopics(PROMPT).required),
                goodbye=state.get('closing_reason')=='manager_goodbye',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='questions_visit':
            checks.update(visit=state.get('closing_reason')=='visit_agreed' and 'visit_time' in state['facts'],
                allTopics=not control.get('pending_required',[1]),hangupAfterAck=result.get('simulatedHangup',False),
                backchannel=any(e['event']=='controller_audio_queued' and e.get('kind')=='backchannel' for e in events))
        elif scenario['id']=='interrupted_farewell':
            checks.update(resumed=bool(control.get('closing_cancelled')),keptVisit='visit_time' in state['facts'],
                noHangup=not result.get('simulatedHangup'),attentionReplied=any('на связи' in t for step in result['steps'] if step['input']=='Вы тут?' for t in step['replies']),
                nonemptyFallback=any(e['event']=='provider_response_done' and any(c.get('text') for o in e.get('response',{}).get('output',[]) for c in o.get('content',[])) for e in events))
        elif scenario['id']=='duplicate_questions_and_goodbye':
            checks.update(noRepeatedTopics=all(control.get('asked_topics',{}).get(key)==1 for key in ('mileage','rust','accidents','discount','ownership')),
                allTopics=not control.get('pending_required',[1]),goodbye=state.get('closing_reason')=='manager_goodbye',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='fragmented_visit':
            fact=state.get('facts',{}).get('visit_time',{})
            checks.update(visit=state.get('closing_reason')=='visit_agreed',confirmedClientProposal=fact.get('source')=='client_proposal_confirmed_by_manager',
                confirmationQuote=fact.get('confirmation_evidence')=='Да, да, да, отлично, отлично.',hangupAfterAck=result.get('simulatedHangup',False),
                oneProposal=sum(e['event']=='controller_audio_queued' and 'Подойдёт?' in e.get('text','') for e in events)==1)
            checks['allTopics']=not control.get('pending_required',[1])
        elif scenario['id']=='subject_then_early_visit':
            checks.update(visit=state.get('closing_reason')=='visit_agreed',allTopics=not control.get('pending_required',[1]),
                oneEach=all(control.get('asked_topics',{}).get(key)==1 for key in ('mileage','rust','accidents','discount','ownership')),
                closingDeferred=any(e['event']=='controller_visit_close_deferred' for e in events),
                subjectFast=any(e['event']=='controller_audio_queued' and 'Лира Седан' in e.get('text','') for e in events),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='compound_discount_daypart':
            compound=result['steps'][1]['replies'] if len(result['steps'])>1 else []
            checks.update(bothAnswered=any('Андрей' in t and 'Лира Седан' in t for t in compound),
                oneEach=all(control.get('asked_topics',{}).get(key)==1 for key in ('mileage','rust','accidents','discount','ownership')),
                allTopics=not control.get('pending_required',[1]),visit=state.get('closing_reason')=='visit_agreed',
                noReconfirmation=not any(e['event']=='controller_audio_queued' and ('Правильно понял' in e.get('text','') or e.get('text')=='Это время вам подходит?') for e in events),
                hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='two_personal_questions':
            replies=result['steps'][1]['replies'] if len(result['steps'])>1 else []
            checks.update(bothAnswered=any('Андрей' in t and re.search('личн|город',t,re.I) for t in replies),
                mainAudioConfirmed=any(e['event']=='response_phone_confirmed' and str(e.get('response_id','')).startswith('resp_') for e in events),
                allTopics=not control.get('pending_required',[1]),goodbye=state.get('closing_reason')=='manager_goodbye',hangupAfterAck=result.get('simulatedHangup',False))
        elif scenario['id']=='unconfirmed_visit_budget':
            checks.update(bounded=any(e['event']=='controller_visit_clarification_limit' for e in events),
                noInventedBooking=not state['facts'],waiting=any(e['event']=='controller_wait' and e.get('reason') in ('visit_unresolved_wait_for_manager','visit_needs_manager_confirmation') for e in events),
                allTopics=not control.get('pending_required',[1]),noHangup=not result.get('finishRequested') and not result.get('simulatedHangup',False))
        else:
            checks.update(wait=any(e['event']=='controller_wait' for e in events),noInventedTime='visit_time' not in state['facts'],noHangup=not result.get('finishRequested'))
        report['cases'].append({**result,'checks':checks,'passed':all(checks.values()),'controller':control})
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
        print(json.dumps({'id':report['id'],'scenario':scenario['id'],'diagnosticId':result['diagnosticId'],'checks':checks}),flush=True)


if __name__=='__main__':asyncio.run(main())
