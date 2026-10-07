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
      expect(prompt).toContain('# Роль и цель');
      expect(prompt).toContain('Всегда оставайся клиентом');
      expect(prompt).toContain('Клиент выбирает автомобиль для семьи.');
      expect(prompt).toContain('Есть ли гарантия?');
      expect(prompt).toContain('Тестовая компания');
      expect(prompt).not.toContain('Гарантия один год');
      expect(prompt.match(/# Приоритетные правила/g)).toHaveLength(1);
      expect(prompt).toContain('# Подключение, IVR и ожидание');
    }
    expect(demoPrompt).toContain('Твоё имя — Анна');
    expect(demoPrompt).toContain('сразу и прямо ответь: «Меня зовут Анна»');
    expect(demoPrompt).toContain('+79990000000');
    expect(planPrompt).toContain('обязательно выбери себе одно обычное человеческое русское имя');
    expect(planPrompt).toContain('сразу и прямо ответь: «Меня зовут [выбранное имя]»');
  });

  it('не допускает служебное резюме после завершения разговора', () => {
    const prompt = buildRealtimeCallPrompt({
      script,
      profile,
      importedItem: { title: 'Автомобиль', description: 'Есть в наличии.' },
      holding: { name: 'Тестовая компания', description: null },
    });

    expect(prompt).toContain('Никогда не произноси служебные итоги');
    expect(prompt).toContain('После завершения больше ничего не говори.');
  });

  it('не превращает живой звонок в проверку ответа по эталону', () => {
    const prompt = buildRealtimeCallPrompt({
      script,
      profile,
      importedItem: { title: 'Автомобиль', description: 'Есть в наличии.' },
      holding: { name: 'Тестовая компания', description: null },
    });

    expect(prompt).toContain('«40 тысяч» является нормальным ответом на вопрос о пробеге');
    expect(prompt).toContain('Качество работы сотрудника оценивает отдельная аналитика');
    expect(prompt).toContain('Не добивайся эталонной формулировки');
    expect(prompt).not.toContain('После двух попыток вернуть разговор к вопросу');
  });
});
