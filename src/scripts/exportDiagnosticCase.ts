import 'dotenv/config';
import { gzipSync } from 'node:zlib';
import { prisma } from '../db';
import { loadDiagnosticCase } from '../diagnostics/loadDiagnosticCase';
import type { DiagnosticCaseRequest } from '../diagnostics/request';

function parseArguments(args: string[]): DiagnosticCaseRequest {
  const [kind, id, ...flags] = args;
  if ((kind !== 'trainer' && kind !== 'call') || !id) {
    throw new Error('Usage: exportDiagnosticCase <trainer|call> <session-id|call-id|call-db-id> [--audio] [--turn N]');
  }
  let includeAudio = false;
  let turnNumber: number | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--audio') includeAudio = true;
    else if (flag === '--turn') turnNumber = Number(flags[++index]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return { kind, id, includeAudio, turnNumber };
}

async function main(): Promise<void> {
  const bundle = await loadDiagnosticCase(parseArguments(process.argv.slice(2)));
  const bytes = gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 6 });
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(bytes, (error) => error ? reject(error) : resolve());
  });
  console.error(`[diagnostic-export] Exported ${bundle.kind} ${bundle.id}; audio=${bundle.audioIncluded}; gzip_bytes=${bytes.length}`);
}

main()
  .catch((error) => {
    console.error('[diagnostic-export] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
