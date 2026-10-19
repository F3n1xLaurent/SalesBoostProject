import type { TranscriptTurn } from './callHistory';

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
