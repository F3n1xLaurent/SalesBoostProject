import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApiAuthMiddleware, handleAuthMe } from '../auth/http';
import { createAuthToken } from '../auth/token';
import { prisma } from '../db';

vi.mock('../db', () => ({ prisma: { account: { findUnique: vi.fn() } } }));
vi.mock('../config', () => ({ config: { authTokenSecret: 'test-secret' } }));
vi.mock('../analytics/productAnalytics', () => ({ recordProductEvent: vi.fn(), toEventRole: () => 'company_admin', getProductOrganizationContext: async () => ({ companyId: 'company', branchId: null }) }));
const token = createAuthToken({ sub: 'account', email: 'user@example.test' }, 'test-secret');
const request = () => ({ get: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer ' + token : 'company' }) as unknown as Request;
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() }) as unknown as Response;
const account = (role = 'platform_superadmin', status = 'active') => ({ id: 'account', email: 'user@example.test', displayName: 'User', status,
  memberships: [{ id: 'membership', role, holdingId: 'company', dealershipId: null }],
  permissionTemplateAssignments: [{ template: { id: 'template', name: 'Template', description: null, permissionsJson: '["users.view"]' } }],
});
beforeEach(() => vi.clearAllMocks());

describe('existing tokens use current account access', () => {
  it('returns changed roles and permissions without issuing another token', async () => {
    vi.mocked(prisma.account.findUnique).mockResolvedValueOnce(account() as any);
    const first = response(); await handleAuthMe(request(), first);
    expect(first.json).toHaveBeenCalledWith(expect.objectContaining({ allowedRoles: ['super'] }));
    const changed = account('holding_admin'); changed.permissionTemplateAssignments[0].template.permissionsJson = '["reports.view"]';
    vi.mocked(prisma.account.findUnique).mockResolvedValueOnce(changed as any);
    const second = response(); await handleAuthMe(request(), second);
    expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ allowedRoles: ['company'], permissionTemplates: [expect.objectContaining({ permissions: ['reports.view'] })] }));
    expect(second.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(prisma.account.findUnique).toHaveBeenCalledTimes(2);
  });
  it('loads the new memberships for protected requests using the same token', async () => {
    vi.mocked(prisma.account.findUnique).mockResolvedValueOnce(account('holding_admin') as any);
    const req = request(), next = vi.fn(); await adminApiAuthMiddleware(req, response(), next);
    expect(next).toHaveBeenCalledOnce(); expect(req.authAccount?.memberships[0].role).toBe('holding_admin');
  });
  it('rejects an inactive account immediately on session and protected endpoints', async () => {
    vi.mocked(prisma.account.findUnique).mockResolvedValue(account('holding_admin', 'blocked') as any);
    const me = response(); await handleAuthMe(request(), me); expect(me.status).toHaveBeenCalledWith(401);
    const api = response(), next = vi.fn(); await adminApiAuthMiddleware(request(), api, next);
    expect(api.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();
  });
});
