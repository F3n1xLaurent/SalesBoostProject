import { readFile, stat } from 'node:fs/promises';
import { prisma } from '../db';
import { callRecordingKey, callRecordingStorage } from '../storage/callRecordingStorage';
import {
  buildCallDiagnosticBundle,
  buildTrainerDiagnosticBundle,
  parseDiagnosticJson,
  type DiagnosticBundle,
} from '../diagnostics/caseBundle';
import { validateDiagnosticCaseRequest, type DiagnosticCaseRequest } from './request';

const MAX_CALL_RECORDING_BYTES = 32 * 1024 * 1024;

async function exportTrainer(args: DiagnosticCaseRequest): Promise<DiagnosticBundle> {
  const session = await prisma.trainerSession.findUnique({ where: { id: args.id } });
  if (!session) throw new Error(`Training not found: ${args.id}`);
  return buildTrainerDiagnosticBundle({
    id: session.id,
    session: {
      id: session.id,
      status: session.status,
      sessionType: session.sessionType,
      scenarioId: session.scenarioId,
      companyId: session.companyId,
      branchId: session.branchId,
      title: session.title,
      difficulty: session.difficulty,
      clientType: session.clientType,
      elevenLabsConversationId: session.elevenLabsConversationId,
      score: session.score,
      baseScore: session.baseScore,
      multiplier: session.multiplier,
      finalPoints: session.finalPoints,
      durationSec: session.durationSec,
      failureReason: session.failureReason,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    },
    caseContextJson: session.caseContextJson,
    transcriptJson: session.transcriptJson,
    evaluationJson: session.evaluationJson,
    dimensionsJson: session.dimensionsJson,
    checklistResultsJson: session.checklistResultsJson,
    objectionsAnalysisJson: session.objectionsAnalysisJson,
    topRecommendationsJson: session.topRecommendationsJson,
  }, {
    includeAudio: args.includeAudio,
    turnNumber: args.turnNumber,
    release: process.env.SENTRY_RELEASE || null,
  });
}

async function readStoredCallRecording(callId: string): Promise<Buffer | null> {
  const filePath = callRecordingStorage.resolvePath(callRecordingKey(callId));
  const info = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile()) throw new Error('Stored call recording is not a regular file');
  if (info.size > MAX_CALL_RECORDING_BYTES) {
    throw new Error('Call recording exceeds 32 MiB; export metadata without --audio');
  }
  const recording = await readFile(filePath);
  if (recording.length > MAX_CALL_RECORDING_BYTES) {
    throw new Error('Call recording exceeds 32 MiB; export metadata without --audio');
  }
  return recording;
}

async function exportCall(args: DiagnosticCaseRequest): Promise<DiagnosticBundle> {
  const numericId = /^\d+$/.test(args.id) ? Number(args.id) : null;
  if (numericId !== null && !Number.isSafeInteger(numericId)) throw new Error('Call database ID is too large');
  const session = await prisma.voiceCallSession.findFirst({
    where: numericId !== null ? { id: numericId } : { callId: args.id },
  });
  if (!session) throw new Error(`Call not found: ${args.id}`);
  const planCall = await prisma.callPlanCall.findUnique({ where: { callId: session.callId } });
  const recording = args.includeAudio ? await readStoredCallRecording(session.callId) : null;
  return buildCallDiagnosticBundle({
    id: session.id,
    callId: session.callId,
    session: {
      source: session.source,
      scenario: session.scenario,
      planId: session.planId,
      dealershipId: session.dealershipId,
      managerId: session.managerId,
      attributionType: session.attributionType,
      attributionSource: session.attributionSource,
      attributionReason: session.attributionReason,
      startedAt: session.startedAt,
      connectedAt: session.connectedAt,
      endedAt: session.endedAt,
      outcome: session.outcome,
      answerTimeSec: session.answerTimeSec,
      durationSec: session.durationSec,
      talkDurationSec: session.talkDurationSec,
      totalScore: session.totalScore,
      failureReason: session.failureReason,
      ivrDetected: session.ivrDetected,
      voxSessionId: session.voxSessionId,
      recordingStatus: session.recordingStatus,
    },
    caseContextJson: session.caseContextJson,
    transcriptJson: session.transcriptJson,
    originalTranscriptJson: session.originalTranscriptJson,
    retranscriptionJson: session.retranscriptionJson,
    evaluationJson: session.evaluationJson,
    dimensionsJson: session.dimensionsJson,
    checklistResultsJson: session.checklistResultsJson,
    ivrPathJson: session.ivrPathJson,
    planCall: planCall ? {
      id: planCall.id,
      planId: planCall.planId,
      scriptId: planCall.scriptId,
      targetKind: planCall.targetKind,
      profileId: planCall.profileId,
      importedItemId: planCall.importedItemId,
      promptText: planCall.promptText,
      criteria: parseDiagnosticJson(planCall.criteriaJson),
    } : null,
  }, {
    recording,
    recordingStatus: session.recordingStatus,
    release: process.env.SENTRY_RELEASE || null,
  });
}

export async function loadDiagnosticCase(args: DiagnosticCaseRequest): Promise<DiagnosticBundle> {
  validateDiagnosticCaseRequest(args);
  return args.kind === 'trainer' ? exportTrainer(args) : exportCall(args);
}
