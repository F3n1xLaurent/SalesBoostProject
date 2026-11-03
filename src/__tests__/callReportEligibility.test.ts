import { describe, expect, it } from 'vitest';
import { assessCallReportEligibility } from '../voice/callReportEligibility';
import type { TranscriptTurn } from '../voice/callHistory';

const client: TranscriptTurn = { role: 'client', text: 'Здравствуйте, хочу узнать цену автомобиля.' };
const manager = (text: string): TranscriptTurn => ({ role: 'manager', text });

describe('call report eligibility', () => {
  it('does not score Mia or its monologue while it is waiting to take a message', () => {
    expect(assessCallReportEligibility([
      manager('Приветствую! Линия абонента сейчас занята. Что важного ему передать?'),
      manager('Я голосовой ассистент Мия. Запишу всё слово в слово. Попробуем?'),
      manager('Ох, эта тишина! Подумать только, сейчас в мире уже разрабатываются нейросети, способные читать эмоции людей. А пока что я тут, жду ответа.'),
    ])).toMatchObject({ eligible: false, outcome: 'no_answer' });
  });
  it.each([
    ['Вызываемый абонент занят. Перезвоните позднее.', 'busy'],
    ['Абонент сейчас разговаривает по другой линии.', 'busy'],
    ['Телефон абонента выключен или находится вне зоны действия сети.', 'no_answer'],
    ['В данный момент абонент недоступен.', 'no_answer'],
    ['Набранный вами номер не обслуживается.', 'no_answer'],
    ['Оставьте сообщение после звукового сигнала.', 'no_answer'],
    ['Абонент временно не может принять ваш звонок.', 'no_answer'],
    ['Линия занята. Перезвоните позднее.', 'busy'],
  ])('skips carrier announcement: %s', (text, outcome) => {
    expect(assessCallReportEligibility([client, manager(text), client, manager(text)]))
      .toMatchObject({ eligible: false, outcome });
  });

  it.each(['Алло?', 'Да, алло.', 'Здравствуйте! Добрый день.', 'Слушаю вас.', 'Здравствуйте, менеджер Анна, слушаю вас.', 'Меня зовут Анна. Чем могу вам помочь?'])('skips a greeting followed by hangup: %s', (text) => {
    expect(assessCallReportEligibility([manager(text), client])).toMatchObject({ eligible: false, outcome: 'no_answer' });
  });

  it('recognizes a carrier message split into several turns', () => {
    expect(assessCallReportEligibility([client, manager('Абонент занят.'), manager('Пожалуйста, перезвоните позднее.')]))
      .toMatchObject({ eligible: false, outcome: 'busy' });
  });

  it('recognizes a busy announcement after an IVR greeting', () => {
    expect(assessCallReportEligibility([manager('Вы позвонили в автосалон. Дождитесь ответа.'), client, manager('Абонент занят.')]))
      .toMatchObject({ eligible: false, outcome: 'busy' });
  });

  it.each(['Нет в наличии.', 'Не звоните мне больше.', 'Я занят, позвоните завтра.', 'Цена миллион.', 'Да, есть.'])('retains short substantive speech: %s', (text) => {
    expect(assessCallReportEligibility([client, manager(text)])).toEqual({ eligible: true });
  });

  it('does not treat a missing or one-sided transcript as proof of a missed call', () => {
    for (const turns of [[], [client], [client, client], [manager('Цена миллион.')]]) {
      expect(assessCallReportEligibility(turns)).toMatchObject({ eligible: false, outcome: null });
    }
  });

  it('skips an unfinished IVR queue but retains a subsequent human conversation', () => {
    const queue = [manager('Вы позвонили в автосалон. Дождитесь ответа оператора.'), client];
    expect(assessCallReportEligibility(queue)).toMatchObject({ eligible: false, outcome: 'no_answer' });
    expect(assessCallReportEligibility([...queue, manager('Здравствуйте, автомобиль в наличии.'), client])).toEqual({ eligible: true });
  });

  it('retains real speech before or after an announcement', () => {
    const announcement = manager('Абонент занят.');
    const answer = manager('Автомобиль стоит миллион рублей.');
    expect(assessCallReportEligibility([announcement, client, answer])).toEqual({ eligible: true });
    expect(assessCallReportEligibility([client, answer, announcement])).toEqual({ eligible: true });
  });

  it('does not classify the bot quoting an announcement as remote carrier speech', () => {
    expect(assessCallReportEligibility([{ role: 'client', text: 'До этого говорили: абонент занят.' }, manager('Слушаю ваш вопрос, автомобиль есть.')])).toEqual({ eligible: true });
  });
});
