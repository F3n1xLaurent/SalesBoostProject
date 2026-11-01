import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReportTestRun } from './reportAutoTesting';
import { validRegressionId } from '../voice/realtimeRegressionHistory';
import { redactDiagnosticData } from './autoTestingDiagnostics';

/** Trusted local archive reader, never a substitute for HTTP owner authorization. */
export async function readLocalReportTest(id: string, root = path.resolve('storage/report-regression')): Promise<ReportTestRun> {
  if (!validRegressionId(id)) throw new Error('Некорректный ID проверки.');
  const run = JSON.parse(await fs.readFile(path.join(root, id, 'report.json'), 'utf8')) as ReportTestRun;
  if (!run || run.id !== id || run.target !== 'report' || !Array.isArray(run.cases) || !Array.isArray(run.checklist)) throw new Error('Повреждённый автотест отчёта.');
  return run;
}
export function reportTestDiagnostics(run: ReportTestRun, selection: { checkId?: string; scenarioId?: string } = {}) {
  if (selection.checkId && !run.checklist.some((item) => item.id === selection.checkId)) throw new Error('Неизвестный пункт отчёта.');
  if (selection.scenarioId && !run.cases.some((item) => item.id === selection.scenarioId)) throw new Error('Неизвестный сценарий отчёта.');
  const { ownerId: _owner, executorPid: _pid, ...report } = run;
  const cases = report.cases.filter((item) => (!selection.scenarioId || item.id === selection.scenarioId) && (!selection.checkId || item.checks.some((point) => point.id === selection.checkId)));
  if ((selection.checkId || selection.scenarioId) && !cases.length) throw new Error('Нет сценариев для выбранного сочетания фильтров.');
  return redactDiagnosticData({ ...report, checklist: report.checklist.filter((item) => !selection.checkId || item.id === selection.checkId), cases });
}
