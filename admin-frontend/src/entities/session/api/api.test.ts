import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';
import { clearStoredAuth, readStoredAuth } from '../lib/storage';
vi.mock('../lib/storage', () => ({ clearStoredAuth: vi.fn(), readStoredAuth: vi.fn() }));
vi.mock('../lib/roleStorage', () => ({ readCurrentStoredRole: () => 'company' }));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', new EventTarget()); vi.mocked(readStoredAuth).mockReturnValue({ token: 'a' }); });
afterEach(() => vi.unstubAllGlobals());
describe('access changes in API responses', () => {
  it('returns 403 without background refresh, logging out or replaying the denied operation', async () => {
    const changed = vi.fn(); window.addEventListener('auth:refresh', changed);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 })); vi.stubGlobal('fetch', fetch);
    expect((await apiFetch('/api/admin/users', { method: 'POST' })).status).toBe(403);
    expect(changed).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce(); expect(clearStoredAuth).not.toHaveBeenCalled();
  });
  it('ends the current session on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await apiFetch('/api/auth/me'); expect(clearStoredAuth).toHaveBeenCalledOnce();
  });
  it('does not log out a new account because an old request returned 401', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = apiFetch('/api/admin/users'); vi.mocked(readStoredAuth).mockReturnValue({ token: 'b' });
    finish(new Response(null, { status: 401 })); await pending;
    expect(clearStoredAuth).not.toHaveBeenCalled();
  });
});
