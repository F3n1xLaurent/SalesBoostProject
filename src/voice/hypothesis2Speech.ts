import { normalizeRussianSpeechNumbers, russianNumberWords } from './speechFacts';

function genitiveYear(year: number): string {
  const tail = year % 100;
  const ordinal: Record<number, string> = { 0: 'двухтысячного', 1: 'первого', 2: 'второго', 3: 'третьего', 4: 'четвёртого', 5: 'пятого', 6: 'шестого', 7: 'седьмого', 8: 'восьмого', 9: 'девятого',
    10: 'десятого', 11: 'одиннадцатого', 12: 'двенадцатого', 13: 'тринадцатого', 14: 'четырнадцатого', 15: 'пятнадцатого', 16: 'шестнадцатого', 17: 'семнадцатого', 18: 'восемнадцатого', 19: 'девятнадцатого',
    20: 'двадцатого', 30: 'тридцатого', 40: 'сорокового', 50: 'пятидесятого', 60: 'шестидесятого', 70: 'семидесятого', 80: 'восьмидесятого', 90: 'девяностого' };
  if (tail === 0) return ordinal[0];
  return `две тысячи ${ordinal[tail] ?? `${russianNumberWords(Math.floor(tail / 10) * 10)} ${ordinal[tail % 10]}`}`;
}

function brands(text: string): string {
  return text.replace(/Mercedes[-\s]Benz/giu, 'Мерседес-Бенц')
    .replace(/G[-\s](?:Class|Класс)/giu, 'Джи-класс')
    .replace(/\bAMG\b/giu, 'АМГ').replace(/\bBMW\b/giu, 'БМВ')
    .replace(/\bKia\b/giu, 'Киа').replace(/\bCarnival\b/giu, 'Карнивал');
}

export function hypothesis2SpokenSubject(title: string): string {
  return normalizeRussianSpeechNumbers(brands(title
    .replace(/,?\s*\b[IVX]{1,4}\b(?:\s*\([A-ZА-Я]\d{1,4}\))?/gu, '')
    .replace(/\s*\([A-ZА-Я]\d{1,4}\)/gu, '')
    .replace(/\b(20\d{2})\b(?:\s+года)?/gu, (_match, year: string) => `${genitiveYear(Number(year))} года`)))
    .replace(/\s+/gu, ' ').trim();
}

export function hypothesis2SpokenText(text: string, subjectTitle: string | null): string {
  let spoken = text;
  if (subjectTitle) {
    const escaped = subjectTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    spoken = spoken.replace(new RegExp(escaped, 'giu'), () => hypothesis2SpokenSubject(subjectTitle));
  }
  return normalizeRussianSpeechNumbers(brands(spoken))
    .replace(/две\s+тысяча\s+/giu, 'две тысячи ');
}
