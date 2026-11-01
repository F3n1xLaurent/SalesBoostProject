import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/db';
import { config } from '../src/config';
import { loadCar } from '../src/data/carLoader';
import { getDefaultState } from '../src/state/defaultState';
import { withCostContext } from '../src/economics/costContext';
import { withAuditAnalyticsProgress } from '../src/logic/auditAnalyticsProgress';
import { evaluateSessionV2 } from '../src/llm/evaluatorV2';
import { prepareTranscriptForAnalysis } from '../src/voice/analysisTranscript';
import { filterUnreliableManagerTurns } from '../src/voice/transcriptReliability';
import { generateCallAnalyticsBundle } from '../src/voice/callAnalyticsBundle';
import { evaluatePlanCriteria } from '../src/voice/voiceCallSession';
import type { TranscriptTurn } from '../src/voice/callHistory';

// Explicitly regenerate one saved call. Never invoke telephony, re-transcribe
// recordings, clear existing analytics, or replay call lifecycle webhooks.
async function main() {
  const callId = String(process.argv[2] || '').trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(callId)) {
    throw new Error('Usage: node --import tsx scripts/regenerate-voice-call-analytics.ts <callId> [--apply]');
  }
  const session = await prisma.voiceCallSession.findUnique({ where: { callId } });
  if (!session) throw new Error('CALL_NOT_FOUND');
  if (!session.endedAt) throw new Error('CALL_NOT_FINISHED');
  const parse = <T>(value: string | null, fallback: T): T => value ? JSON.parse(value) as T : fallback;
  const transcript = parse<TranscriptTurn[]>(session.transcriptJson, []);
  const prepare = (turns: TranscriptTurn[]) => filterUnreliableManagerTurns(
    prepareTranscriptForAnalysis(turns, { ivrDetected: session.ivrDetected }).transcript,
  );
  const analysisTranscript = prepare(transcript);
  if (analysisTranscript.length < 2 || !analysisTranscript.some(t => t.role === 'manager')) {
    throw new Error('INSUFFICIENT_MANAGER_DIALOG');
  }
  const original = session.originalTranscriptJson ? prepare(parse<TranscriptTurn[]>(session.originalTranscriptJson, [])) : null;
  const planCall = await prisma.callPlanCall.findUnique({ where: { callId } });
  const plan = session.planId
    ? await prisma.callPlan.findUnique({ where: { id: session.planId }, select: { scriptId: true } })
    : null;
  const scriptId = planCall?.scriptId ?? plan?.scriptId;
  const script = scriptId
    ? await prisma.callScript.findUnique({ where: { id: scriptId }, include: { checklist: true } })
    : null;
  const evaluationChecklist = script?.checklist && !script.checklist.isArchived
    ? { id: script.checklist.id, name: script.checklist.name, items: parse<any[]>(script.checklist.itemsJson, []) }
    : null;
  const scenarioContext = session.source === 'demo'
    ? parse<{ prompt?: string }>(session.caseContextJson, {}).prompt
    : script ? JSON.stringify({
      name: script.name,
      context: script.context,
      questions: parse(script.questionsJson, []),
      successCriteria: parse(script.successCriteriaJson, []),
      dataCondition: parse(script.dataConditionJson, {}),
    }) : undefined;
  console.log(JSON.stringify({
    callId, model: config.openaiChatModel, turns: analysisTranscript.length,
    existingEvaluation: !!session.evaluationJson, scriptId, apply: process.argv.includes('--apply'),
  }));
  if (!process.argv.includes('--apply')) return;

  const startedAt = new Date();
  const runDirectory = path.resolve('storage/analytics-regeneration', callId, startedAt.toISOString().replace(/[:.]/g, '-'));
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFile(
    path.join(runDirectory, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' },
  );
  await save('before.json', { session, planCall });
  const stage = `analytics_regeneration:${startedAt.toISOString()}`;
  await withAuditAnalyticsProgress(`voice:${callId}`, 'evaluation', () => withCostContext({
    entityType: 'voice_call', entityId: callId, stage,
  }, async () => {
    console.log('[voice-regeneration] evaluation started');
    const { evaluation } = await evaluateSessionV2({
      dialogHistory: analysisTranscript.map(t => ({ role: t.role, content: t.text })),
      car: loadCar(), state: getDefaultState('normal'), earlyFail: false, behaviorSignals: [],
      scenarioContext, evaluationChecklist,
      transcriptionAlternatives: original?.length === analysisTranscript.length
        ? analysisTranscript.flatMap((turn, index) => {
          const raw = original[index];
          return turn.role === 'manager' && raw?.role === 'manager' && raw.text !== turn.text
            ? [{ turnIndex: index + 1, original: raw.text, reviewed: turn.text }] : [];
        }) : undefined,
    });
    await save('evaluation.json', evaluation);
    console.log('[voice-regeneration] evaluation done; generating report and plan criteria');
    const [bundle, criteria] = await Promise.all([
      generateCallAnalyticsBundle({
        transcript: analysisTranscript, outcome: session.outcome,
        totalScore: evaluation.overall_score_0_100 ?? null, evaluation, scenarioContext,
      }),
      evaluatePlanCriteria(callId, analysisTranscript),
    ]);
    if (!bundle.unifiedCallReport) throw new Error('REPORT_GENERATION_INCOMPLETE');
    const definitions = planCall ? parse<any[]>(planCall.criteriaJson, []) : [];
    if (definitions.some(item => String(item.expectedAnswer || '').trim()) && !criteria) {
      throw new Error('PLAN_CRITERIA_GENERATION_INCOMPLETE');
    }
    const result = {
      ...evaluation, call_summary: bundle.callSummary, reply_improvements: bundle.replyImprovements,
      unified_call_report: bundle.unifiedCallReport, plan_criteria: criteria,
    };
    await save('result.json', result);
    const evaluationJson = JSON.stringify(result);
    const totalScore = evaluation.overall_score_0_100 ?? null;
    // Commit both views atomically; abort if another worker updated the source
    // transcript/evaluation while the (potentially long) LLM requests ran.
    await prisma.$transaction(async tx => {
      const updated = await tx.voiceCallSession.updateMany({
        where: { callId, evaluationJson: session.evaluationJson, transcriptJson: session.transcriptJson },
        data: {
          evaluationJson, totalScore, failureReason: null,
          dimensionsJson: JSON.stringify(evaluation.dimension_scores),
          checklistResultsJson: JSON.stringify(evaluation.checklist),
        },
      });
      if (updated.count !== 1) throw new Error('CALL_CHANGED_DURING_REGENERATION; generated result saved on disk');
      if (planCall) {
        const planUpdated = await tx.callPlanCall.updateMany({
          where: { id: planCall.id, evaluationJson: planCall.evaluationJson, transcriptJson: planCall.transcriptJson },
          data: { evaluationJson, totalScore, failureReason: null },
        });
        if (planUpdated.count !== 1) throw new Error('PLAN_CALL_CHANGED_DURING_REGENERATION; generated result saved on disk');
      }
    });
    console.log(JSON.stringify({ ok: true, callId, totalScore, runDirectory, stage, durationMs: Date.now() - startedAt.getTime() }));
  }));
}

main().catch(error => {
  console.error('[voice-regeneration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
