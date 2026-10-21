import { describe, expect, it } from 'vitest';
import { buildEvaluationHighlights } from '../logic/evaluationHighlights';

describe('evaluation highlights', () => {
  it('classifies YES as a strength, PARTIAL/NO as weaknesses and excludes NA', () => {
    const result = buildEvaluationHighlights({
      checklist: [
        { code: 'INTRODUCTION', status: ' yes ', comment: 'Менеджер представился по имени.' },
        { code: 'NEEDS_DISCOVERY', status: 'PARTIAL', comment: 'Задан только один вопрос.' },
        { code: 'NEXT_STEP_PROPOSAL', status: 'NO', comment: 'Следующий шаг не предложен.' },
        { code: 'TRADEIN_OFFER', status: 'NA', comment: 'Тема не поднималась.' },
      ],
    });

    expect(result.hasClassification).toBe(true);
    expect(result.strengths).toEqual([
      'Приветствие и представление: Менеджер представился по имени.',
    ]);
    expect(result.weaknesses).toEqual([
      'Выявление потребностей: Задан только один вопрос.',
      'Предложение следующего шага: Следующий шаг не предложен.',
    ]);
    expect([...result.strengths, ...result.weaknesses].join(' ')).not.toContain('trade-in');
  });

  it('uses the same 80 percent boundary as the script criteria score', () => {
    const result = buildEvaluationHighlights({
      plan_criteria: {
        items: [
          { expectedAnswer: 'Назвать преимущество модели', maxScore: 100, score: 80, status: 'YES' },
          { expectedAnswer: 'Пригласить на тест-драйв', maxScore: 100, score: 50, status: 'PARTIAL' },
          { expectedAnswer: 'Зафиксировать дату', maxScore: 100, score: 0, status: 'NO' },
        ],
      },
    });

    expect(result.strengths).toEqual(['Назвать преимущество модели — выполнено']);
    expect(result.weaknesses).toEqual([
      'Пригласить на тест-драйв — выполнено частично',
      'Зафиксировать дату — не выполнено',
    ]);
  });

  it('does not count script questions that were not reached as weaknesses', () => {
    const result = buildEvaluationHighlights({
      plan_criteria: {
        items: [
          { expectedAnswer: 'Рассказать об условиях гарантии', maxScore: 100, score: 0, status: 'NA' },
          { expectedAnswer: 'Назвать стоимость', maxScore: 100, score: 0, status: 'NO' },
        ],
      },
    });

    expect(result.weaknesses).toEqual(['Назвать стоимость — не выполнено']);
    expect(result.weaknesses.join(' ')).not.toContain('гарантии');
  });

  it('does not turn an ambiguous legacy zero into a weakness', () => {
    const result = buildEvaluationHighlights({
      plan_criteria: {
        items: [
          { expectedAnswer: 'Ответить на вопрос, который мог не прозвучать', maxScore: 100, score: 0 },
          { expectedAnswer: 'Подтверждённый хороший ответ', maxScore: 100, score: 100 },
        ],
      },
    });

    expect(result.strengths).toEqual(['Подтверждённый хороший ответ — выполнено']);
    expect(result.weaknesses).toEqual([]);
  });

  it('does not claim a classification when only NA items exist', () => {
    expect(buildEvaluationHighlights({
      checklist: [{ code: 'CREDIT_EXPLANATION', status: 'NA' }],
    })).toEqual({ strengths: [], weaknesses: [], hasClassification: false });
  });

  it('does not turn a client phrase into a manager strength', () => {
    const result = buildEvaluationHighlights({
      checklist: [{
        code: 'CAR_IDENTIFICATION',
        status: 'YES',
        evidence: ['Клиент: Я звоню насчёт Toyota Corolla Cross'],
        comment: 'Менеджер уточнил, какой автомобиль интересует клиента.',
      }],
    }, 8, [
      { role: 'manager', text: 'Алло!' },
      { role: 'client', text: 'Я звоню насчёт Toyota Corolla Cross' },
    ]);

    expect(result.strengths).toEqual([]);
    expect(result.weaknesses).toEqual([
      'Уточнение интересующего автомобиля: В стенограмме нет подтверждающей реплики менеджера.',
    ]);
  });

  it('describes a proven manager action instead of quoting a script criterion', () => {
    const result = buildEvaluationHighlights({
      plan_criteria: { items: [{ expectedAnswer: 'Какая комплектация?', maxScore: 10, score: 10, status: 'YES' }] },
      checklist: [{
        code: 'CAR_IDENTIFICATION', status: 'YES',
        evidence: ['Менеджер: Подскажите, какой автомобиль вас интересует?'],
        comment: 'Менеджер уточнил интересующий автомобиль.',
      }],
    }, 8, [
      { role: 'manager', text: 'Подскажите, какой автомобиль вас интересует?' },
      { role: 'client', text: 'Мерседес GLE.' },
    ]);

    expect(result.strengths).toEqual(['Менеджер уточнил интересующий автомобиль.']);
    expect(result.strengths.join(' ')).not.toContain('Какая комплектация');
  });

  it('keeps a confirmed company-defined checklist item with its custom ID', () => {
    const result = buildEvaluationHighlights({
      checklist: [{
        code: 'custom-greeting', status: 'YES',
        evidence: ['Менеджер: Добрый день, меня зовут Анна.'],
        comment: 'Менеджер представился по имени.',
      }],
    }, 8, [
      { role: 'manager', text: 'Добрый день, меня зовут Анна.' },
      { role: 'client', text: 'Здравствуйте.' },
    ]);
    expect(result.strengths).toEqual(['Менеджер представился по имени.']);
  });

  it('shows saved custom criterion titles instead of their UUIDs in strengths and weaknesses', () => {
    const greetingId = 'fb308823-ef83-4fbb-8e2e-4b562c4b009f';
    const needsId = '57b39032-9ae4-44dc-882e-8efcdd66be7f';
    const result = buildEvaluationHighlights({
      checklist_definition: { items: [
        { id: greetingId, title: 'Приветствие' },
        { id: needsId, title: 'Выявление потребностей' },
      ] },
      checklist: [
        { code: greetingId, status: 'YES', comment: 'Менеджер поздоровался.' },
        { code: needsId, status: 'NO', comment: 'Уточняющие вопросы не заданы.' },
      ],
    });

    expect(result.strengths).toEqual(['Приветствие: Менеджер поздоровался.']);
    expect(result.weaknesses).toEqual(['Выявление потребностей: Уточняющие вопросы не заданы.']);
    expect([...result.strengths, ...result.weaknesses].join(' ')).not.toContain(greetingId.toUpperCase());
  });

  it('never exposes an opaque criterion ID when an older evaluation lacks its definition', () => {
    const result = buildEvaluationHighlights({
      checklist: [{
        code: 'fb308823-ef83-4fbb-8e2e-4b562c4b009f',
        status: 'NO',
        comment: 'Менеджер не представился.',
      }],
    });

    expect(result.weaknesses).toEqual(['Менеджер не представился.']);
  });
});
