import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPipecatPublicRouter, pipecatLifecycleEvent, pipecatPublicTarget } from '../testing/pipecatPublicGateway';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const id = '7ca493d2-b192-40b6-b289-670858723e8f';
const token = 'a'.repeat(43);
describe('Pipecat public gateway boundaries', () => {
  it('preserves recording and IVR evidence while dropping arbitrary fields', () => {
    for (const event of ['connected', 'recording_started', 'recording_failed', 'ivr_selected', 'cancelled', 'disconnected']) {
      expect(pipecatLifecycleEvent({ event, vox_session_id: '123456', recording_started: true,
        ivr: true, ivr_path: ['1', '#'], reason: 'a'.repeat(200), call_id: 'ignored', target: 'https://untrusted' }))
        .toEqual({ event, vox_session_id: '123456', recording_started: true, ivr: true, ivr_path: ['1', '#'], reason: 'a'.repeat(160) });
    }
    expect(pipecatLifecycleEvent({ event: 'recording_started', vox_session_id: 123 })).toEqual({ event: 'recording_started', vox_session_id: 123 });
  });
  it('rejects unknown lifecycle events and does not forward malformed metadata', () => {
    for (const value of [null, [], {}, { event: 'admin' }]) expect(pipecatLifecycleEvent(value)).toBeNull();
    expect(pipecatLifecycleEvent({ event: 'connected', vox_session_id: 'https://bad', recording_started: 'true', ivr: 1, ivr_path: ['12'] }))
      .toEqual({ event: 'connected' });
    for (const value of [0, -1, Number.MAX_SAFE_INTEGER + 1, {}, '0', 'a'.repeat(100)]) {
      expect(pipecatLifecycleEvent({ event: 'connected', vox_session_id: value })).toEqual({ event: 'connected' });
    }
  });
  it('relays RecordStarted over the public HTTP route to the private lifecycle handler', async () => {
    vi.stubEnv('PIPECAT_HYPOTHESIS_URL', 'http://pipecat:8093');
    const actualFetch = globalThis.fetch;
    const upstream = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    const app = express(); app.use(express.json()); app.use('/pipecat', createPipecatPublicRouter());
    const server = createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number };
      const response = await actualFetch(`http://127.0.0.1:${address.port}/pipecat/events/${id}?token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'recording_started', vox_session_id: 123, recording_started: true }),
      });
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledOnce();
      expect(String(upstream.mock.calls[0][0])).toBe(`http://pipecat:8093/events/${id}?token=${token}`);
      expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual({ event: 'recording_started', vox_session_id: 123, recording_started: true });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('routes only per-call events and media to the configured private service', () => {
    for (const kind of ['events', 'media'] as const) {
      const target = pipecatPublicTarget(`/pipecat/${kind}/${id}?token=${token}`, kind, 'http://127.0.0.1:8093');
      expect(target?.origin).toBe('http://127.0.0.1:8093');
      expect(target?.pathname).toBe(`/${kind}/${id}`);
      expect(target?.searchParams.get('token')).toBe(token);
    }
  });
  it.each([
    `/pipecat/health?token=${token}`, `/pipecat/sessions/${id}?token=${token}`,
    `/pipecat/media/${id}`, `/pipecat/media/${id}?token=short`,
    `/pipecat/media/${id}?token=${token}&token=${token}`, `/pipecat/media/${id}?token=${token}&url=https://example.com`,
    `/pipecat/events/${id}?token=${token}`, `/pipecat/media/../../health?token=${token}`,
  ])('refuses admin access, malformed credentials and arbitrary forwarding: %s', (raw) => {
    expect(pipecatPublicTarget(raw, 'media', 'http://127.0.0.1:8093')).toBeNull();
  });
  it('rejects unsupported schemes and embedded private service credentials', () => {
    for (const base of ['file:///tmp', 'https://user:password@example.test']) {
      expect(pipecatPublicTarget(`/pipecat/media/${id}?token=${token}`, 'media', base)).toBeNull();
    }
  });
  it('forwards only signed immutable WAV assets, never arbitrary files', () => {
    const asset = 'a'.repeat(64) + '.wav';
    const raw = `/pipecat/background/${asset}?token=${'b'.repeat(64)}`;
    const target = pipecatPublicTarget(raw, 'background', 'http://127.0.0.1:8093');
    expect(target?.pathname).toBe('/background/' + asset);
    for (const bad of [raw + '&path=/etc/passwd', raw.replace(asset, 'secret.wav'), raw.replace('.wav', '.mp3'), raw.replace('background/', 'sessions/')]) {
      expect(pipecatPublicTarget(bad, 'background', 'http://127.0.0.1:8093')).toBeNull();
    }
  });
});
