const UNITS = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

function triplet(value: number, feminine = false): string {
  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  const remainder = value % 100;
  if (remainder >= 10 && remainder < 20) parts.push(TEENS[remainder - 10]);
  else {
    const tens = Math.floor(remainder / 10);
    if (tens) parts.push(TENS[tens]);
    const units = remainder % 10;
    if (units) parts.push(feminine && units === 1 ? 'одна' : feminine && units === 2 ? 'две' : UNITS[units]);
  }
  return parts.join(' ');
}

function plural(value: number, forms: [string, string, string]): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return forms[2];
  const last = value % 10;
  return last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2];
}

export function russianNumberWords(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000_000_000) return null;
  if (value === 0) return 'ноль';
  const parts: string[] = [];
  for (const [factor, feminine, forms] of [
    [1_000_000, false, ['миллион', 'миллиона', 'миллионов']],
    [1_000, true, ['тысяча', 'тысячи', 'тысяч']],
    [1, false, ['', '', '']],
  ] as Array<[number, boolean, [string, string, string]]>) {
    const count = Math.floor(value / factor) % 1000;
    if (!count) continue;
    parts.push(triplet(count, feminine));
    if (factor > 1) parts.push(plural(count, forms));
  }
  return parts.filter(Boolean).join(' ');
}

/** Explicit spoken anchors reduce dropped price digits and English numerals in TTS. */
export function buildSpokenNumberAnchors(source: string): string[] {
  const anchors = new Set<string>();
  const pricePattern = /\b\d{1,3}(?:[\s\u00a0]\d{3}){1,3}\s*(?:₽|руб(?:лей|ля|ль|\.)?)|\b\d{5,9}\s*(?:₽|руб(?:лей|ля|ль|\.)?)/giu;
  for (const match of source.matchAll(pricePattern)) {
    const digits = match[0].replace(/\D/g, '');
    const words = russianNumberWords(Number(digits));
    if (words) anchors.add(`${match[0].trim()} → ${words} ${plural(Number(digits), ['рубль', 'рубля', 'рублей'])}`);
  }
  const inchPattern = /\b(\d{1,2})\s*(?:дюйм(?:ов|а)?|["″])/giu;
  for (const match of source.matchAll(inchPattern)) {
    const words = russianNumberWords(Number(match[1]));
    if (words) anchors.add(`${match[0].trim()} → ${words} ${plural(Number(match[1]), ['дюйм', 'дюйма', 'дюймов'])}`);
  }
  return [...anchors].slice(0, 12);
}

export function normalizeRussianSpeechNumbers(text: string): string {
  return text
    .replace(/\b\d{1,3}(?:[\s\u00a0]\d{3}){1,3}\s*(?:₽|руб(?:лей|ля|ль|\.)?)|\b\d{5,9}\s*(?:₽|руб(?:лей|ля|ль|\.)?)/giu, (match) => {
      const value = Number(match.replace(/\D/g, ''));
      const words = russianNumberWords(value);
      return words ? `${words} ${plural(value, ['рубль', 'рубля', 'рублей'])}` : match;
    })
    .replace(/\b(\d{1,2})\s*(?:дюйм(?:ов|а)?|["″])/giu, (match, digits: string) => {
      const value = Number(digits);
      const words = russianNumberWords(value);
      return words ? `${words} ${plural(value, ['дюйм', 'дюйма', 'дюймов'])}` : match;
    });
}
