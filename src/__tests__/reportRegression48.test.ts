import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { openai } from '../lib/openaiClient';
import { REPORT_TEST_SCENARIOS } from '../testing/reportTestCatalog';
import { reportCodeChecks } from '../testing/reportTestEvaluation';
import { generateCallAnalyticsBundle } from '../voice/callAnalyticsBundle';
import { DEFAULT_CALL_REPORT_PROBLEMS, FOLLOW_UP_PROBLEM_TITLE, UNCONFIRMED_NEXT_STEP_TITLE, withReportProblemVariants } from '../voice/problemCatalog';
import { localExampleIssues, parseExampleReviews, reportExampleHash, reviewReportExamples, type ReportExampleTask } from '../voice/reportExampleReview';
import { ensureReportExampleQuality, generateUnifiedTrainerReport, normalizeStoredUnifiedCallReport, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';

afterEach(() => vi.restoreAllMocks());
const completion = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) as any;
const finding = (code: string, quote: string, comment: string, betterExample = '') => ({ problemTitle: DEFAULT_CALL_REPORT_PROBLEMS.find((item) => item.code === code)!.title, importance: 'Важно', quote, comment, betterExample });
const basicTask = (): ReportExampleTask => ({ turnIndex: 1, example: 'Проверю наличие автомобиля и сообщу вам подтверждённый ответ.', problems: [{ id: 'finding:0', code: 'NO_DIRECT_ANSWER', title: 'Прямой ответ', comment: 'Не уточнил наличие.' }],
  knownDialog: [{ role: 'client', text: 'Автомобиль есть?' }, { role: 'manager', text: 'Посмотрите на сайте.' }], scenarioFacts: '' });
const passedReview = (task: ReportExampleTask) => ({ turnIndex: task.turnIndex, exampleHash: reportExampleHash(task.example), checks: [...task.problems.map((item) => item.id), 'direct-answer', 'preserves-facts', 'no-invention'].map((id) => ({ id, status: 'pass', evidence: task.example, reason: 'Содержание подтверждено переданной репликой и известными данными.' })) });

