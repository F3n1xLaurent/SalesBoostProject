import 'dotenv/config';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDiagnosticCaseRequest, type DiagnosticCaseRequest } from '../diagnostics/request';

const MAX_DOWNLOAD_BYTES = 48 * 1024 * 1024;

function parseArguments(args: string[]): DiagnosticCaseRequest {
  const [kind, id, ...flags] = args;
  if ((kind !== 'trainer' && kind !== 'call') || !id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('Usage: fetchDiagnosticCase <trainer|call> <id> [--audio] [--turn N]');
  }
  let includeAudio = false;
  let turnNumber: number | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--audio') includeAudio = true;
    else if (flag === '--turn') turnNumber = Number(flags[++index]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  const request: DiagnosticCaseRequest = { kind, id, includeAudio, turnNumber };
  validateDiagnosticCaseRequest(request);
  return request;
}

async function main(): Promise<void> {
  const request = parseArguments(process.argv.slice(2));
  const baseUrl = process.env.PROD_DIAGNOSTIC_BASE_URL;
  const token = process.env.PROD_DIAGNOSTIC_TOKEN;
  if (!baseUrl || !token || token.length < 32) throw new Error('Set PROD_DIAGNOSTIC_BASE_URL and PROD_DIAGNOSTIC_TOKEN (32+ characters) in local .env');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
    throw new Error('Production diagnostic URL must use HTTPS');
  }
  if (base.username || base.password || base.search || base.hash) throw new Error('Base URL must not contain credentials or query parameters');
  const url = new URL(`/api/internal/diagnostics/${request.kind}/${request.id}`, base);
  if (request.includeAudio) url.searchParams.set('audio', '1');
  if (request.turnNumber !== undefined) url.searchParams.set('turn', String(request.turnNumber));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/gzip' },
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Diagnostic request failed: HTTP ${response.status}`);
  const announcedSize = Number(response.headers.get('content-length') ?? '0');
  if (announcedSize > MAX_DOWNLOAD_BYTES) throw new Error('Diagnostic download exceeds 48 MiB');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Diagnostic response has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error('Diagnostic download exceeds 48 MiB');
    }
    chunks.push(value);
  }
  const compressed = Buffer.concat(chunks, size);
  const bundle = JSON.parse(gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8')) as {
    format?: string; version?: number; kind?: string; id?: string;
  };
  if (bundle.format !== 'salesboost-diagnostic-case' || bundle.version !== 1 || bundle.kind !== request.kind || !bundle.id) {
    throw new Error('Unexpected diagnostic response format');
  }
  if (request.kind === 'trainer' && bundle.id !== request.id) throw new Error('Diagnostic ID does not match request');
  const directory = await mkdtemp(join(tmpdir(), 'salesboost-diagnostic-'));
  const filename = `${request.kind}-${request.id}.json.gz`;
  const outputPath = join(directory, filename);
  await writeFile(outputPath, compressed, { mode: 0o600, flag: 'wx' });
  console.log(outputPath);
  console.error(`[diagnostic-fetch] Downloaded ${request.kind} ${bundle.id}; gzip_bytes=${compressed.length}`);
}

main().catch((error) => {
  console.error('[diagnostic-fetch] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
