import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config';
import { prisma } from '../src/db';
import { withCostContext } from '../src/economics/costContext';
import { assessReportOutput } from '../src/testing/reportTestEvaluation';

async function main() {
  const [directory, ...args] = process.argv.slice(2);
  if (!directory || !args.includes('--execute')) throw new Error('Paid assessment: node --import tsx scripts/assess-report-benchmark.ts /tmp/benchmark --execute baseline optimized');
  if (config.aiApiProvider !== 'proxyapi') throw new Error('ProxyAPI required');
  const labels = args.filter(value => value !== '--execute');
  if (!labels.length || labels.some(value => !/^[a-z0-9_-]+$/iu.test(value))) throw new Error('Invalid labels');
  const input = JSON.parse(await readFile(resolve(directory, 'input.json'), 'utf8'));
  const fixture = { ...input.fixture, checks: ['report-all-problems', 'report-main-problem', 'report-known-context', 'report-preserve-strengths', 'report-one-question', 'report-consistent-data'] };
  const id = `report-comparison-${randomUUID()}`;
  const results = await withCostContext({ entityType: 'report_benchmark', entityId: id, stage: 'independent_assessment' }, () => Promise.all(labels.map(async label => {
    const saved = JSON.parse(await readFile(resolve(directory, `${label}.json`), 'utf8'));
    if (!saved.report) throw new Error(`${label} has no report`);
    // The assessor sees transcript, evaluation and report, without the label,
    // speed, reasoning setting or previous example-review verdicts.
    const checks = await assessReportOutput(fixture, { report: saved.report, transcript: input.transcript, evaluation: input.evaluation,
      timings: { evaluationMs: 0, reportMs: 0, totalMs: 0 } }, AbortSignal.timeout(200_000));
    return { label, checks };
  })));
  const cost = await prisma.costEvent.aggregate({ where: { entityType: 'report_benchmark', entityId: id }, _count: true, _sum: { amountRub: true } });
  const output = resolve(directory, `assessment-${labels.join('-')}.json`);
  await writeFile(output, JSON.stringify({ id, model: config.openaiChatModel, results, cost }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, results, cost }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
