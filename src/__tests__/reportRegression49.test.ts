import { afterEach, describe, expect, it, vi } from 'vitest';
import { openai } from '../lib/openaiClient';
import { CHECKLIST_CODE } from '../logic/diagnosticScoring';
import { collectTranscriptionUncertainties } from '../logic/transcriptionUncertainty';
import { evaluateSessionV2 } from '../llm/evaluatorV2';
import { getDefaultState } from '../state/defaultState';
import { REPORT_TEST_SCENARIOS } from '../testing/reportTestCatalog';
import { REPORT_JUDGE_CALIBRATION, reportCodeChecks } from '../testing/reportTestEvaluation';
import { UNCONFIRMED_NEXT_STEP_TITLE, problemByTitle, DEFAULT_CALL_REPORT_PROBLEMS } from '../voice/problemCatalog';
import { ensureFindingBetterExamples, ensureReportDialogCoverage, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';

afterEach(() => vi.restoreAllMocks());
const completion = (data: unknown) => ({ choices: [{ message: { content: JSON.stringify(data) } }] }) as any;
const finding = (problemTitle: string, quote: string, comment: string, betterExample = '') => ({ problemTitle, quote, comment, betterExample, importance: 'Важно', category: 'Продукт' });

describe('49bdf262: fallback must obey full-turn quality rules', () => {
  it('preserves the real price, conditional benefit, stock and trade-in even when model repair is unavailable', async () => {
    const data = REPORT_TEST_SCENARIOS.find((item) => item.id === 'call-brands')!;
    const report = normalizeUnifiedCallReport({ totalScore: 57, keyFindings: [
      finding('Не уточнил запрос клиента', data.transcript[1].text, 'Не уточнил приоритетную модель.'),
      finding('Не выявил потребности клиента (поверхностные вопросы)', data.transcript[1].text, 'Не уточнил приоритеты.'),
    ] }, { totalScore: 57, transcript: data.transcript })!;
    vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(new Error('simulated provider outage'));
    const repaired = await ensureFindingBetterExamples(report, data.transcript);
    const example = repaired.dialog[1].betterExample!;
    expect(example).toContain('2 250 000 рублей'); expect(example).toContain('до 300 тысяч рублей');
    expect(example).toContain('По Esteo и Volga пока нет подтверждения');
    expect(example).toContain('Текущую машину можно оценить для обмена');
    expect(example.match(/\?/g)).toHaveLength(1);
    expect(example).not.toContain('и что вы хотели');
    expect(repaired.keyFindings.every((item) => item.betterExample === example)).toBe(true);
    expect(report.dialog[1].betterExample).toBeNull();
  });
  it.each(['Какая модель для вас приоритетна и что в ней особенно важно?', 'Подскажите, какой вариант интересует и когда готовы приехать?'])('rejects two clarifications hidden behind a single question mark: %s', (example) => {
    const transcript = [{ role: 'manager' as const, text: 'Давайте обсудим варианты.' }];
    const report = normalizeUnifiedCallReport({ totalScore: 60, keyFindings: [finding('Не уточнил запрос клиента', transcript[0].text, 'Нет уточнения.', example)] }, { totalScore: 60, transcript })!;
    expect(report.keyFindings[0].betterExample).toBe('');
  });
  it('does not reject a single question merely because Подскажите is followed by a comma', () => {
    const transcript = [{ role: 'manager' as const, text: 'Давайте обсудим варианты.' }];
    const example = 'Подскажите, пожалуйста, какая модель для вас приоритетна?';
    expect(normalizeUnifiedCallReport({ totalScore: 60, keyFindings: [finding('Не уточнил запрос клиента', transcript[0].text, 'Нет уточнения.', example)] }, { totalScore: 60, transcript })!.keyFindings[0].betterExample).toBe(example);
  });
});

describe('49bdf262: annotations, factual credit and compact weaknesses', () => {
  it('fills a missing positive comment from grounded manager actions, not a generic placeholder', () => {
    const transcript = [{ role: 'manager' as const, text: 'Здравствуйте, я Дмитрий, компания «Тест». Есть в наличии.' }];
    const evaluation = { checklist: [{ code: 'INTRODUCTION', status: 'YES', evidence: [transcript[0].text], comment: 'Менеджер представился по имени.' }] };
    const report = normalizeUnifiedCallReport({ totalScore: 70, dialog: [{ mark: 'positive', comment: null }] }, { totalScore: 70, transcript, evaluation })!;
    expect(report.dialog[0]).toMatchObject({ mark: 'positive', comment: 'Менеджер представился по имени.' });
  });
  it('repairs remaining missing marks/comments only at the generation boundary', async () => {
    const transcript = [{ role: 'manager' as const, text: 'Спасибо, всего доброго.' }];
    const report = normalizeUnifiedCallReport({ totalScore: 70, dialog: [{ mark: 'positive', comment: null }] }, { totalScore: 70, transcript })!;
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion({ items: [{ index: 0, mark: 'positive', comment: 'Менеджер вежливо попрощался.' }, { index: 99, mark: 'positive', comment: 'Неверный индекс.' }] }));
    const repaired = await ensureReportDialogCoverage(report, transcript);
    expect(create).toHaveBeenCalledTimes(1);
    expect(repaired.dialog[0]).toMatchObject({ mark: 'positive', comment: 'Менеджер вежливо попрощался.' });
    expect(repaired.dialog).toHaveLength(1);
    expect(report.dialog[0].comment).toBeNull();
  });
  it('keeps a missing annotation visibly incomplete on provider failure, never invents a negative mark', async () => {
    const transcript = [{ role: 'manager' as const, text: 'Спасибо, всего доброго.' }];
    const report = normalizeUnifiedCallReport({}, { totalScore: 70, transcript })!;
    vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(new Error('offline'));
    const repaired = await ensureReportDialogCoverage(report, transcript);
    expect(repaired.dialog[0]).toMatchObject({ mark: null, comment: null });
    const fixture = { ...REPORT_TEST_SCENARIOS[0], transcript, checks: ['report-all-turns' as const] };
    expect(reportCodeChecks(fixture, { report: repaired, evaluation: { overall_score_0_100: 70 }, transcript, timings: { evaluationMs: 0, reportMs: 0, totalMs: 0 } })[0].status).toBe('fail');
  });
  it('does not lose a correct price because the turn also has a serious closing/contact weakness', () => {
    const transcript = [{ role: 'manager' as const, text: 'Да, цена 6 405 000 рублей, автомобиль есть.' }];
    const report = normalizeUnifiedCallReport({ totalScore: 0, keyFindings: [finding('Не представился / не назвал компанию', transcript[0].text, 'Не представился.')] }, { totalScore: 0, transcript })!;
    expect(report.strengths.join(' ')).toContain('6 405 000 рублей');
    expect(report.totalScore).toBe(0); // reporting never silently rescales evaluation
  });
  it('uses the weakness title for deduplication and distinguishes an offered slot from confirmed booking', () => {
    const quote = 'Автомобиль есть. На осмотр можно завтра в 18:00.';
    const transcript = [{ role: 'manager' as const, text: quote }];
    const evaluation = { checklist: [
      { code: 'PRODUCT_PRESENTATION', status: 'NO', comment: 'Не представил автомобиль структурированно.' },
      { code: 'DATE_FIXATION', status: 'PARTIAL', evidence: [quote], comment: 'Слот предложен, но визит не подтверждён.' },
      { code: 'FOLLOW_UP_AGREEMENT', status: 'NO', comment: 'Повторный звонок не согласован.' },
    ] };
    const report = normalizeUnifiedCallReport({ totalScore: 60, keyFindings: [
      finding('Презентация не структурирована, нет акцента на выгодах', quote, 'Не представил автомобиль структурированно.'),
      finding('Следующий шаг без конкретики (нет даты/времени)', quote, 'Слот предложен, но визит не подтверждён.'),
    ] }, { totalScore: 60, transcript, evaluation })!;
    expect(report.weaknesses.filter((item) => /Презентация/u.test(item))).toHaveLength(1);
    expect(report.weaknesses.filter((item) => /Слот предложен/u.test(item))).toHaveLength(1);
    expect(report.weaknesses.join(' ')).toContain('Повторный звонок не согласован');
    expect(report.keyFindings[1].problemTitle).toBe(UNCONFIRMED_NEXT_STEP_TITLE);
    expect(problemByTitle(DEFAULT_CALL_REPORT_PROBLEMS, UNCONFIRMED_NEXT_STEP_TITLE)?.code).toBe('NO_CONCRETE_NEXT_STEP');
    expect(normalizeUnifiedCallReport(report, { totalScore: 60, transcript, evaluation })!.keyFindings[1].problemTitle).toBe(UNCONFIRMED_NEXT_STEP_TITLE);
  });
  it('calibrates the judge without declaring missing examples or wrong figures acceptable', () => {
    expect(REPORT_JUDGE_CALIBRATION).toContain('не обязано перечислять все находки');
    expect(REPORT_JUDGE_CALIBRATION).toContain('не обязан дословно повторяться');
    expect(REPORT_JUDGE_CALIBRATION).toContain('корректных действий ИСХОДНОГО ОТВЕТА');
  });
});

