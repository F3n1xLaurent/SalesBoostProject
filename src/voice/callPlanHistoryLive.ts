import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadCallPlanHistory } from './callSettingsManagement';

type Load = () => Promise<unknown[]>;
const tickets = new Map<string, { planId: string; expiresAt: number; load: Load }>();
export function issueHistoryTicket(planId: string, load: Load): string {
  for (const [key, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(key);
  if (tickets.size >= 1000) throw new Error('Слишком много подключений. Попробуйте позже.');
  const token = randomBytes(32).toString('base64url');
  tickets.set(token, { planId, load, expiresAt: Date.now() + 45_000 });
  return token;
}
export function consumeHistoryTicket(token: string, planId: string): Load | null {
  const ticket = tickets.get(token); tickets.delete(token);
  return ticket?.planId === planId && ticket.expiresAt > Date.now() ? ticket.load : null;
}
export async function handleCallPlanHistoryTicket(req: Request, res: Response) {
  const id = String(req.params.id || '');
  // Keep only the authorization context, not an open HTTP request/response.
  const context = { authAccount: req.authAccount } as Request;
  try {
    await loadCallPlanHistory(context, id);
    res.json({ ticket: issueHistoryTicket(id, () => loadCallPlanHistory(context, id)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось подключить историю.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

/** Query only while a viewer is connected; send only changed snapshots. */
export function attachCallPlanHistorySocket(ws: WebSocket, planId: string, initial: unknown[], load: Load) {
  let stopped = false, busy = false, alive = true, initialized = false, previousOrder = '';
  let previous = new Map<string, string>();
  const send = (items: unknown[]) => {
    if (stopped || ws.readyState !== 1) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Slow connection'); return; }
    const rows = items as Array<{ id: string }>;
    const ids = rows.map(row => row.id);
    const next = new Map(rows.map(row => [row.id, JSON.stringify(row)]));
    const upserts = rows.filter(row => previous.get(row.id) !== next.get(row.id));
    const order = JSON.stringify(ids);
    if (!initialized) ws.send(JSON.stringify({ type: 'calls.snapshot', planId, items }));
    else if (upserts.length || previousOrder !== order) ws.send(JSON.stringify({ type: 'calls.delta', planId, ids, upserts }));
    initialized = true; previous = next; previousOrder = order;
  };
  const refresh = async () => {
    if (stopped || busy) return;
    busy = true;
    try { const items = await load(); if (!stopped) send(items); }
    catch { ws.close(1008, 'History unavailable'); }
    finally { busy = false; }
  };
  const interval = setInterval(() => { void refresh(); }, 2000);
  const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 20_000);
  // Reissue an authenticated ticket periodically rather than retaining old scopes forever.
  const expiry = setTimeout(() => ws.close(1000, 'Renew subscription'), 5 * 60_000);
  interval.unref(); heartbeat.unref(); expiry.unref();
  const cleanup = () => { stopped = true; clearInterval(interval); clearInterval(heartbeat); clearTimeout(expiry); };
  ws.on('pong', () => { alive = true; }); ws.once('close', cleanup); ws.once('error', cleanup);
  send(initial);
}

export function createCallPlanHistoryUpgradeHandler() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    let url: URL;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return false; }
    const match = /^\/api\/admin\/call-settings\/plans\/([a-z0-9_-]{1,96})\/calls\/live$/i.exec(url.pathname);
    if (!match) return false;
    const load = consumeHistoryTicket(url.searchParams.get('ticket') || '', match[1]);
    if (!load) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return true; }
    void load().then((items) => {
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => attachCallPlanHistorySocket(ws, match[1], items, load));
    }).catch(() => { if (!socket.destroyed) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); } });
    return true;
  };
}
