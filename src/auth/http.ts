import type { AccountMembership, AccountPermissionTemplateAssignment, PermissionTemplate } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db';
import { config } from '../config';
import { verifyPassword } from './password';
import { createAuthToken, verifyAuthToken } from './token';
import { recordProductEvent, type ProductRole } from '../analytics/productAnalytics';
import * as Sentry from '@sentry/node';

export type FrontendRole = 'super' | 'company' | 'dealer' | 'staff';

export type AuthenticatedAccount = Awaited<ReturnType<typeof getAccountForRequest>>;

type AccountWithMemberships = NonNullable<AuthenticatedAccount>;
type TemplateAssignmentWithTemplate = AccountPermissionTemplateAssignment & { template: PermissionTemplate };

function tokenSecret(): string {
  return config.authTokenSecret || `${config.botToken}:salesboost-auth`;
}

function toFrontendRole(memberships: AccountMembership[]): FrontendRole {
  const roles = memberships.map((membership) => membership.role);
  if (roles.includes('platform_superadmin')) return 'super';
  if (roles.includes('holding_admin')) return 'company';
  if (roles.includes('dealership_admin')) return 'dealer';
  return 'staff';
}

function toAllowedRoles(memberships: AccountMembership[]): FrontendRole[] {
  const out = new Set<FrontendRole>();
  for (const membership of memberships) {
    if (membership.role === 'platform_superadmin') out.add('super');
    if (membership.role === 'holding_admin') out.add('company');
    if (membership.role === 'dealership_admin') out.add('dealer');
    if (membership.role === 'manager') out.add('staff');
  }
  if (out.size === 0) out.add('staff');
  return Array.from(out);
}

function accountToAuthPayload(account: AccountWithMemberships) {
  const templateAssignments = account.permissionTemplateAssignments as TemplateAssignmentWithTemplate[];
  return {
    account: {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      status: account.status,
    },
    allowedRoles: toAllowedRoles(account.memberships),
    defaultRole: toFrontendRole(account.memberships),
    memberships: account.memberships.map((membership) => ({
      id: membership.id,
      role: membership.role,
      holdingId: membership.holdingId,
      dealershipId: membership.dealershipId,
    })),
    permissionTemplates: templateAssignments.map((assignment) => ({
      id: assignment.template.id,
      name: assignment.template.name,
      description: assignment.template.description,
      permissions: JSON.parse(assignment.template.permissionsJson || '[]'),
    })),
  };
}

async function getAccountForRequest(req: Request) {
  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;
  const payload = verifyAuthToken(token, tokenSecret());
  if (!payload) return null;
  return prisma.account.findUnique({
    where: { id: payload.sub },
    include: {
      memberships: true,
      permissionTemplateAssignments: {
        include: {
          template: true,
        },
      },
    },
  });
}

declare global {
  namespace Express {
    interface Request {
      authAccount?: AccountWithMemberships | null;
    }
  }
}

export async function handleAuthLogin(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as { email?: string; password?: string };
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';

  if (!email || !password) {
    res.status(400).json({ error: 'Email и пароль обязательны.' });
    return;
  }

  const account = await prisma.account.findUnique({
    where: { email },
    include: {
      memberships: true,
      permissionTemplateAssignments: {
        include: {
          template: true,
        },
      },
    },
  });

  if (!account || account.status !== 'active' || !verifyPassword(password, account.passwordHash)) {
    res.status(401).json({ error: 'Неверный email или пароль.' });
    return;
  }

  await prisma.account.update({
    where: { id: account.id },
    data: { lastLoginAt: new Date() },
  }).catch(() => {});

  const analyticsMembershipOrder: Array<{ membershipRole: string; productRole: ProductRole }> = [
    { membershipRole: 'platform_superadmin', productRole: 'platform_superadmin' },
    { membershipRole: 'holding_admin', productRole: 'holding_admin' },
    { membershipRole: 'dealership_admin', productRole: 'dealership_admin' },
    { membershipRole: 'manager', productRole: 'manager' },
  ];
  const analyticsRole = analyticsMembershipOrder.find((candidate) =>
    account.memberships.some((membership) => membership.role === candidate.membershipRole),
  );
  const analyticsMembership = analyticsRole
    ? account.memberships.find((membership) => membership.role === analyticsRole.membershipRole)
    : null;
  if (analyticsRole) {
    void recordProductEvent({
      eventName: 'login_succeeded',
      accountId: account.id,
      role: analyticsRole.productRole,
      holdingId: analyticsMembership?.holdingId ?? null,
      dealershipId: analyticsMembership?.dealershipId ?? null,
    }).catch((error) => {
      console.warn('[analytics] failed to record login:', error instanceof Error ? error.message : error);
    });
  }

  const token = createAuthToken({ sub: account.id, email: account.email }, tokenSecret());
  res.json({
    token,
    ...accountToAuthPayload(account),
  });
}

export async function handleAuthMe(req: Request, res: Response): Promise<void> {
  const account = await getAccountForRequest(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  req.authAccount = account;
  res.json(accountToAuthPayload(account));
}

export async function adminApiAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const account = await getAccountForRequest(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  req.authAccount = account;
  Sentry.getIsolationScope().setUser({ id: account.id });
  next();
}
