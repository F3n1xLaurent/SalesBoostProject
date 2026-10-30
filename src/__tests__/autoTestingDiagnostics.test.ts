import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RegressionRun } from '../voice/realtimeRegression';
import { autoTestDiagnostics, formatAutoTestDiagnostics, readLocalAutoTestReport, redactDiagnosticData } from '../testing/autoTestingDiagnostics';
import { loadRegressionReport } from '../voice/realtimeRegressionHistory';

const exec = promisify(execFile);
const temp: string[] = [];
async function fixture(run: RegressionRun) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'autotest-inspect-')); temp.push(cwd);
  const root = path.join(cwd, 'storage/realtime-regression');
  await fs.mkdir(path.join(root, run.id), { recursive: true });
  const file = path.join(root, run.id, 'report.json');
  await fs.writeFile(file, JSON.stringify(run));
  return { cwd, root, file };
}
afterEach(async () => { for (const dir of temp.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
function run(): RegressionRun {
  const ending = { id: 'ending' as const, title: 'Прощание', status: 'fail' as const, evidence: ['Два прощания'] };
  return { id: 'persisted-id', ownerId: 'owner', planId: 'plan', planName: 'План', status: 'completed', model: 'gpt-realtime-2.1', target: 'call_plan',
    createdAt: '2026-10-30T00:00:00Z', progress: 'Готово', parentRunId: 'previous', checklist: [ending], cases: [
      { id: 'closing', title: 'Завершение', status: 'completed', checks: [ending], audioFile: 'closing.wav', events: [{ atMs: 1200, type: 'playback_ended' }] },
      { id: 'female', title: 'Женский род', status: 'completed', checks: [{ id: 'identity', title: 'Легенда', status: 'pass', evidence: ['Род верен'] }] },
    ] };
}

describe('saved autotest diagnostics by persistent ID', () => {
  it('reads the same run after a fresh load and leaves the saved report untouched', async () => {
    const { root, file } = await fixture(run());
    const bytes = await fs.readFile(file, 'utf8');
    expect((await readLocalAutoTestReport('persisted-id', root)).id).toBe('persisted-id');
    const report = autoTestDiagnostics(await readLocalAutoTestReport('persisted-id', root));
    expect(report.parentRunId).toBe('previous'); expect(report.cases[0].audioFile).toBe('persisted-id/closing.wav');
    expect(report.cases[0].events).toEqual([{ atMs: 1200, type: 'playback_ended' }]);
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });
  it('rejects traversal, missing reports, corrupt JSON and mismatched IDs', async () => {
    const { root, file } = await fixture(run());
    for (const id of ['../persisted-id', '/etc/passwd', 'a/b', '%2e%2e', '']) await expect(readLocalAutoTestReport(id, root)).rejects.toThrow('Некорректный ID');
    await expect(readLocalAutoTestReport('absent', root)).rejects.toThrow('не найдена в локальном архиве');
    await fs.writeFile(file, 'not json'); await expect(readLocalAutoTestReport('persisted-id', root)).rejects.toThrow('некорректный JSON');
    await fs.writeFile(file, JSON.stringify({ ...run(), id: 'another' }));
    await expect(readLocalAutoTestReport('persisted-id', root)).rejects.toThrow('другому ID');
  });
  it('keeps HTTP history owner-scoped despite trusted local diagnostic access', async () => {
    const { root } = await fixture(run());
    expect(await loadRegressionReport('persisted-id', 'other-owner', root)).toBeNull();
    expect((await loadRegressionReport('persisted-id', 'owner', root))?.id).toBe('persisted-id');
  });
  it('supports precise check/scenario filters and explains invalid selections', () => {
    expect(autoTestDiagnostics(run(), { checkId: 'ending' }).cases.map((item) => item.id)).toEqual(['closing']);
    expect(autoTestDiagnostics(run(), { scenarioId: 'female' }).cases.map((item) => item.id)).toEqual(['female']);
    expect(() => autoTestDiagnostics(run(), { checkId: 'unknown' })).toThrow('нет пункта');
    expect(() => autoTestDiagnostics(run(), { scenarioId: 'unknown' })).toThrow('нет сценария');
    expect(() => autoTestDiagnostics(run(), { scenarioId: 'female', checkId: 'ending' })).toThrow('сочетания фильтров');
  });
  it('handles legacy metadata and warns about unfinished snapshots', () => {
    const source = run(); source.status = 'running'; delete source.target;
    const report = autoTestDiagnostics(source);
    expect(report.target).toBe('hypothesis2'); expect(report.warnings.some((warning) => warning.includes('неполным'))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('нет снимка'))).toBe(true);
    expect(formatAutoTestDiagnostics(report)).toContain('FAIL [ending]');
  });
  it('omits owner, arbitrary configuration and redacts credentials in diagnostic details', () => {
    const source = { ...run(), configuration: { apiKey: 'private-config-key' } } as unknown as RegressionRun;
    source.error = 'Authorization: Bearer opaque-token';
    source.checklist[0].evidence = ['sk-private-test-key-secret'];
    source.cases[0].assessment = { model: 'judge', response: { api_key: 'private-response-key', detail: 'use Bearer private-bearer' } };
    const serialized = JSON.stringify(autoTestDiagnostics(source));
    for (const secret of ['private-config-key', 'private-response-key', 'opaque-token', 'private-bearer', 'sk-private-test-key-secret', 'ownerId']) expect(serialized).not.toContain(secret);
    expect(redactDiagnosticData({ access_token: 'private', nested: { secret: 'hidden', count: 3 } })).toEqual({ access_token: '[REDACTED]', nested: { secret: '[REDACTED]', count: 3 } });
  });
  it('runs the real CLI from a local archive without a server, database or API requests', async () => {
    const { cwd } = await fixture(run());
    const script = path.resolve('scripts/inspect-autotest.ts');
    const { stdout } = await exec(process.execPath, ['--import', require.resolve('tsx'), script, 'persisted-id', '--check', 'ending', '--json'], { cwd });
    const report = JSON.parse(stdout);
    expect(report.id).toBe('persisted-id'); expect(report.cases.map((item: { id: string }) => item.id)).toEqual(['closing']);
    await expect(exec(process.execPath, ['--import', require.resolve('tsx'), script, 'absent'], { cwd })).rejects.toMatchObject({ code: 1 });
  });
});
