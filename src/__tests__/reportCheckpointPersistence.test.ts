import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { databaseReportCheckpointStore, savedReportDraft, saveReportDraft, withReportCheckpoint } from '../voice/reportCheckpoint';

it('persists checkpoints across database reconnects, isolates owners and rejects writes after source changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'salsa-report-checkpoint-'));
  const makeClient = () => new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  let db = makeClient();
  try {
    // Only the columns used by the checkpoint adapter; apply the real migration.
    for (const [table, key] of [['voice_call_sessions', 'callId'], ['trainer_sessions', 'id']]) {
      await db.$executeRawUnsafe(`CREATE TABLE "${table}" ("${key}" TEXT PRIMARY KEY, ${key === 'callId' ? '"id" INTEGER NOT NULL DEFAULT 1 UNIQUE,' : ''} "transcriptJson" TEXT, "evaluationJson" TEXT, "caseContextJson" TEXT, "updatedAt" DATETIME)`);
      await db.$executeRawUnsafe(`INSERT INTO "${table}" ("${key}", "transcriptJson", "evaluationJson", "caseContextJson") VALUES ('same', '[]', '{}', '{"scenario":"frozen","realtime":{"latency":1}}')`);
    }
    const migration = await readFile(join(process.cwd(), 'prisma/migrations/20261112120000_report_checkpoints/migration.sql'), 'utf8');
    for (const statement of migration.split(';').filter(value => value.trim())) await db.$executeRawUnsafe(statement);
    const input = { transcript: [], evaluation: {}, totalScore: 70, scenarioContext: 'Frozen scenario' };
    await withReportCheckpoint(input, () => saveReportDraft({ summary: 'Completed block' }), { key: 'voice:same', store: databaseReportCheckpointStore('voice:same', db) });
    await db.$disconnect();
    db = makeClient();
    await withReportCheckpoint(input, async () => expect(savedReportDraft()).toEqual({ summary: 'Completed block' }), { key: 'voice:same', store: databaseReportCheckpointStore('voice:same', db) });
    await withReportCheckpoint(input, async () => expect(savedReportDraft()).toBeUndefined(), { key: 'trainer:same', store: databaseReportCheckpointStore('trainer:same', db) });
    // Volatile runtime telemetry does not invalidate frozen scenario facts.
    await db.$executeRawUnsafe(`UPDATE voice_call_sessions SET caseContextJson = '{"scenario":"frozen","realtime":{"latency":2}}'`);
    await withReportCheckpoint(input, async () => expect(savedReportDraft()).toEqual({ summary: 'Completed block' }), { key: 'voice:same', store: databaseReportCheckpointStore('voice:same', db) });
    const stale = databaseReportCheckpointStore('voice:same', db);
    const snapshot = await stale.load();
    await db.$executeRawUnsafe(`UPDATE voice_call_sessions SET transcriptJson = '[{"text":"changed"}]'`);
    expect(await stale.save(snapshot.payload, '{}')).toBe(false);
    await db.$executeRawUnsafe('DELETE FROM voice_call_sessions');
    expect(await stale.save(snapshot.payload, '{}')).toBe(false);
    await expect(databaseReportCheckpointStore('voice:same', db).load()).rejects.toThrow('REPORT_CHECKPOINT_OWNER_NOT_FOUND');
  } finally {
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
