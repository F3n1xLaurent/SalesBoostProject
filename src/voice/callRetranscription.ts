import fs from 'node:fs';
import { APIConnectionError } from 'openai';
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

  const blocks = <T extends { role: string; text: string }>(rows: readonly T[]) => rows.reduce<Array<{ role: string; text: string; originals: T[] }>>((result, row) => {
    const last = result.at(-1);
    if (last?.role === row.role) { last.text += ' ' + row.text; last.originals.push(row); }
    else result.push({ role: row.role, text: row.text, originals: [row] });
    return result;
  }, []);
  const reviewed = blocks(turns.map(turn => ({ role: turn.speaker === agent.speaker ? 'client' : 'manager', text: turn.text })));
  const source = blocks(original);
  if (reviewed.length !== source.length || reviewed.some((turn, index) => turn.role !== source[index].role)) return null;
  // A matching role sequence alone is insufficient: do not map a later agent
  // answer onto an omitted/reordered one. Keep generated client text exact.
  if (reviewed.some((turn, index) => turn.role === 'client' && similarity(turn.text, source[index].text) < 0.35)) return null;
  return source.flatMap((turn, index) => turn.role === 'manager'
    ? [{ role: 'manager' as const, text: reviewed[index].text }]
    : turn.originals.map(row => ({ ...row })));
}

export async function retranscribeCallRecording(
  filepath: string,
  original: readonly TranscriptTurn[],
): Promise<TranscriptTurn[] | null> {
  const stat = await fs.promises.stat(filepath);
  if (stat.size <= 0 || stat.size > MAX_TRANSCRIPTION_BYTES) return null;
  const deadline = Date.now() + 90_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Multipart upload bodies are streams. A network retry must reopen the
    // file, rather than ask the SDK to reuse an already consumed body.
    const file = fs.createReadStream(filepath);
    try {
      const result = await openai.audio.transcriptions.create({ file,
        model: CALL_RETRANSCRIPTION_MODEL, response_format: 'diarized_json', chunking_strategy: 'auto',
      } as any, { timeout: Math.max(1, deadline - Date.now()), maxRetries: 0 }) as unknown as { segments?: DiarizedSegment[] };
      return Array.isArray(result.segments) ? mergeCallRetranscription(original, result.segments) : null;
    } catch (error) {
      const failure = error as { name?: string; status?: number };
      const transient = error instanceof APIConnectionError
        || [408, 429].includes(failure.status ?? 0) || (failure.status ?? 0) >= 500;
      if (attempt || !transient || deadline - Date.now() < 2000) throw error;
    } finally { file.destroy(); }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return null;
}
