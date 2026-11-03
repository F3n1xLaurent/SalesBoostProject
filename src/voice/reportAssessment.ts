import type { TranscriptTurn } from './callHistory';
import type { UnifiedReportCategory } from './unifiedCallReport';
import { sameVisitTime, visitSlot } from './realtimeDialoguePolicy';

export const REPORT_MARK_RUBRIC = [
  'Единая шкала: positive («Положительно») — обязательный смысл передан корректно, даже другими словами; normal («Можно лучше») — полезный ответ/действие есть, но конкретный обязательный элемент отсутствует; negative («Плохо») — подтверждённая существенная ошибка, грубость, противоречие или полный уход от заданного вопроса.',
  'Сравнивай полный смысл исходной и улучшенной реплик. Если улучшение только стилистическое, короче или синонимично и не устраняет конкретный обязательный пробел, исходная реплика не заслуживает negative/normal. Одинаковая степень выполнения при одинаковом контексте должна получать одинаковую метку.',
  'До оценки определи действие клиента: информационный вопрос, просьба, возражение или сообщение. Вопрос о цене/характеристиках сам по себе не возражение. Возражение содержит препятствие, сомнение или несогласие; обычное сообщение о кредите не требует отработки возражения.',
  'Применяй критерий только когда возникла соответствующая ситуация. Не требуй фамилию, если критерий требует только имя. Не называй переспрос уже названных данных сильной стороной. Не оценивай неподтверждённое распознавание марки, имени или обрывка как фактическую ошибку.',
].join('\n');

export function clientAction(text: string): 'question' | 'request' | 'objection' | 'statement' {
  if (/дорого|дорож[еа]|дешевле|сомне|опасаюсь|переживаю|боюсь|неудобно|не\s+(?:подходит|устраивает|хочу|готов|нравится|могу|успею)|смущает|отказываюсь/iu.test(text)) return 'objection';
  if (/\?|(?:^|[.!]\s*)(?:а\s+)?(?:какой|какая|какие|сколько|почему|есть\s+ли|можно\s+ли|что\s+за)/iu.test(text)) return 'question';
  return /подскажите|расскажите|пришлите|отправьте|уточните/iu.test(text) ? 'request' : 'statement';
}

export function repeatedNameRequest(transcript: TranscriptTurn[], index: number): boolean {
  if (/не\s+(?:расслышал|услышал)|плохо\s+слыш|повторите[^.!?]*имя/iu.test(transcript[index]?.text ?? '')) return false;
  return transcript.slice(0, index).some((turn, position) => turn.role === 'client' && (
    /(?:[Мм]еня\s+зовут|[Мм]о[её]\s+имя|(?:^|[,.!]\s*)[Яя]\s+[А-ЯЁ][а-яё]+|[Ээ]то\s+[А-ЯЁ][а-яё]+)/u.test(turn.text)
    || (position > 0 && /как.*(?:зовут|обращаться)|ваше\s+имя/iu.test(transcript[position - 1].text))
  ));
}

const CRITERIA: Array<[string, RegExp]> = [
  ['INTRODUCTION', /представлен.*менеджер|имя\s+менеджер|представился/iu],
  ['SALON_NAME', /назван.*(?:компани|автосалон|салон)/iu],
  ['CAR_IDENTIFICATION', /уточнен.*(?:автомобил|запрос)|идентификац.*автомобил/iu],
  ['NEEDS_DISCOVERY', /потребност/iu], ['PRODUCT_PRESENTATION', /презентац/iu],
  ['CREDIT_EXPLANATION', /кредит/iu], ['TRADEIN_OFFER', /trade.?in|трейд.?ин/iu],
  ['OBJECTION_HANDLING', /возражен/iu], ['NEXT_STEP_PROPOSAL', /предложен.*следующ.*шаг/iu],
  ['DATE_FIXATION', /дат.*времен|времен.*дат/iu], ['FOLLOW_UP_AGREEMENT', /повторн.*контакт/iu],
  ['INITIATIVE', /инициатив/iu], ['COMMUNICATION_TONE', /тон|коммуникац/iu],
];
type Definition = { id: string; title?: string; category?: string; points?: number };
function definitions(evaluation: any): Definition[] {
  return Array.isArray(evaluation?.checklist_definition?.items) ? evaluation.checklist_definition.items : [];
}
export function reportCriterionCode(evaluation: unknown, code: string): string {
  const definition = definitions(evaluation).find(item => item.id.toLowerCase() === code.toLowerCase());
  return definition ? CRITERIA.find(([, pattern]) => pattern.test(definition.title ?? ''))?.[0] ?? code.toUpperCase() : code.toUpperCase();
}
/** An explicit applicability condition in the criterion is part of its rubric. */
export function criterionAllowsNa(definition: { allowNa?: boolean; instruction?: string }): boolean {
  return definition.allowNa === true || /(?:если|при\s+наличии)[^.!?]{0,100}(?:возражени|тема[^.!?]{0,40}(?:уместн|поднимал|обсуждал))/iu.test(definition.instruction ?? '');
}
function reportCategory(category: string): UnifiedReportCategory | null {
  if (/контакт/iu.test(category) && !/повторн/iu.test(category)) return 'Контакт';
  if (/выявлен|диагност/iu.test(category)) return 'Диагностика';
  if (/продукт|презентац|решен|аргумент|довер/iu.test(category)) return 'Продукт';
  if (/следующ|закрыт|повторн/iu.test(category)) return 'Закрытие';
  if (/коммуникац|общен/iu.test(category)) return 'Коммуникация';
  return null;
}
/** Derive all five display blocks from the saved checklist, never from AI numbers. */
export function checklistCategoryScores(evaluation: any): Partial<Record<UnifiedReportCategory, number>> {
  const defs = definitions(evaluation);
  if (!defs.length || !Array.isArray(evaluation?.checklist)) return {};
  const groups = new Map<UnifiedReportCategory, { earned: number; maximum: number }>();
  for (const item of evaluation.checklist) {
    if (!['YES', 'PARTIAL', 'NO'].includes(item?.status)) continue;
    const definition = defs.find(def => def.id.toLowerCase() === String(item.code).toLowerCase());
    const category = reportCategory(definition?.category ?? '');
    const weight = Number(item.weight ?? definition?.points);
    if (!category || !Number.isFinite(weight) || weight <= 0) continue;
    const group = groups.get(category) ?? { earned: 0, maximum: 0 };
    group.maximum += weight;
    group.earned += weight * (item.status === 'YES' ? 1 : item.status === 'PARTIAL' ? 0.5 : 0);
    groups.set(category, group);
  }
  return Object.fromEntries([...groups].map(([name, score]) => [name, Math.round(score.earned / score.maximum * 100)]));
}

