import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), authenticate: vi.fn(), flush: vi.fn(), finish: vi.fn(), lifecycle: vi.fn(), connected: vi.fn(), update: vi.fn() }));
vi.mock('../voice/productionRealtimeState', () => ({ readProductionRealtimeState: mocks.read, authenticateProductionRealtimeWebhook: mocks.authenticate, flushProductionRealtimeState: mocks.flush }));
vi.mock('../voice/callPlanTelephony', () => ({ finishProductionCallPlanTelephony: mocks.finish }));
vi.mock('../voice/cometRealtimeTest', () => ({ updateProductionRealtimeLifecycle: mocks.lifecycle }));
vi.mock('../voice/voiceCallSession', () => ({ recordVoiceCallConnected: mocks.connected }));
vi.mock('../db', () => ({ prisma: { voiceCallSession: { updateMany: mocks.update } } }));
import { handleProductionRealtimeWebhook } from '../voice/productionRealtimeWebhook';
const state = { callId: 'call', snapshot: { phone: '+79507503215', endedAt: null as string | null, ivrDetected: true, ivrPath: ['1'], transcript: [{ role: 'manager', text: 'Алло' }] } };
function request(body: object) { return { body, get: () => 'token' } as unknown as Request; }
function response() { const res = { status: vi.fn(), json: vi.fn(), end: vi.fn() }; res.status.mockReturnValue(res); return res; }
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue(state); mocks.authenticate.mockReturnValue(true); });
describe('production lifecycle authentication and enrichment', () => {
  it('rejects unknown or unauthenticated events before any mutation', async () => {
    mocks.authenticate.mockReturnValue(false);
    const res = response(); const process = vi.fn();
    await handleProductionRealtimeWebhook(request({ call_id: 'call', event: 'disconnected' }), res as unknown as Response, process);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(process).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('acknowledges before processing and supplies durable transcript and recording evidence', async () => {
    const res = response();
    const process = vi.fn(async () => { expect(res.end).toHaveBeenCalled(); });
    await handleProductionRealtimeWebhook(request({ call_id: 'call', event: 'disconnected', to: 'wrong-phone', ts: '2026-10-29T12:01:00Z',
      connected_at: '2026-10-29T12:00:00Z', recording_started: true, vox_session_id: 123 }), res as unknown as Response, process);
    expect(mocks.connected).toHaveBeenCalledWith({ call_id: 'call', to: state.snapshot.phone, ts: '2026-10-29T12:00:00Z' });
    expect(mocks.finish).toHaveBeenCalledWith('call', 'disconnected', '2026-10-29T12:01:00Z');
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { recordingStatus: 'pending' } }));
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ to: state.snapshot.phone, transcript: state.snapshot.transcript, ivr: true, ivr_path: ['1'], vox_session_id: 123 }));
  });
  it('ignores a delayed progress event after finalization', async () => {
    mocks.read.mockResolvedValue({ ...state, snapshot: { ...state.snapshot, endedAt: '2026-10-29T12:01:00Z' } });
    const process = vi.fn();
    await handleProductionRealtimeWebhook(request({ call_id: 'call', event: 'connected' }), response() as unknown as Response, process);
    expect(process).not.toHaveBeenCalled(); expect(mocks.connected).not.toHaveBeenCalled();
  });
  it('does not acknowledge success when durable persistence fails, allowing delivery retry', async () => {
    mocks.flush.mockRejectedValueOnce(new Error('disk unavailable'));
    const res = response(); const process = vi.fn();
    await expect(handleProductionRealtimeWebhook(request({ call_id: 'call', event: 'progress' }), res as unknown as Response, process)).rejects.toThrow('disk unavailable');
    expect(res.end).not.toHaveBeenCalled(); expect(process).not.toHaveBeenCalled();
  });
});
