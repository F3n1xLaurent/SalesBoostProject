import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const usage = `Usage:
  npm run report:prod -- fetch <call|trainer> <numeric-id|UUID>
  npm run report:prod -- generate <artifact-directory> [--draft <report.json>]
  npm run report:prod -- publish <artifact-directory>
  npm run report:prod -- status <artifact-directory>
  npm run report:prod -- rollback <artifact-directory>
Environment: PROD_DIAGNOSTIC_BASE_URL=https://app.salsa-sales.ru
             PROD_DIAGNOSTIC_TOKEN=<existing diagnostic token>`;
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
async function writeJson(file: string, data: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
type Destination = { baseUrl: string };
function target(): Destination {
  return { baseUrl: validateBaseUrl(process.env.PROD_DIAGNOSTIC_BASE_URL || '').origin };
}
function validateBaseUrl(value: string): URL {
  let base: URL;
  try { base = new URL(value); } catch { throw new Error('Set PROD_DIAGNOSTIC_BASE_URL in local .env'); }
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Diagnostic base URL must be an HTTPS origin without credentials or query parameters');
  return base;
}
export async function diagnosticReportRemote(destination: Destination, request: any): Promise<any> {
  const base = validateBaseUrl(destination.baseUrl);
  const token = process.env.PROD_DIAGNOSTIC_TOKEN;
  if (!token || token.length < 32) throw new Error('Set PROD_DIAGNOSTIC_TOKEN (32+ characters) in local .env');
  let pathname: string, body: unknown;
  if (request.action === 'fetch') pathname = `/api/internal/diagnostics/reports/${encodeURIComponent(request.kind)}/${encodeURIComponent(request.id)}`;
  else if (request.action === 'publish') {
    pathname = `/api/internal/diagnostics/reports/${encodeURIComponent(request.snapshot.kind)}/${encodeURIComponent(request.snapshot.session.id)}`;
    body = { operationId: request.operationId, fingerprint: request.snapshot.fingerprint, report: request.report };
  } else if (['status', 'rollback'].includes(request.action)) pathname = `/api/internal/diagnostics/report-operations/${encodeURIComponent(request.operationId)}${request.action === 'rollback' ? '/rollback' : ''}`;
  else throw new Error('INVALID_ACTION');
  const response = await fetch(new URL(pathname, base), {
    method: ['publish', 'rollback'].includes(request.action) ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty diagnostic response; use status before retrying publication');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('Diagnostic response exceeds 16 MiB'); }
    chunks.push(value);
  }
  let result: any;
  try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new Error(`Diagnostic report endpoint returned HTTP ${response.status} without JSON; check deployment and use status before retrying publication`); }
  if (!response.ok) throw new Error(`Diagnostic report operation failed: HTTP ${response.status} ${typeof result?.error === 'string' ? result.error : ''}`);
  return result;
}

export async function generateLocalProductionReport(folder: string, snapshot: any, draftFile?: string) {
  // Import generation code only here: fetch/publish/rollback neither load API
  // credentials nor invoke a model. All model calls run the local source tree.
  const [{ prisma }, { generateUnifiedCallReport, completeGeneratedUnifiedCallReport, requireCompleteReportExamples }, { withCallReportProblemCatalog, DEFAULT_CALL_REPORT_PROBLEMS },
    { buildCallReportScenarioContext }, { prepareTranscriptForAnalysis }, { filterUnreliableManagerTurns }, { withReportCheckpoint, reportCheckpointHash }, { withReportTrace }, { withCostContext }, { config }] = await Promise.all([
    import('../src/db'), import('../src/voice/unifiedCallReport'), import('../src/voice/problemCatalog'), import('../src/voice/callReportContext'),
    import('../src/voice/analysisTranscript'), import('../src/voice/transcriptReliability'), import('../src/voice/reportCheckpoint'), import('../src/voice/reportExecution'),
    import('../src/economics/costContext'), import('../src/config'),
  ]);
  try {
    const raw = JSON.parse(snapshot.session.transcriptJson || '[]');
    const transcript = snapshot.kind === 'call'
      ? filterUnreliableManagerTurns(prepareTranscriptForAnalysis(raw, { ivrDetected: Boolean(snapshot.session.ivrDetected) }).transcript)
      : filterUnreliableManagerTurns(raw.map((turn: any) => ({ role: ['manager', 'assistant'].includes(turn.role) ? 'manager' : 'client', text: String(turn.text || turn.content || '').trim() })).filter((turn: any) => turn.text));
    if (!transcript.some((turn: any) => turn.role === 'manager')) throw new Error('INSUFFICIENT_MANAGER_DIALOG');
    const evaluation = JSON.parse(snapshot.session.evaluationJson);
    delete evaluation.unified_call_report;
    const context = JSON.parse(snapshot.session.caseContextJson || '{}');
    const input = { transcript, evaluation, totalScore: snapshot.score, source: snapshot.kind === 'call' ? 'call' as const : 'trainer' as const,
      outcome: snapshot.kind === 'call' ? snapshot.session.outcome : 'trainer',
      scenarioName: snapshot.kind === 'trainer' ? context.scenario?.name || 'Тренировка' : undefined,
      scenarioContext: snapshot.kind === 'call' ? buildCallReportScenarioContext(snapshot.session.caseContextJson, snapshot.plan) : JSON.stringify(context.scenario ?? {}) };
    const checkpointPath = path.join(folder, 'checkpoint.json');
    let payload: string | null;
    try { payload = await readFile(checkpointPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; payload = null; }
    const store = {
      load: async () => ({ payload, caseContextHash: reportCheckpointHash(snapshot.fingerprint) }),
      save: async (expected: string | null, next: string) => { if (expected !== payload) return false; await writeJson(checkpointPath, JSON.parse(next)); payload = next; return true; },
    };
    const draft = draftFile ? await readJson(path.resolve(draftFile)) : undefined;
    let sequence = 0;
    const catalog = snapshot.catalog.length ? snapshot.catalog : DEFAULT_CALL_REPORT_PROBLEMS;
    const report = await withCallReportProblemCatalog(catalog, () => withCostContext({ entityType: 'production_report_repair', entityId: String(snapshot.session.callId ?? snapshot.session.id), stage: 'local_report_repair' }, () =>
      withReportTrace(async (stage, result) => writeJson(path.join(folder, `trace-${Date.now()}-${++sequence}-${stage}.json`), result), () =>
        withReportCheckpoint(input, effective => draft ? completeGeneratedUnifiedCallReport(draft, effective) : generateUnifiedCallReport(effective),
          { key: `${snapshot.kind === 'call' ? 'voice' : 'trainer'}:${snapshot.session.callId ?? snapshot.session.id}`, store }))));
    requireCompleteReportExamples(report);
    if (report.exampleReviews?.some(review => review.status !== 'pass')) throw new Error('REPLACEMENT_EXAMPLES_NOT_APPROVED: generate again to complete independent checks');
    await writeJson(path.join(folder, 'report.json'), report);
    await writeJson(path.join(folder, 'generation.json'), { snapshotFingerprint: snapshot.fingerprint, reportHash: createHash('sha256').update(JSON.stringify(report)).digest('hex'), model: config.openaiChatModel, generatedAt: new Date().toISOString() });
    console.log(JSON.stringify({ ok: true, stage: 'generated_locally', folder, totalScore: report.totalScore, findings: report.keyFindings.length, examples: report.exampleReviews?.length, model: config.openaiChatModel }));
  } finally { await prisma.$disconnect(); }
}

async function main() {
  const [action, argument, id, ...rest] = process.argv.slice(2);
  if (action === '--help' || action === '-h') { console.log(usage); return; }
  if (action === 'fetch') {
    if (!['call', 'trainer'].includes(argument) || !id || rest.length) throw new Error(usage);
    const destination = target();
    const snapshot = await diagnosticReportRemote(destination, { action, kind: argument, id });
    const operationId = randomUUID();
    const folder = path.resolve(process.env.REPORT_REPAIR_OUTPUT_DIR || 'storage/production-report-repairs', `${argument}-${snapshot.session.id}-${operationId}`);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeJson(path.join(folder, 'snapshot.json'), snapshot);
    await writeJson(path.join(folder, 'operation.json'), { operationId, destination, kind: argument, id: String(snapshot.session.id) });
    console.log(JSON.stringify({ ok: true, stage: 'downloaded', folder, totalScore: snapshot.score, hasReport: Boolean(JSON.parse(snapshot.session.evaluationJson).unified_call_report) }));
    return;
  }
  if (!['generate', 'publish', 'status', 'rollback'].includes(action) || !argument) throw new Error(usage);
  const folder = path.resolve(argument);
  const operation = await readJson(path.join(folder, 'operation.json'));
  if (action === 'generate') {
    if (id && (id !== '--draft' || rest.length !== 1)) throw new Error(usage);
    const lockPath = path.join(folder, 'generation.lock');
    const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('GENERATION_LOCKED: another generation may be running; inspect generation.lock'); });
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return await generateLocalProductionReport(folder, await readJson(path.join(folder, 'snapshot.json')), rest[0]);
    } finally { await lock.close(); await unlink(lockPath); }
  }
  if (id || rest.length) throw new Error(usage);
  let request: any = { action, operationId: operation.operationId };
  if (action === 'publish') {
    const snapshot = await readJson(path.join(folder, 'snapshot.json'));
    const report = await readJson(path.join(folder, 'report.json'));
    const generation = await readJson(path.join(folder, 'generation.json'));
    if (generation.snapshotFingerprint !== snapshot.fingerprint || generation.reportHash !== createHash('sha256').update(JSON.stringify(report)).digest('hex')) throw new Error('REPORT_ARTIFACT_CHANGED_REGENERATE_BEFORE_PUBLISH');
    request = { ...request, snapshot, report };
  }
  const receipt = await diagnosticReportRemote(operation.destination, request);
  await writeJson(path.join(folder, `${action}-receipt.json`), receipt);
  console.log(JSON.stringify(receipt));
}
if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