describe('48dc0cca: stable issue links, deduplication and authoritative scores', () => {
  it('merges introduction/company labels without losing unrelated weaknesses or separate findings', () => {
    const transcript = [{ role: 'manager' as const, text: 'Да, цена 6 405 000 рублей, автомобиль есть.' }];
    const evaluation = { checklist: [
      { code: 'INTRODUCTION', status: 'NO', comment: 'Не назвал имя.' },
      { code: 'SALON_NAME', status: 'NO', comment: 'Компания не названа.' },
      { code: 'NEEDS_DISCOVERY', status: 'NO', comment: 'Не уточнил приоритет.' },
    ] };
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('NO_INTRO_COMPANY', transcript[0].text, 'Менеджер не представился и не назвал компанию.')] }, { totalScore: 50, transcript, evaluation })!;
    expect(report.weaknesses.filter((text) => /представ|компан/iu.test(text))).toHaveLength(1);
    expect(report.weaknesses.join(' ')).toContain('Выявление потребностей');
    expect(report.keyFindings[0].problemCode).toBe('NO_INTRO_COMPANY');
    expect(report.strengths.join(' ')).toContain('6 405 000');
  });
  it('links a proposed but unconfirmed slot identically in findings and recommendations, including stored reads', () => {
    const transcript = [{ role: 'manager' as const, text: 'На осмотр можно завтра в 18:00.' }];
    const oldTitle = DEFAULT_CALL_REPORT_PROBLEMS.find((item) => item.code === 'NO_CONCRETE_NEXT_STEP')!.title;
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('NO_CONCRETE_NEXT_STEP', transcript[0].text, 'Детали визита не закреплены.')], recommendations: [{ problemTitle: oldTitle, text: 'Закрепить детали визита.' }] }, { totalScore: 65, transcript })!;
    for (const result of [report, normalizeStoredUnifiedCallReport(report, { totalScore: 65, transcript })!]) {
      expect(result.keyFindings[0]).toMatchObject({ problemCode: 'NO_CONCRETE_NEXT_STEP', problemTitle: UNCONFIRMED_NEXT_STEP_TITLE });
      expect(result.recommendations[0]).toMatchObject({ problemCode: 'NO_CONCRETE_NEXT_STEP', problemTitle: UNCONFIRMED_NEXT_STEP_TITLE });
    }
  });
  it('separates missing document follow-up from global passive style and does not penalize communication a second time', () => {
    const transcript = [{ role: 'manager' as const, text: 'Отправлю документы на этот номер. Если возникнут вопросы, звоните, я Дмитрий.' }];
    const evaluation = { dimension_scores: { communication: 100 }, checklist: [{ code: 'FOLLOW_UP_AGREEMENT', status: 'NO', comment: 'Повторный контакт не согласован.' }] };
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('PASSIVE_STYLE', transcript[0].text, 'Не согласовал повторный контакт после отправки документов.')], recommendations: [{ problemTitle: 'Пассивный стиль, низкая вовлечённость', text: 'Согласовать повторный контакт после отправки документов.' }] }, { totalScore: 60, transcript, evaluation })!;
    expect(report.keyFindings[0]).toMatchObject({ problemCode: 'NO_FOLLOW_UP', problemTitle: FOLLOW_UP_PROBLEM_TITLE, category: 'Закрытие' });
    expect(report.recommendations[0].problemTitle).toBe(FOLLOW_UP_PROBLEM_TITLE);
    expect(report.weaknesses.filter((text) => /контакт/iu.test(text))).toHaveLength(1);
    expect(report.categories.find((item) => item.name === 'Коммуникация')?.score).toBe(100);
    expect(report.totalScore).toBe(60);
    const control = normalizeUnifiedCallReport({ keyFindings: [finding('PASSIVE_STYLE', transcript[0].text, 'На протяжении беседы не развивал ответы клиента.')] }, { totalScore: 60, transcript })!;
    expect(control.keyFindings[0].problemCode).toBe('PASSIVE_STYLE');
    expect(withReportProblemVariants(DEFAULT_CALL_REPORT_PROBLEMS).some((item) => item.code === 'NO_FOLLOW_UP')).toBe(true);
    expect(DEFAULT_CALL_REPORT_PROBLEMS.some((item) => item.code === 'NO_FOLLOW_UP')).toBe(false);
  });
  it('credits a literal invitation without calling it confirmed booking', () => {
    const transcript = [{ role: 'manager' as const, text: 'Приезжайте, всё расскажем. Когда вам удобно?' }];
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('NO_DIRECT_ANSWER', transcript[0].text, 'Не ответил об ограничениях датчиков.')] }, { totalScore: 10, transcript, evaluation: { checklist: [] } })!;
    expect(report.strengths.join(' ')).toContain('предложил визит');
    expect(report.strengths.join(' ')).toContain('не подтверждает согласование');
    expect(report.dialog[0].mark).toBe('negative');
  });
  it('does not treat generic address/contact actions as leaked future facts', () => {
    const fixture = REPORT_TEST_SCENARIOS.find((item) => item.id === 'trainer-closing')!;
    const example = 'Здравствуйте, меня зовут [имя], компания «Тест». Да, цена 6 405 000 рублей, автомобиль есть. Завтра в 18:00 можно приехать на осмотр, адрес и контакт для связи направлю на этот номер.';
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('NO_INTRO_COMPANY', fixture.transcript[1].text, 'Не представился.', example)] }, { totalScore: 40, transcript: fixture.transcript })!;
    expect(report.dialog[1].betterExample).toBe(example);
    const leaked = example.replace('Здравствуйте', 'Мария, здравствуйте'); // name is only learned later
    expect(normalizeUnifiedCallReport({ keyFindings: [finding('NO_INTRO_COMPANY', fixture.transcript[1].text, 'Не представился.', leaked)] }, { totalScore: 40, transcript: fixture.transcript })!.dialog[1].betterExample).toBeNull();
  });
});

