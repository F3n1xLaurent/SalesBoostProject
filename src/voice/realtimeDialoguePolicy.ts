/** Business state is derived from heard speech, never from end_call.reason. */
export type PolicyTurn = { role: string; text: string; metrics?: { interrupted?: boolean } };
// Interrupted turns already contain the conservative heard prefix. Keep that
// prefix (including a chosen hour), but exclude wholly inaudible generations.
const audible = (turns: readonly PolicyTurn[]) => turns.filter(t => !t.text.startsWith('[') && t.text.trim());
const VISIT = /визит|встреч|прие[хдз]|подъе[хдз]|тест.?драйв|запис(?:аться|ать|ыва|али|ан[аы]?\s+на)|запиш|жд[её]м\s+вас/iu;
const DAY = /послезавтра|завтра|сегодня|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье/iu;
const HOURS: Record<string, number> = { один: 1,одному: 1,час: 1,два: 2,двум: 2,двух: 2,три: 3,трём: 3,трех: 3,трёх: 3,четыре: 4,четырём: 4,четырех: 4,пять: 5,пяти: 5,шесть: 6,шести: 6,семь: 7,семи: 7,восемь: 8,восьми: 8,девять: 9,девяти: 9,десять: 10,десяти: 10,одиннадцать: 11,одиннадцати: 11,двенадцать: 12,двенадцати: 12,тринадцать: 13,тринадцати: 13,четырнадцать: 14,четырнадцати: 14,пятнадцать: 15,пятнадцати: 15,шестнадцать: 16,шестнадцати: 16,семнадцать: 17,семнадцати: 17,восемнадцать: 18,восемнадцати: 18,девятнадцать: 19,девятнадцати: 19,двадцать: 20,двадцати: 20 };
Object.assign(HOURS, { 'двадцать один': 21, 'двадцати одному': 21, 'двадцать два': 22, 'двадцати двум': 22, 'двадцать три': 23, 'двадцати трём': 23 });
const AVAILABILITY_RANGE = /(?:с|от)\s+(?:\d|[а-яё]+)\S*\s+до\s|\b\d{1,2}\s*[-–]\s*\d{1,2}\b/iu;
const OPTIONS_QUESTION = /(?:каки[емх]|чем)[^.!?]*(?:опци|функци)|(?:опци|функци)[^.!?]*(?:пользуетесь|важн)/iu;
const REJECTED_SLOT = /(?:слот|время)[^.!?]*занят|(?:приехать|подъехать|записать(?:ся)?)[^.!?]*не\s+(?:получится|смож)|(?:не\s+(?:подходит|получится|смогу)|занят[оы]?)(?=[\s,.!?]|$)/iu;
const CLOCK_MENTION = /\d{1,2}:\d{2}|(?:^|[\s,.!?])час(?:а|ов|у|ам)?(?=[\s,.!?]|$)/iu;
function paymentQuestion(text: string): boolean {
  return /наличн/iu.test(text) && /кредит/iu.test(text)
    && /\?|планируете|рассматриваете|уточни|уточня|покупк|оплат/iu.test(text);
}
type Slot = { hour: number; minute: number; day: string | null; text: string; ambiguousHour: boolean };
export function visitSlot(text: string): Slot | null {
  // Ranges and alternatives are availability, not an appointment.
  if (AVAILABILITY_RANGE.test(text) || /(?:^|\s)(?:или|либо)(?=\s|[,.]|$)/iu.test(text)) return null;
  const number = Object.keys(HOURS).sort((a,b)=>b.length-a.length).join('|');
  const candidates = [
    ...text.matchAll(new RegExp(`(?:^|[\\s,.!?])(?:в|к|около|ближе\\s+к)\\s+(\\d{1,2})(?::(\\d{2}))?(?=[\\s,.!?]|$)|(?:^|[\\s,.!?])(?:в|к|около|ближе\\s+к)\\s+(${number})(?=[\\s,.!?]|$)`, 'giu')),
    ...text.matchAll(/(?:^|[\s,.!?])(\d{1,2}):(\d{2})(?=[\s,.!?]|$)/gu),
    ...text.matchAll(new RegExp(`(?:^|[\\s,.!?])()()(${number})\\s+(?:час(?:а|ов)?|ноль\\s+ноль)(?=[\\s,.!?]|$)`, 'giu')),
  ];
  // «Пробег около пятнадцати тысяч километров» and «в два миллиона»
  // describe the product, not an appointment at 15:00 or 02:00.
  const match = candidates.find(candidate => {
    const afterNumber = text.slice(candidate.index + candidate[0].length);
    return !/^\s*(?:тысяч|миллион|миллиард|километр|км|рубл|доллар|евро|лет|год|месяц|процент)/iu.test(afterNumber)
      && !/(?:до|после)\s*$/iu.test(text.slice(0, candidate.index));
  });
  if (!match) return null;
  let hour = match[1] ? Number(match[1]) : HOURS[match[3].toLowerCase()];
  if (hour < 1 || hour > 23) return null;
  if (hour < 12 && /вечера|после\s+обеда|второй\s+половине/iu.test(text)) hour += 12;
  const tail = text.slice((match.index ?? 0) + match[0].length).replace(/^\s+час(?:у|ам|ов|а)?/iu, '');
  const spokenMinute = tail.match(/^\s+(ноль\s+ноль|десять|пятнадцать|двадцать|тридцать|сорок|пятьдесят)(?:\s+(один|два|три|четыре|пять|шесть|семь|восемь|девять))?(?=[\s,.!?]|$)/iu);
  const minuteValues: Record<string, number> = { 'ноль ноль': 0, десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50 };
  const minute = match[2] ? Number(match[2]) : spokenMinute
    ? minuteValues[spokenMinute[1].toLowerCase().replace(/\s+/gu, ' ')] + (HOURS[spokenMinute[2]?.toLowerCase()] ?? 0) : 0;
  if (minute > 59) return null;
  const ambiguousHour = !match[2] && hour < 12 && !/утра|вечера|после\s+обеда|второй\s+половине/iu.test(text);
  return { hour, minute, day: text.match(DAY)?.[0]?.toLowerCase() ?? null, text: text.trim(), ambiguousHour };
}
export function sameVisitTime(a: string, b: string): boolean {
  const left=visitSlot(a), right=visitSlot(b);
  if (!left || !right) return true; // Unknown isn't a proven conflict.
  const lower = left.hour < right.hour ? left : right;
  const sameHour = left.hour === right.hour || (lower.ambiguousHour && left.hour % 12 === right.hour % 12);
  return (!left.day || !right.day || left.day===right.day) && sameHour && left.minute===right.minute;
}
function visitState(turns: readonly PolicyTurn[]) {
  const history = audible(turns);
  const start = history.findIndex(t => VISIT.test(t.text));
  const relevant = start < 0 || productUnavailable(history) ? [] : history.slice(start);
  const manager = history.filter(t=>t.role==='manager').at(-1)?.text ?? '';
  const clientSlot = relevant.filter(t=>t.role==='client' && visitSlot(t.text)).at(-1)?.text;
  let managerSlot: string | undefined;
  for (const turn of relevant.filter(t => t.role === 'manager')) {
    if (REJECTED_SLOT.test(turn.text) || AVAILABILITY_RANGE.test(turn.text)
      || (/(?:^|\s)(?:или|либо)(?=\s|[,.]|$)/iu.test(turn.text) && (DAY.test(turn.text) || CLOCK_MENTION.test(turn.text)))) {
      managerSlot = undefined;
    } else if (visitSlot(turn.text)) managerSlot = turn.text;
  }
  return { active: relevant.length>0, manager, clientSlot, managerSlot, dayKnown: relevant.some(t => DAY.test(t.text)) };
}

