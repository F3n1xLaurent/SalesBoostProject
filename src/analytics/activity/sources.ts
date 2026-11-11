import { BASELINE_CALLS } from './config';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { ActivityInputError } from './scope';
import type { ActivityRole, Call, Event, Scope, Sources } from './types';
function parseJson<T>(raw: string | null, fallback: T): T {
  try {
    return JSON.parse(raw ?? '') as T;
  }
  catch {
    return fallback;
  }
}
const eventRole = (role: string): ActivityRole => role === 'manager' ? 'employee' : role === 'holding_admin' ? 'company_admin' : 'branch_admin';
export async function loadActivitySources(scope: Scope, from: Date, until: Date): Promise<Sources> {
  const companies = await prisma.holding.findMany({ where: { isDeleted: false, isTest: false }, select: { id: true, name: true, createdAt: true, _count: { select: { callPlans: true } } }, orderBy: { name: 'asc' } });
  if (scope.companyId && !companies.some(item => item.id === scope.companyId))
    throw new ActivityInputError('Компания не найдена.', 404);
  const allBranches = await prisma.dealership.findMany({ where: { isDeleted: false, holdingId: { in: companies.map(item => item.id) } }, select: { id: true, name: true, holdingId: true, createdAt: true }, orderBy: { name: 'asc' } });
  if (scope.branchId && !allBranches.some(item => item.id === scope.branchId && item.holdingId === scope.companyId))
    throw new ActivityInputError('Точка не принадлежит выбранной компании.');
  const branches = allBranches.filter(item => (!scope.companyId || item.holdingId === scope.companyId) && (!scope.branchId || item.id === scope.branchId));
  const branchIds = branches.map(item => item.id);
  const companyIds = scope.companyId ? [scope.companyId] : companies.map(item => item.id);
  // An empty SQL IN list is intentionally represented by a value that cannot be an application id.
  const sqlCompanies = Prisma.join(companyIds.length ? companyIds : ['']);
  const sqlBranches = scope.branchId ? Prisma.sql`AND e.branchId = ${scope.branchId}` : Prisma.empty;
  const eligibleAccount = { status: 'active', memberships: { none: { role: 'platform_superadmin' } } } as const;
  const [memberships, profiles, trainings, plans, streaks, eventRows, lastRows, callRows] = await Promise.all([
    prisma.accountMembership.findMany({ where: { role: { in: ['manager', 'holding_admin', 'dealership_admin'] }, account: eligibleAccount, OR: [{ holdingId: { in: companyIds } }, { dealershipId: { in: branchIds } }] }, select: { accountId: true, role: true, holdingId: true, dealershipId: true, createdAt: true, account: { select: { createdAt: true } } } }),
    prisma.managerProfile.findMany({ where: { accountId: { not: null }, status: 'active', dealershipId: { in: branchIds }, account: { ...eligibleAccount, memberships: { some: { role: 'manager' }, none: { role: 'platform_superadmin' } } } }, select: { id: true, accountId: true, dealershipId: true } }),
    prisma.trainerSession.findMany({ where: { companyId: { in: companyIds }, ...(scope.branchId ? { branchId: scope.branchId } : {}), OR: [{ startedAt: { gte: from, lte: until } }, { completedAt: { gte: from, lte: until } }], employee: { account: { memberships: { some: { role: 'manager' }, none: { role: 'platform_superadmin' } } } } }, select: { id: true, employee: { select: { accountId: true } }, companyId: true, branchId: true, status: true, score: true, failureReason: true, sessionType: true, difficulty: true, durationSec: true, startedAt: true, completedAt: true } }),
    prisma.trainerDailyPlan.findMany({ where: { companyId: { in: companyIds }, ...(scope.branchId ? { branchId: scope.branchId } : {}), planDate: { gte: new Date(from.getTime() + 10800000).toISOString().slice(0, 10), lte: new Date(until.getTime() + 10800000).toISOString().slice(0, 10) }, employee: { account: { memberships: { some: { role: 'manager' }, none: { role: 'platform_superadmin' } } } } }, select: { companyId: true, branchId: true, planDate: true, sessionsJson: true, employee: { select: { accountId: true } } } }),
    prisma.trainerStreak.findMany({ where: { employee: { dealershipId: { in: branchIds }, account: { ...eligibleAccount, memberships: { some: { role: 'manager' }, none: { role: 'platform_superadmin' } } } } }, select: { currentStreak: true, lastActiveDate: true, employee: { select: { accountId: true, dealershipId: true } } } }),
    // Aggregate repeated actions in SQLite, retaining only one row per person/action/day/scope.
    prisma.$queryRaw<Array<Omit<Event, 'lastAt' | 'actions'> & {
      lastAt: bigint | number;
      actions: bigint | number;
    }>>(Prisma.sql`
      SELECT e.accountId, e.role, e.companyId, e.branchId, e.eventName,
        strftime('%Y-%m-%d', e.occurredAt / 1000, 'unixepoch', '+3 hours') AS date,
        CASE WHEN json_valid(e.propertiesJson) THEN json_extract(e.propertiesJson, '$.report_type') END AS reportType,
        CASE WHEN json_valid(e.propertiesJson) THEN json_extract(e.propertiesJson, '$.section') END AS section,
        COUNT(*) AS actions, MAX(e.occurredAt) AS lastAt
      FROM product_analytics_events e
      WHERE e.initiatedBy = 'user' AND e.role IN ('employee', 'company_admin', 'branch_admin')
        AND e.accountId IS NOT NULL AND e.companyId IN (${sqlCompanies}) ${sqlBranches}
        AND (e.branchId IS NULL OR e.branchId IN (SELECT id FROM dealerships WHERE isDeleted = 0))
        AND NOT EXISTS (SELECT 1 FROM account_memberships m WHERE m.accountId = e.accountId AND m.role = 'platform_superadmin')
        AND (e.role <> 'employee' OR EXISTS (SELECT 1 FROM account_memberships m WHERE m.accountId = e.accountId AND m.role = 'manager'))
        AND e.occurredAt >= ${from} AND e.occurredAt <= ${until}
      GROUP BY e.accountId, e.role, e.companyId, e.branchId, e.eventName, date, reportType, section`),
    prisma.$queryRaw<Array<{
      companyId: string;
      branchId: string | null;
      at: bigint | number;
    }>>(Prisma.sql`
      SELECT e.companyId, e.branchId, MAX(e.occurredAt) AS at FROM product_analytics_events e
      WHERE e.initiatedBy = 'user' AND e.role IN ('employee', 'company_admin', 'branch_admin') AND e.accountId IS NOT NULL
        AND e.companyId IN (${sqlCompanies}) ${sqlBranches} AND e.occurredAt <= ${until}
        AND NOT EXISTS (SELECT 1 FROM account_memberships m WHERE m.accountId = e.accountId AND m.role = 'platform_superadmin')
        AND (e.role <> 'employee' OR EXISTS (SELECT 1 FROM account_memberships m WHERE m.accountId = e.accountId AND m.role = 'manager'))
      GROUP BY e.companyId, e.branchId
      UNION ALL
      SELECT t.companyId, t.branchId, MAX(t.startedAt) AS at FROM trainer_sessions t
      JOIN manager_profiles p ON p.id = t.employeeId
      WHERE t.companyId IN (${sqlCompanies}) AND t.startedAt <= ${until}
        AND EXISTS (SELECT 1 FROM account_memberships m WHERE m.accountId = p.accountId AND m.role = 'manager')
        AND NOT EXISTS (SELECT 1 FROM account_memberships m WHERE m.accountId = p.accountId AND m.role = 'platform_superadmin')
      GROUP BY t.companyId, t.branchId`),
    // Keep the fixed first twenty scores per pair plus recent operational calls. Do not load full call history.
    prisma.$queryRaw<Array<Omit<Call, 'startedAt' | 'connectedAt'> & {
      startedAt: number | bigint;
      connectedAt: number | bigint | null;
    }>>(Prisma.sql`
      WITH resolved AS (
        SELECT v.callId AS id, d.holdingId AS companyId, v.dealershipId AS branchId,
          COALESCE(p.scriptId, CASE WHEN json_valid(v.caseContextJson) THEN json_extract(v.caseContextJson, '$.scriptId') END) AS scriptId,
          v.startedAt, v.connectedAt, v.outcome, v.totalScore AS score, v.talkDurationSec, v.durationSec
        FROM voice_call_sessions v JOIN dealerships d ON d.id = v.dealershipId
        LEFT JOIN call_plans p ON p.id = v.planId
        WHERE v.source <> 'demo' AND d.isDeleted = 0 AND d.holdingId IN (${sqlCompanies})
          ${scope.branchId ? Prisma.sql`AND d.id = ${scope.branchId}` : Prisma.empty} AND v.startedAt <= ${until}
      ), baseline AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY branchId, scriptId ORDER BY startedAt, id) AS position
        FROM resolved WHERE outcome = 'completed' AND score IS NOT NULL AND scriptId IS NOT NULL
      )
      SELECT id, companyId, branchId, scriptId, startedAt, connectedAt, outcome, score, talkDurationSec, durationSec FROM resolved WHERE startedAt >= ${from}
      UNION
      SELECT id, companyId, branchId, scriptId, startedAt, connectedAt, outcome, score, talkDurationSec, durationSec FROM baseline WHERE position <= ${BASELINE_CALLS}`),
  ]);
  const branchCompany = new Map(allBranches.map(item => [item.id, item.holdingId!]));
  return {
    companies: companies.map(item => ({ id: item.id, name: item.name, createdAt: item.createdAt, hasCallPlan: item._count.callPlans > 0 })),
    branches: allBranches.map(item => ({ id: item.id, name: item.name, companyId: item.holdingId!, createdAt: item.createdAt })),
    people: memberships.flatMap(item => {
      const companyId = item.holdingId ?? (item.dealershipId ? branchCompany.get(item.dealershipId) : null);
      if (!companyId || (scope.branchId && item.dealershipId !== scope.branchId))
        return [];
      return [{ accountId: item.accountId, role: eventRole(item.role), companyId, branchId: item.dealershipId, createdAt: item.createdAt > item.account.createdAt ? item.createdAt : item.account.createdAt }];
    }),
    employees: profiles.map(item => ({ id: item.id, accountId: item.accountId!, branchId: item.dealershipId, companyId: branchCompany.get(item.dealershipId)! })),
    events: eventRows.map(item => ({ ...item, lastAt: new Date(Number(item.lastAt)), actions: Number(item.actions) })),
    trainings: trainings.flatMap(({ employee, ...item }) => employee.accountId && item.companyId ? [{ ...item, accountId: employee.accountId, companyId: item.companyId }] : []),
    plans: plans.flatMap(item => item.employee.accountId && item.companyId ? [{ accountId: item.employee.accountId, companyId: item.companyId, branchId: item.branchId, date: item.planDate, items: parseJson(item.sessionsJson, []) }] : []),
    streaks: streaks.flatMap(item => item.employee.accountId ? [{ accountId: item.employee.accountId, branchId: item.employee.dealershipId, current: item.currentStreak, date: item.lastActiveDate }] : []),
    lastActions: lastRows.map(item => ({ ...item, at: new Date(Number(item.at)) })).filter(item => (!item.branchId || branchCompany.has(item.branchId)) && (!scope.branchId || item.branchId === scope.branchId)),
    calls: callRows.map(item => ({ ...item, startedAt: new Date(Number(item.startedAt)), connectedAt: item.connectedAt === null ? null : new Date(Number(item.connectedAt)) })),
  };
}