describe('48dc0cca: per-problem semantic evidence validation', () => {
  it('requires every problem and every common check, an exact candidate hash and literal evidence', () => {
    const task = basicTask(); task.problems.push({ ...task.problems[0], id: 'finding:1' });
    const grade = (item: unknown) => parseExampleReviews([task], { items: [item] })[0];
    expect(grade(passedReview(task)).status).toBe('pass');
    expect(grade({ ...passedReview(task), status: 'pass', checks: [] }).status).toBe('review');
    expect(grade({ ...passedReview(task), exampleHash: reportExampleHash('другой текст') }).status).toBe('review');
    expect(grade({ ...passedReview(task), checks: passedReview(task).checks.slice(1) }).status).toBe('review');
    const fake = passedReview(task); fake.checks[0].evidence = 'Вымышленная цитата';
    expect(grade(fake).status).toBe('review');
    expect(parseExampleReviews([task], { items: [passedReview(task), passedReview(task)] })[0].status).toBe('review');
  });
  it('allows a concrete missing-element failure without a fabricated quote', () => {
    const task = basicTask(), review = passedReview(task);
    review.checks[0] = { ...review.checks[0], status: 'fail', evidence: '', reason: 'Не ответил на вопрос о наличии.' };
    const result = parseExampleReviews([task], { items: [review] })[0];
    expect(result.status).toBe('fail'); expect(result.issues.join(' ')).toContain('finding:0');
  });
  it('requires both manager name and company, not only one or client name', () => {
    const task = basicTask(); task.problems[0].code = 'NO_INTRO_COMPANY';
    task.example = 'Мария, здравствуйте! Компания «Тест». Проверю наличие.';
    expect(localExampleIssues(task).join(' ')).toContain('имя менеджера');
    task.example = 'Меня зовут Дмитрий. Проверю наличие.';
    expect(localExampleIssues(task).join(' ')).toContain('компания');
    task.example = 'Здравствуйте, меня зовут [имя], компания «Тест». Проверю наличие.';
    expect(localExampleIssues(task)).toEqual([]);
    task.example = 'Здравствуйте, я Дмитрий из компании «Тест». Проверю наличие.';
    expect(localExampleIssues(task)).toEqual([]);
    task.example = 'Меня зовут [имя], я менеджер ООО «Тестовый салон». Проверю наличие.';
    expect(localExampleIssues(task)).toEqual([]);
  });
  it('does not let a generic promise mask missing snow/rain/dirt/warranty answers', () => {
    const task = basicTask(); task.knownDialog[0].text = 'Как работают датчики в снег, дождь, при загрязнении? Что с гарантией?';
    task.example = 'Проверим доступную информацию по работе систем и сообщим подтверждённые условия гарантии.';
    expect(localExampleIssues(task)).toHaveLength(3);
    task.example = 'Уточню ограничения датчиков в снег, дождь и при загрязнении, а также условия гарантии и сообщу подтверждённый ответ.';
    expect(localExampleIssues(task)).toEqual([]);
  });
  it('records a grader outage as review, never as a passing example', async () => {
    vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(new Error('simulated outage'));
    expect((await reviewReportExamples([basicTask()]))[0]).toMatchObject({ status: 'review', issues: [expect.stringContaining('недоступна')] });
  });
  it('propagates access and billing errors instead of hiding them as semantic success', async () => {
    const error = Object.assign(new Error('no balance'), { status: 402 });
    vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(error);
    await expect(reviewReportExamples([basicTask()])).rejects.toBe(error);
  });
});

