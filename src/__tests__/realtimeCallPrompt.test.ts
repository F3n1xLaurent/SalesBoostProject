import { describe, expect, it } from 'vitest';
import { buildRealtimeCallPrompt } from '../voice/callSettingsManagement';

const script = {
  context: 'Клиент выбирает автомобиль для семьи.',
  objectionsJson: JSON.stringify([{ id: 'o1', phrase: 'Дорого', whenAppropriate: 'После цены' }]),
  questionsJson: JSON.stringify([{ id: 'q1', text: 'Есть ли гарантия?', required: true }]),
  successCriteriaJson: JSON.stringify([{ id: 'c1', sourceType: 'question', sourceId: 'q1', expectedAnswer: 'Гарантия один год', score: 100 }]),
};

const profile = {
  age: 35,
  ageFrom: 35,
  ageTo: 35,
  temperament: 'doubtful',
  patience: 'medium',
  replyLength: 'short',
  communicationStyle: 'Сомневайся и проси конкретику.',
};

describe('buildRealtimeCallPrompt', () => {
  it('собирает плановый и демо-звонок одним набором правил', () => {
    const common = {
      script,
      profile,
      importedItem: { title: 'Автомобиль', description: 'Есть в наличии.' },
      customerVoiceName: 'Женский',
      holding: { name: 'Тестовая компания', description: 'Описание' },
    };
    const planPrompt = buildRealtimeCallPrompt(common);
    const demoPrompt = buildRealtimeCallPrompt({
      ...common,
      clientName: 'Анна',
      destinationPhone: '+79990000000',
    });

    for (const prompt of [planPrompt, demoPrompt]) {
      expect(prompt).toContain('# Guardrails');
      expect(prompt).toContain('Ты всегда ПОКУПАТЕЛЬ/КЛИЕНТ');
      expect(prompt).toContain('Клиент выбирает автомобиль для семьи.');
      expect(prompt).toContain('Есть ли гарантия?');
      expect(prompt).toContain('Тестовая компания');
      expect(prompt.match(/# Guardrails/g)).toHaveLength(1);
    }
    expect(demoPrompt).toContain('=== ДЕМО-ПЕРСОНА ===');
    expect(demoPrompt).toContain('Имя клиента: Анна');
    expect(demoPrompt).toContain('+79990000000');
    expect(planPrompt).not.toContain('=== ДЕМО-ПЕРСОНА ===');
  });

  it('не допускает служебное резюме после завершения разговора', () => {
    const prompt = buildRealtimeCallPrompt({
      script,
      profile,
      importedItem: { title: 'Автомобиль', description: 'Есть в наличии.' },
      holding: { name: 'Тестовая компания', description: null },
    });

    expect(prompt).toContain('Никогда не произноси итоги или протокол разговора');
    expect(prompt).toContain('После финальной реплики и прощания не создавай ни одного дополнительного текстового или голосового ответа.');
  });
});
