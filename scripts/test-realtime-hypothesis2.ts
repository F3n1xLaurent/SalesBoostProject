import 'dotenv/config';
import type { Request } from 'express';
import { prisma } from '../src/db';
import { config } from '../src/config';
import { resolveRealtimeTestPlanConfiguration } from '../src/voice/callSettingsManagement';
import { cancelRegression, startRegression } from '../src/voice/realtimeRegression';
import { regressionScenarios } from '../src/voice/realtimeRegressionScenarios';
import { loadRegressionReport } from '../src/voice/realtimeRegressionHistory';

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
async function main() {
  if (process.argv.includes('--list')) {
    for (const item of regressionScenarios('выбранный автомобиль')) console.log(`${item.id}: ${item.title}`);
    return;
  }
  const planId = argument('--plan');
  if (!planId) throw new Error('Укажите --plan <id>. Список сценариев: --list; выбор: --scenarios acknowledgement,interruption');
  const account = await prisma.account.findFirst({
    where: { status: 'active', ...(argument('--email') ? { email: argument('--email') } : { memberships: { some: { role: 'platform_superadmin' } } }) },
    include: { memberships: true, permissionTemplateAssignments: { include: { template: true } } },
  });
  if (!account) throw new Error('Не найден активный администратор; укажите --email.');
  const currentPlan = await resolveRealtimeTestPlanConfiguration({ authAccount: account } as unknown as Request, planId);
  const referenceId = argument('--reference');
  const reference = referenceId ? await loadRegressionReport(referenceId, account.id) : null;
  if (referenceId && (!reference || reference.planId !== planId)) throw new Error('Исходный тест не найден или относится к другому плану.');
  const plan = reference?.configuration?.plan ?? currentPlan;
  const run = await startRegression(plan, account.id, argument('--model') || config.openaiRealtimeModel, argument('--scenarios')?.split(','), {
    checkIds: argument('--checks')?.split(','), parentRunId: referenceId,
  });
  process.once('SIGINT', () => cancelRegression(run.id));
  console.log(`RUN_ID ${run.id}`);
  let progress = '';
  while (run.status === 'running') {
    if (progress !== run.progress) { progress = run.progress; console.log(progress); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(`STATUS ${run.status}`);
  for (const item of run.cases) console.log(`${item.id}: ${item.status}${item.error ? ` — ${item.error}` : ''}`);
  for (const item of run.checklist) console.log(`${item.status.toUpperCase()} ${item.title}: ${item.evidence.join(' | ')}`);
  console.log(`REPORT storage/realtime-regression/${run.id}/report.json`);
  process.exitCode = run.status !== 'completed' || run.cases.some((x) => x.status === 'failed') || run.checklist.some((x) => x.status === 'fail') ? 1 : 0;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
