import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { RegressionRun } from '../voice/realtimeRegression';
import { attachAutoTestingSocket, consumeAutoTestingTicket, createAutoTestingUpgradeHandler, issueAutoTestingTicket,
  publishAutoTestingRun, subscribeAutoTestingRun } from '../testing/autoTestingLive';

const run = (status: RegressionRun['status'] = 'running'): RegressionRun => ({ id: 'live-run', ownerId: 'owner',
  planId: 'plan', planName: 'План', model: 'gpt-realtime-2.1', target: 'call_plan', status,
  createdAt: '2026-10-30T10:00:00Z', cases: [], checklist: [], progress: 'Подготовка' });
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  send = vi.fn(); ping = vi.fn(); terminate = vi.fn(() => this.close());
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('owner-scoped short-lived live tickets', () => {
  it('uses unpredictable single-use tickets bound to one run and one owner', () => {
    const token = issueAutoTestingTicket('one-run', 'owner');
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(consumeAutoTestingTicket(token, 'one-run')).toMatchObject({ runId: 'one-run', ownerId: 'owner' });
    expect(consumeAutoTestingTicket(token, 'one-run')).toBeNull();
    expect(consumeAutoTestingTicket(issueAutoTestingTicket('one-run', 'owner'), 'another-run')).toBeNull();
  });
  it('rejects expired tickets', () => {
    vi.useFakeTimers();
    const ticket = issueAutoTestingTicket('one-run', 'owner');
    vi.advanceTimersByTime(45_001);
    expect(consumeAutoTestingTicket(ticket, 'one-run')).toBeNull();
  });
  it('binds trainer tickets to their target as well as owner and ID', () => {
    const wrong = issueAutoTestingTicket('trainer-run', 'owner', 'trainer');
    expect(consumeAutoTestingTicket(wrong, 'trainer-run', 'call_plan')).toBeNull();
    const token = issueAutoTestingTicket('trainer-run', 'owner', 'trainer');
    expect(consumeAutoTestingTicket(token, 'trainer-run', 'trainer')).toMatchObject({ target: 'trainer', ownerId: 'owner' });
  });
  it('does not touch voice upgrades, and rejects live upgrades without a ticket', () => {
    const load = vi.fn(); const upgrade = createAutoTestingUpgradeHandler(load);
    const socket = { write: vi.fn(), destroy: vi.fn() };
    expect(upgrade({ url: '/voice/openai-realtime' } as any, socket as any, Buffer.alloc(0))).toBe(false);
    expect(upgrade({ url: '/api/admin/auto-testing/call-plan/runs/live-run/live' } as any, socket as any, Buffer.alloc(0))).toBe(true);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401'));
    expect(socket.destroy).toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  });
});

describe('live snapshots', () => {
  it('sends an immediate snapshot, progress updates, and a final snapshot before closing', () => {
    vi.useFakeTimers();
    const ws = new Socket();
    attachAutoTestingSocket(ws as unknown as WebSocket, run());
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ type: 'run.snapshot', target: 'call_plan', run: { id: 'live-run' } });
    publishAutoTestingRun({ ...run(), progress: 'Проверка IVR' });
    expect(JSON.parse(ws.send.mock.calls.at(-1)![0]).run.progress).toBe('Проверка IVR');
    publishAutoTestingRun(run('completed'));
    expect(JSON.parse(ws.send.mock.calls.at(-1)![0]).run.status).toBe('completed');
    expect(ws.close).toHaveBeenCalledWith(1000, 'Run finished');
    const sent = ws.send.mock.calls.length;
    publishAutoTestingRun(run());
    expect(ws.send).toHaveBeenCalledTimes(sent);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans up subscriptions and heartbeat after disconnect', () => {
    vi.useFakeTimers();
    const ws = new Socket(); attachAutoTestingSocket(ws as unknown as WebSocket, run());
    ws.close();
    publishAutoTestingRun(run());
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('disconnects unresponsive/slow observers without affecting test execution', () => {
    vi.useFakeTimers();
    const ws = new Socket(); attachAutoTestingSocket(ws as unknown as WebSocket, run());
    vi.advanceTimersByTime(40_000); expect(ws.terminate).toHaveBeenCalled();
    const slow = new Socket(); slow.bufferedAmount = 3 * 1024 * 1024;
    attachAutoTestingSocket(slow as unknown as WebSocket, run());
    expect(slow.close).toHaveBeenCalledWith(1013, 'Slow connection');
    const off = subscribeAutoTestingRun('live-run', () => { throw new Error('Observer failure'); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => publishAutoTestingRun(run('failed'))).not.toThrow(); off();
  });
});