describe('48dc0cca: generation repair loop and persisted review metadata', () => {
  const task = basicTask();
  const transcript = task.knownDialog;
  const initialExample = 'Давайте обсудим удобное время визита.';
  const report = () => normalizeUnifiedCallReport({ keyFindings: [finding('NO_DIRECT_ANSWER', transcript[1].text, 'Не подтвердил наличие.', initialExample)] }, { totalScore: 50, transcript })!;
  it('repairs a structurally valid but incomplete example using exact semantic feedback', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockImplementation((params: any) => {
      const request = JSON.parse(params.messages.at(-1).content.startsWith('{') ? params.messages.at(-1).content : '{}');
      if (request.items?.[0]?.requiredCheckIds) {
        const results = request.items.map((item: ReportExampleTask) => {
          const review = passedReview(item);
          if (item.example === initialExample) review.checks[0] = { ...review.checks[0], status: 'fail', evidence: '', reason: 'Сначала дайте подтверждённый ответ о наличии, не приглашение.' };
          return review;
        });
        return completion({ items: results });
      }
      expect(JSON.stringify(params.messages)).toContain('Сначала дайте подтверждённый ответ о наличии');
      return completion({ items: [{ index: 0, betterExample: task.example }] });
    });
    const result = await ensureReportExampleQuality(report(), transcript);
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.dialog[1].betterExample).toBe(task.example);
    expect(result.keyFindings[0].betterExample).toBe(task.example);
    expect(result.exampleReviews?.[0]).toMatchObject({ status: 'pass', exampleHash: reportExampleHash(task.example), rejectedCandidates: [{ text: initialExample, issues: [expect.stringContaining('Сначала дайте')] }] });
    expect(result.dialog.map(({ role, text }) => ({ role, text }))).toEqual(transcript);
  });
  it('does not publish or restore an unrepaired failed example, or regrade unchanged text until it passes', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockImplementation((params: any) => {
      const content = params.messages.at(-1).content;
      if (content.startsWith('{')) {
        const item = JSON.parse(content).items[0], review = passedReview(item);
        review.checks[0] = { ...review.checks[0], status: 'fail', evidence: '', reason: 'Прямого ответа по-прежнему нет.' };
        return completion({ items: [review] });
      }
      return completion({ items: [{ index: 0, betterExample: initialExample }] });
    });
    const result = await ensureReportExampleQuality(report(), transcript);
    expect(create).toHaveBeenCalledTimes(2); // unchanged rejected text is not re-lotteried
    expect(result.dialog[1].betterExample).toBeNull(); expect(result.keyFindings[0].betterExample).toBe('');
    expect(result.exampleReviews?.[0].status).toBe('fail');
    const stored = normalizeStoredUnifiedCallReport(result, { totalScore: 50, transcript })!;
    expect(stored.dialog[1].betterExample).toBeNull(); expect(stored.keyFindings[0].betterExample).toBe('');
    expect(stored.exampleReviews?.[0].rejectedCandidates?.[0].text).toBe(initialExample);
    expect(create).toHaveBeenCalledTimes(2); // reading does not make provider requests
  });
  it('carries all rejected candidates and their feedback into subsequent repairs instead of oscillating', async () => {
    const intermediate = 'Проверю наличие автомобиля и сообщу ответ до визита.';
    let repairs = 0;
    vi.spyOn(openai.chat.completions, 'create').mockImplementation((params: any) => {
      const content = params.messages.at(-1).content;
      if (content.startsWith('{')) {
        const item = JSON.parse(content).items[0], review = passedReview(item);
        const reason = item.example === initialExample ? 'Не ответил о наличии.' : item.example === intermediate ? 'Нужен подтверждённый ответ.' : null;
        if (reason) review.checks[0] = { ...review.checks[0], status: 'fail', evidence: '', reason };
        return completion({ items: [review] });
      }
      repairs++;
      if (repairs === 2) {
        expect(content).toContain(initialExample);
        expect(content).toContain(intermediate);
        expect(content).toContain('Не ответил о наличии.');
        expect(content).toContain('Нужен подтверждённый ответ.');
      }
      return completion({ items: [{ index: 0, betterExample: repairs === 1 ? intermediate : task.example }] });
    });
    const result = await ensureReportExampleQuality(report(), transcript);
    expect(repairs).toBe(2);
    expect(result.exampleReviews?.[0].status).toBe('pass');
    expect(result.exampleReviews?.[0].rejectedCandidates).toHaveLength(2);
  });
  it('does not trust model-provided review metadata and invalidates a stored pass for edited text', () => {
    const raw = report(); raw.exampleReviews = [{ turnIndex: 1, status: 'pass', exampleHash: reportExampleHash('other candidate'), issues: [] }];
    expect(normalizeUnifiedCallReport(raw, { totalScore: 50, transcript })!.exampleReviews).toBeUndefined();
    expect(normalizeStoredUnifiedCallReport(raw, { totalScore: 50, transcript })!.exampleReviews?.[0].status).toBe('review');
  });
  it('gates completeness by the exact reviewed example, not a nonempty fallback', () => {
    const fixture = { ...REPORT_TEST_SCENARIOS[0], transcript, checks: ['report-all-problems' as const] };
    const output = { report: report(), evaluation: { overall_score_0_100: 50 }, transcript, timings: { evaluationMs: 0, reportMs: 0, totalMs: 0 } };
    expect(reportCodeChecks(fixture, output)[0].status).toBe('review');
    output.report.exampleReviews = [{ turnIndex: 1, status: 'pass', exampleHash: reportExampleHash(initialExample), issues: [] }];
    expect(reportCodeChecks(fixture, output)[0].status).toBe('pass');
    output.report.dialog[1].betterExample = 'Изменённый и ещё не проверенный текст.';
    expect(reportCodeChecks(fixture, output)[0].status).toBe('review');
    output.report.exampleReviews[0].status = 'fail'; output.report.exampleReviews[0].issues = ['Не исправлена вторая проблема.'];
    expect(reportCodeChecks(fixture, output)[0].status).toBe('fail');
  });
  it.each(['call', 'trainer'] as const)('uses the semantic gate in the actual %s generator', async (source) => {
    vi.spyOn(prisma.callReportProblem, 'findMany').mockResolvedValue(DEFAULT_CALL_REPORT_PROBLEMS as any);
    vi.spyOn(openai.chat.completions, 'create').mockImplementation((params: any) => {
      const content = params.messages.at(-1).content;
      if (content.startsWith('{')) return completion({ items: JSON.parse(content).items.map(passedReview) });
      return completion({ summary: 'Менеджер не подтвердил наличие.', dialog: [], keyFindings: [finding('NO_DIRECT_ANSWER', transcript[1].text, 'Не подтвердил наличие.', task.example)] });
    });
    const input = { totalScore: 50, transcript, evaluation: { checklist: [], recommendations: [] } };
    const result = source === 'trainer' ? await generateUnifiedTrainerReport(input) : (await generateCallAnalyticsBundle({ ...input, outcome: 'completed' })).unifiedCallReport!;
    expect(result.source).toBe(source);
    expect(result.exampleReviews?.[0]).toMatchObject({ status: 'pass', exampleHash: reportExampleHash(task.example) });
  });
});


describe('call 809 coaching validation', () => {
  it('allows an open needs question even if a later client answer also uses the word important', () => {
    const transcript = [{ role: 'client' as const, text: 'Предложение по Porsche Cayenne актуально?' }, { role: 'manager' as const, text: 'Да, предложение актуально.' }, { role: 'client' as const, text: 'Понимаю, для меня важно ездить с детьми. Нужно точное время.' }];
    const example = 'Понимаю ваш вопрос. Да, предложение актуально. Точные условия уточню. Подскажите, что для вас особенно важно при выборе?';
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('NO_NEEDS_DISCOVERY', transcript[1].text, 'Не уточнил потребности.', example)] }, { totalScore: 52, transcript })!;
    expect(report.keyFindings[0].betterExample).toBe(example);
    const leaked = normalizeUnifiedCallReport({ keyFindings: [finding('NO_NEEDS_DISCOVERY', transcript[1].text, 'Не уточнил потребности.', 'Да, предложение актуально. Для поездок с детьми этот вариант подходит.')] }, { totalScore: 52, transcript })!;
    expect(leaked.keyFindings[0].betterExample).toBe('');
  });
});
