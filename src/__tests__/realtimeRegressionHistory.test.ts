import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RegressionRun } from '../voice/realtimeRegression';
import { aggregateRegressionChecks, compareRegressionRuns, EVALUATOR_VERSION, listRegressionReports, loadRegressionReport } from '../voice/realtimeRegressionHistory';
import { selectRegressionScenarios } from '../voice/realtimeRegressionScenarios';

function report(id: string, status: 'pass' | 'fail' = 'pass', scenarioIds = ['acknowledgement', 'interruption']): RegressionRun {
  const run: RegressionRun = { id, ownerId: 'owner', planId: 'plan', planName: 'План', model: 'gpt-realtime-2', status: 'completed',
    createdAt: '2026-10-29T10:00:00Z', progress: 'готово', evaluatorVersion: EVALUATOR_VERSION, configurationHash: 'same-configuration',
    cases: scenarioIds.map((key) => ({ id: key, title: key, status: 'completed', checks: [{ id: 'interruption', title: 'Перебивания', status, evidence: [key] }] })), checklist: [] };
  run.checklist = aggregateRegressionChecks(run); return run;
}
const temp: string[] = [];
afterEach(async () => {
  for (const dir of temp.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('targeted regression certification', () => {
  it('selects all scenarios that establish one checklist requirement', () => {
    expect(selectRegressionScenarios('Киа', { checkIds: ['interruption'] }).map((x) => x.id)).toEqual(['acknowledgement', 'interruption']);
    expect(selectRegressionScenarios('Киа', { scenarioIds: ['female'] }).map((x) => x.id)).toEqual(['female']);
    expect(() => selectRegressionScenarios('Киа', { checkIds: ['typo'] })).toThrow();
    expect(() => selectRegressionScenarios('Киа', { checkIds: [] })).toThrow();
    expect(() => selectRegressionScenarios('Киа', { scenarioIds: ['female'], checkIds: ['identity'] })).toThrow();
  });
  it('does not green an entire direction after testing only half of its scenarios', () => {
    expect(report('partial', 'pass', ['acknowledgement']).checklist.find((x) => x.id === 'interruption')?.status).toBe('review');
    expect(report('complete').checklist.find((x) => x.id === 'interruption')?.status).toBe('pass');
  });
  it('does not green failed executions, missing evidence or a discovered failure outside the primary scenario', () => {
    const failed = report('failed'); failed.cases[0].status = 'failed';
    expect(aggregateRegressionChecks(failed).find((x) => x.id === 'interruption')?.status).toBe('review');
    const missing = report('missing'); missing.cases[0].checks = [];
    expect(aggregateRegressionChecks(missing).find((x) => x.id === 'interruption')?.status).toBe('review');
    const leak = report('leak'); leak.cases[0].checks.push({ id: 'technical', title: 'Технические фразы', status: 'fail', evidence: ['Вызови end_call'] });
    expect(aggregateRegressionChecks(leak).find((x) => x.id === 'technical')?.status).toBe('fail');
  });
  it('marks an actual fix but does not pretend untouched requirements regressed', () => {
    const before = report('before', 'fail'); const after = report('after');
    const compared = compareRegressionRuns(before, after);
    expect(compared.rows.find((x) => x.id === 'interruption')?.change).toBe('fixed');
    expect(compared.rows.find((x) => x.id === 'script')?.change).toBe('not_rerun');
    after.configurationHash = 'different';
    expect(compareRegressionRuns(before, after).rows.find((x) => x.id === 'interruption')?.change).toBe('changed');
  });
  it('warns on legacy metadata and different scenario coverage', () => {
    const old = report('old', 'fail'); delete old.configurationHash; delete old.evaluatorVersion;
    const comparison = compareRegressionRuns(old, report('new'));
    expect(comparison.warnings.length).toBe(2);
    expect(comparison.rows.find((x) => x.id === 'interruption')?.comparable).toBe(false);
    expect(compareRegressionRuns(report('full'), report('part', 'pass', ['acknowledgement'])).rows.find((x) => x.id === 'interruption')?.comparable).toBe(false);
  });
});

describe('persistent owner-scoped regression history', () => {
  it('loads older reports after restart, filters owner/plan, and ignores invalid paths and corrupt files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'regression-history-')); temp.push(root);
    const original = report('old'); original.createdAt = '2026-10-28T10:00:00Z';
    delete original.evaluatorVersion; delete original.configurationHash;
    const reports = [original, report('new'), { ...report('other-owner'), ownerId: 'someone' }, { ...report('other-plan'), planId: 'different' }];
    for (const run of reports) {
      await fs.mkdir(path.join(root, run.id)); await fs.writeFile(path.join(root, run.id, 'report.json'), JSON.stringify(run));
    }
    await fs.mkdir(path.join(root, 'corrupt')); await fs.writeFile(path.join(root, 'corrupt', 'report.json'), 'invalid json');
    expect((await listRegressionReports('owner', 'plan', root)).map((x) => x.id)).toEqual(['new', 'old']);
    expect(await loadRegressionReport('old', 'someone', root)).toBeNull();
    expect(await loadRegressionReport('../old', 'owner', root)).toBeNull();
    expect(await loadRegressionReport('old', 'owner', root)).toEqual(original);
    expect(JSON.parse(await fs.readFile(path.join(root, 'old', 'report.json'), 'utf8'))).toEqual(original);
  });
});
