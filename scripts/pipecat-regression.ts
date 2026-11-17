import 'dotenv/config';
import { spawn } from 'node:child_process';
import { REGRESSION_FIXTURE_VERSION, selectRegressionScenarios } from '../src/voice/realtimeRegressionScenarios';

async function main() {
  const args = process.argv.slice(2);
  const arg = (key: string) => args[args.indexOf(key) + 1];
  const synthetic = args.includes('--synthetic');
  const id = args.includes('--id') ? arg('--id') : '';
  if (!synthetic && !/^(?:pc-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) throw new Error('Укажите --synthetic или --id pc-<UUID> исходного звонка.');
  const provider = args.includes('--provider') ? arg('--provider') : 'openai';
  if (!['openai', 'openai_mini', 'gemini', 'gemini_proxyapi'].includes(provider)) throw new Error('Неизвестный провайдер.');
  const reasoning = args.includes('--reasoning') ? arg('--reasoning') : 'low';
  if (!['low', 'minimal'].includes(reasoning) || ((args.includes('--reasoning') || args.includes('--compare-reasoning')) && !['openai', 'openai_mini'].includes(provider))) throw new Error('Сравнение low/minimal доступно для OpenAI.');
  let trace: { configuration: { businessContext?: { subjectTitle?: string } } } = { configuration: { businessContext: { subjectTitle: 'Тестовый автомобиль' } } };
  if (!synthetic) {
    const response = await fetch(`${process.env.PIPECAT_HYPOTHESIS_URL}/sessions/${id}/export`, {
      headers: { Authorization: `Bearer ${process.env.PIPECAT_HYPOTHESIS_TOKEN}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Исходный журнал недоступен: HTTP ${response.status}`);
    trace = await response.json() as typeof trace;
  }
  const scenarios = selectRegressionScenarios(trace.configuration.businessContext?.subjectTitle || 'выбранный автомобиль', {
    ...(args.includes('--scenarios') ? { scenarioIds: arg('--scenarios').split(',') } : {}),
  });
  const command = ['exec', '-i', '-e', 'LOGURU_LEVEL=ERROR', 'salesboost-pipecat-pipecat-1', 'python', 'regression_probe.py', ...(synthetic ? ['--synthetic'] : ['--source', id]), '--provider', provider,
    '--reasoning', reasoning, ...(args.includes('--compare-reasoning') ? ['--compare-reasoning'] : []),
    ...(args.includes('--warm-tts') ? ['--warm-tts'] : []), ...(args.includes('--audio-tts') ? ['--audio-tts'] : [])];
  const processHandle = spawn('docker', command, { stdio: ['pipe', 'inherit', 'inherit'] });
  processHandle.stdin.end(JSON.stringify({ fixtureVersion: REGRESSION_FIXTURE_VERSION, scenarios }));
  processHandle.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  processHandle.on('exit', (code) => { process.exitCode = code ?? 1; });
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
