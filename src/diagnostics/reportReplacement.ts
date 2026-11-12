// Shared transactional replacement engine for token-authenticated diagnostics.
import crypto from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { ProblemCatalogItem } from '../voice/problemCatalog';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
type Database = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;
type Row = Record<string, any>;
export type ReportReplacementSnapshot = { version: number; kind: string; session: Row; plan: Row | null; job: Row | null; catalog: ProblemCatalogItem[]; score: number; fingerprint: string };
export type ReportReplacementRequest = { action: string; kind?: string; id?: string; operationId?: string; snapshot?: {kind: string; session: {id: string}; fingerprint: string}; report?: unknown };

const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item)).digest('hex');
const json = (value: string | null) => value == null ? null : JSON.parse(value);
const reportFailure = (value: unknown) => typeof value === 'string' && value.startsWith('REPORT_GENERATION_FAILED:');

async function columns(db: Database, table: string) {
  return new Set((await db.$queryRawUnsafe<Array<{name: string}>>(`PRAGMA table_info("${table}")`)).map(row => row.name));
}
export async function snapshot(db: Database, kind: string, id: string): Promise<ReportReplacementSnapshot> {
  if (!['call', 'trainer'].includes(kind) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('INVALID_REPORT_ID');
  const table = kind === 'call' ? 'voice_call_sessions' : 'trainer_sessions';
  const available = await columns(db, table);
  const fields = ['id', 'transcriptJson', 'evaluationJson', 'caseContextJson', 'failureReason',
    ...(kind === 'call' ? ['callId', 'totalScore', 'outcome', 'endedAt', 'ivrDetected'] : ['score', 'baseScore', 'status', 'completedAt']),
    ...(available.has('reportCheckpointJson') ? ['reportCheckpointJson'] : [])];
  const where = kind === 'call' ? (/^\d+$/.test(id) ? 'id = ?' : 'callId = ?') : 'id = ?';
  const [session] = await db.$queryRawUnsafe<Row[]>(`SELECT ${fields.map(name => `"${name}"`).join(',')} FROM "${table}" WHERE ${where}`, kind === 'call' && /^\d+$/.test(id) ? Number(id) : id);
  if (!session) throw new Error('REPORT_OWNER_NOT_FOUND');
  if (kind === 'call' ? !session.endedAt : !['completed', 'failed'].includes(session.status)) throw new Error('REPORT_OWNER_NOT_FINISHED');
  const evaluation = json(session.evaluationJson);
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) throw new Error('REPORT_EVALUATION_REQUIRED');
  const score = kind === 'call' ? session.totalScore : evaluation.overall_score_0_100 ?? session.score ?? session.baseScore;
  if (score == null || !Number.isFinite(Number(score))) throw new Error('REPORT_SCORE_REQUIRED');
  const [plan] = kind === 'call' ? await db.$queryRawUnsafe<Row[]>('SELECT id, promptText, criteriaJson, evaluationJson, failureReason FROM call_plan_calls WHERE callId = ?', session.callId) : [];
  const [job] = kind === 'call' ? await db.$queryRawUnsafe<Row[]>('SELECT callId, runId, status, payloadJson, finishedAt FROM call_analysis_jobs WHERE callId = ?', session.callId) : [];
  if (job && ['queued', 'processing'].includes(job.status)) throw new Error('CALL_ANALYSIS_ALREADY_RUNNING');
  const catalog = await db.$queryRawUnsafe<ProblemCatalogItem[]>('SELECT code, title, category, sortOrder FROM call_report_problem_catalog WHERE isActive = 1 ORDER BY sortOrder, title');
  const data = { version: 1, kind, session, plan: plan ?? null, job: job ?? null, catalog, score: Number(score) };
  return { ...data, fingerprint: hash(data) };
}

const reportSchema = z.object({
  version: z.literal('call-report-v1'), source: z.enum(['call', 'trainer']), totalScore: z.number().int().min(0).max(100), summary: z.string().trim().min(1),
  dialog: z.array(z.object({ role: z.enum(['client', 'manager']), text: z.string(), mark: z.enum(['positive', 'normal', 'negative']).nullable().optional(), betterExample: z.string().nullable().optional() }).passthrough()).min(1),
  keyFindings: z.array(z.object({ betterExample: z.string() }).passthrough()),
  exampleReviews: z.array(z.object({ turnIndex: z.number().int().min(0), exampleHash: z.string(), status: z.enum(['pass', 'fail', 'review']),
    checks: z.array(z.object({ id: z.string(), status: z.string(), reason: z.string(), evidence: z.string() })).optional() }).passthrough()),
}).passthrough();
export function validateReport(input: unknown, current: ReportReplacementSnapshot) {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_REPLACEMENT_REPORT');
  const report = parsed.data;
  if (report.source !== (current.kind === 'call' ? 'call' : 'trainer') || report.totalScore !== Math.round(current.score)) throw new Error('INVALID_REPLACEMENT_REPORT');
  if (report.keyFindings.some(finding => !finding.betterExample?.trim())) throw new Error('INCOMPLETE_REPLACEMENT_REPORT');
  for (const [index, turn] of report.dialog.entries()) {
    if (turn.role !== 'manager' || (!turn.betterExample && !['normal', 'negative'].includes(turn.mark ?? ''))) continue;
    if (!turn.betterExample?.trim()) throw new Error('INCOMPLETE_REPLACEMENT_REPORT');
    const example = turn.betterExample;
    const reviews = report.exampleReviews.filter(review => review.turnIndex === index);
    if (reviews.length !== 1 || reviews[0].status !== 'pass'
      || reviews[0].exampleHash !== crypto.createHash('sha256').update(turn.betterExample).digest('hex')) throw new Error('REPLACEMENT_EXAMPLES_NOT_APPROVED');
    const checks = reviews[0].checks;
    if (!Array.isArray(checks) || !['direct-answer', 'preserves-facts', 'no-invention'].every(id => checks.filter(check => check.id === id).length === 1)
      || checks.some(check => check.status !== 'pass' || !check.reason?.trim() || !check.evidence?.trim() || !example.includes(check.evidence))) throw new Error('REPLACEMENT_EXAMPLES_NOT_APPROVED');
  }
}

