import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateLocalProductionReport } from '../../scripts/production-report';
import { openai } from '../lib/openaiClient';
import { prisma as localDatabase } from '../db';
import { bridge } from '../diagnostics/reportReplacement';

let db: PrismaClient, directory: string;
const evaluation = JSON.stringify({ overall_score_0_100: 70, checklist: [{ code: 'KEEP', status: 'ok' }], unified_call_report: { summary: 'Old report' } });
const transcript = JSON.stringify([{ role: 'client', text: 'Есть автомобиль?' }, { role: 'manager', text: 'Не знаю.' }]);
const example = 'Проверю наличие и сообщу подтверждённый ответ.';
const report = { version: 'call-report-v1', source: 'call', totalScore: 70, summary: 'Updated report', keyFindings: [],
  dialog: [{ role: 'client', text: 'Есть автомобиль?' }, { role: 'manager', text: 'Не знаю.', mark: 'normal', betterExample: example }],
  exampleReviews: [{ turnIndex: 1, exampleHash: createHash('sha256').update(example).digest('hex'), status: 'pass',
    checks: ['direct-answer', 'preserves-facts', 'no-invention'].map(id => ({ id, status: 'pass', reason: 'Проверено.', evidence: example })) }] };
const run = (request: any): Promise<any> => bridge(db, request, join(directory, 'backups'));
const fetchCall = () => run({ action: 'fetch', kind: 'call', id: '1190' });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'salsa-prod-report-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  // Production may run an older schema without reportCheckpointJson. The bridge
  // uses SQLite queries rather than requiring the newly generated Prisma model.
  await db.$executeRawUnsafe('CREATE TABLE voice_call_sessions (id INTEGER PRIMARY KEY, callId TEXT UNIQUE, transcriptJson TEXT, evaluationJson TEXT, caseContextJson TEXT, failureReason TEXT, totalScore REAL, outcome TEXT, endedAt DATETIME, ivrDetected BOOLEAN)');
  await db.$executeRawUnsafe('CREATE TABLE call_plan_calls (id TEXT PRIMARY KEY, callId TEXT UNIQUE, promptText TEXT, criteriaJson TEXT, evaluationJson TEXT, failureReason TEXT)');
  await db.$executeRawUnsafe('CREATE TABLE call_analysis_jobs (callId TEXT PRIMARY KEY, runId TEXT, status TEXT, payloadJson TEXT, finishedAt DATETIME)');
  await db.$executeRawUnsafe('CREATE TABLE call_report_problem_catalog (code TEXT, title TEXT, category TEXT, sortOrder INTEGER, isActive BOOLEAN)');
  await db.$executeRawUnsafe('CREATE TABLE trainer_sessions (id TEXT PRIMARY KEY, transcriptJson TEXT, evaluationJson TEXT, caseContextJson TEXT, failureReason TEXT, score REAL, baseScore REAL, status TEXT, completedAt DATETIME)');
  await db.$executeRawUnsafe('INSERT INTO voice_call_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 1190, 'uuid-call', transcript, evaluation, '{"prompt":"Frozen","criteria":[]}', 'REPORT_GENERATION_FAILED: old error', 70, 'completed', Date.now(), false);
  await db.$executeRawUnsafe('INSERT INTO call_plan_calls VALUES (?, ?, ?, ?, ?, ?)', 'plan', 'uuid-call', 'Frozen', '[]', evaluation, 'REPORT_GENERATION_FAILED: old error');
  await db.$executeRawUnsafe('INSERT INTO call_analysis_jobs VALUES (?, ?, ?, ?, ?)', 'uuid-call', 'old-run', 'failed', '{"keep":true}', Date.now() - 1000);
});
afterEach(async () => { vi.restoreAllMocks(); await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

describe('production report replacement over the schema-independent bridge', () => {
  it('generates with local source and exported facts, resumes checkpoints and leaves production unchanged until publication', async () => {
    const before = await fetchCall();
    const folder = join(directory, 'local generation');
    await mkdir(folder);
    const catalog = vi.spyOn(localDatabase.callReportProblem, 'findMany').mockRejectedValue(new Error('Local catalog must not be read'));
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...report,
      dialog: [{}, { mark: 'normal', comment: 'Не ответил о наличии.', betterExample: example }] }) } }] } as any);
    create.mockRejectedValueOnce(Object.assign(new Error('Simulated API failure'), { status: 402 }));
    await expect(generateLocalProductionReport(folder, before)).rejects.toThrow('Simulated API failure');
    expect(JSON.parse(await readFile(join(folder, 'checkpoint.json'), 'utf8')).report).toBeTruthy();
    create.mockImplementation((async (params: any) => {
      const { items } = JSON.parse(params.messages.at(-1).content);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: items.map((item: any) => ({ turnIndex: item.turnIndex,
        exampleHash: createHash('sha256').update(item.example).digest('hex'), checks: item.requiredCheckIds.map((id: string) => ({ id, status: 'pass', reason: 'Проверено по контексту.', evidence: item.example })) })) }) } }] };
    }) as any);
    await generateLocalProductionReport(folder, before);
    expect(create).toHaveBeenCalledTimes(3);
    expect(catalog).not.toHaveBeenCalled();
    const generated = JSON.parse(await readFile(join(folder, 'report.json'), 'utf8'));
    expect(generated.totalScore).toBe(70);
    expect(generated.dialog[1].betterExample).toBe(example);
    expect(JSON.parse(await readFile(join(folder, 'generation.json'), 'utf8')).snapshotFingerprint).toBe(before.fingerprint);
    expect((await fetchCall()).fingerprint).toBe(before.fingerprint);
  });

  it('exports by number or UUID, replaces only the report, mirrors it to the plan and supports exact rollback', async () => {
    const before = await fetchCall();
    expect((await run({ action: 'fetch', kind: 'call', id: 'uuid-call' })).fingerprint).toBe(before.fingerprint);
    const operationId = randomUUID();
    const result = await run({ action: 'publish', snapshot: before, report, operationId });
    expect(result.ok).toBe(true);
    const after = await fetchCall();
    expect(JSON.parse(after.session.evaluationJson)).toEqual({ ...JSON.parse(evaluation), unified_call_report: report });
    expect(after.session.transcriptJson).toBe(transcript);
    expect(after.session.totalScore).toBe(70);
    expect(after.session.failureReason).toBeNull();
    expect(JSON.parse(after.plan.evaluationJson).unified_call_report).toEqual(report);
    expect(after.job.status).toBe('done');
    expect(JSON.parse(await readFile(result.backupPath, 'utf8')).before.fingerprint).toBe(before.fingerprint);
    expect((await run({ action: 'status', operationId })).state).toBe('published');
    await run({ action: 'rollback', operationId });
    expect((await fetchCall()).fingerprint).toBe(before.fingerprint);
    expect((await run({ action: 'status', operationId })).state).toBe('original');
  });

  it('refuses concurrent report, transcript, scenario, plan and queue changes without overwriting anything', async () => {
    const mutations = [
      ['UPDATE voice_call_sessions SET evaluationJson = ?', '{"overall_score_0_100":70,"new":true}'],
      ['UPDATE voice_call_sessions SET transcriptJson = ?', '[]'],
      ['UPDATE voice_call_sessions SET caseContextJson = ?', '{"changed":true}'],
      ['UPDATE call_plan_calls SET criteriaJson = ?', '["new criterion"]'],
      ['UPDATE call_analysis_jobs SET status = ?', 'processing'],
    ];
    for (const [sql, value] of mutations) {
      const before = await fetchCall();
      await db.$executeRawUnsafe(sql, value);
      await expect(run({ action: 'publish', snapshot: before, report, operationId: randomUUID() })).rejects.toThrow(/REPORT_SOURCE_CHANGED|ALREADY_RUNNING/);
      await db.$executeRawUnsafe('UPDATE voice_call_sessions SET evaluationJson = ?, transcriptJson = ?, caseContextJson = ?', evaluation, transcript, '{"prompt":"Frozen","criteria":[]}');
      await db.$executeRawUnsafe('UPDATE call_plan_calls SET criteriaJson = ?', '[]');
      await db.$executeRawUnsafe('UPDATE call_analysis_jobs SET status = ?', 'failed');
    }
    expect((await fetchCall()).session.evaluationJson).toBe(evaluation);
  });

  it('rejects score changes and unapproved examples and preserves unrelated failures', async () => {
    const before = await fetchCall();
    for (const invalid of [{ ...report, totalScore: 71 }, { ...report, exampleReviews: [] },
      { ...report, exampleReviews: [{ ...report.exampleReviews[0], exampleHash: 'stale' }] }]) {
      await expect(run({ action: 'publish', snapshot: before, report: invalid, operationId: randomUUID() })).rejects.toThrow(/INVALID_REPLACEMENT|NOT_APPROVED/);
    }
    await db.$executeRawUnsafe('UPDATE voice_call_sessions SET failureReason = ?', 'UNRELATED_FAILURE');
    const updated = await fetchCall();
    await run({ action: 'publish', snapshot: updated, report, operationId: randomUUID() });
    expect((await fetchCall()).session.failureReason).toBe('UNRELATED_FAILURE');
  });

  it('refuses stale rollback and treats an already published operation as immutable', async () => {
    const before = await fetchCall(), operationId = randomUUID();
    await run({ action: 'publish', snapshot: before, report, operationId });
    await expect(run({ action: 'publish', snapshot: before, report, operationId })).rejects.toThrow('REPORT_SOURCE_CHANGED');
    await db.$executeRawUnsafe('UPDATE voice_call_sessions SET evaluationJson = ?', '{"overall_score_0_100":70,"later":true}');
    await expect(run({ action: 'rollback', operationId })).rejects.toThrow('REPORT_CHANGED_SINCE_PUBLISH');
    expect((await run({ action: 'status', operationId })).state).toBe('changed');
    expect((await run({ action: 'status', operationId: randomUUID() })).state).toBe('not_published');
  });

  it('supports trainer reports and clears optional private checkpoints with rollback', async () => {
    await db.$executeRawUnsafe('ALTER TABLE trainer_sessions ADD COLUMN reportCheckpointJson TEXT');
    await db.$executeRawUnsafe('INSERT INTO trainer_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'trainer-id', transcript, evaluation, '{"scenario":{"name":"Frozen"}}', null, 70, 70, 'completed', Date.now(), '{"draft":true}');
    const before = await run({ action: 'fetch', kind: 'trainer', id: 'trainer-id' });
    const operationId = randomUUID();
    await run({ action: 'publish', snapshot: before, report: { ...report, source: 'trainer' }, operationId });
    expect((await run({ action: 'fetch', kind: 'trainer', id: 'trainer-id' })).session.reportCheckpointJson).toBeNull();
    await run({ action: 'rollback', operationId });
    expect((await run({ action: 'fetch', kind: 'trainer', id: 'trainer-id' })).fingerprint).toBe(before.fingerprint);
  });
});
