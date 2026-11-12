import type { Prisma } from '@prisma/client';

export type TrainerSimulationRow = Prisma.TrainerSessionGetPayload<{ include: { scenario: { select: { id: true; name: true } } } }>;
export function createBuiltinTrainerSimulationRow(id: string, context: Record<string, unknown>): TrainerSimulationRow {
  const scenario = context.scenario as { id: string; name: string };
  const now = new Date();
  return { id, employeeId: 'autotest-fixture', branchId: null, companyId: null, sessionType: 'free', scenarioId: scenario.id, scenario: { id: scenario.id, name: scenario.name },
    title: null, status: 'in_progress', difficulty: 'medium', clientType: String(context.clientType || ''), elevenLabsConversationId: null,
    caseContextJson: JSON.stringify(context), transcriptJson: '[]', evaluationJson: null, reportCheckpointJson: null, dimensionsJson: null, checklistResultsJson: null,
    objectionsAnalysisJson: null, topRecommendationsJson: null, score: null, baseScore: null, multiplier: 1, finalPoints: null, durationSec: 0, failureReason: null,
    startedAt: now, completedAt: null, createdAt: now, updatedAt: now };
}
/** No Prisma writes, scoring, daily-plan changes or normal report scheduling. */
export class TrainerSimulationStore {
  closed = false;
  readonly voices: Array<{ provider: string; voiceId: string | null; spokenText: string }> = [];
  observeVoice = (event: { provider: string; voiceId: string | null; spokenText: string }) => { this.voices.push(event); };
  constructor(public row: TrainerSimulationRow, readonly signal: AbortSignal) {}
  async load() { this.signal.throwIfAborted(); return this.row; }
  async update(data: Prisma.TrainerSessionUpdateInput) {
    this.signal.throwIfAborted();
    if (this.closed) throw new Error('Тестовая сессия закрыта.');
    this.row = { ...this.row, ...data } as TrainerSimulationRow;
    return this.row;
  }
}
