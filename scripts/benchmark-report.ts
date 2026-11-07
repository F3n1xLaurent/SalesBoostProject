import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../src/config';
import { prisma } from '../src/db';
import { openai } from '../src/lib/openaiClient';
import { withCostContext } from '../src/economics/costContext';
import { evaluateSessionV2 } from '../src/llm/evaluatorV2';
import { getDefaultState } from '../src/state/defaultState';
import { generateCallAnalyticsBundle } from '../src/voice/callAnalyticsBundle';
import { REPORT_TEST_SCENARIOS } from '../src/testing/reportTestCatalog';
import { REPORT_SCENARIO_CONTEXT, reportCodeChecks } from '../src/testing/reportTestEvaluation';

function stage(params: any): string {
  const prompt = JSON.stringify(params.messages);
  if (prompt.includes('независимый редактор учебных примеров')) return 'exampleReview';
  if (prompt.includes('редактор учебных примеров для менеджеров')) return 'exampleRepair';
  if (prompt.includes('Заполни только недостающие метки')) return 'dialogCoverage';
  if (prompt.includes('проверяешь полноту отчёта')) return 'findingCoverage';
  if (prompt.includes('EvaluatorAgent')) return 'evaluation';
  return 'generation';
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--execute')) {
    console.log('Paid ProxyAPI benchmark: node --import tsx scripts/benchmark-report.ts --execute --out /tmp/report-benchmark --label baseline [--scenario call-changes] [--input /tmp/report-benchmark/input.json]');
    return;
  }
  const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const directory = resolve(option('--out', '/tmp/salesboost-report-benchmark'));
  const label = option('--label', 'measurement');
  if (!/^[a-z0-9_-]+$/iu.test(label)) throw new Error('Invalid label');
  if (config.aiApiProvider !== 'proxyapi' || !new URL(config.openaiBaseUrl).hostname.endsWith('proxyapi.ru')) throw new Error('Benchmark requires configured ProxyAPI provider');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fixture = REPORT_TEST_SCENARIOS.find(item => item.id === option('--scenario', 'call-changes'));
  if (!fixture) throw new Error('Unknown built-in scenario');
  const requests: any[] = [];
  const id = `benchmark-${label}-${randomUUID()}`;
  const original = openai.chat.completions.create.bind(openai.chat.completions) as any;
  (openai.chat.completions as any).create = async (params: any, options: any = {}) => {
    if (requests.length >= 16) throw new Error('Benchmark request cap (16) reached');
    const entry: any = { index: requests.length + 1, stage: stage(params), startedAt: performance.now(), inputCharacters: JSON.stringify(params.messages).length,
      reasoningEffort: params.reasoning_effort, maxTokens: params.max_completion_tokens ?? params.max_tokens };
    requests.push(entry);
    try {
      const response = await original(params, { ...options, timeout: Math.min(options.timeout ?? 120_000, 120_000), maxRetries: 0 });
      entry.usage = response.usage; entry.response = response;
      return response;
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); throw error; }
    finally {
      entry.durationMs = Math.round(performance.now() - entry.startedAt);
      console.log(JSON.stringify({ request: entry.index, stage: entry.stage, durationMs: entry.durationMs, usage: entry.usage, error: entry.error }));
    }
  };
  let input: any;
  const result: any = { id, label, provider: config.aiApiProvider, model: config.openaiChatModel, reasoning: config.openaiReasoningEffort, requests };
  try {
    await withCostContext({ entityType: 'report_benchmark', entityId: id }, async () => {
      const inputPath = option('--input', '');
      input = inputPath ? JSON.parse(await readFile(inputPath, 'utf8')) : {
        fixture, transcript: fixture.transcript, scenarioContext: REPORT_SCENARIO_CONTEXT,
        evaluation: (await evaluateSessionV2({
          dialogHistory: fixture.transcript.map(({ role, text }) => ({ role, content: text })),
          car: { id: 'report-gle', title: 'Mercedes-Benz GLE 2023', brand: 'Mercedes-Benz', model: 'GLE', year: 2023, price_rub: 6405000, mileage_km: 18000, technical: {}, description: {}, deal_terms: {}, location: {} },
          state: getDefaultState(), earlyFail: false, scenarioContext: REPORT_SCENARIO_CONTEXT,
        })).evaluation,
      };
      if (!inputPath) await writeFile(resolve(directory, 'input.json'), JSON.stringify(input, null, 2), { mode: 0o600 });
      result.inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const started = performance.now();
      try {
        const bundle = await generateCallAnalyticsBundle({ transcript: input.transcript, outcome: 'completed', totalScore: input.evaluation.overall_score_0_100, evaluation: input.evaluation, scenarioContext: input.scenarioContext });
        if (!bundle.unifiedCallReport) throw new Error('No report');
        result.report = bundle.unifiedCallReport;
        result.checks = reportCodeChecks(input.fixture, { report: result.report, evaluation: input.evaluation, transcript: input.transcript, timings: { reportMs: 0, evaluationMs: 0, totalMs: 0 } });
      } finally { result.reportMs = Math.round(performance.now() - started); }
    });
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
  finally {
    result.cost = await prisma.costEvent.aggregate({ where: { provider: 'proxyapi', entityType: 'report_benchmark', entityId: id }, _count: true, _sum: { amountRub: true, inputUnits: true, outputUnits: true } }).catch(() => null);
    await writeFile(resolve(directory, `${label}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log('RESULT', JSON.stringify({ label, reportMs: result.reportMs, requests: requests.length, error: result.error, findings: result.report?.keyFindings.length, reviews: result.report?.exampleReviews?.map((review: any) => review.status), checks: result.checks?.filter((check: any) => check.status === 'fail'), cost: result.cost, output: resolve(directory, `${label}.json`) }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
