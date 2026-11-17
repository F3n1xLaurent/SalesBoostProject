import assert from 'node:assert/strict';
import test from 'node:test';
import { pipecatDockerEnv } from './pipecat-env.mjs';

test('removing both proxy settings disables stale inherited proxy values', () => {
  const env = pipecatDockerEnv({}, {
    ELEVENLABS_PROXY_URL: 'socks5://old.test:1080',
    PIPECAT_ELEVENLABS_PROXY_URL: 'socks5://old-docker.test:1080',
  });
  assert.equal(env.ELEVENLABS_PROXY_URL, '');
  assert.equal(env.PIPECAT_ELEVENLABS_PROXY_URL, '');
});

test('localhost mapping is recomputed without writing a derived override', () => {
  const file = { ELEVENLABS_PROXY_URL: 'socks5://localhost:11080' };
  assert.equal(pipecatDockerEnv(file, {}).PIPECAT_ELEVENLABS_PROXY_URL,
    'socks5://host.docker.internal:11080');
  assert.equal(Object.hasOwn(file, 'PIPECAT_ELEVENLABS_PROXY_URL'), false);
  file.ELEVENLABS_PROXY_URL = 'socks5://localhost:11081';
  assert.equal(pipecatDockerEnv(file, {}).PIPECAT_ELEVENLABS_PROXY_URL,
    'socks5://host.docker.internal:11081');
});

test('explicit empty override disables Docker proxy while host still uses one', () => {
  const env = pipecatDockerEnv({ ELEVENLABS_PROXY_URL: 'socks5://localhost:11080', PIPECAT_ELEVENLABS_PROXY_URL: '' }, {});
  assert.equal(env.PIPECAT_ELEVENLABS_PROXY_URL, '');
  assert.equal(env.ELEVENLABS_PROXY_URL, 'socks5://localhost:11080');
});

test('explicit Docker-only proxy is supported independently of host proxy', () => {
  const env = pipecatDockerEnv({ PIPECAT_ELEVENLABS_PROXY_URL: 'socks5://docker-proxy.test:1080' }, {});
  assert.equal(env.PIPECAT_ELEVENLABS_PROXY_URL, 'socks5://docker-proxy.test:1080');
});

test('file settings override inherited settings without losing Docker context', () => {
  const env = pipecatDockerEnv({ OPENAI_API_KEY: 'file-test-value' }, { OPENAI_API_KEY: 'stale-test-value', DOCKER_CONTEXT: 'desktop-linux' });
  assert.equal(env.OPENAI_API_KEY, 'file-test-value');
  assert.equal(env.DOCKER_CONTEXT, 'desktop-linux');
});
