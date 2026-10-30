import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transcribeVoiceFast } from '../voice/stt';

/** Same admission rule for the real HTTP endpoint and isolated tests. */
export function claimTrainerTurn(tasks: Set<string>, id: string): () => void {
  if (tasks.has(id)) throw Object.assign(new Error('Предыдущая реплика ещё обрабатывается. Дождитесь ответа клиента.'), { status: 409 });
  tasks.add(id);
  return () => tasks.delete(id);
}
export async function transcribeTrainerVoice(audioBase64: string, mimeType: string): Promise<string> {
  const bytes = Buffer.from(audioBase64, 'base64');
  if (bytes.length < 512) throw new Error('Слишком короткое голосовое сообщение.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trainer-stt-'));
  const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : mimeType.includes('wav') ? 'wav' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
  const filename = path.join(directory, `message.${extension}`);
  try { await fs.writeFile(filename, bytes); return await transcribeVoiceFast(filename); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
