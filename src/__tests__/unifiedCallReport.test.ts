import { afterEach, describe, expect, it, vi } from 'vitest';
import { openai } from '../lib/openaiClient';
import {
  ensureFindingBetterExamples,
  ensureRecommendationFindingCoverage,
  normalizeUnifiedCallReport,
} from '../voice/unifiedCallReport';

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

  it('keeps distinct manager errors from the same reply as separate findings', () => {
    const quote = 'Niva Chevrolet отлично подходит для бездорожья. В дороге не подведёт.';
    const report = normalizeUnifiedCallReport({
      totalScore: 60,
      keyFindings: [
        {
          problemTitle: 'Слабое знание характеристик / фактическая ошибка (дезинформация)',
          importance: 'Важно', category: 'Продукт', quote,
          comment: 'Менеджер назвал Niva Chevrolet вместо LADA Niva Legend.',
          betterExample: 'Правильно понимаю, речь идёт о LADA Niva Legend?',
        },
        {
          problemTitle: 'Презентация не структурирована, нет акцента на выгодах',
          importance: 'Важно', category: 'Продукт', quote,
          comment: 'Менеджер не раскрыл возможности автомобиля для бездорожья.',
          betterExample: 'Уточню ваши условия эксплуатации и расскажу о подходящих возможностях автомобиля.',
        },
      ],
    }, {
      totalScore: 60,
      transcript: [{ role: 'manager', text: quote }],
    });

    expect(report?.keyFindings).toHaveLength(2);
    expect(report?.keyFindings.map((item) => item.problemTitle)).toEqual([
      'Слабое знание характеристик / фактическая ошибка (дезинформация)',
      'Презентация не структурирована, нет акцента на выгодах',
    ]);
  });

  it('supports a dedicated finding when the manager uses the wrong client name', () => {
    const quote = 'Завтра в девятнадцать часов, Василий, мы вас будем ожидать.';
    const report = normalizeUnifiedCallReport({
      totalScore: 75,
      keyFindings: [{
        problemTitle: 'Перепутал имя клиента',
        importance: 'Важно', category: 'Коммуникация', quote,
        comment: 'Менеджер назвал Андрея Василием.',
        betterExample: 'Спасибо, Андрей. Будем ждать вас завтра в девятнадцать часов.',
      }],
    }, {
      totalScore: 75,
      transcript: [
        { role: 'client', text: 'Меня зовут Андрей.' },
        { role: 'manager', text: quote },
      ],
    });

    expect(report?.keyFindings).toHaveLength(1);
    expect(report?.keyFindings[0]).toMatchObject({
      problemTitle: 'Перепутал имя клиента',
      category: 'Коммуникация',
    });
    expect(report?.dialog[1]).toMatchObject({ mark: 'negative' });
  });

  it('repairs a catalog problem present in recommendations but missing from key findings', async () => {
    const quote = 'Niva Chevrolet отлично подходит для бездорожья.';
    const report = normalizeUnifiedCallReport({
      totalScore: 70,
      summary: 'Менеджер назвал модель иначе, чем клиент.',
      categories: [{
        name: 'Продукт', score: 50,
        comment: 'Менеджер назвал Niva Chevrolet вместо LADA Niva Legend.',
      }],
      keyFindings: [],
      recommendations: [{
        text: 'Сверять название модели с запросом клиента.',
        category: 'Продукт',
        problemTitle: 'Слабое знание характеристик / фактическая ошибка (дезинформация)',
      }],
    }, {
      totalScore: 70,
      source: 'trainer',
      transcript: [
        { role: 'client', text: 'Звоню по LADA Niva Legend.' },
        { role: 'manager', text: quote },
      ],
    });
    expect(report).not.toBeNull();
    const categoryScoresBeforeRepair = report!.categories.map(({ name, score }) => ({ name, score }));

    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            keyFindings: [{
              problemTitle: 'Слабое знание характеристик / фактическая ошибка (дезинформация)',
              importance: 'Важно',
              category: 'Продукт',
              quote,
              comment: 'Менеджер назвал другую модель автомобиля.',
              betterExample: 'Правильно понимаю, речь идёт о LADA Niva Legend?',
            }],
          }),
        },
      }],
    } as any);

    const repaired = await ensureRecommendationFindingCoverage(report!, [
      { role: 'client', text: 'Звоню по LADA Niva Legend.' },
      { role: 'manager', text: quote },
    ]);

    expect(repaired.keyFindings).toHaveLength(1);
    expect(repaired.keyFindings[0]).toMatchObject({
      problemTitle: 'Слабое знание характеристик / фактическая ошибка (дезинформация)',
      quote,
    });
    expect(repaired.dialog[1]).toMatchObject({ mark: 'negative' });
    expect(repaired.categories.map(({ name, score }) => ({ name, score })))
      .toEqual(categoryScoresBeforeRepair);
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

  it('rebuilds stored report weaknesses with custom checklist titles on read', () => {
    const criterionId = 'f349f657-9f7f-4cfd-8d1a-43de145b4516';
    const report = normalizeUnifiedCallReport(
      { totalScore: 45, categories: [], weaknesses: [`${criterionId}: Не уточнил запрос.`] },
      {
        totalScore: 45,
        transcript: [{ role: 'manager', text: 'Добрый день.' }],
        evaluation: {
          checklist_definition: { items: [{ id: criterionId, title: 'Идентификация запроса клиента' }] },
          checklist: [{ code: criterionId, status: 'NO', comment: 'Не уточнил запрос клиента.' }],
        },
      },
    );

    expect(report?.weaknesses).toEqual(['Идентификация запроса клиента: Не уточнил запрос клиента.']);
    expect(JSON.stringify(report?.weaknesses)).not.toContain(criterionId);
  });

  it('does not build strengths from checklist evidence on a negatively marked dialog turn', () => {
    const quote = 'Добрый день, меня зовут Анна, компания «Сальса».';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 45,
        categories: [],
        keyFindings: [],
        dialog: [{ role: 'manager', text: quote, mark: 'negative', comment: 'Менеджер не ответил на вопрос клиента.' }],
      },
      {
        totalScore: 45,
        transcript: [{ role: 'manager', text: quote }],
        evaluation: {
          checklist: [
            { code: 'INTRODUCTION', status: 'YES', evidence: [`Менеджер: ${quote}`], comment: 'Менеджер поздоровался.' },
            { code: 'SALON_NAME', status: 'YES', evidence: [`Менеджер: ${quote}`], comment: 'Менеджер назвал компанию.' },
          ],
        },
      },
    );

    expect(report?.dialog[0]?.mark).toBe('negative');
    expect(report?.strengths).toEqual([]);
  });

  it('keeps checklist strengths evidenced by a positively marked dialog turn', () => {
    const quote = 'Добрый день, меня зовут Анна.';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 85,
        categories: [],
        keyFindings: [],
        dialog: [{ role: 'manager', text: quote, mark: 'positive', comment: 'Менеджер поздоровался и представился.' }],
      },
      {
        totalScore: 85,
        transcript: [{ role: 'manager', text: quote }],
        evaluation: {
          checklist: [{
            code: 'INTRODUCTION', status: 'YES', evidence: [`Менеджер: ${quote}`], comment: 'Менеджер поздоровался и представился.',
          }],
        },
      },
    );

    expect(report?.strengths).toContain('Менеджер поздоровался и представился.');
  });

  it('does not let a short positive fragment validate evidence from a negative turn', () => {
    const negativeQuote = 'Добрый день, меня зовут Анна, я представляю компанию «Сальса».';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 45,
        categories: [],
        keyFindings: [],
        dialog: [
          { role: 'manager', text: negativeQuote, mark: 'negative', comment: 'Не ответил на вопрос.' },
          { role: 'manager', text: 'Анна.', mark: 'positive', comment: 'Менеджер повторил имя.' },
        ],
      },
      {
        totalScore: 45,
        transcript: [
          { role: 'manager', text: negativeQuote },
          { role: 'manager', text: 'Анна.' },
        ],
        evaluation: {
          checklist: [{
            code: 'INTRODUCTION', status: 'YES', evidence: [`Менеджер: ${negativeQuote}`], comment: 'Менеджер поздоровался и представился.',
          }],
        },
      },
    );

    expect(report?.strengths).not.toContain('Менеджер поздоровался и представился.');
  });

  it('does not accept ambiguous evidence repeated in positive and negative turns', () => {
    const repeatedQuote = 'Добрый день, меня зовут Анна.';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 45,
        categories: [],
        keyFindings: [],
        dialog: [
          { role: 'manager', text: repeatedQuote, mark: 'negative', comment: 'Не ответил на вопрос клиента.' },
          { role: 'manager', text: repeatedQuote, mark: 'positive', comment: 'Менеджер представился.' },
        ],
      },
      {
        totalScore: 45,
        transcript: [
          { role: 'manager', text: repeatedQuote },
          { role: 'manager', text: repeatedQuote },
        ],
        evaluation: {
          checklist: [{
            code: 'INTRODUCTION',
            status: 'YES',
            evidence: [`Менеджер: ${repeatedQuote}`],
            comment: 'Менеджер поздоровался и представился.',
          }],
        },
      },
    );

    expect(report?.strengths).not.toContain('Менеджер поздоровался и представился.');
  });

  it('deduplicates semantically equivalent findings and checklist weaknesses', () => {
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 40,
        categories: [],
        keyFindings: [
          {
            problemTitle: 'Не уточнил запрос клиента',
            importance: 'Важно',
            category: 'Диагностика',
            quote: 'Предлагаю приехать к нам завтра.',
            comment: 'Менеджер не уточнил, какой именно автомобиль интересует клиента.',
            betterExample: 'Какой именно автомобиль вас интересует?',
          },
          {
            problemTitle: 'Презентация не структурирована, нет акцента на выгодах',
            importance: 'Важно',
            category: 'Продукт',
            quote: 'Пробег небольшой.',
            comment: 'Менеджер не связал характеристики с потребностями клиента.',
            betterExample: 'Для ваших поездок небольшой пробег снижает будущие расходы.',
          },
          {
            problemTitle: 'Не предложил следующий шаг',
            importance: 'Важно',
            category: 'Закрытие',
            quote: 'Запишите мой номер.',
            comment: 'Менеджер не согласовал конкретный последующий контакт.',
            betterExample: 'Давайте созвонимся завтра в 12:00.',
          },
        ],
      },
      {
        totalScore: 40,
        transcript: [
          { role: 'manager', text: 'Предлагаю приехать к нам завтра.' },
          { role: 'manager', text: 'Пробег небольшой.' },
          { role: 'manager', text: 'Запишите мой номер.' },
        ],
        evaluation: {
          checklist: [
            { code: 'CAR_IDENTIFICATION', status: 'NO', comment: 'Менеджер не уточнил модель автомобиля.' },
            { code: 'NEEDS_DISCOVERY', status: 'PARTIAL', comment: 'Менеджер выяснил только часть потребностей.' },
            { code: 'PRODUCT_PRESENTATION', status: 'NO', comment: 'Не было структурированной презентации.' },
            { code: 'FOLLOW_UP_AGREEMENT', status: 'NO', comment: 'Конкретный повторный контакт не согласован.' },
          ],
        },
      },
    );

    expect(report?.weaknesses).toEqual([
      'Не уточнил запрос клиента: Менеджер не уточнил, какой именно автомобиль интересует клиента.',
      'Презентация не структурирована, нет акцента на выгодах: Менеджер не связал характеристики с потребностями клиента.',
      'Не предложил следующий шаг: Менеджер не согласовал конкретный последующий контакт.',
      'Выявление потребностей: В стенограмме нет подтверждающей реплики менеджера.',
    ]);
  });

  it('uses one grammatical gender for the manager throughout the report', () => {
    const intro = 'Добрый день, меня зовут Анна.';
    const credit = 'Кредит возможен без первоначального взноса на семь лет.';
    const report = normalizeUnifiedCallReport(
      {
        totalScore: 80,
        summary: 'Менеджер представилась и предложила обсудить условия. Менеджер спросила, клиентка ответила утвердительно. Менеджер уточнила условия, затем менеджер согласовала встречу. Менеджер озвучила решение, компания сообщила о сроках.',
        categories: [{ name: 'Контакт', score: 80, comment: 'Менеджер поздоровалась и назвала своё имя.' }],
        dialog: [
          { role: 'manager', text: intro, mark: 'positive', comment: 'Менеджер представилась по имени.' },
          { role: 'manager', text: credit, mark: 'positive', comment: 'Менеджер ответила на вопрос.' },
        ],
        recommendations: [{ text: 'Менеджер должна была уточнить срок.', category: 'Продукт' }],
      },
      {
        totalScore: 80,
        transcript: [
          { role: 'manager', text: intro },
          { role: 'manager', text: credit },
        ],
        evaluation: {
          checklist: [
            { code: 'INTRODUCTION', status: 'YES', evidence: [intro], comment: 'Менеджер представилась по имени.' },
            {
              code: 'CREDIT_EXPLANATION',
              status: 'YES',
              evidence: [credit],
              comment: 'Менеджер ответила на вопрос, подтвердила возможность займа и назвала срок.',
            },
          ],
        },
      },
    );

    const visibleText = JSON.stringify(report);
    expect(visibleText).toContain('Менеджер представился по имени.');
    expect(visibleText).toContain('Менеджер ответил на вопрос, подтвердил возможность займа и назвал срок.');
    expect(report?.summary).toContain('Менеджер спросил, клиентка ответила утвердительно.');
    expect(report?.summary).toContain('Менеджер уточнил условия, затем менеджер согласовал встречу.');
    expect(report?.summary).toContain('Менеджер озвучил решение, компания сообщила о сроках.');
    expect(visibleText).not.toMatch(/представилась|предложила|поздоровалась|назвала|подтвердила|уточнила|согласовала|озвучила|должна/u);
  });
});
