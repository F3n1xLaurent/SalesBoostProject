import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config';
import { openai } from '../lib/openaiClient';
import { normalizeRussianSpeechNumbers } from '../voice/speechFacts';

/** Test manager, not the tested client. Never apply the client's 360-character TTS limit here. */
export async function synthesizeTrainerFixture(text: string, signal?: AbortSignal, root = path.resolve('storage/trainer-regression/fixtures')) {
  signal?.throwIfAborted();
  const input = normalizeRussianSpeechNumbers(text);
  const key = createHash('sha256').update(JSON.stringify({ input, model: config.openaiTtsModel, voice: 'onyx', format: 'wav' })).digest('hex');
  const filename = path.join(root, `${key}.wav`);
  try { const cached = await fs.readFile(filename); if (cached.length >= 512) return { audioBase64: cached.toString('base64'), mimeType: 'audio/wav' }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const response = await openai.audio.speech.create({ model: config.openaiTtsModel, voice: 'onyx', input, response_format: 'wav' }, { signal, timeout: 45000, maxRetries: 0 });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 512) throw new Error('Не сгенерировано полное голосовое тестового менеджера.');
  signal?.throwIfAborted(); await fs.mkdir(root, { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes); await fs.rename(temporary, filename);
  return { audioBase64: bytes.toString('base64'), mimeType: 'audio/wav' };
}
