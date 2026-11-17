import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { pipecatDockerEnv } from './pipecat-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The root .env is the documented source of provider settings for this service.
// An inherited shell value must not silently replace a freshly edited proxy/key.
const env = pipecatDockerEnv(dotenv.parse(fs.readFileSync(path.join(root, '.env'))));
function run(args, capture = false) {
  const result = spawnSync('docker', args, { cwd: root, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (result.error) throw new Error('Не удалось запустить Docker: проверьте Docker Desktop.');
  if (result.status !== 0) process.exit(result.status || 1);
  return (result.stdout || '').trim();
}
// Explicit context keeps buildx on Docker's built-in builder instead of booting
// an extra BuildKit container. It does not change global Docker settings.
const context = run(['context', 'show'], true);
const docker = ['--context', context];
const buildProxy = env.PIPECAT_BUILD_PROXY_URL;
const proxyArgs = buildProxy ? ['--build-arg', `HTTP_PROXY=${buildProxy}`, '--build-arg', `HTTPS_PROXY=${buildProxy}`] : [];
run([...docker, 'buildx', 'build', '--builder', context, '--load', '--progress', 'plain', ...proxyArgs,
  '-t', `salesboost-pipecat:${env.PIPECAT_IMAGE_TAG || 'local'}`, 'apps/pipecat-hypothesis']);
run([...docker, 'compose', '-f', 'compose.pipecat.yaml', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '90']);
