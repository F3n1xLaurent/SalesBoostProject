import type { Account, AccountMembership, PermissionTemplate, Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../db';
import { hashPassword } from './password';
import {
  ALL_PERMISSIONS,
  APP_ROLES,
  PERMISSION_DEFINITIONS,
  SYSTEM_PERMISSION_TEMPLATES,
  type AppRole,
  type PermissionKey,
} from './permissions';

type ScopedAccount = NonNullable<Express.Request['authAccount']>;

type UserMembershipInput = {
  role: AppRole;
  holdingId?: string | null;
  dealershipId?: string | null;
};

type ManagerProfileInput = {
  fullName: string;
  dealershipId: string;
  email?: string | null;
  phone?: string | null;
  status?: string;
};

type AnalyticsSession = {
  startedAt: Date;
  outcome: string | null;
  totalScore: number | null;
  dimensionsJson: string | null;
  checklistResultsJson: string | null;
  evaluationJson: string | null;
  failureReason?: string | null;
};

type UserAnalytics = {
  aiRating: number;
  deltaRating: number | null;
  auditsCount: number;
  failsCount: number;
  communicationFlag: 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement';
  topMistakeLabel: string;
  status: 'norm' | 'risk' | 'critical' | 'no-data';
};

function isPlatformSuperadmin(account: ScopedAccount): boolean {
  return account.memberships.some((membership) => membership.role === APP_ROLES.platformSuperadmin);
}

function isHoldingAdmin(account: ScopedAccount): boolean {
  return account.memberships.some((membership) => membership.role === APP_ROLES.holdingAdmin);
}

function isDealershipAdmin(account: ScopedAccount): boolean {
  return account.memberships.some((membership) => membership.role === APP_ROLES.dealershipAdmin);
}

function scopeAccountToActiveRole(req: Request, account: ScopedAccount): ScopedAccount {
  const activeRole = String(req.get('x-admin-role') || '').trim();
  if (!activeRole) return account;

  const role = activeRole === 'super'
    ? APP_ROLES.platformSuperadmin
    : activeRole === 'company'
      ? APP_ROLES.holdingAdmin
      : activeRole === 'dealer'
        ? APP_ROLES.dealershipAdmin
        : activeRole === 'staff'
          ? APP_ROLES.manager
          : null;
  if (!role) return account;

  return {
    ...account,
    memberships: account.memberships.filter((membership) => membership.role === role),
  };
}

function getHoldingIds(account: ScopedAccount): string[] {
  return [...new Set(account.memberships.filter((membership) => membership.role === APP_ROLES.holdingAdmin && membership.holdingId).map((membership) => membership.holdingId!))];
}

function getDealershipIds(account: ScopedAccount): string[] {
  return [...new Set(account.memberships.filter((membership) => membership.role === APP_ROLES.dealershipAdmin && membership.dealershipId).map((membership) => membership.dealershipId!))];
}

async function getAccessibleDealerships(account: ScopedAccount) {
  if (isPlatformSuperadmin(account)) {
    return prisma.dealership.findMany({
      include: { holding: true },
      orderBy: [{ holding: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  const holdingIds = getHoldingIds(account);
  const dealershipIds = getDealershipIds(account);
  if (holdingIds.length === 0 && dealershipIds.length === 0) return [];
  return prisma.dealership.findMany({
    where: {
      OR: [
        ...(holdingIds.length ? [{ holdingId: { in: holdingIds } }] : []),
        ...(dealershipIds.length ? [{ id: { in: dealershipIds } }] : []),
      ],
    },
    include: { holding: true },
    orderBy: [{ holding: { name: 'asc' } }, { name: 'asc' }],
  });
}

async function getAccessibleHoldingIds(account: ScopedAccount): Promise<string[]> {
  if (isPlatformSuperadmin(account)) {
    const holdings = await prisma.holding.findMany({ select: { id: true } });
    return holdings.map((holding) => holding.id);
  }
  const holdingIds = getHoldingIds(account);
  const dealerships = await getAccessibleDealerships(account);
  return [...new Set([
    ...holdingIds,
    ...dealerships.map((dealership) => dealership.holdingId).filter((id): id is string => Boolean(id)),
  ])];
}

function parseMemberships(value: unknown): UserMembershipInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : null))
    .filter(Boolean)
    .map((raw) => ({
      role: String(raw!.role || '') as AppRole,
      holdingId: normalizeOptionalId(raw!.holdingId),
      dealershipId: normalizeOptionalId(raw!.dealershipId),
    }))
    .filter((membership) => membership.role.length > 0);
}

function normalizeOptionalId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function parseManagerProfiles(value: unknown): ManagerProfileInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : null))
    .filter(Boolean)
    .map((raw) => ({
      fullName: String(raw!.fullName || '').trim(),
      dealershipId: String(raw!.dealershipId || '').trim(),
      email: raw!.email != null ? String(raw!.email).trim() : null,
      phone: raw!.phone != null ? String(raw!.phone).trim() : null,
      status: raw!.status != null ? String(raw!.status).trim() : 'active',
    }))
    .filter((profile) => profile.fullName && profile.dealershipId);
}

function parseTemplateIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter(Boolean))];
}

