import { afterEach, describe, expect, it, vi } from 'vitest';
import { creditConsultationRequested } from '../logic/creditApplicability';
import { computeCustomChecklistResult, evaluateSessionV2 } from '../llm/evaluatorV2';
import { CHECKLIST_CODE } from '../logic/diagnosticScoring';
import { openai } from '../lib/openaiClient';
import { getDefaultState } from '../state/defaultState';
import { groundReportTurnComment } from '../voice/reportTurnGrounding';
import { normalizeUnifiedCallReport } from '../voice/unifiedCallReport';
import { DEFAULT_CALL_REPORT_PROBLEMS } from '../voice/problemCatalog';
import { assessUserTurnCompletion } from '../voice/realtimeConversationFlow';

const manager = (text: string) => ({ role: 'manager' as const, text });
const client = (text: string) => ({ role: 'client' as const, text });
const payment = manager('Покупку планируете за наличные или в кредит?');
const signals = { profanity: false, misinformation: false, passive_style: false, passive_severity: 'mild' as const, low_engagement: false, redirect_to_website: false, bad_tone: false };
afterEach(() => vi.restoreAllMocks());

describe('Dakar QA: unfinished questions', () => {
  it.each(['Подскажите, пожалуйста, как…', 'Подскажите, пожалуйста, как?', 'А какой', 'Меня зовут.'])(
    'keeps the missing question/name unfinished: %s', text => expect(assessUserTurnCompletion(text, '').incomplete).toBe(true),
  );
  it.each(['Подскажите, пожалуйста, как вас зовут?', 'Как автомобиль эксплуатируете?', 'Меня зовут Ольга.', 'Нет, не было.', 'Как?', 'Почему?', 'Сколько?'])(
    'does not delay a complete question or concise answer: %s', text => expect(assessUserTurnCompletion(text, '').incomplete).toBe(false),
  );
});

describe('Dakar QA: credit applicability', () => {
  it.each(['Пока выбираю.', 'Да.', 'Пока не определился, наличные или кредит.', 'Кредит не рассматриваю. Какая цена за наличные?', 'Буду платить наличными.', 'Кредит не интересен.', 'Кредитная программа не нужна.'])(
    'a payment-choice answer is not a credit request: %s', text => expect(creditConsultationRequested([payment, client(text)])).toBe(false),
  );
  it.each(['В кредит.', 'Да, кредит.', 'Можно ли оформить в кредит?', 'Какая ставка по кредиту?', 'Я пока не решил. Какие условия кредита?'])(
    'recognizes an explicit loan choice or question: %s', text => expect(creditConsultationRequested([payment, client(text)])).toBe(true),
  );
  it('recognizes accepted consultation but not a declined offer', () => {
    const offer = manager('Рассказать про условия кредита?');
    expect(creditConsultationRequested([offer, client('Да, конечно.')])).toBe(true);
    expect(creditConsultationRequested([offer, client('Нет, не надо.')])).toBe(false);
    expect(creditConsultationRequested([manager('У нас есть выгодная кредитная программа.')])).toBe(false);
  });

  it('excludes an untriggered conditional item from scoring while preserving explicit mandatory requirements', () => {
    const intro = 'Здравствуйте, меня зовут Ольга.';
    const transcript = [{ role: 'manager' as const, content: intro }, { role: 'manager' as const, content: payment.text }, { role: 'client' as const, content: 'Пока выбираю.' }];
    const classification = { checklist: [
      { code: 'intro', status: 'YES' as const, evidence: [intro], comment: 'Представился.' },
      { code: 'credit', status: 'NO' as const, evidence: [], comment: 'Не объяснил кредит.' },
    ], extra_signals: signals, recommendations: [] };
    const definitions = [
      { id: 'intro', title: 'Представился', instruction: 'Назвать имя', category: 'Контакт', points: 80, allowNa: false },
      { id: 'credit', title: 'Объяснил условия кредита', instruction: 'Если клиент заинтересован в кредите, объяснить условия.', category: 'Продукт', points: 20, allowNa: false },
    ];
    const conditional = computeCustomChecklistResult(definitions, classification, transcript);
    expect(conditional.checklist[1].status).toBe('NA');
    expect(conditional.score).toBe(100);
    const mandatory = computeCustomChecklistResult([definitions[0], { ...definitions[1], instruction: 'Каждому клиенту обязательно рассказать условия кредита.' }], classification, transcript);
    expect(mandatory.checklist[1].status).toBe('NO');
    expect(mandatory.score).toBe(80);
    const requested = computeCustomChecklistResult(definitions, classification, [...transcript, { role: 'client', content: 'Можно оформить в кредит?' }]);
    expect(requested.checklist[1].status).toBe('NO');
  });

  it('also applies the credit guard to legacy evaluation and removes the unsupported coaching recommendation', async () => {
    const intro = 'Здравствуйте, автосалон Тест, меня зовут Ольга.';
    const classification = { checklist: CHECKLIST_CODE.map(code => ({ code,
      status: code === 'CREDIT_EXPLANATION' ? 'NO' : code === 'OBJECTION_HANDLING' ? 'NA' : 'YES', evidence: [intro], comment: 'Проверено.' })),
      extra_signals: signals, recommendations: ['Объясните кредитные условия.', 'Уточните удобное время визита.'] };
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({ choices: [{ message: { content: JSON.stringify(classification) }, finish_reason: 'stop' }] } as any);
    const { evaluation } = await evaluateSessionV2({ dialogHistory: [
      { role: 'manager', content: intro }, { role: 'manager', content: payment.text }, { role: 'client', content: 'Пока выбираю.' },
    ], state: getDefaultState(), car: {} as any, earlyFail: false });
    expect(evaluation.checklist.find(item => item.code === 'CREDIT_EXPLANATION')?.status).toBe('NA');
    expect(evaluation.recommendations).not.toContain('Объясните кредитные условия.');
    expect(evaluation.recommendations).toContain('Уточните удобное время визита.');
  });
});

