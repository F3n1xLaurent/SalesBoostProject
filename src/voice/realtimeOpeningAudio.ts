import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { config } from '../config';
import { elevenLabsWebSocketOptions } from './elevenLabsHttp';
import { appendSpeechAlignment, type SpeechAlignmentPoint } from './realtimeBargeIn';
import type { ElevenLabsTtsSettings } from './yandexRealtimeTest';

// Only this context-free sentence is reusable. Names, subject and answers are
// always generated from the actual conversation, never guessed before pickup.
export const PREPARED_GREETING = 'Здравствуйте.';
type Options = { prompt: string; elevenLabsVoiceId: string; elevenLabsTts: ElevenLabsTtsSettings };
type Audio = { audio: Buffer; alignment: SpeechAlignmentPoint[] };
type Entry = { expires: number; owners: number; result?: Audio; cancel: () => void };
const cache = new Map<string, Entry>();
const MAX_ENTRIES = 32;
const TTL_MS = 30 * 60_000;

function key(options: Options): string {
  return createHash('sha256').update(JSON.stringify([
    PREPARED_GREETING, options.prompt, options.elevenLabsVoiceId, options.elevenLabsTts,
  ])).digest('hex');
}

/** Bounded preparation; never connects to Vox or writes conversation history. */
export function prepareOpeningAudio(options: Options): () => void {
  const id = key(options);
  for (const [oldId, entry] of cache) {
    if (entry.expires <= Date.now()) { entry.cancel(); cache.delete(oldId); }
  }
  let entry = cache.get(id);
  if (!entry) {
    while (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value!;
      cache.get(oldest)!.cancel(); cache.delete(oldest);
    }
    entry = { expires: Date.now() + TTL_MS, owners: 0, cancel: () => {} };
    cache.set(id, entry);
    const target = entry;
    const tts = options.elevenLabsTts;
    const dialogue = /^eleven_v4/.test(tts.modelId);
    const query = new URLSearchParams({ model_id: tts.modelId, output_format: 'ulaw_8000', language_code: 'ru', sync_alignment: 'true' });
    const url = dialogue
      ? `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?${query}&apply_text_normalization=on`
      : `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.elevenLabsVoiceId)}/stream-input?${query}`;
    const ws = new WebSocket(url, { ...elevenLabsWebSocketOptions(), handshakeTimeout: 5_000,
      headers: { 'xi-api-key': config.elevenLabsApiKey } });
    const chunks: Buffer[] = [];
    const alignment: SpeechAlignmentPoint[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (success = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (success && bytes) target.result = { audio: Buffer.concat(chunks), alignment };
      else if (cache.get(id) === target) cache.delete(id);
      try { ws.close(); } catch { /* preparation is optional */ }
    };
    const timer = setTimeout(() => finish(), 8_000); timer.unref();
    target.cancel = () => finish();
    const send = (value: unknown) => ws.send(JSON.stringify(value));
    ws.on('open', () => {
      if (settled) return;
      const voice_settings = { stability: tts.stability, similarity_boost: tts.similarityBoost, speed: tts.speed };
      const dictionaries = tts.pronunciationDictionaryLocators.length
        ? { pronunciation_dictionary_locators: tts.pronunciationDictionaryLocators } : {};
      if (dialogue) {
        send({ voices: [options.elevenLabsVoiceId], voice_settings, ...dictionaries });
        send({ inputs: [{ text: PREPARED_GREETING, voice_id: options.elevenLabsVoiceId, new_turn: true }] });
        send({ flush: true });
      } else {
        send({ text: ' ', xi_api_key: config.elevenLabsApiKey, voice_settings, ...dictionaries });
        send({ text: `${PREPARED_GREETING} `, try_trigger_generation: true });
        send({ text: '' });
      }
    });
    ws.on('message', raw => {
      if (settled) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.error || message.detail) return finish();
        if (message.audio) {
          const audio = Buffer.from(message.audio, 'base64');
          if (bytes + audio.length > 64_000) return finish();
          appendSpeechAlignment(alignment, message.normalizedAlignment ?? message.alignment ?? message.normalized_alignment, bytes / 8);
          chunks.push(audio); bytes += audio.length;
        }
        if (message.is_final_audio_for_turn || message.is_final || message.isFinal) finish(true);
      } catch { finish(); }
    });
    ws.on('error', () => finish());
    ws.on('unexpected-response', () => finish());
    ws.on('close', () => finish());
  }
  entry.owners++;
  const owned = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owned.owners === 0 && !owned.result) owned.cancel();
  };
}

/** The normal, context-aware model must choose this exact opening sentence. */
export function preparedOpeningAudio(options: Options, text: string, live: boolean): Audio | null {
  if (!live || !/^Здравствуйте[.!](?:\s|$)/u.test(text)) return null;
  const entry = cache.get(key(options));
  return entry && entry.expires > Date.now() ? entry.result ?? null : null;
}
