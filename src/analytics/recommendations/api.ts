import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { normalizeCallPhone } from '../../voice/phoneNumberStats';
import {
  calculateRecommendations,
  type RecommendationCall,
  type RecommendationChild,
} from './engine';

type Membership = NonNullable<Request['authAccount']>['memberships'][number];

const sessionSelect = {
  id: true,
  to: true,
  startedAt: true,
  outcome: true,
  answerTimeSec: true,
  totalScore: true,
  evaluationJson: true,
  checklistResultsJson: true,
  dealershipId: true,
  managerId: true,
  phoneNumberId: true,
  phoneNumberTypeId: true,
  phoneNumberTypeName: true,
  phoneNumberOwnership: true,
} satisfies Prisma.VoiceCallSessionSelect;

type SessionRow = Prisma.VoiceCallSessionGetPayload<{ select: typeof sessionSelect }>;

type PhoneSource = {
  typeId: string;
  type: { name: string; ownership: string };
};

function scopedMemberships(req: Request): Membership[] {
  const memberships = req.authAccount?.memberships ?? [];
  const role = String(req.get('x-admin-role') || '').trim();
  const roleMap: Record<string, string> = {
    super: 'platform_superadmin',
    company: 'holding_admin',
    dealer: 'dealership_admin',
    staff: 'manager',
  };
  return roleMap[role] ? memberships.filter((membership) => membership.role === roleMap[role]) : memberships;
}

function isSuper(memberships: Membership[]): boolean {
  return memberships.some((membership) => membership.role === 'platform_superadmin');
}

function canAccessHolding(memberships: Membership[], holdingId: string): boolean {
  return isSuper(memberships) || memberships.some((membership) => membership.role === 'holding_admin' && membership.holdingId === holdingId);
}

function canAccessDealership(memberships: Membership[], dealership: { id: string; holdingId: string | null }): boolean {
  return isSuper(memberships)
    || memberships.some((membership) => membership.role === 'holding_admin' && membership.holdingId === dealership.holdingId)
    || memberships.some((membership) => ['dealership_admin', 'manager'].includes(membership.role) && membership.dealershipId === dealership.id);
}

function safeJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function sessionScore(session: SessionRow): number | null {
  if (typeof session.totalScore === 'number') return session.totalScore;
  const evaluation = safeJson<Record<string, unknown> | null>(session.evaluationJson, null);
  const unified = evaluation?.unified_call_report;
  const raw = unified && typeof unified === 'object'
    ? (unified as Record<string, unknown>).totalScore
    : evaluation?.overall_score_0_100;
  const score = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(score) ? score : null;
}

function sessionChecklist(session: SessionRow): Array<{ code: string; status: string }> {
  const direct = safeJson<unknown>(session.checklistResultsJson, null);
  const evaluation = safeJson<Record<string, unknown> | null>(session.evaluationJson, null);
  const source = Array.isArray(direct) ? direct : evaluation?.checklist;
  if (!Array.isArray(source)) return [];
  return source.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const code = String(item.code || '').trim();
    const status = String(item.status || '').trim();
    return code && status ? [{ code, status }] : [];
  });
}

function toRecommendationCalls(sessions: SessionRow[], sourcesByPhone: Map<string, PhoneSource>): RecommendationCall[] {
  return sessions.map((session) => {
    const fallbackSource = sourcesByPhone.get(normalizeCallPhone(session.to));
    const ownership = session.phoneNumberOwnership ?? fallbackSource?.type.ownership ?? null;
    return {
      id: session.id,
      startedAt: session.startedAt,
      score: sessionScore(session),
      outcome: session.outcome,
      answerTimeSec: session.answerTimeSec,
      phoneNumberTypeId: session.phoneNumberTypeId ?? fallbackSource?.typeId ?? null,
      phoneNumberTypeName: session.phoneNumberTypeName ?? fallbackSource?.type.name ?? null,
      phoneNumberOwnership: ownership === 'dealership' || ownership === 'user' ? ownership : null,
      phoneNumberId: session.phoneNumberId,
      phoneNumber: session.to,
      checklist: sessionChecklist(session),
    };
  });
}

