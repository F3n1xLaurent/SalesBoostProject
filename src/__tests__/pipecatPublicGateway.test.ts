import { describe, expect, it } from 'vitest';
import { pipecatPublicTarget } from '../testing/pipecatPublicGateway';

const id = '7ca493d2-b192-40b6-b289-670858723e8f';
const token = 'a'.repeat(43);
describe('Pipecat public gateway boundaries', () => {
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
