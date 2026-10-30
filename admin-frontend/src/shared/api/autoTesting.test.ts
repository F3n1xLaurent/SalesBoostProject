import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../entities/session', () => ({ apiFetch }));
import { autoTestingClient, startCallPlanAutoTest, watchCallPlanAutoTest } from './autoTesting';

class Socket {
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: URL) { Socket.instances.push(this); }
  open() { this.onopen?.(); }
  message(run: object) { this.onmessage?.({ data: JSON.stringify({ type: 'run.snapshot', target: 'call_plan', run }) }); }
  close() { this.onclose?.(); }
}
const run = (status = 'running') => ({ id: 'run', planId: 'plan', status, cases: [], checklist: [], progress: 'Подготовка' });
const result = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers(); Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('window', { location: { href: 'https://test.eventstream.space/testing?tab=autotesting' } });
  apiFetch.mockImplementation(async (url: string) => result(url.endsWith('live-ticket') ? { ticket: 'one-use-ticket' } : run()));
});
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('autotest live UI transport', () => {
  it('runs trainer scopes against the trainer API without accepting a phone number or model', async () => {
    await autoTestingClient('trainer').start('source', { checkIds: ['trainer-identity'], referenceRunId: 'parent' }, 'female-source');
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/auto-testing/trainer/runs', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sourceId: 'source', checkIds: ['trainer-identity'], referenceRunId: 'parent', femaleSourceId: 'female-source' }) }));
  });
  it('uses trainer live tickets and accepts only trainer snapshots', async () => {
    const update = vi.fn(); cleanups.push(watchCallPlanAutoTest('run', { onUpdate: update, onConnection: vi.fn() }, 'trainer'));
    await vi.advanceTimersByTimeAsync(0); const ws = Socket.instances[0];
    expect(String(ws.url)).toContain('/trainer/runs/run/live?ticket='); ws.open(); ws.message(run()); expect(update).not.toHaveBeenCalled();
    ws.onmessage?.({ data: JSON.stringify({ type: 'run.snapshot', target: 'trainer', run: run('completed') }) });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });
  it('starts the production target without accepting a browser-selected model or phone number', async () => {
    await startCallPlanAutoTest('plan', { checkIds: ['ending'] });
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/auto-testing/call-plan/runs', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ planId: 'plan', checkIds: ['ending'] }),
    }));
  });

  it('uses WSS and a one-use ticket, updates live, and stops after the final snapshot', async () => {
    const update = vi.fn(), connection = vi.fn();
    cleanups.push(watchCallPlanAutoTest('run', { onUpdate: update, onConnection: connection }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = Socket.instances[0];
    expect(String(ws.url)).toBe('wss://test.eventstream.space/api/admin/auto-testing/call-plan/runs/run/live?ticket=one-use-ticket');
    ws.open(); ws.message({ ...run(), progress: 'IVR проверен' });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ progress: 'IVR проверен' }));
    expect(connection).toHaveBeenLastCalledWith('live');
    await vi.advanceTimersByTimeAsync(3000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    ws.message(run('completed'));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls on disconnect and reconnects with a new ticket', async () => {
    const update = vi.fn(), connection = vi.fn();
    cleanups.push(watchCallPlanAutoTest('run', { onUpdate: update, onConnection: connection }));
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0].open(); Socket.instances[0].close();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection).toHaveBeenLastCalledWith('polling');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'run' }));
    await vi.advanceTimersByTimeAsync(2500);
    expect(Socket.instances).toHaveLength(2);
    expect(apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/live-ticket'))).toHaveLength(2);
  });

  it('does not open a socket when the component unmounts while requesting a ticket', async () => {
    let resolve!: (response: Response) => void;
    apiFetch.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const update = vi.fn();
    const stop = watchCallPlanAutoTest('run', { onUpdate: update, onConnection: vi.fn() });
    stop(); resolve(result({ ticket: 'late' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(Socket.instances).toHaveLength(0); expect(update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores snapshots from another run and malformed messages', async () => {
    const update = vi.fn();
    cleanups.push(watchCallPlanAutoTest('run', { onUpdate: update, onConnection: vi.fn() }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = Socket.instances[0]; ws.open();
    ws.message({ ...run(), id: 'other-run' });
    ws.onmessage?.({ data: 'not-json' }); ws.message({ id: 'run' });
    expect(update).not.toHaveBeenCalled();
    ws.message(run()); expect(update).toHaveBeenCalledTimes(1);
  });

  it('can complete via polling without a working WebSocket connection', async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('live-ticket')) throw new Error('WebSocket temporarily unavailable');
      return result(run('completed'));
    });
    const update = vi.fn();
    cleanups.push(watchCallPlanAutoTest('run', { onUpdate: update, onConnection: vi.fn(), onError: vi.fn() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
