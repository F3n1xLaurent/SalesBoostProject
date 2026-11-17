import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--id');
  const id = (flag >= 0 ? args[flag + 1] : args[0]) || '';
  if (!/^(?:pc-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) throw new Error('Укажите --id pc-<UUID>');
  const base = process.env.PIPECAT_HYPOTHESIS_URL?.replace(/\/$/u, '');
  const token = process.env.PIPECAT_HYPOTHESIS_TOKEN;
  if (!base || !token) throw new Error('Не настроено подключение к Pipecat.');
  const response = await fetch(`${base}/sessions/${encodeURIComponent(id)}/export`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Diagnostic export HTTP ${response.status}`);
  const trace = await response.json();
  const directory = path.resolve('storage/pipecat-diagnostics'); fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${trace.diagnosticId}.json`);
  fs.writeFileSync(filename, JSON.stringify(trace, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ diagnosticId: trace.diagnosticId, status: trace.status, model: trace.model, reasoningEffort: trace.reasoningEffort, eventCount: trace.eventCount,
    transcriptMessages: trace.transcript?.length, legacy: trace.legacy, limitations: trace.limitations,
    summary: trace.summary, filename }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
