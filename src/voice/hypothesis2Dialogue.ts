import { sameVisitTime } from './realtimeDialoguePolicy';
import { isConnectionCheck } from './transcriptReliability';

/** Adapt transport instructions, not business questions, in the isolated bridge. */
export function adaptHypothesis2Prompt(prompt: string): string {
  return prompt
    .replace(/используй существующую процедуру Finish call/giu, 'подтверди договорённость, естественно попрощайся одной репликой и вызови end_call')
    .replace(/При voicemail используй отдельную процедуру\./giu, 'Если это автоответчик, не веди с ним диалог; вызови end_call.')
    .replace(/Не вызывай end_call напрямую и не создавай обычную финальную реплику перед процедурой\./giu, 'Не озвучивай названия процедур и инструментов.');
}

export function profileIdentity(prompt: string): { name: string | null; gender: string | null } {
  // Test persona is appended after the plan; its explicit identity wins.
  const names = [...prompt.matchAll(/(?:^|\s)[Тт]ы\s+([А-ЯЁ][а-яё-]+)\s*,\s*(?:женщина|мужчина)/gu)];
  const genders = [...prompt.matchAll(/(?:Голос клиента:\s*(Женский|Мужской)|ты\s+[А-ЯЁ][а-яё-]+\s*,\s*(женщина|мужчина))/giu)];
  const last = genders.at(-1);
  const raw = last?.[1] ?? last?.[2];
  return { name: names.at(-1)?.[1] ?? null, gender: raw ? (/^жен/iu.test(raw) ? 'женский' : 'мужской') : null };
}

/** Only replace a self-introduction; never rewrite the employee's name. */
export function pinSelfIntroduction(text: string, name: string | null): string {
  if (!name) return text;
  return text.replace(/((?:меня\s+зовут|моё\s+имя)\s+)не\s+[а-яё][а-яё-]{1,30}\s*,?\s*а\s+[а-яё][а-яё-]{1,30}/giu, `$1${name}`)
    .replace(/((?:меня\s+зовут|моё\s+имя)\s+)[а-яё][а-яё-]{1,30}/giu, `$1${name}`)
    .replace(/(^|[.!?]\s*)(Я\s+)[А-ЯЁ][а-яё-]+(?=[,.!?]|$)/gu, `$1$2${name}`);
}

/** Preserve only an explicit requested callback time, never invent one. */
export function callbackFarewell(text: string): string | null {
  if (/(?:не\s+перезванива|не\s+надо\s+перезванива)/iu.test(text)) return null;
  const request = text.match(/(?:перезвоните|перезвони|(?:можете|сможете)\s+перезвонить)(?=[\s,!?.—-]|$)\s*[,—-]?\s*([^.!?]*)/iu);
  if (!request) return null;
  // A callback plus an unrelated question must still be handled by the model.
  const other = text.slice(0, request.index).replace(/я\s+сейчас\s+занят[а]?/iu, '');
  const tail = text.slice((request.index ?? 0) + request[0].length).replace(/^[.!?]\s*/u, '');
  if (/[?]/u.test(other + tail) || /(?:^|\s)(?:какой|какая|сколько|почему)(?=\s|$)/iu.test(request[1])) return null;
  const time = request[1].replace(/пожалуйста/giu, '').replace(/^[\s,]+|[\s,]+$/gu, '').replace(/^(?:мне|нам)\s+/iu, '');
  return time ? `Хорошо, перезвоню ${time}. До свидания.` : 'Хорошо, перезвоню. До свидания.';
}

type DialogueTurn = { role: string; text: string; metrics?: { interrupted?: boolean; ttsFailed?: boolean } };

/** Repeat once on an explicit audibility check, not on unrelated questions or
 * hold instructions. Later checks do not replay the same long reply again. */
