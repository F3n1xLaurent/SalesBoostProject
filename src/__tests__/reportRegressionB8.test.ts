import { afterEach, describe, expect, it, vi } from 'vitest';
import { openai } from '../lib/openaiClient';
import { evaluateSessionV2, productPresentationContradiction, type EvaluatorInput } from '../llm/evaluatorV2';
import { CHECKLIST_CODE } from '../logic/diagnosticScoring';
import { buildEvaluationHighlights } from '../logic/evaluationHighlights';
import { getDefaultState } from '../state/defaultState';
import { REPORT_TEST_CHECKS, REPORT_TEST_SCENARIOS } from '../testing/reportTestCatalog';
import { assessReportOutput, parseReportAssessment, type ReportOutput } from '../testing/reportTestEvaluation';
import { DEFAULT_CALL_REPORT_PROBLEMS } from '../voice/problemCatalog';
import { localExampleIssues, parseExampleReviews, reportExampleHash, reviewReportExamples, type ReportExampleTask } from '../voice/reportExampleReview';
import { REPORT_EXAMPLE_ACCEPTANCE_RULES } from '../voice/reportQualityRules';
import { reportGenerationIssues, requestReportJson } from '../voice/reportGeneration';
import { ensureFindingBetterExamples, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';

afterEach(() => vi.restoreAllMocks());
const completion = (data: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }) as any;
const finding = (code: string, quote: string, comment: string, betterExample = '') => ({ problemTitle: DEFAULT_CALL_REPORT_PROBLEMS.find((item) => item.code === code)!.title, importance: 'Важно', quote, comment, betterExample });
const task = (example = 'Здравствуйте! Меня зовут [имя], я менеджер автоцентра «Тест». Да, цена — 6 405 000 рублей, автомобиль есть. Приехать на осмотр можно завтра в 18:00.'): ReportExampleTask => ({ turnIndex: 1, example, problems: [{ id: 'finding:0', code: 'NO_INTRO_COMPANY', title: 'Представление', comment: 'Не представился.' }],
  knownDialog: [{ role: 'client', text: 'Здравствуйте! Можно приехать завтра в 18:00? Цена 6 405 000 рублей?' }, { role: 'manager', text: 'Да, цена 6 405 000 рублей, автомобиль есть.' }], scenarioFacts: 'Автоцентр «Тест». Имя менеджера неизвестно.' });
const grade = (item: ReportExampleTask) => ({ turnIndex: item.turnIndex, exampleHash: reportExampleHash(item.example), checks: [...item.problems.map((problem) => problem.id), 'direct-answer', 'preserves-facts', 'no-invention'].map((id) => ({ id, status: 'pass', reason: 'Подтверждено текущим примером.', evidence: item.example })) });

