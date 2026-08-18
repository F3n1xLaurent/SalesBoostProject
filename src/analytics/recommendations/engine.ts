import {
  CHECKLIST_PROBLEM_WEIGHTS,
  LAGGING_SCORE_DELTA,
  MIN_ANSWERED_CALLS,
  MIN_CHECKLIST_CALLS,
  MIN_ENTITY_EVALUATED_CALLS,
  MIN_LAGGING_CALLS,
  MIN_MISSED_CALL_ATTEMPTS,
  MIN_MISSED_REGULAR_DAYS,
  MIN_SLOW_ANSWER_CONSECUTIVE_DAYS,
  MIN_SOURCE_CALLS,
  MIN_TREND_CALLS_PER_PERIOD,
  MISSED_RATE_EXCESS_PERCENT,
  OPERATIONAL_BASE_IMPORTANCE,
  PHONE_OWNERSHIP_NORMS,
  SIGNIFICANT_PROBLEM_SHARE,
  SOURCE_SCORE_DELTA,
  SYSTEMIC_ENTITY_SHARE,
  TREND_SCORE_DROP,
  checklistProblemValue,
  normalizeChecklistProblemCode,
  type ChecklistProblemCode,
  type ChecklistResultStatus,
} from './rules';

export type RecommendationCall = {
  id: string | number;
  startedAt: Date;
  score: number | null;
  outcome: string | null;
  answerTimeSec: number | null;
  phoneNumberTypeId: string | null;
  phoneNumberTypeName: string | null;
  phoneNumberOwnership: 'dealership' | 'user' | null;
  phoneNumberId?: string | null;
  phoneNumber?: string | null;
  checklist: Array<{ code: string; status: string }>;
};

export type RecommendationChild = { id: string; name: string; accountId?: string | null; calls: RecommendationCall[] };
export type RecommendationSignalKind = 'checklist' | 'lagging' | 'trend' | 'source' | 'missed' | 'answer_speed';
export type RecommendationSignal = {
  id: string;
  kind: RecommendationSignalKind;
  scope: 'quick' | 'systemic';
  importance: number;
  entityId?: string;
  entityName?: string;
  entityAccountId?: string;
  problemCode?: ChecklistProblemCode;
  sourceTypeId?: string;
  sourceName?: string;
  phoneNumberId?: string;
  phoneNumber?: string;
  ownership?: 'dealership' | 'user';
  metrics: Record<string, number>;
};

export type RecommendationResult = {
  state: 'insufficient_data' | 'normal' | 'findings';
  evaluatedCalls: number;
  minimumCalls: number;
  quick: RecommendationSignal[];
  systemic: RecommendationSignal[];
  growthPoint: RecommendationSignal | null;
};

const DAY_MS = 86_400_000;
const missedOutcomes = new Set(['no_answer', 'busy', 'failed']);
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const evaluated = (calls: RecommendationCall[]) => calls.filter((call) => call.score !== null);
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

function inWindow(call: RecommendationCall, from: Date, to: Date): boolean {
  return call.startedAt >= from && call.startedAt <= to;
}

