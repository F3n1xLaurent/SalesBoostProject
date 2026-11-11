import { BASELINE_CALLS, MIN_WINDOW_CALLS, GROWTH_THRESHOLD, NS_WINDOW_DAYS, DAY_MS, mean } from './config';
import type { Call, NsValue } from './types';
export type BranchGrowth = NsValue & {
  branchId: string;
  group: 'improved' | 'flat' | 'declined' | 'insufficient';
};
export function computeBranchGrowth(branchIds: string[], windowEnd: Date, calls: Call[]): BranchGrowth[] {
  const pairs = new Map<string, Call[]>();
  const allowed = new Set(branchIds);
  for (const call of calls) {
    if (!allowed.has(call.branchId) || call.outcome !== 'completed' || call.score === null || !call.scriptId || call.startedAt >= windowEnd)
      continue;
    const key = `${call.branchId}:${call.scriptId}`;
    const group = pairs.get(key) ?? [];
    group.push(call);
    pairs.set(key, group);
  }
  const sums = new Map<string, {
    weighted: number;
    count: number;
  }>();
  const windowStart = windowEnd.getTime() - NS_WINDOW_DAYS * DAY_MS;
  for (const pair of pairs.values()) {
    pair.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
    if (pair.length < BASELINE_CALLS)
      continue;
    const baseline = mean(pair.slice(0, BASELINE_CALLS).map(call => call.score!))!;
    const current = pair.slice(BASELINE_CALLS).filter(call => call.startedAt.getTime() >= windowStart);
    if (current.length < MIN_WINDOW_CALLS)
      continue;
    const item = sums.get(pair[0].branchId) ?? { weighted: 0, count: 0 };
    item.weighted += (mean(current.map(call => call.score!))! - baseline) * current.length;
    item.count += current.length;
    sums.set(pair[0].branchId, item);
  }
  return branchIds.map(branchId => {
    const item = sums.get(branchId), value = item ? item.weighted / item.count : null;
    return { branchId, value, state: value === null ? 'insufficient' : 'ok', group: value === null ? 'insufficient' : value >= GROWTH_THRESHOLD ? 'improved' : value <= -GROWTH_THRESHOLD ? 'declined' : 'flat' };
  });
}
