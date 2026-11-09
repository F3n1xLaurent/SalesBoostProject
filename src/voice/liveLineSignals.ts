/** Direct address from an employee, rather than the identity of an answering
 * service. Kept free of server dependencies because analytics also uses it. */
export function isDirectHumanInteraction(value: string): boolean {
  const text = value.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
  // A recording can quote a question or ask for input before routing a call.
  if (/нажмите|наберите|выберите.{0,25}(?:пункт|цифру|клавишу|отдел)|после\s+(?:звукового\s+)?сигнала|оставьте.{0,25}сообщение|вас приветству|оставайтесь на линии/iu.test(text)) return false;
  return /(?:^|[.!?]\s*|алло[,\s]+)(?:вы|ты)\s+(?:(?:живой|настоящий)\s+)?(?:человек|робот|бот|голосовой\s+(?:ai[ -]?)?(?:ассистент|помощник))(?=[\s,.!?]|$)/iu.test(text)
    || /(?:^|[.!?]\s*|алло[,\s]+)(?:вы\s+меня\s+слышите|меня\s+слышно|вам\s+слышно|с\s+кем\s+я\s+(?:говорю|разговариваю)|какой\s+автомобиль\s+(?:вас\s+интересует|рассматриваете))(?=[\s,.!?]|$)/iu.test(text);
}
