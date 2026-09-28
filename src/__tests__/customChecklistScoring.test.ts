import { describe, expect, it } from 'vitest';
import { computeCustomChecklistResult } from '../llm/evaluatorV2';

describe('custom checklist scoring', () => {
  it('calculates configured points and category dimensions deterministically', () => {
    const result = computeCustomChecklistResult(
      [
        { id: 'contact', title: 'Представился', instruction: 'Проверить представление', category: 'Контакт', points: 20, allowNa: false },
        { id: 'need', title: 'Уточнил запрос', instruction: 'Проверить вопросы', category: 'Выявление запроса', points: 40, allowNa: false },
        { id: 'next', title: 'Назначил следующий шаг', instruction: 'Проверить договорённость', category: 'Следующий шаг', points: 40, allowNa: false },
      ],
      {
        checklist: [
          { code: 'contact', status: 'YES', evidence: ['Менеджер: Меня зовут Анна'], comment: 'Выполнено' },
          { code: 'need', status: 'PARTIAL', evidence: ['Менеджер: Какой вариант рассматриваете?'], comment: 'Частично' },
          { code: 'next', status: 'NO', evidence: [], comment: 'Не выполнено' },
        ],
        extra_signals: {
          profanity: false,
          misinformation: false,
          passive_style: false,
          passive_severity: 'mild',
          low_engagement: false,
          redirect_to_website: false,
          bad_tone: false,
        },
        recommendations: [],
      },
      [
        { role: 'manager', content: 'Меня зовут Анна' },
        { role: 'manager', content: 'Какой вариант рассматриваете?' },
      ],
    );

    expect(result.score).toBe(40);
    expect(result.dimensions.first_contact).toBe(100);
    expect(result.dimensions.product_and_sales).toBe(50);
    expect(result.dimensions.closing_commitment).toBe(0);
  });

  it('does not let an unapproved NA remove a criterion', () => {
    const result = computeCustomChecklistResult(
      [{ id: 'required', title: 'Обязательный пункт', instruction: 'Проверить', category: 'Контакт', points: 100, allowNa: false }],
      {
        checklist: [{ code: 'required', status: 'NA', evidence: [], comment: 'Не применимо' }],
        extra_signals: {
          profanity: false,
          misinformation: false,
          passive_style: false,
          passive_severity: 'mild',
          low_engagement: false,
          redirect_to_website: false,
          bad_tone: false,
        },
        recommendations: [],
      },
      [],
    );

    expect(result.checklist[0]?.status).toBe('NO');
    expect(result.score).toBe(0);
  });
});
