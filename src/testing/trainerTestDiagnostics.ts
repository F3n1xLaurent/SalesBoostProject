import fs from 'node:fs/promises';
import path from 'node:path';
import type { TrainerTestRun } from './trainerAutoTesting';
import { validRegressionId } from '../voice/realtimeRegressionHistory';
import { redactDiagnosticData } from './autoTestingDiagnostics';

/** Local trusted CLI only; HTTP uses the owner-scoped service loader. */
export async function readLocalTrainerTestReport(id: string, root = path.resolve('storage/trainer-regression')): Promise<TrainerTestRun> {
  if (!validRegressionId(id)) throw new Error('Некорректный ID проверки.');
  const run = JSON.parse(await fs.readFile(path.join(root, id, 'report.json'), 'utf8')) as TrainerTestRun;
  if (!run || run.id !== id || run.target !== 'trainer' || !Array.isArray(run.cases) || !Array.isArray(run.checklist)) throw new Error('Повреждённый отчёт автотеста тренировки.');
  return run;
}
export function trainerTestDiagnostics(run: TrainerTestRun, selection: { checkId?: string; scenarioId?: string }) {
  if (selection.checkId && !run.checklist.some((item) => item.id === selection.checkId)) throw new Error('Неизвестный пункт тренировки.');
  if (selection.scenarioId && !run.cases.some((item) => item.id === selection.scenarioId)) throw new Error('Неизвестный сценарий тренировки.');
  const { ownerId: _owner, executorPid: _pid, ...report } = run;
  return redactDiagnosticData({ ...report,
    checklist: report.checklist.filter((item) => !selection.checkId || item.id === selection.checkId),
    cases: report.cases.filter((item) => (!selection.scenarioId || item.id === selection.scenarioId) && (!selection.checkId || item.checks.some((point) => point.id === selection.checkId))),
  });
}
