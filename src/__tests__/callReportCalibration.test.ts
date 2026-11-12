import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureFindingBetterExamples, normalizeStoredUnifiedCallReport, normalizeUnifiedCallReport, reportExampleStructuralIssues, requireCompleteReportExamples } from '../voice/unifiedCallReport';
import { localExampleIssues, reportExampleHash } from '../voice/reportExampleReview';
import { checklistCategoryScores, clientAction, confirmedTimeInDialog, deduplicateReportStrengths, reportCriterionCode } from '../voice/reportAssessment';
import { collectTranscriptionUncertainties, isUncertainFactClaim } from '../logic/transcriptionUncertainty';
import { computeCustomChecklistResult, evaluateSessionV2 } from '../llm/evaluatorV2';
import { getDefaultState } from '../state/defaultState';
import { openai } from '../lib/openaiClient';
afterEach(() => vi.restoreAllMocks());
const manager = (text: string) => ({ role: 'manager' as const, text });
const client = (text: string) => ({ role: 'client' as const, text });

describe('production call report calibration', () => {
  it('1147: accepts a natural named introduction before independent semantic review', () => {
    const task = { turnIndex: 0, example: 'Добрый день, Дмитрий! Это Алина [фамилия], эксперт по автомобилям EXEED в «МореАвто», официальном дилере EXEED.',
      problems: [{ id: 'finding:0', code: 'NO_INTRO_COMPANY', title: 'Представление', comment: 'Не назвал фамилию и роль.' }],
      knownDialog: [manager('Алина. Добрый день, Дмитрий. Мориавто, официальный дилер Exeed.')], scenarioFacts: '' };
    expect(localExampleIssues(task)).toEqual([]);
    expect(localExampleIssues({ ...task, example: 'Дмитрий, здравствуйте, автосалон «МореАвто».' }).join(' ')).toContain('имя менеджера');
    expect(localExampleIssues({ ...task, example: 'Это Алина [фамилия], эксперт по автомобилям.' }).join(' ')).toContain('компания');
  });
  it('1147: corrects an explicitly wrong address using scenario evidence without changing other numbers', () => {
    const original = 'Ждём вас сегодня в 16 часов по адресу Московский проспект, 271. На этот номер могу отправить СМС с адресом.';
    const transcript = [client('Приеду сегодня в 16 часов.'), manager(original)];
    const context = 'Адрес ДЦ: Московский проспект, 250А.';
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Следующий шаг без конкретики (нет даты/времени)', quote: original,
      comment: 'Назван неверный адрес, не закреплена цель визита.' }], dialog: [{}, { mark: 'normal' }] }, { totalScore: 70, transcript })!;
    const corrected = 'Ждём вас сегодня в 16 часов на тест-драйв по адресу Московский проспект, 250А. На этот номер отправлю СМС с адресом.';
    expect(reportExampleStructuralIssues(corrected, 1, report, transcript, context)).toEqual([]);
    expect(reportExampleStructuralIssues(corrected.replace('250А', '999'), 1, report, transcript, context).join(' ')).toContain('271');
    expect(reportExampleStructuralIssues(corrected.replace('16 часов', '17 часов'), 1, report, transcript, context).join(' ')).toContain('16');
    expect(reportExampleStructuralIssues(corrected, 1, report, transcript, '').join(' ')).toContain('271');
  });
  it.each(['Не знаю, автомат или механика.', 'Автоматическая коробка? Уточню позже.', 'Возможно, установлен автомат.'])('does not treat %s as a grounded useful answer', answer => {
    const transcript = [client('Какая коробка передач?'), manager(answer)];
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Ушёл от вопроса клиента / не дал прямого ответа',
      quote: answer, comment: 'Не дал содержательного ответа.', importance: 'Важно' }], dialog: [{}, { mark: 'normal' }] }, { totalScore: 60, transcript })!;
    expect(report.keyFindings[0].problemTitle).toBe('Ушёл от вопроса клиента / не дал прямого ответа');
    expect(report.dialog[1].mark).toBe('negative');
  });
  it('retains a known transmission answer when only its finer detail is unknown', () => {
    const transcript = [client('Какая коробка передач?'), manager('Установлен автомат, но число ступеней не знаю.')];
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Ушёл от вопроса клиента / не дал прямого ответа',
      quote: transcript[1].text, comment: 'Не указал число ступеней.', importance: 'Важно' }] }, { totalScore: 60, transcript })!;
    expect(report.dialog[1].mark).toBe('normal');
  });
  it('does not restore a reviewed example onto a client turn or a changed manager quote', () => {
    const example = 'Что для вас важнее при выборе первой машины?';
    const source = { dialog: [{ role: 'manager', text: 'Расскажи.', mark: 'normal', comment: 'Вопрос общий.', betterExample: example }, {}],
      exampleReviews: [{ turnIndex: 0, exampleHash: reportExampleHash(example), status: 'pass', issues: [] }] };
    const clientTurn = normalizeStoredUnifiedCallReport(source, { totalScore: 60, transcript: [client('Расскажи.'), client('Моя первая машина.')] })!;
    expect(clientTurn.dialog[0].betterExample).toBeNull();
    const changed = normalizeStoredUnifiedCallReport(source, { totalScore: 60, transcript: [manager('Сколько лет водите?'), client('Это первая машина.')] })!;
    expect(changed.dialog[0].betterExample).toBeNull();
    expect(changed.exampleReviews?.[0].status).toBe('review');
  });
  it.each(['normal', 'negative'])("1193/1196: an incomplete useful parking answer stays normal despite raw mark %s", mark => {
    const transcript = [client('Это первая машина, габариты большие?'), manager('Это среднеразмерный внедорожник, парковаться поможет система автоматической парковки.')];
    const report = normalizeUnifiedCallReport({ dialog: [{}, { mark, comment: 'Ответ полезный, но нет длины и ширины.' }], keyFindings: [{
      problemTitle: 'Ушёл от вопроса клиента / не дал прямого ответа', importance: 'Критично',
      quote: transcript[1].text, comment: 'Ответил про парковку, но не назвал длину и ширину.',
    }] }, { totalScore: 66, transcript })!;
    expect(report.dialog[1].mark).toBe('normal');
    expect(report.keyFindings[0].problemTitle).toBe('Недостаточно подробно ответил на вопрос');
    expect(report.totalScore).toBe(66);
  });
  it('1196: does not claim the company was omitted when only the rest of the introduction is missing', () => {
    const transcript = [manager('Добрый день, автосалон Море Авто, меня зовут Оля.')];
    const evaluation = { checklist_definition: { items: [{ id: 'intro', title: 'Представление', instruction: 'Назвать компанию, имя и фамилию, представиться экспертом.', category: 'Контакт', points: 10 }] } };
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Не представился / не назвал компанию', quote: transcript[0].text,
      comment: 'Менеджер назвал название компании и имя, но не назвал фамилию и не представился экспертом.' }] }, { totalScore: 66, transcript, evaluation })!;
    expect(report.keyFindings[0].problemTitle).toBe('Неполное представление');
    expect(normalizeUnifiedCallReport(report, { totalScore: 66, transcript, evaluation })!.keyFindings[0].problemTitle).toBe('Неполное представление');
  });
  it('1196: a wrong name does not erase a useful answer about transmission', () => {
    const transcript = [client('Меня зовут Максим. Какая коробка?'), manager('Ну, Илья, установлен автомат. Удобен для новичка.')];
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Перепутал имя клиента', quote: transcript[1].text, importance: 'Критично', comment: 'Перепутал имя клиента.' }],
      dialog: [{}, { mark: 'negative', comment: 'Коробка названа, имя перепутано.' }] }, { totalScore: 66, transcript })!;
    expect(report.dialog[1].mark).toBe('normal');
  });
  it('1196: preserves a reviewed example when a read lacks the original persona context', () => {
    const transcript = [client('Смотрю автомобиль для города.'), manager('Расскажи.'), client('Это моя первая машина.')];
    const example = 'Что для вас важнее при выборе первой машины — удобство парковки или комфорт?';
    const source = { dialog: [{}, { mark: 'normal', comment: 'Вопрос слишком общий.', betterExample: example }, {}],
      exampleReviews: [{ turnIndex: 1, exampleHash: reportExampleHash(example), status: 'pass', issues: [] }] };
    expect(normalizeUnifiedCallReport(source, { totalScore: 60, transcript })!.dialog[1].betterExample).toBeNull();
    expect(normalizeStoredUnifiedCallReport(source, { totalScore: 60, transcript })!.dialog[1].betterExample).toBe(example);
    const changed = { ...source, dialog: [{}, { ...source.dialog[1], betterExample: `${example} У вас двое детей.` }, {}] };
    expect(normalizeStoredUnifiedCallReport(changed, { totalScore: 60, transcript })!.exampleReviews?.[0].status).toBe('review');
  });
  it('1196: common connecting words are not treated as facts from the future', () => {
    const transcript = [manager('Расскажи.'), client('После этого обсудим автомобиль.')];
    const example = 'Что для вас важнее? После ответа предложу подходящий вариант.';
    expect(normalizeUnifiedCallReport({ dialog: [{ mark: 'normal', comment: 'Нужно конкретное уточнение.', betterExample: example }, {}] },
      { totalScore: 60, transcript })!.dialog[0].betterExample).toBe(example);
  });
  it('merges paraphrased repeated strengths without dropping independent actions', () => {
    expect(deduplicateReportStrengths(['Менеджер представился по имени.', 'Менеджер назвал компанию.',
      'Менеджер поздоровался и представился, назвал компанию.', 'Менеджер предложил визит.'])).toEqual([
      'Менеджер представился по имени.', 'Менеджер назвал компанию.', 'Менеджер предложил визит.',
    ]);
  });
  it('864: does not mistake a connective word for a borrowed future fact', () => {
    const transcript = [client('Какие габариты автомобиля?'), manager('Это среднеразмерный автомобиль.'), client('Хочу, чтобы было удобно с детьми.')];
    const report = normalizeUnifiedCallReport({ dialog: [{}, { mark: 'normal', comment: 'Нужно уточнить габариты.', betterExample: 'Это среднеразмерный автомобиль. Точные габариты проверю по спецификации, чтобы сообщить вам достоверные данные.' }, {}] }, { totalScore: 70, transcript })!;
    expect(report.dialog[1].betterExample).toContain('чтобы сообщить');
    const unsafe = normalizeUnifiedCallReport({ dialog: [{}, { mark: 'normal', comment: 'Нужно уточнить габариты.', betterExample: 'Это среднеразмерный автомобиль. Детям будет удобно.' }, {}] }, { totalScore: 70, transcript })!;
    expect(unsafe.dialog[1].betterExample).toBeNull();
  });
  it('does not let invented coaching facts inside comments become repair requirements', () => {
    const report = normalizeUnifiedCallReport({ dialog: [{ mark: 'normal', comment: 'Не назвал габариты. Можно лучше: «Длина 4775 мм, ширина 1890 мм».' }] }, { totalScore: 60, transcript: [manager('Это среднеразмерный автомобиль.')] })!;
    expect(report.dialog[0].comment).toBe('Не назвал габариты.');
  });
  it('does not convert a conditional inapplicable criterion into a failure due to a legacy default flag', () => {
    const result = computeCustomChecklistResult([
      { id: 'intro', title: 'Представление менеджера', instruction: 'Назвать имя', category: 'Контакт', points: 40, allowNa: false },
      { id: 'objection', title: 'Работа с возражениями', instruction: 'Проверь, обработал ли менеджер возражения, если клиент высказывал возражения.', category: 'Аргументация', points: 60, allowNa: false },
    ], { checklist: [
      { code: 'intro', status: 'YES', evidence: ['Меня зовут Алексей.'], comment: 'Представился.' },
      { code: 'objection', status: 'NA', evidence: [], comment: 'Возражений не было.' },
    ], extra_signals: {} as any, recommendations: [] }, [{ role: 'manager', content: 'Меня зовут Алексей.' }]);
    expect(result.checklist[1].status).toBe('NA');
    expect(result.score).toBe(100);
  });
  it('propagates a billing failure immediately rather than trying more example repairs', async () => {
    const transcript = [client('Какая цена?'), manager('Не скажу.')];
    const report = normalizeUnifiedCallReport({ dialog: [{}, { mark: 'negative', comment: 'Не ответил на вопрос о цене.' }] }, { totalScore: 30, transcript })!;
    const error = Object.assign(new Error('Payment required'), { status: 402 });
    const create = vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(error);
    await expect(ensureFindingBetterExamples(report, transcript)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('870: aligns custom argumentation findings with product scores and keeps the calculated total', () => {
    const transcript = [client('Это слишком дорого, боюсь не потянуть платёж.'), manager('Приезжайте завтра, всё обсудим.')];
    const evaluation = { checklist_definition: { items: [
      { id: 'needs', title: 'Выявление потребностей', category: 'Выявление запроса', points: 20 },
      { id: 'objection', title: 'Работа с возражениями', category: 'Аргументация и доверие', points: 30 },
      { id: 'next', title: 'Предложение следующего шага', category: 'Следующий шаг', points: 50 },
    ] }, checklist: [
      { code: 'needs', weight: 20, status: 'NO', evidence: [], comment: 'Не выяснил приоритет.' },
      { code: 'objection', weight: 30, status: 'PARTIAL', evidence: [transcript[1].text], comment: 'Сомнение не снято.' },
      { code: 'next', weight: 50, status: 'YES', evidence: [transcript[1].text], comment: 'Менеджер предложил визит.' },
    ], dimension_scores: { product_and_sales: 30, closing_commitment: 100 } };
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Не отработал возражение / отработал слабо', quote: transcript[1].text, comment: 'Не снял сомнение по платежу.' }] }, { totalScore: 65, evaluation, transcript })!;
    expect(report.totalScore).toBe(65);
    expect(report.categories.find(c => c.name === 'Диагностика')?.score).toBe(0);
    expect(report.categories.find(c => c.name === 'Продукт')?.score).toBe(50);
    expect(report.categories.find(c => c.name === 'Закрытие')?.score).toBe(100);
    expect(report.keyFindings[0].category).toBe('Продукт');
    expect(reportCriterionCode(evaluation, 'objection')).toBe('OBJECTION_HANDLING');
  });
  it('does not score NA as a success or include its weight in category scores', () => {
    const evaluation = { checklist_definition: { items: [
      { id: 'credit', category: 'Предложение решения', points: 90 }, { id: 'product', category: 'Предложение решения', points: 10 },
    ] }, checklist: [{ code: 'credit', status: 'NA', weight: 90 }, { code: 'product', status: 'PARTIAL', weight: 10 }] };
    expect(checklistCategoryScores(evaluation)).toEqual({ Продукт: 50 });
    const report = normalizeUnifiedCallReport({ strengths: ['Не применимо'], weaknesses: ['Кредит: не применимо'] }, { totalScore: 50, transcript: [] })!;
    expect(report.strengths).toEqual([]); expect(report.weaknesses).toEqual([]);
  });
  it('does not turn a neutral question or statement into an objection', () => {
    expect(clientAction('Какая цена и комплектация?')).toBe('question');
    expect(clientAction('Буду покупать в кредит.')).toBe('statement');
    expect(clientAction('У других дешевле, ваша цена меня не устраивает.')).toBe('objection');
    const transcript = [client('Какая цена?'), manager('Приезжайте, обсудим.')];
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Не отработал возражение / отработал слабо', quote: transcript[1].text, comment: 'Не ответил на вопрос о цене.' }] }, { totalScore: 50, transcript })!;
    expect(report.keyFindings[0].problemCode).toBe('NO_DIRECT_ANSWER');
  });
  it('892: does not attach a closing quote containing Алло to the opening Алло', () => {
    const transcript = [manager('Алло.'), client('Здравствуйте, я Андрей.'), manager('Ждём завтра. Алло. Вы меня слышите?')];
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Следующий шаг без конкретики (нет даты/времени)', quote: transcript[2].text, comment: 'Не согласовано время.' }] }, { totalScore: 50, transcript })!;
    expect(report.dialog[0].mark).toBeNull(); expect(report.dialog[2].mark).toBe('negative');
  });
  it('deduplicates one problem by code and source turn, even when display titles differ', () => {
    const transcript = [manager('Приезжайте завтра в 12:00.')];
    const report = normalizeUnifiedCallReport({ keyFindings: ['Следующий шаг без конкретики (нет даты/времени)', 'Не закрепил детали следующего шага'].map(problemTitle => ({ problemTitle, quote: transcript[0].text, comment: 'Слот предложен, но не подтверждён.' })) }, { totalScore: 50, transcript })!;
    expect(report.keyFindings).toHaveLength(1);
  });
  it('does not credit asking for an already supplied name as a strength', () => {
    const transcript = [client('Здравствуйте, меня зовут Марина.'), manager('Как я могу к вам обращаться?')];
    const report = normalizeUnifiedCallReport({ dialog: [{}, { mark: 'positive', comment: 'Менеджер уточнил имя клиента.' }] }, { totalScore: 70, transcript })!;
    expect(report.dialog[1].mark).toBe('normal'); expect(report.strengths.join(' ')).not.toContain('уточнил имя');
  });
  it('retains useful parts of a mixed answer with one grounded action', () => {
    const transcript = [client('Какая цена?'), manager('Цена 2 000 000 рублей. Приезжайте посмотреть.')];
    const evaluation = { checklist: [{ code: 'PRODUCT_PRESENTATION', status: 'YES', evidence: [transcript[1].text], weight: 10, comment: 'Менеджер сообщил цену.' }] };
    const report = normalizeUnifiedCallReport({ keyFindings: [{ problemTitle: 'Презентация не структурирована, нет акцента на выгодах', quote: transcript[1].text, comment: 'Цена названа, но польза предложения не раскрыта.' }] }, { totalScore: 60, transcript, evaluation })!;
    expect(report.dialog[1].mark).toBe('normal');
  });
  it('treats competing name/brand STT as uncertainty without erasing independent errors', () => {
    const turns = [{ role: 'manager', content: 'Я эксперт по автомобилям Volvo.' }];
    const hints = collectTranscriptionUncertainties(turns, undefined, [{ original: turns[0].content, reviewed: 'Я эксперт по автомобилям Volga.' }]);
    expect(hints.some(h => h.token === 'Volvo')).toBe(true);
    expect(isUncertainFactClaim('Ошибочно назвал марку Volvo.', hints)).toBe(true);
    expect(isUncertainFactClaim('Не согласовал время визита.', hints)).toBe(false);
  });
  it('does not publish a finished report when any negative/normal reply lacks a safe improvement', () => {
    const report = normalizeUnifiedCallReport({ dialog: [{ mark: 'negative', comment: 'Нет прямого ответа.' }] }, { totalScore: 30, transcript: [manager('Посмотрите на сайте.')] })!;
    expect(() => requireCompleteReportExamples(report)).toThrow('полный улучшенный пример');
    report.dialog[0].betterExample = 'Я уточню стоимость нужной комплектации и сообщу её вам.';
    expect(requireCompleteReportExamples(report)).toBe(report);
  });
  it('880/874: distinguishes a confirmed clock time from an availability window or proposal', () => {
    const turn = (role: string, content: string) => ({ role, content });
    expect(confirmedTimeInDialog([turn('manager', 'Для визита свободно завтра до 12:00.'), turn('client', 'Хорошо, подъеду.')])).toBe(false);
    expect(confirmedTimeInDialog([turn('manager', 'Приезжайте завтра в 12:00.'), turn('client', 'Хорошо, приеду.')])).toBe(true);
    expect(confirmedTimeInDialog([turn('client', 'Приеду завтра в 12:00.'), turn('manager', 'Ждём вас завтра в 15:00.')])).toBe(false);
    expect(confirmedTimeInDialog([turn('manager', 'Приезжайте завтра в 12:00.'), turn('client', 'В двенадцать не подходит.'), turn('manager', 'Хорошо, пришлю расчёт.')])).toBe(false);
    expect(confirmedTimeInDialog([turn('manager', 'Приезжайте завтра в 12:00.'), turn('client', 'Хорошо, приеду.'), turn('client', 'Отменяю визит.')])).toBe(false);
  });
  it('reclassifies an unsupported perfect closing before calculating the score, without a report-layer penalty', async () => {
    const dialog = [{ role: 'manager' as const, content: 'Меня зовут Алексей. Приезжайте завтра до 12:00.' }, { role: 'client' as const, content: 'Хорошо, постараюсь подъехать.' }];
    const classification = (status: string) => ({ checklist: [
      { code: 'intro', status: 'YES', evidence: [dialog[0].content], comment: 'Представился.' },
      { code: 'date', status, evidence: [dialog[0].content], comment: 'Предложен интервал без подтверждения точного часа.' },
    ], extra_signals: {}, recommendations: [] });
    const completion = (data: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }) as any;
    const create = vi.spyOn(openai.chat.completions, 'create')
      .mockResolvedValueOnce(completion(classification('YES'))).mockResolvedValueOnce(completion(classification('PARTIAL')));
    const { evaluation } = await evaluateSessionV2({ dialogHistory: dialog, car: {} as any, state: getDefaultState(), earlyFail: false,
      evaluationChecklist: { id: 'test', name: 'Контроль времени', items: [
        { id: 'intro', title: 'Представление менеджера', instruction: 'Назвать имя', category: 'Контакт', points: 20, allowNa: false },
        { id: 'date', title: 'Фиксация даты и времени', instruction: 'Подтвердить дату и время', category: 'Следующий шаг', points: 80, allowNa: false },
      ] } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(evaluation.dimension_scores.closing_commitment).toBe(50);
    expect(evaluation.overall_score_0_100).toBe(60);
  });
});
