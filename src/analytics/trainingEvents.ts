import { prisma } from '../db';
import { recordProductEvent, type ProductEventName, type ProductEventProperty } from './productAnalytics';
export function recordTrainingEvent(sessionId: string, eventName: Extract<ProductEventName, `training_${string}`>, extra: Record<string, ProductEventProperty> = {}): void {
  void (async () => {
    const session = await prisma.trainerSession.findUnique({ where: { id: sessionId }, include: { employee: { select: { accountId: true } }, scenario: { select: { name: true } } } });
    if (!session)
      return;
    await recordProductEvent({ eventName, accountId: session.employee.accountId, role: 'employee', companyId: session.companyId, branchId: session.branchId, employeeId: session.employeeId, targetType: 'trainer_session', targetId: session.id, deduplicationKey: `${eventName}:${session.id}`, occurredAt: eventName === 'training_started' ? session.startedAt : session.completedAt ?? new Date(), properties: { session_id: session.id, session_type: session.sessionType, scenario_id: session.scenarioId, scenario_name: session.scenario?.name ?? null, difficulty: session.difficulty, client_type: session.clientType, result: session.status === 'completed' ? 'completed' : 'fail_case', fail_reason: session.failureReason, score: session.score, duration_sec: session.durationSec, points: session.finalPoints, turns_count: turnCount(session.transcriptJson), ...extra } });
  })().catch(error => console.warn('[analytics] training event failed', error instanceof Error ? error.message : error));
}
function turnCount(raw: string) {
  try {
    const turns = JSON.parse(raw);
    return Array.isArray(turns) ? turns.length : 0;
  }
  catch {
    return 0;
  }
}
