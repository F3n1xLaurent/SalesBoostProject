/** Paid synthetic regression: preserve every ASR fragment of one manager reply. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db';
import { withCostContext } from '../src/economics/costContext';
import { normalizeUnifiedCallReport, ensureReportExampleQuality, requireCompleteReportExamples } from '../src/voice/unifiedCallReport';
import { withReportGenerationBudget, withReportTrace } from '../src/voice/reportExecution';

async function main() {
  if (!process.argv.includes('--execute')) {
    console.log('Paid synthetic probe: node --import tsx scripts/probe-report-fragments.ts --execute');
    return;
  }
  const transcript = [
    { role: 'client' as const, text: 'Могу подъехать сегодня в 19:00. Какое состояние машины?' },
    { role: 'manager' as const, text: 'Да, будем ждать вас сегодня в 19:00.' },
    { role: 'manager' as const, text: 'Машина в отличном состоянии, ДТП не было, пороги не гнилые.' },
    { role: 'client' as const, text: 'А ещё мне нужен большой багажник.' },
  ];
  const source = normalizeUnifiedCallReport({ dialog: [{},
    { mark: 'normal', comment: 'Подтвердил визит, но не уточнил приоритеты клиента.' },
    { mark: 'positive', comment: 'Сообщил состояние автомобиля.' }, {}],
  }, { totalScore: 80, transcript })!;
  const started = performance.now();
  const trace: unknown[] = [];
  let result: Record<string, unknown>;
  try {
    const report = await withCostContext({ entityType: 'report_benchmark', entityId: `fragments-${randomUUID()}` },
      () => withReportGenerationBudget(() => withReportTrace(async (stage, value) => {
        trace.push({ stage, elapsedMs: Math.round(performance.now() - started), result: value });
      }, () => ensureReportExampleQuality(source, transcript))));
    requireCompleteReportExamples(report);
    const checks = { completeExample: !!report.dialog[1].betterExample,
      semanticReviewPassed: report.exampleReviews?.some(review => review.turnIndex === 1 && review.status === 'pass') === true,
      noFailedReview: !report.exampleReviews?.some(review => review.status === 'fail'),
      noFutureDisclosure: !/багажник/iu.test(report.dialog[1].betterExample ?? '') };
    result = { checks, passed: Object.values(checks).every(Boolean), report };
  } catch (error) {
    result = { passed: false, error: error instanceof Error ? error.message : String(error) };
  }
  const directory = resolve('storage/pipecat-benchmarks/stage6');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifact = { ...result, durationMs: Math.round(performance.now() - started), transcript, trace, phoneCalls: 0 };
  await writeFile(resolve(directory, 'fragmented-reply.json'), JSON.stringify(artifact, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks, durationMs: artifact.durationMs, error: result.error }));
  if (!result.passed) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
