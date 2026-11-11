import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createHttpPerformanceMiddleware, instrumentPrismaHttpTiming, measureHttpStage, type HttpPerformanceLog } from '../diagnostics/httpPerformance';

const directory = mkdtempSync(join(tmpdir(), 'http-performance-'));
const db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
instrumentPrismaHttpTiming(db);
afterAll(async () => { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

function fixtures(path: string) {
  const headers = new Map<string, string>();
  const res = Object.assign(new EventEmitter(), { statusCode: 200,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value); },
    writeHead: () => res,
  });
  const req = { originalUrl: path, method: 'GET', route: { path: path.startsWith('/api/admin/') ? '/api/admin/users/:accountId' : '/api/support/meta' },
    params: { accountId: 'private-account-id' }, headers: { authorization: 'Bearer secret-authorization' } };
  return { req, res, headers };
}

async function request(path: string, task: () => Promise<unknown>, options: { enabled?: boolean; slowMs?: number } = {}) {
  const data = fixtures(path), logs: HttpPerformanceLog[] = [];
  await new Promise<void>(resolve => {
    createHttpPerformanceMiddleware({ slowMs: 0, ...options, log: record => logs.push(record) })(data.req as any, data.res as any, () => {
      void (async () => {
        try { await task(); } catch { data.res.statusCode = 500; }
        data.res.writeHead(); data.res.emit('finish'); data.res.emit('close'); resolve();
      })();
    });
  });
  return { ...data, logs };
}

describe('HTTP route diagnostics', () => {
  it('preserves existing Server-Timing and identifies the static billing router mount', () => {
    const { req, res, headers } = fixtures('/api/admin/billing/payments/private-id');
    Object.assign(req, { baseUrl: '/api/admin/billing', route: { path: '/payments/:paymentId' } });
    res.setHeader('Server-Timing', 'cache;dur=1');
    const logs: HttpPerformanceLog[] = [];
    createHttpPerformanceMiddleware({ slowMs: 0, log: record => logs.push(record) })(req as any, res as any, () => {
      res.writeHead(); res.emit('finish');
    });
    expect(logs[0].route).toBe('/api/admin/billing/payments/:paymentId');
    expect(headers.get('server-timing')).toMatch(/^cache;dur=1, app;dur=/);
  });
  it('measures real Prisma operations and auth without recording SQL, credentials, params or query strings', async () => {
    const result = await request('/api/admin/users/private-account-id?token=secret-query',
      () => measureHttpStage('auth', () => db.$queryRawUnsafe("SELECT 'private-sql-value' AS email")));
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({ route: '/api/admin/users/:accountId', dbCount: 1, status: 200, stages: { auth: { count: 1 } } });
    expect(result.logs[0].dbTop[0].operation).toContain('queryRaw');
    expect(result.headers.get('server-timing')).toContain('app;dur=');
    expect(result.headers.get('server-timing')).toContain('auth;dur=');
    expect(result.headers.get('x-request-id')).toBe(result.logs[0].requestId);
    const serialized = JSON.stringify(result.logs);
    for (const secret of ['private-account-id', 'secret-query', 'secret-authorization', 'private-sql-value', 'SELECT']) expect(serialized).not.toContain(secret);
  });

  it('isolates simultaneous requests and records a failed stage as well', async () => {
    const [admin, support] = await Promise.all([
      request('/api/admin/users', () => measureHttpStage('auth', () => db.$queryRawUnsafe('SELECT 1'))),
      request('/api/support/meta', () => measureHttpStage('support_categories', async () => {
        await db.$queryRawUnsafe('SELECT 1'); await db.$queryRawUnsafe('SELECT 2');
        await measureHttpStage('bitrix_http', async () => { throw new Error('private-upstream-url'); });
      })),
    ]);
    expect(admin.logs[0]).toMatchObject({ dbCount: 1, stages: { auth: { count: 1 } } });
    expect(admin.logs[0].stages).not.toHaveProperty('bitrix_http');
    expect(support.logs[0]).toMatchObject({ status: 500, dbCount: 2, stages: { support_categories: { count: 1 }, bitrix_http: { count: 1 } } });
    expect(support.logs[0].stages).not.toHaveProperty('auth');
    expect(support.logs[0].requestId).not.toBe(admin.logs[0].requestId);
    expect(JSON.stringify(support.logs)).not.toContain('private-upstream-url');
  });

  it('does not instrument unrelated endpoints and supports disabling diagnostics', async () => {
    for (const path of ['/health', '/webhooks/vox', '/api/public/support/meta', '/api/admin-extra']) {
      const result = await request(path, async () => {});
      expect(result.logs).toEqual([]); expect(result.headers.has('server-timing')).toBe(false);
    }
    const disabled = await request('/api/support/meta', async () => {}, { enabled: false });
    expect(disabled.logs).toEqual([]); expect(disabled.headers.has('x-request-id')).toBe(false);
  });

  it('keeps fast responses quiet but always logs server errors', async () => {
    expect((await request('/api/support/meta', async () => {}, { slowMs: 1e8 })).logs).toEqual([]);
    const failed = await request('/api/support/meta', async () => { throw new Error('error'); }, { slowMs: 1e8 });
    expect(failed.logs).toHaveLength(1); expect(failed.logs[0].status).toBe(500);
  });

  it('records a disconnected client once without logging an unmatched raw path', () => {
    const { req, res, headers } = fixtures('/api/admin/private-id?access_token=private-token');
    delete (req as any).route;
    const logs: HttpPerformanceLog[] = [];
    createHttpPerformanceMiddleware({ log: record => logs.push(record) })(req as any, res as any, () => {});
    res.emit('close'); res.emit('close');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ aborted: true, status: 499, headersMs: null, route: '/api/admin/:unmatched' });
    expect(JSON.stringify(logs)).not.toContain('private-');
    expect(headers.has('x-request-id')).toBe(true);
  });

  it('stops collecting background operations after the HTTP response has finished', async () => {
    let release!: () => void, pending!: Promise<unknown>;
    const result = await request('/api/admin/users', async () => {
      pending = new Promise<void>(resolve => { release = resolve; }).then(() =>
        measureHttpStage('bitrix_http', () => db.$queryRawUnsafe('SELECT 1')));
    });
    release(); await pending;
    expect(result.logs[0]).toMatchObject({ dbCount: 0, stages: {} });
  });

  it('identifies the in-flight auth/database wait when the client aborts before completion', async () => {
    let queryMiddleware: any, release!: () => void, pending!: Promise<unknown>;
    instrumentPrismaHttpTiming({ $use: middleware => { queryMiddleware = middleware; } });
    const { req, res } = fixtures('/api/admin/users');
    const logs: HttpPerformanceLog[] = [];
    createHttpPerformanceMiddleware({ log: record => logs.push(record) })(req as any, res as any, () => {
      pending = measureHttpStage('auth', () => queryMiddleware({ model: 'Account', action: 'findUnique' },
        () => new Promise<void>(resolve => { release = resolve; })));
    });
    res.emit('close');
    expect(logs[0]).toMatchObject({ status: 499, dbInFlight: 1, pendingStages: { auth: 1 } });
    release(); await pending;
    expect(logs).toHaveLength(1);
  });
});
