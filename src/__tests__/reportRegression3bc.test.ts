import { afterEach, describe, expect, it, vi } from 'vitest';
import { openai } from '../lib/openaiClient';
import { evaluateSessionV2 } from '../llm/evaluatorV2';
import { getDefaultState } from '../state/defaultState';
import { REPORT_TEST_SCENARIOS } from '../testing/reportTestCatalog';
import { ensureFindingBetterExamples, finalizeGeneratedReport, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';
import { requestReportJson } from '../voice/reportGeneration';

afterEach(() => vi.restoreAllMocks());
const fixture = REPORT_TEST_SCENARIOS.find((item) => item.id === 'call-strong')!;
const quote = fixture.transcript[1].text;
const needs = 'Не выявил потребности клиента (поверхностные вопросы)';
const product = 'Презентация не структурирована, нет акцента на выгодах';
const classification = { overall_score_0_100: 76, checklist: [
  { code: 'INTRODUCTION', status: 'YES', evidence: ['Автоцентр «Тест», меня зовут Дмитрий.'], comment: 'Менеджер представился по имени.' },
  { code: 'SALON_NAME', status: 'YES', evidence: ['Автоцентр «Тест», меня зовут Дмитрий.'], comment: 'Менеджер назвал компанию.' },
  { code: 'NEXT_STEP_PROPOSAL', status: 'YES', evidence: ['Завтра в 18:00 запишу вас на осмотр по адресу Тестовая, 10.'], comment: 'Менеджер предложил осмотр.' },
  { code: 'NEEDS_DISCOVERY', status: 'NO', evidence: [], comment: 'Менеджер не задал вопросов о потребностях.' },
] };
function strongReport() {
  return normalizeUnifiedCallReport({
    totalScore: 76, summary: 'Сообщил только цену.',
    keyFindings: [
      { problemTitle: needs, importance: 'Важно', quote, comment: 'Менеджер не выяснил приоритеты клиента.', betterExample: 'Что для вас особенно важно?' },
      { problemTitle: product, importance: 'Средне', quote, comment: 'Не связал свойства с задачами клиента.', betterExample: 'Расскажу подробнее о машине.' },
    ],
    dialog: fixture.transcript.map((turn, index) => ({ ...turn, mark: turn.role === 'manager' ? index === 1 ? 'negative' : 'positive' : null, comment: index === 1 ? 'Не уточнил приоритеты.' : 'Менеджер подтвердил визит.' })),
  }, { totalScore: 76, transcript: fixture.transcript, evaluation: classification })!;
}
const improved = quote.replace('Удобно отправить подтверждение на этот номер?', 'Подтверждение отправлю на этот номер. Что для вас особенно важно при выборе автомобиля?');
const completion = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) as any;

