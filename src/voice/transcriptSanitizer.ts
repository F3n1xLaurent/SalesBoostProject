const BRACKETED_SEGMENT_RE = /\[([^\[\]]+)\]/g;

/**
 * Removes speech-to-text service annotations in square brackets, such as
 * `[expensive]`, `[background noise]`, `[laughter]` or `[неразборчиво]`.
 */
export function sanitizeTranscriptText(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text
    .replace(BRACKETED_SEGMENT_RE, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function sanitizeTranscriptTurns<T extends { text: string }>(turns: readonly T[]): T[] {
  const sanitized: T[] = [];
  for (const turn of turns) {
    const text = sanitizeTranscriptText(turn.text);
    if (!text) continue;
    sanitized.push({ ...turn, text });
  }
  return sanitized;
}
