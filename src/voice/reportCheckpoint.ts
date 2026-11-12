import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../db';
import type { PrismaClient } from '@prisma/client';
import { config } from '../config';
import { assertAuditAnalyticsCurrent, currentAuditAnalyticsKey } from '../logic/auditAnalyticsProgress';
import { assertReportGenerationActive } from './reportExecution';
import { REPORT_QUALITY_RULES, REPORT_EXAMPLE_ACCEPTANCE_RULES } from './reportQualityRules';
import type { ReportExampleReview, ReportExampleTask } from './reportExampleReview';

// Bump when structural validation changes incompatibly; prompt changes are
// additionally covered by the rules hash below.
const VERSION = 1;
type Rejected = Array<{ text: string; issues: string[] }>;
type State = {
  version: number; inputHash: string; caseContextHash: string; attemptId: string;
  scenarioContext?: string; scenarioName?: string | null; report?: unknown;
  reviews: Record<string, ReportExampleReview>; rejected: Record<string, Rejected>;
};
export type ReportCheckpointStore = {
  load(): Promise<{ payload: string | null; caseContextHash: string }>;
  save(expected: string | null, payload: string): Promise<boolean>;
};
type Input = { transcript: unknown; evaluation: unknown; totalScore: unknown; scenarioContext?: string; scenarioName?: string | null; outcome?: string | null; source?: string };
const scope = new AsyncLocalStorage<{ state: State; expected: string | null; writes: Promise<void>; store: ReportCheckpointStore }>();
export function isReportCheckpointError(error: unknown): boolean {
  return error instanceof Error && /^(?:REPORT_CHECKPOINT_|AUDIT_ANALYTICS_SUPERSEDED)/u.test(error.message);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export const reportCheckpointHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function inputHash(input: Input): string {
  const evaluation = { ...(input.evaluation as Record<string, unknown>) };
  for (const key of ['unified_call_report', 'call_summary', 'reply_improvements']) delete evaluation[key];
  // The initial bundle supplies these defaults; persisted evaluations may omit
  // them. Both paths must describe the same source rather than restart a draft.
  evaluation.dimension_scores = evaluation.dimension_scores && typeof evaluation.dimension_scores === 'object' ? evaluation.dimension_scores : undefined;
  for (const key of ['checklist', 'issues', 'recommendations']) evaluation[key] = Array.isArray(evaluation[key]) ? evaluation[key] : [];
  const transcript = Array.isArray(input.transcript) ? input.transcript.map(turn => ({ role: turn.role, text: String(turn.text ?? '').trim() })) : input.transcript;
  return reportCheckpointHash({ version: VERSION, transcript, evaluation, totalScore: input.totalScore,
    scenarioContext: input.scenarioContext ?? '', scenarioName: input.scenarioName ?? '', outcome: input.outcome ?? '', source: input.source ?? 'call',
    model: config.openaiChatModel, reasoning: config.openaiReasoningEffort, rules: [REPORT_QUALITY_RULES, REPORT_EXAMPLE_ACCEPTANCE_RULES] });
}

export function databaseReportCheckpointStore(key: string, db: PrismaClient = prisma): ReportCheckpointStore {
  const [kind, ...parts] = key.split(':'); const id = parts.join(':');
  const delegate = kind === 'voice' ? db.voiceCallSession : db.trainerSession;
  const identity = kind === 'voice' ? { callId: id } : { id };
  let row: any;
  return {
    async load() {
      row = await (delegate.findUnique as any)({ where: identity,
        select: { reportCheckpointJson: true, transcriptJson: true, evaluationJson: true, caseContextJson: true } });
      if (!row) throw new Error('REPORT_CHECKPOINT_OWNER_NOT_FOUND');
      let caseContext: any;
      try { caseContext = JSON.parse(row.caseContextJson ?? '{}'); } catch { caseContext = row.caseContextJson; }
      if (caseContext && typeof caseContext === 'object') delete caseContext.realtime;
      return { payload: row.reportCheckpointJson ?? null, caseContextHash: reportCheckpointHash(caseContext) };
    },
    async save(expected, payload) {
      assertAuditAnalyticsCurrent(); assertReportGenerationActive();
      const result = await (delegate.updateMany as any)({ where: { ...identity, reportCheckpointJson: expected,
        transcriptJson: row.transcriptJson, evaluationJson: row.evaluationJson, caseContextJson: row.caseContextJson },
        data: { reportCheckpointJson: payload } });
      return result.count === 1;
    },
  };
}

export async function withReportCheckpoint<T extends Input, R>(input: T, task: (input: T) => Promise<R>, options: { key?: string; store?: ReportCheckpointStore } = {}): Promise<R> {
  if (scope.getStore()) return task(input);
  const key = options.key ?? currentAuditAnalyticsKey();
  if (!key || !/^(voice|trainer):.+$/u.test(key)) return task(input);
  const store = options.store ?? databaseReportCheckpointStore(key);
  const saved = await store.load();
  let previous: State | undefined;
  try { previous = saved.payload ? JSON.parse(saved.payload) : undefined; } catch { /* corrupt drafts are regenerated */ }
  const valid = previous && typeof previous === 'object' && typeof previous.reviews === 'object' && previous.reviews !== null
    && !Array.isArray(previous.reviews) && typeof previous.rejected === 'object' && previous.rejected !== null && !Array.isArray(previous.rejected)
    && (!previous.report || (typeof previous.report === 'object' && !Array.isArray(previous.report)));
  const contextUnchanged = valid && previous?.version === VERSION && previous.caseContextHash === saved.caseContextHash;
  const effective = { ...input,
    scenarioContext: input.scenarioContext ?? (contextUnchanged ? previous?.scenarioContext : undefined),
    scenarioName: input.scenarioName ?? (contextUnchanged ? previous?.scenarioName : undefined) };
  const hash = inputHash(effective);
  const state: State = contextUnchanged && previous?.inputHash === hash && previous.reviews && previous.rejected
    ? { ...previous, attemptId: randomUUID() }
    : { version: VERSION, inputHash: hash, caseContextHash: saved.caseContextHash, attemptId: randomUUID(),
      scenarioContext: effective.scenarioContext, scenarioName: effective.scenarioName, reviews: {}, rejected: {} };
  return scope.run({ state, expected: saved.payload, store, writes: Promise.resolve() }, async () => {
    await persist(); // Claim the source snapshot before starting paid requests.
    return task(effective);
  });
}

async function persist(): Promise<void> {
  const current = scope.getStore(); if (!current) return;
  assertAuditAnalyticsCurrent(); assertReportGenerationActive();
  const payload = JSON.stringify(current.state);
  current.writes = current.writes.then(async () => {
    let saved: boolean;
    try { saved = await current.store.save(current.expected, payload); }
    catch (error) { if (isReportCheckpointError(error)) throw error; throw new Error('REPORT_CHECKPOINT_SAVE_FAILED', { cause: error }); }
    if (!saved) throw new Error('REPORT_CHECKPOINT_CONFLICT');
    current.expected = payload;
  });
  await current.writes;
}
export function savedReportDraft(): unknown { return scope.getStore()?.state.report; }
export async function saveReportDraft(report: unknown): Promise<void> {
  const current = scope.getStore(); if (!current) return;
  current.state.report = JSON.parse(JSON.stringify(report));
  await persist();
}
export function savedReportRejections(): ReadonlyMap<number, Rejected> {
  return new Map(Object.entries(scope.getStore()?.state.rejected ?? {}).map(([index, items]) => [Number(index), items]));
}
export function rememberReportRejection(index: number, text: string, issues: string[]): void {
  const current = scope.getStore(); if (!current) return;
  const items = current.state.rejected[index] ?? [];
  if (!items.some(item => item.text === text && JSON.stringify(item.issues) === JSON.stringify(issues))) {
    current.state.rejected[index] = [...items, { text, issues }].slice(-10);
  }
}
export function cachedReportReview(task: ReportExampleTask): ReportExampleReview | undefined {
  return scope.getStore()?.state.reviews[reportCheckpointHash(task)];
}
export async function saveReportReview(task: ReportExampleTask, review: ReportExampleReview): Promise<void> {
  const current = scope.getStore(); if (!current) return;
  if (review.status === 'review' || review.exampleHash !== createHash('sha256').update(task.example).digest('hex')) return;
  current.state.reviews[reportCheckpointHash(task)] = review;
  await persist();
}
