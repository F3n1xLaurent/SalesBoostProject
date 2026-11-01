import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_REALTIME_ROOT } from '../voice/productionRealtimeState';

describe('production realtime storage in the read-only Docker image', () => {
  const dockerfile = readFileSync(path.resolve('Dockerfile'), 'utf8');
  const compose = readFileSync(path.resolve('compose.prod.yaml'), 'utf8');
  const runtime = dockerfile.split('AS production')[1];

  it('mounts persistent writable storage at the runtime snapshot path', () => {
    const relative = path.relative(process.cwd(), PRODUCTION_REALTIME_ROOT);
    expect(relative).toBe('storage/voice-realtime');
    expect(compose).toContain(`- salesboost_voice_realtime:/app/${relative}`);
    expect(compose).toMatch(/^  salesboost_voice_realtime:\n    name: salesboost_voice_realtime$/m);
    expect(compose).toContain('read_only: true');
  });

  it('initializes the volume mountpoint with private node-owned permissions before switching user', () => {
    const prepare = runtime.indexOf('RUN mkdir -p');
    const ownership = runtime.indexOf('chown -R node:node /app /data');
    const permissions = runtime.indexOf('chmod 700 /app/storage/voice-realtime');
    const user = runtime.indexOf('USER node');
    expect(prepare).toBeGreaterThan(-1);
    expect(runtime.slice(prepare, ownership)).toContain('/app/storage/voice-realtime');
    expect(ownership).toBeGreaterThan(prepare);
    expect(permissions).toBeGreaterThan(ownership);
    expect(user).toBeGreaterThan(permissions);
  });
});
