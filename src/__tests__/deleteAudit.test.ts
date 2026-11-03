import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateTrainerStreak, createDeleteAuditHandler } from '../audits/deleteAudit';
import { wasVoiceAuditDeleted } from '../audits/deletedAudit';

let db: PrismaClient;
let directory: string;
const invalidate = vi.fn();
const processing = vi.fn(() => false);

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'salesboost-delete-audit-'));
  const url = `file:${join(directory, 'test.db')}`;
  writeFileSync(join(directory, 'test.db'), '');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url } } });
  await db.holding.create({ data: { id: 'holding', name: 'Company' } });
  await db.dealership.create({ data: { id: 'dealer', name: 'Dealer', holdingId: 'holding' } });
  await db.managerProfile.create({ data: { id: 'manager', dealershipId: 'dealer', fullName: 'Manager' } });
}, 30000);

beforeEach(async () => {
  vi.clearAllMocks(); processing.mockReturnValue(false);
  await db.callBatch.deleteMany();
  await db.callPlanCall.deleteMany();
  await db.voiceCallSession.deleteMany();
  await db.callPlan.deleteMany();
  await db.trainerSession.deleteMany();
  await db.trainerDailyPlan.deleteMany();
  await db.trainerStreak.deleteMany();
  await db.productAnalyticsEvent.deleteMany();
});
afterAll(async () => { await db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true }); });

async function request(id: string, role: string | null = 'platform_superadmin') {
  const req = { params: { id }, get: () => 'super', authAccount: role ? { id: 'admin', memberships: [{ role }] } : null } as unknown as Request;
  const result = { status: 200, body: null as any };
  const res = { status(code: number) { result.status = code; return this; }, json(body: unknown) { result.body = body; return this; } };
  await createDeleteAuditHandler({ db, invalidateAnalytics: invalidate, isCallProcessing: processing })(req, res as unknown as Response, () => {});
  return result;
}
const voice = (callId: string, score: number, endedAt: Date | null = new Date()) => db.voiceCallSession.create({ data: {
  callId, to: '+79990000000', totalScore: score, endedAt, outcome: endedAt ? 'completed' : null, managerId: 'manager', dealershipId: 'dealer',
} });

