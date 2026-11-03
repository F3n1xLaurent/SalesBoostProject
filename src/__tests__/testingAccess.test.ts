import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireTestingSuperadmin } from '../testing/access';

function checkAccess(roles?: string[]) {
  const req = {
    authAccount: roles ? { memberships: roles.map((role) => ({ role })) } : null,
    get: () => 'super',
  } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  requireTestingSuperadmin(req, res as unknown as Response, next);
  return { res, next };
}

describe('testing API access', () => {
  it('requires authentication', () => {
    const { res, next } = checkAccess();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([[], ['holding_admin'], ['dealership_admin'], ['manager'], ['holding_admin', 'dealership_admin']])(
    'rejects non-superadmin memberships %j even with a super role header', (...roles) => {
      const { res, next } = checkAccess(roles);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('allows a platform superadmin with multiple memberships', () => {
    const { res, next } = checkAccess(['holding_admin', 'platform_superadmin']);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
