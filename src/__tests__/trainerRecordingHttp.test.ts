import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrainerRecordingHandler } from '../trainer/trainerRecordingHttp';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), sendFile: vi.fn() };
  res.status.mockReturnValue(res); return res;
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trainer-recording-http-test-'));
  directories.push(directory);
  const file = path.join(directory, 'recording.mp3');
  await writeFile(file, 'mp3');
  const findScopedSession = vi.fn(async (req: Request, _id: string) => req.authAccount?.id === 'owner' ? { id: 'session', status: 'completed' } : null);
  const forReport = vi.fn(async () => ({ recordingStatus: 'ready' as const, recordingUrl: '/api/admin/trainer-recordings/session', recordingError: null }));
  const recordingPath = vi.fn(() => file);
  return { file, findScopedSession, forReport, recordingPath, handler: createTrainerRecordingHandler({ findScopedSession, forReport, recordingPath }) };
}
function request(action = '', accountId: string | null = 'owner', id = 'session') {
  return { params: { sessionId: id, action }, authAccount: accountId ? { id: accountId } : undefined } as unknown as Request;
}

describe('trainer recording access', () => {
  it.each(['', 'status', 'download'])('requires authentication for action %s', async (action) => {
    const fixture = await fixtureForTest(); const res = response();
    await fixture.handler(request(action, null), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(fixture.findScopedSession).not.toHaveBeenCalled();
    expect(fixture.forReport).not.toHaveBeenCalled();
  });

  it.each(['', 'status', 'download'])('does not disclose files or start jobs for another employee: %s', async (action) => {
    const fixture = await fixtureForTest(); const res = response();
    const req = request(action, 'another-employee');
    await fixture.handler(req, res as unknown as Response);
    expect(fixture.findScopedSession).toHaveBeenCalledWith(req, 'session');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(fixture.forReport).not.toHaveBeenCalled();
    expect(fixture.recordingPath).not.toHaveBeenCalled();
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it.each(['', 'download'])('serves the complete file with private caching for owner action %s', async (action) => {
    const fixture = await fixtureForTest(); const res = response();
    await fixture.handler(request(action), res as unknown as Response);
    expect(res.sendFile).toHaveBeenCalledWith(fixture.file);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'audio/mpeg');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', `${action ? 'attachment' : 'inline'}; filename="trainer-session.mp3"`);
  });

  it('returns status without transferring the MP3', async () => {
    const fixture = await fixtureForTest(); const res = response();
    await fixture.handler(request('status'), res as unknown as Response);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recordingStatus: 'ready' }));
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('rejects traversal before any storage access', async () => {
    const fixture = await fixtureForTest(); const res = response();
    await fixture.handler(request('download', 'owner', '../private'), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(fixture.findScopedSession).not.toHaveBeenCalled();
  });
});

// Separate name keeps test-local variables readable without shadowing the factory.
const fixtureForTest = fixture;
