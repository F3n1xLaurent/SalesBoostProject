export type TranscriptionUncertainty = { turnIndex: number; quote: string; token: string; reason: string };
type Turn = { role: string; content?: string; text?: string };

/** A suspicious span is a review hint, not a corrected transcript or a proven lie. */
export function collectTranscriptionUncertainties(turns: Turn[], vehicleYear?: number, alternatives: Array<{ original: string; reviewed: string }> = []): TranscriptionUncertainty[] {
  const result: TranscriptionUncertainty[] = [];
  turns.forEach((turn, turnIndex) => {
    if (!['manager', 'assistant'].includes(turn.role)) return;
    const text = turn.content ?? turn.text ?? '';
    if (vehicleYear && Number.isFinite(vehicleYear)) {
      for (const match of text.matchAll(/(?:обслуживан[а-яё]*|техобслуживан[а-яё]*|сервис[а-яё]*)[^.!?,;:\n]{0,45}?(19\d{2}|20\d{2})\s*(?:год|г\.)/giu)) {
        if (Number(match[1]) < vehicleYear) result.push({ turnIndex, quote: match[0], token: match[1], reason: 'Распознанный год обслуживания раньше года автомобиля. Без записи нельзя отличить ошибку распознавания от оговорки или фактической ошибки; требуется проверка.' });
      }
    }
    for (const item of alternatives) {
      if (item.original === item.reviewed || ![item.original, item.reviewed].some((value) => value && text.includes(value.replace(/[.!?]+$/, '')))) continue;
      const years = [...item.original.matchAll(/(?:19|20)\d{2}/g)].map((match) => match[0]);
      for (const token of years.filter((year) => !item.reviewed.includes(year))) result.push({ turnIndex, quote: item.original, token, reason: 'Есть конкурирующие варианты распознавания; спорное слово не доказывает ошибку менеджера.' });
      const originalTokens = item.original.match(/[\p{L}\p{N}]+/gu) ?? [];
      const reviewedTokens = item.reviewed.match(/[\p{L}\p{N}]+/gu) ?? [];
      const normalize = (token: string) => token.toLowerCase().replace(/ё/gu, 'е');
      const originalSet = new Set(originalTokens.map(normalize));
      const reviewedSet = new Set(reviewedTokens.map(normalize));
      const changed = [...originalTokens.filter(token => !reviewedSet.has(normalize(token))), ...reviewedTokens.filter(token => !originalSet.has(normalize(token)))];
      // Only localized disagreements: unrelated/transcript-wide rewrites do
      // not turn every word into an uncertainty or erase independent faults.
      if (changed.length <= 6) for (const token of changed.filter(token => token.length >= 3 && text.includes(token))) {
        result.push({ turnIndex, quote: text, token, reason: 'Слово различается между вариантами распознавания записи; без проверки аудио оно не доказывает нарушение.' });
      }
    }
  });
  return result.filter((item, index) => result.findIndex((other) => other.turnIndex === item.turnIndex && other.token === item.token) === index);
}

export function isUncertainFactClaim(text: string, hints: TranscriptionUncertainty[]): boolean {
  return hints.some((hint) => text.toLocaleLowerCase('ru').includes(hint.token.toLocaleLowerCase('ru'))
    && /(?:ошиб|дезинформац|неверн|не соответств|противореч|некоррект|неподтвержд)/iu.test(text));
}
