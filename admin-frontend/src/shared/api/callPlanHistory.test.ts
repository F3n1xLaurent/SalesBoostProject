import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { apiFetch, fetchCallPlanCalls } = vi.hoisted(() => ({ apiFetch: vi.fn(), fetchCallPlanCalls: vi.fn() }));
vi.mock('../../entities/session', () => ({ apiFetch }));
vi.mock('./adminPanel', () => ({ fetchCallPlanCalls }));
import { watchCallPlanHistory } from './callPlanHistory';

class Socket {
  static all: Socket[] = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onerror: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: URL) { Socket.all.push(this); }
  open() { this.onopen?.(); }
  close() { this.onclose?.(); }
  update(items: unknown[], planId = 'plan') { this.onmessage?.({ data: JSON.stringify({ type: 'calls.snapshot', planId, items }) }); }
}
const stops: (() => void)[] = [];
let visibility: () => void;
let doc: { visibilityState: string; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers(); Socket.all = [];
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('window', { location: { href: 'https://test/call-settings/plans/plan' } });
  doc = { visibilityState: 'visible', addEventListener: vi.fn((_, cb) => { visibility = cb; }), removeEventListener: vi.fn() };
  vi.stubGlobal('document', doc);
  apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ticket: 'one-use' })));
  fetchCallPlanCalls.mockResolvedValue([{ id: 'call', status: 'running' }]);
});
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('plan history viewer', () => {
  it('updates statuses in place over WSS and ignores other plans', async () => {
    const update = vi.fn(); stops.push(watchCallPlanHistory('plan', update)); await vi.advanceTimersByTimeAsync(0);
    const ws = Socket.all[0]; expect(ws.url.protocol).toBe('wss:'); expect(ws.url.searchParams.get('ticket')).toBe('one-use');
    ws.open(); ws.update([{ id: 'call', status: 'running' }]);
    ws.onmessage?.({ data: JSON.stringify({ type: 'calls.delta', planId: 'plan', ids: ['call'], upserts: [{ id: 'call', status: 'completed' }] }) });
    ws.update([], 'another');
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0][0]).toMatchObject({ id: 'call', status: 'completed' });
    await vi.advanceTimersByTimeAsync(6000); expect(fetchCallPlanCalls).not.toHaveBeenCalled();
  });
  it('keeps the last snapshot on connection loss and falls back to HTTP', async () => {
    const update = vi.fn(); stops.push(watchCallPlanHistory('plan', update)); await vi.advanceTimersByTimeAsync(0);
    Socket.all[0].open(); Socket.all[0].update([{ id: 'call', status: 'running' }]);
    fetchCallPlanCalls.mockRejectedValueOnce(new Error('Offline'));
    Socket.all[0].close(); await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(update).toHaveBeenCalledTimes(2);
  });
  it('applies additions, deletion and ordering while preserving unchanged rows', async () => {
    const update = vi.fn(); stops.push(watchCallPlanHistory('plan', update)); await vi.advanceTimersByTimeAsync(0);
    const ws = Socket.all[0]; ws.open();
    ws.update([{ id: 'a', status: 'completed' }, { id: 'b', status: 'running' }]);
    const unchanged = update.mock.calls[0][0][1];
    ws.onmessage?.({ data: JSON.stringify({ type: 'calls.delta', planId: 'plan', ids: ['c', 'b'], upserts: [{ id: 'c', status: 'scheduled' }] }) });
    expect(update.mock.calls[1][0].map((item: { id: string }) => item.id)).toEqual(['c', 'b']);
    expect(update.mock.calls[1][0][1]).toBe(unchanged);
  });
  it('does not let an older HTTP response overwrite a socket update', async () => {
    let resolve!: (items: unknown[]) => void;
    fetchCallPlanCalls.mockImplementation(() => new Promise(done => { resolve = done; }));
    const update = vi.fn(); stops.push(watchCallPlanHistory('plan', update)); await vi.advanceTimersByTimeAsync(3000);
    const ws = Socket.all[0]; ws.open(); ws.update([{ id: 'call', status: 'completed' }]);
    ws.close(); resolve([{ id: 'call', status: 'running' }]); await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0][0].status).toBe('completed');
  });
  it('stops queries in a hidden tab, reconnects on return and cleans up after navigation', async () => {
    const update = vi.fn(), stop = watchCallPlanHistory('plan', update); stops.push(stop);
    await vi.advanceTimersByTimeAsync(0); Socket.all[0].open();
    doc.visibilityState = 'hidden'; visibility(); await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchCallPlanCalls).not.toHaveBeenCalled();
    doc.visibilityState = 'visible'; apiFetch.mockResolvedValue(new Response(JSON.stringify({ ticket: 'new' })));
    visibility(); await vi.advanceTimersByTimeAsync(0);
    expect(Socket.all).toHaveLength(2); stop();
    Socket.all[1].update([{ id: 'late' }]); const count = update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); expect(update).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0); expect(doc.removeEventListener).toHaveBeenCalled();
  });
});
