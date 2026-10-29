// Shared by the live TTS gate and the regression checker. Keep business facts
// ("запишу адрес", "договорились на завтра") distinct from narrated workflow.
const CLOSING_INTENTION = /(?:(?:зафиксир[а-яё]*|фиксир[а-яё]*)\s*[,—:]?\s*(?:(?:нашу|эту|всю)\s+)?(?:договор[её]нност[а-яё]*|что\s+мы\s+договорились|итог[а-яё]*\s+(?:разговора|звонка|диалога))|(?:закро[а-яё]*|закрыва[а-яё]*|закон[а-яё]*|заверш[а-яё]*)\s+(?:(?:наш|этот|текущий)\s+)?(?:разговор|звонок|диалог|общение|сценарий)|(?:перейду|перехожу|приступлю)\s+к\s+завершению|(?:оформлю|выполню)\s+завершение)/iu;
const FAREWELL = /(?:до\s+свидания|всего\s+(?:доброго|хорошего)|хорошего\s+(?:дня|вечера)|до\s+(?:связи|встречи)|будем\s+на\s+связи|прощайте)(?=$|[^а-яё])/iu;

export function hasClosingIntention(text: string): boolean { return CLOSING_INTENTION.test(text); }

export function hasNaturalFarewell(text: string): boolean {
  return FAREWELL.test(text) || /(?:^|[.!?,;]\s*)(?:ну\s*,?\s*)?пока[.!\s]*$/iu.test(text.trim());
}

/** Salvage only the actual farewell, not its preceding technical explanation. */
export function extractNaturalFarewell(text: string): string {
  const farewell = text.match(FAREWELL);
  if (farewell) return farewell[0].trim() + '.';
  return /(?:^|[.!?,;]\s*)пока[.!\s]*$/iu.test(text.trim()) ? 'Пока.' : '';
}

/** Do not let duplicate goodbyes or a new question follow the first goodbye. */
export function throughFirstFarewell(text: string): string {
  const farewell = text.match(FAREWELL);
  if (!farewell) return text;
  const end = farewell.index! + farewell[0].length;
  const tail = text.slice(end);
  const second = tail.match(FAREWELL);
  if (second) return text.slice(0, end + second.index!).replace(/[\s,;—-]+$/u, '') + '.';
  if (tail.includes('?')) return text.slice(0, end).trim() + '.';
  return text;
}

export function farewellCount(text: string): number {
  return [...text.matchAll(new RegExp(FAREWELL.source, 'giu'))].length
    + (/(?:^|[.!?,;]\s*)пока[.!\s]*$/iu.test(text.trim()) ? 1 : 0);
}
