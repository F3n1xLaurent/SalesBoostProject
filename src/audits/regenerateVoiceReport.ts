import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import { withCostContext } from '../economics/costContext';
import { assertAuditAnalyticsCurrent, withAuditAnalyticsProgress } from '../logic/auditAnalyticsProgress';
import { reportError } from '../monitoring/reportError';
import { generateUnifiedCallReport, completeGeneratedUnifiedCallReport } from '../voice/unifiedCallReport';
import type { TranscriptTurn } from '../voice/callHistory';
import { loadCallReportScenarioContext } from '../voice/callReportContext';
import { prepareTranscriptForAnalysis } from '../voice/analysisTranscript';
import { filterUnreliableManagerTurns } from '../voice/transcriptReliability';

/** Repair only the missing report. Never re-evaluate an already scored conversation. */
export async function regenerateVoiceReport(callId: string, draft?: unknown) {
  return withAuditAnalyticsProgress(`voice:${callId}`, 'report', async () => {
    const session = await prisma.voiceCallSession.findUnique({ where: { callId } });
    if (!session?.endedAt) throw new Error('CALL_NOT_FINISHED');
    const evaluation = JSON.parse(session.evaluationJson ?? 'null');
    if (!evaluation || session.totalScore == null) throw new Error('CALL_EVALUATION_REQUIRED');
    if (evaluation.unified_call_report) return evaluation.unified_call_report;
    const transcript = filterUnreliableManagerTurns(prepareTranscriptForAnalysis(JSON.parse(session.transcriptJson ?? '[]') as TranscriptTurn[], { ivrDetected: session.ivrDetected }).transcript);
    if (!transcript.some(turn => turn.role === 'manager')) throw new Error('INSUFFICIENT_MANAGER_DIALOG');
    const runId = randomUUID();
    await prisma.$transaction(async tx => {
      const existing = await tx.callAnalysisJob.findUnique({ where: { callId } });
      if (existing && ['queued', 'processing'].includes(existing.status)) throw new Error('CALL_ANALYSIS_ALREADY_RUNNING');
      const data = { runId, status: 'processing', payloadJson: '{}', queuedAt: new Date(), startedAt: new Date(), finishedAt: null };
      await tx.callAnalysisJob.upsert({ where: { callId }, create: { callId, ...data }, update: data });
    });
    try {
      const scenarioContext = await loadCallReportScenarioContext(callId, session.caseContextJson);
      const report = await withCostContext({ entityType: 'voice_call', entityId: callId, stage: 'report_retry' }, () => { const input = { transcript, outcome: session.outcome, totalScore: session.totalScore, evaluation, scenarioContext }; return draft ? completeGeneratedUnifiedCallReport(draft, input) : generateUnifiedCallReport(input); });
      if (!report) throw new Error('EMPTY_UNIFIED_CALL_REPORT');
      assertAuditAnalyticsCurrent();
      await prisma.$transaction(async tx => {
        const updated = await tx.voiceCallSession.updateMany({
          where: { callId, evaluationJson: session.evaluationJson, transcriptJson: session.transcriptJson },
          data: { evaluationJson: JSON.stringify({ ...evaluation, unified_call_report: report }), failureReason: null, reportCheckpointJson: null },
        });
        if (updated.count !== 1) throw new Error('CALL_CHANGED_DURING_REPORT_REPAIR');
        await tx.callPlanCall.updateMany({ where: { callId }, data: { evaluationJson: JSON.stringify({ ...evaluation, unified_call_report: report }), failureReason: null } });
        await tx.callAnalysisJob.updateMany({ where: { callId, runId }, data: { status: 'done', finishedAt: new Date(), payloadJson: '{}' } });
      });
      return report;
    } catch (error) {
      const reason = `REPORT_GENERATION_FAILED: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
      // Do not overwrite a report/evaluation written by a concurrent worker.
      await prisma.$transaction(async tx => {
        const updated = await tx.voiceCallSession.updateMany({ where: { callId, evaluationJson: session.evaluationJson, transcriptJson: session.transcriptJson }, data: { failureReason: reason } });
        if (updated.count) await tx.callPlanCall.updateMany({ where: { callId }, data: { failureReason: reason } });
        await tx.callAnalysisJob.updateMany({ where: { callId, runId }, data: { status: 'failed', finishedAt: new Date(), payloadJson: '{}' } });
      });
      reportError(error, { task: 'voice-report-repair', stage: 'report', entityId: callId });
      throw error;
    }
  });
}