function checklistCandidates(calls: RecommendationCall[], children: RecommendationChild[]): { significant: RecommendationSignal[]; growth: RecommendationSignal | null } {
  const values = new Map<ChecklistProblemCode, number[]>();
  for (const call of evaluated(calls)) {
    for (const item of call.checklist) {
      const code = normalizeChecklistProblemCode(String(item.code || '').toUpperCase());
      const status = String(item.status || '').toUpperCase() as ChecklistResultStatus;
      if (!code || !['YES', 'PARTIAL', 'NO'].includes(status)) continue;
      const bucket = values.get(code) ?? [];
      bucket.push(checklistProblemValue(status));
      values.set(code, bucket);
    }
  }
  const all: RecommendationSignal[] = [];
  for (const [problemCode, samples] of values) {
    if (samples.length < MIN_CHECKLIST_CALLS) continue;
    const problemShare = average(samples) ?? 0;
    const eligibleChildren = children.flatMap((child) => {
      const statuses = evaluated(child.calls).flatMap((call) => call.checklist)
        .filter((item) => normalizeChecklistProblemCode(String(item.code || '').toUpperCase()) === problemCode)
        .map((item) => checklistProblemValue(String(item.status).toUpperCase() as ChecklistResultStatus));
      return statuses.length >= MIN_CHECKLIST_CALLS ? [{ child, problemShare: average(statuses) ?? 0, calls: statuses.length }] : [];
    });
    const affectedChildren = eligibleChildren.filter((item) => item.problemShare >= SIGNIFICANT_PROBLEM_SHARE);
    const systemicShare = children.length ? affectedChildren.length / children.length : 0;
    const scope = systemicShare >= SYSTEMIC_ENTITY_SHARE ? 'systemic' : 'quick';
    const localized = affectedChildren.sort((a, b) => b.problemShare * b.calls - a.problemShare * a.calls)[0];
    all.push({
      id: `checklist:${problemCode}`,
      kind: 'checklist',
      scope,
      importance: round(CHECKLIST_PROBLEM_WEIGHTS[problemCode] * problemShare),
      problemCode,
      ...(scope === 'quick' && localized ? { entityId: localized.child.id, entityName: localized.child.name, ...(localized.child.accountId ? { entityAccountId: localized.child.accountId } : {}) } : {}),
      metrics: { activeCalls: samples.length, problemShare: round(problemShare * 100), localizedProblemShare: localized ? round(localized.problemShare * 100) : 0, affectedChildren: affectedChildren.length, eligibleChildren: eligibleChildren.length, totalChildren: children.length, systemicShare: round(systemicShare * 100) },
    });
  }
  const ordered = all.sort((a, b) => b.importance - a.importance);
  return {
    significant: ordered.filter((item) => item.metrics.problemShare >= SIGNIFICANT_PROBLEM_SHARE * 100),
    growth: ordered.find((item) => item.metrics.problemShare < SIGNIFICANT_PROBLEM_SHARE * 100) ?? null,
  };
}

function laggingCandidates(calls: RecommendationCall[], children: RecommendationChild[]): RecommendationSignal[] {
  const groupScores = evaluated(calls).map((call) => call.score as number);
  const groupAverage = average(groupScores);
  if (groupAverage === null) return [];
  return children.flatMap((child) => {
    const scores = evaluated(child.calls).map((call) => call.score as number);
    if (scores.length < MIN_LAGGING_CALLS) return [];
    const childAverage = average(scores) as number;
    const delta = groupAverage - childAverage;
    if (delta < LAGGING_SCORE_DELTA) return [];
    return [{
      id: `lagging:${child.id}`,
      kind: 'lagging' as const,
      scope: 'quick' as const,
      importance: round(delta * (scores.length / groupScores.length)),
      entityId: child.id,
      entityName: child.name,
      metrics: { score: round(childAverage), groupScore: round(groupAverage), delta: round(delta), calls: scores.length, callShare: round(scores.length / groupScores.length * 100) },
    }];
  });
}

function trendCandidate(calls: RecommendationCall[], now: Date): RecommendationSignal[] {
  const currentStart = new Date(now.getTime() - 30 * DAY_MS);
  const previousStart = new Date(now.getTime() - 60 * DAY_MS);
  const current = evaluated(calls).filter((call) => inWindow(call, currentStart, now)).map((call) => call.score as number);
  const previous = evaluated(calls).filter((call) => call.startedAt >= previousStart && call.startedAt < currentStart).map((call) => call.score as number);
  if (current.length < MIN_TREND_CALLS_PER_PERIOD || previous.length < MIN_TREND_CALLS_PER_PERIOD) return [];
  const currentScore = average(current) as number;
  const previousScore = average(previous) as number;
  const drop = previousScore - currentScore;
  if (drop < TREND_SCORE_DROP) return [];
  return [{ id: 'trend', kind: 'trend', scope: 'systemic', importance: round(drop), metrics: { currentScore: round(currentScore), previousScore: round(previousScore), drop: round(drop) } }];
}