export function connectionCheckResponse(turns: readonly DialogueTurn[], name: string | null = null): string | null {
  const latest = turns.at(-1);
  if (latest?.role !== 'manager' || !isConnectionCheck(latest.text)) return null;
  const previousClient = turns.slice(0, -1).filter(turn => turn.role === 'client'
    && !turn.text.startsWith('[') && !turn.metrics?.ttsFailed).at(-1);
  if (!previousClient) return null;
  const lastContent = turns.map(turn => turn.role === 'manager' && !isConnectionCheck(turn.text)).lastIndexOf(true);
  const checks = turns.slice(lastContent + 1).filter(turn => turn.role === 'manager' && isConnectionCheck(turn.text)).length;
  if (checks > 2) return null;
  if (checks === 2) return 'Да, я на связи. Вы меня слышите?';
  if (/меня\s+зовут[\s,.!?]*$/iu.test(previousClient.text)) {
    return name ? `Меня зовут ${name}. Вы меня слышите?` : 'Да, я на связи. Вы меня слышите?';
  }
  const question = previousClient.text.match(/[^.!?]+\?/gu)?.at(-1)?.trim();
  const repeat = question ?? previousClient.text.trim();
  return repeat.length <= 300 && !/\d{1,2}:\s*$/u.test(repeat)
    ? repeat : 'Да, я на связи. Вы меня слышите?';
}
const questionTopic = (text: string): string => {
  // Acknowledging the previous topic isn't asking it again: "Скидку понял.
  // Какой пробег?" belongs to mileage, not to discount.
  text = text.match(/[^.!?]*\?/gu)?.at(-1) ?? text;
  const topics: Array<[string, RegExp]> = [
    ['spare', /запас(?:н|к)|докатк|ремкомплект|комплектност.*кол[её]с/iu],
    ['discount', /скидк|скинут|торг/iu], ['mileage', /пробег/iu],
    ['ownership', /владел|собственник/iu], ['accident', /дтп|авари|окрас/iu],
  ];
  return topics.find(([, pattern]) => pattern.test(text))?.[0]
    ?? text.toLowerCase().replace(/ё/gu, 'е').replace(/[^а-яa-z0-9\s]/gu, ' ').split(/\s+/u).filter((word) => word.length >= 5).map((word) => word.slice(0, 5)).sort().join(' ');
};
/** Derive reminders from audible turns, never from tool arguments or silent generations. */
export function dialogueProgressInstructions(turns: readonly DialogueTurn[], prompt: string): string {
  const clients = turns.filter((turn) => turn.role === 'client' && !turn.metrics?.interrupted && !turn.text.startsWith('['));
  const questions = clients.filter((turn) => /\?|(?:интересует|подскажите|уточните)/iu.test(turn.text));
  const last = questions.at(-1), previous = questions.at(-2);
  const instructions: string[] = [];
  if (last && previous && questionTopic(last.text) && questionTopic(last.text) === questionTopic(previous.text)) {
    instructions.push(`Тема последнего вопроса «${last.text}» уже была задана и один раз уточнена. Не задавай её в третий раз другими словами. Если менеджер не ответил, оставь факт неизвестным, не говори «разобрались» и перейди к другой обязательной теме. Исключение — явная просьба менеджера повторить вопрос.`);
  }
  // An objection overlapping a mandatory question still consumes the ONE optional topic.
  const optional = prompt.match(/4\.\s*Выбери[^\n]*ОДНО[^\n]*\n+([\s\S]*?)(?=\n\n5\.|\n#|$)/iu)?.[1] ?? '';
  const optionalTopics = optional.split(/\n/u).filter((line) => /^\d+\./u.test(line.trim())).map(questionTopic).filter(Boolean);
  if (questions.some((turn) => optionalTopics.includes(questionTopic(turn.text)))) {
    instructions.push('Одно возражение/дополнительная тема из списка уже использовано, в том числе если оно совпало с обязательным вопросом. Не добавляй второе возражение или другой дополнительный вопрос из списка. Продолжай только оставшиеся обязательные темы и согласование следующего шага.');
  }
  const latest = turns.at(-1);
  if (last && latest?.role === 'manager') {
    const sentences = latest.text.split(/[.!?]+/u).map((part) => part.trim()).filter(Boolean);
    const nameOnly = sentences.length > 0 && !/(?:пробег|год|цен[ауые]|стоимость|машин|автомобил|кредит|наличи)/iu.test(latest.text)
      && sentences.every((part) => /(?:меня\s+зовут|мо[её]\s+имя|обращайтесь\s+ко\s+мне)/iu.test(part));
    if (nameOnly) instructions.push(`Менеджер только исправил своё имя, но не ответил на вопрос «${last.text}». Признай поправку имени и сначала вернись к этому неотвеченному вопросу (если лимит одного уточнения ещё не исчерпан), а не переключайся на новую тему. Не считай расхождение модели/года разрешённым.`);
  }
  return instructions.join('\n');
}

export type VisitOffer = { text: string; time: string };
/** Explicit, single visit slot only. No inference from tool.reason, address or generic "ждём". */
export function explicitVisitOffer(text: string): VisitOffer | null {
  if (!/(?:приезжайте|подъезжайте|жд[её]м\s+вас|(?:можете|можно)\s+(?:приехать|подъехать))/iu.test(text)
    || /(?:не\s+(?:приезжайте|подъезжайте)|(?:^|\s)(?:или|либо)(?=\s|$))/iu.test(text)) return null;
  const time = text.match(/(?:сегодня|послезавтра|завтра|в\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье))\s+(?:в|к|после)\s+(?:\d{1,2}(?::\d{2})?|[а-яё-]+)(?:\s+час(?:у|ам|ов|а)?)?(?:\s+(?:ноль|десять|пятнадцать|двадцать|тридцать|сорок|пятьдесят|\d{1,2})(?:\s+(?:одна|одну|один|две|два|три|четыре|пять|шесть|семь|восемь|девять))?(?:\s+минут[а-яё]*)?)?(?:\s+(?:утра|вечера|дня))?/iu)?.[0];
  return time ? { text, time } : null;
}
export function hasVisitDecision(text: string): boolean {
  // A generic thanks/goodbye isn't a confirmation. Clarification or refusal
  // counts as addressing the offer, but must not cause automatic hangup.
  return /(?:приеду|подъеду|буду\s+(?:у\s+вас|в|к|на)|не\s+(?:смогу|получится)|не\s+подходит|(?:мне\s+)?подходит|давайте\s+(?:завтра|сегодня|послезавтра|в|к)|договорились|подтверждаю|(?:сегодня|завтра|послезавтра)\s+(?:в|к|после)\s+\S+|(?:правильно\s+понимаю|единственный\s+вариант|можно\s+(?:завтра|перенести)))/iu.test(text);
}
export function visitResponseCanEnd(text: string, offer: VisitOffer): boolean {
  if (!hasVisitDecision(text) || text.includes('?')) return false;
  if (!sameVisitTime(text, offer.time)) return false;
  const days = (value: string): string[] => value.toLowerCase().match(/послезавтра|завтра|сегодня|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье/gu) ?? [];
  const offeredDay = days(offer.time)[0], replyDays = days(text);
  // A different proposed day is a counteroffer, not a confirmed appointment.
  return !(offeredDay && replyDays.length && !replyDays.includes(offeredDay) && /приеду|подъеду|давайте/iu.test(text));
}
export function visitDecisionInstructions(offer: VisitOffer): string {
  return `Менеджер предложил визит: «${offer.text}». Это предложение, а не уже достигнутая договорённость. Сначала явно прими, отклони или уточни его. Если ранее ты предлагал другое время, не подменяй его молча: согласуй расхождение. Не вызывай end_call и не произноси одно прощание вместо ответа. Подтверждение времени и прощание, когда они уместны, должны быть одной репликой.`;
}
