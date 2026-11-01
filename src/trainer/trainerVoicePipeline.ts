import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transcribeVoiceFast } from '../voice/stt';
import { renderTrainerRecording } from './trainerRecording';

export async function transcribeTrainerVoice(audioBase64: string, mimeType: string): Promise<string> {
  const bytes = Buffer.from(audioBase64, 'base64');
  if (bytes.length < 512) throw new Error('Слишком короткое голосовое сообщение.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trainer-stt-'));
  const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : mimeType.includes('wav') ? 'wav' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
  const filename = path.join(directory, `message.${extension}`);
  try { await fs.writeFile(filename, bytes); return await transcribeVoiceFast(filename); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Preserve both original and correction audio in the one logical transcript turn. */
export async function combineTrainerVoiceMessages(messages: Array<{ audioBase64: string; mimeType: string }>) {
  if (messages.length === 1) return messages[0];
  if (!messages.length || messages.length > 8) throw new Error('Недопустимое число голосовых уточнений.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trainer-correction-'));
  try {
    const filename = path.join(directory, 'combined.mp3');
    await renderTrainerRecording(JSON.stringify(messages.map((message) => ({ role: 'manager', audioBase64: message.audioBase64, audioMimeType: message.mimeType }))), filename);
    return { audioBase64: (await fs.readFile(filename)).toString('base64'), mimeType: 'audio/mpeg' };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
