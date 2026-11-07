import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareTranscriptForAnalysis } from '../voice/analysisTranscript';
import { connectionCheckResponse } from '../voice/hypothesis2Dialogue';
import { canEndDialogue, dialogueRecoveryResponse, unansweredManagerResponseIssue } from '../voice/realtimeDialoguePolicy';
import { buildEvaluationHighlights } from '../logic/evaluationHighlights';
import { ensureFindingBetterExamples, ensureReportDialogCoverage, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';
import { openai } from '../lib/openaiClient';
import type { TranscriptTurn } from '../voice/callHistory';
import { sanitizeRealtimeSpokenText } from '../voice/cometRealtimeTest';
import { reportCodeChecks } from '../testing/reportTestEvaluation';
import { REPORT_TEST_SCENARIOS } from '../testing/reportTestCatalog';

const manager = (text: string): TranscriptTurn => ({ role: 'manager', text });
const client = (text: string): TranscriptTurn => ({ role: 'client', text });
afterEach(() => vi.restoreAllMocks());

describe('generic regressions from the two-call QA review', () => {
  const conversation = [manager('Добрый день, автосалон КИТ, меня зовут Оля.'),
    client('Цена в объявлении окончательная при оплате наличными?'), manager('Да, никаких наценок нет.'),
    client('Цена в объявлении окончательная при оплате наличными?'), manager('Подъезжайте сегодня в 19:00.'),
    client('Вы предлагаете сегодня в 19:00?'), manager('Алло, вас не слышно.'), client('До свидания.')];

  it.each([false, true])('never discards completed sales dialogue because the bot repeated a question (IVR flag %s)', (ivrDetected) => {
    const result = prepareTranscriptForAnalysis(conversation, { ivrDetected });
    expect(result.transcript).toEqual(conversation);
    expect(result.removedPrefixTurns).toBe(0);
  });

  it('does not treat waiting for documents as waiting for an initial connection', () => {
    const transcript = [manager('Здравствуйте, меня зовут Анна.'), client('Подскажите цену?'),
      manager('Цена два миллиона. Отправлю документы.'), client('Хорошо, жду документы.'),
      manager('Здравствуйте, ещё раз. Вы меня слышите?'), client('Да.')];
    expect(prepareTranscriptForAnalysis(transcript).transcript).toEqual(transcript);
  });

  it('keeps the actual dialogue after an IVR prefix even when it contains repeats and a connection check', () => {
    const transcript = [manager('Вас приветствует компания. Дождитесь ответа оператора.'), ...conversation];
    expect(prepareTranscriptForAnalysis(transcript).transcript).toEqual(conversation);
  });

  it('does not blame the employee or create a coaching example for a standalone audibility check', async () => {
    const transcript = [manager('Здравствуйте, менеджер Ольга.'), client('Вы предлагаете сегодня в 19:00?'), manager('Алло, вас не слышно.')];
    const report = normalizeUnifiedCallReport({ totalScore: 70, dialog: [
      { mark: 'positive', comment: 'Менеджер представился.' }, null,
      { mark: 'negative', comment: 'Не отработал возражение.', betterExample: 'Здравствуйте, меня зовут [имя]. Приезжайте завтра в 10:00.' },
    ], keyFindings: [{ problemTitle: 'Не предложил следующий шаг', importance: 'Важно', quote: 'Алло, вас не слышно.', comment: 'Не предложил визит.' }] },
    { totalScore: 70, transcript })!;
    expect(report.keyFindings).toHaveLength(0);
    expect(report.dialog[2]).toMatchObject({ mark: null, betterExample: null });
    expect(report.dialog[2].comment).toContain('проверяет слышимость');
    const create = vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(new Error('Unexpected paid repair'));
    const covered = await ensureReportDialogCoverage(report, transcript);
    await ensureFindingBetterExamples(covered, transcript);
    expect(create).not.toHaveBeenCalled();
    const fixture = { ...REPORT_TEST_SCENARIOS[0], transcript, checks: ['report-all-turns' as const] };
    const output = { report: covered, evaluation: {}, transcript, timings: { evaluationMs: 0, reportMs: 0, totalMs: 0 } };
    expect(reportCodeChecks(fixture, output).find(check => check.id === 'report-all-turns')?.status).toBe('pass');
    const incomplete = { ...covered, dialog: covered.dialog.map((line, index) => index === 0 ? { ...line, mark: null, comment: null } : line) };
    expect(reportCodeChecks(fixture, { ...output, report: incomplete }).find(check => check.id === 'report-all-turns')?.status).toBe('fail');
  });

  it('does not shield a substantive reply merely beginning with «Алло»', () => {
    const transcript = [client('Какая цена?'), manager('Алло, цена два миллиона рублей.')];
    const report = normalizeUnifiedCallReport({ dialog: [null, { mark: 'positive', comment: 'Сообщил цену.' }] }, { totalScore: 80, transcript })!;
    expect(report.dialog[1].mark).toBe('positive');
  });

  it('repeats the pending visit question once instead of saying goodbye on an audibility check', () => {
    const transcript = conversation.slice(0, -1);
    expect(connectionCheckResponse(transcript)).toBe('Вы предлагаете сегодня в 19:00?');
    expect(canEndDialogue(transcript, 'Хорошо, приеду сегодня в 19:00. До свидания.')).toBe(false);
    const twice = [...transcript, client('Вы предлагаете сегодня в 19:00?'), manager('Вас не слышно.')];
    expect(connectionCheckResponse(twice)).toBe('Да, я на связи. Вы меня слышите?');
    expect(connectionCheckResponse([...twice, client('Да, я на связи.'), manager('Алло.')])).toBeNull();
  });

  it('does not repeat speech that failed synthesis or complete an interrupted introduction with invented identity', () => {
    expect(connectionCheckResponse([manager('Здравствуйте.'), { ...client('Меня зовут Анна.'), metrics: { ttsFailed: true } }, manager('Алло, вас не слышно.')])).toBeNull();
    const transcript = [manager('Здравствуйте.'), client('Меня зовут'), manager('Алло, вас не слышно.')];
    expect(connectionCheckResponse(transcript, 'Анна')).toBe('Меня зовут Анна. Вы меня слышите?');
    expect(connectionCheckResponse(transcript)).not.toContain('Меня зовут');
  });

  it('uses criterion names and linked questions instead of employee reply templates in highlights', () => {
    const result = buildEvaluationHighlights({ plan_criteria: { items: [
      { title: 'Приветствие', expectedAnswer: 'Здравствуйте! Меня зовут [Имя], автосалон КИТ.', status: 'PARTIAL', score: 50, maxScore: 100 },
      { sourcePrompt: 'Цена окончательная при оплате наличными?', expectedAnswer: 'Нет. Понимаем, много историй про недобросовестные салоны.', status: 'NO', score: 0, maxScore: 100 },
      { expectedAnswer: 'Здравствуйте! Меня зовут [Имя].', status: 'PARTIAL', score: 50, maxScore: 100 },
    ] } });
    expect(result.weaknesses).toEqual(['Приветствие — выполнено частично', 'Цена окончательная при оплате наличными? — не выполнено', 'Приветствие и представление — выполнено частично']);
    expect(result.weaknesses.join(' ')).not.toContain('[Имя]');
  });

  it('rejects feigned ignorance of personal facts and uses a direct refusal rather than a circular clarification', () => {
    const transcript = [manager('На чём вы сейчас ездите, какой автомобиль у вас в собственности?')];
    expect(unansweredManagerResponseIssue(transcript, 'Пока не могу уточнить, какой автомобиль сейчас в эксплуатации.')).toContain('по легенде');
    const recovery = dialogueRecoveryResponse(transcript, { answerRequired: true });
    expect(recovery).not.toContain('?');
    expect(recovery).not.toContain('уточнить');
    expect(unansweredManagerResponseIssue(transcript, recovery)).toBeNull();
  });

  it.each([
    'Хорошо, уточню этот момент и коротко продолжу по делу.',
    'Хорошо, сейчас коротко уточню и сразу договоримся по визиту.',
  ])('blocks narrated workflow from the QA review without removing the actual answer: %s', (preface) => {
    expect(sanitizeRealtimeSpokenText(`${preface} Завтра в 19:00 мне удобно.`)).toBe('Завтра в 19:00 мне удобно.');
    expect(sanitizeRealtimeSpokenText('Тогда уточню: завтра в 19:00 можно приехать?')).toBe('Тогда уточню: завтра в 19:00 можно приехать?');
  });
});
