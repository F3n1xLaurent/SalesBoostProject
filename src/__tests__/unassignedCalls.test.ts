import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { prisma } from '../db';
import { attributeCallToIntroducedManager } from '../voice/callManagerAttribution';
import { assignUnassignedCall, listUnassignedCalls, unassignedCallsAccess, unassignedCallsScope, withUnassignedCallsReadScope } from '../voice/unassignedCalls';
vi.mock('../db', () => ({ prisma: { $transaction: vi.fn(), voiceCallSession: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() }, managerProfile: { findMany: vi.fn() }, dealership: { findMany: vi.fn() } } }));
function account(role = 'dealership_admin', permissions?: string[]) {
  return { id: 'actor', memberships: [{ role, dealershipId: 'branch', holdingId: null }],
    permissionTemplateAssignments: permissions ? [{ template: { isSystem: false, permissionsJson: JSON.stringify(permissions) } }] : [] } as any;
}
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() }) as unknown as Response;
const request = (actor = account()) => ({ authAccount: actor, params: { id: '1' }, body: { managerId: 'nikolay' }, query: {} }) as unknown as Request;
const tx = { voiceCallSession: { findFirst: vi.fn(), updateMany: vi.fn() }, managerProfile: { findFirst: vi.fn() }, callPlanCall: { updateMany: vi.fn() } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx));
  tx.voiceCallSession.findFirst.mockResolvedValue({ id: 1, callId: 'call', dealershipId: 'branch' });
  tx.managerProfile.findFirst.mockResolvedValue({ id: 'nikolay', fullName: 'Николай Иванов' });
  tx.voiceCallSession.updateMany.mockResolvedValue({ count: 1 });
});
describe('unassigned calls RBAC and attribution', () => {
  it('grants supervisors access and permits a custom read-only role without inherited writes', () => {
    expect(unassignedCallsAccess(account())).toEqual({ view: true, assign: true });
    expect(unassignedCallsAccess(account('manager'))).toEqual({ view: false, assign: false });
    for (const role of ['manager', 'dealership_admin']) {
      expect(unassignedCallsAccess(account(role, ['unassigned_calls.view']))).toEqual({ view: true, assign: false });
    }
  });
  it('retains branch scope for custom roles and denies accounts without organizations', () => {
    expect(unassignedCallsScope(account('manager', ['unassigned_calls.view']))).toEqual({ OR: [{ id: 'branch' }] });
    expect(unassignedCallsScope({ ...account(), memberships: [] })).toEqual({ OR: [] });
  });
  it('grants read-only report and playback access only to unassigned calls in the membership scope', () => {
    const ownCalls = { manager: { accountId: 'actor' } };
    expect(withUnassignedCallsReadScope(account('manager', ['unassigned_calls.view']), ownCalls)).toEqual({
      OR: [ownCalls, { AND: [expect.objectContaining({ managerId: null, endedAt: { not: null }, source: { not: 'demo' } }),
        { dealership: { OR: [{ id: 'branch' }] } }] }],
    });
  });
  it('does not broaden report access without module view permission', () => {
    const ownCalls = { manager: { accountId: 'actor' } };
    expect(withUnassignedCallsReadScope(account('manager'), ownCalls)).toEqual(ownCalls);
    expect(withUnassignedCallsReadScope(account('manager', ['unassigned_calls.assign']), ownCalls)).toEqual(ownCalls);
  });
  it('denies both listing and assignment without access', async () => {
    const req = request(account('manager')), res = response();
    await listUnassignedCalls(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    await assignUnassignedCall(req, res);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.voiceCallSession.findMany).not.toHaveBeenCalled();
  });
  it('rejects assignment for a read-only role even via direct API request', async () => {
    const res = response();
    await assignUnassignedCall(request(account('dealership_admin', ['unassigned_calls.view'])), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('updates the analytics manager relation, scheduled call and attribution author together', async () => {
    const res = response(); await assignUnassignedCall(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(tx.voiceCallSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      managerId: 'nikolay', attributionType: 'manager', attributionSource: 'manual_assignment',
      attributionEvidence: expect.stringContaining('actor'),
    }) }));
    expect(tx.callPlanCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { employeeId: 'nikolay', employeeName: 'Николай Иванов' } }));
    expect(tx.managerProfile.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ dealershipId: 'branch', status: 'active' }) }));
  });
  it('rejects an inaccessible or already assigned call', async () => {
    tx.voiceCallSession.findFirst.mockResolvedValue(null);
    const res = response(); await assignUnassignedCall(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(tx.voiceCallSession.updateMany).not.toHaveBeenCalled();
    expect(tx.voiceCallSession.findFirst.mock.calls[0][0].where.AND).toContainEqual({ dealership: { OR: [{ id: 'branch' }] } });
  });
  it('rejects employees outside the branch or inactive employees', async () => {
    tx.managerProfile.findFirst.mockResolvedValue(null);
    const res = response(); await assignUnassignedCall(request(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(tx.voiceCallSession.updateMany).not.toHaveBeenCalled();
  });
  it('lists only ended, unassigned shared-number calls within the granted organization', async () => {
    vi.mocked(prisma.voiceCallSession.findMany).mockResolvedValue([]);
    vi.mocked(prisma.voiceCallSession.count).mockResolvedValue(0);
    vi.mocked(prisma.dealership.findMany).mockResolvedValue([]);
    const res = response();
    await listUnassignedCalls(request(account('manager', ['unassigned_calls.view'])), res);
    expect(prisma.voiceCallSession.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [
      expect.objectContaining({ managerId: null, endedAt: { not: null }, OR: [{ attributionType: 'dealership' }, { phoneNumberOwnership: 'dealership' }] }),
      { dealership: { OR: [{ id: 'branch' }] } },
    ] } }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ canAssign: false, calls: [] }));
  });
  it('applies normalized phone search and date boundaries before counting and pagination', async () => {
    vi.mocked(prisma.voiceCallSession.count).mockResolvedValue(71);
    vi.mocked(prisma.voiceCallSession.findMany).mockResolvedValue([]);
    vi.mocked(prisma.dealership.findMany).mockResolvedValue([]);
    const req = request();
    req.query = { q: '8 (999) 123-45-67', from: '2026-11-01T00:00:00+03:00', to: '2026-11-20T00:00:00+03:00', page: '2', pageSize: '25' };
    const res = response(); await listUnassignedCalls(req, res);
    const where = vi.mocked(prisma.voiceCallSession.count).mock.calls[0][0]!.where;
    expect(where).toEqual({ AND: [expect.anything(), { dealership: { OR: [{ id: 'branch' }] } },
      { startedAt: { gte: new Date('2026-10-31T21:00:00Z'), lt: new Date('2026-11-19T21:00:00Z') } },
      { OR: [{ callId: { contains: '8 (999) 123-45-67' } }, { to: { contains: '79991234567' } }] },
    ] });
    expect(prisma.voiceCallSession.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 25, take: 25 }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ total: 71, page: 2, pageSize: 25, totalPages: 3 }));
  });
  it('searches the displayed numeric call ID and clamps an emptied last page', async () => {
    vi.mocked(prisma.voiceCallSession.count).mockResolvedValue(11);
    vi.mocked(prisma.voiceCallSession.findMany).mockResolvedValue([]);
    vi.mocked(prisma.dealership.findMany).mockResolvedValue([]);
    const req = request(); req.query = { q: '#123', page: '99', pageSize: '10' };
    const res = response(); await listUnassignedCalls(req, res);
    expect(prisma.voiceCallSession.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10,
      where: { AND: [expect.anything(), expect.anything(), { OR: [{ callId: { contains: '#123' } }, { id: 123 }] }] } }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ page: 2, totalPages: 2 }));
  });
  it('rejects invalid or reversed periods before querying calls', async () => {
    for (const query of [{ from: 'not-a-date' }, { from: '2026-11-20', to: '2026-11-19' }]) {
      const req = request(); req.query = query;
      const res = response(); await listUnassignedCalls(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(prisma.voiceCallSession.count).not.toHaveBeenCalled();
  });
  it('preserves a manual assignment made while automatic attribution was running', async () => {
    vi.mocked(prisma.voiceCallSession.findUnique).mockResolvedValue({ source: 'scheduled', dealershipId: 'branch', managerId: null, attributionType: 'dealership' } as any);
    vi.mocked(prisma.managerProfile.findMany).mockResolvedValue([{ id: 'auto', fullName: 'Николай Иванов' }] as any);
    tx.voiceCallSession.updateMany.mockResolvedValue({ count: 0 });
    await attributeCallToIntroducedManager('call', [{ role: 'manager', text: 'Добрый день, меня зовут Николай Иванов.' }]);
    expect(tx.voiceCallSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { callId: 'call', managerId: null, attributionType: 'dealership' } }));
    expect(tx.callPlanCall.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a concurrent second assignment without changing scheduled call attribution', async () => {
    tx.voiceCallSession.updateMany.mockResolvedValue({ count: 0 });
    const res = response(); await assignUnassignedCall(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(tx.callPlanCall.updateMany).not.toHaveBeenCalled();
  });
});
