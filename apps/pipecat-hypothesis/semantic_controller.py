"""Semantic turn understanding with the same strict audio/question controller."""
import asyncio
import json
import os
import re
import time
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from uuid import uuid4
from copy import deepcopy

from pipecat.services.openai.realtime import events
from dialogue_controller import DialogueController,normalized
from controller_visit import VisitProposal,same_clock,affirmative,confirms_slot,clock_minutes
from turn_meaning import interpret,review_acceptance,MODEL
from speech_ledger import SpeechLedger,fingerprint
from customer_legend import choose_name
from line_gate import LineGate,greeting_only
from breath import BreathCue
from policy import is_introductory_greeting
from plan_context import plan_need,selected_subject,subject_scope,target_location,call_purpose

SEMANTIC_VERSION='semantic-25'


class SemanticController(DialogueController):
    def __init__(self,*args):
        super().__init__(*args)
        self.last_meaning=None;self.continuation_task=None;self.semantic_failures=0
        self.pending_answer_keys=[]
        self.closing_suspended=False
        self.closing_target=None
        self.closing_ack_sent=False
        self.s.evidence.memory.name=choose_name(self.s.prompt)
        self.customer_legend=[]
        self.speech=SpeechLedger(self.s.evidence.memory.name)
        self.line=LineGate(self)
        self.breath=BreathCue(self)
        self.name_repeat_requested=False;self.identity_confirmation_requested=False
        self.question_replay_inflight=set();self.auto_replayed_questions=set()
        self.last_receipt_at=-1000.
        self.native_opening_response=None
        self.s.evidence.memory.semantic_mode=True
        self.s.evidence.event('semantic_configuration',model=MODEL,version=SEMANTIC_VERSION)

    async def prepare(self):
        await super().prepare()
        # Default visit choices should not start a slow TTS request mid-call.
        # This caches preferences only; manager availability still needs consent.
        from dialogue_controller import voice_clip
        city=target_location(self.s).get('city')
        if city:
            self.texts['target_city']='Я обращаюсь в город '+city+'.'
            self.clips['target_city']=await voice_clip(self.s,self.texts['target_city'])
        now=datetime.now(ZoneInfo('Europe/Moscow'))
        choices=[('завтра','в 10:00')]
        future=now+timedelta(hours=1)
        if future.date()==now.date():choices.append(('сегодня',f'в {max(10,future.hour)}:00'))
        self.visit_clip_cache={}
        for day,clock in choices:
            text=f'Могу подъехать {day}, {clock}. Подойдёт?'
            self.visit_clip_cache[fingerprint(text)]=await voice_clip(self.s,text)
        self.s.evidence.event('semantic_visit_clips_ready',count=len(self.visit_clip_cache))

    async def _speak(self,key=None,text=None,kind='cached',mirror=True,closing=False,pcm=None,question_key=None,retry_of=None,identities=()):
        if key is None and pcm is None:pcm=getattr(self,'visit_clip_cache',{}).get(fingerprint(text or ''))
        return await super()._speak(key,text,kind,mirror,closing,pcm,question_key,retry_of,identities)

    def snapshot(self):
        return {**super().snapshot(),'understanding':SEMANTIC_VERSION,'last_meaning':self.last_meaning,
                'opening_pending':self.needs_opening(),
                'semantic_failures':self.semantic_failures,'speech_ledger':self.speech.queued,
                'line':self.line.snapshot(),
                'thinking_delay_ms':max(self.thinking.delay_ms,self.thinking.semantic_delay_ms),
                'thinking_pause_policy':{'cooldown_seconds':max(self.thinking.cooldown,60),
                    'max_per_call':2,'used_keys':sorted(self.thinking.used_keys)},
                'customer_legend':self.customer_legend}

    def needs_opening(self):
        # Starting a native answer is not the same as introducing the purpose
        # and asking availability. Preserve this obligation across interruption.
        return not self.opening_sent and self.opening_topic not in self.answers

    def ignores_opening_greeting(self,text,turn):
        if not turn.overlap or turn.interrupted:return False
        question=turn.question or {}
        identifier=question.get('response_id') if question.get('topic')==self.opening_topic else (
            self.native_opening_response if self.needs_opening() else None)
        return bool(identifier and not self.s.evidence.delivery.complete(identifier)
            and is_introductory_greeting(text,turn.duration_ms,self.s.evidence.memory.name))

    def question_history(self):
        rows=[];seen=set()
        for known in self.native_questions.known_questions():
            row=self.question_ledger.get(known['id'])
            if not row or row['response_id'] in seen:continue
            seen.add(row['response_id'])
            topic=known['id'].removeprefix('plan:') if known['id'].startswith('plan:') else None
            text=self.texts[topic] if topic in self.texts else row['text']
            if topic==self.opening_topic or not topic and not known['id'].startswith('visit-'):
                questions=re.findall(r'[^.!?]*\?',text)
                if questions:text=questions[-1].strip()
            delivery=self.s.evidence.delivery.response(row['response_id'])
            rows.append({'id':known['id'],'text':text,'response_id':row['response_id'],'topic':topic,
                'answered':known['answered'],'turn':row.get('turn',0),
                'interrupted':delivery['interrupted'],'phone_complete':self.s.evidence.delivery.complete(row['response_id'])})
        return rows

    def unfinished_question(self):
        return next((r for r in self.question_history() if r['topic'] and r['interrupted']
            and not r['answered']),None)

    async def replay_question(self,identity,keys=(),explicit=True):
        row=next((r for r in self.question_history() if r['id']==identity),None)
        if not row or identity in self.question_replay_inflight:return
        if not explicit and (row['answered'] or not row['interrupted'] or identity in self.auto_replayed_questions):return
        self.question_replay_inflight.add(identity)
        if not explicit:self.auto_replayed_questions.add(identity)
        identifier=None
        try:
            prefix=[k for k in keys if self.speech.available(self.texts[k]) or k=='name' and self.name_repeat_requested
                    or k=='identity_ack' and self.identity_confirmation_requested]
            clip_key=('opening_body' if row['topic']==self.opening_topic and row['interrupted'] else row['topic'])
            question=self.texts.get(clip_key,row['text']);shortened=False
            # After answering an interruption, resume the question without
            # restating a personal preamble the listener has just heard.
            # Shortening needs semantic approval: payment/other conditions
            # must never silently disappear from a question.
            original=next((r['question'] for r in self.s.evidence.memory.topics.required if r['key']==row['topic']),'')
            parts=re.findall(r'[^.!?]*\?',original)
            tail=parts[-1].strip() if parts else ''
            native=getattr(self,'native_resume_context',None)
            if (not explicit and tail and tail!=original.strip() and original.count('?')==1
                    and native and native['epoch']==self.epoch
                    and self.s.evidence.delivery.complete(native['response_id'])):
                try:
                    response=await self.http.post('https://api.proxyapi.ru/v1/decisions',
                        headers={'Authorization':'Bearer '+os.environ['PROXYAPI_API_KEY']},timeout=1.5,
                        json={'model':MODEL,'state':{'original_question':original,'question_only':tail,
                            'heard_buyer_answer':native['text'],'manager_question':self.latest_input},
                            'questions':{'shorten':{'type':'choice','instructions':
                                'Можно ли после услышанного ответа покупателя задать только question_only, не повторяя предисловие original_question? '
                                'Разрешай только если предисловие сообщает уже названные личные обстоятельства покупателя. '
                                'Не теряй условия скидки/оплаты, ограничения, числа или неизвестные сведения. При сомнении full.',
                                'criteria':{'full':'Нужно сохранить полный вопрос и условия.',
                                    'short':'Предисловие повторяет уже услышанные личные обстоятельства; короткий вопрос сохраняет смысл в данном контексте.'}}}})
                    response.raise_for_status();verdict=response.json()['answers']['shorten']
                    scores=verdict.get('probabilities',{})
                    if verdict.get('choice')=='short' and scores.get('short',0)>=.9 and scores.get('full',1)<.1:
                        question=tail;shortened=True
                except (OSError,ValueError,KeyError,TypeError):pass
                except Exception as exc:self.s.evidence.event('semantic_resume_check_failed',error_type=type(exc).__name__)
            text=' '.join([self.texts[k] for k in prefix]+[question])
            pcm=(b''.join(self.clips[k] for k in prefix)+self.clips[clip_key]) if not shortened and clip_key in self.clips else None
            identifier=await self.speak(text=text,pcm=pcm,retry_of=row['response_id'],
                repeat_reason='requested_question_repetition' if explicit else 'resume_interrupted_question')
            if not identifier:return
            for key,record in list(self.question_ledger.items()):
                if record['response_id']==row['response_id']:
                    self.question_ledger[key]={**record,'response_id':identifier,'retry_of':row['response_id'],
                        'turn':self.s.evidence.turn,'state':'queued'}
            self.last_question={'text':question,'response_id':identifier,'topic':row['topic'],
                'kind':'plan' if row['topic'] else 'followup','turn':self.s.evidence.turn}
            if not row['topic']:self.last_question['question_id']=identity
            if row['topic']:self.current=row['topic']
            if self.visit_offer_response_id==row['response_id']:self.visit_offer_response_id=identifier
            self.waiting=False
            self.s.evidence.event('semantic_question_replayed',question_id=identity,response_id=identifier,
                retry_of=row['response_id'],explicit_request=explicit,preamble_omitted=shortened)
        finally:
            self.question_replay_inflight.discard(identity)
            if not explicit and not identifier:self.auto_replayed_questions.discard(identity)

    def approve_speech_sentence(self,text,response_id):
        if not self.line.can_speak:
            self.s.evidence.event('line_speech_blocked',source='native',response_id=response_id)
            return ''
        value=fingerprint(text)
        if len(value.split())>=8 and value in fingerprint(self.latest_input):
            self.s.evidence.event('native_echo_blocked',response_id=response_id,text=text)
            return ''
        allowed=set()
        if self.name_repeat_requested:
            name=self.s.evidence.memory.name
            allowed={'identity:customer_name','text:'+fingerprint('Меня зовут '+name),'text:'+fingerprint('Я '+name)}
        if (self.last_meaning or {}).get('subject') and 'subject' in self.texts:
            for sentence in self.speech.sentences(self.texts['subject']):allowed.update(self.speech.keys(sentence))
        elif (self.last_meaning or {}).get('subject') and (plan_need(self.s) or selected_subject(self.s)):
            # An explicit request to repeat the subject also applies to a
            # generated answer grounded in the need, without a cached clip.
            allowed.update(self.speech.keys(text) & (self.speech.queued.keys() | self.speech.reserved.keys()))
        recalled=(self.last_meaning or {}).get('legend_recall')
        previous=next((row for row in self.customer_legend if row['response_id']==recalled),None)
        if previous:
            for sentence in self.speech.sentences(previous['text']):
                if 'identity:customer_name' not in self.speech.keys(sentence):allowed.update(self.speech.keys(sentence))
        spoken,blocked=self.speech.reserve(text,response_id,repeat_keys=allowed)
        if spoken and self.needs_opening() and self.native_opening_response is None:
            # Both the prefix and the answer pass through the same TTS stream.
            # A separate queued clip could be cancelled/overtaken by the reply.
            greeting=self.texts['greeting']
            if not re.match(r'^\s*(?:здравствуйте|добрый\s+(?:день|вечер)|доброе\s+утро|привет)\b',spoken,re.I):
                prefix,_=self.speech.reserve(greeting,response_id)
                if prefix:spoken=prefix+' '+spoken
            self.native_opening_response=response_id
            self.s.evidence.event('semantic_native_opening',response_id=response_id)
        self.speech.commit(response_id,response_id)
        if spoken and allowed and 'identity:customer_name' in self.speech.keys(text):
            self.s.evidence.event('speech_repeat_authorized',response_id=response_id,reason='requested_identity',source='native')
        for sentence in blocked:self.s.evidence.event('speech_repeat_blocked',text=sentence,response_id=response_id,source='native')
        return (' ' if text[:1].isspace() else '')+spoken if spoken else ''

    async def speak(self,key=None,text=None,kind='cached',mirror=True,closing=False,pcm=None,question_key=None,retry_of=None,repeat_reason=None):
        if not self.line.can_speak:
            self.s.evidence.event('line_speech_blocked',source='controller',kind=kind)
            return None
        if kind=='backchannel':return await super().speak(key,text,kind,mirror,closing,pcm,question_key,retry_of)
        original=self.texts[key] if key else text
        owner='speech-'+uuid4().hex
        spoken,blocked=self.speech.reserve(original,owner,repeat=bool(repeat_reason))
        for sentence in blocked:self.s.evidence.event('speech_repeat_blocked',text=sentence,source='prepared')
        if not spoken:
            self.waiting=True;self.thinking.cancel('duplicate_speech_blocked');await self.stop_backchannel()
            self.s.evidence.event('controller_wait',reason='duplicate_speech_blocked')
            target=(self.last_clip or {}).get('response_id')
            if closing and target and not self.s.evidence.delivery.response(target)['interrupted']:
                self.s.playback.finish_requested=True;self.s.finish_response_id=target
                if hasattr(self.serializer,'maybe_hangup'):await self.serializer.maybe_hangup()
            return None
        opening=key in ('opening','named_opening','opening_followup','opening_body')
        if blocked:
            # Removing an already spoken greeting must not erase the plan ID
            # or turn its remaining question into an untracked follow-up.
            if opening:question_key=self.opening_topic
            elif key in {r['key'] for r in self.s.evidence.memory.topics.required}:question_key=key
            key=None;text=spoken
            pcm=next((self.clips[clip_key] for clip_key,value in self.texts.items()
                if value.strip()==spoken.strip() and clip_key in self.clips),None)
        identifier=None
        try:
            if repeat_reason and retry_of:
                identifier=await super()._speak(key,text,kind,mirror,closing,pcm,question_key,retry_of)
            else:identifier=await super().speak(key,text,kind,mirror,closing,pcm,question_key,retry_of)
            if identifier:
                self.speech.commit(owner,identifier)
                if opening:self.opening_sent=True
            if identifier and repeat_reason:self.s.evidence.event('speech_repeat_authorized',response_id=identifier,reason=repeat_reason)
            return identifier
        finally:self.speech.release(owner)

    def context_text(self):
        # The voice model renders one answer. The question plan stays in the
        # controller so a request to continue cannot turn into a topic list.
        return 'CONTROLLER_STATE\n'+json.dumps({'CURRENT_TASK':self.fallback_goal,
            'requested_answers':self.requested_answers,'manager_utterance':self.latest_input,
            'confirmation_requested':bool((self.last_meaning or {}).get('confirmation_request')),
            'manager_questions':(self.last_meaning or {}).get('buyer_question_parts',[]),
            'SCENARIO_SCOPE':subject_scope(self.s),
            'target_location':target_location(self.s),
            'last_question':self.last_question,'last_assistant_reply':(self.last_clip or {}).get('text'),
            'active_visit':self.visit.offered,'facts':self.s.evidence.memory.facts,
            'confirmed_visit':self.confirmed_visit(),'visit_confirmed':self.visit_confirmed,
            'answered_plan_topics':self.answers,
            'recent_manager_quotes':self.s.evidence.memory.users[-5:],
            'controlled_fields':['visit_day','visit_time','visit_availability','received_information','company_address'],
            'buyer_information':{'customer_name':self.s.evidence.memory.name,
                'default_condition_preference':('новый автомобиль; предпочтение покупателя, не факт о товаре продавца' if call_purpose(self.s)=='purchase' else None),
                'chosen_personal_statements':self.customer_legend,
                'provided_need':plan_need(self.s),'selected_subject':selected_subject(self.s)},
            'question_policy':getattr(self,'native_question_policy','answer_only')},ensure_ascii=False)

    def cancel_continuation(self):
        if self.continuation_task and self.continuation_task is not asyncio.current_task():self.continuation_task.cancel()
        self.continuation_task=None

    async def new_input(self):
        self.breath.cancel_pending()  # Manager speech never stops an already playing breath.
        self.cancel_continuation()
        self.name_repeat_requested=False;self.identity_confirmation_requested=False
        if self.s.evidence.memory.phase=='closing':
            self.closing_target=getattr(self.s,'finish_response_id',None)
            # STT/meaning must decide whether this is an acknowledgment or a
            # new question before a simultaneous playback ACK can hang up.
            self.s.playback.finish_requested=False
        await super().new_input()
        self.waiting=False

    def on_turn_committed(self,turn):
        self.breath.arm(turn)
        if self.line.can_speak and self.started and not (turn.overlap and not turn.interrupted) and not self.s.playback.finish_requested:
            self.thinking.arm('turn_wait')

    async def on_ignored_input(self,turn):
        # Short non-interrupting acknowledgments/noise never enter handle().
        # Release the temporary hangup hold only after proving that this is
        # still the latest input and no other utterance awaits interpretation.
        if (self.s.evidence.memory.phase!='closing' or turn.interrupted
                or turn.number!=self.monitor.turn.number or getattr(self.llm,'user_speaking',False)
                or self.inputs.fragments or getattr(self.llm,'stt_tasks',{})):return
        target=self.closing_target or getattr(self.s,'finish_response_id',None)
        if target and not self.s.evidence.delivery.response(target)['interrupted']:
            self.s.playback.finish_requested=True;self.s.finish_response_id=target
            self.s.evidence.event('semantic_closing_ignored_input',response_id=target)
            if hasattr(self.serializer,'maybe_hangup'):await self.serializer.maybe_hangup()

    async def on_stt_recovery(self,turn):
        await self.new_input()
        self.thinking.cancel('transcription_recovery');self.waiting=True
        if self.s.playback.busy:await self.clear_audio()
        if not self.line.can_speak:return
        if getattr(self.llm,'user_speaking',False) or self.monitor.segment_start is not None:
            self.s.evidence.event('controller_stt_recovery_notice_deferred',source_turn=turn.number)
            return
        # A recovery notice is not an answer to the buffered utterances and
        # must neither consume them nor replace the active question/proposal.
        await self.speak('stt_repair',kind='recovery',mirror=False,repeat_reason='transcription_recovery')
        self.s.evidence.event('controller_stt_recovery_notice',source_turn=turn.number,
            retained_turns=[r['turn'] for r in self.inputs.snapshot()])

    def abort(self):
        self.breath.cancel_pending()
        self.line.state='ended';self.line.cancel();self.cancel_continuation();super().abort()

    async def close(self):
        await self.breath.stop('session_closed')
        self.line.state='ended'
        self.line.cancel()
        task=self.continuation_task;self.cancel_continuation()
        if task:await asyncio.gather(task,return_exceptions=True)
        await super().close()

    def candidate(self,text,turn):
        # Format parsing only; whether this is an offer/change/acceptance is
        # decided by the semantic result, not by these date/time expressions.
        v=VisitProposal();v.day=deepcopy(self.visit.day);v.time=deepcopy(self.visit.time)
        v.update(text,turn)
        # A rejection of the old slot may precede a positive replacement.
        # Parse complete later clauses independently; do not let the earlier
        # negation erase a replacement or combine its day with an old clock.
        clauses=re.split(r'(?<=[.!?;])\s+|\b(?:но|давайте|лучше)\b',text,flags=re.I)
        if len(clauses)>1:
            for clause in clauses:
                if re.search(r'\bсейчас\b|\bесли\b',clause,re.I):continue
                replacement=VisitProposal();replacement.update(clause,turn)
                if replacement.day:v=replacement
                elif replacement.time and v.day:v.time=replacement.time
        return v

    def confirmed_visit(self):
        facts=self.s.evidence.memory.facts
        return {key:deepcopy(facts['visit_'+key]) for key in ('day','time')} if self.visit_confirmed and all('visit_'+key in facts for key in ('day','time')) else None

    def choose_visit_preference(self,candidate,turn):
        now=datetime.now(ZoneInfo('Europe/Moscow'))
        if not candidate.day:candidate.day={'value':'завтра','source':'client_preference','turn':turn}
        if not candidate.time:
            # The default is a preference, never a booking. Avoid proposing
            # a clock that already passed today; choose the next full hour.
            hour=10
            if normalized(candidate.day['value'])=='сегодня':
                future=now+timedelta(hours=1)
                if future.date()!=now.date():candidate.day={'value':'завтра','source':'client_preference','turn':turn}
                else:hour=max(hour,future.hour)
            candidate.time={'value':f'в {hour}:00','source':'client_preference','turn':turn}
        return candidate

    def future_visit(self):
        """Validate inherited clocks too, including the start of opening hours."""
        if not self.visit.day or not self.visit.time:return True
        now=datetime.now(ZoneInfo('Europe/Moscow'))
        today=normalized(self.visit.day['value']) in ('сегодня','в '+('понедельник','вторник','среду','четверг','пятницу','субботу','воскресенье')[now.weekday()])
        minute=clock_minutes(self.visit.time['value'])
        if not today or minute is None or minute>now.hour*60+now.minute:return True
        old=dict(self.visit.time)
        future=(now+timedelta(hours=1)).replace(minute=0,second=0,microsecond=0)
        end=old.get('interval_end')
        if future.date()!=now.date() or end is not None and future.hour*60>=end:
            self.visit.time=None;self.visit.offered=None
            self.s.evidence.event('semantic_past_visit_rejected',previous=old,local_now=now.isoformat())
            return False
        self.visit.time={'value':f'в {future.hour}:00','source':'future_client_preference','turn':self.s.evidence.turn}
        self.visit.offered=None
        self.s.evidence.event('semantic_past_visit_adjusted',previous=old,proposal=self.visit.proposal(),local_now=now.isoformat())
        return True

    @staticmethod
    def changed_slot(candidate,offer,turn):
        if not offer:return False
        for key,value in (('day',candidate.day),('time',candidate.time)):
            if not value or value.get('turn')!=turn:continue
            if key=='time':
                if not same_clock(offer[key]['value'],value['value'],value['value']):return True
            elif normalized(value['value'])!=normalized(offer[key]['value']):return True
        return False

    def accept_active(self,text,turn,meaning):
        self.acceptance_block_reason=None
        def reject(reason):self.acceptance_block_reason=reason;return False
        offer=self.visit.offered
        if not offer or not self.visit_offer_response_id:return reject('missing_proposal')
        scope=meaning['acceptance_scope']
        reference=getattr(self,'input_reference',None) or self.last_question or {}
        if scope=='direct_reply' and (reference.get('response_id')!=self.visit_offer_response_id
                or (self.last_clip or {}).get('response_id')!=self.visit_offer_response_id):return reject('unrelated_direct_reply')
        if scope not in ('direct_reply','explicit_visit'):return reject('uncertain_scope')
        candidate=self.candidate(text,turn)
        # Explicitly changed literal slots override a mistaken acceptance label.
        if candidate.day and candidate.day.get('turn')==turn and normalized(candidate.day['value'])!=normalized(offer['day']['value']):return reject('changed_day')
        when=candidate.time
        if when and when.get('turn')==turn and when.get('source')=='manager_quote':
            if not same_clock(offer['time']['value'],when['value'],text):return reject('changed_time')
        self.s.evidence.memory.facts.update({'visit_'+key:{**deepcopy(value),
            'source':'semantic_active_proposal_confirmed_by_manager','confirmation_evidence':text,
            'confirmation_turn':turn,'proposal_response_id':self.visit_offer_response_id} for key,value in offer.items()})
        self.visit.offered=None;self.awaiting_confirmation=None;self.visit_confirmed=True
        self.visit_deferred=False;self.s.evidence.memory.visit_pending=False
        self.s.evidence.event('semantic_visit_confirmed',proposal_response_id=self.visit_offer_response_id,
            evidence=text,acceptance_scope=scope)
        return True

    def direct_slot_acceptance(self,text,turn):
        reference=getattr(self,'input_reference',None) or self.last_question or {}
        offer=self.visit.offered
        if (not offer or reference.get('response_id')!=self.visit_offer_response_id
                or (self.last_clip or {}).get('response_id')!=self.visit_offer_response_id):return False
        # An opening 'Отлично' followed by 'Во сколько?' is not slot acceptance.
        first=re.split(r'(?<=[.!?])\s+',text.strip(),maxsplit=1)[0]
        if not confirms_slot(offer,text if '?' in text else first):return False
        if re.search(r'\b(?:если|но|только|вместо|отмен\w*|позже|раньше|перен[её]с\w*|перенос\w*)\b',text,re.I):return False
        if self.changed_slot(self.candidate(text,turn),offer,turn):return False
        return self.accept_active(text,turn,{'acceptance_scope':'direct_reply'})

    async def handle(self,text,turn,epoch):
        if self.unavailable() or epoch!=self.epoch:return
        batch=self.active_batch or []
        current=batch[-1]['text'] if batch and batch[-1]['turn']==turn else text
        was_live=self.line.can_speak
        if not was_live and batch:
            for part in batch[:-1]:
                if part['text'] not in self.line.history:self.line.history.append(part['text'])
            self.line.history=self.line.history[-8:]
        route=await self.line.route(current,turn,epoch)
        resumed=self.line.resumed
        if route=='blocked':
            ignored={part['turn'] for part in batch} or {turn}
            self.s.evidence.memory.users=[r for r in self.s.evidence.memory.users if r['turn'] not in ignored]
            return
        if resumed:
            # The new recipient has not heard retries addressed to the old one.
            self.auto_replayed_questions.clear()
            self.s.evidence.event('line_transfer_replay_budget_reset',source_turn=turn)
        if not was_live and route=='human':
            # Cancelled STT batches may still contain a previous menu. Only
            # the newly verified employee utterance enters business meaning.
            text=current
            self.s.evidence.memory.users=[r for r in self.s.evidence.memory.users if r['turn']!=turn]
            self.s.evidence.memory.user(text,turn)
        self.latest_input=text;self.waiting=False
        m=self.s.evidence.memory
        # Save an unambiguous reply to our exact proposal before another ASR
        # fragment cancels the pending interpretation task.
        accepted_directly=self.direct_slot_acceptance(text,turn)
        if not resumed and greeting_only(text) and self.needs_opening():
            self.started=True;self.current=self.opening_topic
            self.s.evidence.event('semantic_opening_fast_path',source_turn=turn)
            await self.speak('opening');return
        if self.started:self.thinking.arm('semantic_interpretation')
        try:meaning=await interpret(self,text)
        except (OSError,ValueError,KeyError,TypeError) as exc:
            await self.failed_interpretation(exc,epoch);return
        except Exception as exc:
            # A timeout/provider failure must not fall back to the old keyword
            # interpreter or silently accept a booking.
            await self.failed_interpretation(exc,epoch);return
        if epoch!=self.epoch or self.unavailable():
            self.s.evidence.event('semantic_stale_discarded',source_turn=turn);return
        if meaning.get('transfer_reply'):
            # A transfer may depend on an answer other than the caller's name.
            # Resume output for that answer, then wait after telephone playback.
            if not self.line.can_speak:
                self.line.state='live';self.line.cancel()
                await self.serializer.send({'customEvent':'control','action':'set_output_enabled','enabled':True})
            meaning['control']='continue';meaning['other_questions']=True
            self.s.evidence.event('semantic_transfer_reply_required',source_turn=turn)
        elif route=='human_hold':meaning['control']='wait'
        elif meaning['name'] and meaning['control']=='wait' and self.line.can_speak:
            # A transfer announced in the same sentence must wait for our name.
            meaning['control']='continue'
            self.s.evidence.event('semantic_transfer_identity_answer',source_turn=turn)
        reference=getattr(self,'input_reference',None) or self.last_question or {}
        if (meaning['control']=='fragment' and affirmative(text)
                and reference.get('topic') and meaning['coverage'].get(reference['topic'])=='answered'):
            # A complete confirmation already tied to the active question is
            # an answer, even if the independent control label calls it a fragment.
            meaning['control']='continue'
            self.s.evidence.event('semantic_complete_confirmation',topic=reference['topic'],evidence=text)
        self.last_meaning=meaning;self.semantic_failures=0
        substantive=bool(meaning.get('question_recall') or meaning['name'] or meaning.get('name_confirmation') or meaning.get('visit_request')=='details'
            or meaning['subject'] or meaning['other_questions'] or meaning['next_question']
            or meaning['visit'] in ('offer','change','cancel','conditional','accept')
            or any(v in ('answered','unknown') for v in meaning['coverage'].values()))
        if (m.phase=='closing' or self.closing_suspended) and not substantive and meaning['control'] not in ('callback','decline','audio_repair'):
            # An acknowledgment/address is not a new task. Preserve an intact
            # farewell; if barge-in already cleared it, listen for continuation
            # instead of re-entering advance -> the same farewell forever.
            self.thinking.cancel('closing_followup');await self.stop_backchannel()
            if self.closing_suspended and (meaning['control']=='goodbye' or meaning.get('closing_intent')=='acknowledgment'):
                completed=(self.last_clip or {}).get('response_id')
                if completed and not self.s.evidence.delivery.response(completed)['interrupted']:
                    self.s.playback.finish_requested=True;self.s.finish_response_id=completed
                    m.phase='closing';m.closing_reason='manager_goodbye'
                    self.s.evidence.event('semantic_close_after_manager_goodbye',response_id=completed)
                    if hasattr(self.serializer,'maybe_hangup'):await self.serializer.maybe_hangup()
                    return
                if not self.closing_ack_sent:
                    self.closing_ack_sent=True
                    await self.perform('close_goodbye',text,epoch)
                    return
            target=self.closing_target or getattr(self.s,'finish_response_id',None)
            if (m.phase=='closing' and target and not self.s.evidence.delivery.response(target)['interrupted']
                    and (meaning.get('closing_intent')=='acknowledgment' or meaning['control']=='goodbye')
                    and meaning['control'] not in ('wait','fragment')):
                self.s.playback.finish_requested=True;self.s.finish_response_id=target
                self.s.evidence.event('semantic_closing_preserved',control=meaning['control'])
                self.s.evidence.event('controller_wait',reason='closing_playback_preserved')
                if hasattr(self.serializer,'maybe_hangup'):await self.serializer.maybe_hangup()
                return
            first=not self.closing_suspended
            self.closing_suspended=True;m.phase='dialogue';m.closing_reason=None
            self.s.playback.finish_requested=False;self.s.finish_response_id=None
            self.waiting=True
            self.s.evidence.event('semantic_closing_wait',control=meaning['control'])
            self.s.evidence.event('controller_wait',reason='closing_waits_for_manager_continuation')
            if meaning['control']=='goodbye' and first:
                await self.perform('close_goodbye',text,epoch)
                return
            if first and meaning['control'] not in ('wait','fragment'):
                if self.s.playback.busy:await self.clear_audio()
                await self.speak('resume')
            return
        if substantive:self.closing_suspended=False;self.closing_target=None;self.closing_ack_sent=False
        if m.phase=='closing':
            if self.s.playback.busy:await self.clear_audio()
            self.s.playback.finish_requested=False;self.s.finish_response_id=None
            m.phase='dialogue';m.closing_reason=None;self.closing_cancelled=True
            self.s.evidence.event('controller_closing_resumed',turn=turn)
        supplied=False
        for key,status in meaning['coverage'].items():
            if status not in ('answered','unknown'):continue
            new_information=key not in self.answers or key==self.current
            self.answers[key]={'evidence':text,'turn':turn,'status':status,'scope':'semantic turn coverage'}
            supplied=supplied or new_information
            self.s.evidence.event('controller_answer_saved',topic=key,evidence=text,status=status,source=SEMANTIC_VERSION)
        m.topics.name_requested=meaning['name']
        response_seen=any(self.asked.get(key) for key in meaning.get('response_seen',[]))
        for key in meaning.get('response_seen',[]):
            if self.asked.get(key) and meaning['coverage'].get(key)=='unanswered':
                self.s.evidence.event('semantic_response_unverified',topic=key,evidence=text,
                    scope='navigation only; answer coverage not approved')
        if meaning['name'] or meaning.get('name_confirmation'):
            introduced='identity:customer_name' in self.speech.queued or 'identity:customer_name' in self.speech.reserved
            # Asking for the value again is itself permission to repeat it.
            # Only an explicit check of the already supplied value gets an ACK.
            key='identity_ack' if meaning.get('name_confirmation') else 'name'
            if key not in self.pending_answer_keys:self.pending_answer_keys.append(key)
        self.name_repeat_requested=bool(meaning.get('name_repeat') or meaning['name'] and
            ('identity:customer_name' in self.speech.queued or 'identity:customer_name' in self.speech.reserved))
        self.identity_confirmation_requested=meaning.get('name_confirmation',False)
        if meaning['subject'] and not meaning['next_question'] and 'subject' in self.texts and 'subject' not in self.pending_answer_keys:self.pending_answer_keys.append('subject')
        if meaning['subject'] and 'subject' not in self.texts:
            # A subject question is still a real question when the imported
            # row is empty. Answer it from the need before advancing the plan.
            meaning['other_questions']=True
            self.s.evidence.event('semantic_subject_from_context',source='selection' if selected_subject(self.s) else 'need' if plan_need(self.s) else 'unspecified')
        self.requested_answers={key:self.texts[key] for key in self.pending_answer_keys}
        relation='none' if accepted_directly else meaning['visit'];action='advance' if accepted_directly else None
        previous_visit=self.visit.offered or self.confirmed_visit()
        if relation in ('accept','unclear','offer','change') and previous_visit:
            if self.changed_slot(self.candidate(text,turn),previous_visit,turn):
                relation='change'
                self.s.evidence.event('semantic_visit_literal_change',evidence=text,
                    reason='explicit slot differs from active proposal; not acceptance')
        if self.visit_confirmed and meaning.get('visit_request')=='details' and not self.changed_slot(self.candidate(text,turn),previous_visit,turn):
            relation='none'
        if self.visit_confirmed and relation not in ('change','cancel'):
            # Confirmation is durable. Unrelated answers and repeated
            # invitations cannot reopen a booking that was already agreed.
            relation='none'
        if relation=='change' and meaning.get('visit_request')=='details':
            self.visit=self.candidate(text,turn);self.visit.offered=None
            self.visit_confirmed=False;m.facts.pop('visit_day',None);m.facts.pop('visit_time',None)
            m.visit_pending=True
        if meaning.get('visit_request')=='details':action='answer_visit'
        elif relation=='accept':
            if self.accept_active(text,turn,meaning):action='advance'
            else:
                relation='unclear'
                action=('resolve_acceptance' if self.acceptance_block_reason=='uncertain_scope' else
                        'acceptance_unresolved' if self.visit.offered else 'propose')
                self.s.evidence.event('semantic_visit_acceptance_blocked',reason=self.acceptance_block_reason)
        elif relation in ('offer','change'):
            v=self.candidate(text,turn)
            fresh=any(value and value.get('turn')==turn for value in (v.day,v.time))
            if relation=='change':
                self.visit_confirmed=False;m.facts.pop('visit_day',None);m.facts.pop('visit_time',None)
                # A changed day does not imply yesterday's time still works.
                if v.day and v.day.get('turn')==turn and (not v.time or v.time.get('turn')!=turn):v.time=None
            if relation=='offer' and self.visit.offered and not self.changed_slot(v,self.visit.offered,turn):
                # Repeating our own day/hour is not a new proposal, even if
                # ASR writes the clock differently (10:00 / десять часов).
                action='resolve_acceptance'
            elif fresh:
                self.visit=v;m.visit_pending=True;action='propose'
            else:
                if relation=='offer' and self.visit.offered:
                    # An invitation without a new slot may be acceptance of
                    # our existing proposal. Verify it instead of restating it.
                    action='resolve_acceptance'
                elif relation=='offer' and self.unasked() and not self.visit.offered:
                    action='advance'
                    self.s.evidence.event('semantic_visit_invitation_deferred',reason='questions_before_unscheduled_visit')
                else:action='propose'
        elif relation=='cancel':
            self.visit=VisitProposal();self.visit_confirmed=False;self.awaiting_confirmation=None
            m.facts.pop('visit_day',None);m.facts.pop('visit_time',None);m.visit_pending=False
            self.s.evidence.event('semantic_visit_cancelled',evidence=text)
        elif relation in ('conditional','unclear') and meaning['control'] not in ('wait','fragment'):
            # Never convert a conditional answer into confirmed facts.
            if relation=='conditional' and self.unasked() and not self.visit.offered and not self.visit.day:
                action='advance'
                self.s.evidence.event('semantic_visit_invitation_deferred',reason='unscheduled_condition_before_plan')
            elif relation=='unclear' and self.visit.offered:action='resolve_acceptance'
            elif relation=='conditional' or self.current=='visit':action='clarify_visit'
        control=meaning['control']
        recall=meaning.get('question_recall')
        if recall and control not in ('wait','fragment','callback','decline'):action='recall:'+recall
        self.s.evidence.event('semantic_transition',control=control,visit=relation,action=action,
            covered_topics=[k for k,v in meaning['coverage'].items() if v!='unanswered'],
            requested_answers=list(self.requested_answers),unasked_required=self.unasked())
        if control in ('wait','fragment'):
            if control=='wait' and self.line.can_speak:
                # Semantic hold is authoritative too, including imperfect ASR
                # that did not match the conservative local transfer grammar.
                self.line.history=[current];self.line.state='waiting_operator';self.line.arm_wait()
                await self.line.silence('semantic_requested_hold')
            self.waiting=True;self.thinking.cancel('semantic_'+control);await self.stop_backchannel()
            self.s.evidence.event('controller_wait',reason='semantic_'+control);return
        if control=='attention' and self.started:
            if not self.needs_opening() and not self.unfinished_question() and not (recall or meaning['name'] or meaning.get('name_confirmation') or supplied or response_seen or meaning['next_question'] or meaning['other_questions']):
                await self.speak('resume',repeat_reason='requested_connection_check');return
            if supplied or response_seen:self.pending_answer_keys.insert(0,'receipt_0')
        if control=='audio_repair' and not recall:
            if self.needs_opening():
                self.current=self.opening_topic;self.started=True
                await self.speak('named_opening' if meaning['name'] else 'opening');return
            if self.pending_answer_keys:
                keys=self.pending_answer_keys;self.pending_answer_keys=[]
                await self.speak(text=' '.join(self.texts[k] for k in keys),pcm=b''.join(self.clips[k] for k in keys),
                    repeat_reason='requested_field_repetition')
                return
            clip=self.last_clip
            if clip:
                await self.speak(text=clip['text'],pcm=clip.get('pcm'),retry_of=clip['response_id'],repeat_reason='requested_repetition')
            else:await self.speak('connection_repair')
            return
        if control in ('callback','decline') or control=='goodbye' and not recall:action='close_'+control
        unfinished=self.unfinished_question()
        if (unfinished and unfinished['topic']==self.opening_topic and meaning['name']
                and self.opening_sent and control=='continue'
                and not (meaning['subject'] or meaning['other_questions'] or meaning['next_question'] or recall)):
            # Answer identity without automatically repeating the whole intro
            # to the same operator. The pending question keeps its identity.
            keys=self.pending_answer_keys;self.pending_answer_keys=[]
            await self.prepared(keys)
            return
        if (unfinished and meaning.get('listening_ready') and control=='continue'
                and not (action or recall or supplied or response_seen or meaning['other_questions'])):
            # An explicit invitation authorizes restoring the interrupted need,
            # even when the automatic retry budget has already been consumed.
            keys=self.pending_answer_keys;self.pending_answer_keys=[]
            await self.replay_question(unfinished['id'],keys)
            self.s.evidence.event('controller_question_resumed_on_invitation',question_id=unfinished['id'])
            return
        if (unfinished and control=='attention' and unfinished['id'] in self.auto_replayed_questions
                and not (action or recall or supplied or response_seen or self.pending_answer_keys or meaning['other_questions'])):
            await self.speak('resume',repeat_reason='explicit_connection_check')
            return
        if not action and self.unfinished_question() and (self.pending_answer_keys or control=='attention' or meaning['other_questions']):
            # Answer the interruption, then restore the existing question ID.
            # A queued/cancelled opening must not turn into permanent silence.
            action='advance'
        if meaning.get('transfer_reply'):
            await self.native_answer(text,'wait_transfer',epoch)
            return
        if meaning.get('location_only') and 'target_city' in self.texts:
            self.pending_answer_keys=[];self.requested_answers={}
            await self.speak('target_city',repeat_reason='requested_target_location')
            return
        if meaning['other_questions']:
            if action=='clarify_visit':
                # One answer plus at most one clarification in the same
                # generation, instead of another request after phone playback.
                await self.native_answer(text,None,epoch,clarify=True)
                return
            await self.native_answer(text,action or ('advance' if supplied or response_seen or meaning['next_question']
                or self.visit_confirmed and not self.unasked() else 'open' if self.needs_opening() else None),epoch)
            return
        if action and action.startswith('close_'):
            await self.perform(action,text,epoch);return
        if (resumed and not supplied and not response_seen and not meaning['name'] and not meaning.get('name_confirmation')
                and not meaning['subject'] and not meaning['other_questions'] and not meaning['next_question'] and not action):
            previous=self.last_question or {}
            row=next((r for r in self.question_history() if r['response_id']==previous.get('response_id') and not r['answered']),None)
            if row:
                await self.replay_question(row['id'])
                self.s.evidence.event('line_transfer_question_resumed',question_id=row['id'])
            else:await self.speak('resume',repeat_reason='line_transfer_resumed')
            return
        self.started=True
        if self.needs_opening() and not action:
            self.current=self.opening_topic
            self.pending_answer_keys=[]
            await self.speak('named_opening' if meaning['name'] else 'opening');return
        if (meaning.get('contextual_reply') and not action and not self.pending_answer_keys
                and not affirmative(text)):
            self.s.evidence.event('semantic_contextual_reply',source_turn=turn,
                reason='unclassified_continuation',advance_after_answer=bool(supplied or response_seen))
            await self.native_answer(text,'advance' if supplied or response_seen else None,epoch)
            return
        if not action and (supplied or response_seen or meaning['next_question'] or self.visit_confirmed and not self.unasked()):action='advance'
        reference=getattr(self,'input_reference',None) or self.last_question or {}
        if (not action and not self.pending_answer_keys and control=='continue'
                and not any(v in ('answered','unknown') for v in meaning['coverage'].values())
                and reference.get('kind')=='plan' and self.asked.get(reference.get('topic'))):
            action='advance'
            self.s.evidence.event('semantic_unresolved_answer_advanced',topic=reference.get('topic'),evidence=text,
                scope='question already asked; no answer invented')
        await self.perform(action,text,epoch)

    async def failed_interpretation(self,exc,epoch):
        if epoch!=self.epoch or self.unavailable():return
        self.semantic_failures+=1
        self.s.evidence.event('semantic_interpretation_failed',error_type=type(exc).__name__,attempt=self.semantic_failures,
            http_status=getattr(getattr(exc,'response',None),'status_code',None))
        if self.semantic_failures==1:await self.speak('repeat')
        else:
            self.waiting=True;self.thinking.cancel('semantic_unavailable');await self.stop_backchannel()
            self.s.evidence.event('controller_wait',reason='semantic_unavailable')

    async def perform(self,action,text,epoch):
        if epoch!=self.epoch or self.unavailable():return
        self.s.evidence.event('semantic_action',action=action,requested_answers=list(self.pending_answer_keys),
            visit_confirmed=self.visit_confirmed,unasked_required=self.unasked())
        keys=self.pending_answer_keys;self.pending_answer_keys=[]
        m=self.s.evidence.memory
        if action=='wait_transfer':
            self.line.history=[text];self.line.state='waiting_operator';self.line.arm_wait()
            await self.line.silence('transfer_prerequisite_answered')
            return
        if action=='open':
            if self.needs_opening():
                self.current=self.opening_topic
                native=getattr(self,'native_resume_context',None)
                completed=(native and native['response_id']==self.native_opening_response
                    and self.s.evidence.delivery.complete(native['response_id']))
                subject=subject_scope(self.s).get('subject')
                introduced=(completed and (self.last_meaning or {}).get('subject')
                    or completed and subject and fingerprint(subject) in fingerprint(native['text']))
                await self.speak(('opening_followup' if introduced else 'opening_body') if completed else 'opening')
            return
        if action and action.startswith('recall:'):
            await self.replay_question(action.removeprefix('recall:'),keys)
            return
        if action=='answer_visit':
            candidate=self.candidate(text,self.s.evidence.turn)
            base=self.visit.offered or self.visit.proposal()
            changed=(self.changed_slot(candidate,base,self.s.evidence.turn) if base else
                any(value and value.get('turn')==self.s.evidence.turn for value in (candidate.day,candidate.time)))
            if changed:
                self.visit=candidate
                self.visit_confirmed=False;m.facts.pop('visit_day',None);m.facts.pop('visit_time',None)
                m.visit_pending=True
                if candidate.proposal():
                    await self.propose(keys)
                    return
            if not self.visit.offered and not self.visit_confirmed and self.visit.proposal():
                await self.propose(keys)
                return
            offer=self.visit.offered or ({'day':m.facts['visit_day'],'time':m.facts['visit_time']}
                if all(k in m.facts for k in ('visit_day','visit_time')) else self.visit.proposal())
            if not offer:
                candidate=self.candidate(text,self.s.evidence.turn)
                # A customer may choose a preference; this is not a manager's
                # availability or a confirmed appointment. Confirmation remains
                # bound to the outgoing proposal and its response ID.
                candidate=self.choose_visit_preference(candidate,self.s.evidence.turn)
                self.visit=candidate;m.visit_pending=True
                await self.propose(keys)
                return
            if offer:
                prefix=' '.join(self.texts[key] for key in keys if self.speech.available(self.texts[key]))
                sentence=(prefix+' ' if prefix else '')+f"Мне удобно {offer['day']['value'].lower()}, {offer['time']['value'].lower()}."
                identifier=await self.speak(text=sentence,repeat_reason='requested_visit_details')
                if identifier and self.visit.offered:
                    self.visit_offer_response_id=identifier
                    self.last_question={'response_id':identifier,'text':sentence,'kind':'visit_details','topic':None,'turn':self.s.evidence.turn}
                self.waiting=True
                return
            action='propose'
        if action=='acceptance_unresolved':
            await self.prepared(keys+['visit_ack' if self.visit_confirmed else 'receipt_0' if self.visit.offered else 'visit_pending']);self.waiting=True
            return
        if action=='resolve_acceptance':
            if self.visit_confirmed:
                await self.prepared(keys+['visit_ack']);self.waiting=True
                return
            accepted=False
            try:accepted=await review_acceptance(self,text)
            except Exception as exc:
                self.s.evidence.event('semantic_confirmation_review_failed',error_type=type(exc).__name__)
            if epoch!=self.epoch or self.unavailable():return
            if accepted:
                reference=getattr(self,'input_reference',None) or self.last_question or {}
                direct=bool(self.visit_offer_response_id and reference.get('response_id')==self.visit_offer_response_id
                    and (self.last_clip or {}).get('response_id')==self.visit_offer_response_id)
                accepted=self.accept_active(text,self.s.evidence.turn,{'acceptance_scope':'direct_reply' if direct else 'explicit_visit'})
            if accepted:
                self.pending_answer_keys=keys
                await self.perform('advance',text,epoch)
            else:
                await self.prepared(keys+['receipt_0' if self.visit.offered else 'visit_pending'])
                self.waiting=True
                self.s.evidence.event('controller_wait',reason='semantic_acceptance_unresolved')
            return
        if action and action.startswith('close_'):
            reason={'close_goodbye':'manager_goodbye','close_callback':'callback_requested','close_decline':'declined'}[action]
            # Critical semantic control score and the current manager quote were
            # validated before this transition. Transport still waits for ACK.
            m.phase='closing';m.closing_reason=reason
            await self.prepared(keys+['callback_farewell' if action=='close_callback' else 'goodbye'],closing=True);return
        if action=='propose':
            await self.propose(keys);return
        if action=='clarify_visit':
            self.pending_answer_keys=keys
            self.requested_answers={key:self.texts[key] for key in keys}
            self.s.evidence.event('semantic_visit_needs_clarification',evidence=text)
            # Ask about the actual condition; do not repeat the slot question.
            await self.native_answer(text,None,epoch,clarify=True)
            return
        if action=='advance':
            remaining=self.unasked()
            if self.visit_confirmed or not m.visit_pending:
                unfinished=self.unfinished_question()
                if unfinished:
                    intent=self.last_meaning or {}
                    authorized=(not self.last_meaning or self.visit_confirmed
                        or intent.get('control') in ('attention','audio_repair')
                        or any(intent.get(key) for key in ('listening_ready','name','subject','other_questions','question_recall'))
                        or intent.get('next_question') and intent.get('plan_permission',True))
                    if not authorized:
                        if keys:await self.prepared(keys)
                        self.waiting=True;self.thinking.cancel('interrupted_question_waits_for_manager');await self.stop_backchannel()
                        self.s.evidence.event('controller_wait',reason='interrupted_question_waits_for_manager',question_id=unfinished['id'])
                        return
                    if unfinished['id'] in self.auto_replayed_questions:
                        # The retry can be interrupted too. A bounded replay
                        # budget must not count its unheard tail as completed.
                        if keys:await self.prepared(keys)
                        self.waiting=True;self.thinking.cancel('question_delivery_incomplete')
                        await self.stop_backchannel()
                        self.s.evidence.event('controller_wait',reason='interrupted_question_awaits_repair',question_id=unfinished['id'])
                    else:await self.replay_question(unfinished['id'],keys,explicit=False)
                    return
            undelivered=[row for row in self.question_history() if row['topic'] and not row['answered'] and not row['phone_complete']]
            if self.visit_confirmed and not remaining and undelivered:
                self.waiting=True;self.thinking.cancel('question_delivery_incomplete')
                await self.stop_backchannel()
                self.s.evidence.event('controller_wait',reason='required_question_playback_pending',question_ids=[r['id'] for r in undelivered])
                return
            if self.visit_confirmed and not remaining and all(k in m.facts for k in ('visit_day','visit_time')):
                result=m.prepare_close('visit_agreed')
                if result['ok']:
                    await self.prepared(keys+['visit_farewell'],closing=True);return
            if not remaining and self.visit.offered:
                # Keep the exact proposal while waiting for its answer. A
                # generic "when can I come?" would erase the conversational link.
                if keys:await self.prepared(keys)
                self.waiting=True
                self.s.evidence.event('controller_wait',reason='active_visit_awaits_confirmation')
                return
            if (self.s.backchannel and remaining and not keys and time.monotonic()-self.last_receipt_at>=20
                    and any(row.get('turn')==self.s.evidence.turn and row.get('status')=='answered' for row in self.answers.values())):
                available=[key for key in ('receipt_0','receipt_2','receipt_1') if self.speech.available(self.texts[key])]
                if available:
                    keys=[available[0]];self.last_receipt_at=time.monotonic()
            target=remaining[0]['key'] if remaining else 'visit';self.current=target
            await self.prepared(keys+[target]);return
        if keys:await self.prepared(keys)
        else:
            self.waiting=True;self.thinking.cancel('semantic_no_response_needed');await self.stop_backchannel()
            self.s.evidence.event('controller_wait',reason='semantic_no_response_needed')

    async def prepared(self,keys,closing=False):
        original_keys=list(keys)
        keys=[key for key in keys if self.speech.available(self.texts[key])
              or key=='name' and getattr(self,'name_repeat_requested',False)
              or key=='subject' and (self.last_meaning or {}).get('subject')
              or key=='identity_ack' and getattr(self,'identity_confirmation_requested',False)]
        if not keys:
            if closing:return await self.speak(text=' '.join(self.texts[key] for key in original_keys),closing=True)
            self.waiting=True;self.thinking.cancel('duplicate_speech_blocked');await self.stop_backchannel()
            self.s.evidence.event('speech_repeat_blocked',source='prepared_batch')
            self.s.evidence.event('controller_wait',reason='duplicate_speech_blocked')
            return
        if sum(self.texts[key].count('?') for key in keys)>1:
            self.s.evidence.event('semantic_question_budget_blocked',keys=keys)
            raise ValueError('Only one controller question per utterance')
        repeat_reason=('requested_repetition' if 'name' in keys and getattr(self,'name_repeat_requested',False)
                       else 'requested_subject' if 'subject' in keys and (self.last_meaning or {}).get('subject')
                       else 'requested_identity_confirmation' if 'identity_ack' in keys and getattr(self,'identity_confirmation_requested',False) else None)
        if len(keys)==1:return await self.speak(keys[0],closing=closing,repeat_reason=repeat_reason)
        return await self.speak(text=' '.join(self.texts[key] for key in keys),
            pcm=b''.join(self.clips[key] for key in keys),question_key=keys[-1],closing=closing,repeat_reason=repeat_reason)

    async def propose(self,keys):
        if not self.future_visit():
            await self.speak(text='Это время сегодня уже прошло. На какое более позднее время можно записаться?',question_key='visit-future-time')
            return
        proposal=self.visit.proposal()
        if proposal and self.visit.offered and all(normalized(proposal[key]['value'])==normalized(self.visit.offered[key]['value']) for key in ('day','time')):
            if keys:await self.prepared(keys)
            self.waiting=True;self.thinking.cancel('existing_visit_proposal_preserved');await self.stop_backchannel()
            self.s.evidence.event('controller_wait',reason='existing_visit_proposal_preserved',response_id=self.visit_offer_response_id)
            return
        if not keys:
            await self.ask_visit(proposal);return
        if not proposal:
            key='clarify_visit' if self.visit.day else 'clarify_day'
            await self.prepared(keys+[key]);return
        signature=(normalized(proposal['day']['value']),normalized(proposal['time']['value']))
        text=' '.join(self.texts[key] for key in keys)+f" Могу подъехать {proposal['day']['value']}, {proposal['time']['value']}. Подойдёт?"
        identifier=await self.speak(text=text,question_key='visit-slot:'+':'.join(signature))
        if identifier:
            self.visit.offered=proposal;self.visit_offer_response_id=identifier
            self.visit_attempts[signature]=self.visit_attempts.get(signature,0)+1
            self.s.evidence.event('controller_visit_proposal_queued',response_id=identifier,proposal=proposal,
                attempt=self.visit_attempts[signature])

    async def native_answer(self,text,after,epoch,clarify=False):
        self.legend_question=text if not clarify else None
        self.started=True
        self.native_question_policy='clarification' if clarify else 'answer_only'
        self.fallback_turn=self.s.evidence.turn;self.fallback_empty_recovered=False
        self.fallback_goal=('Цель из SCENARIO_SCOPE.purpose обязательна: при service речь об обслуживании уже имеющегося автомобиля. Не предлагай купить его и не превращай запись в осмотр перед покупкой. При other не добавляй покупку от себя. Правила о выборе нового автомобиля применяются только к purchase.\n'
            '- SCENARIO_SCOPE.spoken_subject — разговорное название для речи. Используй его, склоняя по месту: «бэха-пятёрка» → «по поводу бэхи-пятёрки». Допускаются привычные однозначные разговорные названия по манере клиента; не выдумывай прозвища и не теряй модель или серию. Не переходи к чтению полного каталожного названия.\n'
            'Ответь от первого лица на ВСЕ дополнительные вопросы менеджера из manager_utterance и manager_questions. Не повторяй уже данный ответ вместо ответа на новый вопрос. Краткость не должна исключать часть вопроса.\n'
            '- На общее приглашение представиться или рассказать о цели звонка назови только предмет обращения одной короткой фразой. Не перечисляй весь контекст, цену и условия, если их не спрашивали.\n'
            '- Имя и объект бери из requested_answers и buyer_information; сохраняй заданную потребность. Новые личные детали добавляй только по правилам легенды ниже.\n'
            '- Для понимания предмета обращения используй selected_subject и provided_need; полная модификация остаётся внутренними данными. При первом описании автомобиля используй SCENARIO_SCOPE.spoken_subject: разговорную марку/модель, цвет и короткое обозначение двигателя (объём и/или топливо), только если они явно есть у выбранного автомобиля в selected_subject. Например «по поводу чёрной бэхи-пятёрки, двухлитровой бензиновой». Неизвестные цвет или двигатель пропускай. При повторном упоминании достаточно марки/модели или цвета, не повторяй всё описание каждый раз. Если spoken_subject не выделен, сформулируй такое короткое описание по явным данным. Не читай полное название фида, год, поколение, коробку, привод, мощность и комплектацию. При уточнении менеджера ответь коротким запрошенным признаком из данных, например «автомат»; на несколько явных вопросов кратко ответь на каждый. Не расшифровывай индекс вроде 520i в объём двигателя или топливо без явных данных. Не путай предмет покупки с нынешней машиной клиента из легенды. Если предмет не задан нигде, попроси уточнить без выдуманной модели.\n'
            '- SCENARIO_SCOPE имеет приоритет над chosen_personal_statements и предпосылками вопросов менеджера. Предмет из subject или script_references уже выбран. Если они не содержат конкретного предмета, проверь script_title: используй только явно названную там марку и модель, без служебных слов и без замены заданного предмета. Не отвечай «модель не выбрал» и не проси выбрать её вместо заданной. Если менеджер спрашивает «новый?», ответь по данным о состоянии; если состояние не задано, на вопрос «новый или с пробегом» прямо назови предпочтение из buyer_information.default_condition_preference («Рассматриваю новый автомобиль»), не утверждая, что товар продавца действительно новый. Не отвечай «состояние пока не уточнял» и не уходи от выбора повтором модели. Не превращай уточняющие вопросы менеджера в новые желания клиента.\n'
            '- На вопрос, общались ли раньше с менеджером, ответь прямо о предыдущем контакте: по истории текущего звонка либо «До этого звонка не общался», если предыдущего контакта не задано. Перевод между сотрудниками в текущем звонке не означает прошлое обращение. Не заменяй ответ «да/нет» повтором марки автомобиля.\n'
            '- Если факта нет, отвечай как человек: что ещё не решил или предпочитаешь пока обсудить саму покупку. Не говори «я не указал», «я не сообщал», «этой информации у меня нет».\n'
            '- Ты вымышленный клиент тестового звонка. Если личная деталь ещё не задана в потребности или chosen_personal_statements, выбери правдоподобную деталь по контексту и голосу, ответь от первого лица. Не объясняй, что составляешь легенду.\n'
            '- Назови конкретное значение запрошенного личного свойства, а не общую категорию: например, на вопрос о текущем автомобиле нужны марка и модель, а не просто «какой-то седан». Если раньше назвал только категорию, можешь уточнить её без противоречия.\n'
            '- Если спрашивают, какие варианты сравнивал и где изучал предложения, не ограничивайся словами «характеристики и условия». Назови конкретные альтернативы и источник изучения в пределах цели SCENARIO_SCOPE. Это может быть правдоподобной личной легендой, если она ещё не задана; не придумывай реальные цены, акции, обещания других компаний и посещения тест-драйвов. Если раньше уже сказал, что конкретные варианты не сравнивал, сохрани это и явно отличай будущие планы сравнения от прошлого опыта.\n'
            '- Выбранные личные детали сохраняй: не меняй имя, текущую машину, способ оплаты и другие ответы при повторном вопросе. Заданные сведения потребности имеют приоритет. Не придумывай точные контакты, адреса, документы, факты о товаре, компании или сотруднике.\n'
            '- Не пересказывай уже сообщённую биографию по собственной инициативе. На новое свойство той же темы ответь только этим свойством: не добавляй заново текущую машину и её судьбу к вопросу о том, для кого покупается новая. Повторяй прежнюю деталь лишь по прямому повторному запросу.\n'
            '- При confirmation_requested сначала прямо подтверди или поправь понимание сотрудника: предмет, направление, город/точку обращения или прошлый контакт. Не заменяй «да/нет» собственным вопросом или простым «понял». Город и объект сверяй с target_location и SCENARIO_SCOPE; если сотрудник ошибся, поправь его. Отсутствие вопросительного знака в распознанном тексте не отменяет уточнение.\n'
            '- Если сотрудник проверяет, достаточно ли объяснил, ответь на достаточность информации. Если просит взять документы, прямо подтверди, что возьмёшь их. Не заменяй такую реакцию повтором модели, своего вопроса или времени визита.\n'
            '- География клиента не является свободной легендой: если target_location.city задан, клиент находится в этом городе и обращается в эту точку. На вопрос «где вы территориально?» назови этот город. Не подменяй его городом из описания холдинга, другого филиала, реплики продавца или ранее ошибочно созданной легенды. Не придумывай район, личный адрес, переезд, командировку или поездку из другого города. Если целевой город не задан, не выдумывай его.\n'
            '- Легенда разрешает биографию клиента, но НЕ новые ограничения приезда, занятость или удобные часы. Не выбирай время, не отказывайся от предложенного слота и не говори «вечером удобнее»: это решает только контроллер.\n'
            '- Адрес нужного салона бери из target_location.address, город и название — из той же target_location. Это известные данные целевой точки, их можно назвать по запросу сотрудника, в том числе для перевода в отдел продаж. Не заменяй их адресом другого филиала или личным адресом клиента. Если оператор предлагает назвать номер объявления ИЛИ адрес, достаточно известного адреса; номер объявления не выдумывай. Если адреса нет ни в target_location, ни в recent_manager_quotes, попроси его назвать. Не перечисляй адрес без запроса.\n'
            '- Не выдумывай факты о ходе разговора: получил ли отчёт, что уже обсуждено. Источники — facts, confirmed_visit и recent_manager_quotes.\n'
            '- На предложение порядка осмотра дай короткую реакцию на его содержание; не превращай его в неопределённость о личных планах.\n'
            '- Согласованный осмотр не задаёт срок покупки. chosen_personal_statements сохраняет только легенду клиента и не подтверждает сведения продавца или договорённости.\n'
            '- Время визита, восстановление прежнего вопроса и завершение озвучит контроллер. Не включай сведения о времени в свой ответ даже при вопросе о приезде; ответь только на остальные части. Твой ответ без собственных вопросов и прощания.\n'
            '- Не повторяй и не пересказывай реплику менеджера: ответь только на адресованные покупателю вопросы. Данные менеджера находятся в manager_utterance.')
        if clarify:
            self.fallback_goal=self.fallback_goal.replace('Твой ответ без собственных вопросов и прощания.',
                'Разрешён один новый вопрос о нерешённом условии, без прощания.')
            self.fallback_goal+=('\nСначала коротко ответь на ВСЕ вопросы менеджера, затем при необходимости уточни '
                'только нерешённое условие визита одним коротким новым вопросом. Не повторяй заданный вопрос о дне/времени. '
                'Не принимай условие автоматически и не запрашивай резерв без основания.')
        if (self.last_meaning or {}).get('contextual_reply'):
            self.fallback_goal+=('\nВ текущей реплике могло остаться нераспознанное уточнение. '
                'Прочитай manager_utterance целиком: прежде чем реагировать на сообщённые сведения, '
                'ответь на обращённые к тебе уточнения, включая проверку предыдущего контакта и предмета обращения. '
                'Искажённое название сверяй с SCENARIO_SCOPE. Если смысл не удаётся восстановить, '
                'коротко попроси повторить, не выдумывай ответ и не заменяй его простым «понял».')
        self.pending_after_native=(after,text,epoch)
        self.s.evidence.event('semantic_native_requested',after_playback=after,requested_answers=list(self.requested_answers))
        self.s.evidence.mark('llm_requested');self.thinking.arm('native_reply')
        self.llm.request_reason='controller_fallback';self.llm.request_turns.append(self.s.evidence.turn)
        self.s.playback.generated=True
        await self.llm.send_client_event(events.ResponseCreateEvent())

    async def fallback_done(self,response_id):
        statement=self.llm.spoken_text.get(response_id,'').strip()
        if statement and getattr(self,'legend_question',None) and not any(row['response_id']==response_id for row in self.customer_legend):
            self.customer_legend.append({'response_id':response_id,'question':self.legend_question,'text':statement,'scope':'fictional customer statements; not verified seller facts'})
            self.s.evidence.event('customer_legend_statement',response_id=response_id,text=statement)
        blocked=not self.llm.spoken_text.get(response_id,'').strip() and any(e['event'] in ('speech_repeat_blocked','native_echo_blocked')
            and e.get('response_id')==response_id for e in self.s.evidence.events)
        if blocked:self.fallback_empty_recovered=True
        await super().fallback_done(response_id)
        if blocked:
            self.pending_after_native=None;self.waiting=True;self.thinking.cancel('native_repeat_blocked')
            self.s.evidence.event('controller_wait',reason='native_repeat_blocked')
            return
        pending=getattr(self,'pending_after_native',None);self.pending_after_native=None
        if not pending or not self.llm.spoken_text.get(response_id,'').strip():return
        after,text,epoch=pending
        self.pending_answer_keys=[];self.requested_answers={}
        if not after:return
        async def continue_after_playback():
            try:
                async with asyncio.timeout(30):
                    while not self.s.evidence.delivery.complete(response_id):
                        if epoch!=self.epoch or self.unavailable():return
                        if self.s.evidence.delivery.response(response_id).get('interrupted'):return
                        await asyncio.sleep(.02)
                if epoch==self.epoch and not getattr(self.llm,'user_speaking',False) and self.monitor.segment_start is None:
                    self.native_resume_context={'response_id':response_id,'text':self.llm.spoken_text[response_id],'epoch':epoch}
                    self.s.evidence.event('semantic_continuation_ready',response_id=response_id,action=after)
                    await self.perform(after,text,epoch)
            except TimeoutError:self.s.evidence.event('semantic_continuation_timeout',response_id=response_id)
            finally:
                if self.continuation_task is asyncio.current_task():self.continuation_task=None
        self.cancel_continuation();self.continuation_task=asyncio.create_task(continue_after_playback())
