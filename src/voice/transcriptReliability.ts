import type { TranscriptTurn } from './callHistory';

/** Standalone checks of the audio channel carry no evidence about sales
 * performance. Do not match a substantive answer merely beginning «Алло». */
export function isConnectionCheck(text: string): boolean {
  const normalized = text.toLocaleLowerCase('ru').replace(/ё/gu, 'е')
    .replace(/[^а-я\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return /^(?:(?:алло|да|пожалуйста)\s+)*(?:алло|вас\s+не\s+слышно|я\s+вас\s+не\s+слышу|не\s+слышу\s+вас|вы\s+меня\s+слышите|меня\s+слышно|говорите\s+пожалуйста\s+вас\s+не\s+слышно)(?:\s+пожалуйста)?$/u.test(normalized);
}

export function isConnectionCheckTurn(transcript: readonly TranscriptTurn[], index: number): boolean {
  const text = transcript[index]?.text ?? '';
  if (!isConnectionCheck(text)) return false;
  // Initial «Алло» can be an incomplete greeting under the configured
  // checklist. A repeated «Алло» during an established exchange is a check.
  if (/^(?:алло[\s,.!?…]*)+$/iu.test(text.trim())) {
    return transcript.slice(0, index).some(turn => turn.role === 'manager')
      && transcript.slice(0, index).some(turn => turn.role === 'client');
  }
  return true;
}

/** A narrow guard for visibly broken ASR, not a grammar checker. */
export function isUnreliableManagerUtterance(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  if (/[¿�]|[а-яёa-z][-–—]{2,}|[-–—]{2,}[а-яёa-z]/iu.test(normalized)) return true;
  // A short phrase ending in an unfinished adjective is not reliable evidence
  // that the manager avoided a question or used a poor tone.
  const words = normalized.match(/[а-яё]+/giu) ?? [];
  return words.length <= 5 && /(?:^|\s)[а-яё]{3,}(?:иче|ичес|ческ)[.!?…]*$/iu.test(normalized);
}

export function filterUnreliableManagerTurns<T extends TranscriptTurn>(transcript: readonly T[]): T[] {
  return transcript.filter((turn) => turn.role !== 'manager' || !isUnreliableManagerUtterance(turn.text));
}
