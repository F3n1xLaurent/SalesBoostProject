import { describe, expect, it } from 'vitest';
import { buildCustomerScenarioPromptCore } from '../voice/customerScenarioPrompt';
import {
  buildTrainerInitialClientMessage,
  importedItemMatchesTrainerTags,
} from '../trainer/trainerScenario';

describe('trainer scenario selection', () => {
  it('opens with a scenario question without voicing the internal scenario name', () => {
    const message = buildTrainerInitialClientMessage({
      scenario: {
        id: 'service-script',
        name: 'Звонок в сервисную службу',
        questions: [{ text: 'Можно записаться на диагностику?', required: true }],
      },
      company: { city: 'Воронеж' },
      importedItem: { title: 'Audi A5 Sportback' },
    });

    expect(message).toContain('Можно записаться на диагностику?');
    expect(message).not.toContain('Звонок в сервисную службу');
    expect(message).not.toContain('Audi A5 Sportback');
    expect(message).not.toContain('есть в наличии');
    expect(message).not.toContain('предложение актуально');
  });

  it('uses a concrete imported item when the scenario has no opening question', () => {
    const message = buildTrainerInitialClientMessage({
      scenario: { id: 'car-script', name: 'Покупка автомобиля', questions: [] },
      importedItem: { title: 'Audi A5 Sportback' },
    });

    expect(message).toContain('Audi A5 Sportback');
    expect(message).not.toContain('Покупка автомобиля');
  });

  it('uses generic client instructions for trainer scenarios', () => {
    const prompt = buildCustomerScenarioPromptCore({
      mode: 'generic',
      context: 'Клиент хочет записаться на техническое обслуживание.',
      itemTitle: 'Звонок в сервисную службу',
      includeFirstMessage: false,
    });

    expect(prompt).toContain('реальный клиент');
    expect(prompt).not.toContain('реалистичный покупатель');
    expect(prompt).not.toContain('актуально ли предложение');
  });

  it('keeps live dialog separate from post-call answer evaluation', () => {
    const prompt = buildCustomerScenarioPromptCore({
      mode: 'generic',
      questions: [{ text: 'Какой пробег у автомобиля?', required: true }],
      criteria: [{ expectedAnswer: 'Пробег автомобиля составляет 40 000 километров', score: 10 }],
    });

    expect(prompt).toContain('«40 тысяч» является нормальным ответом на вопрос о пробеге');
    expect(prompt).toContain('Оценка выполняется только после разговора отдельной аналитикой');
    expect(prompt).toContain('повторять вопрос ради получения эталонного ответа');
    expect(prompt).not.toContain('Если ответил также или почти также');
  });

  it('gives the client a direct answer when the manager asks their name', () => {
    const prompt = buildCustomerScenarioPromptCore({ mode: 'generic' });

    expect(prompt).toContain('обязательно выбери себе одно обычное человеческое русское имя');
    expect(prompt).toContain('Запомни его и не меняй до конца разговора');
    expect(prompt).toContain('сразу и прямо ответь: «Меня зовут [выбранное имя]»');
    expect(prompt).toContain('Запрещено скрывать своё имя');
  });

  it('does not start the substantive scenario before a live employee answers', () => {
    const prompt = buildCustomerScenarioPromptCore({
      itemTitle: 'Skoda Octavia',
    });

    expect(prompt).toContain('после подтверждения живого сотрудника');
    expect(prompt).toContain('только после осмысленной реплики живого сотрудника');
    expect(prompt).toContain('Автоматическое приветствие, просьба подождать, музыка, шум и тишина');
    expect(prompt).toContain('Не повторяй первый вопрос из-за отсутствия ответа');
    expect(prompt).toContain('Если живой сотрудник явно сказал «повторите, пожалуйста»');
  });

  it('does not accept an unrelated imported item when script tags are configured', () => {
    expect(importedItemMatchesTrainerTags(['Продажа', 'Авто'], ['Сервис'])).toBe(false);
    expect(importedItemMatchesTrainerTags(['Сервис', 'Диагностика'], ['Сервис'])).toBe(true);
  });
});
