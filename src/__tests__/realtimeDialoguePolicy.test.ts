import { describe, expect, it } from 'vitest';
import { canEndDialogue, currentManagerVisitTime, dialogueAgreementInstruction, dialogueRecoveryResponse, hasVisitNegotiation, previousClientVisitTime, repeatedVisitQuestionIssue, sameVisitTime, unansweredFactInstruction, unansweredFactResponseIssue, unansweredManagerResponseIssue, visitSlot } from '../voice/realtimeDialoguePolicy';
const manager = (text: string) => ({role:'manager',text});
const client = (text: string) => ({role:'client',text});

describe('production dialogue agreement regressions', () => {
  it('949: recording notice and mileage never create a visit at 15:00', () => {
    const turns = [manager('Для контроля качества обслуживания разговор будет записан.'),
      manager('Добрый день, чем могу помочь?'),
      client('Омода С5 2024 года, пробег около пятнадцати тысяч километров. Она ещё в продаже?'),
      manager('У нас не было такого автомобиля.')];
    expect(visitSlot(turns[2].text)).toBeNull();
    expect(hasVisitNegotiation(turns.slice(0, 3))).toBe(false);
    expect(previousClientVisitTime(turns)).toBeNull();
    expect(canEndDialogue(turns, 'Понятно, спасибо. До свидания.')).toBe(true);
    expect(dialogueRecoveryResponse(turns)).not.toContain('15:00');
    expect(dialogueRecoveryResponse(turns)).not.toContain('?');
  });

  it.each(['Пробег около пятнадцати тысяч километров.', 'Цена в два миллиона рублей.',
    'Скидка около пяти процентов.', 'Автомобилю около пяти лет.'])(
    'does not parse product quantities as hours: %s', (text) => expect(visitSlot(text)).toBeNull(),
  );

  it('949: cancels a stale visit when no product is available and answers the source question', () => {
    const turns = [client('Могу приехать завтра в 15:00.'), manager('У нас не было такого автомобиля.'),
      manager('А вы подскажите, где видели?')];
    expect(previousClientVisitTime(turns)).toBeNull();
    expect(hasVisitNegotiation(turns)).toBe(false);
    const recovery = dialogueRecoveryResponse(turns, { answerRequired: true });
    expect(recovery).toContain('источник объявления');
    expect(recovery).not.toContain('15:00');
    expect(canEndDialogue(turns, recovery)).toBe(true);
    expect(canEndDialogue(turns, 'А похожая машина есть?')).toBe(false);
    expect(dialogueAgreementInstruction(turns)).toContain('Визит согласовывать не нужно');
    expect(repeatedVisitQuestionIssue(turns, 'Сможете подтвердить это время?')).toContain('не согласовывай визит');
  });

  it('still finds a real visit hour after a mileage quantity in the same turn', () => {
    expect(visitSlot('Пробег около пятнадцати тысяч километров. Приеду завтра в 17:00.')?.hour).toBe(17);
  });

  it('bounds repeated confirmation requests as well as repeated slot questions', () => {
    const turns = [client('Могу приехать завтра в 15:00. Сможете подтвердить это время?'), manager('Пока не могу.'),
      client('Сможете подтвердить это время?'), manager('Пока неизвестно.')];
    expect(repeatedVisitQuestionIssue(turns, 'Сможете подтвердить это время?')).toContain('Не задавай тот же вопрос');
    expect(dialogueRecoveryResponse(turns)).not.toContain('?');
  });

  it('does not mistake lack of problems for an unavailable product or skip a new manager question', () => {
    expect(canEndDialogue([manager('Нет проблем с автомобилем.')], 'Спасибо, до свидания.')).toBe(false);
    const turns = [manager('Такого автомобиля нет.'), manager('Покупку за наличные или в кредит планируете?')];
    expect(canEndDialogue(turns, 'Спасибо, до свидания.')).toBe(false);
    expect(canEndDialogue(turns, 'Пока выбираю способ оплаты. Спасибо, до свидания.')).toBe(true);
    expect(canEndDialogue([manager('Автомобиля нет.'), manager('Есть подходящая машина. Приезжайте завтра.')], 'До свидания.')).toBe(false);
  });

  it('916: a payment alternative containing «сейчас» never clears the agreed visit hour', () => {
    const turns = [manager('Удобно будет приехать на тест-драйв?'),
      client('Завтра в первой половине дня удобнее. Если есть окно ближе к одиннадцати, я подстроюсь.'),
      manager('Предлагаю нам завтра встретиться в одиннадцать ноль-ноль.'),
      manager('Вы планируете покупку за наличные или за кредит? Спрашиваю, потому что сейчас действует выгода по кредиту.')];
    expect(currentManagerVisitTime(turns)).toContain('одиннадцать');
    expect(canEndDialogue(turns, 'Хорошо, приеду завтра в одиннадцать. До свидания.')).toBe(false);
    expect(unansweredManagerResponseIssue(turns, 'Хорошо, приеду завтра в одиннадцать.')).toContain('способе оплаты');
    expect(dialogueRecoveryResponse(turns)).toContain('Способ оплаты пока выбираю');
    expect(dialogueRecoveryResponse(turns)).not.toContain('?');
    expect(repeatedVisitQuestionIssue(turns, 'На какой день и время договоримся?')).toContain('Не спрашивай');
    expect(repeatedVisitQuestionIssue([...turns, manager('Повторите вопрос, пожалуйста.')], 'На какой день и время договоримся?')).toBeNull();
    expect(dialogueAgreementInstruction(turns)).toContain('Не спрашивай заново день и время');
    expect(canEndDialogue(turns, 'Способ оплаты пока выбираю. Приеду завтра в одиннадцать, до свидания.')).toBe(true);
  });
  it.each(['Пока не определилась.', 'Буду покупать за собственные средства.', 'За свои.', 'Пока думаю.'])(
    'accepts a substantive payment answer without demanding a fixed choice: %s', (answer) => {
      expect(unansweredManagerResponseIssue([manager('Покупку планируете за наличные или в кредит?')], answer)).toBeNull();
    });
  it('916: after the manager repeats eleven and asks «Удобно?» recovery confirms it', () => {
    const turns = [manager('Предлагаю записаться на тест-драйв.'), client('Мне удобно завтра ближе к одиннадцати.'),
      manager('Давайте договоримся завтра в одиннадцать ноль ноль.'), manager('Удобно?')];
    expect(dialogueRecoveryResponse(turns)).toBe('Хорошо, приеду завтра в одиннадцать.');
    expect(canEndDialogue(turns, dialogueRecoveryResponse(turns))).toBe(true);
    expect(dialogueRecoveryResponse(turns)).not.toContain('?');
  });
  it('retains an unresolved conflict and asks only for missing parts of the appointment', () => {
    const turns = [manager('Запишем вас на тест-драйв.'), client('Завтра в 12:00 удобно.'), manager('Можем завтра в 15:00.')];
    expect(dialogueRecoveryResponse(turns)).toContain('12:00');
    expect(dialogueRecoveryResponse(turns)).not.toContain('приеду');
    expect(dialogueRecoveryResponse([manager('Предлагаю приехать завтра.')])).toBe('Во сколько завтра можно приехать?');
    const noReply = [manager('Предлагаю приехать.'), client('На какой день и время можно записаться?'), manager('Потом решим.'),
      client('Подскажите время визита?'), manager('Пока не могу сказать.')];
    expect(dialogueRecoveryResponse(noReply)).not.toContain('?');
    expect(dialogueRecoveryResponse(noReply)).toContain('не удалось согласовать');
    expect(canEndDialogue(noReply, dialogueRecoveryResponse(noReply))).toBe(false);
  });
  it('never turns a spoken afternoon shorthand into a conflicting explicit night appointment', () => {
    const turns = [manager('Приезжайте завтра к трём.')];
    expect(dialogueRecoveryResponse(turns)).toBe('Хорошо, приеду завтра в три.');
    expect(sameVisitTime(dialogueRecoveryResponse(turns), 'Завтра в 15:00.')).toBe(true);
    expect(dialogueRecoveryResponse([client('Приехать завтра в 15:00 на визит удобно.'), ...turns])).toContain('15:00');
  });
  it('does not reuse an old slot after the manager replaces it with alternatives', () => {
    const turns = [manager('Приезжайте завтра в 12:00.'), client('Уточню возможность визита.'), manager('В двенадцать уже занято. Можно сегодня в 17:00 или завтра в 15:00.')];
    expect(canEndDialogue(turns, 'Хорошо, договорились, до свидания.')).toBe(false);
  });
  it('does not treat a rejected appointment or message offer as a next step', () => {
    expect(canEndDialogue([manager('Завтра в 12:00 приехать не получится, слот занят.')], 'Хорошо, до свидания.')).toBe(false);
    expect(canEndDialogue([manager('Не отправлю расчёт, у меня нет данных.')], 'Хорошо, жду. До свидания.')).toBe(false);
    expect(canEndDialogue([manager('Отправлю расчёт завтра.')], 'Нет, мне не подходит. До свидания.')).toBe(false);
    expect(canEndDialogue([manager('Приезжайте завтра в 12:00.')], 'Я не приеду. До свидания.')).toBe(false);
  });
  it('cannot replace an answer to a new question with a previous appointment', () => {
    const turns = [manager('Приезжайте завтра в 12:00.'), client('Завтра в 12:00 приеду.'), manager('А какими опциями вы сейчас пользуетесь?')];
    expect(canEndDialogue(turns, 'Хорошо, договорились. До свидания.')).toBe(false);
    expect(canEndDialogue(turns, 'Пользуюсь подогревом сидений и камерой заднего вида. До свидания.')).toBe(true);
  });
  it('distinguishes explicit 24-hour clock values from spoken afternoon shorthand', () => {
    expect(sameVisitTime('Завтра в 03:00.', 'Завтра в 15:00.')).toBe(false);
    expect(visitSlot('Завтра в двадцать один час.')?.hour).toBe(21);
    expect(visitSlot('Завтра к двадцати двум часам.')?.hour).toBe(22);
  });
  it('877: choosing tomorrow without an hour does not complete the appointment', () => {
    expect(canEndDialogue([manager('Планируете подъехать сегодня или завтра?')], 'Завтра удобнее. Спасибо, до свидания.')).toBe(false);
  });
  it('864/867: two alternatives or an arrival range are not a concrete appointment', () => {
    for (const offer of ['Предлагаю подъехать сегодня в 17:00 либо завтра в 15:00.', 'С 16 до 18 будем вас ожидать в салоне.']) {
      expect(canEndDialogue([manager(offer)], 'Хорошо, до свидания.')).toBe(false);
    }
  });
  it('874: preserves twelve when the manager silently substitutes fifteen', () => {
    const turns = [manager('Предлагаю записаться на завтра.'), client('Завтра ближе к двенадцати мне подходит.'), manager('Ждем вас завтра. Пятнадцать часов. Отправить СМС на этот номер?')];
    expect(canEndDialogue(turns, 'Да, завтра в пятнадцать подъеду. До свидания.')).toBe(false);
    expect(dialogueAgreementInstruction(turns)).toContain('двенадцати');
    expect(dialogueAgreementInstruction(turns)).toContain('не соглашайся молча');
  });
  it('waits for the manager to confirm an hour chosen from an availability range', () => {
    const turns=[manager('Для визита завтра свободно с девяти до пятнадцати часов.')];
    expect(canEndDialogue(turns, 'Завтра в двенадцать подходит. До встречи.')).toBe(false);
    expect(canEndDialogue([...turns,client('Завтра в двенадцать подходит.'),manager('Ждём вас завтра в двенадцать.')], 'Договорились, до встречи.')).toBe(true);
  });
  it('accepts a concrete manager offer and the client confirmation in one reply', () => {
    expect(canEndDialogue([manager('Приезжайте сегодня к семнадцати часам.')], 'Хорошо, приеду сегодня к пяти. До свидания.')).toBe(true);
    expect(canEndDialogue([manager('Приезжайте завтра в 15:00.')], 'Хорошо, приеду завтра в 12:00. До свидания.')).toBe(false);
  });
  it('never accepts a goodbye or end_call reasoning as an agreement', () => {
    expect(canEndDialogue([manager('Алло, слушаю.')], 'Спасибо, до свидания.')).toBe(false);
    expect(canEndDialogue([manager('Автомобиль есть.')], 'Спасибо, до свидания.')).toBe(false);
    expect(canEndDialogue([manager('Спасибо за звонок, до свидания.')], 'Спасибо, до свидания.')).toBe(true);
    expect(canEndDialogue([manager('Перезвоните завтра после десяти.')], 'Хорошо, перезвоню завтра после десяти. До свидания.')).toBe(true);
    expect(canEndDialogue([manager('Отправлю расчёт вам сегодня.')], 'Хорошо, жду расчёт. До свидания.')).toBe(true);
  });
  it('does not use inaudible bracketed generations as agreement history', () => {
    expect(canEndDialogue([manager('Выберите время визита.'),client('[реплика не прозвучала]'),manager('Хорошо.')], 'Договорились, до свидания.')).toBe(false);
  });
  it('parses inflected hours, standalone hours and unambiguous clock values', () => {
    expect(visitSlot('Завтра ближе к двенадцати.')?.hour).toBe(12);
    expect(visitSlot('Пятнадцать часов.')?.hour).toBe(15);
    expect(visitSlot('Сегодня. Семнадцать ноль ноль.')?.hour).toBe(17);
    expect(sameVisitTime('Завтра к пяти.', 'Завтра в 17:00.')).toBe(true);
    expect(sameVisitTime('Завтра в пять утра.', 'Завтра в 17:00.')).toBe(false);
    expect(sameVisitTime('Завтра в 12:30.', 'Завтра в 12:00.')).toBe(false);
    expect(sameVisitTime('Завтра в двенадцать тридцать.', 'Завтра в 12:00.')).toBe(false);
    expect(sameVisitTime('Завтра в пять тридцать вечера.', 'Завтра в 17:30.')).toBe(true);
    expect(visitSlot('Завтра после пятнадцати часов.')).toBeNull();
    expect(sameVisitTime('Сегодня к пяти.', 'Завтра к пяти.')).toBe(false);
  });
});

