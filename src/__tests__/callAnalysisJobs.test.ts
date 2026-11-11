import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCallAnalysisJob, saveCallAnalysisJob, startCallAnalysisRecovery } from '../voice/callAnalysisJobs';

const directory = mkdtempSync(join(tmpdir(), 'analytics-queue-test-'));
const db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'queue.db')}` } } });
beforeAll(async () => {
  const migration = readFileSync('prisma/migrations/20261110120000_add_call_analysis_queue/migration.sql', 'utf8');
  for (const statement of migration.split(';').filter(sql => sql.trim())) await db.$executeRawUnsafe(statement);
});
beforeEach(async () => { await db.callAnalysisJob.deleteMany(); });
afterAll(async () => { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

describe('durable call analysis on real SQLite', () => {
  it('persists original transcript and hangup time, deduplicates a webhook and claims a job once', async () => {
    const payload = { call_id: 'call-a', ts: '2026-11-10T10:00:00Z', transcript: [{ role: 'manager', text: 'Цена миллион.' }] };
    const job = (await saveCallAnalysisJob('call-a', payload, false, db))!;
    expect((await saveCallAnalysisJob('call-a', { call_id: 'call-a' }, false, db))?.runId).toBe(job.runId);
    expect(JSON.parse(job.payloadJson)).toEqual(payload);
    const paid = vi.fn(async () => {});
    await Promise.all([runCallAnalysisJob(job, paid, db), runCallAnalysisJob(job, paid, db)]);
    expect(paid).toHaveBeenCalledOnce();
    expect(await db.callAnalysisJob.findUnique({ where: { callId: 'call-a' } })).toMatchObject({ status: 'done', payloadJson: '{}' });
    expect(await saveCallAnalysisJob('call-a', payload, false, db)).toBeNull();
  });

  it('does not let an obsolete worker overwrite its replacement job', async () => {
    const old = (await saveCallAnalysisJob('replace', { call_id: 'replace' }, false, db))!;
    let release!: () => void;
    const pending = runCallAnalysisJob(old, () => new Promise<void>(resolve => { release = resolve; }), db);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const replacement = (await saveCallAnalysisJob('replace', { call_id: 'replace' }, true, db))!;
    release(); await pending;
    expect(await db.callAnalysisJob.findUnique({ where: { callId: 'replace' } })).toMatchObject({ runId: replacement.runId, status: 'queued' });
  });

  it('restores queued and interrupted work after restart while leaving failures terminal', async () => {
    await saveCallAnalysisJob('queued', { call_id: 'queued' }, false, db);
    const interrupted = (await saveCallAnalysisJob('interrupted', { call_id: 'interrupted' }, false, db))!;
    await db.callAnalysisJob.update({ where: { callId: interrupted.callId }, data: { status: 'processing' } });
    const failed = (await saveCallAnalysisJob('failed', { call_id: 'failed' }, false, db))!;
    await expect(runCallAnalysisJob(failed, async () => { throw new Error('provider unavailable'); }, db)).rejects.toThrow('provider unavailable');
    const seen: string[] = [];
    await saveCallAnalysisJob('corrupt', { call_id: 'corrupt' }, false, db);
    await db.callAnalysisJob.update({ where: { callId: 'corrupt' }, data: { payloadJson: 'not JSON' } });
    await db.$disconnect(); // Recovery must read durable rows, not live JS state.
    const worker = startCallAnalysisRecovery(async payload => { seen.push(payload.call_id!); }, () => false, db)!;
    try {
      await worker.ready;
      await vi.waitFor(() => expect(seen.sort()).toEqual(['interrupted', 'queued']));
      await vi.waitFor(async () => expect(await db.callAnalysisJob.count({ where: { status: 'queued' } })).toBe(0));
      expect(await db.callAnalysisJob.findUnique({ where: { callId: 'corrupt' } })).toMatchObject({ status: 'failed' });
      expect(await saveCallAnalysisJob('failed', { call_id: 'failed' }, false, db)).toBeNull();
      expect(await saveCallAnalysisJob('failed', { call_id: 'failed' }, true, db)).toMatchObject({ status: 'queued' });
    } finally { worker.stop(); }
  });
});
