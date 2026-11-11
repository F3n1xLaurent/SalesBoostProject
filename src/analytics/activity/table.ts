import { DAY_MS, dayStart, mean, ratio, unique } from './config';
import type { ActivityResponse, Call, Event, Sources, Status, Training } from './types';
import type { BranchGrowth } from './northStar';
export function activityStatus(last: Date | null, now: Date): Status {
  if (!last)
    return 'not_started';
  const days = Math.floor((dayStart(now).getTime() - dayStart(last).getTime()) / DAY_MS);
  return days <= 7 ? 'active' : days <= 14 ? 'fading' : 'inactive';
}
export function buildActivityTable(data: Sources, events: Event[], calls: Call[], trainings: Training[], growth: BranchGrowth[], companyId: string | null, now: Date): ActivityResponse['table'] {
  const entities = companyId ? data.branches : data.companies;
  type Bucket = {
    leaders: Set<string>;
    employees: Set<string>;
    calls: number;
    connected: number;
    trainings: number;
    last: Date | null;
    scores: number[];
    branches: number;
    total: Set<string>;
  };
  const buckets = new Map<string, Bucket>(entities.map(item => [item.id, { leaders: new Set(), employees: new Set(), calls: 0, connected: 0, trainings: 0, last: null, scores: [], branches: 0, total: new Set() }]));
  const key = (item: {
    companyId: string;
    branchId?: string | null;
  }) => companyId ? item.branchId : item.companyId;
  for (const item of events) {
    const b = buckets.get(key(item) ?? '');
    if (b)
      (item.role === 'employee' ? b.employees : b.leaders).add(item.accountId);
  }
  for (const item of calls) {
    const b = buckets.get(key(item) ?? '');
    if (b) {
      b.calls++;
      if (item.connectedAt)
        b.connected++;
    }
  }
  for (const item of trainings) {
    const b = buckets.get(key(item) ?? '');
    if (b)
      b.trainings++;
  }
  for (const item of data.lastActions) {
    const b = buckets.get(key(item) ?? '');
    if (b && (!b.last || b.last < item.at))
      b.last = item.at;
  }
  for (const item of data.branches) {
    const b = buckets.get(companyId ? item.id : item.companyId);
    if (b)
      b.branches++;
  }
  for (const item of data.people) {
    const b = buckets.get(key(item) ?? '');
    if (b && item.role === 'employee')
      b.total.add(item.accountId);
  }
  const branchCompanies = new Map(data.branches.map(item => [item.id, item.companyId]));
  for (const item of growth) {
    const b = buckets.get(companyId ? item.branchId : branchCompanies.get(item.branchId) ?? '');
    if (b && item.value !== null)
      b.scores.push(item.value);
  }
  const order: Status[] = ['active', 'fading', 'inactive', 'not_started'];
  return {
    kind: companyId ? 'branches' : 'companies', rows: entities.map(item => {
      const b = buckets.get(item.id)!;
      const value = mean(b.scores);
      return { id: item.id, name: item.name, status: activityStatus(b.last, now), lastActionAt: b.last?.toISOString() ?? null, ...(companyId ? { employeesTotal: b.total.size } : { branchesCount: b.branches }), activeLeaders: b.leaders.size, activeEmployees: b.employees.size, callsLaunched: b.calls, answerRate: ratio(b.connected, b.calls), trainingsStarted: b.trainings, northStar: { value, state: value === null ? 'insufficient' as const : 'ok' as const } };
    }).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.callsLaunched - a.callsLaunched || a.name.localeCompare(b.name, 'ru'))
  };
}
