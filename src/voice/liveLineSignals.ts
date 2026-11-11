import { isTerminalAutomatedAnswer } from './terminalAutomatedAnswer';

export function activeLineSegment(value: string): string {
  // A single STT item may contain a recording/hold instruction followed by a
  // new employee. Keep the transcript intact; isolate only the current address
  // for routing decisions. A greeting followed by menu/recording instructions
  // remains automation, including scripts that begin «Добрый день».
  if (isTerminalAutomatedAnswer(value)) return value;
  const greetings = [...value.matchAll(/(?:здравствуйте|добрый\s+день|доброе\s+утро|добрый\s+вечер|алло)(?=[\s,.!?]|$)/giu)];
  const routing = [...value.matchAll(/нажмите|наберите|вы\s+позвонили|вас\s+приветству(?:ет|ют)|оставайтесь\s+на\s+линии|дождитесь|соединя(?:ю|ем)|соединю|переключу|переведу|неправильный\s+ввод|разговоры?\s+записыва[а-яё]*/giu)].at(-1);
  if (!routing) return value;
  const greeting = greetings.find(item => item.index! > routing.index! + routing[0].length);
  if (!greeting) return value;
  if (/(?:скажите|произнесите|повторите|слово)\s*[«"„“]?\s*$/iu.test(value.slice(0, greeting.index))) return value;
  const tail = value.slice(greeting.index).trim();
  if (/нажмите|наберите|выберите[^.!?]{0,25}(?:пункт|цифру|клавишу|отдел)|вас\s+приветству(?:ет|ют)|вы\s+позвонили|после\s+(?:звукового\s+)?сигнала|оставьте[^.!?]{0,25}сообщение|(?:голосовой|виртуальный|автоматический)\s+(?:ассистент|помощник)/iu.test(tail)) return value;
  return tail;
}

/** Direct address from an employee, rather than the identity of an answering
 * service. Kept free of server dependencies because analytics also uses it. */
export function isDirectHumanInteraction(value: string): boolean {
  const text = value.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
  // A recording can quote a question or ask for input before routing a call.
  if (/нажмите|наберите|выберите.{0,25}(?:пункт|цифру|клавишу|отдел)|после\s+(?:звукового\s+)?сигнала|оставьте.{0,25}сообщение|вас приветству|оставайтесь на линии/iu.test(text)) return false;
  return /(?:^|[.!?]\s*|алло[,\s]+)(?:вы|ты)\s+(?:(?:живой|настоящий)\s+)?(?:человек|робот|бот|голосовой\s+(?:ai[ -]?)?(?:ассистент|помощник))(?=[\s,.!?]|$)/iu.test(text)
    || /(?:^|[.!?]\s*|алло[,\s]+)(?:вы\s+меня\s+слышите|меня\s+слышно|вам\s+слышно|с\s+кем\s+я\s+(?:говорю|разговариваю)|какой\s+автомобиль\s+(?:вас\s+интересует|рассматриваете))(?=[\s,.!?]|$)/iu.test(text);
}