describe('Dakar QA: per-turn attribution', () => {
  const transcript = [manager('Здравствуйте, автосалон Тест, меня зовут Ольга. Как к вам обращаться?'),
    client('Меня зовут Сергей.'), manager('Меня зовут.'), client('Сергей.'), manager('Андрей, подскажите.'),
    manager('Вы уже проходили тест-драйв?')];
  const finding = (code: string, quote: string, comment: string) => ({ problemTitle: DEFAULT_CALL_REPORT_PROBLEMS.find(item => item.code === code)!.title, quote, comment, importance: 'Важно' });

  it('keeps an explicit fragment quote instead of rewriting it to the complete greeting', () => {
    const report = normalizeUnifiedCallReport({ dialog: [{ mark: 'positive', comment: 'Менеджер представился и спросил имя клиента.' }],
      keyFindings: [finding('WEAK_DIALOG_OPENING', 'Меня зовут.', 'Представление оборвано.')] }, { totalScore: 70, transcript })!;
    expect(report.keyFindings[0].quote).toBe('Меня зовут.');
    expect(report.dialog[0].mark).toBe('positive');
    expect(report.dialog[2].mark).toBe('negative');
  });

  it('rejects an invented explicit quote instead of substituting a real successful greeting', () => {
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('WEAK_DIALOG_OPENING', 'Непрозвучавший текст', 'Не представился.')] }, { totalScore: 70, transcript })!;
    expect(report.keyFindings).toHaveLength(0);
  });

  it('preserves the real name error while removing a test-drive action borrowed from the next turn', () => {
    const comment = 'Менеджер перепутал имя клиента. Менеджер спросил о тест-драйве.';
    expect(groundReportTurnComment(comment, 4, transcript)).toBe('Менеджер перепутал имя клиента.');
    const report = normalizeUnifiedCallReport({ keyFindings: [finding('WRONG_CLIENT_NAME', transcript[4].text, comment)] }, { totalScore: 70, transcript })!;
    expect(report.keyFindings[0].comment).toBe('Менеджер перепутал имя клиента.');
    expect(report.dialog[4].comment).not.toContain('тест-драйв');
  });

  it('keeps legitimate absence criticism and interprets a short answer using preceding context', () => {
    expect(groundReportTurnComment('Менеджер не спросил о тест-драйве.', 4, transcript)).toBe('Менеджер не спросил о тест-драйве.');
    const turns = [client('Тест-драйв доступен?'), manager('Да.'), manager('Приезжайте на тест-драйв.')];
    expect(groundReportTurnComment('Менеджер подтвердил тест-драйв.', 1, turns)).toBe('Менеджер подтвердил тест-драйв.');
  });
});