describe('49bdf262: uncertain ASR is not misinformation', () => {
  const transcript = [{ role: 'manager' as const, content: 'Здравствуйте, я Дмитрий, компания «Тест». GLE 2023 года, цена 6 405 000 рублей. Последнее обслуживание за 2006 год подтверждено документами.' }];
  const classification = (misinformation: boolean, evidence: string[] = []) => ({ checklist: CHECKLIST_CODE.map((code) => ({ code, status: ['INTRODUCTION', 'SALON_NAME', 'CAR_IDENTIFICATION', 'COMMUNICATION_TONE'].includes(code) ? 'YES' : 'NA', evidence: [transcript[0].content], comment: 'Менеджер представился и назвал сведения.' })), extra_signals: { misinformation, misinformation_evidence: evidence, profanity: false, passive_style: false, low_engagement: false, bad_tone: false }, recommendations: ['Проверить ошибку: обслуживание за 2006 год неверно.'] });
  const input = () => ({ dialogHistory: structuredClone(transcript), car: { year: 2023 } as any, state: getDefaultState(), earlyFail: false });
  it('retains the original wording and flags only the suspicious service year', () => {
    const before = JSON.stringify(transcript);
    const hints = collectTranscriptionUncertainties(transcript, 2023);
    expect(hints).toHaveLength(1); expect(hints[0]).toMatchObject({ turnIndex: 0, token: '2006' });
    expect(collectTranscriptionUncertainties(transcript, 2000)).toEqual([]);
    expect(JSON.stringify(transcript)).toBe(before);
  });
  it('does not apply a misinformation penalty based solely on the disputed year', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(completion(classification(true, ['Последнее обслуживание за 2006 год подтверждено документами.']))).mockResolvedValueOnce(completion(classification(false)));
    const original = input(), before = JSON.stringify(original);
    const result = await evaluateSessionV2(original);
    const control = await evaluateSessionV2(input());
    expect(result.evaluation.overall_score_0_100).toBe(control.evaluation.overall_score_0_100);
    expect(result.evaluation.issues.some((item) => item.issue_type === 'MISINFORMATION')).toBe(false);
    expect(result.evaluation.transcription_uncertainties?.[0].token).toBe('2006');
    expect(result.evaluation.recommendations).toEqual([]);
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.stringify(create.mock.calls[0][0].messages)).toContain('НЕОПРЕДЕЛЁННОСТЬ РАСПОЗНАВАНИЯ');
  });
  it('does not suppress a separately evidenced wrong model just because there is also an ASR warning', async () => {
    const params = input(); params.dialogHistory[0].content += ' У Haval 2020 года пробег 1838 километров.';
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion(classification(true, ['У Haval 2020 года пробег 1838 километров.'])));
    const result = await evaluateSessionV2(params);
    expect(result.evaluation.issues.some((item) => item.issue_type === 'MISINFORMATION')).toBe(true);
    expect(result.evaluation.issues.find((item) => item.issue_type === 'MISINFORMATION')?.evidence).toContain('Haval 2020');
  });
  it('retries a bare misinformation flag instead of silently accepting it or dropping a real error', async () => {
    const params = input(); params.dialogHistory[0].content += ' У Haval 2020 года пробег 1838 километров.';
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(completion(classification(true)))
      .mockResolvedValueOnce(completion(classification(true, ['У Haval 2020 года пробег 1838 километров.'])));
    expect((await evaluateSessionV2(params)).evaluation.issues.some((item) => item.issue_type === 'MISINFORMATION')).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('keeps independently confirmed application-side misinformation even if the model omitted quotes', async () => {
    const params = input(); params.state.fact_context = { ...params.state.fact_context, misinformation_detected: true };
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion(classification(false)));
    expect((await evaluateSessionV2(params)).evaluation.issues.some((item) => item.issue_type === 'MISINFORMATION')).toBe(true);
  });
  it('keeps known independent issues/strengths but moves the disputed date out of negative findings', () => {
    const turns = transcript.map(({ role, content }) => ({ role, text: content }));
    const hints = collectTranscriptionUncertainties(transcript, 2023);
    const report = normalizeUnifiedCallReport({ totalScore: 60, keyFindings: [
      finding('Слабое знание характеристик / фактическая ошибка (дезинформация)', turns[0].text, 'Год обслуживания 2006 противоречит году выпуска; это фактическая ошибка.'),
      finding('Не выявил потребности клиента (поверхностные вопросы)', turns[0].text, 'Не уточнил приоритеты.'),
    ] }, { totalScore: 60, transcript: turns, evaluation: { transcription_uncertainties: hints } })!;
    expect(report.keyFindings).toHaveLength(1);
    expect(report.keyFindings[0].problemTitle).toContain('потребности');
    expect(report.transcriptionUncertainties).toEqual(hints);
    expect(report.dialog[0].text).toContain('2006');
    expect(report.strengths.join(' ')).toContain('6 405 000');
  });
  it('does not lower a category merely because its comment mentions an ASR review', () => {
    const hints = collectTranscriptionUncertainties(transcript, 2023);
    const report = normalizeUnifiedCallReport({ totalScore: 100, categories: [{ name: 'Продукт', comment: 'Год обслуживания 2006 неверный; это ошибка.' }] }, { totalScore: 100, transcript: transcript.map(({ role, content }) => ({ role, text: content })), evaluation: { transcription_uncertainties: hints }, dimensionScores: { product_and_sales: 100 } })!;
    expect(report.categories.find((item) => item.name === 'Продукт')?.score).toBe(100);
  });
  it('does not treat an evasive Всё нормально as proof of misinformation', async () => {
    const params = input(); params.dialogHistory[0].content = 'Да нормально всё.';
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion(classification(true, ['Да нормально всё.'])));
    expect((await evaluateSessionV2(params)).evaluation.issues.some((item) => item.issue_type === 'MISINFORMATION')).toBe(false);
  });
});
