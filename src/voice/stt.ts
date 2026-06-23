import fs from 'fs';
import { openai } from '../lib/openaiClient';
import { config } from '../config';

/**
 * Transcribe a local audio file (Telegram voice) to text using OpenAI STT.
 */
export async function transcribeVoice(filepath: string): Promise<string> {
  const fileStream = fs.createReadStream(filepath);

  const result = await openai.audio.transcriptions.create({
    file: fileStream as any,
    model: config.openaiSttModel,
    language: 'ru',
  });

  const text = (result as any).text ?? '';
  return typeof text === 'string' ? text.trim() : '';
}
