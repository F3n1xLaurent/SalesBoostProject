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
          { expectedAnswer: 'Назвать преимущество модели', maxScore: 100, score: 80 },
          { expectedAnswer: 'Пригласить на тест-драйв', maxScore: 100, score: 50 },
          { expectedAnswer: 'Зафиксировать дату', maxScore: 100, score: 0 },
        ],
      },
    });

    expect(result.strengths).toEqual(['Назвать преимущество модели — выполнено']);
    expect(result.weaknesses).toEqual([
      'Пригласить на тест-драйв — выполнено частично',
      'Зафиксировать дату — не выполнено',
    ]);
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
});
