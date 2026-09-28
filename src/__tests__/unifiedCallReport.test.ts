import { describe, expect, it } from 'vitest';
import { normalizeUnifiedCallReport } from '../voice/unifiedCallReport';

describe('unified call report normalization', () => {
  it('uses calculated trainer scores and falls back to evaluator recommendations', () => {
    const report = normalizeUnifiedCallReport(
      {
        version: 'call-report-v1',
        source: 'trainer',
        summary: 'Менеджер провёл разговор отлично.',
        totalScore: 100,
        categories: [
          { name: 'Контакт', score: 100, comment: 'Отлично' },
          { name: 'Диагностика', score: 100, comment: 'Отлично' },
          { name: 'Продукт', score: 100, comment: 'Отлично' },
          { name: 'Закрытие', score: 100, comment: 'Отлично' },
          { name: 'Коммуникация', score: 100, comment: 'Отлично' },
        ],
        strengths: [],
        weaknesses: [],
        keyFindings: [],
        dialog: [],
        recommendations: [],
      },
      {
        totalScore: 37,
        source: 'trainer',
        transcript: [{ role: 'manager', text: 'Здравствуйте' }],
        dimensionScores: {
          first_contact: 13,
          product_and_sales: 32,
          closing_commitment: 78,
          communication: 100,
        },
        evaluation: {
          checklist: [
            { code: 'INTRODUCTION', status: 'NO', comment: 'Менеджер не представился.' },
          ],
          recommendations: ['Представляться по имени в начале разговора.'],
        },
      },
    );

    expect(report).not.toBeNull();
    expect(report?.totalScore).toBe(37);
    expect(report?.verdict).toBe('Плохо');
    expect(report?.summary).toContain('требует существенной доработки');
    expect(report?.categories.map(({ name, score }) => ({ name, score }))).toEqual([
      { name: 'Контакт', score: 13 },
      { name: 'Диагностика', score: 37 },
      { name: 'Продукт', score: 32 },
      { name: 'Закрытие', score: 78 },
      { name: 'Коммуникация', score: 100 },
    ]);
    expect(report?.recommendations).toEqual([
      {
        text: 'Представляться по имени в начале разговора.',
        category: 'Коммуникация',
        problemTitle: null,
      },
    ]);
  });

  it('supports stored recommendation objects as a fallback', () => {
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 42,
        categories: [],
        recommendations: [],
      },
      {
        totalScore: 42,
        transcript: [],
        recommendations: [{ title: 'Отработать выявление потребностей.' }],
      },
    );

    expect(report?.recommendations[0]?.text).toBe('Отработать выявление потребностей.');
  });

  it('uses company wording in key findings while preserving verbatim quotes', () => {
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 50,
        categories: [],
        keyFindings: [{
          problemTitle: 'Не представился / не назвал компанию',
          importance: 'Важно',
          category: 'Контакт',
          quote: 'Добрый день, автосалон на Ленина.',
          comment: 'Менеджер не назвал название автосалона.',
          betterExample: 'Здравствуйте, это [название автосалона].',
        }],
        recommendations: [],
      },
      {
        totalScore: 50,
        transcript: [{ role: 'manager', text: 'Добрый день, автосалон на Ленина.' }],
      },
    );

    expect(report?.keyFindings[0]).toMatchObject({
      quote: 'Добрый день, автосалон на Ленина.',
      comment: 'Менеджер не назвал название компании.',
      betterExample: 'Здравствуйте, это [название компании].',
    });
  });

  it('aligns a client-request finding title with its description instead of client name', () => {
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 50,
        categories: [],
        keyFindings: [{
          problemTitle: 'Не уточнил / не подтвердил имя клиента',
          importance: 'Важно',
          category: 'Контакт',
          quote: 'Менеджер не уточнил, какой именно автомобиль интересует клиента.',
          comment: 'Необходимо уточнить запрос клиента.',
          betterExample: 'Какой автомобиль вас интересует?',
        }],
        recommendations: [],
      },
      { totalScore: 50, transcript: [] },
    );

    expect(report?.keyFindings[0]).toMatchObject({
      problemTitle: 'Не уточнил запрос клиента',
      category: 'Диагностика',
    });
  });

  it('removes a false client-name finding when the manager asked how to address the client', () => {
    const managerQuestion = 'Подскажите, как я могу к вам обращаться?';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 54,
        categories: [],
        keyFindings: [{
          problemTitle: 'Не уточнил / не подтвердил имя клиента',
          importance: 'Важно',
          category: 'Контакт',
          quote: managerQuestion,
          comment: 'Менеджер не уточнил имя клиента.',
          betterExample: "Менеджер должен был спросить: 'Как вас зовут?'",
        }],
        dialog: [{
          role: 'manager',
          text: managerQuestion,
          mark: 'normal',
          comment: 'Менеджер уточнил, как обращаться к клиенту.',
          betterExample: "Менеджер должен был спросить: 'Как вас зовут?'",
        }],
        recommendations: [],
      },
      {
        totalScore: 54,
        transcript: [
          { role: 'manager', text: managerQuestion },
          { role: 'client', text: 'Меня можно звать Алексей.' },
        ],
      },
    );

    expect(report?.keyFindings).toEqual([]);
    expect(report?.dialog[0]).toMatchObject({
      mark: 'positive',
      comment: 'Менеджер уточнил имя клиента.',
      betterExample: null,
    });
  });

  it('anchors an incomplete introduction finding to the opening manager line', () => {
    const opening = 'Да, добрый день. В наличии есть. Подскажите, что вас интересует?';
    const unrelatedLaterLine = 'Этот автомобиль прошёл юридическую проверку и диагностику.';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 43,
        source: 'trainer',
        categories: [],
        keyFindings: [{
          problemTitle: 'Не представился / не назвал компанию',
          importance: 'Важно',
          category: 'Контакт',
          quote: unrelatedLaterLine,
          comment: 'Менеджер не назвал компанию.',
          betterExample: 'Здравствуйте, это [название компании].',
        }],
        recommendations: [],
      },
      {
        totalScore: 43,
        source: 'trainer',
        transcript: [
          { role: 'client', text: 'Здравствуйте, подскажите по автомобилю.' },
          { role: 'manager', text: opening },
          { role: 'manager', text: unrelatedLaterLine },
        ],
      },
    );

    expect(report?.keyFindings[0]?.quote).toBe(opening);
  });

  it('keeps IVR lines visible without shifting live-dialog analytics onto them', () => {
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 80,
        categories: [],
        keyFindings: [],
        recommendations: [],
        dialog: [
          { role: 'manager', text: 'Здравствуйте, Анна меня зовут.', mark: 'positive', comment: 'Менеджер представился.' },
          { role: 'client', text: 'Здравствуйте, подскажите стоимость.', mark: null, comment: null },
        ],
      },
      {
        totalScore: 80,
        transcript: [
          { role: 'manager', text: 'Добро пожаловать в компанию. Дождитесь ответа оператора.' },
          { role: 'client', text: 'Хорошо, подожду.' },
          { role: 'manager', text: 'Здравствуйте, Анна меня зовут.' },
          { role: 'client', text: 'Здравствуйте, подскажите стоимость.' },
        ],
      },
    );

    expect(report?.dialog).toHaveLength(4);
    expect(report?.dialog[0]).toMatchObject({
      text: 'Добро пожаловать в компанию. Дождитесь ответа оператора.',
      mark: null,
      comment: null,
    });
    expect(report?.dialog[2]).toMatchObject({
      text: 'Здравствуйте, Анна меня зовут.',
      mark: 'positive',
      comment: 'Менеджер представился.',
    });
  });
});
