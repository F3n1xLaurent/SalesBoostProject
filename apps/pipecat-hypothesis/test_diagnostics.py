import json
import os
import tempfile
import unittest
from unittest.mock import patch, AsyncMock
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
from diagnostics import TraceArchive, redact, transcript
from policy import Evidence, Playback
from pipeline import GatedRealtime, Turn
from pipecat.services.openai.realtime import events
import service


class ArchiveTests(unittest.TestCase):
    def test_full_trace_survives_ring_limit_and_restart_with_cursor_and_auth(self):
        identifier = str(uuid4())
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "PIPECAT_LOG_DIR": directory, "PIPECAT_HYPOTHESIS_TOKEN": "x" * 32,
        }):
            archive = TraceArchive()
            archive.metadata(identifier, {"id": identifier, "diagnosticId": "pc-" + identifier,
                "status": "connected", "createdAt": 1, "instanceId": "previous-process"})
            evidence = Evidence(lambda event: archive.append(identifier, event))
            for i in range(1105):
                evidence.event("test", index=i)
            self.assertEqual(len(evidence.events), 1000)
            with TestClient(service.app) as client:
                auth = {"Authorization": "Bearer " + "x" * 32}
                self.assertEqual(client.get("/sessions").status_code, 401)
                for suffix in ("", "/export", "/diagnostics", "/summary"):
                    self.assertEqual(client.get(f"/sessions/{identifier}{suffix}").status_code, 401)
                exported = client.get(f"/sessions/pc-{identifier}/export", headers=auth).json()
                self.assertEqual(exported["eventCount"], 1105)
                self.assertEqual(exported["events"][0]["index"], 0)
                self.assertEqual(exported["status"], "interrupted")
                self.assertTrue(exported["finalized"])
                page = client.get(f"/sessions/{identifier}/diagnostics?after=1000&limit=60", headers=auth).json()
                self.assertEqual(page["nextCursor"], 1060)
                self.assertTrue(page["hasMore"])
                self.assertEqual(page["events"][0]["seq"], 1001)
                self.assertEqual(client.get(f"/sessions/{identifier}/diagnostics?after=-1", headers=auth).status_code, 400)
                self.assertEqual(client.get("/sessions", headers=auth).json()["runs"][0]["diagnosticId"], "pc-" + identifier)

    def test_legacy_and_incomplete_last_line_are_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = TraceArchive(directory)
            identifier = str(uuid4())
            archive.append(identifier, {"event": "user_transcript", "text": "Да", "turn": 1})
            with (archive.root / f"{identifier}.jsonl").open("a") as file:
                file.write('{"event":')
            restored = TraceArchive(directory).read(identifier)
            self.assertTrue(restored["legacy"])
            self.assertEqual(restored["eventCount"], 1)
            self.assertTrue(restored["limitations"])
            with self.assertRaises(ValueError):
                archive.read("../../.env")

    def test_redaction_preserves_text_but_removes_keys_urls_and_pcm(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "a-private-key"}):
            result = redact({"token": "secret", "text": "error a-private-key", "audio": "A" * 1000,
                "url": "https://user:password@example.org/media?token=secret&call=123", "answer": "Удобно завтра?"})
        encoded = json.dumps(result)
        for secret in ("secret", "password", "a-private-key", "A" * 1000):
            self.assertNotIn(secret, encoded)
        self.assertEqual(result["answer"], "Удобно завтра?")

    def test_partial_and_final_merge_and_delayed_cancel_does_not_replace_new_question(self):
        clock = [0]
        evidence = Evidence(clock=lambda: clock[0])
        evidence.assistant("old", "Удобно?", status="partial", item_id="item-old")
        evidence.assistant("old", "Удобно завтра?")
        evidence.assistant("new", "Во сколько позвонить?")
        evidence.assistant("old", "Удобно завтра?", status="cancelled")
        evidence.last_played_id = "new"
        evidence.last_playback_end_ms = 1000
        clock[0] = 14
        reference = evidence.reply_reference(2)
        self.assertEqual(reference["pause_ms"], 13000)
        self.assertEqual(reference["previous_assistant"]["response_id"], "new")
        self.assertEqual(reference["candidate_question"]["response_id"], "new")
        evidence.event("user_transcript", text="В пять", turn=2, item_id="user-2", reply_reference=reference)
        messages = transcript(evidence.events)
        self.assertEqual(len(messages), 3)
        self.assertEqual(messages[0]["status"], "cancelled")
        self.assertEqual(messages[-1]["replyReference"]["pause_ms"], 13000)


class ProviderAuditTests(unittest.IsolatedAsyncioTestCase):
    async def test_audit_passes_original_requests_and_snapshots_committed_audio_and_deleted_context(self):
        session = SimpleNamespace(evidence=Evidence(), playback=Playback())
        monitor = SimpleNamespace(turn=Turn(False, 600, number=2))
        llm = GatedRealtime(session, monitor, api_key="test")
        llm.provider_items["previous"] = {"id": "previous", "role": "assistant", "content": [{"text": "Ваш бюджет?"}]}
        llm.audio_buffer_bytes = 48000
        with patch.object(GatedRealtime.__bases__[0], "send_client_event", new=AsyncMock()) as send:
            commit = events.InputAudioBufferCommitEvent()
            request = events.ResponseCreateEvent()
            await llm.send_client_event(commit)
            await llm.send_client_event(request)
            self.assertIs(send.call_args_list[0].args[0], commit)
            self.assertIs(send.call_args_list[-1].args[0], request)
            snapshot = next(e for e in session.evidence.events if e["event"] == "response_requested")
            self.assertEqual(snapshot["last_audio_commit"]["audio_ms"], 1000)
            self.assertEqual(snapshot["provider_conversation"][0]["id"], "previous")
            await llm.send_client_event(events.ConversationItemDeleteEvent(item_id="previous"))
            self.assertNotIn("previous", llm.provider_items)
            self.assertEqual(session.evidence.events[-1]["removed_item"]["id"], "previous")


if __name__ == "__main__":
    unittest.main()