describe('b8bac984: grader protocol and shared scoped acceptance rules', () => {
  it('uses the same explicit placeholder, mid-dialogue and unknown-property rules for generation and grading', () => {
    expect(REPORT_EXAMPLE_ACCEPTANCE_RULES).toContain('разрешено заменить явным [имя]');
    expect(REPORT_EXAMPLE_ACCEPTANCE_RULES).toContain('не требуют повторного представления посреди разговора');
    expect(REPORT_EXAMPLE_ACCEPTANCE_RULES).toContain('КАЖДОЕ неизвестное условие');
    expect(localExampleIssues(task())).toEqual([]);
    const middle = task('Документы отправлю на этот номер. В какое время вам удобно обсудить их после просмотра?');
    middle.problems = [{ id: 'finding:3', code: 'NO_FOLLOW_UP', title: 'Повторный контакт', comment: 'Не договорился о контакте.' }];
    expect(localExampleIssues(middle)).toEqual([]);
  });
  it('records the exact failing check, returned quote and reason instead of one generic protocol error', () => {
    const data = grade(task()); data.checks[2].evidence = 'Дословной цитаты тут нет.';
    const result = parseExampleReviews([task()], { items: [data] })[0];
    expect(result.status).toBe('review');
    expect(result.validationIssues?.join(' ')).toContain('preserves-facts');
    expect(result.validationIssues?.join(' ')).toContain('Дословной цитаты тут нет.');
    expect(result.checks?.[2].evidence).toBe('Дословной цитаты тут нет.');
  });
  it('repairs invalid evidence once, but never retries a valid red verdict until it becomes green', async () => {
    const invalid = grade(task()); invalid.checks[0].evidence = '';
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(completion({ items: [invalid] })).mockResolvedValueOnce(completion({ items: [grade(task())] }));
    expect((await reviewReportExamples([task()]))[0].status).toBe('pass');
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[0][0].messages)).toContain(REPORT_EXAMPLE_ACCEPTANCE_RULES.replace(/\n/g, '\\n'));
    const red = grade(task()); red.checks[0] = { ...red.checks[0], status: 'fail', reason: 'Не исправлен конкретный дефект.', evidence: '' };
    create.mockClear().mockResolvedValue(completion({ items: [red] }));
    expect((await reviewReportExamples([task()]))[0].status).toBe('fail'); expect(create).toHaveBeenCalledTimes(1);
  });
  it('does not retry a genuine semantic uncertainty or mask repeated invalid evidence', async () => {
    const item = grade(task()); item.checks[0] = { ...item.checks[0], status: 'review', evidence: '', reason: 'Сама находка не обоснована.' };
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion({ items: [item] }));
    expect((await reviewReportExamples([task()]))[0].status).toBe('review'); expect(create).toHaveBeenCalledTimes(1);
    item.checks[0].status = 'pass'; item.checks[0].evidence = 'несуществующий фрагмент'; create.mockClear().mockResolvedValue(completion({ items: [item] }));
    const result = await reviewReportExamples([task()]);
    expect(result[0].status).toBe('review'); expect(create).toHaveBeenCalledTimes(2);
    expect(result[0].validationIssues?.join(' ')).toContain('finding:0');
  });
});

