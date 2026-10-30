import fs from 'node:fs/promises';
import path from 'node:path';
import type { RegressionCheck, RegressionRun } from './realtimeRegression';
import { REGRESSION_CHECKLIST, regressionScenarios, type CheckId } from './realtimeRegressionScenarios';

export const REGRESSION_ROOT = path.resolve('storage/realtime-regression');
export const EVALUATOR_VERSION = '2026-10-29.6';
export const validRegressionId = (id: string) => /^[a-z0-9-]{1,64}$/i.test(id);
export type RegressionTiming = { samples: number; medianMs: number | null; p95Ms: number | null };

export function regressionTiming(run: RegressionRun, checkId?: CheckId): RegressionTiming {
  const relevant = new Set(regressionScenarios('').filter((s) => !checkId || s.checks.includes(checkId)).map((s) => s.id));
  const samples = run.cases.filter((c) => relevant.has(c.id)).flatMap((c) => c.session?.transcript
    .filter((x) => x.role === 'client' && !x.metrics.interrupted)
    .map((x) => x.metrics.speechToVoxPlaybackMs).filter((x): x is number => x != null && Number.isFinite(x)) ?? []).sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return { samples: samples.length, medianMs: samples.length ? Math.round(samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2) : null,
    p95Ms: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null };
}

export function summarizeRegression(run: RegressionRun) {
  return {
    id: run.id, planId: run.planId, planName: run.planName, model: run.model, status: run.status,
    target: run.target ?? 'hypothesis2', executionMode: run.executionMode ?? 'simulation',
    createdAt: run.createdAt, endedAt: run.endedAt, parentRunId: run.parentRunId,
    evaluatorVersion: run.evaluatorVersion, configurationHash: run.configurationHash,
    selectedCheckIds: run.selectedCheckIds, scenarioIds: run.cases.map((c) => c.id),
    counts: { pass: run.checklist.filter((x) => x.status === 'pass').length, fail: run.checklist.filter((x) => x.status === 'fail').length,
      review: run.checklist.filter((x) => x.status === 'review').length, not_run: run.checklist.filter((x) => x.status === 'not_run').length },
    casesCompleted: run.cases.filter((c) => c.status === 'completed').length, casesTotal: run.cases.length,
    checklist: run.checklist, timing: regressionTiming(run),
  };
}
export type RegressionSummary = ReturnType<typeof summarizeRegression>;

/** Read-only access to immutable historical reports; never migrates old files. */
export async function loadRegressionReport(id: string, ownerId: string, root = REGRESSION_ROOT): Promise<RegressionRun | null> {
  if (!validRegressionId(id)) return null;
  try {
    const run = JSON.parse(await fs.readFile(path.join(root, id, 'report.json'), 'utf8')) as RegressionRun;
    return run.id === id && run.ownerId === ownerId && Array.isArray(run.cases) && Array.isArray(run.checklist) ? run : null;
  } catch { return null; }
}
export async function listRegressionReports(ownerId: string, planId?: string, root = REGRESSION_ROOT): Promise<RegressionRun[]> {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const reports: RegressionRun[] = [];
  // Sequential reads keep a large audio history from exhausting file descriptors.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const run = await loadRegressionReport(entry.name, ownerId, root);
    if (run && (!planId || run.planId === planId)) reports.push(run);
  }
  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

function scenarioCoverage(run: RegressionRun, id: CheckId): string[] {
  const declared = regressionScenarios('').filter((s) => s.checks.includes(id)).map((s) => s.id);
  return run.cases.filter((c) => declared.includes(c.id)).map((c) => c.id).sort();
}
export function compareRegressionRuns(before: RegressionRun, after: RegressionRun) {
  const warnings: string[] = [];
  if (before.planId !== after.planId) warnings.push('Разные планы прозвона.');
  if ((before.target ?? 'hypothesis2') !== (after.target ?? 'hypothesis2')) warnings.push('Разные контуры: старая гипотеза и основная телефония.');
  if (before.model !== after.model) warnings.push('Разные Realtime-модели.');
  if (!before.configurationHash || !after.configurationHash) warnings.push('В старом отчёте нет снимка конфигурации; идентичность профиля и голоса не подтверждена.');
  else if (before.configurationHash !== after.configurationHash) warnings.push('Различаются профиль, голос или настройки диалога.');
  if (before.evaluatorVersion !== after.evaluatorVersion) warnings.push('Различаются версии оценщика; статусы требуют сопоставления по свидетельствам.');
  const rows = REGRESSION_CHECKLIST.map(([id, title]) => {
    const a = before.checklist.find((x) => x.id === id);
    const b = after.checklist.find((x) => x.id === id);
    const coverageBefore = scenarioCoverage(before, id);
    const coverageAfter = scenarioCoverage(after, id);
    const sameCoverage = coverageBefore.length > 0 && JSON.stringify(coverageBefore) === JSON.stringify(coverageAfter);
    const comparable = !warnings.length && sameCoverage;
    let change: 'unchanged' | 'fixed' | 'regressed' | 'changed' | 'not_rerun' | 'new' = 'changed';
    if (!b || b.status === 'not_run') change = 'not_rerun';
    else if (!a || a.status === 'not_run') change = 'new';
    else if (a.status === b.status) change = 'unchanged';
    else if (comparable && a.status === 'fail' && b.status === 'pass') change = 'fixed';
    else if (comparable && a.status === 'pass' && b.status === 'fail') change = 'regressed';
    const timingBefore = regressionTiming(before, id);
    const timingAfter = regressionTiming(after, id);
    return { id, title, before: a ?? null, after: b ?? null, change, comparable, coverageBefore, coverageAfter,
      timingBefore, timingAfter, medianDeltaMs: comparable && timingBefore.medianMs != null && timingAfter.medianMs != null
        ? timingAfter.medianMs - timingBefore.medianMs : null };
  });
  return { beforeId: before.id, afterId: after.id, warnings, rows };
}

export function aggregateRegressionChecks(run: RegressionRun): RegressionCheck[] {
  const catalog = regressionScenarios('');
  return REGRESSION_CHECKLIST.map(([id, title]) => {
    const relevantIds = catalog.filter((s) => s.checks.includes(id)).map((s) => s.id);
    const relevantCases = run.cases.filter((c) => relevantIds.includes(c.id));
    const items = relevantCases.flatMap((c) => c.checks.filter((x) => x.id === id));
    const failures = run.cases.flatMap((c) => c.checks.filter((x) => x.id === id && x.status === 'fail'));
    // A failed case with an old provisional green check cannot certify success.
    const incomplete = relevantCases.some((c) => c.status !== 'completed');
    const fullCoverage = relevantIds.every((caseId) => relevantCases.some((c) => c.id === caseId));
    const missingEvidence = relevantCases.some((c) => !c.checks.some((x) => x.id === id));
    const status = failures.length ? 'fail' : !relevantCases.length || relevantCases.every((c) => c.status === 'pending') ? 'not_run'
      : incomplete || !fullCoverage || missingEvidence || !items.length || items.some((x) => x.status === 'review' || x.status === 'not_run') ? 'review' : 'pass';
    return { id, title, status, evidence: [...new Set([...failures, ...items].flatMap((x) => x.evidence))] };
  });
}