const accountListInclude = {
  memberships: {
    include: {
      holding: true,
      dealership: {
        include: {
          holding: true,
        },
      },
    },
  },
  managerProfiles: {
    include: {
      dealership: {
        include: {
          holding: true,
        },
      },
    },
  },
  phoneNumbers: {
    include: {
      type: true,
    },
  },
  permissionTemplateAssignments: {
    include: {
      template: true,
    },
  },
} satisfies Prisma.AccountInclude;

type AccountListItem = Prisma.AccountGetPayload<{
  include: typeof accountListInclude;
}>;

function dealershipIdsFromMemberships(memberships: Array<{ dealershipId?: string | null }>): string[] {
  return [...new Set(memberships.map((membership) => membership.dealershipId).filter((id): id is string => Boolean(id)))];
}

async function dealershipIdsForMemberships(memberships: Array<{ holdingId?: string | null; dealershipId?: string | null }>): Promise<string[]> {
  const directDealershipIds = dealershipIdsFromMemberships(memberships);
  const holdingIds = [...new Set(memberships.map((membership) => membership.holdingId).filter((id): id is string => Boolean(id)))];
  if (holdingIds.length === 0) return directDealershipIds;

  const dealerships = await prisma.dealership.findMany({
    where: { holdingId: { in: holdingIds } },
    select: { id: true },
  });
  return [...new Set([...directDealershipIds, ...dealerships.map((dealership) => dealership.id)])];
}

function defaultProfileName(params: { displayName?: string | null; email: string }): string {
  const displayName = params.displayName?.trim();
  if (displayName) return displayName;
  const emailName = params.email.split('@')[0]?.trim();
  return emailName || params.email || 'Сотрудник';
}

async function expandManagerProfilesForDealershipMemberships(
  memberships: UserMembershipInput[],
  managerProfiles: ManagerProfileInput[],
  fallback: { fullName?: string | null; email: string; status?: string | null },
): Promise<ManagerProfileInput[]> {
  const out = [...managerProfiles];
  const profileDealershipIds = new Set(out.map((profile) => profile.dealershipId).filter(Boolean));
  const fullName = managerProfiles[0]?.fullName || fallback.fullName?.trim() || defaultProfileName({ displayName: fallback.fullName, email: fallback.email });

  for (const dealershipId of await dealershipIdsForMemberships(memberships)) {
    if (profileDealershipIds.has(dealershipId)) continue;
    out.push({
      fullName,
      dealershipId,
      email: fallback.email,
      phone: null,
      status: fallback.status || 'active',
    });
    profileDealershipIds.add(dealershipId);
  }

  return out;
}

async function ensureManagerProfilesForAccounts(accounts: AccountListItem[]): Promise<boolean> {
  let changed = false;

  for (const account of accounts) {
    const existingDealershipIds = new Set(account.managerProfiles.map((profile) => profile.dealershipId));
    for (const dealershipId of await dealershipIdsForMemberships(account.memberships)) {
      if (existingDealershipIds.has(dealershipId)) continue;

      const existing = await prisma.managerProfile.findFirst({
        where: { accountId: account.id, dealershipId },
        select: { id: true },
      });
      if (existing) {
        existingDealershipIds.add(dealershipId);
        continue;
      }

      await prisma.managerProfile.create({
        data: {
          accountId: account.id,
          dealershipId,
          fullName: defaultProfileName(account),
          email: account.email,
          status: 'active',
        },
      });
      existingDealershipIds.add(dealershipId);
      changed = true;
    }
  }

  return changed;
}

function safeJsonParseLocal<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function extractDimensionsFromSession(session: { dimensionsJson: string | null; evaluationJson: string | null }): Record<string, number> {
  const direct = safeJsonParseLocal<Record<string, unknown> | null>(session.dimensionsJson, null);
  const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
  const source = direct ?? (evaluation?.dimension_scores as Record<string, unknown> | undefined);
  if (!source || typeof source !== 'object') return {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, value]) => [key, typeof value === 'number' ? value : Number(value)])
      .filter(([, value]) => Number.isFinite(value as number)),
  ) as Record<string, number>;
}

function extractChecklistFromSession(session: { checklistResultsJson: string | null; evaluationJson: string | null }): Array<{ code?: string; status?: string; comment?: string }> {
  const direct = safeJsonParseLocal<unknown>(session.checklistResultsJson, null);
  if (Array.isArray(direct)) return direct as Array<{ code?: string; status?: string; comment?: string }>;
  const evaluation = safeJsonParseLocal<Record<string, unknown> | null>(session.evaluationJson, null);
  return Array.isArray(evaluation?.checklist) ? evaluation.checklist as Array<{ code?: string; status?: string; comment?: string }> : [];
}

function scoreFromSessions(sessions: AnalyticsSession[]): number {
  const scored = sessions.filter((session) => typeof session.totalScore === 'number');
  return scored.length ? round1(scored.reduce((sum, session) => sum + (session.totalScore ?? 0), 0) / scored.length) : 0;
}

function deltaFromSessions(sessions: AnalyticsSession[]): number | null {
  const now = new Date();
  const currentStart = new Date(now);
  currentStart.setDate(currentStart.getDate() - 30);
  const previousStart = new Date(now);
  previousStart.setDate(previousStart.getDate() - 60);
  const current = sessions.filter((session) => typeof session.totalScore === 'number' && session.startedAt >= currentStart);
  const previous = sessions.filter((session) => typeof session.totalScore === 'number' && session.startedAt >= previousStart && session.startedAt < currentStart);
  if (!current.length || !previous.length) return null;
  return Math.round(scoreFromSessions(current) - scoreFromSessions(previous));
}

