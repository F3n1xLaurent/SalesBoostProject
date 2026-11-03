/** A terminal answering service, as distinct from an IVR that can connect a human. */
export function isTerminalAutomatedAnswer(value: unknown): boolean {
  const text = String(value ?? '').toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
  if (/нажмите|наберите|выберите.{0,25}(?:пункт|цифру|клавишу|отдел)|соедин(?:ю|яем|им).{0,40}(?:оператор|менеджер|сотрудник)|дождитесь|оставайтесь на линии/u.test(text)) return false;
  return /(?:я|это)\s+(?:голосов(?:ой|ая)|виртуальн(?:ый|ая)|автоматическ(?:ий|ая))\s+(?:ассистент|помощни(?:к|ца))|(?:абонент|линия|номер).{0,40}(?:занят|недоступен|не может ответить)|(?:оставьте|запишите).{0,30}сообщение|запишу.{0,25}(?:слово в слово|сообщение)|после\s+(?:звукового\s+)?сигнала/u.test(text);
}
