import { afterEach, describe, expect, it, vi } from 'vitest';
import { openai } from '../lib/openaiClient';
import { ensureFindingBetterExamples, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('deduplicates two findings on one manager reply and aligns its mark with the finding', () => {
    const quote = 'Автомобиль прошёл проверку, всё хорошо.';
    const report = normalizeUnifiedCallReport({
      totalScore: 65,
      keyFindings: [
        {
          problemTitle: 'Презентация не структурирована, нет акцента на выгодах',
          importance: 'Важно', category: 'Продукт', quote,
          comment: 'Менеджер не объяснил, что проверяли.',
          betterExample: 'Проверка включает диагностику двигателя и ходовой части.',
        },
        {
          problemTitle: 'Ушёл от вопроса клиента / не дал прямого ответа',
          importance: 'Средне', category: 'Продукт', quote: 'всё хорошо.',
          comment: 'Не перечислил выполненные работы.',
          betterExample: 'Проверка включает диагностику двигателя и ходовой части.',
        },
      ],
      dialog: [
        { role: 'client', text: 'Что входит в проверку?', mark: null },
        { role: 'manager', text: quote, mark: 'positive', comment: 'Хорошая презентация.' },
      ],
    }, { totalScore: 65, transcript: [
      { role: 'client', text: 'Что входит в проверку?' },
      { role: 'manager', text: quote },
    ] });

    expect(report?.keyFindings).toHaveLength(1);
    expect(report?.dialog[1]).toMatchObject({
      mark: 'negative', comment: 'Менеджер не объяснил, что проверяли.',
    });
  });

  it('does not create a negative finding or mark from visibly broken ASR', () => {
    const quote = 'для вас ха-- актуально';
    const report = normalizeUnifiedCallReport({
      totalScore: 70,
      keyFindings: [{
        problemTitle: 'Ушёл от вопроса клиента / не дал прямого ответа',
        importance: 'Важно', category: 'Продукт', quote,
        comment: 'Менеджер ушёл от ответа.', betterExample: 'Я уточню информацию.',
      }],
      dialog: [{ role: 'manager', text: quote, mark: 'negative', comment: 'Плохой ответ.' }],
    }, { totalScore: 70, transcript: [{ role: 'manager', text: quote }] });

    expect(report?.keyFindings).toEqual([]);
    expect(report?.dialog[0]).toMatchObject({ mark: null, comment: null, betterExample: null });
  });

  it('does not mark every repeated identical manager phrase as a negative finding', () => {
    const quote = 'Автомобиль прошёл проверку.';
    const transcript = [
      { role: 'manager' as const, text: quote },
      { role: 'client' as const, text: 'Что именно проверяли?' },
      { role: 'manager' as const, text: quote },
    ];
    const report = normalizeUnifiedCallReport({
      totalScore: 70,
      keyFindings: [{
        problemTitle: 'Ушёл от вопроса клиента / не дал прямого ответа',
        importance: 'Важно', category: 'Продукт', quote,
        comment: 'Не ответил на вопрос о составе проверки.',
        betterExample: 'Я уточню состав проверки и перечислю выполненные работы.',
      }],
      dialog: [
        { role: 'manager', text: quote, mark: 'positive', comment: 'Менеджер подтвердил проверку.' },
        { role: 'client', text: 'Что именно проверяли?' },
        { role: 'manager', text: quote, mark: 'negative', comment: 'Не ответил на вопрос.' },
      ],
    }, { totalScore: 70, transcript });

    expect(report?.dialog.map((line) => line.mark)).toEqual(['positive', null, 'negative']);
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

  it('regenerates a missing Как лучше example from the context known at the quoted reply', async () => {
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
      {
        totalScore: 75,
        transcript: [
          { role: 'client', text: 'Мне важен комфорт в ежедневных поездках.' },
          { role: 'manager', text: quote },
        ],
      },
    );
    expect(report?.keyFindings[0]?.betterExample).toBe('');
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            items: [{
              index: 0,
              betterExample: 'Для ваших ежедневных поездок просторный салон сделает дорогу комфортнее.',
            }],
          }),
        },
      }],
    } as any);

    const repaired = await ensureFindingBetterExamples(report!, [
      { role: 'client', text: 'Мне важен комфорт в ежедневных поездках.' },
      { role: 'manager', text: quote },
    ]);

    expect(repaired.keyFindings[0]?.betterExample)
      .toBe('Для ваших ежедневных поездок просторный салон сделает дорогу комфортнее.');
  });

  it('uses a safe problem fallback when regenerated Как лучше examples are rejected', async () => {
    const quote = 'Да, предложение актуально. Чем я могу вам помочь?';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 60,
        categories: [],
        keyFindings: [{
          problemTitle: 'Не выявил потребности клиента (поверхностные вопросы)',
          importance: 'Важно',
          category: 'Диагностика',
          quote,
          comment: 'Менеджер не задал вопросов о потребностях клиента.',
          betterExample: '',
        }],
      },
      { totalScore: 60, transcript: [{ role: 'manager', text: quote }] },
    );
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        items: [{ index: 0, betterExample: 'Предложение актуально. Чем я могу вам помочь?' }],
      }) } }],
    } as any);

    const repaired = await ensureFindingBetterExamples(report!, [{ role: 'manager', text: quote }]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(repaired.keyFindings[0]?.betterExample)
      .toBe('Подскажите, пожалуйста, что для вас особенно важно при выборе?');
  });

  it('does not replace a direct question about inspection works with a counter-question', async () => {
    const transcript = [
      { role: 'client' as const, text: 'Что входит в проверку автомобиля?' },
      { role: 'manager' as const, text: 'Машина прошла проверку.' },
    ];
    const report = normalizeUnifiedCallReport({
      totalScore: 65,
      keyFindings: [{
        problemTitle: 'Презентация не структурирована, нет акцента на выгодах',
        importance: 'Важно',
        category: 'Продукт',
        quote: transcript[1].text,
        comment: 'Не рассказал, что входит в проверку.',
        betterExample: 'Что для вас важнее всего?',
      }],
    }, { totalScore: 65, transcript });
    expect(report?.keyFindings[0]?.betterExample).toBe('');

    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ items: [{
        index: 0, betterExample: 'Проверка включает диагностику двигателя и ходовой части.',
      }] }) } }],
    } as any);
    const repaired = await ensureFindingBetterExamples(report!, transcript,
      'Проверка: диагностика двигателя и ходовой части.');
    expect(repaired.keyFindings[0]?.betterExample)
      .toBe('Проверка включает диагностику двигателя и ходовой части.');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        content: expect.stringContaining('диагностика двигателя и ходовой части'),
      })]),
    }));
  });

  it('rejects a multi-sentence deflection instead of an answer about inspection works', async () => {
    const transcript = [
      { role: 'client' as const, text: 'Что входит в проверку автомобиля?' },
      { role: 'manager' as const, text: 'Машина прошла проверку.' },
    ];
    const finding = {
      problemTitle: 'Презентация не структурирована, нет акцента на выгодах',
      importance: 'Важно',
      category: 'Продукт',
      quote: transcript[1].text,
      comment: 'Не рассказал, что входит в проверку.',
    };
    const report = normalizeUnifiedCallReport({
      totalScore: 65,
      keyFindings: [{
        ...finding,
        betterExample: 'Давайте уточним ваши задачи. Что для вас важнее всего?',
      }],
    }, { totalScore: 65, transcript });
    expect(report?.keyFindings[0]?.betterExample).toBe('');

    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ items: [{
        index: 0,
        betterExample: 'Проверка включает диагностику двигателя и ходовой части.',
      }] }) } }],
    } as any);
    const repaired = await ensureFindingBetterExamples(report!, transcript,
      'Проверка: диагностика двигателя и ходовой части.');
    expect(repaired.keyFindings[0]?.betterExample)
      .toBe('Проверка включает диагностику двигателя и ходовой части.');

    const statementOnly = normalizeUnifiedCallReport({
      totalScore: 65,
      keyFindings: [{ ...finding, betterExample: 'Давайте уточним ваши задачи.' }],
    }, { totalScore: 65, transcript });
    expect(statementOnly?.keyFindings[0]?.betterExample).toBe('');
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