describe('b8bac984: real full-turn defects, not looser test thresholds', () => {
  it('accepts the rejected affordable-offer rewrite without treating the word budget as future information', async () => {
    const fixture = REPORT_TEST_SCENARIOS.find((item) => item.id === 'trainer-brands')!;
    const example = 'Здравствуйте, меня зовут Дмитрий, я менеджер компании «Тест». Из названных вами моделей сейчас подтверждён в наличии Coolray за 2 250 000 рублей — он укладывается в ваш бюджет до 6 500 000 рублей. Наличие Zeekr и Exlantix проверю по складу, по Esteo и Volga пока нет подтверждения. Текущую машину можно оценить для обмена, а по дополнительным услугам возможна выгода до 300 000 рублей; точные условия рассчитаем отдельно. Какая из моделей для вас приоритетна, чтобы я сначала уточнил её наличие и подготовил расчёт?';
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('WEAK_BENEFIT_PRESENTATION', fixture.transcript[1].text, 'Не связал предложение с бюджетом.')] }, { totalScore: 60, transcript: fixture.transcript })!;
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion({ items: [{ index: 0, betterExample: example }] }));
    const result = await ensureFindingBetterExamples(report, fixture.transcript);
    expect(result.dialog[1].betterExample).toBe(example);
    const leaked = example.replace('Дмитрий', 'Алексей');
    const future = [...fixture.transcript, { role: 'client' as const, text: 'Имя моего менеджера Алексей.' }];
    expect(normalizeUnifiedCallReport({ keyFindings: [finding('WEAK_BENEFIT_PRESENTATION', future[1].text, 'Нет привязки.', leaked)] }, { totalScore: 60, transcript: future })!.keyFindings[0].betterExample).toBe('');
  });
  it('rejects a rewrite that preserves all numbers but drops confirmation delivery or weakens booking', async () => {
    const fixture = REPORT_TEST_SCENARIOS.find((item) => item.id === 'call-strong')!;
    const lost = fixture.transcript[1].text.replace('запишу вас', 'можно приехать').replace('Удобно отправить подтверждение на этот номер?', 'Что для вас особенно важно при выборе?');
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('NO_NEEDS_DISCOVERY', fixture.transcript[1].text, 'Не уточнил приоритеты.')] }, { totalScore: 70, transcript: fixture.transcript })!;
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion({ items: [{ index: 0, betterExample: lost }] }));
    const rejections: string[] = [];
    await ensureFindingBetterExamples(report, fixture.transcript, '', {}, (_index, _text, issues) => rejections.push(...issues));
    expect(rejections.join(' ')).toContain('отправка подтверждения');
    expect(rejections.join(' ')).toContain('Запись на осмотр');
    const fixed = fixture.transcript[1].text.replace('Удобно отправить подтверждение на этот номер?', 'Подтверждение отправлю на этот номер. Что для вас особенно важно при выборе?');
    expect(localExampleIssues({ ...task(fixed), knownDialog: fixture.transcript.slice(0, 2), problems: [] })).toEqual([]);
    const equivalent = fixed.replace('запишу вас на осмотр', 'оформлю для вас запись на осмотр');
    expect(localExampleIssues({ ...task(equivalent), knownDialog: fixture.transcript.slice(0, 2), problems: [] })).toEqual([]);
  });
  it('merges the next-step weakness only when the more specific finding already covers the missing visit format', () => {
    const quote = 'Приезжайте, всё расскажем. Когда вам удобно?';
    const evaluation = { checklist: [{ code: 'NEXT_STEP_PROPOSAL', status: 'PARTIAL', evidence: [quote], comment: 'Пригласил, но не предложил конкретный формат визита.' }] };
    const report = (comment: string) => normalizeUnifiedCallReport({ keyFindings: [finding('NO_CONCRETE_NEXT_STEP', quote, comment)] }, { totalScore: 30, transcript: [{ role: 'manager', text: quote }], evaluation })!;
    expect(report('Не предложил конкретный формат визита и не закрепил дату.').weaknesses).toHaveLength(1);
    expect(report('Не закрепил дату визита и не обозначил порядок следующего шага.').weaknesses).toHaveLength(1);
    expect(report('Не закрепил дату и время.').weaknesses).toHaveLength(2); // independent format weakness remains
  });
  it('describes confirmed availability as confirmation, not a question the manager never asked', () => {
    const comment = 'Менеджер подтвердил наличие автомобиля, указанного клиентом: Mercedes-Benz GLE.';
    const output = buildEvaluationHighlights({ checklist: [{ code: 'CAR_IDENTIFICATION', status: 'YES', evidence: ['Есть в наличии.'], comment }] }, 8, [{ role: 'manager', text: 'Здравствуйте, Мария, я Дмитрий, компания «Тест». Есть в наличии.' }]);
    expect(output.strengths).toEqual([comment]); expect(output.strengths[0]).not.toContain('уточнил');
  });
  it('links a priority question to needs discovery in findings and recommendations, not a duplicate request-clarification family', () => {
    const quote = 'Да, цена 6 405 000 рублей, автомобиль есть.';
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('NO_REQUEST_CLARIFICATION', quote, 'Не уточнил, что именно важно проверить при просмотре.')],
      recommendations: [{ problemTitle: 'Не уточнил запрос клиента', text: 'Уточнить, что именно важно проверить при просмотре.' }],
    }, { totalScore: 40, transcript: [{ role: 'manager', text: quote }], evaluation: { checklist: [{ code: 'NEEDS_DISCOVERY', status: 'NO', comment: 'Менеджер не задавал вопросов о потребностях клиента.' }] } })!;
    expect(report.keyFindings[0].problemCode).toBe('NO_NEEDS_DISCOVERY');
    expect(report.recommendations[0].problemCode).toBe('NO_NEEDS_DISCOVERY'); expect(report.weaknesses).toHaveLength(1);
    const modelRequest = normalizeUnifiedCallReport({ keyFindings: [finding('NO_REQUEST_CLARIFICATION', quote, 'Не уточнил приоритетную модель автомобиля.')] }, { totalScore: 40, transcript: [{ role: 'manager', text: quote }] })!;
    expect(modelRequest.keyFindings[0].problemCode).toBe('NO_REQUEST_CLARIFICATION');
  });
  it('regenerates a self-denying factual-error finding, rather than publishing or silently deleting it', async () => {
    const bad = { summary: 'Отчёт.', dialog: [], keyFindings: [finding('PRODUCT_MISINFORMATION', 'Да, автомобиль есть.', 'Фактической ошибки в цене и наличии нет, однако менеджер не назвал автомобиль явно.')] };
    expect(reportGenerationIssues(bad)).toHaveLength(1);
    const good = { ...bad, keyFindings: [finding('PRODUCT_MISINFORMATION', 'У Haval 2020 года пробег 1838 километров.', 'Менеджер вместо GLE сообщил данные другого автомобиля, что противоречит запросу.')] };
    expect(reportGenerationIssues(good)).toEqual([]);
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(completion(bad)).mockResolvedValueOnce(completion(good));
    expect(await requestReportJson({ model: 'mock', messages: [{ role: 'user', content: 'Сформируй отчёт.' }] })).toEqual(good);
    expect(create).toHaveBeenCalledTimes(2); expect(JSON.stringify(create.mock.calls[1][0].messages)).toContain('комментарий явно отрицает фактическую ошибку');
  });
});

