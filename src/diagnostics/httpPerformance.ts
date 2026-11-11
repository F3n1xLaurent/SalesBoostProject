import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';

type Stage = 'auth' | 'support_categories' | 'bitrix_http' | 'bitrix_refresh';
type Timing = { count: number; ms: number; maxMs: number };
type Context = { open: boolean; stages: Map<Stage, Timing>; pendingStages: Map<Stage, number>;
  db: Map<string, Timing>; dbCount: number; dbMs: number; dbInFlight: number };
const context = new AsyncLocalStorage<Context>();
export function withoutHttpDiagnostics<T>(task: () => T): T { return context.exit(task); }
const round = (value: number) => Math.round(value * 10) / 10;

function add<K>(map: Map<K, Timing>, name: K, ms: number) {
  const timing = map.get(name) ?? { count: 0, ms: 0, maxMs: 0 };
  timing.count++; timing.ms += ms; timing.maxMs = Math.max(timing.maxMs, ms);
  map.set(name, timing);
}

export async function measureHttpStage<T>(name: Stage, task: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (!current?.open) return task();
  const started = performance.now();
  current.pendingStages.set(name, (current.pendingStages.get(name) ?? 0) + 1);
  try { return await task(); }
  finally {
    current.pendingStages.set(name, current.pendingStages.get(name)! - 1);
    if (current.open) add(current.stages, name, performance.now() - started);
  }
}

/** Prisma operation wall time includes connection/engine wait, not only SQL.
 * Never retain SQL, params, rows or request bodies. Background work is excluded
 * unless it was started from this particular HTTP request's async context. */
export function instrumentPrismaHttpTiming(client: Pick<PrismaClient, '$use'>) {
  client.$use(async (params, next) => {
    const current = context.getStore();
    if (!current?.open) return next(params);
    const started = performance.now();
    current.dbInFlight++;
    try { return await next(params); }
    finally {
      current.dbInFlight--;
      if (current.open) {
        const ms = performance.now() - started;
        current.dbCount++; current.dbMs += ms;
        const operation = `${params.model ?? '$raw'}.${params.action}`;
        add(current.db, current.db.has(operation) || current.db.size < 50 ? operation : 'other', ms);
      }
    }
  });
}

export type HttpPerformanceLog = {
  requestId: string; method: string; family: string; route: string; status: number; aborted: boolean;
  durationMs: number; headersMs: number | null; dbCount: number; dbMs: number; dbInFlight: number;
  pendingStages: Record<string, number>;
  stages: Record<string, Timing>; dbTop: Array<Timing & { operation: string }>;
  processCpuMs: number; eventLoopUtilization: number;
};

/** The frontend gets timings for every targeted response; slow/error requests
 * also produce a single bounded, structured log without URLs or credentials. */
export function createHttpPerformanceMiddleware(options: {
  enabled?: boolean; slowMs?: number; log?: (record: HttpPerformanceLog) => void;
} = {}): RequestHandler {
  const enabled = options.enabled ?? process.env.HTTP_DIAGNOSTICS_ENABLED !== 'false';
  const configured = Number(process.env.HTTP_DIAGNOSTICS_SLOW_MS ?? 1000);
  const slowMs = options.slowMs ?? (Number.isFinite(configured) && configured >= 0 ? configured : 1000);
  const log = options.log ?? (record => console.info('[http-diagnostics]', JSON.stringify(record)));
  return (req, res, next) => {
    const path = req.originalUrl.split('?')[0].toLowerCase();
    const family = /^\/api\/support\/meta\/?$/.test(path) ? '/api/support/meta'
      : path === '/api/admin' || path.startsWith('/api/admin/') ? '/api/admin' : null;
    if (!enabled || !family) return next();
    const current: Context = { open: true, stages: new Map(), pendingStages: new Map(),
      db: new Map(), dbCount: 0, dbMs: 0, dbInFlight: 0 };
    const requestId = randomUUID(), started = performance.now(), cpu = process.cpuUsage();
    const loop = performance.eventLoopUtilization();
    let headersMs: number | null = null, finished = false;
    // Route templates are safe; originalUrl/path/params may contain PII/secrets.
    let route = `${family}/:unmatched`;
    const captureRoute = () => {
      if (typeof req.route?.path !== 'string') return;
      // This known static router mount is safe; arbitrary baseUrl values can
      // contain actual account IDs and must not be copied into a log.
      route = req.baseUrl === '/api/admin/billing' ? `${req.baseUrl}${req.route.path}` : req.route.path;
    };
    res.setHeader('X-Request-ID', requestId);
    const writeHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: any[]) {
      if (headersMs == null) {
        captureRoute();
        headersMs = performance.now() - started;
        const timings = [`app;dur=${round(headersMs)}`, `db;dur=${round(current.dbMs)}`,
          ...Array.from(current.stages, ([name, value]) => `${name};dur=${round(value.ms)}`)];
        const previous = res.getHeader('Server-Timing');
        res.setHeader('Server-Timing', [...(previous ? [String(previous)] : []), ...timings].join(', '));
      }
      return Reflect.apply(writeHead, this, args);
    } as Response['writeHead'];
    const finish = (aborted: boolean) => {
      if (finished) return;
      finished = true; captureRoute();
      current.open = false;
      const durationMs = performance.now() - started;
      if (!aborted && res.statusCode < 500 && durationMs < slowMs) return;
      const usage = process.cpuUsage(cpu);
      log({ requestId, method: req.method, family, route, status: aborted ? 499 : res.statusCode, aborted,
        durationMs: round(durationMs), headersMs: headersMs == null ? null : round(headersMs),
        dbCount: current.dbCount, dbMs: round(current.dbMs), dbInFlight: current.dbInFlight,
        pendingStages: Object.fromEntries([...current.pendingStages].filter(([, count]) => count > 0)),
        stages: Object.fromEntries(Array.from(current.stages, ([name, t]) => [name, { count: t.count, ms: round(t.ms), maxMs: round(t.maxMs) }])),
        dbTop: Array.from(current.db, ([operation, t]) => ({ operation, count: t.count, ms: round(t.ms), maxMs: round(t.maxMs) }))
          .sort((a, b) => b.ms - a.ms).slice(0, 5),
        processCpuMs: round((usage.user + usage.system) / 1000),
        eventLoopUtilization: round(performance.eventLoopUtilization(loop).utilization * 100) / 100,
      });
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(true));
    context.run(current, next);
  };
}
