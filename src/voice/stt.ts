import fs from 'fs';
import path from 'path';
import { openai } from '../lib/openaiClient';
import { config } from '../config';

function contentTypeForFile(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase();
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg';
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  return 'application/octet-stream';
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Transcribe a local audio file (Telegram voice) to text using OpenAI STT.
 */
export async function transcribeVoice(filepath: string): Promise<string> {
  const fileStream = fs.createReadStream(filepath);

  const result = await openai.audio.transcriptions.create({
    file: fileStream as any,
    model: config.openaiSttModel,
    language: 'ru',
  }, { timeout: 25000 });

  const text = (result as any).text ?? '';
  return typeof text === 'string' ? text.trim() : '';
}

export async function transcribeVoiceElevenLabs(filepath: string): Promise<string> {
  if (!config.elevenLabsApiKey) throw new Error('ELEVENLABS_API_KEY is not configured');
  const contentType = contentTypeForFile(filepath);
  const bytes = await fs.promises.readFile(filepath);
  const file = new File([new Blob([bytes], { type: contentType })], path.basename(filepath), {
    type: contentType,
  });
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('language_code', 'ru');
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'none');
  form.append('file', file);

  const response = await fetchWithTimeout('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenLabsApiKey },
    body: form,
  }, 25000);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ElevenLabs STT error ${response.status}: ${body || response.statusText}`);
  }
  const data = await response.json() as { text?: unknown };
  return typeof data.text === 'string' ? data.text.trim() : '';
}

export async function transcribeVoiceFast(filepath: string): Promise<string> {
  if (config.elevenLabsApiKey) {
    try {
      return await transcribeVoiceElevenLabs(filepath);
    } catch (error) {
      console.error('[stt] ElevenLabs STT error, falling back to OpenAI:', error);
    }
  }
  return transcribeVoice(filepath);
}
