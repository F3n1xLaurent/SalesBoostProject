"""Short prepared voice while a real generation operation is still pending."""
import asyncio
import os
import time
from line_gate import local_type


class ThinkingPause:
    def __init__(self, controller):
        self.c = controller
        self.delay_ms = max(0, min(10000, int(os.getenv('PIPECAT_THINKING_DELAY_MS', '1600'))))
        self.cooldown = max(5,min(120,float(os.getenv('PIPECAT_THINKING_COOLDOWN_SECONDS','25'))))
        self.current = None
        self.task = None
        self.last_key = None
        self.used_keys=set()
        self.semantic_delay_ms=2400

    def cancel(self, reason='cancelled'):
        job, self.current = self.current, None
        if self.task and self.task is not asyncio.current_task():
            self.task.cancel()
        self.task = None
        if job:
            self.c.s.evidence.event('thinking_pause_finished', source=job['source'], reason=reason,
                                   latency_ms=round((time.monotonic()-job['started'])*1000, 2),
                                   emitted=job['emitted'], turn=job['turn'])

    def arm(self, source):
        c=self.c
        if getattr(c,'line',None) and not c.line.can_speak:return None
        if (self.current and self.current['epoch']==c.epoch and self.current['turn']==c.s.evidence.turn
                and not c.unavailable()):
            self.current['stage']=source
            c.s.evidence.event('thinking_pause_stage',source=self.current['source'],stage=source)
            if not (self.task and self.task.done() and not self.current['emitted']):return self.current
        self.cancel('replaced')
        if not c.s.backchannel or not self.delay_ms or c.unavailable():
            return None
        started=time.monotonic()
        if source=='turn_wait':started=c.s.evidence.turn_marks.get((c.s.evidence.turn,'speech_end'),started)
        semantic=getattr(c.s.evidence.memory,'semantic_mode',False)
        threshold=max(self.delay_ms,self.semantic_delay_ms) if semantic else self.delay_ms
        job = {'source': source, 'epoch': c.epoch, 'turn': c.s.evidence.turn,
               'started': started, 'stage':source, 'emitted': False}
        self.current = job
        c.s.evidence.event('thinking_pause_armed', source=source, threshold_ms=threshold)

        async def later():
            try:
                await asyncio.sleep(max(0,threshold/1000-(time.monotonic()-job['started'])))
                reason = None
                if self.current is not job or job['epoch'] != c.epoch or c.unavailable():reason='stale'
                elif c.waiting or c.s.evidence.memory.phase in ('closing','ended','failed'):reason='waiting_or_closing'
                elif c.monitor.segment_start is not None or getattr(c.llm,'user_speaking',False):reason='person_speaking'
                elif c.s.playback.pending or c.s.playback.finish_requested:reason='audio_already_playing'
                elif c.bc_turn == job['turn'] or time.monotonic()-c.last_bc < (max(self.cooldown,60) if semantic else self.cooldown):reason='rate_limit'
                stage=job['stage']
                meaning_pending=(stage=='semantic_interpretation' and bool(c.latest_input.strip())
                    and bool(c.last_question) and local_type(c.latest_input) not in ('hold','terminal','ivr')
                    and not any(word in c.latest_input.casefold() for word in ('проверю','посмотрю','секунду')))
                if semantic and stage not in ('native_reply','reply_tts','visit_tts') and not meaning_pending:reason=reason or 'meaning_not_ready'
                if semantic and len(self.used_keys)>=2:reason=reason or 'call_budget'
                # Waiting is not agreement or a judgment about an unparsed
                # utterance. Listening acknowledgments have a separate path.
                pool=(['think_visit_0','think_visit_1'] if stage=='visit_tts' else
                      ['think_reply_0'] if semantic and meaning_pending else ['think_reply_1'])
                keys=[key for key in pool if key in c.clips and 0 < len(c.clips[key])/32000 <= 2]
                if semantic:keys=[key for key in keys if key not in self.used_keys]
                if not keys:reason=reason or 'no_short_prepared_clip'
                if reason:
                    c.s.evidence.event('thinking_pause_skipped',source=source,reason=reason)
                    return
                key=next((key for key in keys if key!=self.last_key),keys[0])
                self.last_key=key;c.last_bc=time.monotonic();c.bc_turn=job['turn']
                self.used_keys.add(key)
                job['emitted']=True
                c.s.evidence.event('thinking_pause_emitted',source=source,stage=stage,text=c.texts[key],
                                   latency_ms=round((time.monotonic()-job['started'])*1000,2))
                job['response_id']=await c.speak(key,kind='backchannel',mirror=False)
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                c.s.evidence.event('thinking_pause_failed',error_type=type(exc).__name__)

        self.task=asyncio.create_task(later())
        return job

    async def finish(self, job, reason='main_ready'):
        if self.current is not job:return
        c=self.c
        if job['emitted'] and getattr(c.s.evidence.memory,'semantic_mode',False):
            identifier=job.get('response_id') or c.playing_id
            # Finish sending this short prepared clip, then let the normal
            # output FIFO play the main reply. Clearing media here would cut
            # the filler (and can flush audio belonging to the main response).
            try:
                if getattr(c,'output_transport',None):
                    async with asyncio.timeout(2):
                        while job['epoch']==c.epoch and not c.unavailable():
                            row=c.s.evidence.delivery.response(identifier)
                            if row['interrupted'] or row['tags'] and row['tags']<=c.s.playback.sealed|row['confirmed']:break
                            await asyncio.sleep(.01)
            except TimeoutError:
                c.s.evidence.event('thinking_pause_handoff_timeout',response_id=identifier)
                self.cancel(reason);await c.stop_backchannel();return
            if self.current is not job or job['epoch']!=c.epoch:return
            self.cancel(reason)
            if c.playing_id==identifier:c.playing_id=None;c.playing_kind=None
            c.s.evidence.event('thinking_pause_handoff',response_id=identifier,clear_audio=False)
            return
        self.cancel(reason)
        # Output-only cancellation: never cancel the native LLM/TTS context.
        await c.stop_backchannel()

    async def main_audio_ready(self, response_id):
        c=self.c
        turn=c.s.evidence.messages.get(response_id,{}).get('turn')
        if turn!=c.s.evidence.turn:return
        if getattr(c,'breath',None):await c.breath.stop('tts_audio_ready')
        if self.current:
            await self.finish(self.current,'main_audio_ready')
        else:
            await c.stop_backchannel()