export function isInapplicableReportText(text: string): boolean {
  return /^(?:не\s*применим[оа]?|не\s+требуется|n\/?a|не\s+оценивалось)[.!\s]*$/iu.test(text.split(':').at(-1)?.trim() ?? '');
}

const STRENGTH_ACTIONS: Array<[string, RegExp]> = [
  ['PRICE', /(?:назвал|сообщил|подтвердил|озвучил)[^.!?]{0,30}(?:цен|стоимост)/iu],
  ['INTRODUCTION', /представился|представил\s+себя|приветств|поздоровал/iu],
  ['SALON_NAME', /назвал[^.!?]{0,30}(?:компани|автосалон|салон)|название\s+компании/iu],
  ['CAR_IDENTIFICATION', /уточнил[^.!?]{0,35}(?:автомобил|модел)|подтвердил[^.!?]{0,35}модел/iu],
  ['NEEDS_DISCOVERY', /выяснил[^.!?]{0,30}(?:потребност|приоритет)|уточнил[^.!?]{0,30}(?:потребност|приоритет|срок\s+покупк)/iu],
  ['CREDIT_EXPLANATION', /объяснил[^.!?]{0,30}кредит/iu],
  ['OBJECTION_HANDLING', /(?:ответил|отреагировал|отработал)[^.!?]{0,35}возражен/iu],
  ['NEXT_STEP_PROPOSAL', /предложил[^.!?]{0,35}(?:визит|следующий\s+шаг|встреч|тест.?драйв)/iu],
  ['DATE_FIXATION', /(?:согласовал|зафиксировал)[^.!?]{0,35}(?:дат|врем)/iu],
  ['FOLLOW_UP_AGREEMENT', /договорился[^.!?]{0,35}(?:повторн|смс|sms)/iu],
];
export function reportStrengthActions(text: string): string[] {
  return STRENGTH_ACTIONS.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
}
export function deduplicateReportStrengths(items: string[], limit = 8): string[] {
  const result: string[] = [], seen = new Set<string>();
  for (const item of items) {
    const keys = reportStrengthActions(item);
    if (keys.length && keys.every(key => seen.has(key))) continue;
    if (result.includes(item)) continue;
    result.push(item); keys.forEach(key => seen.add(key));
    if (result.length >= limit) break;
  }
  return result;
}

/** A proposed/range slot is not a confirmed appointment. No numerical penalty here. */
export function confirmedTimeInDialog(turns: Array<{ role: string; content: string }>): boolean {
  let pending: { role: string; text: string } | null = null;
  let dayKnown = false;
  let confirmed = false;
  for (const turn of turns) {
    dayKnown ||= /сегодня|завтра|послезавтра|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье|\d{1,2}[./]\d{1,2}/iu.test(turn.content);
    const slot = visitSlot(turn.content);
    const rejected = /не\s+(?:подходит|смогу|получится|приеду|подъеду)|отменя|встреч[ау][^.!?]*отмен|слот[^.!?]*занят/iu.test(turn.content);
    const accepted = /(?:^|[\s,.!?])(?:да|хорошо|договорились|подходит|подтверждаю|жд[её]м|приеду|подъеду|отлично)(?=[\s,.!?]|$)/iu.test(turn.content)
      && !rejected && !turn.content.includes('?');
    if (rejected) { pending = null; confirmed = false; continue; }
    if (dayKnown && pending && pending.role !== turn.role && accepted && (!slot || sameVisitTime(pending.text, turn.content))) confirmed = true;
    if (slot) {
      if (pending && !sameVisitTime(pending.text, turn.content)) confirmed = false;
      pending = { role: turn.role, text: turn.content };
    } else if (/или|либо|занят|не\s+получится/iu.test(turn.content)) { pending = null; confirmed = false; }
  }
  return confirmed;
}
