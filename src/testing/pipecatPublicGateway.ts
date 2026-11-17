import { Router } from 'express';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Public surface: per-call events/media and signed immutable background audio. */
export function pipecatPublicTarget(raw: string, kind: 'media' | 'events' | 'background', base = process.env.PIPECAT_HYPOTHESIS_URL): URL | null {
  if (!base) return null;
  try {
    const incoming = new URL(raw, 'http://localhost');
    const name = kind === 'background' ? '[a-f0-9]{64}\\.wav' : ID;
    const match = incoming.pathname.match(new RegExp(`^/pipecat/${kind}/(${name})$`, 'i'));
    const tokens = incoming.searchParams.getAll('token');
    if (!match || tokens.length !== 1 || incoming.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{32,128}$/u.test(tokens[0])) return null;
    const target = new URL(base.replace(/\/$/u, '') + `/${kind}/${match[1]}`);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    target.searchParams.set('token', tokens[0]);
    return target;
  } catch { return null; }
}

export function createPipecatPublicRouter(): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    const base = process.env.PIPECAT_HYPOTHESIS_URL;
    const token = process.env.PIPECAT_HYPOTHESIS_TOKEN;
    if (!base || !token) { res.status(503).json({ ok: false }); return; }
    try {
      const response = await fetch(base.replace(/\/$/u, '') + '/health', {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      res.status(response.ok ? 200 : 503).json({ ok: response.ok });
    } catch { res.status(503).json({ ok: false }); }
  });
  router.post('/events/:id', async (req, res) => {
    const target = pipecatPublicTarget(req.originalUrl, 'events');
    if (!target) { res.status(403).json({ ok: false }); return; }
    const event = req.body?.event;
    if (!['connected', 'disconnected', 'failed', 'busy', 'no_answer',
      'background_started', 'background_failed', 'background_restarted', 'background_stopped'].includes(event)) { res.status(400).json({ ok: false }); return; }
    try {
      const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 160) : undefined }), signal: AbortSignal.timeout(5000), redirect: 'error' });
      res.status(response.ok ? 200 : response.status === 403 ? 403 : 502).json({ ok: response.ok });
    } catch { res.status(502).json({ ok: false }); }
  });
  router.get('/background/:asset', async (req, res) => {
    const target = pipecatPublicTarget(req.originalUrl, 'background');
    if (!target) { res.sendStatus(403); return; }
    try {
      const response = await fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: req.headers.range ? { Range: req.headers.range } : {},
        signal: AbortSignal.timeout(30_000), redirect: 'error' });
      res.status(response.status);
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      if (req.method === 'HEAD' || !response.body) { res.end(); return; }
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
    } catch {
      if (!res.headersSent) res.sendStatus(502);
      else res.destroy();
    }
  });
  return router;
}

/** Transparent upgrade relay: preserve WS frames and stream backpressure. */
export function handlePipecatPublicUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (!req.url?.startsWith('/pipecat/')) return false;
  const target = pipecatPublicTarget(req.url, 'media');
  const reject = (status: number) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  if (!target || req.headers.upgrade?.toLowerCase() !== 'websocket') { reject(403); return true; }
  const headers: http.OutgoingHttpHeaders = { Host: target.host, Connection: 'Upgrade', Upgrade: 'websocket' };
  for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: 'GET', headers });
  const timer = setTimeout(() => { upstream.destroy(); reject(504); }, 10_000);
  timer.unref();
  socket.once('error', () => upstream.destroy());
  socket.once('close', () => { clearTimeout(timer); upstream.destroy(); });
  upstream.once('error', () => { clearTimeout(timer); reject(502); });
  upstream.once('response', (response) => {
    clearTimeout(timer);
    response.resume();
    reject(response.statusCode === 403 ? 403 : 502);
  });
  upstream.once('upgrade', (response, remote, remoteHead) => {
    clearTimeout(timer);
    if (socket.destroyed) { remote.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((lines, value, index, values) => index % 2 === 0 ? lines + `${value}: ${values[index + 1]}\r\n` : lines, '')}\r\n`);
    if (head.length) remote.write(head);
    if (remoteHead.length) socket.write(remoteHead);
    socket.once('close', () => remote.destroy());
    remote.once('error', () => socket.destroy());
    remote.once('close', () => socket.destroy());
    socket.pipe(remote).pipe(socket);
  });
  upstream.end();
  return true;
}
