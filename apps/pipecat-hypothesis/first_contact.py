"""One audio-backed recovery of a greeting; never repairs business facts."""
import math
import re
import statistics
import time

from pipecat.services.openai.realtime import events
from input_quality import foreign_script,tokens
from line_gate import company_greeting_only,greeting_only,local_type,name_question_only
from plan_context import target_location


PROTECTED=set('да нет не нельзя можно сегодня завтра послезавтра один два три четыре пять шесть семь восемь девять десять двадцать тридцать сто тысяча тысяч рублей часов понедельник вторник среда четверг пятница суббота воскресенье'.split())


def contact_intent(text,names):
    if (not isinstance(text,str) or not text.strip() or len(text)>300 or foreign_script(text)
            or re.search(r'\d',text) or set(tokens(text))&PROTECTED):return None
    if local_type(text) not in (None,'human'):return None
    if greeting_only(text) or company_greeting_only(text,names):return 'greeting'
    if name_question_only(text):return 'name'
    # Strip only a known company introduction, never an arbitrary earlier
    # question. The remaining full suffix must be an explicit name request.
    for match in re.finditer(r'\b\w',text):
        if not name_question_only(text[match.start():]):continue
        prefix=text[:match.start()].strip(' ,.!?;:…')
        if company_greeting_only(prefix,names) or company_greeting_only('Здравствуйте, '+prefix,names):return 'name'
    return None


class FirstContact:
    def __init__(self,controller):self.c=controller;self.record=None;self.used=False

    def clear(self):self.record=None

    def capture(self,text,turn,window,item_id):
        self.clear()
        c=self.c;location=target_location(c.s)
        name=location.get('name','')
        # A city alone is not an independent company identifier.
        if (self.used or c.line.ever_human or not window or not name
                or tokens(name)==tokens(location.get('city',''))
                or len(''.join(tokens(name)))<5 or not tokens(name)
                or tokens(name) in (['автосалон'],['компания'],['отдел','продаж'])
                or turn!=c.monitor.turn.number):return
        first=tokens(text);brand=tokens(name)
        if not any(first[i:i+len(brand)]==brand for i in range(len(first)-len(brand)+1)):return
        if foreign_script(text) or re.search(r'\d',text) or set(first)&PROTECTED or local_type(text) is not None:return
        f=window.features()
        if (window.clipped or not 700<=f['duration_ms']<=8000 or f['rms_db']<-40
                or f['snr_db']<12 or f['energetic_ms']<500):return
        self.record={'text':text,'turn':turn,'window':window,'item_id':item_id,'names':[name],
            'captured_at':time.monotonic()}
        c.s.evidence.event('first_contact_audio_retained',source_turn=turn,features=f)

    def safe(self,record,epoch):
        c=self.c
        return (epoch==c.epoch and record['turn']==c.monitor.turn.number and not c.unavailable()
            and not c.line.ever_human and not c.line.can_speak and c.line.state!='ended'
            and not c.manager_speaking() and not c.s.playback.busy
            and time.monotonic()-record['captured_at']<8
            and not any(getattr(c.llm,key,None) for key in ('stt_tasks','quality_tasks','pending','items')))

    async def recover(self,text,turn,epoch):
        record=self.record;self.clear()
        if (self.used or not record or record['turn']!=turn or tokens(record['text'])!=tokens(text)
                or not self.safe(record,epoch)):return None
        self.used=True;c=self.c;started=time.monotonic()
        try:
            result,reason=await c.llm.input_quality.verify_window(record['window'])
            if not self.safe(record,epoch):return None
            reviewed=result.get('text','') if isinstance(result,dict) else ''
            rows=result.get('logprobs') if isinstance(result,dict) else None
            scores=[r.get('logprob') for r in rows if isinstance(r,dict)] if isinstance(rows,list) else []
            valid_scores=bool(scores) and all(type(x) in (int,float) and math.isfinite(x) and x<=0 for x in scores)
            mean=statistics.mean(scores) if valid_scores else None
            confident=mean is not None and mean>=-.5
            words=tokens(reviewed) if isinstance(reviewed,str) else []
            brand=tokens(record['names'][0])
            same_company=any(words[i:i+len(brand)]==brand for i in range(len(words)-len(brand)+1))
            intent=contact_intent(reviewed,record['names']) if confident and same_company else None
            c.s.evidence.event('first_contact_audio_review',source_turn=turn,intent=intent,
                reason=reason or ('verified_contact' if intent else 'unverified_contact'),
                reviewed_text=reviewed,verification_mean_logprob=mean,
                latency_ms=round((time.monotonic()-started)*1000,2),scope='greeting/name only; no business facts')
            if not intent:return None
            # Keep the original evidence log, remove its garbled provider item.
            # Only the independently recognized greeting/name request is used.
            await c.llm.send_client_event(events.ConversationItemDeleteEvent(item_id=record['item_id']))
            if not self.safe(record,epoch):return None
            item=events.ConversationItem(type='message',role='user',content=[events.ItemContent(type='input_text',text=reviewed)])
            c.llm.reviewed_items.add(item.id);c.llm._messages_added_manually[item.id]=True
            await c.llm.send_client_event(events.ConversationItemCreateEvent(item=item))
            if not self.safe(record,epoch):return None
            c.s.evidence.event('user_transcript',turn=turn,item_id=record['item_id'],text=reviewed,
                source='first_contact_audio_review',status='completed',replaces_text=text,
                verification_scope='greeting/name only; no business facts')
            return {'intent':intent,'text':reviewed}
        except Exception as exc:
            c.s.evidence.event('first_contact_audio_review_failed',source_turn=turn,error_type=type(exc).__name__)
            return None
