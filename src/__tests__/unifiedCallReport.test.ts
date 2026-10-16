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

  it('does not attach a better example to a normal manager reply', () => {
    const managerReply = 'Алексей, я вас понимаю. Эта модель даёт больше комфорта в ежедневных поездках.';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 80,
        categories: [],
        keyFindings: [],
        dialog: [{
          role: 'manager',
          text: managerReply,
          mark: 'normal',
          comment: 'Корректная аргументация.',
          betterExample: 'Можно сказать иначе.',
        }],
        recommendations: [],
      },
      { totalScore: 80, transcript: [{ role: 'manager', text: managerReply }] },
    );

    expect(report?.dialog[0]?.betterExample).toBeNull();
  });

  it('adds confirmed findings to weaknesses and lowers a contradictory perfect category', () => {
    const quote = 'Автомобиль комфортный и просторный.';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 100,
        categories: [{ name: 'Продукт', score: 100, comment: 'Не связал преимущества с потребностью клиента.' }],
        weaknesses: [],
        keyFindings: [{
          problemTitle: 'Презентация не структурирована, нет акцента на выгодах',
          importance: 'Важно',
          category: 'Продукт',
          quote,
          comment: 'Менеджер перечислил свойства без связи с задачами клиента.',
          betterExample: 'Для ваших ежедневных поездок просторный салон будет удобнее.',
        }],
      },
      {
        totalScore: 90,
        transcript: [{ role: 'manager', text: quote }],
        dimensionScores: { product_and_sales: 100 },
        evaluation: { checklist: [{ code: 'INTRODUCTION', status: 'YES', comment: 'Выполнено.' }] },
      },
    );

    expect(report?.weaknesses.join(' ')).toContain('Презентация не структурирована');
    expect(report?.categories.find((item) => item.name === 'Продукт')?.score).toBeLessThan(100);
    expect(report?.categories.find((item) => item.name === 'Продукт')?.comment)
      .toBe('Менеджер перечислил свойства без связи с задачами клиента.');
  });

  it('removes an unexplained Можно лучше mark', () => {
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 80,
        categories: [],
        keyFindings: [],
        dialog: [{ role: 'manager', text: 'Да, конечно.', mark: 'normal', comment: '' }],
      },
      { totalScore: 80, transcript: [{ role: 'manager', text: 'Да, конечно.' }] },
    );

    expect(report?.dialog[0]).toMatchObject({ mark: null, comment: null, betterExample: null });
  });

  it('does not teach the manager to use a client fact revealed later', () => {
    const quote = 'У автомобиля просторный салон и мягкая подвеска.';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 70,
        categories: [],
        keyFindings: [{
          problemTitle: 'Презентация не структурирована, нет акцента на выгодах',
          importance: 'Важно',
          category: 'Продукт',
          quote,
          comment: 'Преимущества не связаны с потребностью клиента.',
          betterExample: 'Для ваших поездок за город мягкая подвеска будет особенно удобна.',
        }],
        dialog: [{
          role: 'manager',
          text: quote,
          mark: 'negative',
          comment: 'Презентация не связана с потребностью клиента.',
          betterExample: 'Для ваших поездок за город мягкая подвеска будет особенно удобна.',
        }],
      },
      {
        totalScore: 70,
        transcript: [
          { role: 'manager', text: quote },
          { role: 'client', text: 'Я живу за городом и часто езжу по трассе.' },
        ],
      },
    );

    expect(report?.keyFindings[0]?.betterExample).toBe('');
    expect(report?.dialog[0]?.betterExample).toBeNull();
  });

  it('hides Как лучше when it merely rearranges the original words', () => {
    const quote = 'Автомобиль комфортный и просторный.';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 75,
        categories: [],
        keyFindings: [{
          problemTitle: 'Презентация не структурирована, нет акцента на выгодах',
          importance: 'Средне',
          category: 'Продукт',
          quote,
          comment: 'Не раскрыта польза характеристик для клиента.',
          betterExample: 'Это просторный и комфортный автомобиль.',
        }],
      },
      { totalScore: 75, transcript: [{ role: 'manager', text: quote }] },
    );

    expect(report?.keyFindings[0]?.betterExample).toBe('');
  });

  it('does not keep a perfect category score when its comment contains a concern', () => {
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 100,
        categories: [
          { name: 'Продукт', score: 100, comment: 'Следует лучше связывать характеристики с потребностями.' },
          { name: 'Контакт', score: 100, comment: 'Недостатков не выявлено.' },
        ],
        keyFindings: [],
      },
      { totalScore: 100, transcript: [] },
    );

    expect(report?.categories.find((item) => item.name === 'Продукт')?.score).toBe(95);
    expect(report?.categories.find((item) => item.name === 'Контакт')?.score).toBe(100);
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