/** An explicit lack of a suitable product makes a visit unnecessary. A later
 * confirmed alternative can reopen negotiation; a tool reason cannot. */
function productUnavailable(turns: readonly PolicyTurn[]): boolean {
  let unavailable = false;
  for (const turn of audible(turns).filter(t => t.role === 'manager')) {
    if (/(?:нет(?:у)?|не\s+было|отсутствует)\s+(?:(?:у\s+нас|сейчас|пока|вообще|такого|такой|подходящего|подходящей|этого|этой|ни\s+одного|ни\s+одной)\s+){0,5}(?:автомобил[ья]|машин[аы]|модел[ьи])|(?:автомобил[ья]|машин[аы]|модел[ьи])\s+(?:(?:у\s+нас|сейчас|пока|вообще)\s+){0,5}(?:нет(?:у)?|не\s+было|отсутствует)/iu.test(turn.text)) unavailable = true;
    else if (/(?:автомобил[ья]|машина|модель)[^.!?]{0,30}(?:есть|в\s+наличии)|(?:есть|в\s+наличии)[^.!?]{0,30}(?:автомобил|машин|модел)/iu.test(turn.text)) unavailable = false;
  }
  return unavailable;
}
export function dialogueNeedsValidation(turns: readonly PolicyTurn[]): boolean {
  const state = visitState(turns);
  if (/(?:до\s+свидания|всего\s+доброго|до\s+встречи|не\s+звоните|разговор\s+окончен)/iu.test(state.manager)) return false;
  const visitDecision = state.active && (state.clientSlot || VISIT.test(state.manager) || DAY.test(state.manager)
    || visitSlot(state.manager) || /удобн|врем|час/iu.test(state.manager));
  return !!visitDecision || !!state.managerSlot || paymentQuestion(state.manager) || OPTIONS_QUESTION.test(state.manager) || unansweredFactInstruction(turns).length > 0;
}
/** Reject clear non-answers, without claiming to semantically grade every reply. */
export function unansweredManagerResponseIssue(turns: readonly PolicyTurn[], response: string): string | null {
  const manager = audible(turns).filter(t => t.role === 'manager').at(-1)?.text ?? '';
  const lastQuestion = manager.match(/[^.!?]*\?/gu)?.at(-1) ?? manager;
  if (paymentQuestion(manager) && !/наличн|кредит|оплат|способ.*расч[её]т|собственн[^.!?]*средств|за\s+свои|(?:пока|ещ[её])\s+(?:выбираю|думаю)|не\s+(?:решил[аи]?|определил[а-яё]*|выбрал[аи]?)/iu.test(response)) {
    return 'Менеджер спросил о способе оплаты: наличные или кредит. Ответь по легенде; если способ ещё не выбран, прямо скажи это. Не подменяй ответ вопросом о времени визита.';
  }
  const question = /\?|^(?:а\s+)?(?:какой|какая|какие|какими|для\s+кого|сколько|подскажите)/iu.test(manager);
  if (!question) return null;
  const substantive = response.replace(/до\s+(?:свидания|встречи|связи)[^.!?]*[.!?]?|всего\s+(?:доброго|хорошего)[.!]?/giu, '')
    .replace(/(?:^|[\s,.!])(?:хорошо|спасибо|да|нет|договорились|понятно|понял[аи]?|отлично)(?=[\s,.!]|$)/giu, '').replace(/[\s,.!]+/gu, '');
  const closedQuestion = /удобно|подойд[её]т|подходит|сможете|можете\s+(?:приехать|подъехать|перезвонить)|получить\s+смс/iu.test(lastQuestion);
  // Slot choice has a dedicated recovery which asks for a concrete time.
  const visitQuestion = VISIT.test(lastQuestion) || /(?:како[ей]|во\s+сколько)[^.!?]*врем/iu.test(lastQuestion);
  if (!substantive && !closedQuestion && !visitQuestion) return `Ответь по существу на последний вопрос менеджера «${manager}», а не одним подтверждением или прощанием.`;
  if (OPTIONS_QUESTION.test(manager)
    && !/подогрев|обогрев|камер|парктрон|климат|кондиционер|круиз|навиг|панорам|массаж|вентиляц|безопас|парков|комфорт|простор|мультимед|свет|багаж|диспле|экран|ничем|никак|(?:пользуюсь|использую)\s+(?:все|всеми)|не\s+(?:могу\s+уточнить|знаю|пользуюсь|использую)|затрудняюсь/iu.test(response)) {
    return `Менеджер спросил об опциях: «${manager}». Сначала назови используемые функции/предпочтения из легенды или прямо скажи, что не можешь уточнить; не заменяй ответ согласованием визита.`;
  }
  return null;
}
export function hasVisitNegotiation(turns: readonly PolicyTurn[]): boolean {
  return visitState(turns).active;
}
export function previousClientVisitTime(turns: readonly PolicyTurn[]): string | null {
  return visitState(turns).clientSlot ?? null;
}
export function currentManagerVisitTime(turns: readonly PolicyTurn[]): string | null {
  return visitState(turns).managerSlot ?? null;
}
export function repeatedVisitQuestionIssue(turns: readonly PolicyTurn[], response: string): string | null {
  const asksSlot = (text: string) => /\?/u.test(text)
    && /како[йе][^.!?]*(?:день|врем)|во\s+сколько|когда[^.!?]*(?:приехать|подъехать)|уточните[^.!?]*врем|подтвердить[^.!?]*(?:время|час)/iu.test(text);
  if (!asksSlot(response)) return null;
  const state = visitState(turns);
  if (productUnavailable(turns)) return 'Подходящего автомобиля нет: не согласовывай визит и не проси подтверждать время. Ответь на вопрос сотрудника и при необходимости попрощайся.';
  if (/повторите|не\s+расслышал[аи]?|не\s+услышал[аи]?/iu.test(state.manager)) return null;
  if (state.managerSlot) return `Менеджер уже назвал время: «${state.managerSlot}». Не спрашивай его заново; подтверди предложение или уточни конкретное расхождение с ранее выбранным временем.`;
  if (audible(turns).filter(t => t.role === 'client' && asksSlot(t.text)).length >= 2) {
    return 'Время визита уже дважды уточняли. Не задавай тот же вопрос снова и не утверждай, что запись подтверждена; предложи вернуться к согласованию позже.';
  }
  return null;
}

