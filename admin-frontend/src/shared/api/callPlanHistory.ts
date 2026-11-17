import { apiFetch } from '../../entities/session';
import { fetchCallPlanCalls, type CallPlanCallItem } from './adminPanel';

export function watchCallPlanHistory(id: string, onUpdate: (items: CallPlanCallItem[]) => void): () => void {
  const abort = new AbortController();
  const root = `/api/admin/call-settings/plans/${encodeURIComponent(id)}/calls`;
  let stopped = false, connected = false, connecting = false, polling = false, revision = 0;
  let socket: WebSocket | null = null;
  let cached: CallPlanCallItem[] | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const signal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
  async function poll() {
    if (stopped || connected || polling || !visible()) return;
    polling = true; const atStart = revision;
    try {
      const items = await fetchCallPlanCalls(id, signal());
      if (!stopped && visible() && !connected && atStart === revision) onUpdate(items);
    } catch { /* Preserve the table during a temporary network failure. */ }
    finally { polling = false; }
  }
  async function connect() {
    if (stopped || connecting || connected || !visible()) return;
    connecting = true;
    try {
      const response = await apiFetch(`${root}/live-ticket`, { method: 'POST', signal: signal() });
      if (!response.ok) throw new Error('History connection unavailable');
      const { ticket } = await response.json();
      if (stopped || !visible()) return;
      if (typeof ticket !== 'string') throw new Error('Invalid history ticket');
      const url = new URL(`${root}/live`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket);
      const ws = new WebSocket(url); socket = ws;
      deadline = setTimeout(() => ws.close(), 5000);
      ws.onopen = () => { if (!stopped && socket === ws) { connected = true; clearTimeout(deadline); } };
      ws.onmessage = (event) => {
        if (stopped || socket !== ws || !visible()) return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.planId !== id) return;
          const validRows = (rows: unknown): rows is CallPlanCallItem[] => Array.isArray(rows)
            && rows.every(row => row && typeof row.id === 'string' && typeof row.status === 'string');
          if (message.type === 'calls.snapshot' && validRows(message.items)) cached = message.items;
          else if (message.type === 'calls.delta' && cached && validRows(message.upserts)
              && Array.isArray(message.ids) && message.ids.every((key: unknown) => typeof key === 'string')) {
            const map = new Map(cached.map(row => [row.id, row]));
            for (const row of message.upserts) map.set(row.id, row);
            const next = message.ids.map((key: string) => map.get(key));
            if (next.some((row: CallPlanCallItem | undefined) => !row)) return;
            cached = next;
          } else return;
          revision++; onUpdate(cached!);
        } catch { /* Keep the last valid snapshot. */ }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null; connected = false; clearTimeout(deadline);
        if (!stopped && visible()) { void poll(); retry = setTimeout(() => { void connect(); }, 2500); }
      };
    } catch {
      if (!stopped && visible()) { void poll(); retry = setTimeout(() => { void connect(); }, 5000); }
    } finally { connecting = false; }
  }
  function visibilityChanged() {
    clearTimeout(retry); clearTimeout(deadline);
    if (!visible()) { const old = socket; socket = null; connected = false; old?.close(); }
    else { void poll(); void connect(); }
  }
  const interval = setInterval(() => { void poll(); }, 3000);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged);
  void connect();
  return () => {
    stopped = true; abort.abort(); clearInterval(interval); clearTimeout(retry); clearTimeout(deadline);
    socket?.close(); socket = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
