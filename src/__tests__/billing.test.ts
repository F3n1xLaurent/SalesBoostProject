import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const state = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }));
vi.mock('../db', () => ({ get prisma() { return state.prisma; } }));
import { billingRouter, paymentInput } from '../billing/http';
import { assertCompanyModule, assertDealershipModule, BillingAccessError, calculateBillingAccess } from '../billing/access';
import { isTabAllowedForRole, parseAdminPath } from '../../admin-frontend/src/shared/routing/adminRoutes';

const at = new Date('2026-11-02T12:00:00Z');
const grant = { calls: true, trainer: false, status: 'active', startsAt: new Date('2026-11-01T00:00:00Z'), endsAt: null };
const payment = { amountKopecks: 500000, paidAt: '2026-11-02T00:00:00Z', startsAt: '2026-11-01T00:00:00Z', endsAt: null,
  calls: true, trainer: false, comment: 'Договор №123, обзвон точек', status: 'active' };

describe('company module access', () => {
  it('keeps existing access when billing is disabled; enabling without payments blocks both modules', () => {
    expect(calculateBillingAccess(false, [], at)).toEqual({ calls: true, trainer: true });
    expect(calculateBillingAccess(true, [], at)).toEqual({ calls: false, trainer: false });
  });
  it('unions modules from separate payments, excluding cancelled, future and expired payments', () => {
    expect(calculateBillingAccess(true, [grant, { ...grant, calls: false, trainer: true }], at)).toEqual({ calls: true, trainer: true });
    for (const extra of [{ status: 'cancelled' }, { startsAt: new Date('2026-12-01') }, { endsAt: new Date('2026-11-01') }]) {
      expect(calculateBillingAccess(true, [{ ...grant, trainer: true, ...extra }], at)).toEqual({ calls: false, trainer: false });
    }
  });
  it('includes exact access boundaries', () => {
    expect(calculateBillingAccess(true, [{ ...grant, startsAt: at, endsAt: at }], at).calls).toBe(true);
    expect(calculateBillingAccess(true, [{ ...grant, endsAt: new Date(at.getTime() - 1) }], at).calls).toBe(false);
  });
  it('validates money, modules, comment and period', () => {
    expect(paymentInput.safeParse(payment).success).toBe(true);
    for (const change of [{ amountKopecks: 0 }, { amountKopecks: 10.5 }, { amountKopecks: 2147483648 }, { calls: false }, { comment: '   ' }, { endsAt: '2026-10-01T00:00:00Z' }, { paidAt: 'not-a-date' }]) {
      expect(paymentInput.safeParse({ ...payment, ...change }).success).toBe(false);
    }
  });
  it('only exposes the billing route to the superadmin role', () => {
    expect(parseAdminPath('/billing').tab).toBe('billing');
    for (const role of ['company', 'dealer', 'staff'] as const) expect(isTabAllowedForRole('billing', role)).toBe(false);
    expect(isTabAllowedForRole('billing', 'super')).toBe(true);
  });
});