/** Safe spoken recovery after the one model retry; never discard an already known slot. */
export function dialogueRecoveryResponse(turns: readonly PolicyTurn[], options: { answerRequired?: boolean } = {}): string {
  const history = audible(turns);
  const state = visitState(history);
  if (paymentQuestion(state.manager)) return 'Способ оплаты пока выбираю. Окончательно решу после осмотра.';
  if (productUnavailable(history)) {
    if (/(?:где|откуда)[^.!?]*(?:видел|увиде|объявлен|информац)/iu.test(state.manager)) return 'Точный источник объявления сейчас не могу назвать. Спасибо, до свидания.';
    if (!options.answerRequired) return 'Понятно, спасибо за информацию. До свидания.';
  }
  if (options.answerRequired) return 'Пока не могу уточнить ответ на ваш вопрос. Подскажите, что именно вам важно знать?';
  const knownDay = history.filter(t => !/(?:^|\s)(?:или|либо)(?=\s|[,.]|$)/iu.test(t.text))
    .map(t => t.text.match(DAY)?.[0]?.toLowerCase()).filter(Boolean).at(-1);
  const formatDay = (day: string) => /сегодня|завтра/iu.test(day) ? day
    : `в ${({ среда: 'среду', пятница: 'пятницу', суббота: 'субботу' } as Record<string, string>)[day] ?? day}`;
  const format = (text: string) => {
    const slot = visitSlot(text)!;
    const day = slot.day ?? knownDay;
    // Do not turn the spoken shorthand «к трём» into the explicit clock 03:00.
    const time = slot.ambiguousHour
      ? `${Object.keys(HOURS).find(word => HOURS[word] === slot.hour)}${slot.minute ? ` часов ${slot.minute} минут` : ''}`
      : `${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`;
    return `${day ? `${formatDay(day)} ` : ''}в ${time}`;
  };
  if (state.managerSlot && (!state.clientSlot || sameVisitTime(state.managerSlot, state.clientSlot))) {
    const slot = visitSlot(state.managerSlot)!;
    const confirmed = slot.ambiguousHour && state.clientSlot && !visitSlot(state.clientSlot)?.ambiguousHour
      ? state.clientSlot : state.managerSlot;
    return `Хорошо, приеду ${format(confirmed)}.`;
  }
  const visitQuestions = history.filter(t => t.role === 'client' && /\?/u.test(t.text)
    && /время|во\s+сколько|какой\s+день|записать|сможете\s+подтвердить/iu.test(t.text));
  if (state.active && visitQuestions.length >= 2) return 'Пока не удалось согласовать время. Давайте вернёмся к записи позже.';
  if (state.clientSlot) return `Мне удобно ${format(state.clientSlot)}. Сможете подтвердить это время?`;
  if (state.active) {
    return knownDay ? `Во сколько ${formatDay(knownDay)} можно приехать?`
      : 'Подскажите, на какой конкретный день и время договоримся?';
  }
  return 'Давайте уточним следующий шаг: о чём договоримся?';
}
export function unansweredFactResponseIssue(turns: readonly PolicyTurn[], response: string): string | null {
  const instruction = unansweredFactInstruction(turns);
  if (!instruction.includes('пока не получен')) return null;
  const history = audible(turns);
  const manager = history.at(-1)?.text ?? '';
  const question = history.slice(0,-1).filter(t=>t.role==='client').at(-1)?.text ?? '';
  const missing = FACTS.find(f => f.topic.test(question) && !f.answer.test(manager)
    && !(f.topic.test(response) && /\?|подскажите|уточните|назовите/iu.test(response))
    && history.filter(t=>t.role==='client' && f.topic.test(t.text) && /\?|подскажите|уточните/iu.test(t.text)).length < 2);
  return missing ? instruction : null;
}
export function canEndDialogue(turns: readonly PolicyTurn[], response: string): boolean {
  const state=visitState(turns);
  if (response.includes('?')) return false;
  if (unansweredManagerResponseIssue(turns, response)) return false;
  // A manager's explicit termination/refusal and callback are terminal even
  // when a visit could not be agreed. A quoted earlier goodbye isn't.
  if (/(?:до\s+свидания|всего\s+доброго|до\s+встречи|не\s+звоните|не\s+перезванивайте|разговор\s+окончен)/iu.test(state.manager)) return true;
  if (/(?:перезвоните|можете\s+перезвонить)/iu.test(state.manager)) return true;
  if (productUnavailable(turns)) return true;
  const rejectedStep = /не\s+(?:приеду|подъеду|буду|подходит|подтверждаю|соглас|смогу|получится|надо|нужно)|отказываюсь/iu.test(response);
  if (rejectedStep) return false;
  const offeredFollowUp = !/(?:не\s+(?:отправлю|пришлю|вышлю|перезвоню|свяжусь))/iu.test(state.manager)
    && /(?:отправлю|пришлю|вышлю|перезвоню|свяжусь)/iu.test(state.manager);
  const acceptedFollowUp = /(?:^|[\s,.!?])(?:да|хорошо|договорились|жду|подходит|спасибо)(?=$|[\s,.!?])/iu.test(response);
  if (!VISIT.test(state.manager) && offeredFollowUp
    && acceptedFollowUp) return true;
  if (state.active) {
    if (!state.managerSlot || !state.dayKnown) return false;
    if (state.clientSlot && !sameVisitTime(state.clientSlot,state.managerSlot)) return false;
    if (visitSlot(response) && !sameVisitTime(response,state.managerSlot)) return false;
    return (/подходит|договорились|приеду|подъеду|подтверждаю|буду\s+(?:в|к|у\s+вас)|хорошо/iu.test(response)
      || (!!state.clientSlot && /подходит|договорились|приеду|подъеду|подтверждаю/iu.test(state.clientSlot)))
      && !/(?:не\s+подходит|не\s+смогу|не\s+получится)/iu.test(response);
  }
  // A concrete non-visit next step needs both an offer and acceptance.
  return offeredFollowUp
    && acceptedFollowUp;
}
export function dialogueAgreementInstruction(turns: readonly PolicyTurn[]): string {
  const state=visitState(turns);
  const rules = ['Завершай звонок только после подтверждения конкретного следующего шага обеими сторонами, либо явного отказа/просьбы закончить или перезвонить. Одного «спасибо», закрытых вопросов или собственного прощания недостаточно.',
    'Не озвучивай «сейчас отвечу», «выбираю из вариантов», «зафиксирую время»: сразу дай сам ответ или выбранный вариант. Обещание ответить не является ответом.'];
  if (productUnavailable(turns)) rules.push('Сотрудник явно сообщил, что подходящего автомобиля нет. Визит согласовывать не нужно: не возвращайся к ранее названному часу и не требуй следующего шага ради завершения. Сначала ответь на последний вопрос сотрудника, затем можно естественно попрощаться.');
  if (state.active) rules.push('Согласуется визит: выбери конкретный день и время. «Будни», «завтра», «до обеда», диапазон часов и часы работы не являются согласованным временем. Если ты сам предложил новый час, дождись подтверждения менеджера; пока не прощайся.');
  if (state.clientSlot) rules.push(`Твоё последнее названное время визита: «${state.clientSlot}». Сохраняй его. Если менеджер называет другой час/день, сначала явно уточни расхождение; не соглашайся молча и не прощайся.`);
  if (state.managerSlot) rules.push(`Менеджер уже назвал время визита: «${state.managerSlot}». Не спрашивай заново день и время. Если оно подходит, подтверди его; на новый вопрос об оплате или автомобиле отвечай отдельно, сохраняя это время.`);
  return rules.join('\n');
}
const FACTS: Array<{topic: RegExp; answer: RegExp; name: string}> = [
  {name:'цена',topic:/цен[ауы]|стоимост|сколько\s+стоит/iu,answer:/(?:миллион|тысяч|рубл|цен[ауы]\s*(?:от\s*)?\d|стоит\s*\d)/iu},
  {name:'наличие',topic:/наличи|есть\s+ли.*(?:машин|автомобил)/iu,answer:/в\s+наличии|нет\s+в\s+наличии|остал(?:ся|ись)|на\s+складе|под\s+заказ|поставк|отсутству/iu},
  {name:'сравнение',topic:/сравни|чем\s+отлича|разниц/iu,answer:/в\s+отличие|(?:больше|меньше|выше|ниже|мощнее|экономичнее)|разница\s+в/iu},
  {name:'характеристики',topic:/характеристик|габарит|размер|коробк|мощност|расход/iu,answer:/автомат|робот|механик|вариатор|метр|сантиметр|лошад|литр|сил|ступен|\d/iu},
];
export function unansweredFactInstruction(turns: readonly PolicyTurn[]): string {
  const history=audible(turns), manager=history.at(-1);
  if (manager?.role!=='manager') return '';
  const question=history.slice(0,-1).filter(t=>t.role==='client').at(-1);
  if (!question || !/\?|подскажите|уточните/iu.test(question.text)) return '';
  const missing=FACTS.filter(f=>f.topic.test(question.text) && !f.answer.test(manager.text));
  return missing.map(f=>{
    const attempts=history.filter(t=>t.role==='client' && f.topic.test(t.text) && /\?|подскажите|уточните/iu.test(t.text)).length;
    return attempts<2 ? `По теме «${f.name}» ответ по существу пока не получен: «${question.text}». Общие обещания, «зависит от комплектации», приглашение приехать не заменяют факты. Сначала ответь на последний вопрос менеджера, затем один раз коротко вернись к этому вопросу. Если нужны комплектация/модель — назови известное из легенды, не выдумывай.`
      : `По теме «${f.name}» уже было одно повторное уточнение. Не спрашивай в третий раз и не считай вопрос решённым: факт остаётся неизвестным, продолжай остальные темы.`;
  }).join('\n');
}
