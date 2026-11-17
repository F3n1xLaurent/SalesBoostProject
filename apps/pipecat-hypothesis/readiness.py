"""Own one prepared socket until the same socket is handed to Pipecat."""
import asyncio
import json
import time
from websockets.protocol import State


class WarmSocket:
    context_id = "salesboost-warmup"

    def __init__(self, socket, evidence):
        self.socket, self.evidence = socket, evidence
        self.tasks = []
        self.error = None
        self.claimed = False

    @classmethod
    async def prepare(cls, opener, uri, headers, voice, evidence):
        for attempt in (1, 2):
            socket = None
            started = time.monotonic()
            try:
                async with asyncio.timeout(10):
                    socket = await opener(uri, additional_headers=headers, max_size=16 * 1024 * 1024, open_timeout=8, close_timeout=1)
                    await socket.send(json.dumps({"context_id": cls.context_id, "voices": [voice]}))
                    pong = await socket.ping()
                    await pong
                result = cls(socket, evidence)
                result.tasks = [asyncio.create_task(result.keepalive()), asyncio.create_task(result.watch())]
                evidence.event("tts_ready", attempt=attempt, latency_ms=round((time.monotonic() - started) * 1000, 2),
                    scope="working socket handshake and ping; voice/model synthesis checked separately by preflight")
                return result
            except Exception as exc:
                evidence.event("tts_prepare_failed", attempt=attempt, error_type=type(exc).__name__)
                if socket:
                    await socket.close()
                if attempt == 2:
                    raise RuntimeError("ElevenLabs working connection not ready; call was not dialed") from None

    async def keepalive(self):
        try:
            async with asyncio.timeout(120):
                while True:
                    await asyncio.sleep(5)
                    await self.socket.send(json.dumps({"context_id": self.context_id, "keep_alive": True}))
        except Exception as exc:
            self.error = type(exc).__name__
            self.evidence.event("tts_reservation_failed", error_type=self.error)
            await self.socket.close()

    async def watch(self):
        try:
            async for raw in self.socket:
                message = json.loads(raw)
                if message.get("error"):
                    self.error = "ProviderError"
                    self.evidence.event("tts_reservation_failed", message=message)
                    await self.socket.close()
                    return
        except Exception as exc:
            self.error = type(exc).__name__

    async def stop_tasks(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []

    async def claim(self):
        await self.stop_tasks()
        if self.claimed or self.error or self.socket.state is not State.OPEN:
            raise RuntimeError("Prepared ElevenLabs connection was lost before media handoff")
        self.claimed = True
        await self.socket.send(json.dumps({"context_id": self.context_id, "close_context": True}))
        self.evidence.event("tts_ready_connection_reused")
        return self.socket

    async def close(self):
        await self.stop_tasks()
        if not self.claimed:
            await self.socket.close()
