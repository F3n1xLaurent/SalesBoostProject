"""Run the existing TS scenario fixtures through the prototype's real LLM/tools.

Text-only evidence: never reports ASR/VAD/TTS/phone quality as passed.
"""
import asyncio
import argparse
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace
from uuid import uuid4

from pipecat.frames.frames import EndFrame, ErrorFrame, LLMRunFrame, StartFrame, OutputAudioRawFrame, TTSStoppedFrame, InterruptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.services.openai.realtime import events
from pipecat.workers.runner import WorkerRunner

from policy import OPENAI_PROVIDERS, PROVIDERS
from diagnostics import TraceArchive
from gemini_provider import create_gemini_service
from pipeline import GatedRealtime, OutputEvidence, Turn, VoxSerializer, call_context, prepare_tts, probe_tts_service
from service import Session


async def run_case(source, scenario, provider, audio_tts=False, reasoning_effort="low"):
    config = source["configuration"]
    prompt = config["prompt"] + ("\n" + scenario["persona"] if scenario.get("persona") else "")
    session = Session(id=str(uuid4()), provider=provider, tts_model=source["ttsModel"], voice_id=source["voiceId"],
        prompt=prompt, context={**config.get("businessContext", {}), "planName": "Текстовая регрессия: " + scenario["id"]}, to="", reasoning_effort=reasoning_effort,
        prompt_mode=config.get("promptMode", "legacy"), speech_mode=config.get("speechMode", "sentence"),
        dialogue_mode=config.get("dialogueMode","legacy"),backchannel=config.get("backchannel",False))
    session.status = "connected"
    evidence = session.evidence
    session.is_simulation = True
    evidence.event("regression_configuration", scenario_id=scenario["id"], mode="text_input_with_tts" if audio_tts else "text_only", phone_calls=0, playback_ack="simulated")

    async def no_phone_hangup():
        evidence.event("regression_end_requested", waiting_for_real_audio=True)

    simulated_digits=[]
    async def simulated_socket_send(text):
        message = json.loads(text)
        if message.get("action") == "hangup":
            evidence.event("simulated_hangup", phone_calls=0)
        if message.get('action')=='send_dtmf':
            simulated_digits.append(message['digit'])
            await serializer.deserialize(json.dumps({'customEvent':'dtmf_result',
                'commandId':message['commandId'],'digit':message['digit'],'ok':True,'path':simulated_digits}))
    serializer = VoxSerializer(session, SimpleNamespace(send_text=simulated_socket_send))
    controller=None
    if session.dialogue_mode in ("controller","semantic"):
        if not audio_tts:raise ValueError("Controller probe requires audio_tts")
        from dialogue_controller import DialogueController,controller_prompt
        from controller_audio import PreparedAudioPlayer
        from pipecat.processors.aggregators.llm_context import LLMContext
        from semantic_controller import SemanticController
        cls=SemanticController if session.dialogue_mode=="semantic" else DialogueController
        controller=cls(session,serializer,None);session.controller=controller
        await controller.prepare()
        context=LLMContext([{"role":"system","content":controller_prompt(session)}],tools=[])
        controller.player=PreparedAudioPlayer(session)
    else:context = call_context(session, serializer if audio_tts else SimpleNamespace(maybe_hangup=no_phone_hangup))
    user, assistant = LLMContextAggregatorPair(context, realtime_service_mode=provider in OPENAI_PROVIDERS)
    monitor = SimpleNamespace(turn=Turn(False),segment_start=None)
    llm = (GatedRealtime(session, monitor, wait_for_user=True, api_key=os.environ["OPENAI_API_KEY"],
        settings=GatedRealtime.Settings(model=PROVIDERS[provider], session_properties=events.SessionProperties(
            reasoning=events.Reasoning(effort=reasoning_effort),
            output_modalities=["text"], audio=events.AudioConfiguration(input=events.AudioInput(turn_detection=False)))))
        if provider in OPENAI_PROVIDERS else create_gemini_service(provider))
    started = asyncio.Event()
    llm.session = session
    if controller:controller.llm=llm;controller.monitor=monitor
    audio_bytes = 0
    ack_tasks=[]

    class SimulatedOutput(FrameProcessor):
        async def process_frame(self, frame, direction):
            nonlocal audio_bytes
            await super().process_frame(frame, direction)
            if isinstance(frame, OutputAudioRawFrame):
                audio_bytes += len(frame.audio)
                await serializer.serialize(frame)
            if isinstance(frame,InterruptionFrame):await serializer.serialize(frame)
            if isinstance(frame, TTSStoppedFrame):
                tag = session.playback.active
                await serializer.seal()
                if tag:
                    interrupt_question=bool(index+1<len(scenario['steps']) and
                        (scenario['steps'][index+1].get('interrupt_question') or scenario['steps'][index+1].get('overlap_fragment')))
                    async def acknowledge(tag):
                        if interrupt_question or controller and session.playback.finish_requested and any(s.get("interrupt_closing") for s in scenario["steps"]):await asyncio.sleep(3)
                        await serializer.deserialize(json.dumps({"customEvent": "playback", "action": "ended", "tag": tag}))
                    ack_tasks.append(asyncio.create_task(acknowledge(tag)))
            await self.push_frame(frame, direction)

    class Collector(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, StartFrame):
                started.set()
            if isinstance(frame, ErrorFrame):
                evidence.event("pipeline_error", message=frame.error)
            await self.push_frame(frame, direction)

    processors = [user, llm, OutputEvidence(session, serializer, "llm")]
    if audio_tts:
        try:
            await prepare_tts(session)
        except Exception as exc:
            session.status = "failed"; session.finalized = True
            evidence.event("session_ended", reason="tts_not_ready", error_type=type(exc).__name__)
            session.persist()
            return {"scenarioId": scenario["id"], "diagnosticId": "pc-" + session.id,
                    "status": "error", "errorType": type(exc).__name__, "message": str(exc), "audioBytes": 0}
        processors += [session.prepared_tts]
        if controller:processors.append(controller.player)
        output=SimulatedOutput()
        if controller:controller.output_transport=output
        processors += [OutputEvidence(session, serializer, "tts"), output, OutputEvidence(session, serializer, "delivery")]
    processors += [Collector(), assistant]
    worker = PipelineWorker(Pipeline(processors),
        params=PipelineParams(enable_metrics=True, audio_out_sample_rate=16000), enable_rtvi=False, processor_unusable_policy=ProcessorUnusablePolicy.END)
    @worker.event_handler("on_pipeline_error")
    async def pipeline_error(worker, frame):
        evidence.event("pipeline_error", message=frame.error)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    if provider in OPENAI_PROVIDERS:
        await worker.queue_frames([LLMRunFrame()])
    running = asyncio.create_task(runner.run())
    result = {"scenarioId": scenario["id"], "diagnosticId": "pc-" + session.id, "mode": "text_input_with_tts" if audio_tts else "text_only", "reasoningEffort": reasoning_effort if provider in OPENAI_PROVIDERS else None, "steps": []}
    try:
        await asyncio.wait_for(started.wait(), 15)
        if provider in OPENAI_PROVIDERS:
            await asyncio.wait_for(llm.context_ready.wait(), 15)
        pending = []
        for index, step in enumerate(scenario["steps"]):
            if step.get("if_confirmation") and not (controller and (controller.awaiting_confirmation or controller.visit.offered)):continue
            if session.playback.finish_requested and not step.get("interrupt_closing"):
                break
            if step.get("text"):
                pending.append(step["text"])
            if step.get("wait") == "none":
                continue  # Preserve a multi-part utterance as one input.
            if not pending:
                continue
            text = " ".join(pending); pending.clear()
            turn = index + 1
            evidence.turn = evidence.output_turn = turn
            monitor.turn = Turn(False, number=turn)
            if controller:await controller.new_input()
            if controller and step.get('listening_probe'):
                monitor.segment_start=time.monotonic()-4
                controller.schedule_backchannel('listen_active',0)
                if controller.bc_task:await controller.bc_task
                await asyncio.sleep(.3)
                monitor.segment_start=None
            if controller and step.get('barge_in'):
                await llm.broadcast_frame(InterruptionFrame)
            evidence.mark("speech_end",turn=turn)
            evidence.memory.user(text, turn)
            evidence.event("user_transcript", text=text, turn=turn)
            before = evidence.sequence
            if provider in OPENAI_PROVIDERS:
                if controller and step.get('overlap_fragment'):
                    # Exercise the real final-ASR handler, with a simulated
                    # short acoustic overlap and delayed phone playback ACK.
                    overlap=Turn(True,0,number=turn,question=controller.last_question)
                    monitor.turn=overlap
                    identifier='synthetic-prefix-'+str(turn)
                    llm.items[identifier]=(overlap,True)
                    await llm.handle_evt_input_audio_transcription_completed(SimpleNamespace(item_id=identifier,transcript=text))
                    await asyncio.gather(*ack_tasks)
                    result['steps'].append({'input':text,'replies':[],'expectedWait':'non_interrupting_fragment'})
                    continue
                llm.has_user_commit = True
                await llm._send_message_item(text, role="user")
                if controller and step.get('native_question_task'):
                    # Test-only model proposal: exercise the real Realtime ->
                    # semantic gate -> streaming TTS route deterministically.
                    controller.latest_input=text
                    controller.fallback_goal=step['native_question_task']
                    controller.fallback_turn=turn
                    controller.fallback_empty_recovered=False
                    controller.thinking.arm('native_reply')
                    llm.request_reason='controller_fallback'
                    llm.request_turns.append(turn)
                    session.playback.generated=True
                    await llm.send_client_event(events.ResponseCreateEvent())
                elif controller:controller.receive(text,turn)
                else:
                    llm.request_reason = "text_regression_input"
                    await llm._create_response()
            else:
                context.add_message({"role": "system", "content": evidence.memory.context_text()})
                context.add_message({"role": "user", "content": text})
                await worker.queue_frames([LLMRunFrame()])
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                await asyncio.sleep(0.1)
                rows = [e for e in evidence.events if e["seq"] > before]
                complete = any(e["event"] in {"provider_response_done", "assistant_response", "controller_wait", "simulated_hangup", "line_dialogue_blocked"} for e in rows)
                idle_ms = (evidence.clock() - evidence.started) * 1000 - evidence.events[-1]["ms"]
                busy = provider in OPENAI_PROVIDERS and (llm._response_active or llm._open_function_calls
                    or (llm.clarification_task and not llm.clarification_task.done())
                    or (llm._results_awaiting_response and not session.playback.finish_requested
                        and not (getattr(session,"tool_budget",None) and session.tool_budget.blocked)))
                if controller:busy=busy or bool(controller.task and not controller.task.done())
                if controller and getattr(controller,'line',None):
                    busy=busy or bool(controller.line.dtmf_task and not controller.line.dtmf_task.done())
                next_step=next((s for s in scenario["steps"][index+1:] if not s.get("if_confirmation") or (controller and (controller.awaiting_confirmation or controller.visit.offered))),{})
                if controller and next_step.get("interrupt_closing") and session.playback.finish_requested and session.playback.pending:break
                if controller and next_step.get('interrupt_question') and session.playback.pending:break
                if complete and not busy and idle_ms > 800 and (not audio_tts or not session.playback.busy):
                    break
            else:
                raise TimeoutError("Regression response did not settle")
            rows = [e for e in evidence.events if e["seq"] > before and e["event"] == "assistant_response" and e.get("status") != "suppressed_closing_narration"]
            replies = [evidence.messages.get(e.get("response_id"), {}).get("spoken_text", e["text"]) for e in rows]
            result["steps"].append({"input": text, "replies": [text for text in replies if text.strip()],
                "generatedReplies": [e["text"] for e in rows], "expectedWait": step.get("wait")})
            if controller and step.get("backchannel_probe"):
                controller.last_bc=-1000;controller.bc_turn=None
                controller.schedule_backchannel("listen",0)
                if controller.bc_task:await controller.bc_task
                await asyncio.sleep(.3)
        result["transportErrors"] = [e for e in evidence.events if e["event"] in {"pipeline_error", "provider_error", "provider_error_received", "closing_denied"}]
        result["finishRequested"] = session.playback.finish_requested
        result["closingDenials"] = sum(e["event"] == "closing_decision" and not e.get("result", {}).get("ok") for e in evidence.events)
        if scenario["id"] == "callback" and not session.playback.finish_requested:
            result["transportErrors"].append({"event": "callback_did_not_finish"})
        result["reasoningEffort"] = reasoning_effort if provider in OPENAI_PROVIDERS else None
        result["llmFirstTextMs"] = [e["latency_ms"] for e in evidence.events if e["event"] == "response_first_text_ms" and e.get("latency_ms") is not None]
        ordinary_requests = {e["request_id"] for e in evidence.events if e["event"] == "response_requested" and e.get("reason") == "text_regression_input"}
        result["ordinaryFirstTextMs"] = [e["latency_ms"] for e in evidence.events if e["event"] == "response_first_text_ms"
            and e.get("request_id") in ordinary_requests and e.get("response_id") not in getattr(llm, "held_responses", set()) and e.get("latency_ms") is not None]
        if provider in OPENAI_PROVIDERS:
            confirmations = [e for e in evidence.events if e["event"] == "provider_session_confirmed"]
            effective = ((confirmations[-1].get("session", {}).get("reasoning") or {}) if confirmations else {}).get("effort")
            result["reasoningConfirmed"] = effective
            if effective != reasoning_effort:
                result["transportErrors"].append({"event": "reasoning_not_confirmed", "requested": reasoning_effort, "effective": effective})
        result["audioBytes"] = audio_bytes
        if controller and getattr(controller,'line',None):result['line']=controller.line.snapshot()
        result["simulatedHangup"] = any(e["event"] == "simulated_hangup" for e in evidence.events)
        if audio_tts and not audio_bytes:
            raise RuntimeError("No TTS audio in the integrated pipeline")
        result["status"] = "error" if result["transportErrors"] else "review"
        result["checks"] = [{"id": key, "status": "review", "reason": "Shared fixture executed; semantic/audio assessment requires transcript review or the shared judge. Text input does not test live audio."} for key in scenario["checks"]]
    except Exception as exc:
        result.update(status="error", errorType=type(exc).__name__, message=str(exc),audioBytes=audio_bytes)
    finally:
        if controller:await controller.close()
        for task in ack_tasks:
            if not task.done():task.cancel()
        await asyncio.gather(*ack_tasks,return_exceptions=True)
        await runner.cancel()
        await asyncio.gather(running, return_exceptions=True)
        session.status = "disconnected"
        session.finalized = True
        evidence.event("session_ended", reason="text_regression")
        session.persist()
    return result


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source")
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--provider", choices=list(PROVIDERS), default="openai")
    parser.add_argument("--warm-tts", action="store_true")
    parser.add_argument("--audio-tts", action="store_true")
    parser.add_argument("--reasoning", choices=["low", "minimal"], default="low")
    parser.add_argument("--compare-reasoning", action="store_true")
    args = parser.parse_args()
    if args.synthetic:
        source = {"diagnosticId": "synthetic-no-crm", "ttsModel": "eleven_v4_turbo", "voiceId": os.environ.get("ELEVENLABS_VOICE_ID"),
            "configuration": {"prompt": "Ты покупатель, звонишь по тестовому автомобилю. Сначала уточни наличие, затем пробег. Если менеджер занят, согласись перезвонить в названное время и заверши разговор. Говори коротко по-русски.", "businessContext": {"subjectTitle": "Тестовый автомобиль"}}}
        if not source["voiceId"]:
            # Read only the user's configured voice from its existing provider;
            # no agent instructions or CRM fields are sent to the LLM.
            import httpx
            from network import elevenlabs_http_options
            async with httpx.AsyncClient(timeout=15, **elevenlabs_http_options()) as client:
                response = await client.get("https://api.elevenlabs.io/v1/convai/agents/" + os.environ["ELEVENLABS_AGENT_ID"], headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]})
                response.raise_for_status()
                source["voiceId"] = response.json()["conversation_config"]["tts"]["voice_id"]
    else:
        source = TraceArchive().read(args.source)
    fixtures = json.load(sys.stdin)
    report = {"id": "pcr-" + str(uuid4()), "provider": args.provider, "fixtureVersion": fixtures["fixtureVersion"],
        "source": source["diagnosticId"], "phoneCallsMade": 0, "mode": "text_input_with_tts" if args.audio_tts else "text_only", "cases": [],
        "reasoningEffort": "compare" if args.compare_reasoning else args.reasoning,
        "limitations": ["No ASR, VAD, barge-in, telephone playback or acoustic quality measurement. Playback ACK is simulated in audio mode.",
                        "Shared scenarios reused without modifying hypothesis 2; semantic checks require review."]}
    if args.warm_tts:
        config = source["configuration"]
        s = Session(id=str(uuid4()), provider=args.provider, tts_model=source["ttsModel"], voice_id=source["voiceId"],
            prompt="Проверка подготовки TTS без звонка", context={}, to="")
        try:
            await prepare_tts(s)
            report["warmTts"] = await probe_tts_service(s.tts_model, s.voice_id, tts_service=s.prepared_tts)
            report["warmTts"]["sameConnectionReused"] = any(e["event"] == "tts_ready_connection_reused" for e in s.evidence.events)
        finally:
            s.status = "disconnected"; s.finalized = True; s.persist()
    orders = [["low", "minimal"], ["minimal", "low"]] if args.compare_reasoning else [[args.reasoning]]
    for order in orders:
        for effort in order:
            for scenario in fixtures["scenarios"]:
                result = await run_case(source, scenario, args.provider, args.audio_tts, effort)
                report["cases"].append(result)
                print(json.dumps({"scenarioId": result["scenarioId"], "reasoningEffort": effort, "status": result["status"], "diagnosticId": result["diagnosticId"]}), flush=True)
    if args.compare_reasoning:
        import statistics
        report["comparison"] = {}
        for effort in ("low", "minimal"):
            cases = [case for case in report["cases"] if case.get("reasoningEffort") == effort]
            values = [value for case in cases for value in case.get("ordinaryFirstTextMs", [])]
            report["comparison"][effort] = {"samples": len(values), "medianFirstTextMs": round(statistics.median(values), 2) if values else None,
                "errors": sum(case["status"] == "error" for case in cases), "quality": "manual review; not automatic acceptance"}
    path = TraceArchive().root / (report["id"] + ".json")
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"reportId": report["id"], "path": str(path), "cases": len(report["cases"]), "warmTts": report.get("warmTts"), "comparison": report.get("comparison")}), flush=True)
    if any(case["status"] == "error" for case in report["cases"]):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
