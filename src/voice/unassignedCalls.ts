import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { PERMISSIONS, ROLE_PERMISSION_PRESETS, type AppRole, type PermissionKey } from '../auth/permissions';

type Account = NonNullable<Request['authAccount']>;

/** Custom templates define this module's access; memberships still constrain organizations. */
export function unassignedCallsAccess(account: Account | null | undefined) {
  const allowed = (permission: PermissionKey) => {
    if (!account) return false;
    if (account.memberships.some(m => m.role === 'platform_superadmin')) return true;
    const custom = account.permissionTemplateAssignments.filter(a => !a.template.isSystem);
    if (custom.length) return custom.some(a => {
      try { return JSON.parse(a.template.permissionsJson).includes(permission); } catch { return false; }
    });
    return account.memberships.some(m => ROLE_PERMISSION_PRESETS[m.role as AppRole]?.has(permission)) ||
      account.permissionTemplateAssignments.some(a => {
        try { return JSON.parse(a.template.permissionsJson).includes(permission); } catch { return false; }
      });
  };
  return { view: allowed(PERMISSIONS.unassignedCalls.view), assign: allowed(PERMISSIONS.unassignedCalls.assign) };
}

export function unassignedCallsScope(account: Account): Prisma.DealershipWhereInput {
  if (account.memberships.some(m => m.role === 'platform_superadmin')) return {};
  return { OR: account.memberships.flatMap<Prisma.DealershipWhereInput>(m => {
    if (m.role === 'holding_admin' && m.holdingId) return [{ holdingId: m.holdingId }];
    if (m.dealershipId) return [{ id: m.dealershipId }];
    return [];
  }) };
}

export const unassignedCallWhere: Prisma.VoiceCallSessionWhereInput = {
  managerId: null,
  dealershipId: { not: null },
  endedAt: { not: null },
  source: { not: 'demo' },
  OR: [{ attributionType: 'dealership' }, { phoneNumberOwnership: 'dealership' }],
};

/** Report and playback may be read with module access, within its original call scope. */
export function withUnassignedCallsReadScope(
  account: Account | null | undefined,
  existingScope: Prisma.VoiceCallSessionWhereInput,
): Prisma.VoiceCallSessionWhereInput {
  // An empty scope already permits every call. Prisma ignores {} inside OR,
  // so wrapping it would restrict superadmins to the unassigned branch only.
  if (Object.keys(existingScope).length === 0) return existingScope;
  if (!account || !unassignedCallsAccess(account).view) return existingScope;
  return { OR: [existingScope, { AND: [unassignedCallWhere, { dealership: unassignedCallsScope(account) }] }] };
}

export async function listUnassignedCalls(req: Request, res: Response) {
  const access = unassignedCallsAccess(req.authAccount);
  if (!access.view || !req.authAccount) return res.status(403).json({ error: 'Нет права просмотра нераспределённых звонков.' });
  const requestedPage = Number(req.query.page);
  const requestedPageSize = Number(req.query.pageSize);
  const pageSize = [10, 25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 25;
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  const filters: Prisma.VoiceCallSessionWhereInput[] = [];
  const from = typeof req.query.from === 'string' && req.query.from ? new Date(req.query.from) : null;
  const to = typeof req.query.to === 'string' && req.query.to ? new Date(req.query.to) : null;
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from >= to)) {
    return res.status(400).json({ error: 'Укажите корректный период звонков.' });
  }
  if (from || to) filters.push({ startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } });
  if (query) {
    const numericId = /^(?:#|call-)?(\d+)$/i.exec(query)?.[1];
    const id = numericId ? Number(numericId) : NaN;
    let phone = /^[+\d\s().-]+$/.test(query) ? query.replace(/\D/g, '') : '';
    if (phone.length === 11 && phone.startsWith('8')) phone = '7' + phone.slice(1);
    filters.push({ OR: [
      { callId: { contains: query.toLowerCase() } },
      ...(phone ? [{ to: { contains: phone } }] : []),
      ...(Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? [{ id }] : []),
    ] });
  }
  const scope = unassignedCallsScope(req.authAccount);
  const where: Prisma.VoiceCallSessionWhereInput = { AND: [unassignedCallWhere, { dealership: scope }, ...filters] };
  const total = await prisma.voiceCallSession.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, totalPages);
  const [calls, dealerships] = await Promise.all([
    prisma.voiceCallSession.findMany({ where, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
      select: { id: true, callId: true, to: true, startedAt: true, durationSec: true, outcome: true, totalScore: true,
        attributionIntroducedName: true, dealershipId: true, phoneNumberTypeName: true,
        dealership: { select: { name: true } } } }),
    prisma.dealership.findMany({ where: scope, orderBy: { name: 'asc' }, select: { id: true, name: true,
      managerProfiles: { where: { status: 'active', OR: [{ accountId: null }, { account: { is: { status: 'active' } } }] },
        select: { id: true, fullName: true, email: true }, orderBy: [{ fullName: 'asc' }, { id: 'asc' }] } } }),
  ]);
  return res.json({ calls, total, page, pageSize, totalPages, dealerships, canAssign: access.assign });
}

export async function assignUnassignedCall(req: Request, res: Response) {
  const access = unassignedCallsAccess(req.authAccount);
  if (!access.view || !access.assign || !req.authAccount) return res.status(403).json({ error: 'Нет права назначения ответственного.' });
  const id = Number(req.params.id);
  const managerId = typeof req.body?.managerId === 'string' ? req.body.managerId.trim() : '';
  if (!Number.isSafeInteger(id) || id <= 0 || !managerId) return res.status(400).json({ error: 'Укажите звонок и ответственного сотрудника.' });
  const account = req.authAccount;
  const result = await prisma.$transaction(async tx => {
    const call = await tx.voiceCallSession.findFirst({ where: { AND: [{ id }, unassignedCallWhere, { dealership: unassignedCallsScope(account) }] } });
    if (!call) return { status: 409, error: 'Звонок уже распределён или недоступен. Обновите список.' };
    const manager = await tx.managerProfile.findFirst({ where: { id: managerId, dealershipId: call.dealershipId!, status: 'active',
      OR: [{ accountId: null }, { account: { is: { status: 'active' } } }] } });
    if (!manager) return { status: 400, error: 'Выберите активного сотрудника этой точки.' };
    const updated = await tx.voiceCallSession.updateMany({ where: { AND: [{ id }, unassignedCallWhere] }, data: {
      managerId, attributionType: 'manager', attributionSource: 'manual_assignment', attributionReason: 'assigned_by_supervisor',
      attributionConfidence: 1, attributionEvidence: JSON.stringify({ accountId: account.id, assignedAt: new Date().toISOString() }),
    } });
    if (!updated.count) return { status: 409, error: 'Звонок уже распределён. Обновите список.' };
    await tx.callPlanCall.updateMany({ where: { callId: call.callId, targetKind: 'dealership', employeeId: null },
      data: { employeeId: manager.id, employeeName: manager.fullName } });
    return { status: 200 };
  });
  return res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
}
