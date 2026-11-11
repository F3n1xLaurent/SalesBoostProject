import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../db', () => ({ get prisma() { return state.db; } }));
import { loadActivitySources } from '../analytics/activity/sources';
import { computeActivity } from '../analytics/activity';
let directory: string;
const now = new Date('2026-11-11T12:00:00Z');
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'salsa-activity-v3-'));
  const url = `file:${join(directory, 'test.db')}`;
  writeFileSync(join(directory, 'test.db'), '');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  state.db = new PrismaClient({ datasources: { db: { url } } });
  await state.db.holding.createMany({ data: [{ id: 'c', name: 'Клиент' }, { id: 'test', name: 'Тест', isTest: true }, { id: 'deleted', name: 'Удалённая', isDeleted: true }] });
  await state.db.dealership.createMany({ data: [{ id: 'b', name: 'Точка', holdingId: 'c' }, { id: 'tb', name: 'Тестовая точка', holdingId: 'test' }] });
  for (const [id, role, branch] of [['employee', 'manager', 'b'], ['admin', 'dealership_admin', 'b'], ['team', 'platform_superadmin', 'b'], ['test-user', 'manager', 'tb']] as const) {
    await state.db.account.create({ data: { id, email: `${id}@example.test`, passwordHash: 'unused', memberships: { create: { role, dealershipId: branch } } } });
    await state.db.managerProfile.create({ data: { id: `profile-${id}`, accountId: id, fullName: id, dealershipId: branch } });
    await state.db.trainerSession.create({ data: { employeeId: `profile-${id}`, branchId: branch, companyId: branch === 'tb' ? 'test' : 'c', sessionType: 'free', status: 'completed', score: 80, startedAt: new Date('2026-11-10T21:30:00Z'), completedAt: new Date('2026-11-10T21:40:00Z') } });
  }
  await state.db.productAnalyticsEvent.createMany({
    data: [
      { accountId: 'employee', role: 'employee', companyId: 'c', branchId: 'b', eventName: 'report_viewed', occurredAt: new Date('2026-11-10T21:30:00Z'), propertiesJson: '{"report_type":"training"}' },
      { accountId: 'employee', role: 'employee', companyId: 'c', branchId: 'b', eventName: 'report_viewed', occurredAt: new Date('2026-11-10T22:30:00Z'), propertiesJson: '{"report_type":"training"}' },
      { accountId: 'admin', role: 'branch_admin', companyId: 'c', branchId: 'b', eventName: 'page_viewed', occurredAt: new Date('2026-11-10T12:00:00Z'), propertiesJson: '{"section":"branches"}' },
      { accountId: 'team', role: 'branch_admin', companyId: 'c', branchId: 'b', eventName: 'page_viewed', occurredAt: now },
      { accountId: 'employee', role: 'employee', companyId: 'c', branchId: 'b', eventName: 'call_check_completed', initiatedBy: 'system', occurredAt: now },
      { accountId: 'test-user', role: 'employee', companyId: 'test', branchId: 'tb', eventName: 'page_viewed', occurredAt: now },
    ]
  });
  await state.db.callScript.create({ data: { id: 's', name: 'Скрипт', holdingId: 'c' } });
  for (let i = 0; i < 30; i++)
    await state.db.voiceCallSession.create({ data: { callId: `call-${i}`, to: 'unused', dealershipId: 'b', outcome: 'completed', totalScore: i < 20 ? 50 : 60, caseContextJson: '{"scriptId":"s"}', startedAt: new Date(i < 20 ? '2026-09-01T12:00:00Z' : '2026-11-10T12:00:00Z'), connectedAt: new Date('2026-11-10T12:00:00Z') } });
  await state.db.voiceCallSession.create({ data: { callId: 'demo', to: 'unused', source: 'demo', dealershipId: 'b', outcome: 'completed', totalScore: 100, startedAt: now } });
}, 30000);
afterAll(async () => {
  await state.db?.$disconnect(); if (directory)
    rmSync(directory, { recursive: true, force: true });
});
describe('activity SQLite sources', () => {
  it('excludes test companies, system events and admins training, aggregates events in Moscow and includes unattributed calls', async () => {
    const scope = { period: 30 as const, companyId: null, branchId: null };
    const d = await loadActivitySources(scope, new Date('2026-09-12T00:00:00Z'), now);
    expect(d.companies.map(c => c.id)).toEqual(['c']);
    expect(d.trainings).toHaveLength(1);
    expect(d.people.map(p => p.accountId).sort()).toEqual(['admin', 'employee']);
    expect(d.events.find(e => e.eventName === 'report_viewed')).toMatchObject({ actions: 2, date: '2026-11-11' });
    expect(d.calls).toHaveLength(30);
    const r = computeActivity(d, scope, now);
    expect(r.kpis.activeEmployees.value).toBe(1);
    expect(r.kpis.activeLeaders.value).toBe(1);
    expect(r.calls.funnel.launched).toBe(10);
    expect(r.kpis.northStar.value).toBe(10);
    expect(r.roles.employees.reports.viewed.training).toBe(1);
  });
  it('validates inaccessible companies and branch ownership', async () => {
    await expect(loadActivitySources({ period: 30, companyId: 'test', branchId: null }, new Date(0), now)).rejects.toMatchObject({ status: 404 });
    await expect(loadActivitySources({ period: 30, companyId: 'c', branchId: 'tb' }, new Date(0), now)).rejects.toMatchObject({ status: 400 });
  });
});
import type { Request, Response } from 'express';
import { createEmployeeImportHandlers } from '../auth/employeeImport';
import { verifyPassword } from '../auth/password';
const importedEvent = vi.fn();
function importRequest(rows: unknown[], role = 'dealership_admin', companyId = 'c') {
  return { get: () => role === 'manager' ? 'staff' : role === 'platform_superadmin' ? 'super' : 'dealer', authAccount: { id: 'admin', memberships: [{ role, dealershipId: 'b', holdingId: null }] }, body: { companyId, rows } } as unknown as Request;
}
async function invokeImport(req: Request, commit = false) {
  const output = { status: 200, body: null as any };
  const res = { status(value: number) { output.status = value; return this; }, json(value: unknown) { output.body = value; return this; } } as Response;
  const handler = createEmployeeImportHandlers(state.db, importedEvent);
  await (commit ? handler.commit : handler.preview)(req, res);
  return output;
}
const importRow = (email: string, branchId = 'b') => ({ email, fullName: 'Новый сотрудник', branchId, password: 'ExamplePass123', phone: '' });
describe('employee import with a real database', () => {
  it('previews errors without exposing passwords or modifying accounts', async () => {
    const count = await state.db.account.count();
    const result = await invokeImport(importRequest([importRow('valid@example.test'), importRow('valid@example.test'), importRow('admin@example.test')]));
    expect(result.body.valid).toBe(false);
    expect(result.body.rows[0].errors).toContain('Повтор email в файле');
    expect(JSON.stringify(result.body)).not.toContain('ExamplePass123');
    expect(await state.db.account.count()).toBe(count);
  });
  it('rejects employee actors and branches outside the permitted company', async () => {
    expect((await invokeImport(importRequest([importRow('denied@example.test')], 'manager'))).status).toBe(403);
    const result = await invokeImport(importRequest([importRow('foreign@example.test', 'tb')]));
    expect(result.body.valid).toBe(false);
    expect((await invokeImport(importRequest([importRow('foreign@example.test', 'tb')], 'dealership_admin', 'test'))).status).toBe(403);
  });
  it('creates linked employee accounts atomically with hashed passwords and emits one fact after commit', async () => {
    importedEvent.mockClear();
    const result = await invokeImport(importRequest([{ ...importRow('imported@example.test'), phone: '8 (999) 123-45-67', memberships: [{ role: 'platform_superadmin' }] }, importRow('imported2@example.test')]), true);
    expect(result.status).toBe(201);
    expect(result.body.importedCount).toBe(2);
    const account = await state.db.account.findUniqueOrThrow({ where: { email: 'imported@example.test' }, include: { memberships: true, managerProfiles: true } });
    expect(verifyPassword('ExamplePass123', account.passwordHash)).toBe(true);
    expect(account.memberships.map(item => item.role)).toEqual(['manager']);
    expect(account.managerProfiles[0]).toMatchObject({ dealershipId: 'b', phone: '+79991234567' });
    expect(importedEvent).toHaveBeenCalledOnce();
    expect(importedEvent.mock.calls[0][1]).toMatchObject({ eventName: 'employees_imported', companyId: 'c', branchId: 'b', properties: { imported_count: 2, source: 'csv' } });
  });
  it('does not partially create rows when any validation fails and rejects repeated imports', async () => {
    importedEvent.mockClear();
    const count = await state.db.account.count();
    const result = await invokeImport(importRequest([importRow('not-created@example.test'), importRow('imported@example.test')]), true);
    expect(result.status).toBe(422);
    expect(await state.db.account.count()).toBe(count);
    expect(importedEvent).not.toHaveBeenCalled();
  });
  it('enforces employee phone uniqueness within the branch', async () => {
    const result = await invokeImport(importRequest([{ ...importRow('phone-duplicate@example.test'), phone: '+7 999 123 45 67' }]));
    expect(result.body.valid).toBe(false);
    expect(result.body.rows[0].errors).toContain('Телефон уже принадлежит сотруднику этой точки');
  });
});
