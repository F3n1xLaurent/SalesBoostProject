import { allSettled, fork } from 'effector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '../api/api';
import { $auth, authAccessKey, bootstrapAuth, type AuthUser } from './model';
import { readStoredAuth } from '../lib/storage';
import { writeStoredRole } from '../lib/roleStorage';

vi.mock('../api/api', () => ({ apiJson: vi.fn() }));
vi.mock('../lib/storage', () => ({ clearStoredAuth: vi.fn(), writeStoredAuth: vi.fn(), readStoredAuth: vi.fn() }));
vi.mock('../lib/roleStorage', () => ({ readCurrentStoredRole: () => 'super', writeStoredRole: vi.fn() }));
const api = vi.mocked(apiJson);
const user = (role: 'super' | 'company' = 'super'): AuthUser => ({
  account: { id: 'a', email: 'a@example.test', displayName: null, status: 'active' },
  allowedRoles: [role], defaultRole: role,
  memberships: [{ id: 'membership', role: role === 'super' ? 'platform_superadmin' : 'holding_admin', holdingId: role === 'super' ? null : 'company', dealershipId: null }],
  permissionTemplates: [{ id: 'template', name: 'Template', description: null, permissions: ['users.view'] }],
});
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readStoredAuth).mockReturnValue({ token: 'token-a' }); });
afterEach(() => vi.useRealTimers());

describe('permissions loaded on page reload', () => {
  it('loads current roles and templates with the stored token, without another login', async () => {
    const scope = fork(), updated = user('company');
    updated.permissionTemplates![0].permissions = ['reports.view']; api.mockResolvedValueOnce(updated);
    await allSettled(bootstrapAuth, { scope });
    expect(scope.getState($auth)).toMatchObject({ status: 'authenticated', token: 'token-a', user: updated });
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/auth/me', { cache: 'no-store' });
    expect(writeStoredRole).toHaveBeenCalledWith('a', 'company');
  });
  it('fetches the latest access again when the page bootstraps after a reload', async () => {
    const first = fork(); api.mockResolvedValueOnce(user()); await allSettled(bootstrapAuth, { scope: first });
    const reloaded = fork(); api.mockResolvedValueOnce(user('company')); await allSettled(bootstrapAuth, { scope: reloaded });
    expect(first.getState($auth)).toMatchObject({ user: { allowedRoles: ['super'] } });
    expect(reloaded.getState($auth)).toMatchObject({ token: 'token-a', user: { allowedRoles: ['company'] } });
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('does not schedule periodic permission requests after bootstrap', async () => {
    vi.useFakeTimers(); const scope = fork(); api.mockResolvedValueOnce(user());
    await allSettled(bootstrapAuth, { scope }); await vi.advanceTimersByTimeAsync(120_000);
    expect(api).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not request account data when no stored token exists', async () => {
    vi.mocked(readStoredAuth).mockReturnValue(null); const scope = fork(); await allSettled(bootstrapAuth, { scope });
    expect(scope.getState($auth).status).toBe('guest'); expect(api).not.toHaveBeenCalled();
  });
  it('changes the access key for scopes or permissions, but not profile text', () => {
    const original = user(), renamed = { ...original, account: { ...original.account, displayName: 'New name' } };
    expect(authAccessKey(renamed)).toBe(authAccessKey(original));
    expect(authAccessKey(user('company'))).not.toBe(authAccessKey(original));
    const changed = user(); changed.permissionTemplates![0].permissions = [];
    expect(authAccessKey(changed)).not.toBe(authAccessKey(original));
  });
});