describe('superadmin audit deletion', () => {
  it('rejects guests and every non-superadmin even with a super role header', async () => {
    const session = await voice('keep', 80);
    expect((await request(`call-${session.id}`, null)).status).toBe(401);
    for (const role of ['holding_admin', 'dealership_admin', 'manager']) {
      expect((await request(`call-${session.id}`, role)).status).toBe(403);
      expect((await request('trainer-any', role)).status).toBe(403);
    }
    expect(await db.voiceCallSession.count()).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('removes the source call and linked history, recalculates counters and excludes it from score statistics', async () => {
    const target = await voice('delete', 100);
    await voice('keep', 20);
    await db.callPlan.create({ data: { id: 'plan', holdingId: 'holding', name: 'Test', targetType: 'employees', scriptId: 'script', phoneNumberTypeId: 'phone', frequency: 'manual', callTimeFrom: '09:00', callTimeTo: '18:00' } });
    await db.callPlanCall.create({ data: { planId: 'plan', callId: target.callId, phone: target.to, phoneNumberTypeId: 'phone', scriptId: 'script', promptText: '', status: 'completed' } });
    await db.callBatch.create({ data: { id: 'batch', mode: 'manual', status: 'completed', totalJobs: 1, completedJobs: 1 } });
    await db.callBatchJob.create({ data: { id: 'job', batchId: 'batch', phone: target.to, status: 'completed', lastVoiceCallId: target.callId, linkedAuditId: `call-${target.id}` } });
    await db.callBatchAttempt.create({ data: { jobId: 'job', attempt: 1, voiceCallId: target.callId, status: 'ended' } });
    await db.productAnalyticsEvent.create({ data: { eventName: 'call_check_completed', targetType: 'voice_call', targetId: target.callId } });
    expect((await request(`call-${target.id}`)).status).toBe(200);
    expect(await db.voiceCallSession.findUnique({ where: { id: target.id } })).toBeNull();
    expect((await db.voiceCallSession.aggregate({ _avg: { totalScore: true } }))._avg.totalScore).toBe(20);
    expect(await db.callPlanCall.count()).toBe(0);
    expect(await db.callBatchAttempt.count()).toBe(0);
    expect(await db.callBatchJob.count()).toBe(0);
    expect(await db.callBatch.findUnique({ where: { id: 'batch' } })).toMatchObject({ totalJobs: 0, completedJobs: 0 });
    expect(await wasVoiceAuditDeleted(db, target.callId)).toBe(true);
    expect(await db.productAnalyticsEvent.count({ where: { eventName: 'call_check_completed' } })).toBe(0);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('removes training points and repairs streaks and daily plans from the remaining sessions', async () => {
    for (const [id, offset, points] of [['first', 2, 10], ['target', 1, 20], ['last', 0, 30]] as const) {
      await db.trainerSession.create({ data: { id, employeeId: 'manager', sessionType: 'plan', status: 'completed', score: points,
        startedAt: new Date(Date.now() - offset * 86400000), completedAt: new Date(),
        scoreEntry: { create: { employeeId: 'manager', baseScore: points, multiplier: 1, finalScore: points } },
      } });
    }
    await db.trainerStreak.create({ data: { employeeId: 'manager', currentStreak: 3, longestStreak: 3 } });
    await db.trainerDailyPlan.create({ data: { employeeId: 'manager', planDate: '2026-11-03', sessionsJson: JSON.stringify([{ trainerSessionId: 'target' }, { trainerSessionId: 'last' }]) } });
    expect((await request('trainer-target')).status).toBe(200);
    expect(await db.trainerSession.count()).toBe(2);
    expect((await db.trainerScore.aggregate({ _sum: { finalScore: true } }))._sum.finalScore).toBe(40);
    expect(await db.trainerStreak.findUnique({ where: { employeeId: 'manager' } })).toMatchObject({ currentStreak: 1, longestStreak: 1 });
    expect(JSON.parse((await db.trainerDailyPlan.findFirst())!.sessionsJson)).toEqual([{ trainerSessionId: 'last' }]);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('preserves other attempts and derives batch results from the remaining call', async () => {
    const first = await voice('previous', 0);
    const target = await voice('latest', 100);
    await db.callBatch.create({ data: { id: 'batch', mode: 'manual', status: 'completed', totalJobs: 1, completedJobs: 1 } });
    await db.callBatchJob.create({ data: { id: 'job', batchId: 'batch', phone: target.to, status: 'completed', lastVoiceCallId: target.callId, linkedAuditId: `call-${target.id}` } });
    await db.callBatchAttempt.createMany({ data: [
      { jobId: 'job', attempt: 1, voiceCallId: first.callId, status: 'ended', outcome: 'busy' },
      { jobId: 'job', attempt: 2, voiceCallId: target.callId, status: 'ended', outcome: 'disconnected' },
    ] });
    expect((await request(`call-${target.id}`)).status).toBe(200);
    expect(await db.callBatchAttempt.count()).toBe(1);
    expect(await db.voiceCallSession.count()).toBe(1);
    expect(await db.callBatchJob.findUnique({ where: { id: 'job' } })).toMatchObject({
      status: 'failed', lastVoiceCallId: first.callId, linkedAuditId: `call-${first.id}`, lastOutcome: 'busy',
    });
    expect(await db.callBatch.findUnique({ where: { id: 'batch' } })).toMatchObject({ totalJobs: 1, completedJobs: 0, failedJobs: 1 });
  });

  it('does not delete a call while its batch is waiting to retry', async () => {
    const target = await voice('retry', 0);
    await db.callBatch.create({ data: { id: 'batch', mode: 'manual' } });
    await db.callBatchJob.create({ data: { batchId: 'batch', phone: target.to, status: 'retry_wait', lastVoiceCallId: target.callId } });
    expect((await request(`call-${target.id}`)).status).toBe(409);
    expect(await db.voiceCallSession.count()).toBe(1);
    expect(await db.productAnalyticsEvent.count()).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('rejects active calls, finalizations and unfinished training without changing data', async () => {
    const target = await voice('active', 80, null);
    expect((await request(`call-${target.id}`)).status).toBe(409);
    await db.voiceCallSession.update({ where: { id: target.id }, data: { endedAt: new Date() } });
    processing.mockReturnValue(true);
    expect((await request(`call-${target.id}`)).status).toBe(409);
    await db.trainerSession.create({ data: { id: 'active', employeeId: 'manager', sessionType: 'free' } });
    expect((await request('trainer-active')).status).toBe(409);
    expect(await db.voiceCallSession.count()).toBe(1);
    expect(await db.productAnalyticsEvent.count()).toBe(0);
  });

  it('validates identifiers strictly and reports missing records', async () => {
    for (const id of ['call-1junk', 'call--1', 'call-0', 'call-1.5', '../trainer-test', 'trainer-']) {
      expect((await request(id)).status).toBe(400);
    }
    expect((await request('call-99999')).status).toBe(404);
    expect((await request('trainer-unknown')).status).toBe(404);
  });
});

it('clears a streak after all sessions are removed and expires old streaks', () => {
  expect(calculateTrainerStreak([])).toEqual({ currentStreak: 0, longestStreak: 0, lastActiveDate: null });
  expect(calculateTrainerStreak([new Date('2026-10-01'), new Date('2026-10-02')], new Date('2026-11-03')))
    .toMatchObject({ currentStreak: 0, longestStreak: 2, lastActiveDate: '2026-10-02' });
});
