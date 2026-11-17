import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ rows: vi.fn(), update: vi.fn(), connected: vi.fn(), claims: vi.fn(), claimUpdate: vi.fn(), session: vi.fn() }));
vi.mock('../db', () => ({ prisma: { voiceCallSession: { findMany: mocks.rows, updateMany: mocks.update, findUnique: mocks.session },
  callPlanCall: { findMany: mocks.claims, updateMany: mocks.claimUpdate } } }));
vi.mock('../config', () => ({ config: { elevenLabsVoiceId: 'fallback' } }));
vi.mock('../voice/voiceCallSession', () => ({ recordVoiceCallConnected: mocks.connected }));
import { PIPECAT_STATE_ROOT, PipecatLaunchUncertainError, prepareProductionPipecatCall,
  readPipecatState, savePipecatState, syncProductionPipecatCalls, recoverPipecatQueueClaims, type PipecatSnapshot } from '../voice/productionPipecat';

let id: string;
let snapshot: PipecatSnapshot;
const request = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();id = randomUUID();
  vi.stubEnv('PIPECAT_HYPOTHESIS_URL', 'http://pipecat:8093');vi.stubEnv('PIPECAT_HYPOTHESIS_TOKEN', 'x'.repeat(32));
  vi.stubGlobal('fetch', request);
  snapshot = { callId: id, diagnosticId: 'pc-' + id, to: '+79990000000', status: 'prepared', finalized: false,
    createdAt: new Date().toISOString(), connectedAt: null, endedAt: null, voxSessionId: 456, recordingStarted: false,
    failureReason: null, transcript: [], metrics: [], profile: { model: 'gpt-realtime-2.1' } };
  mocks.rows.mockResolvedValue([{ callId: id, startedAt: new Date(), connectedAt: null, caseContextJson: '{"scriptId":"retained"}' }]);
  mocks.update.mockResolvedValue({ count: 1 });mocks.connected.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.unstubAllGlobals();vi.unstubAllEnvs();
  await fs.rm(path.join(PIPECAT_STATE_ROOT, id + '.json'), { force: true });
});
function response(value: unknown) { return { ok: true, status: 200, json: async () => value }; }
describe('production Pipecat integration', () => {
  it('recovers only unstarted queue claims, never actual persisted calls', async () => {
    mocks.claims.mockResolvedValue([{ id: 'abandoned', callId: 'manual-pipecat-old' }, { id: 'started', callId: 'scheduled:p:t:date' }]);
    mocks.session.mockImplementation(async ({ where }) => where.callId === 'manual-pipecat-old' ? null : { callId: where.callId });
    await recoverPipecatQueueClaims(Date.now());
    expect(mocks.claimUpdate).toHaveBeenCalledOnce();
    expect(mocks.claimUpdate.mock.calls[0][0]).toMatchObject({ where: { id: 'abandoned' }, data: { status: 'scheduled' } });
    expect(request).not.toHaveBeenCalled();
  });
  it('prepares without dialing, binds the plan voice, and preserves the same call ID at start', async () => {
    request.mockResolvedValueOnce(response(snapshot)).mockResolvedValueOnce(response({ ...snapshot, status: 'dialing' }));
    const prepared = await prepareProductionPipecatCall(id, '79990000000', { planId: 'p', planName: 'План', prompt: 'Потребность', elevenLabsVoiceId: 'profile-voice', customerVoiceId: null, subjectTitle: 'Товар', subjectDescription: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ callId: id, to: '+79990000000', voiceId: 'profile-voice' });
    await prepared.start();
    expect(request.mock.calls[1][0]).toBe(`http://pipecat:8093/production/sessions/${id}/start`);
    expect((await readPipecatState(id))?.status).toBe('dialing');
  });
  it('does not retry a lost start response or fall back to another dialer', async () => {
    request.mockResolvedValueOnce(response(snapshot)).mockRejectedValueOnce(new Error('timeout'));
    const prepared = await prepareProductionPipecatCall(id, '+79990000000', { planId: 'p', planName: 'План', prompt: 'Текст', elevenLabsVoiceId: 'v', customerVoiceId: null, subjectTitle: null, subjectDescription: null });
    await expect(prepared.start()).rejects.toBeInstanceOf(PipecatLaunchUncertainError);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('passes the script need independently when no imported row was selected', async () => {
    request.mockResolvedValueOnce(response(snapshot));
    await prepareProductionPipecatCall(id, '+79990000000', { planId: 'p', planName: 'План', prompt: 'Сценарий',
      elevenLabsVoiceId: 'v', customerVoiceId: null, subjectTitle: null, subjectDescription: null,
      customerNeed: 'Нужен семейный автомобиль.\nVolkswagen Touareg 2019.' });
    expect(JSON.parse(request.mock.calls[0][1].body).context).toMatchObject({ subjectTitle: null,
      subjectDescription: null, customerNeed: 'Нужен семейный автомобиль.\nVolkswagen Touareg 2019.' });
  });
  it('recovers a terminal call from the database queue and forwards actual transcript and recording evidence', async () => {
    snapshot = { ...snapshot, status: 'disconnected', finalized: true, recordingStarted: true,
      ivrDetected: true, ivrPath: ['1','2'], lineState: 'live',
      connectedAt: new Date().toISOString(), endedAt: new Date().toISOString(), transcript: [{ role: 'manager', text: 'Добрый день' }, { role: 'client', text: 'Здравствуйте' }] };
    request.mockResolvedValue(response(snapshot));
    const processEvent = vi.fn().mockResolvedValue(undefined);
    await syncProductionPipecatCalls(processEvent);
    expect(mocks.connected).toHaveBeenCalledWith(expect.objectContaining({ call_id: id }));
    expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({ call_id: id, event: 'disconnected', recording_started: true, vox_session_id: 456, transcript: snapshot.transcript }));
    expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({ ivr: true, ivr_path: ['1','2'] }));
    expect(mocks.update.mock.calls[0][0].data).toMatchObject({ ivrDetected: true, ivrPathJson: '["1","2"]' });
    expect(JSON.parse(mocks.update.mock.calls[0][0].data.caseContextJson)).toMatchObject({ scriptId: 'retained', pipecat: { diagnosticId: 'pc-' + id } });
    expect(request.mock.calls.every(call => call[1].method === 'GET')).toBe(true);
  });
  it('waits for final media drain before processing the terminal event', async () => {
    request.mockResolvedValue(response({ ...snapshot, status: 'disconnected', finalized: false }));
    const processEvent = vi.fn().mockResolvedValue(undefined);
    await syncProductionPipecatCalls(processEvent);
    expect(processEvent.mock.calls.some(([payload]) => payload.event === 'disconnected')).toBe(false);
  });
  it('never dials an abandoned preparation when recovering after a restart', async () => {
    mocks.rows.mockResolvedValue([{ callId: id, startedAt: new Date(Date.now() - 240_000), connectedAt: null, caseContextJson: '{}' }]);
    request.mockResolvedValueOnce(response(snapshot)).mockResolvedValueOnce(response({ ok: true }));
    const processEvent = vi.fn().mockResolvedValue(undefined);
    await syncProductionPipecatCalls(processEvent);
    expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'cancelled' }));
    expect(request.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(false);
  });
  it('persists snapshots durably without exposing any call credential', async () => {
    await savePipecatState(snapshot);
    expect(await readPipecatState(id)).toEqual(snapshot);
    expect(await readPipecatState('../outside')).toBeNull();
    expect((await fs.stat(path.join(PIPECAT_STATE_ROOT, id + '.json'))).mode & 0o777).toBe(0o600);
  });
});
