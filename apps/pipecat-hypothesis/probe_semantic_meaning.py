"""Developer paraphrase validation through real Decisions; no TTS/STT/phone calls."""
import asyncio
import json
import argparse
from types import SimpleNamespace
from uuid import uuid4

from conversation import ConversationMemory
from diagnostics import TraceArchive
from pipeline import Turn
from policy import Evidence,Playback
from semantic_controller import SemanticController
from turn_meaning import interpret,MODEL

PROMPT='Ты Андрей, мужчина.\nДоставляете по области? [обязательная тема]\nРаботаете по выходным? [обязательная тема]'
CASES=[
    ('focus_beneficiary','Машину подбираете себе или кому-то из семьи?',{'reply_focus':'beneficiary'}),
    ('focus_beneficiary_distorted','Для кого сейчас я подбираю себе автомобиль?',{'reply_focus':'beneficiary'}),
    ('focus_selected_model','Какая марка и модель вам нужна?',{'reply_focus':'selected_subject'}),
    ('focus_visit_day','Для оценки вашей машины выберем время. Удобнее завтра или в субботу?',{'reply_focus':'visit_only','visit_request':'details'}),
    ('focus_familiarity','Машину выбираете для себя? С автомобилем уже знакомы?',{'reply_focus':'other','other_questions':True}),
    ('focus_familiarity_distorted','Для себя подбираете? Сафтомобили уже знакомы?',{'reply_focus':'other','other_questions':True}),
    ('focus_prior_contact','Вы уже звонили нашим менеджерам на прошлой неделе?',{'reply_focus':'prior_contact'}),
    ('focus_own_vehicle','Отлично, будем ждать вас завтра. Нынешнюю Шкоду планируете продать?',{'reply_focus':'own_vehicle','other_questions':True}),
    ('focus_mixed_visit','Подъедете в субботу? Какой пробег вашей машины?',{'reply_focus':'other','other_questions':True}),
    ('tail_after_answer','Кузов в хорошем состоянии. В авариях машина',{'control':'fragment'}),
    ('tail_complete_answer','Кузов в хорошем состоянии. Аварий не было.',{'control':'continue'}),
    ('unasked_damage_coverage','Автомобиль не участвовал в ДТП, кузов целый.',{'current_covered':True}),
    ('linking_word_pause','Значит.',{'control':'fragment','next_question':False}),
    ('linking_phrase_pause','Так, получается...',{'control':'fragment','next_question':False}),
    ('explicit_plan_permission','Что ещё хотели бы узнать?',{'plan_permission':True,'next_question':True}),
    ('information_sufficiency','Я рассказал про оснащение. Этой информации вам достаточно?',{'acknowledgment_request':True,'other_questions':True,'next_question':False}),
    ('bring_documents_ack','Не забудьте взять паспорт и водительское удостоверение, хорошо?',{'acknowledgment_request':True,'other_questions':True,'next_question':False}),
    ('model_familiarity','Вы уже знакомы с этой моделью?',{'confirmation_request':False,'other_questions':True}),
    ('transfer_legal_status','Я соединю вас с отделом. Скажите, вы частное лицо или представляете организацию?',{'transfer_reply':True}),
    ('transfer_real_hold','Подождите, пожалуйста, соединяю вас с коллегой, хорошо?',{'transfer_reply':False,'control':'wait'}),
    ('location_controlled','Вы звоните в город Омск?',{'location_only':True}),
    ('buyer_prior_contact_addressed','Андрей, приятно познакомиться. Раньше с нашими менеджерами общались?',{'name':False,'other_questions':True}),
    ('buyer_first_contact_compound','Автомобиль стоит на нашей площадке. По этой машине впервые обратились в нашу компанию, Андрей.',{'reply_routed':True,'next_question':False}),
    ('confirm_distorted_model','Тайота карола интересует.',{'reply_routed':True,'next_question':False}),
    ('buyer_first_contact_without_question_mark','Это ваше первое обращение по этой машине.',{'other_questions':True,'next_question':False}),
    ('confirm_city_without_question_mark','В город Омск обращаетесь.',{'confirmation_request':True,'other_questions':True,'next_question':False}),
    ('confirm_model','Вас интересует Toyota Corolla?',{'confirmation_request':True,'other_questions':True,'next_question':False}),
    ('confirm_department','Вам нужен отдел продаж или сервис?',{'other_questions':True,'next_question':False}),
    ('listening_after_transfer','Я готова вас выслушать, расскажите.',{'listening_ready':True}),
    ('buyer_prior_contact','Уточните, пожалуйста, не общались ранее с менеджером по данному автомобилю?',{'subject':False,'other_questions':True}),
    ('buyer_condition','Вас интересует новый автомобиль или с пробегом?',{'other_questions':True}),
    ('buyer_transfer_name','Я сейчас соединю вас с отделом продаж, вас менеджер проконсультирует по новым автомобилям. Уточните, пожалуйста, как могу к вам обращаться?',{'name':True}),
    ('visit_time_after_ack','Отлично. Во сколько?',{'visit_request':'details','accept':False}),
    ('visit_contradiction','Почему? Вы же сказали, что мы будем в три часа с вами встречаться?',{'visit_request':'details','other_questions':False}),
    ('visit_background_and_preference','Пороги идеальные. Вы можете приехать на тест-драйв или осмотр и убедиться самостоятельно. Вам когда удобно подъехать?',{'visit_request':'details','other_questions':False}),
    ('wrongname_short','Михаил?',{'name':True,'name_confirmation':False}),
    ('wrongname_address','Хорошо, Николай, когда приедете?',{'name':True,'name_confirmation':False,'visit_request':'details'}),
    ('wrongname_seller','Меня зовут Михаил, я менеджер.',{'name':False}),
    ('preference_options','Ну вот вам когда удобнее, сегодня? Или завтра, возможно, выходные, тогда мы и назначим.',{'visit_request':'details','question_recall':None,'other_questions':False}),
    ('preference_inverse','Тогда удобнее в субботу или в будни?',{'visit_request':'details','question_recall':None,'other_questions':False}),
    ('preference_open','Так определились, когда вам удобнее подъехать?',{'visit_request':'details','question_recall':None,'other_questions':False}),
    ('legend_current_car','Напомните, на какой машине вы сейчас ездите?',{'legend_recall':'personal-car','question_recall':None}),
    ('recall_owner','Да Да, удобно, будем вас ожидать. Вы хотели что-то уточнить о последнем владельце?',{'question_recall':'plan:delivery','other_questions':False,'visit':'accept'}),
    ('recall_specific','Да, удобно, будем вас ожидать. Вы хотели что-то уточнить о доставке?',{'question_recall':'plan:delivery','other_questions':False,'visit':'accept'}),
    ('recall_generic','Извините, я вас перебил. Что вы хотели спросить?',{'question_recall':'plan:delivery','other_questions':False}),
    ('recall_paraphrase','Вернёмся к вашему вопросу про перевозку: что именно вас интересовало?',{'question_recall':'plan:delivery','other_questions':False}),
    ('recall_navigation','Какие у вас ещё вопросы?',{'question_recall':None,'next_question':True}),
    ('recall_buyer_question','Для чего вам нужна доставка?',{'question_recall':None,'other_questions':True}),
    ('identity_confirmation','Андрей, да? Пробег актуален и подтверждается отчётом.',{'name':False,'name_confirmation':True}),
    ('visit_repeat_time','Какое время?',{'visit_request':'details','accept':False}),
    ('visit_ask_preference','Ну когда вам удобно?',{'visit_request':'details','accept':False}),
    ('visit_check_availability','Завтра в три часа дня. Удобно?',{'visit_request':'details','accept':False}),
    ('visit_process_question','Вы приедете завтра в три часа дня в наш дилерский центр. Мы проведём пробную поездку. Как вам такая идея?',{'visit_request':'none','other_questions':True}),
    ('closing_address','Андрей',{'closing_acknowledged':False}),
    ('closing_ack','Хорошо, до встречи!',{'closing_intent':'acknowledgment'}),
    ('closing_short_ack','Okay',{'closing_intent':'acknowledgment'}),
    ('closing_question','Подождите, а как скоро планируете покупку?',{'closing_intent':'continuation','other_questions':True}),
    ('buyer_purchase_deadline','Вы в какой срок планируете покупку?',{'other_questions':True,'next_question':False}),
    ('buyer_invitation_and_deadline','Тогда это отличный повод посетить наш дилерский центр и познакомиться с ним. Вы в какой срок планируете покупку?',{'other_questions':True,'next_question':False}),
    ('buyer_decision','Как скоро собираетесь определиться с выбором?',{'other_questions':True,'next_question':False}),
    ('buyer_payment','Оформлять будете за наличные или в кредит?',{'other_questions':True,'next_question':False}),
    ('buyer_future_purchase','Покупка у вас намечена на ближайшее время или только присматриваетесь?',{'other_questions':True,'next_question':False}),
    ('name_new','Собеседника как величать?',{'name':True}),
    ('plan_navigation','А так что вас ещё интересует?',{'next_question':True,'other_questions':False}),
    ('plan_and_buyer','Что ещё хотите узнать? И из какого вы города?',{'next_question':True,'other_questions':True}),
    ('general_invitation','Можете приехать посмотреть.',{'visit':'offer','other_questions':False}),
    ('name_address','Да, объект продаётся. Подскажите, к кому могу обращаться?',{'name':True}),
    ('compound','По области доставляем, а по субботам и воскресеньям закрыты. Как вас записать по имени и для каких целей ищете товар?',{'name':True,'other_questions':True,'both_covered':True}),
    ('record_commitment','Считайте, место в расписании за вами уже закрепили.',{'accept':True}),
    ('commitment_and_question','Записываю вас. На какой номер прислать адрес?',{'accept':True,'other_questions':True}),
    ('conditional','Закрепим запись, когда подтвердится наличие машины.',{'accept':False}),
    ('changed','Вообще лучше перенесём на послезавтра, к пяти.',{'visit':'change','accept':False}),
    ('wait','На минуту отвлекусь к коллеге, оставайтесь на линии.',{'control':'wait'}),
    ('goodbye','Спасибо за разговор, всего вам самого доброго.',{'control':'goodbye'}),
    ('third_party','Кто из ваших сотрудников будет отвечать за подготовку машины?',{'name':False,'other_questions':True}),
    ('uncertain','В три или четыре ещё надо сверить по журналу.',{'accept':False}),
    ('reported','Предыдущий клиент говорил: тогда увидимся, но потом передумал. К вашей записи это не относится.',{'accept':False}),
    ('reported_goodbye','Предыдущий клиент сказал до свидания. А у меня ещё есть к вам вопросы.',{'control':'continue'}),
    ('topic_limit','Скидку обсудим в салоне.',{'control':'continue'}),
    ('ack_other','Да.',{'accept':False}),
]


