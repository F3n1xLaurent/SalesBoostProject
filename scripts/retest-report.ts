import 'dotenv/config';
import type { Request } from 'express';
import { config } from '../src/config';
import { prisma } from '../src/db';
import { createReportAutoTesting } from '../src/testing/reportAutoTesting';
import { readLocalReportTest } from '../src/testing/reportTestDiagnostics';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('Платный перетест сохранённой проверки отчёта без звонков.\nnode --import tsx scripts/retest-report.ts --reference <ID> [--scenario <ID>] --execute');
    return;
  }
  let reference = '', scenario: string | undefined, execute = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--execute') { execute = true; continue; }
    if (!['--reference', '--scenario'].includes(flag || '') || !args[0] || args[0].startsWith('--')) throw new Error('Некорректные аргументы. Используйте --help.');
    if (flag === '--reference') reference = args.shift()!;
    else scenario = args.shift()!;
  }
  if (!reference || !execute) throw new Error('Укажите --reference и --execute: запуск расходует баланс API.');
  const before = await readLocalReportTest(reference);
  const runner = createReportAutoTesting();
  const run = await runner.start({ authAccount: { id: before.ownerId }, body: { referenceRunId: reference, ...(scenario ? { scenarioIds: [scenario] } : {}) } } as unknown as Request);
  console.log(`RUN_ID ${run.id}`);
  console.log(JSON.stringify({ model: run.model, reasoningEffort: run.configuration.reasoningEffort,
    reasoningProfileVersion: run.configuration.reasoningProfileVersion, reasoningByStage: run.configuration.reasoningByStage,
    provider: config.aiApiProvider, cases: run.cases.length }));
  let progress = '';
  while (run.status === 'running') {
    if (run.progress !== progress) { progress = run.progress; console.log(progress); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const cost = await prisma.costEvent.aggregate({ where: { provider: 'proxyapi', entityType: 'report_autotest', entityId: run.id }, _count: true, _sum: { amountRub: true, inputUnits: true, outputUnits: true } });
  console.log(`RESULT_JSON ${JSON.stringify({ id: run.id, status: run.status, error: run.error, counts: Object.fromEntries(['pass', 'fail', 'review', 'not_run'].map((status) => [status, run.checklist.filter((point) => point.status === status).length])), requests: cost._count, estimatedRub: cost._sum.amountRub, inputTokens: cost._sum.inputUnits, outputTokens: cost._sum.outputUnits })}`);
  if (run.status !== 'completed') process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