async function loadPhoneSources(dealershipIds: string[], accountIds: string[]): Promise<Map<string, PhoneSource>> {
  const phoneNumbers = await prisma.phoneNumber.findMany({
    where: {
      isActive: true,
      OR: [
        ...(dealershipIds.length ? [{ dealershipId: { in: dealershipIds } }] : []),
        ...(accountIds.length ? [{ accountId: { in: accountIds } }] : []),
      ],
    },
    select: { phone: true, typeId: true, type: { select: { name: true, ownership: true } } },
  });
  return new Map(phoneNumbers.map((phone) => [normalizeCallPhone(phone.phone), { typeId: phone.typeId, type: phone.type }]));
}

async function loadSessions(where: Prisma.VoiceCallSessionWhereInput): Promise<SessionRow[]> {
  return prisma.voiceCallSession.findMany({
    where: {
      AND: [
        where,
        { source: { notIn: ['demo', 'trainer', 'training'] } },
        { OR: [{ scenario: null }, { scenario: { notIn: ['trainer', 'training'] } }] },
      ],
      startedAt: { gte: new Date(Date.now() - 60 * 86_400_000) },
    },
    select: sessionSelect,
    orderBy: { startedAt: 'desc' },
  });
}

function childrenByKey(
  sessions: SessionRow[],
  calls: RecommendationCall[],
  items: Array<{ id: string; name: string; accountId?: string | null; sessionIds: Set<number> }>,
): RecommendationChild[] {
  const callById = new Map(calls.map((call) => [call.id, call]));
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    accountId: item.accountId,
    calls: sessions.filter((session) => item.sessionIds.has(session.id)).map((session) => callById.get(session.id)).filter((call): call is RecommendationCall => Boolean(call)),
  }));
}

export async function handleHoldingRecommendations(req: Request, res: Response): Promise<void> {
  const holdingId = String(req.params.holdingId || '').trim();
  const memberships = scopedMemberships(req);
  if (!req.authAccount) return void res.status(401).json({ error: 'Требуется авторизация.' });
  if (!canAccessHolding(memberships, holdingId)) return void res.status(403).json({ error: 'Нет доступа к компании.' });
  const holding = await prisma.holding.findUnique({
    where: { id: holdingId },
    include: { dealerships: { select: { id: true, name: true } } },
  });
  if (!holding) return void res.status(404).json({ error: 'Компания не найдена.' });
  const dealershipIds = holding.dealerships.map((item) => item.id);
  const profiles = await prisma.managerProfile.findMany({ where: { dealershipId: { in: dealershipIds } }, select: { id: true, accountId: true } });
  const sessions = await loadSessions({ dealershipId: { in: dealershipIds } });
  const sources = await loadPhoneSources(dealershipIds, profiles.flatMap((profile) => profile.accountId ? [profile.accountId] : []));
  const calls = toRecommendationCalls(sessions, sources);
  const children = childrenByKey(sessions, calls, holding.dealerships.map((dealership) => ({
    ...dealership,
    sessionIds: new Set(sessions.filter((session) => session.dealershipId === dealership.id).map((session) => session.id)),
  })));
  res.json({ entity: { id: holding.id, name: holding.name, level: 'holding' }, recommendations: calculateRecommendations({ calls, children }) });
}

