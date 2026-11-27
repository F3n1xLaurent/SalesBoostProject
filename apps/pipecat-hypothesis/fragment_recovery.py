"""Bound semantic fragment waits without speaking over audio or pending ASR."""
import asyncio
import time
import re
from copy import deepcopy

from turn_meaning import review_fragment_question
from policy import is_courtesy_fragment


class FragmentRecovery:
    def __init__(self,controller):
        self.c=controller;self.task=None;self.record=None
        self.quiet_seconds=2.5;self.repair_seconds=5.;self.max_wait=10.
        self.reviews=0;self.handled=set();self.repaired_roots=set()

    def cancel(self,preserve=False):
        if self.task and self.task is not asyncio.current_task():self.task.cancel()
        self.task=None
        if not preserve:self.record=None

    def safe(self,record,check_epoch=True):
        c=self.c;llm=c.llm
        return (self.record is record and (not check_epoch or record['epoch']==c.epoch)
            and not c.unavailable() and c.line.can_speak and c.s.evidence.memory.phase not in ('closing','ended','failed')
            and not c.manager_speaking() and not c.s.playback.busy
            and not any(getattr(llm,key,None) for key in ('stt_tasks','quality_tasks','pending','items','wire_active','wire_pending'))
            and not any(row not in record['batch'] for row in c.inputs.snapshot()))

    def arm(self,text,turn,epoch,meaning,batch=None,speech_end=None):
        self.cancel()
        if not self.c.line.can_speak or self.c.unavailable():return
        batch=list(self.c.active_batch or []) if batch is None else batch
        signature=(text,tuple(row['turn'] for row in batch))
        if signature in self.handled:return
        if speech_end is None:
            speech_end=getattr(self.c.monitor.turn,'speech_end',None) if self.c.monitor.turn.number==turn else None
        record={'text':text,'turn':turn,'epoch':epoch,'meaning':deepcopy(meaning),'batch':list(batch),
            'speech_end':speech_end or time.monotonic(),'signature':signature,
            'root':batch[0]['turn'] if batch else turn}
        self.record=record;self.task=asyncio.create_task(self.run(record))
        self.c.s.evidence.event('semantic_fragment_recovery_armed',source_turn=turn)

    async def quiet(self,record,seconds):
        deadline=record['speech_end']+seconds
        while self.record is record and self.c.epoch==record['epoch'] and not self.c.unavailable() and self.c.line.can_speak:
            now=time.monotonic()
            if self.safe(record) and now>=deadline:return True
            if now>=record['speech_end']+self.max_wait:
                self.c.s.evidence.event('semantic_fragment_recovery_deferred',source_turn=record['turn'],reason='audio_or_asr_pending')
                return False
            await asyncio.sleep(.01 if now>=deadline else min(.05,deadline-now))
        return False

    def restore_after_ignored_input(self):
        record=self.record
        if not record or not self.safe(record,check_epoch=False):return
        self.arm(record['text'],self.c.monitor.turn.number,self.c.epoch,record['meaning'],batch=record['batch'])
        self.c.s.evidence.event('semantic_fragment_recovery_restored')

    async def run(self,record):
        c=self.c;epoch=record['epoch']
        try:
            if not await self.quiet(record,self.quiet_seconds):return
            meaning=record['meaning']
            substantive=(any(meaning.get(key) for key in ('name','name_confirmation','subject','other_questions',
                'next_question','plan_permission','listening_ready','acknowledgment_request','confirmation_request','question_recall'))
                or meaning.get('seller_permission','none')!='none'
                or meaning.get('visit') in ('accept','offer','change','cancel','conditional')
                or any(value in ('answered','unknown') for value in meaning.get('coverage',{}).values()))
            if is_courtesy_fragment(record['text']) and not substantive:
                # A handful of courtesy syllables contains nothing to clarify.
                # Keep raw evidence, discard this empty dialogue batch so it
                # cannot poison the next employee's actual greeting/question.
                self.handled.add(record['signature']);self.record=None
                c.inputs.consume(record['batch']);c.fragment_input_epoch=None;c.waiting=True
                ignored={row['turn'] for row in record['batch']}|{record['turn']}
                c.s.evidence.memory.users=[row for row in c.s.evidence.memory.users if row['turn'] not in ignored]
                c.thinking.cancel('courtesy_fragment')
                c.s.evidence.event('semantic_courtesy_fragment_ignored',source_turn=record['turn'])
                return
            verdict='clarify'
            if self.reviews<4:
                self.reviews+=1
                try:verdict=await review_fragment_question(c,record['text'])
                except Exception as exc:c.s.evidence.event('semantic_fragment_review_failed',error_type=type(exc).__name__)
            if not self.safe(record):return
            if verdict=='hold':
                self.handled.add(record['signature']);self.record=None
                c.line.history=[record['text']];c.line.state='waiting_operator';c.line.arm_wait()
                await c.line.silence('fragment_review_requested_hold')
                return
            if verdict in ('own_vehicle','other'):
                self.handled.add(record['signature']);self.record=None
                focus=verdict if verdict=='own_vehicle' else record['meaning'].get('reply_focus','other')
                if focus not in ('own_vehicle','selected_subject','beneficiary','preferences','prior_contact'):focus='other'
                if verdict=='other' and focus=='own_vehicle':focus='other'
                c.last_meaning={**record['meaning'],'control':'continue','reply_focus':focus,'other_questions':True,
                    'next_question':False,'subject':focus=='selected_subject','name':False,'name_confirmation':False,
                    'confirmation_request':False,'buyer_question_parts':[]}
                c.fragment_input_epoch=None;c.waiting=False;c.active_batch=list(record['batch'])
                c.pending_answer_keys=[];c.requested_answers={}
                c.s.evidence.event('semantic_fragment_question_recovered',source_turn=record['turn'],reply_focus=focus)
                await c.native_answer(record['text'],'advance',epoch)
                return
            if record['root'] in self.repaired_roots:
                # New ASR turn numbers do not create a new repair budget for
                # the same retained sentence. A repeated reply may be clear
                # while an older unfinished tail still poisons interpretation.
                parts=record['batch']
                words=lambda value:re.findall(r'\w+',value.casefold().replace('ё','е'))
                repeated=bool(parts and any(words(row['text'])==words(parts[-1]['text']) for row in parts[:-1]))
                if repeated:
                    before=set(c.answers);c.active_batch=list(parts);c.fragment_input_epoch=None
                    resolved=await c.clarify_required_answer([],record['text'],epoch)
                    if epoch!=c.epoch or c.unavailable():return
                    if resolved or set(c.answers)!=before:
                        self.handled.add(record['signature']);self.record=None
                        c.s.evidence.event('semantic_repeated_fragment_resolved',source_turn=record['turn'],root=record['root'])
                        if not resolved:await c.perform('advance',record['text'],epoch)
                        return
                self.handled.add(record['signature']);self.record=None
                c.waiting=True;c.thinking.cancel('fragment_repair_limit')
                c.s.evidence.event('semantic_fragment_repair_limit',source_turn=record['turn'],root=record['root'])
                return
            if not await self.quiet(record,self.repair_seconds):return
            # A repair is not the answer to this retained fragment. Keep the
            # original text so a short continuation can still complete it.
            active=c.active_batch;c.active_batch=None
            try:identifier=await c.speak('stt_repair',repeat_reason='unfinished_fragment_repair')
            finally:
                if c.epoch==epoch and c.active_batch is None:c.active_batch=active
            if identifier:
                self.repaired_roots.add(record['root'])
                self.handled.add(record['signature']);self.record=None
                c.s.evidence.event('semantic_fragment_repair_requested',source_turn=record['turn'])
        finally:
            if self.task is asyncio.current_task():self.task=None

    async def close(self):
        task=self.task;self.cancel()
        if task:await asyncio.gather(task,return_exceptions=True)
