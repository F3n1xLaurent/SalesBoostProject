import { prisma } from '../db';

function json(value: string | null | undefined, fallback: unknown): any {
  try { return JSON.parse(value ?? '') ?? fallback; } catch { return fallback; }
}

/** Use the call's frozen facts, never today's edited script/profile. Put
 * assessment facts first so downstream context limits do not discard them. */
export async function loadCallReportScenarioContext(callId: string, caseContextJson: string | null): Promise<string | undefined> {
  const context = json(caseContextJson, {});
  if (typeof context.prompt === 'string' && context.prompt.trim() && Array.isArray(context.criteria)) {
    return JSON.stringify({ assessmentCriteria: context.criteria, scenario: context.prompt });
  }
  const snapshot = await prisma.callPlanCall.findUnique({ where: { callId }, select: { promptText: true, criteriaJson: true } });
  const prompt = snapshot?.promptText?.trim() || (typeof context.prompt === 'string' ? context.prompt.trim() : '');
  const criteria = snapshot ? json(snapshot.criteriaJson, []) : context.criteria;
  if (!prompt && (!Array.isArray(criteria) || criteria.length === 0)) return undefined;
  return JSON.stringify({ assessmentCriteria: Array.isArray(criteria) ? criteria : [], scenario: prompt });
}
