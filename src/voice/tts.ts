import https from 'https';
import { Input } from 'telegraf';
import { config } from '../config';
import { openai } from '../lib/openaiClient';
import type { Context } from 'telegraf';
import type { TtsVoice } from '../state/userPreferences';

const TTS_MAX_CHARS = 360;

/** OpenAI voices: male = onyx, female = nova */
const OPENAI_VOICE_MAP: Record<TtsVoice, string> = {
  male: 'onyx',
  female: 'nova',
};

function useOpenAITts(): boolean {
  return config.ttsProvider === 'openai' || !(config.elevenLabsApiKey && config.elevenLabsVoiceId);
}

export function isTtsEnabled(): boolean {
  return Boolean(config.openaiApiKey) || Boolean(config.elevenLabsApiKey && config.elevenLabsVoiceId);
}

/** Cost per 1000 chars (OpenAI tts-1). ~$0.015/1k chars. */
export const TTS_COST_PER_1K_CHARS = 0.015;

/** Estimate cost for a training session (10–14 client turns, ~300 chars each). */
export function estimateTtsCostPerSession(): string {
  const avgTurns = 12;
  const avgCharsPerTurn = 300;
  const totalChars = avgTurns * avgCharsPerTurn;
  const cost = (totalChars / 1000) * TTS_COST_PER_1K_CHARS;
  return `~$${cost.toFixed(3)} за сессию (${avgTurns} сообщений × ~${avgCharsPerTurn} симв.)`;
}

function buildTtsText(fullText: string): string {
  if (fullText.length <= TTS_MAX_CHARS) return fullText;
  const slice = fullText.slice(0, TTS_MAX_CHARS);
  const lastPunct = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'));
  if (lastPunct > 40) {
    return slice.slice(0, lastPunct + 1);
  }
  return slice + '…';
}

async function generateSpeechElevenLabs(text: string, voiceId = config.elevenLabsVoiceId): Promise<Buffer> {
  const resolvedVoiceId = String(voiceId || '').trim();
  if (!config.elevenLabsApiKey || !resolvedVoiceId) {
    throw new Error('ElevenLabs is not configured');
  }

  const body = JSON.stringify({
    text: buildTtsText(text),
    model_id: 'eleven_multilingual_v2',
  });

  const options: https.RequestOptions = {
    hostname: 'api.elevenlabs.io',
    port: 443,
    path: `/v1/text-to-speech/${encodeURIComponent(
      resolvedVoiceId
    )}?output_format=opus_48000_128`,
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenLabsApiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/opus',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return await new Promise<Buffer>((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          const errBody = Buffer.concat(chunks).toString('utf8');
          return reject(
            new Error(
              `ElevenLabs TTS error: HTTP ${res.statusCode} ${res.statusMessage || ''} - ${errBody.slice(0, 300)}`
            )
          );
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function generateSpeechElevenLabsVoice(text: string, voiceId: string): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) return Buffer.alloc(0);
  return generateSpeechElevenLabs(trimmed, voiceId);
}

/** OpenAI opus = OGG/Opus, suitable for Telegram sendVoice (voice message). */
export async function generateSpeechOpenAI(text: string, voice: TtsVoice = 'male'): Promise<Buffer> {
  const response = await openai.audio.speech.create({
    model: config.openaiTtsModel,
    voice: OPENAI_VOICE_MAP[voice] as any,
    input: buildTtsText(text),
    response_format: 'opus',
  });
  const blob = await (response as any).blob();
  const arrayBuffer = await blob.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Backward-compatible helper for non-Telegram callers (e.g. web trainer).
export async function generateSpeechBuffer(text: string, voice: TtsVoice = 'male'): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) return Buffer.alloc(0);

  if (useOpenAITts()) {
    return generateSpeechOpenAI(trimmed, voice);
  }

  try {
    return await generateSpeechElevenLabs(trimmed);
  } catch (elErr) {
    const msg = elErr instanceof Error ? elErr.message : String(elErr);
    if (msg.includes('401') || msg.includes('402') || msg.includes('403') || msg.includes('Payment Required') || msg.includes('Unauthorized')) {
      console.warn('[tts] ElevenLabs failed, falling back to OpenAI TTS');
      return generateSpeechOpenAI(trimmed, voice);
    }
    throw elErr;
  }
}

export interface SendVoiceOptions {
  voice?: TtsVoice;
}

/**
 * Send client voice/audio message using TTS.
 * Uses OpenAI TTS when TTS_PROVIDER=openai or ElevenLabs unavailable.
 * Fails silently for the user (only logs).
 */
export async function sendClientVoiceIfEnabled(
  ctx: Context,
  text: string,
  options?: SendVoiceOptions
): Promise<void> {
  if (!isTtsEnabled()) return;
  const trimmed = text.trim();
  if (!trimmed) return;

  const voice = options?.voice ?? 'male';

  const tryOpenAI = async () => {
    const buffer = await generateSpeechOpenAI(trimmed, voice);
    if (!buffer.length) return;
    await ctx.replyWithVoice(Input.fromBuffer(buffer, 'voice.ogg'));
  };

  const tryElevenLabs = async () => {
    const audio = await generateSpeechElevenLabs(trimmed);
    if (!audio.length) return;
    await ctx.replyWithVoice(Input.fromBuffer(audio, 'voice.ogg'));
  };

  try {
    if (useOpenAITts()) {
      await tryOpenAI();
      return;
    }
    try {
      await tryElevenLabs();
    } catch (elErr) {
      const msg = elErr instanceof Error ? elErr.message : String(elErr);
      if (msg.includes('401') || msg.includes('402') || msg.includes('403') || msg.includes('Payment Required') || msg.includes('Unauthorized')) {
        console.warn('[tts] ElevenLabs failed, falling back to OpenAI TTS');
        await tryOpenAI();
      } else {
        throw elErr;
      }
    }
  } catch (err) {
    console.error('[tts] Failed to send voice:', err);
  }
}