async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--case',action='append');options=parser.parse_args()
    cases=CASES
    if options.case:
        if set(options.case)-{r[0] for r in CASES}:raise ValueError('Unknown case')
        cases=[r for r in CASES if r[0] in options.case]
    report={'id':'psmean-'+str(uuid4()),'model':MODEL,'phoneCalls':0,'scope':'synthetic state; real Decisions only','cases':[]}
    limit=asyncio.Semaphore(3)
    async def run(case):
        name,text,expected=case
        async with limit:
            prompt=('Машина не битая? [обязательная тема]' if name=='unasked_damage_coverage' else
                'Как долго последний владелец владел автомобилем? [обязательная тема]' if name=='recall_owner' else PROMPT)
            s=SimpleNamespace(prompt=prompt,context={},backchannel=False,finalized=False,
                evidence=Evidence(),playback=Playback(),dialogue_mode='semantic')
            s.evidence.memory=ConversationMemory(prompt);s.evidence.memory.semantic_mode=True
            s.evidence.turn=s.evidence.output_turn=2
            monitor=SimpleNamespace(turn=Turn(False,number=2),segment_start=None)
            c=SemanticController(s,None,monitor);s.controller=c
            c.texts={'opening':'Объект ещё доступен?'}
            c.started=True;c.current=c.s.evidence.memory.topics.required[0]['key']
            c.visit.update('Завтра в три часа дня.',1);c.visit.offered=c.visit.proposal();c.visit_offer_response_id='offer'
            c.last_question={'text':'Завтра в три подойдёт?','response_id':'offer','topic':None,'kind':'followup'}
            c.last_clip={'text':'Могу подъехать завтра в три часа дня. Подойдёт?','response_id':'offer'}
            if name.startswith('preference_') or name.startswith('legend_'):
                c.visit.offered=None;c.visit_offer_response_id=None
                c.question_ledger['visit-field:day']={'response_id':'visit-question','text':'Когда можно подъехать посмотреть машину?','turn':1,'state':'queued'}
                c.last_question={'text':'Когда можно подъехать посмотреть машину?','response_id':'visit-question','topic':'visit','kind':'plan'}
                c.last_clip={'text':'Когда можно подъехать посмотреть машину?','response_id':'visit-question'}
            if name.startswith('legend_'):
                c.customer_legend=[{'response_id':'personal-car','question':'На чём сейчас ездите?','text':'Сейчас езжу на Шкоде Октавии.'}]
            if name.startswith('recall_'):
                # Synthetic delivery history: an interrupted earlier plan question,
                # followed by an unrelated visit proposal. No phone audio is uploaded.
                topic=c.s.evidence.memory.topics.required[0]['key']
                c.texts[topic]='Как долго последний владелец владел автомобилем?' if name=='recall_owner' else 'Возможна ли доставка по области?'
                c.question_ledger['plan:'+topic]={'response_id':'interrupted-plan','text':c.texts[topic],'turn':1,'state':'queued'}
                c.asked[topic]=1
                c.s.evidence.delivery.response('interrupted-plan')['interrupted']=True
                expected={key:('plan:'+topic if value=='plan:delivery' else value) for key,value in expected.items()}
            if name=='ack_other':c.last_clip={'text':'Меня зовут Андрей.','response_id':'name'}
            if name=='name_address' or name.startswith('buyer_'):
                c.current='availability';c.visit.offered=None;c.visit_offer_response_id=None
                c.last_question={'text':'Объект продаётся?','response_id':'opening','topic':'availability','kind':'plan'}
                c.last_clip={'text':'Объект продаётся?','response_id':'opening'}
            if name.startswith('confirm_'):
                s.prepared_purpose='purchase'
                s.context={'subjectTitle':'Toyota Corolla','targetLocation':{'city':'Омск','name':'Тестовая точка'}}
                c.visit.offered=None;c.visit_offer_response_id=None
                c.texts['subject']='Меня интересует Toyota Corolla.'
                c.last_question={'text':'Машина в наличии?','response_id':'opening','topic':'availability','kind':'plan'}
                c.last_clip={'text':'Меня интересует Toyota Corolla. Машина в наличии?','response_id':'opening'}
            if name=='identity_confirmation':
                c.visit.offered=None;c.visit_offer_response_id=None
                c.last_question={'text':'Пробег актуальный?','response_id':'intro','topic':None,'kind':'plan'}
                c.last_clip={'text':'Меня зовут Андрей. Пробег актуальный?','response_id':'intro'}
            if name.startswith('closing_'):
                c.s.evidence.memory.phase='closing';c.visit.offered=None;c.visit_offer_response_id=None
                c.last_clip={'text':'Спасибо, тогда до встречи!','response_id':'farewell'}
            c.s.evidence.memory.user(text,2)
            try:
                result=await interpret(c,text)
                actual={**result,'closing_acknowledged':result.get('closing_intent')=='acknowledgment',
                    'current_covered':result['coverage'].get(c.current)=='answered',
                    'reply_routed':bool(result.get('other_questions') or result.get('contextual_reply')),
                    'both_covered':all(result['coverage'].get(r['key'])=='answered' for r in s.evidence.memory.topics.required),
                    'accept':result.get('visit_request')!='details' and result['visit']=='accept' and c.accept_active(text,2,result)}
                checks={key:actual.get(key)==value for key,value in expected.items()}
                return {'id':name,'text':text,'expected':expected,'meaning':result,'checks':checks,'passed':all(checks.values()),
                    'raw':next(e['answers'] for e in s.evidence.events if e['event']=='semantic_interpretation')}
            except Exception as exc:return {'id':name,'passed':False,'errorType':type(exc).__name__}
            finally:await c.close()
    report['cases']=await asyncio.gather(*(run(case) for case in cases))
    path=TraceArchive().root/(report['id']+'.json');path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
    print(json.dumps({'id':report['id'],'phoneCalls':0,'cases':[{k:c.get(k) for k in ('id','checks','passed','errorType')} for c in report['cases']]},ensure_ascii=False),flush=True)
    if not all(c['passed'] for c in report['cases']):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
