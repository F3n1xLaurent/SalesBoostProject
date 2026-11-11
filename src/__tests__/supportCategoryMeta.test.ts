import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ installation: null as any }));
vi.mock('../db', () => ({ prisma: { supportBitrixInstallation: { findFirst: async () => mocks.installation } } }));
vi.mock('../config', () => ({ config: { bitrix24SupportTokenKey: 'test-category-cache-token-key-32chars', bitrix24SupportFieldsJson: undefined } }));
afterEach(() => { vi.unstubAllGlobals(); });

describe('support meta with a slow upstream', () => {
  it('responds with fallback immediately, then cached Bitrix values, and performs one fields request', async () => {
    const api = await import('../support/bitrix24');
    const { handleGetSupportMeta } = await import('../support/http');
    mocks.installation = { memberId: 'test', clientEndpoint: 'https://bitrix.example.test/rest/',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000), accessTokenEncrypted: api.encryptBitrixToken('private-token') };
    let release!: (value: any) => void;
    const fetch = vi.fn(() => new Promise<any>(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const json = vi.fn();
    await handleGetSupportMeta({} as any, { json } as any);
    expect(json.mock.calls[0][0].categories).toContain('technical_issue');
    expect(json.mock.calls[0][0].categoriesPending).toBe(true);
    for (let i = 0; i < 30; i++) api.getCachedBitrixSupportCategories();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release({ ok: true, json: async () => ({ result: { UF_CRM_CATEGORY: {
      title: 'Категория технической поддержки', items: [{ VALUE: 'Помощь с доступом' }],
    } } }) });
    await api.refreshBitrixSupportCategories();
    await handleGetSupportMeta({} as any, { json } as any);
    expect(json.mock.calls.at(-1)?.[0].categories).toEqual(['Помощь с доступом']);
    expect(json.mock.calls.at(-1)?.[0].categoriesPending).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