describe('substantive manager answers and bounded clarification', () => {
  it.each([
    ['Сколько стоит автомобиль?', 'Цена зависит от комплектации. Приезжайте завтра в 15:00.'],
    ['Есть в наличии EXEED LX?', 'Какую модель рассматриваете?'],
    ['Чем отличается от Audi Q7?', 'Важно понять, какими опциями вы пользуетесь сейчас.'],
    ['Какие габариты автомобиля?', 'Лучше приезжайте посмотреть.'],
  ])('recognizes an evasion: %s', (question,reply) => {
    const history=[client(question),manager(reply)];
    expect(unansweredFactInstruction(history)).toContain('пока не получен');
    expect(unansweredFactResponseIssue(history,'Хорошо, приеду завтра.')).toBeTruthy();
    expect(unansweredFactResponseIssue(history,question)).toBeNull();
  });
  it.each([
    ['Сколько стоит автомобиль?', 'Цена от двух миллионов рублей.'],
    ['Есть в наличии EXEED LX?', 'В наличии нет, только под заказ.'],
    ['Какая коробка передач?', 'Семиступенчатый робот.'],
    ['Чем отличается от Audi Q7?', 'Он больше и экономичнее.'],
  ])('recognizes a substantive answer: %s', (question,reply) => {
    expect(unansweredFactInstruction([client(question),manager(reply)])).toBe('');
  });
  it('allows at most one clarification and keeps the unknown fact unknown', () => {
    const history=[client('Какая цена?'),manager('Приезжайте.'),client('Уточните цену, пожалуйста?'),manager('Обсудим в салоне.')];
    expect(unansweredFactInstruction(history)).toContain('Не спрашивай в третий раз');
    expect(unansweredFactResponseIssue(history,'Тогда подскажите, какая гарантия?')).toBeNull();
  });
});
