import fs from 'node:fs';
import { openai } from '../lib/openaiClient';
import { config } from '../config';
import type { TranscriptTurn } from './callHistory';

export const CALL_RETRANSCRIPTION_MODEL = config.aiApiProvider === 'proxyapi'
  ? 'openai/gpt-4o-transcribe-diarize' : 'gpt-4o-transcribe-diarize';
const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

interface DiarizedSegment {
  speaker?: unknown;
  start?: unknown;
  end?: unknown;
  text?: unknown;
}

function words(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}]+/gu) ?? []);
}

function similarity(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

function mergeSegments(segments: DiarizedSegment[]): Array<{ speaker: string; text: string; start: number; end: number }> {
  const ordered = segments
    .filter((s): s is DiarizedSegment & { speaker: string; text: string; start: number; end: number } =>
      typeof s.speaker === 'string' && typeof s.text === 'string'
      && typeof s.start === 'number' && typeof s.end === 'number'
      && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);
  const result: Array<{ speaker: string; text: string; start: number; end: number }> = [];
  for (const segment of ordered) {
    const last = result[result.length - 1];
    if (last && last.speaker === segment.speaker && segment.start - last.end <= 1.2) {
      last.text = `${last.text} ${segment.text.trim()}`;
      last.end = segment.end;
    } else {
      result.push({ speaker: segment.speaker, text: segment.text.trim(), start: segment.start, end: segment.end });
    }
  }
  return result;
}

/**
 * The agent's actual words are already known. Use them to identify its diarized
 * speaker; only replace manager ASR, keeping the exact generated agent text.
 * Refuse an uncertain alignment rather than changing the meaning of a report.
 */
export function mergeCallRetranscription(
  original: readonly TranscriptTurn[],
  segments: DiarizedSegment[],
): TranscriptTurn[] | null {
  const turns = mergeSegments(segments);
  const speakers = [...new Set(turns.map((turn) => turn.speaker))];
  if (speakers.length !== 2 || original.length < 2) return null;

  const roleTexts = {
    client: original.filter((turn) => turn.role === 'client').map((turn) => turn.text),
    manager: original.filter((turn) => turn.role === 'manager').map((turn) => turn.text),
  };
  if (!roleTexts.client.length || !roleTexts.manager.length) return null;
  const speakerScores = speakers.map((speaker) => {
    const spoken = turns.filter((turn) => turn.speaker === speaker);
    const score = (reference: string[]) => spoken.reduce((sum, turn) =>
      sum + Math.max(0, ...reference.map((text) => similarity(turn.text, text))), 0) / spoken.length;
    return { speaker, client: score(roleTexts.client), manager: score(roleTexts.manager) };
  });
  speakerScores.sort((a, b) => (b.client - b.manager) - (a.client - a.manager));
  const agent = speakerScores[0];
  const other = speakerScores[1];
  if (agent.client < 0.35 || agent.client - agent.manager < 0.08
    || agent.client - agent.manager - (other.client - other.manager) < 0.2) return null;

  const diarizedRoles = turns.map((turn) => turn.speaker === agent.speaker ? 'client' : 'manager');
  const originalRoles = original.map((turn) => turn.role);
  if (diarizedRoles.length !== originalRoles.length
    || diarizedRoles.some((role, index) => role !== originalRoles[index])) return null;

  return original.map((turn, index) => turn.role === 'manager'
    ? { role: 'manager', text: turns[index].text }
    : { ...turn });
}

export async function retranscribeCallRecording(
  filepath: string,
  original: readonly TranscriptTurn[],
): Promise<TranscriptTurn[] | null> {
  const stat = await fs.promises.stat(filepath);
  if (stat.size <= 0 || stat.size > MAX_TRANSCRIPTION_BYTES) return null;
  const result = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filepath),
    model: CALL_RETRANSCRIPTION_MODEL,
    response_format: 'diarized_json',
    chunking_strategy: 'auto',
  } as any, { timeout: 90_000 }) as unknown as { segments?: DiarizedSegment[] };
  return Array.isArray(result.segments) ? mergeCallRetranscription(original, result.segments) : null;
}