function communicationFlagFromSessions(sessions: AnalyticsSession[]): UserAnalytics['communicationFlag'] {
  if (sessions.some((session) => String(session.failureReason || '').toUpperCase().includes('PROFANITY'))) return 'profanity';
  const values = sessions
    .map((session) => extractDimensionsFromSession(session).communication)
    .filter((value): value is number => typeof value === 'number');
  if (!values.length) return 'ok';
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (avg < 35) return 'aggression';
  if (avg < 50) return 'low-engagement';
  if (avg < 70) return 'fillers';
  return 'ok';
}

function topIssueFromSessions(sessions: AnalyticsSession[]): string {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const item of extractChecklistFromSession(session)) {
      const status = String(item.status || '').toUpperCase();
      if (status !== 'NO' && status !== 'PARTIAL') continue;
      const key = item.comment || item.code || 'Пункт чек-листа';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  const failed = sessions.find((session) => session.failureReason);
  return failed?.failureReason || 'Нет данных';
}

function analyticsFromSessions(sessions: AnalyticsSession[]): UserAnalytics {
  const aiRating = scoreFromSessions(sessions);
  const failsCount = sessions.filter((session) => typeof session.totalScore === 'number' && (session.totalScore ?? 0) < 50).length;
  const communicationFlag = communicationFlagFromSessions(sessions);
  const status: UserAnalytics['status'] = sessions.length === 0
    ? 'no-data'
    : aiRating < 50 || failsCount >= 2 || communicationFlag === 'profanity' || communicationFlag === 'aggression'
      ? 'critical'
      : aiRating < 70 || communicationFlag === 'fillers' || communicationFlag === 'low-engagement'
        ? 'risk'
        : 'norm';
  return {
    aiRating,
    deltaRating: deltaFromSessions(sessions),
    auditsCount: sessions.length,
    failsCount,
    communicationFlag,
    topMistakeLabel: topIssueFromSessions(sessions),
    status,
  };
}

function parsePermissionKeys(value: unknown): PermissionKey[] {
  if (!Array.isArray(value)) return [];
  const values = value.map((item) => String(item)).filter((item): item is PermissionKey => ALL_PERMISSIONS.includes(item as PermissionKey));
  return [...new Set(values)];
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallback;
}

function isUniqueEmailError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  return Array.isArray(target) ? target.includes('email') : target === 'email';
}

function prismaUserUpdateErrorMessage(error: unknown): string | null {
  const candidate = error as { code?: unknown; meta?: { field_name?: unknown; cause?: unknown; target?: unknown } };
  if (candidate.code === 'P2003') {
    const field = String(candidate.meta?.field_name || candidate.meta?.cause || '');
    if (field.includes('dealershipId')) return 'Указанная точка не найдена или недоступна.';
    if (field.includes('holdingId')) return 'Указанная компания не найдена или недоступна.';
    if (field.includes('templateId')) return 'Указанный шаблон прав не найден.';
    return 'Некорректная привязка сотрудника к компании, точке или шаблону прав.';
  }
  if (candidate.code === 'P2025') return 'Сотрудник, компания, точка или шаблон прав не найдены.';
  return null;
}

function formatPhoneNumber(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.length === 10) return `+7 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`;
  const normalized = digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
  if (normalized.length === 11 && normalized.startsWith('7')) {
    return `+7 ${normalized.slice(1, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7, 9)} ${normalized.slice(9)}`;
  }
  return raw;
}

function normalizePhoneNumberResponse(
  phoneNumber: Prisma.PhoneNumberGetPayload<{ include: { type: true } }>,
) {
  return {
    id: phoneNumber.id,
    typeId: phoneNumber.typeId,
    typeName: phoneNumber.type.name,
    phone: phoneNumber.phone,
    dealershipId: phoneNumber.dealershipId,
    accountId: phoneNumber.accountId,
    isActive: phoneNumber.isActive,
    createdAt: phoneNumber.createdAt,
    updatedAt: phoneNumber.updatedAt,
  };
}

function membershipToScopeLabel(membership: { role: string; holding?: { name: string } | null; dealership?: { name: string } | null }) {
  if (membership.role === APP_ROLES.platformSuperadmin) return 'Платформа';
  if (membership.holding?.name) return membership.holding.name;
  if (membership.dealership?.name) return membership.dealership.name;
  return 'Без scope';
}