function sourceCandidates(calls: RecommendationCall[], children: RecommendationChild[], parentCalls: RecommendationCall[]): RecommendationSignal[] {
  const scored = evaluated(calls).filter((call) => call.phoneNumberTypeId);
  const ids = [...new Set(scored.map((call) => call.phoneNumberTypeId as string))];
  return ids.flatMap((id) => {
    const source = scored.filter((call) => call.phoneNumberTypeId === id);
    const rest = scored.filter((call) => call.phoneNumberTypeId !== id);
    if (source.length < MIN_SOURCE_CALLS || rest.length === 0) return [];
    const sourceScore = average(source.map((call) => call.score as number)) as number;
    const restScore = average(rest.map((call) => call.score as number)) as number;
    const delta = restScore - sourceScore;
    if (delta < SOURCE_SCORE_DELTA) return [];
    const eligibleChildren = children.flatMap((child) => {
      const childScored = evaluated(child.calls);
      const childSource = childScored.filter((call) => call.phoneNumberTypeId === id);
      const childRest = childScored.filter((call) => call.phoneNumberTypeId !== id);
      if (childSource.length < MIN_SOURCE_CALLS || childRest.length === 0) return [];
      const childDelta = (average(childRest.map((call) => call.score as number)) as number) - (average(childSource.map((call) => call.score as number)) as number);
      return [{ child, delta: childDelta, calls: childSource.length }];
    });
    const affectedChildren = eligibleChildren.filter((item) => item.delta >= SOURCE_SCORE_DELTA);
    const systemicShare = children.length ? affectedChildren.length / children.length : 0;
    const scope = systemicShare >= SYSTEMIC_ENTITY_SHARE ? 'systemic' : 'quick';
    let comparisonScore = restScore;
    let comparisonDelta = delta;
    if (scope === 'systemic' && parentCalls.length) {
      const parentScored = evaluated(parentCalls);
      const parentSource = parentScored.filter((call) => call.phoneNumberTypeId === id);
      const parentRest = parentScored.filter((call) => call.phoneNumberTypeId !== id);
      if (parentSource.length < MIN_SOURCE_CALLS || parentRest.length === 0) return [];
      const parentSourceScore = average(parentSource.map((call) => call.score as number)) as number;
      comparisonScore = average(parentRest.map((call) => call.score as number)) as number;
      comparisonDelta = comparisonScore - parentSourceScore;
      if (comparisonDelta < SOURCE_SCORE_DELTA) return [];
    }
    const localized = affectedChildren.sort((a, b) => b.delta * b.calls - a.delta * a.calls)[0];
    return [{
      id: `source:${id}`,
      kind: 'source' as const,
      scope,
      importance: round(comparisonDelta * source.length / scored.length),
      sourceTypeId: id,
      sourceName: source[0].phoneNumberTypeName ?? id,
      ...(scope === 'quick' && localized ? { entityId: localized.child.id, entityName: localized.child.name, ...(localized.child.accountId ? { entityAccountId: localized.child.accountId } : {}) } : {}),
      metrics: { score: round(sourceScore), otherScore: round(comparisonScore), delta: round(comparisonDelta), calls: source.length, callShare: round(source.length / scored.length * 100), affectedChildren: affectedChildren.length, eligibleChildren: eligibleChildren.length, systemicShare: round(systemicShare * 100), higherLevelBenchmark: scope === 'systemic' && parentCalls.length ? 1 : 0 },
    }];
  });
}

function hasConsecutiveDays(keys: string[], minimum: number): boolean {
  const times = [...new Set(keys)].map((key) => Date.parse(`${key}T00:00:00.000Z`)).sort((a, b) => a - b);
  let run = 1;
  for (let index = 1; index < times.length; index += 1) {
    run = times[index] - times[index - 1] === DAY_MS ? run + 1 : 1;
    if (run >= minimum) return true;
  }
  return times.length > 0 && minimum <= 1;
}

