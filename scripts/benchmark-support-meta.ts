import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { prisma } from '../src/db';
import * as bitrix from '../src/support/bitrix24';

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--execute')) throw new Error('Read-only network benchmark requires --execute');
  const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const label = option('--label', 'measurement');
  if (!/^[a-z0-9_-]+$/iu.test(label)) throw new Error('Invalid label');
  const directory = resolve(option('--out', '/tmp/salesboost-support-benchmark'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result: any = { label, measuredAt: new Date().toISOString(), location: 'script execution environment', provider: [], getter: [], service: [] };
  const baselineGetter = option('--baseline-getter', '');
  const readerModule: { getBitrixSupportCategories: () => Promise<string[]>;
    getCachedBitrixSupportCategories?: () => string[]; refreshBitrixSupportCategories?: () => Promise<boolean> } =
    baselineGetter ? createRequire(resolve('package.json'))(resolve(baselineGetter)) : bitrix;
  result.getterVariant = baselineGetter ? 'pre-cache source snapshot' : 'current cached reader';
  console.log(JSON.stringify({ status: 'started', label }));
  try {
    const installation = await prisma.supportBitrixInstallation.findFirst({ where: { status: 'active' } });
    if (!installation || installation.accessTokenExpiresAt.getTime() <= Date.now() + 120_000) {
      throw new Error('A valid support OAuth access token is required; this benchmark never refreshes tokens');
    }
    const api = new URL(installation.clientEndpoint);
    if (api.protocol !== 'https:') throw new Error('Bitrix endpoint must use HTTPS');
    if (!api.pathname.endsWith('/')) api.pathname += '/';
    const token = bitrix.decryptBitrixToken(installation.accessTokenEncrypted);
    // Refuse OAuth refresh even if a valid-looking local installation contains
    // a token that the remote service has already invalidated.
    const networkFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === 'oauth.bitrix24.tech') return Promise.reject(new Error('OAuth refresh is disabled in read-only benchmark'));
      return networkFetch(input, init);
    }) as typeof fetch;
    const samples = args.includes('--skip-provider') ? 0 : 3;
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      try {
        const response = await fetch(new URL('crm.deal.fields.json', api), { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth: token }), signal: AbortSignal.timeout(20_000) });
        const headersMs = performance.now() - started;
        const body = await response.json() as any;
        const apiError = typeof body.error === 'string' && /^[a-z0-9_.-]{1,80}$/iu.test(body.error) ? body.error : undefined;
        result.provider.push({ status: response.status, headersMs: Math.round(headersMs), totalMs: Math.round(performance.now() - started),
          success: response.ok && !!body.result, fieldCount: body.result ? Object.keys(body.result).length : 0, apiError });
      } catch { result.provider.push({ success: false, error: 'network_or_json_error', totalMs: Math.round(performance.now() - started) }); }
      console.log(JSON.stringify({ kind: 'provider', ...result.provider.at(-1) }));
      await pause(600);
    }
    if (installation.accessTokenExpiresAt.getTime() <= Date.now() + 120_000) throw new Error('Token expiry too close; skipped getter to avoid OAuth refresh');
    await pause(1000);
    for (const phase of ['cold', 'warm']) {
      const started = performance.now();
      const categories = readerModule.getCachedBitrixSupportCategories
        ? readerModule.getCachedBitrixSupportCategories() : await readerModule.getBitrixSupportCategories();
      result.getter.push({ phase, totalMs: Number((performance.now() - started).toFixed(2)), categoryCount: categories.length });
      // The optimized reader returns immediately; allow its shared background
      // refresh to finish before comparing a genuinely warm cache.
      if (phase === 'cold' && readerModule.refreshBitrixSupportCategories) await readerModule.refreshBitrixSupportCategories();
    }
    console.log(JSON.stringify({ kind: 'getter', samples: result.getter }));
    const auth = process.env.PROD_BENCHMARK_TOKEN;
    const base = process.env.PROD_BENCHMARK_BASE_URL || process.env.PROD_DIAGNOSTIC_BASE_URL;
    if (auth && base) {
      const url = new URL(base);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Benchmark service base URL must be HTTPS without credentials/query');
      for (const path of ['/api/support/meta', '/api/admin/verify', '/api/admin/users?page=1&limit=10']) {
        for (let i = 0; i < 2; i++) {
          const started = performance.now();
          try {
            const response = await fetch(new URL(path, url), { redirect: 'error', headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(25_000) });
            const headersMs = performance.now() - started;
            const body = await response.arrayBuffer();
            result.service.push({ path: path.split('?')[0], status: response.status, headersMs: Math.round(headersMs),
              totalMs: Math.round(performance.now() - started), bytes: body.byteLength,
              serverTiming: response.headers.get('server-timing'), requestId: response.headers.get('x-request-id') });
          } catch { result.service.push({ path: path.split('?')[0], error: 'network_error', totalMs: Math.round(performance.now() - started) }); }
          console.log(JSON.stringify({ kind: 'service', ...result.service.at(-1) }));
          await pause(600);
        }
      }
    } else { result.serviceSkipped = 'PROD_BENCHMARK_TOKEN or service base URL is missing'; }
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'benchmark_failed'; process.exitCode = 1;
  } finally {
    const output = resolve(directory, `${label}.json`);
    await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ output, getter: result.getter, serviceSkipped: result.serviceSkipped, error: result.error }));
  }
}
main().catch(() => { console.error('Benchmark failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