function normalizeAccountResponse(account: Prisma.AccountGetPayload<{
  include: {
    memberships: { include: { holding: true; dealership: { include: { holding: true } } } };
    managerProfiles: { include: { dealership: { include: { holding: true } } } };
    phoneNumbers: { include: { type: true } };
    permissionTemplateAssignments: { include: { template: true } };
  };
}>, analyticsByManagerId: Map<string, UserAnalytics> = new Map()) {
  const managerAnalytics = account.managerProfiles
    .map((profile) => analyticsByManagerId.get(profile.id))
    .filter((analytics): analytics is UserAnalytics => Boolean(analytics));
  const analytics = managerAnalytics.length
    ? {
        aiRating: round1(managerAnalytics.reduce((sum, item) => sum + item.aiRating, 0) / managerAnalytics.length),
        deltaRating: managerAnalytics.some((item) => item.deltaRating !== null)
          ? Math.round(managerAnalytics.reduce((sum, item) => sum + (item.deltaRating ?? 0), 0) / managerAnalytics.filter((item) => item.deltaRating !== null).length)
          : null,
        auditsCount: managerAnalytics.reduce((sum, item) => sum + item.auditsCount, 0),
        failsCount: managerAnalytics.reduce((sum, item) => sum + item.failsCount, 0),
        communicationFlag: managerAnalytics.find((item) => item.communicationFlag === 'profanity')?.communicationFlag
          ?? managerAnalytics.find((item) => item.communicationFlag === 'aggression')?.communicationFlag
          ?? managerAnalytics.find((item) => item.communicationFlag === 'low-engagement')?.communicationFlag
          ?? managerAnalytics.find((item) => item.communicationFlag === 'fillers')?.communicationFlag
          ?? 'ok',
        topMistakeLabel: managerAnalytics.find((item) => item.topMistakeLabel !== 'Нет данных')?.topMistakeLabel ?? 'Нет данных',
        status: managerAnalytics.find((item) => item.status === 'critical')?.status
          ?? managerAnalytics.find((item) => item.status === 'risk')?.status
          ?? managerAnalytics.find((item) => item.status === 'norm')?.status
          ?? 'no-data',
      }
    : analyticsFromSessions([]);
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastLoginAt: account.lastLoginAt,
    memberships: account.memberships.map((membership) => ({
      id: membership.id,
      role: membership.role,
      holdingId: membership.holdingId,
      holdingName: membership.holding?.name ?? membership.dealership?.holding?.name ?? null,
      dealershipId: membership.dealershipId,
      dealershipName: membership.dealership?.name ?? null,
      dealershipType: membership.dealership?.type ?? null,
      scopeLabel: membershipToScopeLabel(membership),
    })),
    managerProfiles: account.managerProfiles.map((profile) => ({
      id: profile.id,
      fullName: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      status: profile.status,
      dealershipId: profile.dealershipId,
      dealershipName: profile.dealership.name,
      dealershipType: profile.dealership.type,
      holdingId: profile.dealership.holdingId,
      holdingName: profile.dealership.holding?.name ?? null,
    })),
    phoneNumbers: account.phoneNumbers.map(normalizePhoneNumberResponse),
    permissionTemplates: account.permissionTemplateAssignments.map((assignment) => ({
      id: assignment.template.id,
      name: assignment.template.name,
      description: assignment.template.description,
      permissions: JSON.parse(assignment.template.permissionsJson || '[]'),
    })),
    analytics,
  };
}

async function assertMembershipsAllowed(account: ScopedAccount, memberships: UserMembershipInput[], templateIds: string[]): Promise<void> {
  if (isPlatformSuperadmin(account)) return;
  if (!isHoldingAdmin(account) && !isDealershipAdmin(account)) {
    throw new Error('Недостаточно прав для управления пользователями.');
  }
  if (templateIds.length > 0) throw new Error('Шаблоны прав может назначать только суперадмин.');

  const dealerships = await getAccessibleDealerships(account);
  const dealershipIds = new Set(dealerships.map((dealership) => dealership.id));

  for (const membership of memberships) {
    if (membership.role !== APP_ROLES.manager) {
      throw new Error('Руководитель компании или точки может создавать и редактировать только менеджеров.');
    }
    if (!membership.dealershipId || !dealershipIds.has(membership.dealershipId)) {
      throw new Error('Нельзя назначить менеджера вне доступных вам точек.');
    }
  }
}

async function assertManagerProfilesAllowed(account: ScopedAccount, profiles: ManagerProfileInput[]): Promise<void> {
  if (isPlatformSuperadmin(account)) return;
  if (!isHoldingAdmin(account) && !isDealershipAdmin(account)) {
    throw new Error('Недостаточно прав для управления пользователями.');
  }

  const dealerships = await getAccessibleDealerships(account);
  const dealershipIds = new Set(dealerships.map((dealership) => dealership.id));
  for (const profile of profiles) {
    if (!dealershipIds.has(profile.dealershipId)) {
      throw new Error('Нельзя редактировать менеджеров вне доступных вам точек.');
    }
  }
}

async function assertAccountInScope(account: ScopedAccount, targetAccountId: string): Promise<void> {
  if (isPlatformSuperadmin(account)) return;
  if (!isHoldingAdmin(account)) throw new Error('Недостаточно прав для управления пользователями.');

  const holdingIds = getHoldingIds(account);
  const target = await prisma.account.findUnique({
    where: { id: targetAccountId },
    include: {
      memberships: {
        include: {
          dealership: true,
        },
      },
      managerProfiles: {
        include: {
          dealership: true,
        },
      },
    },
  });

  if (!target) throw new Error('Сотрудник не найден.');

  const inScope = target.memberships.some(
    (membership) =>
      membership.role === APP_ROLES.manager &&
      ((membership.dealership?.holdingId && holdingIds.includes(membership.dealership.holdingId)) || false),
  ) || target.managerProfiles.some((profile) => !!profile.dealership.holdingId && holdingIds.includes(profile.dealership.holdingId));

  if (!inScope) {
    throw new Error('Нельзя управлять пользователем вне автосалонов вашего холдинга.');
  }
}