describe('billing API and durable history', () => {
  let directory: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'salesboost-billing-'));
    const databasePath = join(directory, 'test.db');
    writeFileSync(databasePath, '');
    const url = `file:${databasePath}`;
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], {
      env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
    });
    state.prisma = new PrismaClient({ datasources: { db: { url } } });
    await state.prisma.holding.createMany({ data: [{ id: 'one', name: 'Компания 1' }, { id: 'two', name: 'Компания 2' }] });
    await state.prisma.dealership.create({ data: { id: 'dealer', name: 'Точка', holdingId: 'one' } });

  }, 30_000);
  afterAll(async () => {
    if (state.prisma) await state.prisma.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  // Exercise the router with real SQLite storage without binding a network port.
  const request = (path: string, method = 'GET', body?: unknown, role = 'platform_superadmin') => new Promise<{ status: number; ok: boolean; json: () => Promise<any> }>((resolve, reject) => {
    const req = { method, url: path, body, headers: { 'x-admin-role': 'super' },
      authAccount: { id: 'admin', email: 'admin@example.test', displayName: 'Суперадмин', memberships: [{ role }] },
    } as unknown as Request;
    const res = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { resolve({ status: this.statusCode, ok: this.statusCode >= 200 && this.statusCode < 300, json: async () => value }); return this; },
    };
    billingRouter(req, res as unknown as Response, (error?: unknown) => reject(error || new Error('No matching billing route')));
  });
  it('denies every read and write to non-superadmins, even with a super role header', async () => {
    for (const role of ['holding_admin', 'dealership_admin', 'manager']) {
      for (const [path, method, body] of [['/one', 'GET', undefined], ['/one', 'PATCH', { enabled: true }], ['/one/payments', 'POST', payment], ['/one/payments/other', 'PUT', { ...payment, version: 1 }]] as const) {
        expect((await request(path, method, body, role)).status).toBe(403);
      }
    }
    expect(await state.prisma.billingChange.count()).toBe(0);
  });
  it('records two payments, revisions and cancellation without losing earlier snapshots', async () => {
    expect((await request('/one', 'PATCH', { enabled: true })).ok).toBe(true);
    await expect(assertDealershipModule('dealer', 'calls')).rejects.toBeInstanceOf(BillingAccessError);
    const firstResponse = await request('/one/payments', 'POST', payment);
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as { id: string };
    await expect(assertCompanyModule('one', 'calls')).resolves.toBeUndefined();
    await expect(assertCompanyModule('one', 'trainer')).rejects.toBeInstanceOf(BillingAccessError);
    const secondResponse = await request('/one/payments', 'POST', { ...payment, calls: false, trainer: true, comment: 'Доплата 5000 ₽ за тренажёр' });
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json() as { id: string };
    await expect(assertCompanyModule('one', 'trainer')).resolves.toBeUndefined();
    const updated = await request(`/one/payments/${first.id}`, 'PUT', { ...payment, amountKopecks: 1000000, trainer: true, comment: 'Исправлено по договору', version: 1 });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { version: number }).version).toBe(2);
    expect((await request(`/one/payments/${first.id}`, 'PUT', { ...payment, version: 1 })).status).toBe(409);
    expect((await request(`/two/payments/${first.id}`, 'PUT', { ...payment, version: 2 })).status).toBe(404);
    for (const [p, version] of [[first, 2], [second, 1]] as const) {
      expect((await request(`/one/payments/${p.id}`, 'PUT', { ...payment, status: 'cancelled', version })).status).toBe(200);
    }
    await expect(assertCompanyModule('one', 'calls')).rejects.toBeInstanceOf(BillingAccessError);
    await expect(assertCompanyModule('one', 'trainer')).rejects.toBeInstanceOf(BillingAccessError);
    const data = await (await request('/one')).json() as { changes: Array<{ beforeJson: string | null; afterJson: string; actorName: string }> };
    expect(data.changes).toHaveLength(6);
    const revision = data.changes.find((c: { beforeJson: string | null; afterJson: string }) => c.beforeJson && JSON.parse(c.afterJson).version === 2 && JSON.parse(c.afterJson).amountKopecks === 1000000);
    expect(JSON.parse(revision!.beforeJson!)).toMatchObject({ amountKopecks: 500000, trainer: false, comment: payment.comment });
    expect(revision!.actorName).toBe('Суперадмин');
    expect((await request('/one', 'PATCH', { enabled: false })).ok).toBe(true);
    await expect(assertCompanyModule('one', 'trainer')).resolves.toBeUndefined();
    expect((await (await request('/two')).json() as { payments: unknown[] }).payments).toHaveLength(0);
  });
  it('applies the migration without rewriting companies or losing their children', async () => {
    const databasePath = join(directory, 'migration.db');
    writeFileSync(databasePath, '');
    const db = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
    try {
      await db.$executeRawUnsafe('PRAGMA foreign_keys=ON');
      await db.$executeRawUnsafe('CREATE TABLE holdings (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      await db.$executeRawUnsafe("INSERT INTO holdings VALUES ('existing', 'Existing company')");
      await db.$executeRawUnsafe('CREATE TABLE children (holdingId TEXT REFERENCES holdings(id) ON DELETE CASCADE)');
      await db.$executeRawUnsafe("INSERT INTO children VALUES ('existing')");
      const sql = readFileSync('prisma/migrations/20261102120000_add_company_billing/migration.sql', 'utf8');
      for (const statement of sql.split(';').filter((s) => s.trim())) await db.$executeRawUnsafe(statement);
      expect(await db.$queryRawUnsafe('SELECT billingEnabled FROM holdings')).toEqual([{ billingEnabled: false }]);
      expect(await db.$queryRawUnsafe('SELECT holdingId FROM children')).toEqual([{ holdingId: 'existing' }]);
      expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    } finally { await db.$disconnect(); }
  });
  it('rejects invalid requests without writing history', async () => {
    const count = await state.prisma.billingChange.count();
    expect((await request('/one/payments', 'POST', { ...payment, comment: '' })).status).toBe(400);
    expect((await request('/missing/payments', 'POST', payment)).status).toBe(404);
    expect((await request('/one', 'PATCH', { enabled: 'yes' })).status).toBe(400);
    expect(await state.prisma.billingChange.count()).toBe(count);
  });
});