describe('report regression 3bc8ef34: real normalizer/repair with mocked model responses', () => {
  it('does not erase demonstrated actions because of one omission; deduplicates needs weaknesses', () => {
    const report = strongReport();
    expect(report.dialog[1].mark).toBe('normal');
    expect(report.dialog[1].comment).toContain('Выполнено:');
    expect(report.dialog[1].comment).toContain('не выяснил приоритеты');
    expect(report.strengths).toContain('Менеджер назвал компанию.');
    expect(report.weaknesses.filter((item) => /потребност|приоритет/u.test(item))).toHaveLength(1);
    expect(report.keyFindings).toHaveLength(2);
    // Conflicting fragments are not presented as valid full replacements.
    expect(report.keyFindings.every((finding) => finding.betterExample === '')).toBe(true);
  });
  it('repairs all problems of one turn together, preserves numbers and updates all blocks atomically', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion({ items: [{ index: 0, betterExample: improved }] }));
    const report = await ensureFindingBetterExamples(strongReport(), fixture.transcript);
    expect(create).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(create.mock.calls[0][0].messages);
    expect(prompt).toContain(needs); expect(prompt).toContain(product);
    expect(prompt).not.toContain(fixture.transcript[2].text);
    expect(report.keyFindings.map((finding) => finding.betterExample)).toEqual([improved, improved]);
    expect(report.dialog[1].betterExample).toBe(improved);
    expect(report.dialog[1].mark).toBe('normal');
    expect(normalizeUnifiedCallReport(report, { totalScore: 76, transcript: fixture.transcript, evaluation: classification })?.keyFindings).toHaveLength(2);
  });
  it('rejects a generic question that drops the correct price, benefit and time; then accepts a full reply', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create')
      .mockResolvedValueOnce(completion({ items: [{ index: 0, betterExample: 'Что для вас особенно важно при выборе?' }] }))
      .mockResolvedValueOnce(completion({ items: [{ index: 0, betterExample: improved }] }));
    const report = await ensureFindingBetterExamples(strongReport(), fixture.transcript);
    expect(create).toHaveBeenCalledTimes(2);
    expect(report.dialog[1].betterExample).toContain('6 405 000');
    expect(report.dialog[1].betterExample).toContain('до 300 тысяч');
    expect(report.dialog[1].betterExample).toContain('18:00');
  });
  it('accepts equivalent number notation but does not turn a conditional benefit into a guaranteed discount', async () => {
    const equivalent = improved.replace('до 300 тысяч рублей', 'до 300 000 рублей');
    const create = vi.spyOn(openai.chat.completions, 'create')
      .mockResolvedValueOnce(completion({ items: [{ index: 0, betterExample: equivalent.replace('до 300 000', '300 000') }] }))
      .mockResolvedValueOnce(completion({ items: [{ index: 0, betterExample: equivalent }] }));
    const report = await ensureFindingBetterExamples(strongReport(), fixture.transcript);
    expect(create).toHaveBeenCalledTimes(2);
    expect(report.dialog[1].betterExample).toBe(equivalent);
  });
  it('keeps different name/model errors even when they share the same full corrected answer', () => {
    const data = REPORT_TEST_SCENARIOS.find((item) => item.id === 'call-changes')!;
    const betterExample = 'Мария, извините: речь о Mercedes-Benz GLE 2023 года с пробегом 18 000 километров. Проверю историю обслуживания и пришлю подтверждённые документы.';
    const report = normalizeUnifiedCallReport({ totalScore: 30, keyFindings: [
      { problemTitle: 'Перепутал имя клиента', quote: data.transcript[3].text, comment: 'Назвал Марию Анной.', betterExample },
      { problemTitle: 'Слабое знание характеристик / фактическая ошибка (дезинформация)', quote: data.transcript[3].text, comment: 'Назвал Haval 2020 вместо GLE 2023.', betterExample },
    ] }, { totalScore: 30, transcript: data.transcript })!;
    expect(report.keyFindings).toHaveLength(2);
    expect(report.keyFindings.every((finding) => finding.betterExample === betterExample)).toBe(true);
    expect(report.dialog[3].mark).toBe('negative');
  });
  it('builds the new summary from final grounded highlights and prioritises unanswered questions', () => {
    const report = strongReport();
    report.keyFindings.push({ ...report.keyFindings[0], problemTitle: 'Ушёл от вопроса клиента / не дал прямого ответа', comment: 'Не ответил о гарантии.' });
    const final = finalizeGeneratedReport(report);
    expect(final.summary).toContain('76/100');
    expect(final.summary).toContain('Менеджер назвал компанию');
    expect(final.summary).toContain('Не ответил о гарантии');
    expect(final.summary).not.toContain('только цену');
    expect(report.summary).toBe('Сообщил только цену.'); // source not mutated
  });
  it('repairs normal turns even without a catalog finding', async () => {
    const transcript = [{ role: 'client' as const, text: 'Какие есть условия обмена?' }, { role: 'manager' as const, text: 'Обмен возможен.' }];
    const report = normalizeUnifiedCallReport({ totalScore: 60, keyFindings: [], dialog: [null, { mark: 'normal', comment: 'Не объяснил порядок оценки.' }] }, { totalScore: 60, transcript })!;
    const example = 'Обмен возможен. Для оценки нужно осмотреть вашу машину; после оценки обсудим доплату.';
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion({ items: [{ index: 1, betterExample: example }] }));
    const result = await ensureFindingBetterExamples(report, transcript);
    expect(result.dialog[1].betterExample).toBe(example);
  });
});

describe('report regression 3bc8ef34: provider failures are not manager mistakes', () => {
  const params = { model: 'gpt-5.4', messages: [{ role: 'user' as const, content: 'test' }] };
  const valid = { summary: 'Готово', dialog: [], keyFindings: [] };
  it('retries empty/length-limited JSON with a larger visible+reasoning budget', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create')
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: '' } }] } as any)
      .mockResolvedValueOnce(completion(valid));
    await expect(requestReportJson(params)).resolves.toEqual(valid);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.4', max_completion_tokens: 10000 });
    expect(create.mock.calls[1][0]).toMatchObject({ model: 'gpt-5.4', max_completion_tokens: 16000 });
  });
  it('does not publish incomplete JSON after both attempts', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion({ summary: 'Только итог без диалога' }));
    await expect(requestReportJson(params)).rejects.toThrow('complete JSON');
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('preserves HTTP 402 without retrying or fabricating a report', async () => {
    const error = Object.assign(new Error('402 status code (no body)'), { status: 402 });
    const create = vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(error);
    await expect(requestReportJson(params)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
    create.mockClear();
    await expect(evaluateSessionV2({ dialogHistory: [], car: {} as any, state: getDefaultState(), earlyFail: false })).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