export async function handleRbacMeta(req: Request, res: Response): Promise<void> {
  const authAccount = req.authAccount;
  if (!authAccount) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const account = scopeAccountToActiveRole(req, authAccount);

  if (isPlatformSuperadmin(account)) {
    await ensureSystemPermissionTemplates();
  }

  const [dealerships, templates] = await Promise.all([
    getAccessibleDealerships(account),
    isPlatformSuperadmin(account)
      ? prisma.permissionTemplate.findMany({ orderBy: { name: 'asc' } })
      : Promise.resolve([] as PermissionTemplate[]),
  ]);
  const holdingIds = [...new Set(dealerships.map((dealership) => dealership.holdingId).filter((id): id is string => Boolean(id)))];
  const holdings = isPlatformSuperadmin(account)
    ? await prisma.holding.findMany({ orderBy: { name: 'asc' } })
    : holdingIds.length
      ? await prisma.holding.findMany({ where: { id: { in: holdingIds } }, orderBy: { name: 'asc' } })
      : [];

  res.json({
    roles: Object.values(APP_ROLES),
    permissions: PERMISSION_DEFINITIONS,
    holdings: holdings.map((holding) => ({ id: holding.id, name: holding.name })),
    dealerships: dealerships.map((dealership) => ({
      id: dealership.id,
      name: dealership.name,
      holdingId: dealership.holdingId ?? null,
      holdingName: dealership.holding?.name ?? null,
    })),
    permissionTemplates: templates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      permissions: JSON.parse(template.permissionsJson || '[]'),
      isSystem: template.isSystem,
    })),
    canManageTemplates: isPlatformSuperadmin(account),
  });
}

