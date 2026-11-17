import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
vi.mock('../voice/callSettingsManagement', () => ({ loadCallPlanHistory: vi.fn() }));
import { loadCallPlanHistory } from '../voice/callSettingsManagement';
import { attachCallPlanHistorySocket, consumeHistoryTicket, createCallPlanHistoryUpgradeHandler,
  handleCallPlanHistoryTicket, issueHistoryTicket } from '../voice/callPlanHistoryLive';

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  send = vi.fn(); ping = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  terminate = vi.fn(() => this.close());
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('plan history authorization', () => {
  it('binds a single-use ticket to the plan and expires it', () => {
    vi.useFakeTimers(); const load = vi.fn();
    const ticket = issueHistoryTicket('plan-a', load);
    expect(consumeHistoryTicket(ticket, 'plan-b')).toBeNull();
    expect(consumeHistoryTicket(ticket, 'plan-a')).toBeNull();
    const expired = issueHistoryTicket('plan-a', load); vi.advanceTimersByTime(45_001);
    expect(consumeHistoryTicket(expired, 'plan-a')).toBeNull();
    const valid = issueHistoryTicket('plan-a', load);
    expect(consumeHistoryTicket(valid, 'plan-a')).toBe(load);
    expect(consumeHistoryTicket(valid, 'plan-a')).toBeNull();
  });
  it('does not issue a ticket if normal history authorization fails', async () => {
    vi.mocked(loadCallPlanHistory).mockRejectedValueOnce(new Error('Нет доступа к выбранной компании.'));
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handleCallPlanHistoryTicket({ params: { id: 'plan-a' }, authAccount: { id: 'outsider' } } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ ticket: expect.any(String) }));
  });
  it('rejects unauthenticated history sockets without intercepting voice sockets', () => {
    const upgrade = createCallPlanHistoryUpgradeHandler();
    const socket = { write: vi.fn(), destroy: vi.fn() };
    expect(upgrade({ url: '/voice/openai-realtime' } as any, socket as any, Buffer.alloc(0))).toBe(false);
    expect(upgrade({ url: '/api/admin/call-settings/plans/one/calls/live' } as any, socket as any, Buffer.alloc(0))).toBe(true);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401'));
  });
});

describe('active history subscription', () => {
  it('sends initial and changed snapshots, preserves unchanged data and stops on disconnect', async () => {
    vi.useFakeTimers(); const ws = new Socket();
    const load = vi.fn().mockResolvedValueOnce([{ id: 'call', status: 'running' }])
      .mockResolvedValue([{ id: 'call', status: 'completed', totalScore: 90 }]);
    attachCallPlanHistorySocket(ws as unknown as WebSocket, 'plan', [{ id: 'call', status: 'running' }], load);
    expect(ws.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); expect(ws.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(JSON.parse(ws.send.mock.calls[1][0])).toMatchObject({ type: 'calls.delta', ids: ['call'], upserts: [{ id: 'call', status: 'completed' }] });
    ws.close(); await vi.advanceTimersByTimeAsync(6000);
    expect(load).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('discards an in-flight query after leaving the page', async () => {
    vi.useFakeTimers(); const ws = new Socket(); let resolve!: (items: unknown[]) => void;
    const load = vi.fn(() => new Promise<unknown[]>(done => { resolve = done; }));
    attachCallPlanHistorySocket(ws as unknown as WebSocket, 'plan', [], load);
    await vi.advanceTimersByTimeAsync(2000); ws.close(); resolve([{ id: 'late' }]); await Promise.resolve();
    expect(ws.send).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('closes slow clients and drops subscriptions whose access was removed', async () => {
    vi.useFakeTimers(); const slow = new Socket(); slow.bufferedAmount = 3 * 1024 * 1024;
    attachCallPlanHistorySocket(slow as unknown as WebSocket, 'plan', [], vi.fn());
    expect(slow.close).toHaveBeenCalledWith(1013, 'Slow connection');
    const denied = new Socket();
    attachCallPlanHistorySocket(denied as unknown as WebSocket, 'plan', [], vi.fn().mockRejectedValue(new Error('No access')));
    await vi.advanceTimersByTimeAsync(2000); expect(denied.close).toHaveBeenCalledWith(1008, 'History unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
});
