import { CACHE_TTL_MS, DAY_MS, NS_WINDOW_DAYS, TRAINED_SHARE, dayKey, dayStart, mean, ratio, unique } from './config';
import { loadActivitySources } from './sources';
import { inScope } from './scope';
import { computeBranchGrowth } from './northStar';
import { reportUsage, roleBlock, sectionUsage, withTrainingActivity } from './people';
import { trainerMetrics } from './trainer';
import { callMetrics } from './calls';
import { activityStatus, buildActivityTable } from './table';
import type { ActivityResponse, Scope, Sources } from './types';
export function computeActivity(data: Sources, scope: Scope, now = new Date()): ActivityResponse {
  const end = new Date(dayStart(now).getTime() + DAY_MS);
  const start = new Date(end.getTime() - scope.period * DAY_MS);
  const previousStart = new Date(start.getTime() - scope.period * DAY_MS);
  const companies = data.companies.filter(item => !scope.companyId || item.id === scope.companyId);
  const branches = data.branches.filter(item => (!scope.companyId || item.companyId === scope.companyId) && (!scope.branchId || item.id === scope.branchId));
  const scoped: Sources = { ...data, companies, branches, people: data.people.filter(item => inScope(item, scope)), employees: data.employees.filter(item => inScope(item, scope)), lastActions: data.lastActions.filter(item => inScope(item, scope)) };
  const events = withTrainingActivity(data.events.filter(item => inScope(item, scope)), data.trainings.filter(item => inScope(item, scope)));
  const slice = (from: Date, until: Date) => {
    const selectedEvents = events.filter(item => item.date >= dayKey(from) && item.date < dayKey(until));
    const trainings = data.trainings.filter(item => inScope(item, scope) && item.startedAt >= from && item.startedAt < until);
    const calls = data.calls.filter(item => inScope(item, scope) && item.startedAt >= from && item.startedAt < until);
    const people = scoped.people.filter(item => item.createdAt < until);
    const leaders = roleBlock(selectedEvents, people, scope.period, false), employees = roleBlock(selectedEvents, people, scope.period, true);
    const growth = computeBranchGrowth(branches.filter(item => item.createdAt < until).map(item => item.id), until, data.calls);
    const ns = mean(growth.flatMap(item => item.value === null ? [] : [item.value]));
    const activeEntities = unique(selectedEvents.flatMap(item => scope.companyId ? item.branchId ? [item.branchId] : [] : [item.companyId]));
    const callStats = callMetrics(calls, branches.filter(item => item.createdAt < until), companies);
    return { events: selectedEvents, trainings, calls, leaders, employees, growth, ns, activeEntities, callStats };
  };
  const current = slice(start, end), previous = slice(previousStart, start);
  const delta = (value: number | null, before: number | null) => value === null || before === null ? null : value - before;
  const bucketDays = scope.period === 90 ? 7 : 1;
  const daily = Array.from({ length: Math.ceil(scope.period / bucketDays) }, (_, i) => {
    const from = new Date(start.getTime() + i * bucketDays * DAY_MS), until = new Date(Math.min(end.getTime(), from.getTime() + bucketDays * DAY_MS));
    const rows = current.events.filter(item => item.date >= dayKey(from) && item.date < dayKey(until));
    return { date: dayKey(from), leaders: unique(rows.filter(item => item.role !== 'employee').map(item => item.accountId)), employees: unique(rows.filter(item => item.role === 'employee').map(item => item.accountId)) };
  });
  const groups = { improved: 0, flat: 0, declined: 0, insufficient: 0 };
  const everChecked = new Set(data.calls.filter(item => item.outcome === 'completed' && item.score !== null && item.startedAt < end).map(item => item.branchId));
  current.growth.filter(item => everChecked.has(item.branchId)).forEach(item => groups[item.group]++);
  const trainingStart = new Date(end.getTime() - NS_WINDOW_DAYS * DAY_MS);
  const trainedByBranch = new Map<string, Set<string>>();
  for (const item of data.trainings) {
    if (item.status !== 'completed' || !item.completedAt || item.completedAt < trainingStart || item.completedAt >= end || !item.branchId)
      continue;
    const set = trainedByBranch.get(item.branchId) ?? new Set<string>();
    set.add(item.accountId);
    trainedByBranch.set(item.branchId, set);
  }
  const employeesByBranch = new Map<string, Set<string>>();
  for (const item of scoped.people.filter(item => item.role === 'employee')) {
    if (!item.branchId)
      continue;
    const set = employeesByBranch.get(item.branchId) ?? new Set<string>();
    set.add(item.accountId);
    employeesByBranch.set(item.branchId, set);
  }
  const trained: number[] = [], notTrained: number[] = [];
  for (const item of current.growth) {
    if (item.value === null)
      continue;
    const total = employeesByBranch.get(item.branchId)?.size ?? 0;
    const count = trainedByBranch.get(item.branchId)?.size ?? 0;
    (total > 0 && count / total >= TRAINED_SHARE ? trained : notTrained).push(item.value);
  }
  const nsGroup = (items: number[]) => ({ value: mean(items), state: items.length ? 'ok' as const : 'insufficient' as const, branches: items.length });
  const table = buildActivityTable(scoped, current.events, current.calls, current.trainings, current.growth, scope.companyId, now);
  const status = table.rows[0];
  return {
    generatedAt: now.toISOString(), periodDays: scope.period,
    scope: { view: scope.branchId ? 'branch' : scope.companyId ? 'company' : 'all', companyId: scope.companyId, branchId: scope.branchId },
    filters: { companies: data.companies.map(({ id, name }) => ({ id, name })), branches: data.branches.filter(item => item.companyId === scope.companyId).map(({ id, name, companyId }) => ({ id, name, companyId })) },
    kpis: {
      activeEntities: scope.branchId ? null : { value: current.activeEntities, total: (scope.companyId ? branches : companies).filter(item => item.createdAt < end).length, delta: current.activeEntities - previous.activeEntities },
      branchStatus: scope.branchId ? { status: status?.status ?? activityStatus(null, now), lastActionAt: status?.lastActionAt ?? null } : null,
      activeLeaders: { value: current.leaders.active, total: current.leaders.total, delta: current.leaders.active - previous.leaders.active },
      activeEmployees: { value: current.employees.active, total: current.employees.total, delta: current.employees.active - previous.employees.active },
      answerRate: { connected: current.callStats.funnel.connected, launched: current.callStats.funnel.launched, rate: ratio(current.callStats.funnel.connected, current.callStats.funnel.launched), deltaPp: delta(ratio(current.callStats.funnel.connected, current.callStats.funnel.launched), ratio(previous.callStats.funnel.connected, previous.callStats.funnel.launched)) },
      northStar: { value: current.ns, delta: delta(current.ns, previous.ns), branchesWithData: current.growth.filter(item => item.value !== null).length },
    },
    dailyActive: { granularity: bucketDays === 7 ? 'week' : 'day', points: daily }, table,
    roles: { leaders: current.leaders, employees: { ...current.employees, reports: reportUsage(current.events) } },
    trainer: trainerMetrics(current.trainings, data.plans.filter(item => inScope(item, scope) && item.date >= dayKey(start) && item.date < dayKey(end)), data.streaks, current.events, now),
    calls: current.callStats,
    value: { groups, series: daily.map((item, i) => ({ date: item.date, value: mean(computeBranchGrowth(branches.map(branch => branch.id), new Date(Math.min(start.getTime() + (i + 1) * bucketDays * DAY_MS, end.getTime())), data.calls).flatMap(item => item.value === null ? [] : [item.value])) })), trainedVsNot: { trained: nsGroup(trained), notTrained: nsGroup(notTrained) } },
    sections: { leaders: sectionUsage(current.events, false), employees: sectionUsage(current.events, true) },
  };
}
const cache = new Map<string, {
  expires: number;
  value?: ActivityResponse;
  pending?: Promise<ActivityResponse>;
}>();
export function clearActivityCache() { cache.clear(); }
export async function getInternalActivityAnalytics(input: Scope | 7 | 30 | 90): Promise<ActivityResponse> {
  const scope: Scope = typeof input === 'number' ? { period: input, companyId: null, branchId: null } : input;
  const now = new Date(), key = `${dayKey(now)}:${scope.period}:${scope.companyId ?? ''}:${scope.branchId ?? ''}`;
  const existing = cache.get(key);
  if (existing && existing.expires > now.getTime()) {
    if (existing.value)
      return existing.value;
    if (existing.pending)
      return existing.pending;
  }
  const pending = (async () => {
    const from = new Date(dayStart(now).getTime() - (scope.period * 2 + NS_WINDOW_DAYS) * DAY_MS);
    return computeActivity(await loadActivitySources(scope, from, now), scope, now);
  })();
  cache.set(key, { expires: now.getTime() + CACHE_TTL_MS, pending });
  try {
    const value = await pending;
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
    return value;
  }
  catch (error) {
    cache.delete(key);
    throw error;
  }
  finally {
    for (const [id, entry] of cache)
      if (entry.expires < Date.now())
        cache.delete(id);
    if (cache.size > 100)
      cache.delete(cache.keys().next().value!);
  }
}