export async function handleListUsers(req: Request, res: Response): Promise<void> {
  const authAccount = req.authAccount;
  if (!authAccount) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const account = scopeAccountToActiveRole(req, authAccount);

  const search = String(req.query.search || '').trim().toLowerCase();
  const holdingIds = getHoldingIds(account);
  const dealershipIds = getDealershipIds(account);

  const where: Prisma.AccountWhereInput = isPlatformSuperadmin(account)
    ? {}
    : {
        OR: [
          ...(holdingIds.length
            ? [
                {
                  memberships: {
                    some: {
                      role: APP_ROLES.manager,
                      dealership: {
                        holdingId: { in: holdingIds },
                      },
                    },
                  },
                },
                {
                  managerProfiles: {
                    some: {
                      dealership: {
                        holdingId: { in: holdingIds },
                      },
                    },
                  },
                },
              ]
            : []),
          ...(dealershipIds.length
            ? [
                {
                  memberships: {
                    some: {
                      role: APP_ROLES.manager,
                      dealershipId: { in: dealershipIds },
                    },
                  },
                },
                {
                  managerProfiles: {
                    some: {
                      dealershipId: { in: dealershipIds },
                    },
                  },
                },
              ]
            : []),
        ],
      };

  let accounts = await prisma.account.findMany({
    where,
    include: accountListInclude,
    orderBy: { createdAt: 'desc' },
  });

  if (await ensureManagerProfilesForAccounts(accounts)) {
    accounts = await prisma.account.findMany({
      where,
      include: accountListInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  const filtered = search
    ? accounts.filter((item) => {
        const haystack = [
          item.email,
          item.displayName || '',
          ...item.managerProfiles.map((profile) => profile.fullName),
          ...item.memberships.map((membership) => membership.dealership?.name || membership.holding?.name || ''),
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(search);
      })
    : accounts;

  const managerIds = [...new Set(filtered.flatMap((account) => account.managerProfiles.map((profile) => profile.id)))];
  const voiceSessions = managerIds.length
    ? await prisma.voiceCallSession.findMany({
        where: { managerId: { in: managerIds } },
        select: {
          managerId: true,
          startedAt: true,
          outcome: true,
          totalScore: true,
          dimensionsJson: true,
          checklistResultsJson: true,
          evaluationJson: true,
          failureReason: true,
        },
        orderBy: { startedAt: 'desc' },
      })
    : [];

  const sessionsByManagerId = new Map<string, AnalyticsSession[]>();
  for (const session of voiceSessions) {
    if (!session.managerId) continue;
    const list = sessionsByManagerId.get(session.managerId) ?? [];
    list.push({
      startedAt: session.startedAt,
      outcome: session.outcome,
      totalScore: session.totalScore,
      dimensionsJson: session.dimensionsJson,
      checklistResultsJson: session.checklistResultsJson,
      evaluationJson: session.evaluationJson,
      failureReason: session.failureReason,
    });
    sessionsByManagerId.set(session.managerId, list);
  }
  const analyticsByManagerId = new Map<string, UserAnalytics>();
  for (const managerId of managerIds) {
    analyticsByManagerId.set(managerId, analyticsFromSessions(sessionsByManagerId.get(managerId) ?? []));
  }

  res.json({
    items: filtered.map((account) => normalizeAccountResponse(account, analyticsByManagerId)),
    canManageTemplates: isPlatformSuperadmin(account),
  });
}

export async function handleCreateUser(req: Request, res: Response): Promise<void> {
  const authAccount = req.authAccount;
  if (!authAccount) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const account = scopeAccountToActiveRole(req, authAccount);

  const body = (req.body || {}) as Record<string, unknown>;
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim() || null;
  const status = String(body.status || 'active').trim() || 'active';
  const memberships = parseMemberships(body.memberships);
  const managerProfiles = await expandManagerProfilesForDealershipMemberships(
    memberships,
    parseManagerProfiles(body.managerProfiles),
    { fullName: displayName, email, status: 'active' },
  );
  const templateIds = parseTemplateIds(body.templateIds);

  if (!email || !password) {
    res.status(400).json({ error: 'Email и пароль обязательны.' });
    return;
  }
  if (memberships.length === 0) {
    res.status(400).json({ error: 'Нужно назначить хотя бы одну роль.' });
    return;
  }

  try {
    await assertMembershipsAllowed(account, memberships, templateIds);
    await assertManagerProfilesAllowed(account, managerProfiles);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  try {
    const existing = await prisma.account.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      res.status(409).json({ error: 'Сотрудник с таким email уже существует.' });
      return;
    }

    const created = await prisma.account.create({
      data: {
        email,
        passwordHash: hashPassword(password),
        displayName,
        status,
        memberships: {
          create: memberships.map((membership) => ({
            role: membership.role,
            holdingId: membership.holdingId || null,
            dealershipId: membership.dealershipId || null,
          })),
        },
        managerProfiles: managerProfiles.length
          ? {
              create: managerProfiles.map((profile) => ({
                fullName: profile.fullName,
                dealershipId: profile.dealershipId,
                email: profile.email || null,
                phone: profile.phone || null,
                status: profile.status || 'active',
              })),
            }
          : undefined,
        permissionTemplateAssignments: isPlatformSuperadmin(account) && templateIds.length
          ? {
              create: templateIds.map((templateId) => ({
                templateId,
              })),
            }
          : undefined,
      },
      include: {
        memberships: {
          include: {
            holding: true,
            dealership: {
              include: {
                holding: true,
              },
            },
          },
        },
        managerProfiles: {
          include: {
            dealership: {
              include: {
                holding: true,
              },
            },
          },
        },
        phoneNumbers: {
          include: {
            type: true,
          },
        },
        permissionTemplateAssignments: {
          include: {
            template: true,
          },
        },
      },
    });
    res.status(201).json({ item: normalizeAccountResponse(created) });
  } catch (error) {
    if (isUniqueEmailError(error)) {
      res.status(409).json({ error: 'Сотрудник с таким email уже существует.' });
      return;
    }
    const message = prismaUserUpdateErrorMessage(error);
    if (message) {
      res.status(400).json({ error: message });
      return;
    }
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Не удалось создать пользователя.' });
  }
}

export async function handleUpdateUser(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const accountId = String(req.params.accountId || '').trim();
  if (!accountId) {
    res.status(400).json({ error: 'Некорректный accountId.' });
    return;
  }

  try {
    await assertAccountInScope(account, accountId);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const email = body.email != null ? String(body.email).trim().toLowerCase() : undefined;
  const password = body.password != null ? String(body.password) : undefined;
  const displayName = body.displayName != null ? String(body.displayName).trim() || null : undefined;
  const status = body.status != null ? String(body.status).trim() : undefined;
  const memberships = body.memberships != null ? parseMemberships(body.memberships) : undefined;
  const managerProfiles = body.managerProfiles != null || memberships
    ? await expandManagerProfilesForDealershipMemberships(
        memberships ?? [],
        parseManagerProfiles(body.managerProfiles),
        { fullName: displayName, email: email || '', status: 'active' },
      )
    : undefined;
  const templateIds = body.templateIds != null ? parseTemplateIds(body.templateIds) : undefined;

  try {
    if (memberships) await assertMembershipsAllowed(account, memberships, templateIds || []);
    if (managerProfiles) await assertManagerProfilesAllowed(account, managerProfiles);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: accountId },
        data: {
          email,
          displayName,
          status,
          ...(password ? { passwordHash: hashPassword(password) } : {}),
        },
      });

      if (memberships) {
        await tx.accountMembership.deleteMany({ where: { accountId } });
        if (memberships.length > 0) {
          await tx.accountMembership.createMany({
            data: memberships.map((membership) => ({
              accountId,
              role: membership.role,
              holdingId: membership.holdingId || null,
              dealershipId: membership.dealershipId || null,
            })),
          });
        }
      }

      if (managerProfiles) {
        await tx.managerProfile.deleteMany({ where: { accountId } });
        if (managerProfiles.length > 0) {
          await tx.managerProfile.createMany({
            data: managerProfiles.map((profile) => ({
              accountId,
              fullName: profile.fullName,
              dealershipId: profile.dealershipId,
              email: profile.email || null,
              phone: profile.phone || null,
              status: profile.status || 'active',
            })),
          });
        }
      }

      if (templateIds && isPlatformSuperadmin(account)) {
        await tx.accountPermissionTemplateAssignment.deleteMany({ where: { accountId } });
        if (templateIds.length > 0) {
          await tx.accountPermissionTemplateAssignment.createMany({
            data: templateIds.map((templateId) => ({
              accountId,
              templateId,
            })),
          });
        }
      }
    });

    const updated = await prisma.account.findUnique({
      where: { id: accountId },
      include: {
        memberships: {
          include: {
            holding: true,
            dealership: {
              include: {
                holding: true,
              },
            },
          },
        },
        managerProfiles: {
          include: {
            dealership: {
              include: {
                holding: true,
              },
            },
          },
        },
        phoneNumbers: {
          include: {
            type: true,
          },
        },
        permissionTemplateAssignments: {
          include: {
            template: true,
          },
        },
      },
    });

    res.json({ item: updated ? normalizeAccountResponse(updated) : null });
  } catch (error) {
    if (isUniqueEmailError(error)) {
      res.status(409).json({ error: 'Сотрудник с таким email уже существует.' });
      return;
    }
    const message = prismaUserUpdateErrorMessage(error);
    if (message) {
      res.status(400).json({ error: message });
      return;
    }
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Не удалось обновить пользователя.' });
  }
}

