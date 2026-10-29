export type SpeechAlignmentPoint = {
  character: string;
  endMs: number;
};

type RawAlignment = {
  chars?: unknown;
  characters?: unknown;
  char_start_times_ms?: unknown;
  char_durations_ms?: unknown;
  character_start_times_seconds?: unknown;
  character_end_times_seconds?: unknown;
};

function finiteNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number)
    : [];
}

/**
 * ElevenLabs returns timings relative to each audio chunk. Attach them to the
 * call-wide playout timeline so a barge-in can be mapped back to heard text.
 */
export function appendSpeechAlignment(
  target: SpeechAlignmentPoint[],
  raw: unknown,
  audioOffsetMs: number,
): void {
  if (!raw || typeof raw !== 'object') return;
  const alignment = raw as RawAlignment;
  const characters = Array.isArray(alignment.chars)
    ? alignment.chars.map(String)
    : Array.isArray(alignment.characters)
      ? alignment.characters.map(String)
      : [];
  if (!characters.length) return;

  const startsMs = finiteNumbers(alignment.char_start_times_ms);
  const durationsMs = finiteNumbers(alignment.char_durations_ms);
  const startsSeconds = finiteNumbers(alignment.character_start_times_seconds);
  const endsSeconds = finiteNumbers(alignment.character_end_times_seconds);

  for (let index = 0; index < characters.length; index += 1) {
    let endMs: number | null = null;
    if (Number.isFinite(startsMs[index]) && Number.isFinite(durationsMs[index])) {
      endMs = startsMs[index] + durationsMs[index];
    } else if (Number.isFinite(endsSeconds[index])) {
      endMs = endsSeconds[index] * 1000;
    } else if (Number.isFinite(startsSeconds[index])) {
      const next = startsSeconds[index + 1];
      endMs = (Number.isFinite(next) ? next : startsSeconds[index] + 0.06) * 1000;
    }
    if (endMs == null || !Number.isFinite(endMs)) {
      // Preserve the character position; dropping one corrupts a heard word.
      target.push({ character: characters[index], endMs: Number.POSITIVE_INFINITY });
      continue;
    }
    target.push({ character: characters[index], endMs: audioOffsetMs + Math.max(0, endMs) });
  }
}

function cleanSpokenPrefix(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  // Eleven v4 direction tags guide delivery but are not spoken. Alignment can
  // begin after the opening bracket or end before the closing bracket, so an
  // incomplete leading tag must never be treated as audible speech.
  const withoutCompleteTag = compact.replace(/^[^\]]*\]\s*/, '');
  if (withoutCompleteTag === compact && /^\[?(?:convers|natural|warm|attentive)/i.test(compact)) return '';
  return withoutCompleteTag
    .replace(/\s+/g, ' ')
    .trim();
}

function endAtWordBoundary(value: string): string {
  const trimmed = value.trimEnd();
  if (!trimmed || /[\s.,!?;:—–-]$/.test(value)) return trimmed;
  const boundary = Math.max(
    trimmed.lastIndexOf(' '),
    trimmed.lastIndexOf('.'),
    trimmed.lastIndexOf(','),
    trimmed.lastIndexOf('!'),
    trimmed.lastIndexOf('?'),
  );
  return boundary > 0 ? trimmed.slice(0, boundary).trimEnd() : '';
}

function verifiedSpokenPrefix(alignedText: string, sourceText: string): string {
  // Alignment may omit characters or contain a partial direction tag. Never
  // insert its damaged spelling (e.g. «брыйдень») into model history. Keep only
  // the common, complete-word prefix of the actual text sent to synthesis.
  const source = cleanSpokenPrefix(sourceText);
  const sourceLetters = [...source.matchAll(/[\p{L}\p{N}]/gu)];
  const alignedLetters = alignedText.match(/[\p{L}\p{N}]/gu) ?? [];
  let length = 0;
  const canonical = (letter: string) => letter.toLocaleLowerCase('ru').replace(/ё/gu, 'е');
  while (length < sourceLetters.length && length < alignedLetters.length
    && canonical(sourceLetters[length][0]) === canonical(alignedLetters[length])) length++;
  if (!length) return '';
  const end = sourceLetters[length - 1].index! + sourceLetters[length - 1][0].length;
  // Include following punctuation/space so an actually completed word survives.
  const next = sourceLetters[length]?.index ?? source.length;
  return endAtWordBoundary(source.slice(0, next > end ? next : end));
}

export function audibleTextAt(
  alignment: readonly SpeechAlignmentPoint[],
  playbackMs: number,
  fallbackText: string,
  totalAudioMs: number,
): string {
  // The last packet sent by the bridge may still be in the carrier jitter
  // buffer. Being conservative is safer than telling the model that the user
  // heard words which never reached the handset.
  const safePlaybackMs = Math.max(0, playbackMs - 160);
  if (alignment.length) {
    let text = '';
    for (const point of alignment) {
      if (point.endMs > safePlaybackMs) break;
      text += point.character;
    }
    return verifiedSpokenPrefix(endAtWordBoundary(cleanSpokenPrefix(text)), fallbackText);
  }

  const source = cleanSpokenPrefix(fallbackText);
  if (!source || safePlaybackMs === 0) return '';
  const ratio = totalAudioMs > 0
    ? Math.min(1, safePlaybackMs / totalAudioMs)
    : Math.min(1, safePlaybackMs / Math.max(600, source.length * 65));
  return endAtWordBoundary(source.slice(0, Math.floor(source.length * ratio)));
}

export function isCumulativeTranscriptUpdate(
  previousText: string,
  nextText: string,
  previousAt: string,
  nextAt: string,
  maxGapMs = 1800,
): boolean {
  const previous = previousText.trim().toLocaleLowerCase('ru-RU');
  const next = nextText.trim().toLocaleLowerCase('ru-RU');
  if (!previous || previous === next) return previous === next;
  const previousWords = previous.split(/\s+/);
  const nextWords = next.split(/\s+/);
  if (nextWords.length < previousWords.length) return false;
  const comparable = previousWords.length;
  let matches = 0;
  for (let index = 0; index < comparable; index += 1) {
    const before = previousWords[index];
    const after = nextWords[index];
    const sharedPrefix = Math.min(before.length, after.length) >= 5
      && (before.startsWith(after.slice(0, 5)) || after.startsWith(before.slice(0, 5)));
    if (before === after || sharedPrefix) matches += 1;
  }
  // Realtime ASR often revises the ending of its previous hypothesis
  // (e.g. «производится» -> «производятся»), so exact startsWith is too
  // strict for identifying one growing utterance.
  if (matches / comparable < 0.8) return false;
  const gapMs = new Date(nextAt).getTime() - new Date(previousAt).getTime();
  return Number.isFinite(gapMs) && gapMs >= 0 && gapMs <= maxGapMs;
}
