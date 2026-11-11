import { mean, unique } from './config';
import type { ActivityResponse, Branch, Call, Company } from './types';
export function callMetrics(calls: Call[], branches: Branch[], companies: Company[]): ActivityResponse['calls'] {
  const talked = calls.filter(item => item.outcome === 'completed');
  const evaluated = talked.filter(item => item.score !== null).length;
  const planned = new Set(companies.filter(item => item.hasCallPlan).map(item => item.id));
  const called = new Set(calls.map(item => item.branchId));
  return {
    funnel: { launched: calls.length, connected: calls.filter(item => item.connectedAt !== null).length, talked: talked.length, evaluated },
    outcomes: { completed: talked.length, disconnected: calls.filter(item => item.outcome === 'disconnected').length, no_answer: calls.filter(item => item.outcome === 'no_answer').length, busy: calls.filter(item => item.outcome === 'busy').length, failed: calls.filter(item => item.outcome === 'failed').length },
    avgTalkSec: mean(talked.flatMap(item => item.talkDurationSec ?? item.durationSec ?? [])),
    branchesWithoutCalls: unique(branches.filter(item => planned.has(item.companyId) && !called.has(item.id)).map(item => item.id)),
    notEvaluated: talked.length - evaluated,
  };
}
