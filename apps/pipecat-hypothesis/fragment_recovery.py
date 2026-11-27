"""Bound semantic fragment waits without speaking over audio or pending ASR."""
import asyncio
import time
from copy import deepcopy

from turn_meaning import review_fragment_question


class FragmentRecovery:
    def __init__(self,controller):
        self.c=controller;self.task=None;self.record=None
        self.quiet_seconds=2.5;self.repair_seconds=5.;self.max_wait=10.
        self.reviews=0;self.handled=set()

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
            'speech_end':speech_end or time.monotonic(),'signature':signature}
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
            if not await self.quiet(record,self.repair_seconds):return
            # A repair is not the answer to this retained fragment. Keep the
            # original text so a short continuation can still complete it.
            active=c.active_batch;c.active_batch=None
            try:identifier=await c.speak('stt_repair',repeat_reason='unfinished_fragment_repair')
            finally:
                if c.epoch==epoch and c.active_batch is None:c.active_batch=active
            if identifier:
                self.handled.add(record['signature']);self.record=None
                c.s.evidence.event('semantic_fragment_repair_requested',source_turn=record['turn'])
        finally:
            if self.task is asyncio.current_task():self.task=None

    async def close(self):
        task=self.task;self.cancel()
        if task:await asyncio.gather(task,return_exceptions=True)
