import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RegressionRun } from '../voice/realtimeRegression';
import type { TrainerTestRun } from './trainerAutoTesting';

type LiveRun = RegressionRun | TrainerTestRun;
type LiveTarget = 'call_plan' | 'trainer';
export type AutoTestingSnapshot = { type: 'run.snapshot'; target: LiveTarget; run: LiveRun; revision: number };
type Ticket = { runId: string; ownerId: string; expiresAt: number; target: LiveTarget };
const listeners = new Map<string, Set<(event: AutoTestingSnapshot) => void>>();
const tickets = new Map<string, Ticket>();
const revisions = new Map<string, number>();

export function publishAutoTestingRun(run: LiveRun): void {
  const revision = (revisions.get(run.id) ?? 0) + 1;
  revisions.set(run.id, revision);
  for (const listener of listeners.get(run.id) ?? []) {
    try { listener({ type: 'run.snapshot', target: run.target === 'trainer' ? 'trainer' : 'call_plan', run, revision }); }
    catch { console.warn('[auto-testing] disconnected live observer'); }
  }
  if (run.status !== 'running') revisions.delete(run.id);
}
export function subscribeAutoTestingRun(id: string, listener: (event: AutoTestingSnapshot) => void): () => void {
  const set = listeners.get(id) ?? new Set(); set.add(listener); listeners.set(id, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(id); };
}
export function issueAutoTestingTicket(runId: string, ownerId: string, target: LiveTarget = 'call_plan'): string {
  for (const [token, value] of tickets) if (value.expiresAt <= Date.now()) tickets.delete(token);
  if (tickets.size >= 1000) throw new Error('Слишком много ожидающих подключений. Попробуйте позже.');
  const token = randomBytes(32).toString('base64url');
  tickets.set(token, { runId, ownerId, target, expiresAt: Date.now() + 45_000 });
  return token;
}
export function consumeAutoTestingTicket(token: string, runId: string, target: LiveTarget = 'call_plan'): Ticket | null {
  const ticket = tickets.get(token);
  tickets.delete(token);
  return ticket && ticket.runId === runId && ticket.target === target && ticket.expiresAt > Date.now() ? ticket : null;
}

/** A short-lived single-use ticket, never an account JWT or provider API key. */
export function attachAutoTestingSocket(ws: WebSocket, run: LiveRun): void {
  const send = (event: AutoTestingSnapshot) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Slow connection'); return; }
    ws.send(JSON.stringify(event));
    if (event.run.status !== 'running') ws.close(1000, 'Run finished');
  };
  const unsubscribe = subscribeAutoTestingRun(run.id, send);
  let alive = true;
  const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 20_000);
  heartbeat.unref();
  ws.on('pong', () => { alive = true; });
  const cleanup = () => { unsubscribe(); clearInterval(heartbeat); };
  ws.once('close', cleanup); ws.once('error', cleanup);
  send({ type: 'run.snapshot', target: run.target === 'trainer' ? 'trainer' : 'call_plan', run, revision: revisions.get(run.id) ?? 0 });
}

export function createAutoTestingUpgradeHandler(loadRun: (id: string, ownerId: string, target: LiveTarget) => Promise<LiveRun | null>) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  return (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    let url: URL;
    try { url = new URL(request.url || '/', 'http://localhost'); } catch { return false; }
    const match = /^\/api\/admin\/auto-testing\/(call-plan|trainer)\/runs\/([a-z0-9-]{1,64})\/live$/i.exec(url.pathname);
    if (!match) return false;
    const target: LiveTarget = match[1] === 'trainer' ? 'trainer' : 'call_plan';
    const ticket = consumeAutoTestingTicket(url.searchParams.get('ticket') || '', match[2], target);
    if (!ticket) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return true; }
    let disconnected = false;
    const disconnectedHandler = () => { disconnected = true; };
    socket.once('close', disconnectedHandler);
    void loadRun(match[2], ticket.ownerId, target).then((run) => {
      socket.removeListener('close', disconnectedHandler);
      if (disconnected || socket.destroyed) return;
      if (!run || run.ownerId !== ticket.ownerId || (run.target === 'trainer') !== (target === 'trainer')) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (ws) => attachAutoTestingSocket(ws, run));
    }).catch(() => socket.destroy());
    return true;
  };
}
