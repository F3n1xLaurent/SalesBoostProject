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

  it('does not accept an unrelated imported item when script tags are configured', () => {
    expect(importedItemMatchesTrainerTags(['Продажа', 'Авто'], ['Сервис'])).toBe(false);
    expect(importedItemMatchesTrainerTags(['Сервис', 'Диагностика'], ['Сервис'])).toBe(true);
  });
});