async function updateFields(db: Database, table: string, identity: [string, unknown], fields: Record<string, unknown>) {
  const entries = Object.entries(fields);
  const result = await db.$executeRawUnsafe(`UPDATE "${table}" SET ${entries.map(([key]) => `"${key}" = ?`).join(', ')} WHERE "${identity[0]}" = ?`, ...entries.map(([, value]) => value), identity[1]);
  if (result !== 1) throw new Error('REPORT_WRITE_CONFLICT');
}
async function writeState(db: Database, state: ReportReplacementSnapshot, restore = false, report?: unknown) {
  const { session, kind, plan, job } = state;
  const sessionFields: Record<string, unknown> = restore ? { evaluationJson: session.evaluationJson, failureReason: session.failureReason }
    : { evaluationJson: JSON.stringify({ ...json(session.evaluationJson), unified_call_report: report }), failureReason: reportFailure(session.failureReason) ? null : session.failureReason };
  if (Object.hasOwn(session, 'reportCheckpointJson')) sessionFields.reportCheckpointJson = restore ? session.reportCheckpointJson : null;
  await updateFields(db, kind === 'call' ? 'voice_call_sessions' : 'trainer_sessions', ['id', session.id], sessionFields);
  if (plan) await updateFields(db, 'call_plan_calls', ['id', plan.id], restore
    ? { evaluationJson: plan.evaluationJson, failureReason: plan.failureReason }
    : { evaluationJson: JSON.stringify({ ...(json(plan.evaluationJson) ?? json(session.evaluationJson)), unified_call_report: report }), failureReason: reportFailure(plan.failureReason) ? null : plan.failureReason });
  if (job && (restore || (job.status === 'failed' && reportFailure(session.failureReason)))) {
    await updateFields(db, 'call_analysis_jobs', ['callId', job.callId], restore
      ? { status: job.status, payloadJson: job.payloadJson, finishedAt: job.finishedAt }
      : { status: 'done', payloadJson: '{}', finishedAt: Date.now() });
  }
}

export async function bridge(db: PrismaClient, request: ReportReplacementRequest, backupDirectory = process.env.REPORT_REPLACEMENT_BACKUP_DIR || (process.env.NODE_ENV === 'production' ? '/data/report-replacements' : path.resolve('storage/report-replacements'))) {
  if (request.action === 'fetch') {
    if (!request.kind || !request.id) throw new Error('INVALID_REPORT_ID');
    return db.$transaction(tx => snapshot(tx, request.kind!, request.id!));
  }
  if (!/^[a-f0-9-]{36}$/.test(request.operationId ?? '')) throw new Error('INVALID_OPERATION_ID');
  const backupPath = path.join(backupDirectory, `${request.operationId}.json`);
  if (request.action === 'status') {
    if (!fs.existsSync(backupPath)) return { operationId: request.operationId, state: 'not_published' };
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const current = await db.$transaction(tx => snapshot(tx, backup.before.kind, String(backup.before.session.id)));
    return { operationId: request.operationId, state: current.fingerprint === backup.after.fingerprint ? 'published'
      : current.fingerprint === backup.before.fingerprint ? 'original' : 'changed', backupPath };
  }
  if (request.action === 'publish') {
    if (!request.snapshot) throw new Error('INVALID_REPORT_SNAPSHOT');
    const expected = request.snapshot;
    return db.$transaction(async tx => {
      const before = await snapshot(tx, expected.kind, String(expected.session.id));
      if (before.fingerprint !== expected.fingerprint) throw new Error('REPORT_SOURCE_CHANGED_FETCH_AGAIN');
      validateReport(request.report, before);
      await writeState(tx, before, false, request.report);
      const after = await snapshot(tx, before.kind, String(before.session.id));
      fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(backupPath, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify({ operationId: request.operationId, before, after }, (_key, value) => typeof value === 'bigint' ? String(value) : value)); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      return { ok: true, operationId: request.operationId, backupPath, fingerprint: after.fingerprint };
    }, { timeout: 15000 });
  }
  if (request.action === 'rollback') {
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    return db.$transaction(async tx => {
      const current = await snapshot(tx, backup.before.kind, String(backup.before.session.id));
      if (current.fingerprint !== backup.after.fingerprint) throw new Error('REPORT_CHANGED_SINCE_PUBLISH');
      await writeState(tx, backup.before, true);
      return { ok: true, operationId: request.operationId, restored: true };
    }, { timeout: 15000 });
  }
  throw new Error('INVALID_ACTION');
}
