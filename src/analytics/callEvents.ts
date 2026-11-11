import { prisma } from '../db';
import { recordProductEvent, type ProductEventName, type ProductEventProperty } from './productAnalytics';
export function recordCallEvent(callId: string, eventName: Extract<ProductEventName, `call_${string}`>, extra: Record<string, ProductEventProperty> = {}, occurredAt?: Date): void {
  void (async () => {
    const call = await prisma.voiceCallSession.findUnique({ where: { callId }, select: { source: true, startedAt: true, endedAt: true, outcome: true, connectedAt: true, answerTimeSec: true, talkDurationSec: true, durationSec: true, totalScore: true, evaluationJson: true, managerId: true, dealershipId: true, planId: true, caseContextJson: true, manager: { select: { accountId: true } }, dealership: { select: { holdingId: true } }, plan: { select: { scriptId: true } } } });
    if (!call || call.source === 'demo')
      return;
    let scriptId = call.plan?.scriptId ?? null;
    if (!scriptId)
      try {
        const context = JSON.parse(call.caseContextJson ?? '{}');
        scriptId = typeof context.scriptId === 'string' ? context.scriptId : null;
      }
      catch { }
    const script = scriptId ? await prisma.callScript.findUnique({ where: { id: scriptId }, select: { name: true } }) : null;
    await recordProductEvent({ eventName, accountId: call.manager?.accountId, role: call.managerId ? 'employee' : null, companyId: call.dealership?.holdingId, branchId: call.dealershipId, employeeId: call.managerId, targetType: 'voice_call', targetId: callId, occurredAt: occurredAt ?? (eventName === 'call_attempted' ? call.startedAt : call.endedAt ?? new Date()), deduplicationKey: `${eventName}:${callId}:${String(extra.failure_stage ?? 'ready')}`, properties: { call_id: callId, call_source: call.source, plan_id: call.planId, script_id: scriptId, script_name: script?.name ?? null, phone_scope: call.managerId ? 'employee' : 'branch', outcome: call.outcome, connected: !!call.connectedAt, answer_time_sec: call.answerTimeSec, talk_duration_sec: call.talkDurationSec ?? call.durationSec, attribution_type: call.managerId ? 'employee' : 'branch', score: call.totalScore, has_recommendations: hasRecommendations(call.evaluationJson), ...extra } });
  })().catch(error => console.warn('[analytics] call event failed:', error instanceof Error ? error.message : error));
}
function hasRecommendations(raw: string | null) {
  try {
    const value = JSON.parse(raw ?? '{}');
    return (value.unified_call_report?.recommendations ?? value.recommendations ?? []).length > 0;
  }
  catch {
    return false;
  }
}
