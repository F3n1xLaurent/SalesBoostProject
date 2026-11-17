"""Bounded backend-owned farewell when the Realtime transport is lost."""
import asyncio
from uuid import uuid4

from pipecat.frames.frames import InterruptionFrame, TTSSpeakFrame


class RealtimeFailureNotice:
    def __init__(self, session, llm, monitor, serializer, runner, timeout=15):
        self.session, self.llm, self.monitor = session, llm, monitor
        self.serializer, self.runner, self.timeout = serializer, runner, timeout

    async def __call__(self):
        s, e = self.session, self.session.evidence
        try:
            self.monitor.cancel_timer()
            # Discard stale output before a separate, backend-owned utterance.
            barrier = getattr(self.serializer, "queue_cleared_event", None)
            if barrier:
                barrier.clear()
            await self.monitor.broadcast_frame(InterruptionFrame)
            if barrier:
                await asyncio.wait_for(barrier.wait(), timeout=2)
            identifier = "failure-" + uuid4().hex
            text = ("Извините, не удаётся распознать речь. Не могу продолжить разговор. До свидания."
                if getattr(s,'failure_reason',None)=='realtime_stt_timeout' else
                "Извините, связь прервалась. Не могу продолжить разговор. До свидания.")
            if getattr(s,'failure_reason',None)=='realtime_initialization_timeout':
                text='Извините, не удалось начать разговор из-за технической ошибки. До свидания.'
            e.current_response_id = identifier
            e.response_text_at[identifier] = e.clock()
            e.assistant(identifier, text, source="backend_realtime_failure")
            e.delivery.response(identifier)["generated_done"] = True
            s.playback.finish_requested = True
            s.finish_response_id = identifier
            frame = TTSSpeakFrame(text)
            frame.append_to_context = False
            frame.metadata["diagnostic_response_id"] = identifier
            e.event("realtime_failure_notice_requested", response_id=identifier, ack_timeout_seconds=self.timeout)
            await self.llm.push_frame(frame)
            await self.serializer.maybe_hangup()
            await asyncio.sleep(self.timeout)
            if not getattr(s, "finalized", False) and s.status != "disconnected":
                e.event("realtime_failure_close_timeout", normal_completion=False, response_id=identifier)
                await self.serializer.send({"customEvent": "control", "action": "hangup"})
                asyncio.create_task(self.runner.cancel())
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            e.event("realtime_failure_notice_failed", error_type=type(exc).__name__, normal_completion=False)
            try:
                await self.serializer.send({"customEvent": "control", "action": "hangup"})
            finally:
                asyncio.create_task(self.runner.cancel())
