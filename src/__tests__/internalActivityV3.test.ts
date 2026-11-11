import { describe, expect, it } from 'vitest';
import { computeActivity } from '../analytics/activity';
import { computeBranchGrowth } from '../analytics/activity/northStar';
import { trainingOutcomes } from '../analytics/activity/trainer';
import { parseActivityScope } from '../analytics/activity/scope';
import { activityStatus } from '../analytics/activity/table';
import type { Call, Sources, Training } from '../analytics/activity/types';
const now = new Date('2026-11-11T12:00:00Z');
const old = new Date('2026-01-01T00:00:00Z');
function fixture(): Sources { return { companies: [{ id: 'c', name: 'Компания', createdAt: old, hasCallPlan: true }], branches: [{ id: 'b', name: 'Точка', companyId: 'c', createdAt: old }], people: [{ accountId: 'employee', role: 'employee', companyId: 'c', branchId: 'b', createdAt: old }], employees: [{ id: 'profile', accountId: 'employee', companyId: 'c', branchId: 'b' }], events: [], trainings: [], calls: [], plans: [], streaks: [], lastActions: [] }; }
function call(id: string, score: number, date: string, branchId = 'b', scriptId: string | null = 's'): Call { return { id, branchId, companyId: 'c', scriptId, startedAt: new Date(date), connectedAt: new Date(date), outcome: 'completed', score, talkDurationSec: 60, durationSec: 60 }; }
function training(patch: Partial<Training> = {}): Training { return { id: 't', accountId: 'employee', companyId: 'c', branchId: 'b', status: 'completed', score: 80, failureReason: null, sessionType: 'plan', difficulty: 'easy', durationSec: 90, startedAt: new Date('2026-11-10T12:00:00Z'), completedAt: new Date('2026-11-10T12:10:00Z'), ...patch }; }
const scope = { period: 30 as const, companyId: null, branchId: null };
describe('internal activity v3 calculations', () => {
  it('does not count an employee who only received a bot call as active, and includes branch calls', () => { const d = fixture(); d.calls = [call('bot', 80, '2026-11-10T10:00:00Z')]; const r = computeActivity(d, scope, now); expect(r.kpis.activeEmployees.value).toBe(0); expect(r.kpis.activeEntities?.value).toBe(0); expect(r.calls.funnel.launched).toBe(1); expect(r.calls.funnel.connected).toBe(1); });
  it('counts multiple employee profiles and training events as one account, with Moscow day boundaries', () => { const d = fixture(); d.trainings = [training(), training({ id: 't2', startedAt: new Date('2026-11-10T21:30:00Z') })]; const r = computeActivity(d, scope, now); expect(r.kpis.activeEmployees.value).toBe(1); expect(r.trainer.trainedPeople).toBe(1); expect(r.roles.employees.activeDaysPerWeek).toBeCloseTo(2 / (30 / 7)); expect(r.dailyActive.points.at(-1)?.employees).toBe(1); });
  it('counts unique people for weekly buckets rather than summing daily users', () => { const d = fixture(); d.trainings = [training({ startedAt: new Date('2026-11-05T12:00:00Z') }), training({ id: 't2', startedAt: new Date('2026-11-06T12:00:00Z') })]; const r = computeActivity(d, { ...scope, period: 90 }, now); expect(r.dailyActive.granularity).toBe('week'); expect(Math.max(...r.dailyActive.points.map(p => p.employees))).toBe(1); });
  it('returns missing ratios and durations as null', () => { const r = computeActivity(fixture(), scope, now); expect(r.kpis.answerRate.rate).toBeNull(); expect(r.kpis.northStar.value).toBeNull(); expect(r.trainer.perPerson).toBeNull(); expect(r.trainer.avgDurationSec).toBeNull(); });
  it('classifies session outcomes without counting ongoing sessions', () => { expect(trainingOutcomes([training(), training({ status: 'completed', score: null }), training({ status: 'failed', failureReason: 'PROFANITY' }), training({ status: 'failed', failureReason: 'SYSTEM_ERROR:evaluation' }), training({ status: 'cancelled' }), training({ status: 'paused', startedAt: old }), training({ status: 'in_progress', startedAt: now })], now)).toEqual({ evaluated: 1, failCase: 1, abandoned: 2, failed: 2 }); });
  it('compares current and previous periods using the same calculation', () => { const d = fixture(); d.calls = [call('current', 80, '2026-11-10T12:00:00Z'), { ...call('previous', 80, '2026-10-01T12:00:00Z'), connectedAt: null, outcome: 'no_answer', score: null }]; const r = computeActivity(d, scope, now); expect(r.kpis.answerRate.deltaPp).toBe(100); });
  it('keeps a fixed baseline per script and excludes disconnects, unscripted calls and baseline overlap', () => {
    const calls = [...Array.from({ length: 20 }, (_, i) => call(`base${i}`, 50, '2026-09-01T12:00:00Z')), ...Array.from({ length: 10 }, (_, i) => call(`window${i}`, 60, '2026-11-10T12:00:00Z')), { ...call('disconnected', 0, '2026-11-10T12:00:00Z'), outcome: 'disconnected' }, call('unscripted', 0, '2026-11-10T12:00:00Z', 'b', null)];
    expect(computeBranchGrowth(['b'], now, calls)[0]).toMatchObject({ value: 10, group: 'improved' });
    expect(computeBranchGrowth(['b'], now, calls.slice(0, 19))[0].state).toBe('insufficient');
    expect(computeBranchGrowth(['b'], now, calls.slice(0, 29))[0].state).toBe('insufficient');
    const overlap = Array.from({ length: 20 }, (_, i) => call(`o${i}`, 50, '2026-11-01T12:00:00Z'));
    expect(computeBranchGrowth(['b'], now, overlap)[0].state).toBe('insufficient');
  });
  it('weights scripts by window calls but gives branches equal weight', () => {
    const d = fixture(); d.branches.push({ id: 'b2', name: 'Точка 2', companyId: 'c', createdAt: old }); for (const [branch, script, score, n] of [['b', 's', 60, 10], ['b', 's2', 80, 30], ['b2', 's', 40, 10]] as const) {
      d.calls.push(...Array.from({ length: 20 }, (_, i) => call(`${branch}${script}base${i}`, 50, '2026-09-01T12:00:00Z', branch, script)), ...Array.from({ length: n }, (_, i) => call(`${branch}${script}now${i}`, score, '2026-11-10T12:00:00Z', branch, script)));
    } const r = computeActivity(d, scope, now); expect(r.table.rows[0].northStar.value).toBe(7.5); expect(r.kpis.northStar.value).toBe(7.5);
  });
  it('scopes every block to a selected branch and handles status independently of the period', () => { const d = fixture(); d.branches.push({ id: 'b2', name: 'Точка 2', companyId: 'c', createdAt: old }); d.calls = [call('other', 90, '2026-11-10T12:00:00Z', 'b2')]; d.lastActions = [{ companyId: 'c', branchId: 'b', at: old }]; const r = computeActivity(d, { period: 7, companyId: 'c', branchId: 'b' }, now); expect(r.table.rows).toHaveLength(1); expect(r.calls.funnel.launched).toBe(0); expect(r.kpis.branchStatus?.status).toBe('inactive'); });
  it('validates periods, scalar ids and dependent branch filters', () => {
    for (const q of [{ period: '8' }, { period: ['30'] }, { branchId: 'b' }, { companyId: ['c'] }])
      expect(() => parseActivityScope(q)).toThrow(); expect(parseActivityScope({})).toEqual(scope);
  });
  it('handles status thresholds by Moscow calendar days', () => { expect(activityStatus(new Date('2026-11-04T00:00:00+03:00'), now)).toBe('active'); expect(activityStatus(new Date('2026-11-03T23:59:00+03:00'), now)).toBe('fading'); expect(activityStatus(null, now)).toBe('not_started'); });
});