function missedMetrics(calls: RecommendationCall[], ownership: 'dealership' | 'user', now: Date) {
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  if (calls.length < MIN_MISSED_CALL_ATTEMPTS) return null;
  const allowedMissedRate = 100 - PHONE_OWNERSHIP_NORMS[ownership].minimumAnswerRate;
  const missedRate = calls.filter((call) => missedOutcomes.has(String(call.outcome))).length / calls.length * 100;
  const excess = missedRate - allowedMissedRate;
  const recentByDay = new Map<string, RecommendationCall[]>();
  for (const call of calls.filter((item) => inWindow(item, sevenDaysAgo, now))) {
    const key = dayKey(call.startedAt);
    recentByDay.set(key, [...(recentByDay.get(key) ?? []), call]);
  }
  const badDays = [...recentByDay].filter(([, dayCalls]) => dayCalls.filter((call) => missedOutcomes.has(String(call.outcome))).length / dayCalls.length * 100 > allowedMissedRate).length;
  if (excess < MISSED_RATE_EXCESS_PERCENT || badDays < MIN_MISSED_REGULAR_DAYS) return null;
  return { importance: round(OPERATIONAL_BASE_IMPORTANCE + excess), metrics: { attempts: calls.length, missedRate: round(missedRate), allowedMissedRate, excess: round(excess), badDays } };
}

function answerSpeedMetrics(calls: RecommendationCall[], ownership: 'dealership' | 'user', now: Date) {
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const answered = calls.filter((call) => call.answerTimeSec !== null && !missedOutcomes.has(String(call.outcome)));
  if (answered.length < MIN_ANSWERED_CALLS) return null;
  const maximumAnswerTimeSec = PHONE_OWNERSHIP_NORMS[ownership].maximumAnswerTimeSec;
  const answerTime = average(answered.map((call) => call.answerTimeSec as number)) as number;
  const excess = answerTime - maximumAnswerTimeSec;
  const badDayKeys = [...new Set(answered.filter((call) => inWindow(call, sevenDaysAgo, now)).map((call) => dayKey(call.startedAt)))]
    .filter((key) => (average(answered.filter((call) => dayKey(call.startedAt) === key).map((call) => call.answerTimeSec as number)) ?? 0) > maximumAnswerTimeSec);
  if (excess <= 0 || !hasConsecutiveDays(badDayKeys, MIN_SLOW_ANSWER_CONSECUTIVE_DAYS)) return null;
  return { importance: round(OPERATIONAL_BASE_IMPORTANCE + excess / 5), metrics: { answeredCalls: answered.length, answerTimeSec: round(answerTime), maximumAnswerTimeSec, excessSec: round(excess), badDays: badDayKeys.length } };
}

