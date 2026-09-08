import { prisma } from '../db';
import type { ProductEventName } from './productAnalytics';

const DAY_MS = 24 * 60 * 60 * 1000;
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const PRODUCT_ROLES = ['manager', 'holding_admin', 'dealership_admin'] as const;
const LEADER_ROLES = new Set(['holding_admin', 'dealership_admin']);

const FEATURE_LABELS: Partial<Record<ProductEventName, string>> = {
  analytics_opened: 'Открытие аналитики',
  manager_viewed: 'Просмотр сотрудника',
  dealership_viewed: 'Просмотр точки',
  comparison_used: 'Сравнение',
  report_viewed: 'Просмотр отчёта',
  score_viewed: 'Просмотр баллов',
  errors_viewed: 'Просмотр ошибок',
  recommendations_viewed: 'Просмотр рекомендаций',
};

type ActivityEvent = {
  eventName: string;
  accountId: string | null;
  role: string | null;
  targetType: string | null;
  targetId: string | null;
  occurredAt: Date;
};

function percent(part: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, Math.round((part / total) * 100))) : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number {
  return values.length ? round1(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function moscowDayStartUtc(value: Date): Date {
  const shifted = new Date(value.getTime() + MOSCOW_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - MOSCOW_OFFSET_MS);
}

function moscowDateKey(value: Date): string {
  const shifted = new Date(value.getTime() + MOSCOW_OFFSET_MS);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function distinctAccounts(events: ActivityEvent[], from: Date): number {
  return new Set(events
    .filter((event) => event.occurredAt >= from && event.accountId)
    .map((event) => event.accountId as string)).size;
}

function hasRecommendations(evaluationJson: string | null): boolean {
  if (!evaluationJson) return false;
  try {
    const parsed = JSON.parse(evaluationJson) as Record<string, unknown>;
    const unified = parsed.unified_call_report && typeof parsed.unified_call_report === 'object'
      ? parsed.unified_call_report as Record<string, unknown>
      : null;
    return (Array.isArray(unified?.recommendations) && unified.recommendations.length > 0)
      || (Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0);
  } catch {
    return false;
  }
}

export type InternalActivityAnalytics = Awaited<ReturnType<typeof getInternalActivityAnalytics>>;

export async function getInternalActivityAnalytics(periodDays: 7 | 30 | 90) {
  const now = new Date();
  const todayStart = moscowDayStartUtc(now);
  const periodStart = new Date(todayStart.getTime() - (periodDays - 1) * DAY_MS);
  const previousStart = new Date(periodStart.getTime() - periodDays * DAY_MS);
  const last7Start = new Date(todayStart.getTime() - 6 * DAY_MS);
  const last30Start = new Date(todayStart.getTime() - 29 * DAY_MS);
  const eventFetchStart = previousStart < last30Start ? previousStart : last30Start;

  const [events, trainerSessions, calls, managers, newManagerAccounts, firstEventGroups, trackingStart] = await Promise.all([
    prisma.productAnalyticsEvent.findMany({
      where: {
        occurredAt: { gte: eventFetchStart, lte: now },
        role: { in: [...PRODUCT_ROLES] },
      },
      select: { eventName: true, accountId: true, role: true, targetType: true, targetId: true, occurredAt: true },
      orderBy: { occurredAt: 'asc' },
    }),
    prisma.trainerSession.findMany({
      where: {
        OR: [
          { startedAt: { gte: previousStart, lte: now } },
          { completedAt: { gte: previousStart, lte: now } },
        ],
      },
      select: { id: true, employeeId: true, status: true, startedAt: true, completedAt: true },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.voiceCallSession.findMany({
      where: {
        managerId: { not: null },
        source: { not: 'demo' },
        endedAt: { gte: previousStart, lte: now },
        evaluationJson: { not: null },
        totalScore: { not: null },
      },
      select: {
        callId: true,
        managerId: true,
        endedAt: true,
        totalScore: true,
        evaluationJson: true,
      },
      orderBy: { endedAt: 'asc' },
    }),
    prisma.managerProfile.findMany({
      where: { accountId: { not: null }, status: 'active' },
      select: { id: true, accountId: true },
    }),
    prisma.account.findMany({
      where: {
        status: 'active',
        createdAt: { gte: periodStart, lte: now },
        memberships: { some: { role: 'manager' } },
      },
      select: {
        id: true,
        createdAt: true,
        managerProfiles: { select: { id: true } },
      },
    }),
    prisma.productAnalyticsEvent.groupBy({
      by: ['accountId'],
      where: {
        accountId: { not: null },
        role: { in: [...PRODUCT_ROLES] },
      },
      _min: { occurredAt: true },
    }),
    prisma.productAnalyticsEvent.findFirst({
      where: { role: { in: [...PRODUCT_ROLES] } },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    }),
  ]);

  const accountToManagerIds = new Map<string, string[]>();
  for (const manager of managers) {
    if (!manager.accountId) continue;
    const ids = accountToManagerIds.get(manager.accountId) ?? [];
    ids.push(manager.id);
    accountToManagerIds.set(manager.accountId, ids);
  }

  const currentEvents = events.filter((event) => event.occurredAt >= periodStart);
  const currentTrainingsStarted = trainerSessions.filter((session) => session.startedAt >= periodStart);
  const currentTrainingsCompleted = trainerSessions.filter((session) =>
    session.status === 'completed' && session.completedAt && session.completedAt >= periodStart,
  );
  const startedManagerIds = new Set(currentTrainingsStarted.map((session) => session.employeeId));
  const completedStartedManagerIds = new Set(currentTrainingsStarted
    .filter((session) => session.status === 'completed' && session.completedAt)
    .map((session) => session.employeeId));
  const currentCalls = calls.filter((call) => call.endedAt && call.endedAt >= periodStart);
  const previousCalls = calls.filter((call) => call.endedAt && call.endedAt >= previousStart && call.endedAt < periodStart);

  const activeManagerIds = new Set<string>();
  for (const event of currentEvents) {
    if (event.role !== 'manager' || !event.accountId) continue;
    for (const managerId of accountToManagerIds.get(event.accountId) ?? []) activeManagerIds.add(managerId);
  }
  currentTrainingsStarted.forEach((session) => activeManagerIds.add(session.employeeId));
  currentTrainingsCompleted.forEach((session) => activeManagerIds.add(session.employeeId));
  currentCalls.forEach((call) => { if (call.managerId) activeManagerIds.add(call.managerId); });

  const trainedManagerIds = new Set(currentTrainingsCompleted.map((session) => session.employeeId));
  const checkedManagerIds = new Set(currentCalls.flatMap((call) => call.managerId ? [call.managerId] : []));
  const managerEvents = currentEvents.filter((event) => event.role === 'manager');
  const leaderEvents = currentEvents.filter((event) => event.role && LEADER_ROLES.has(event.role));
  const activeLeaderIds = new Set(leaderEvents.flatMap((event) => event.accountId ? [event.accountId] : []));

  const checkedAfterTraining = new Set<string>();
  const recommendationsAfterTraining = new Set<string>();
  const improvedAfterRepeatCheck = new Set<string>();
  for (const managerId of trainedManagerIds) {
    const completedTrainings = currentTrainingsCompleted
      .filter((session) => session.employeeId === managerId && session.completedAt)
      .map((session) => session.completedAt as Date);
    if (!completedTrainings.length) continue;
    const firstTrainingAt = new Date(Math.min(...completedTrainings.map((date) => date.getTime())));
    const managerCalls = currentCalls.filter((call) => call.managerId === managerId && call.endedAt && call.endedAt >= firstTrainingAt);
    if (!managerCalls.length) continue;
    checkedAfterTraining.add(managerId);
    const recommendationCallIndex = managerCalls.findIndex((call) => hasRecommendations(call.evaluationJson));
    if (recommendationCallIndex < 0) continue;
    recommendationsAfterTraining.add(managerId);
    const before = managerCalls[recommendationCallIndex].totalScore;
    for (let index = recommendationCallIndex + 1; index < managerCalls.length; index += 1) {
      const after = managerCalls[index].totalScore;
      if (before != null && after != null && after > before) {
        improvedAfterRepeatCheck.add(managerId);
        break;
      }
    }
  }

  const activationCohortIds = new Set(newManagerAccounts.map((account) => account.id));
  let activatedManagers = 0;
  for (const account of newManagerAccounts) {
    const profileIds = new Set(account.managerProfiles.map((profile) => profile.id));
    const activated = trainerSessions.some((session) => profileIds.has(session.employeeId) && session.startedAt >= account.createdAt)
      || calls.some((call) => !!call.managerId && profileIds.has(call.managerId) && !!call.endedAt && call.endedAt >= account.createdAt);
    if (activated) activatedManagers += 1;
  }

  const retentionCutoff = new Date(todayStart.getTime() - 7 * DAY_MS);
  const retentionCohort = firstEventGroups
    .filter((group) => group.accountId && group._min.occurredAt && group._min.occurredAt >= periodStart && group._min.occurredAt < retentionCutoff)
    .map((group) => ({ accountId: group.accountId as string, firstAt: group._min.occurredAt as Date }));
  const retentionEvents = retentionCohort.length
    ? await prisma.productAnalyticsEvent.findMany({
      where: {
        accountId: { in: retentionCohort.map((item) => item.accountId) },
        occurredAt: { gte: periodStart, lte: now },
        role: { in: [...PRODUCT_ROLES] },
      },
      select: { accountId: true, occurredAt: true },
    })
    : [];
  const retainedAccounts = new Set<string>();
  for (const cohortUser of retentionCohort) {
    const windowStart = new Date(cohortUser.firstAt.getTime() + 7 * DAY_MS);
    const windowEnd = new Date(cohortUser.firstAt.getTime() + 14 * DAY_MS);
    if (retentionEvents.some((event) => event.accountId === cohortUser.accountId && event.occurredAt >= windowStart && event.occurredAt < windowEnd)) {
      retainedAccounts.add(cohortUser.accountId);
    }
  }

  const daily = Array.from({ length: periodDays }, (_, index) => {
    const dayStart = new Date(periodStart.getTime() + index * DAY_MS);
    const key = moscowDateKey(dayStart);
    const dayActiveAccounts = new Set(currentEvents
      .filter((event) => moscowDateKey(event.occurredAt) === key && event.accountId)
      .map((event) => event.accountId as string));
    return {
      date: key,
      activeUsers: dayActiveAccounts.size,
      trainingsCompleted: currentTrainingsCompleted.filter((session) => session.completedAt && moscowDateKey(session.completedAt) === key).length,
      checksCompleted: currentCalls.filter((call) => call.endedAt && moscowDateKey(call.endedAt) === key).length,
    };
  });

  const featureUsage = Object.entries(FEATURE_LABELS).map(([eventName, label]) => {
    const matching = currentEvents.filter((event) => event.eventName === eventName);
    return {
      eventName,
      label: label as string,
      events: matching.length,
      users: new Set(matching.flatMap((event) => event.accountId ? [event.accountId] : [])).size,
    };
  }).sort((a, b) => b.events - a.events);

  const currentScores = currentCalls.flatMap((call) => call.totalScore == null ? [] : [call.totalScore]);
  const previousScores = previousCalls.flatMap((call) => call.totalScore == null ? [] : [call.totalScore]);
  const currentAverageScore = average(currentScores);
  const previousAverageScore = average(previousScores);

  return {
    generatedAt: now.toISOString(),
    periodDays,
    trackingStartedAt: trackingStart?.occurredAt.toISOString() ?? null,
    summary: {
      dau: distinctAccounts(events, todayStart),
      wau: distinctAccounts(events, last7Start),
      mau: distinctAccounts(events, last30Start),
      activeManagers: activeManagerIds.size,
      activeLeaders: activeLeaderIds.size,
      activationRate: percent(activatedManagers, activationCohortIds.size),
      activationCohortSize: activationCohortIds.size,
      retentionD7: retentionCohort.length ? percent(retainedAccounts.size, retentionCohort.length) : null,
      retentionCohortSize: retentionCohort.length,
      fullCycleRate: percent(recommendationsAfterTraining.size, activeManagerIds.size),
      fullCycleManagers: recommendationsAfterTraining.size,
      northStarRate: percent(improvedAfterRepeatCheck.size, activeManagerIds.size),
      improvedManagers: improvedAfterRepeatCheck.size,
      avgQualityScore: currentScores.length ? currentAverageScore : null,
      qualityScoreDelta: currentScores.length && previousScores.length
        ? round1(currentAverageScore - previousAverageScore)
        : null,
    },
    managers: {
      trainingsStarted: currentTrainingsStarted.length,
      trainingsCompleted: currentTrainingsCompleted.length,
      trainingCompletionRate: percent(completedStartedManagerIds.size, startedManagerIds.size),
      avgTrainingsPerActiveManager: activeManagerIds.size ? round1(currentTrainingsStarted.length / activeManagerIds.size) : 0,
      managersTrained: trainedManagerIds.size,
      checksCompleted: currentCalls.length,
      managersChecked: checkedManagerIds.size,
      scoreViews: managerEvents.filter((event) => event.eventName === 'score_viewed').length,
      errorViews: managerEvents.filter((event) => event.eventName === 'errors_viewed').length,
      recommendationsViewed: managerEvents.filter((event) => event.eventName === 'recommendations_viewed').length,
    },
    leaders: {
      activeLeaders: activeLeaderIds.size,
      analyticsViews: leaderEvents.filter((event) => event.eventName === 'analytics_opened').length,
      managerViews: leaderEvents.filter((event) => event.eventName === 'manager_viewed').length,
      managersViewed: new Set(leaderEvents
        .filter((event) => event.eventName === 'manager_viewed' && event.targetId)
        .map((event) => event.targetId as string)).size,
      dealershipViews: leaderEvents.filter((event) => event.eventName === 'dealership_viewed').length,
      dealershipsViewed: new Set(leaderEvents
        .filter((event) => event.eventName === 'dealership_viewed' && event.targetId)
        .map((event) => event.targetId as string)).size,
      comparisons: leaderEvents.filter((event) => event.eventName === 'comparison_used').length,
      reportsViewed: leaderEvents.filter((event) => event.eventName === 'report_viewed').length,
      callsAnalyzed: new Set(leaderEvents
        .filter((event) => event.eventName === 'report_viewed' && event.targetType === 'voice_call' && event.targetId)
        .map((event) => event.targetId as string)).size,
      recommendationsViewed: leaderEvents.filter((event) => event.eventName === 'recommendations_viewed').length,
    },
    funnel: [
      { key: 'active', label: 'Активные менеджеры', value: activeManagerIds.size, percent: activeManagerIds.size ? 100 : 0 },
      { key: 'training', label: 'Завершили тренировку', value: trainedManagerIds.size, percent: percent(trainedManagerIds.size, activeManagerIds.size) },
      { key: 'check', label: 'Прошли проверку после тренировки', value: checkedAfterTraining.size, percent: percent(checkedAfterTraining.size, activeManagerIds.size) },
      { key: 'recommendations', label: 'Получили рекомендации', value: recommendationsAfterTraining.size, percent: percent(recommendationsAfterTraining.size, activeManagerIds.size) },
      { key: 'improved', label: 'Улучшили балл при повторной проверке', value: improvedAfterRepeatCheck.size, percent: percent(improvedAfterRepeatCheck.size, activeManagerIds.size) },
    ],
    featureUsage,
    daily,
  };
}
