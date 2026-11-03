import { describe, expect, it } from 'vitest';
import { canEndDialogue, dialogueAgreementInstruction, sameVisitTime, unansweredFactInstruction, unansweredFactResponseIssue, visitSlot } from '../voice/realtimeDialoguePolicy';
const manager = (text: string) => ({role:'manager',text});
const client = (text: string) => ({role:'client',text});

describe('production dialogue agreement regressions', () => {
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