describe('b8bac984: correct scoring at the classification boundary, not in report presentation', () => {
  const fixture = REPORT_TEST_SCENARIOS.find((item) => item.id === 'call-strong')!;
  const input = (): EvaluatorInput => ({ dialogHistory: fixture.transcript.map(({ role, text }) => ({ role, content: text })), car: { title: 'GLE', model: 'GLE', year: 2023, price_rub: 6405000 } as any, state: getDefaultState(), earlyFail: false });
  const classification = (status: string) => ({ checklist: CHECKLIST_CODE.map((code) => ({ code, status: code === 'PRODUCT_PRESENTATION' ? status : 'NA', evidence: code === 'PRODUCT_PRESENTATION' && status === 'PARTIAL' ? [fixture.transcript[1].text] : [], comment: 'Недостаточно структуры.' })), extra_signals: { misinformation: false }, recommendations: [] }) as any;
  it('reclassifies an unsupported zero into a grounded partial, then computes the score normally', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(completion(classification('NO'))).mockResolvedValueOnce(completion(classification('PARTIAL')));
    const result = await evaluateSessionV2(input());
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[1][0].messages)).toContain('PRODUCT_PRESENTATION=NO противоречит');
    expect(result.evaluation.checklist.find((item) => item.code === 'PRODUCT_PRESENTATION')?.status).toBe('PARTIAL');
    expect(result.evaluation.dimension_scores.product_and_sales).toBe(50);
  });
  it('does not award points or retry this rule for a wrong price, factual error, empty answer or custom checklist', () => {
    const params = input(), bad = classification('NO');
    expect(productPresentationContradiction(params, bad)).toBe(true);
    const changed = input(); changed.car.price_rub = 2250000;
    expect(productPresentationContradiction(changed, bad)).toBe(false);
    const factual = classification('NO'); factual.extra_signals.misinformation = true;
    expect(productPresentationContradiction(params, factual)).toBe(false);
    const empty = input(); empty.dialogHistory = [{ role: 'manager', content: 'Да нормально всё.' }];
    expect(productPresentationContradiction(empty, bad)).toBe(false);
    expect(productPresentationContradiction({ ...params, evaluationChecklist: { id: 'custom', name: 'custom', items: [{ id: 'PRODUCT_PRESENTATION' } as any] } }, bad)).toBe(false);
  });
});

