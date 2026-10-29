import { describe, expect, it } from 'vitest';
import { hypothesis2SpokenSubject, hypothesis2SpokenText } from '../voice/hypothesis2Speech';
import { managerReplyTo } from '../voice/realtimeRegressionScenarios';
import { parseRegressionAssessment } from '../voice/realtimeRegressionAssessment';

describe('hypothesis 2 report regressions', () => {
  it('speaks a catalogue title without chassis code or English letter spelling', () => {
    const title = 'Mercedes-Benz G-Класс AMG, II (W463) 2019';
    expect(hypothesis2SpokenSubject(title)).toBe('Мерседес-Бенц Джи-класс АМГ две тысячи девятнадцатого года');
    expect(hypothesis2SpokenText(`Звоню по ${title}. Цена 2 250 000 рублей.`, title))
      .toBe('Звоню по Мерседес-Бенц Джи-класс АМГ две тысячи девятнадцатого года. Цена два миллиона двести пятьдесят тысяч рублей.');
    expect(hypothesis2SpokenText('Мерседес две тысяча девятнадцатого года.', null)).toBe('Мерседес две тысячи девятнадцатого года.');
  });
  it('does not confuse a question about actual mileage with vehicle availability', () => {
    expect(managerReplyTo('Подскажите, пробег в объявлении актуальный?', 'Киа')).toContain('Пробег тридцать тысяч');
    expect(managerReplyTo('Предложение актуально?', 'Киа')).toContain('в наличии');
    expect(managerReplyTo('Можете прислать отчёт по кузову и истории на мессенджер?', 'Киа')).toContain('можем отправить');
  });
  it('accepts indexed evidence for text requirements without requiring audio', () => {
    const turns = [{ role: 'manager', text: 'Как вас зовут?' }, { role: 'client', text: 'Меня зовут Анна, я не готова это обсуждать.' }];
    const result = parseRegressionAssessment(['identity'], turns, { checks: [{ id: 'identity', evaluatedRole: 'ai_client', status: 'pass', turnIndices: [0, 1], reason: 'Имя и женский род подтверждены.' }] });
    expect(result[0].status).toBe('pass');
    expect(result[0].evidence[1]).toContain('Меня зовут Анна');
    expect(parseRegressionAssessment(['identity'], turns, { checks: [{ id: 'identity', status: 'pass', turnIndices: [99, -1, '1'] }] })[0].status).toBe('review');
    expect(parseRegressionAssessment(['identity'], turns, { checks: [{ id: 'identity', status: 'pass', turnIndices: [0] }] })[0].status).toBe('review');
    expect(parseRegressionAssessment(['identity'], turns, { checks: [{ id: 'identity', status: 'pass', evidence: ['Я Андрей, мужчина.'] }] })[0].status).toBe('review');
  });
});