function operationalCandidates(calls: RecommendationCall[], children: RecommendationChild[], now: Date): RecommendationSignal[] {
  const groups = new Map<string, RecommendationCall[]>();
  for (const call of calls) {
    if (!call.phoneNumberOwnership) continue;
    const key = call.phoneNumberOwnership;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  return [...groups].flatMap(([key, groupCalls]) => {
    const ownership = groupCalls[0].phoneNumberOwnership as 'dealership' | 'user';
    const definitions = [
      { kind: 'missed' as const, calculate: missedMetrics },
      { kind: 'answer_speed' as const, calculate: answerSpeedMetrics },
    ];
    return definitions.flatMap(({ kind, calculate }) => {
      const aggregate = calculate(groupCalls, ownership, now);
      if (!aggregate) return [];
      const eligibleChildren = children.flatMap((child) => {
        const childCalls = child.calls.filter((call) => call.phoneNumberOwnership === ownership);
        const metrics = calculate(childCalls, ownership, now);
        return metrics ? [{ child, ...metrics }] : [];
      });
      const systemicShare = children.length ? eligibleChildren.length / children.length : 0;
      const scope = systemicShare >= SYSTEMIC_ENTITY_SHARE ? 'systemic' : 'quick';
      const localized = eligibleChildren.sort((a, b) => b.importance - a.importance)[0];
      const typeGroups = new Map<string, RecommendationCall[]>();
      for (const call of groupCalls) {
        if (call.phoneNumberTypeId) typeGroups.set(call.phoneNumberTypeId, [...(typeGroups.get(call.phoneNumberTypeId) ?? []), call]);
      }
      const focus = [...typeGroups].flatMap(([typeId, typeCalls]) => {
        const focusMetrics = calculate(typeCalls, ownership, now);
        return focusMetrics ? [{ typeId, typeCalls, ...focusMetrics }] : [];
      }).sort((a, b) => b.importance - a.importance)[0];
      const soleType = typeGroups.size === 1 ? [...typeGroups][0] : null;
      const focusedCalls = focus?.typeCalls ?? soleType?.[1] ?? groupCalls;
      const sourceTypeId = focus?.typeId ?? soleType?.[0];
      const sourceName = focusedCalls[0]?.phoneNumberTypeName ?? undefined;
      const uniquePhoneIds = [...new Set(focusedCalls.map((call) => call.phoneNumberId).filter((id): id is string => Boolean(id)))];
      const uniquePhones = [...new Set(focusedCalls.map((call) => call.phoneNumber).filter((phone): phone is string => Boolean(phone)))];
      return [{
        id: `${kind}:${ownership}`, kind, scope, ownership, sourceTypeId, sourceName,
        ...(uniquePhoneIds.length === 1 ? { phoneNumberId: uniquePhoneIds[0] } : {}),
        ...(uniquePhones.length === 1 ? { phoneNumber: uniquePhones[0] } : {}),
        ...(scope === 'quick' && localized ? { entityId: localized.child.id, entityName: localized.child.name, ...(localized.child.accountId ? { entityAccountId: localized.child.accountId } : {}) } : {}),
        importance: aggregate.importance,
        metrics: { ...aggregate.metrics, affectedChildren: eligibleChildren.length, totalChildren: children.length, systemicShare: round(systemicShare * 100) },
      }];
    });
  });
}

export function calculateRecommendations(input: { calls: RecommendationCall[]; children?: RecommendationChild[]; parentCalls?: RecommendationCall[]; now?: Date }): RecommendationResult {
  const now = input.now ?? new Date();
  const currentStart = new Date(now.getTime() - 30 * DAY_MS);
  const currentCalls = input.calls.filter((call) => inWindow(call, currentStart, now));
  const currentChildren = (input.children ?? []).map((child) => ({ ...child, calls: child.calls.filter((call) => inWindow(call, currentStart, now)) }));
  const evaluatedCalls = evaluated(currentCalls).length;
  const checklist = checklistCandidates(currentCalls, currentChildren);
  const candidates = [
    ...checklist.significant,
    ...laggingCandidates(currentCalls, currentChildren),
    ...trendCandidate(input.calls, now),
    ...sourceCandidates(currentCalls, currentChildren, (input.parentCalls ?? []).filter((call) => inWindow(call, currentStart, now))),
    ...operationalCandidates(currentCalls, currentChildren, now),
  ];
  if (evaluatedCalls < MIN_ENTITY_EVALUATED_CALLS && candidates.length === 0) {
    return { state: 'insufficient_data', evaluatedCalls, minimumCalls: MIN_ENTITY_EVALUATED_CALLS, quick: [], systemic: [], growthPoint: null };
  }
  const quick = candidates.filter((item) => item.scope === 'quick').sort((a, b) => b.importance - a.importance).slice(0, 3);
  const systemic = candidates.filter((item) => item.scope === 'systemic').sort((a, b) => b.importance - a.importance).slice(0, 2);
  return {
    state: quick.length || systemic.length ? 'findings' : 'normal',
    evaluatedCalls,
    minimumCalls: MIN_ENTITY_EVALUATED_CALLS,
    quick,
    systemic,
    growthPoint: quick.length || systemic.length ? null : checklist.growth,
  };
}