export async function handleChangeOwnPassword(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const password = String(body.password || '');
  if (!password) {
    res.status(400).json({ error: 'Новый пароль обязателен.' });
    return;
  }

  try {
    await prisma.account.update({
      where: { id: account.id },
      data: { passwordHash: hashPassword(password) },
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Change own password error:', error);
    res.status(500).json({ error: 'Не удалось изменить пароль.' });
  }
}

export async function handleChangeUserPassword(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const accountId = String(req.params.accountId || '').trim();
  const body = (req.body || {}) as Record<string, unknown>;
  const password = String(body.password || '');

  if (!accountId) {
    res.status(400).json({ error: 'Некорректный accountId.' });
    return;
  }
  if (!password) {
    res.status(400).json({ error: 'Новый пароль обязателен.' });
    return;
  }

  try {
    await assertAccountInScope(account, accountId);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  try {
    await prisma.account.update({
      where: { id: accountId },
      data: { passwordHash: hashPassword(password) },
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Change user password error:', error);
    res.status(500).json({ error: 'Не удалось изменить пароль пользователя.' });
  }
}

export async function handleDeleteUser(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const accountId = String(req.params.accountId || '').trim();
  if (!accountId) {
    res.status(400).json({ error: 'Некорректный accountId.' });
    return;
  }
  if (account.id === accountId) {
    res.status(400).json({ error: 'Нельзя удалить собственную учётную запись.' });
    return;
  }

  try {
    await assertAccountInScope(account, accountId);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  try {
    await prisma.account.delete({
      where: { id: accountId },
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Не удалось удалить пользователя.' });
  }
}

export async function handleListUserPhoneNumbers(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const accountId = String(req.params.accountId || '').trim();
  if (!accountId) {
    res.status(400).json({ error: 'Некорректный accountId.' });
    return;
  }

  try {
    await assertAccountInScope(account, accountId);
    const items = await prisma.phoneNumber.findMany({
      where: { accountId },
      include: { type: true },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ items: items.map(normalizePhoneNumberResponse) });
  } catch (error) {
    console.error('List user phone numbers error:', error);
    res.status(error instanceof Error && error.message.includes('не найден') ? 404 : 403).json({
      error: error instanceof Error ? error.message : 'Нет доступа.',
    });
  }
}

export async function handleCreateUserPhoneNumber(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const accountId = String(req.params.accountId || '').trim();
  const body = (req.body || {}) as Record<string, unknown>;
  const typeId = String(body.typeId || '').trim();
  const phone = formatPhoneNumber(body.phone);
  const isActive = parseBoolean(body.isActive, true);

  if (!accountId) {
    res.status(400).json({ error: 'Некорректный accountId.' });
    return;
  }
  if (!typeId) {
    res.status(400).json({ error: 'Выберите тип номера.' });
    return;
  }
  if (!phone) {
    res.status(400).json({ error: 'Укажите номер телефона.' });
    return;
  }

  try {
    await assertAccountInScope(account, accountId);
    const type = await prisma.phoneNumberType.findUnique({
      where: { id: typeId },
      select: { id: true, ownership: true, isActive: true },
    });
    if (!type || type.ownership !== 'user' || !type.isActive) {
      res.status(400).json({ error: 'Выберите активный тип номера для пользователя.' });
      return;
    }

    const created = await prisma.phoneNumber.create({
      data: { accountId, typeId, phone, isActive },
      include: { type: true },
    });
    res.status(201).json({ item: normalizePhoneNumberResponse(created) });
  } catch (error) {
    console.error('Create user phone number error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Не удалось добавить номер телефона.' });
  }
}

export async function handleUpdateUserPhoneNumber(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const phoneNumberId = String(req.params.phoneNumberId || '').trim();
  const body = (req.body || {}) as Record<string, unknown>;
  const typeId = body.typeId != null ? String(body.typeId).trim() : undefined;
  const phone = body.phone != null ? formatPhoneNumber(body.phone) : undefined;
  const isActive = body.isActive != null ? parseBoolean(body.isActive, true) : undefined;

  if (!phoneNumberId) {
    res.status(400).json({ error: 'Некорректный phoneNumberId.' });
    return;
  }
  if (body.phone != null && !phone) {
    res.status(400).json({ error: 'Укажите номер телефона.' });
    return;
  }

  try {
    const existing = await prisma.phoneNumber.findUnique({ where: { id: phoneNumberId } });
    if (!existing?.accountId) {
      res.status(404).json({ error: 'Номер телефона не найден.' });
      return;
    }
    await assertAccountInScope(account, existing.accountId);

    if (typeId) {
      const type = await prisma.phoneNumberType.findUnique({
        where: { id: typeId },
        select: { id: true, ownership: true, isActive: true },
      });
      if (!type || type.ownership !== 'user' || !type.isActive) {
        res.status(400).json({ error: 'Выберите активный тип номера для пользователя.' });
        return;
      }
    }

    const updated = await prisma.phoneNumber.update({
      where: { id: phoneNumberId },
      data: {
        ...(typeId !== undefined ? { typeId } : {}),
        ...(phone !== undefined && phone !== null ? { phone } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
      include: { type: true },
    });
    res.json({ item: normalizePhoneNumberResponse(updated) });
  } catch (error) {
    console.error('Update user phone number error:', error);
    res.status(500).json({ error: 'Не удалось обновить номер телефона.' });
  }
}

export async function handleDeleteUserPhoneNumber(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const phoneNumberId = String(req.params.phoneNumberId || '').trim();
  if (!phoneNumberId) {
    res.status(400).json({ error: 'Некорректный phoneNumberId.' });
    return;
  }

  try {
    const existing = await prisma.phoneNumber.findUnique({ where: { id: phoneNumberId } });
    if (!existing?.accountId) {
      res.status(404).json({ error: 'Номер телефона не найден.' });
      return;
    }
    await assertAccountInScope(account, existing.accountId);
    await prisma.phoneNumber.delete({ where: { id: phoneNumberId } });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete user phone number error:', error);
    res.status(500).json({ error: 'Не удалось удалить номер телефона.' });
  }
}

function assertSuperadmin(account: ScopedAccount): void {
  if (!isPlatformSuperadmin(account)) {
    throw new Error('Доступно только суперадмину.');
  }
}

async function ensureSystemPermissionTemplates(): Promise<void> {
  await Promise.all(
    SYSTEM_PERMISSION_TEMPLATES.map((template) =>
      prisma.permissionTemplate.upsert({
        where: { name: template.name },
        create: {
          name: template.name,
          description: template.description,
          permissionsJson: JSON.stringify(template.permissions),
          isSystem: true,
        },
        update: {
          description: template.description,
          permissionsJson: JSON.stringify(template.permissions),
          isSystem: true,
        },
      }),
    ),
  );
}

export async function handleListPermissionTemplates(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  await ensureSystemPermissionTemplates();

  const templates = await prisma.permissionTemplate.findMany({
    include: {
      assignments: true,
    },
    orderBy: { name: 'asc' },
  });

  res.json({
    items: templates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      permissions: JSON.parse(template.permissionsJson || '[]'),
      assignedAccountsCount: template.assignments.length,
      isSystem: template.isSystem,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    })),
  });
}

export async function handleCreatePermissionTemplate(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const name = String(body.name || '').trim();
  const description = body.description != null ? String(body.description).trim() : null;
  const permissions = parsePermissionKeys(body.permissions);
  const systemTemplateNames = new Set(SYSTEM_PERMISSION_TEMPLATES.map((template) => template.name));

  if (!name) {
    res.status(400).json({ error: 'Название шаблона обязательно.' });
    return;
  }
  if (systemTemplateNames.has(name)) {
    res.status(400).json({ error: 'Такое название зарезервировано системным шаблоном.' });
    return;
  }

  const template = await prisma.permissionTemplate.create({
    data: {
      name,
      description,
      permissionsJson: JSON.stringify(permissions),
      createdByAccountId: account.id,
    },
  });

  res.status(201).json({
    item: {
      id: template.id,
      name: template.name,
      description: template.description,
      permissions,
      assignedAccountsCount: 0,
      isSystem: template.isSystem,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    },
  });
}

export async function handleUpdatePermissionTemplate(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const templateId = String(req.params.templateId || '').trim();
  const body = (req.body || {}) as Record<string, unknown>;
  const name = body.name != null ? String(body.name).trim() : undefined;
  const description = body.description != null ? String(body.description).trim() : undefined;
  const permissions = body.permissions != null ? parsePermissionKeys(body.permissions) : undefined;

  const existing = await prisma.permissionTemplate.findUnique({ where: { id: templateId } });
  if (!existing) {
    res.status(404).json({ error: 'Шаблон прав не найден.' });
    return;
  }
  if (existing.isSystem) {
    res.status(400).json({ error: 'Системный шаблон нельзя редактировать вручную.' });
    return;
  }

  const template = await prisma.permissionTemplate.update({
    where: { id: templateId },
    data: {
      name,
      description,
      permissionsJson: permissions ? JSON.stringify(permissions) : undefined,
    },
    include: {
      assignments: true,
    },
  });

  res.json({
    item: {
      id: template.id,
      name: template.name,
      description: template.description,
      permissions: JSON.parse(template.permissionsJson || '[]'),
      assignedAccountsCount: template.assignments.length,
      isSystem: template.isSystem,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    },
  });
}

export async function handleDeletePermissionTemplate(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const templateId = String(req.params.templateId || '').trim();
  if (!templateId) {
    res.status(400).json({ error: 'Некорректный templateId.' });
    return;
  }

  try {
    const existing = await prisma.permissionTemplate.findUnique({ where: { id: templateId } });
    if (!existing) {
      res.status(404).json({ error: 'Шаблон прав не найден.' });
      return;
    }
    if (existing.isSystem) {
      res.status(400).json({ error: 'Системный шаблон нельзя удалить.' });
      return;
    }
    await prisma.permissionTemplate.delete({
      where: { id: templateId },
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete permission template error:', error);
    res.status(500).json({ error: 'Не удалось удалить шаблон прав.' });
  }
}
