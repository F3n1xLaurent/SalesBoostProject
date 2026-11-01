import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { readLocalReportTest, reportTestDiagnostics } from '../testing/reportTestDiagnostics';
import type { ReportTestRun } from '../testing/reportAutoTesting';

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
it('analyses a saved report by ID through the real CLI, offline and without credentials', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'report-cli-')); roots.push(cwd);
  const root = path.join(cwd, 'storage/report-regression'); await fs.mkdir(path.join(root, 'report-run'), { recursive: true });
  const check = { id: 'report-single-example', title: 'Один пример', status: 'fail', evidence: ['Разные примеры'] };
  const run = { id: 'report-run', ownerId: 'private-owner', executorPid: 123, target: 'report', status: 'completed', checklist: [check], cases: [{ id: 'call-closing', checks: [check], output: { report: { summary: 'Не закрепил визит' } } }], configuration: { apiKey: 'private-key' } } as unknown as ReportTestRun;
  await fs.writeFile(path.join(root, run.id, 'report.json'), JSON.stringify(run));
  expect((await readLocalReportTest(run.id, root)).id).toBe(run.id);
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', require.resolve('tsx'), path.resolve('scripts/inspect-autotest.ts'), run.id, '--check', check.id, '--json'], { cwd });
  expect(JSON.parse(stdout).report.cases[0].output.report.summary).toBe('Не закрепил визит');
  expect(stdout).not.toContain('private-owner'); expect(stdout).not.toContain('private-key'); expect(stdout).not.toContain('executorPid');
  expect(() => reportTestDiagnostics(run, { checkId: 'unknown' })).toThrow('Неизвестный пункт');
  await expect(readLocalReportTest('../run', root)).rejects.toThrow('Некорректный ID');
});