export async function handleDealershipRecommendations(req: Request, res: Response): Promise<void> {
  const dealershipId = String(req.params.dealershipId || '').trim();
  const memberships = scopedMemberships(req);
  if (!req.authAccount) return void res.status(401).json({ error: 'Требуется авторизация.' });
  const dealership = await prisma.dealership.findUnique({ where: { id: dealershipId }, select: { id: true, name: true, holdingId: true } });
  if (!dealership) return void res.status(404).json({ error: 'Точка не найдена.' });
  if (!canAccessDealership(memberships, dealership)) return void res.status(403).json({ error: 'Нет доступа к точке.' });
  const profiles = await prisma.managerProfile.findMany({ where: { dealershipId }, select: { id: true, fullName: true, accountId: true } });
  const sessions = await loadSessions({ dealershipId });
  const sources = await loadPhoneSources([dealershipId], profiles.flatMap((profile) => profile.accountId ? [profile.accountId] : []));
  const calls = toRecommendationCalls(sessions, sources);
  let parentCalls: RecommendationCall[] = [];
  if (dealership.holdingId) {
    const parentDealerships = await prisma.dealership.findMany({ where: { holdingId: dealership.holdingId }, select: { id: true } });
    const parentDealershipIds = parentDealerships.map((item) => item.id);
    const parentProfiles = await prisma.managerProfile.findMany({ where: { dealershipId: { in: parentDealershipIds } }, select: { accountId: true } });
    const parentSessions = await loadSessions({ dealershipId: { in: parentDealershipIds } });
    const parentSources = await loadPhoneSources(parentDealershipIds, parentProfiles.flatMap((profile) => profile.accountId ? [profile.accountId] : []));
    parentCalls = toRecommendationCalls(parentSessions, parentSources);
  }
  const identities = new Map<string, { id: string; name: string; accountId: string | null; profileIds: string[] }>();
  for (const profile of profiles) {
    const key = profile.accountId ? `account:${profile.accountId}` : `profile:${profile.id}`;
    const current = identities.get(key) ?? { id: profile.id, name: profile.fullName, accountId: profile.accountId, profileIds: [] };
    current.profileIds.push(profile.id);
    identities.set(key, current);
  }
  const children = childrenByKey(sessions, calls, [...identities.values()].map((identity) => ({
    id: identity.id,
    name: identity.name,
    accountId: identity.accountId,
    sessionIds: new Set(sessions.filter((session) => session.managerId && identity.profileIds.includes(session.managerId)).map((session) => session.id)),
  })));
  res.json({ entity: { id: dealership.id, name: dealership.name, level: 'dealership' }, recommendations: calculateRecommendations({ calls, children, parentCalls }) });
}

export async function handleUserRecommendations(req: Request, res: Response): Promise<void> {
  const accountId = String(req.params.accountId || '').trim();
  const memberships = scopedMemberships(req);
  if (!req.authAccount) return void res.status(401).json({ error: 'Требуется авторизация.' });
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, displayName: true, email: true, managerProfiles: { select: { id: true, fullName: true, dealershipId: true, dealership: { select: { holdingId: true } } } } },
  });
  if (!account) return void res.status(404).json({ error: 'Пользователь не найден.' });
  const allowed = isSuper(memberships) || req.authAccount.id === accountId || account.managerProfiles.some((profile) => canAccessDealership(memberships, { id: profile.dealershipId, holdingId: profile.dealership.holdingId }));
  if (!allowed) return void res.status(403).json({ error: 'Нет доступа к пользователю.' });
  const accessibleProfiles = account.managerProfiles.filter((profile) => req.authAccount?.id === accountId || canAccessDealership(memberships, { id: profile.dealershipId, holdingId: profile.dealership.holdingId }));
  const profileIds = accessibleProfiles.map((profile) => profile.id);
  const dealershipIds = [...new Set(accessibleProfiles.map((profile) => profile.dealershipId))];
  const sessions = await loadSessions({ managerId: { in: profileIds } });
  const sources = await loadPhoneSources(dealershipIds, [account.id]);
  const calls = toRecommendationCalls(sessions, sources);
  res.json({
    entity: { id: account.id, name: account.displayName || accessibleProfiles[0]?.fullName || account.email, level: 'user' },
    recommendations: calculateRecommendations({ calls }),
  });
}