describe('b8bac984: bounded independent grading with compact, verifiable references', () => {
  const fixture = { ...REPORT_TEST_SCENARIOS[0], checks: REPORT_TEST_CHECKS.map(([id]) => id) };
  const output = (): ReportOutput => ({ transcript: fixture.transcript, evaluation: { overall_score_0_100: 70 }, timings: { evaluationMs: 0, reportMs: 0, totalMs: 0 }, report: normalizeUnifiedCallReport({ summary: 'Краткое резюме отчёта.', keyFindings: [] }, { totalScore: 70, transcript: fixture.transcript })! });
  const valid = (ids: string[]) => ({ checks: ids.map((id) => ({ id, status: 'pass', reason: 'Проверено по конкретному полю.', evaluatedRole: 'manager', turnIndices: [1], references: [{ path: '/report/summary', quote: 'резюме' }] })) });
  it('accepts only literal reference fragments, preserves legacy exact-value references and rejects mixed or forged references', () => {
    const grade = (reference: unknown) => parseReportAssessment({ ...fixture, checks: ['report-summary'] }, output(), { checks: [{ ...valid(['report-summary']).checks[0], references: [reference] }] })[0].status;
    expect(grade({ path: '/report/summary', quote: 'резюме' })).toBe('pass');
    expect(grade({ path: '/report/totalScore', value: 70 })).toBe('pass');
    expect(grade({ path: '/report/summary', quote: 'несуществующая цитата' })).toBe('review');
    expect(grade({ path: '/report/summary', quote: 'резюме', value: 'резюме' })).toBe('review');
    expect(grade({ path: '/report/summary', quote: '' })).toBe('review');
  });
  it('recovers a truncated response in a small batch without losing completed groups or sending rejection history to the independent judge', async () => {
    let first = true;
    const create = vi.spyOn(openai.chat.completions, 'create').mockImplementation((params: any) => {
      const data = JSON.parse(params.messages.at(-1).content);
      expect(data.criteria.length).toBeLessThanOrEqual(6); expect(data.report.exampleReviews).toBeUndefined();
      expect(JSON.stringify(params.messages)).toContain('Для строк');
      if (first) { first = false; return { choices: [{ finish_reason: 'length', message: { content: '{"checks":[' } }] } as any; }
      return completion(valid(data.criteria.map(([id]: string[]) => id)));
    });
    const result = await assessReportOutput(fixture, output(), new AbortController().signal);
    expect(result.length).toBeGreaterThan(12); expect(result.every((item) => item.status === 'pass')).toBe(true);
    expect(create).toHaveBeenCalledTimes(Math.ceil(result.length / 6) + 1);
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
  });
  it('keeps a persistently broken group review without discarding healthy groups', async () => {
    vi.spyOn(openai.chat.completions, 'create').mockImplementation((params: any) => {
      const ids = JSON.parse(params.messages.at(-1).content).criteria.map(([id]: string[]) => id);
      return ids.includes('report-entities') ? completion({ checks: [] }) : completion(valid(ids));
    });
    const result = await assessReportOutput(fixture, output(), new AbortController().signal);
    expect(result.filter((item) => item.status === 'review')).toHaveLength(6);
    expect(result.some((item) => item.status === 'pass')).toBe(true);
  });
  it('does not retry billing errors or issue requests after cancellation', async () => {
    const error = Object.assign(new Error('no balance'), { status: 402 });
    const create = vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(error);
    await expect(assessReportOutput(fixture, output(), new AbortController().signal)).rejects.toBe(error); expect(create).toHaveBeenCalledTimes(1);
    create.mockClear(); const controller = new AbortController(); controller.abort();
    await expect(assessReportOutput(fixture, output(), controller.signal)).rejects.toThrow(); expect(create).not.toHaveBeenCalled();
  });
});
