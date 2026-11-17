import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(root, '.env');
if (!fs.existsSync(filename)) throw new Error('Создайте корневой .env с ключами провайдеров.');
const env = dotenv.parse(fs.readFileSync(filename));
const additions = [];
if (!env.PIPECAT_HYPOTHESIS_URL) additions.push('PIPECAT_HYPOTHESIS_URL=http://127.0.0.1:8093');
if (!env.PIPECAT_HYPOTHESIS_PUBLIC_URL) {
  const base = env.PUBLIC_BASE_URL || env.VOICE_DIALOG_BASE_URL;
  if (base) {
    const publicUrl = new URL(base);
    if (publicUrl.protocol === 'https:' && !publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash) {
      additions.push(`PIPECAT_HYPOTHESIS_PUBLIC_URL=${publicUrl.toString().replace(/\/$/u, '')}/pipecat`);
    }
  }
}
if (!env.PIPECAT_HYPOTHESIS_TOKEN) additions.push(`PIPECAT_HYPOTHESIS_TOKEN=${randomBytes(32).toString('hex')}`);
else if (env.PIPECAT_HYPOTHESIS_TOKEN.length < 32) throw new Error('PIPECAT_HYPOTHESIS_TOKEN должен содержать не менее 32 символов.');
// The Docker runner maps localhost proxies in memory. Do not persist a derived
// override that would survive commenting out ELEVENLABS_PROXY_URL later.
if (additions.length) fs.appendFileSync(filename, `\n# Isolated Pipecat Docker service\n${additions.join('\n')}\n`);
console.log('Настройки локального Pipecat готовы. Секреты остаются в .env.');
