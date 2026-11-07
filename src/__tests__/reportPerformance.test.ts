import { afterEach, describe, expect, it, vi } from 'vitest';
import { openai } from '../lib/openaiClient';
import { createReportCompletion, mapReportBatches, withReportGenerationBudget } from '../voice/reportExecution';
import { ensureFindingBetterExamples, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';
import { clarificationRequestIssues, reportExampleHash, reviewReportExamples } from '../voice/reportExampleReview';
import { DEFAULT_CALL_REPORT_PROBLEMS } from '../voice/problemCatalog';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const completion = (content: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }) as any;

describe('bounded report execution', () => {
  it('runs independent groups concurrently with a fixed bound and stable result order', async () => {
    let active = 0, maximum = 0;
    const releases: Array<() => void> = [];
    const pending = mapReportBatches([1, 2, 3, 4, 5], 2, 2, async batch => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--; return batch;
    });
    expect(active).toBe(2);
    releases[1](); await Promise.resolve(); await Promise.resolve();
    expect(active).toBe(2);
    releases[2](); releases[0]();
    expect(await pending).toEqual([[1, 2], [3, 4], [5]]);
    expect(maximum).toBe(2);
  });

  it('aborts the actual HTTP request at the shared deadline instead of leaving paid work running', async () => {
    vi.useFakeTimers();
    const create = vi.spyOn(openai.chat.completions, 'create').mockImplementation(((_params: any, options: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted HTTP request')), { once: true });
    })) as any);
    const task = withReportGenerationBudget(() => createReportCompletion({ model: 'test', messages: [] }, 'exampleRepair'), 25);
    const rejected = expect(task).rejects.toThrow('aborted HTTP request');
    await vi.advanceTimersByTimeAsync(25); await rejected;
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 25, maxRetries: 0 });
    expect(create.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('does not publish a result after a swallowed deadline and does not reset the budget in nested generators', async () => {
    vi.useFakeTimers();
    const task = withReportGenerationBudget(() => withReportGenerationBudget(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { summary: 'A partial result' };
    }, 1000), 20);
    const rejected = expect(task).rejects.toThrow('REPORT_GENERATION_TIMEOUT');
    await vi.advanceTimersByTimeAsync(30); await rejected;
  });

  it('does not inherit ten-minute SDK timeouts or hidden transport retries in auxiliary requests', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue(completion({}));
    await createReportCompletion({ model: 'test', messages: [] }, 'findingCoverage');
    await createReportCompletion({ model: 'test', messages: [] }, 'exampleReview');
    expect(create.mock.calls.map(call => call[1])).toEqual([
      { timeout: 120_000, maxRetries: 0 }, { timeout: 90_000, maxRetries: 0 },
    ]);
  });
});

describe('compact drafts keep the same quality gates', () => {
  it('does not hide multiple clarifications behind imperative requests without a question mark', () => {
    expect(clarificationRequestIssues('Что для вас важнее при выборе? Напишите удобные дату и время визита и контакт.')).toHaveLength(1);
    expect(clarificationRequestIssues('Напишите удобную дату и время визита.')).toEqual([]);
    expect(clarificationRequestIssues('Что для вас важнее при выборе? Я проверю документы и предложу время осмотра.')).toEqual([]);
  });
  it('copies one canonical example to every distinct finding without losing any problem or requesting redundant repair', async () => {
    const transcript = [
      { role: 'client' as const, text: 'Меня зовут Мария. Я по Mercedes-Benz GLE 2023 года с пробегом 18 000. Что с историей обслуживания?' },
      { role: 'manager' as const, text: 'Анна, у Haval 2020 года пробег 1838 километров, всё нормально.' },
    ];
    const example = 'Мария, извините: речь о Mercedes-Benz GLE 2023 года с пробегом 18 000 километров. Историю обслуживания проверю и сообщу подтверждённые сведения.';
    const findings = ['WRONG_CLIENT_NAME', 'PRODUCT_MISINFORMATION'].map(code => ({
      problemTitle: DEFAULT_CALL_REPORT_PROBLEMS.find(problem => problem.code === code)!.title,
      quote: transcript[1].text, comment: code === 'WRONG_CLIENT_NAME' ? 'Перепутал имя клиента.' : 'Назвал другую модель, год и пробег.',
      importance: 'Критично', betterExample: '',
    }));
    const report = normalizeUnifiedCallReport({ keyFindings: findings, dialog: [null, { mark: 'negative', comment: 'Перепутал факты.', betterExample: example }] }, { transcript, totalScore: 20 })!;
    expect(report.keyFindings).toHaveLength(2);
    expect(report.keyFindings.map(finding => finding.betterExample)).toEqual([example, example]);
    const create = vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(new Error('Unexpected redundant repair'));
    const repaired = await ensureFindingBetterExamples(report, transcript);
    expect(repaired.dialog[1].betterExample).toBe(example);
    expect(create).not.toHaveBeenCalled();
  });

  it('checks every candidate and problem independently across batches, including a genuine failure', async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => ({ turnIndex: index * 2 + 1, example: 'Проверю наличие и сообщу подтверждённый ответ.',
      problems: [{ id: `finding:${index}`, code: 'NO_DIRECT_ANSWER', title: 'Прямой ответ', comment: 'Не ответил о наличии.' }],
      knownDialog: [{ role: 'client' as const, text: 'Автомобиль есть?' }, { role: 'manager' as const, text: 'Не знаю.' }], scenarioFacts: '' }));
    const create = vi.spyOn(openai.chat.completions, 'create').mockImplementation((async (params: any) => {
      const { items } = JSON.parse(params.messages.at(-1).content);
      return completion({ items: items.map((item: any) => ({ turnIndex: item.turnIndex, exampleHash: reportExampleHash(item.example),
        checks: item.requiredCheckIds.map((id: string) => ({ id, status: item.turnIndex === 5 && id === 'direct-answer' ? 'fail' : 'pass', reason: 'Проверено по контексту.', evidence: item.example })) })) });
    }) as any);
    const reviews = await reviewReportExamples(tasks);
    expect(create).toHaveBeenCalledTimes(3);
    expect(reviews.map(review => review.turnIndex)).toEqual([1, 3, 5, 7, 9]);
    expect(reviews.map(review => review.status)).toEqual(['pass', 'pass', 'fail', 'pass', 'pass']);
    expect(reviews.every(review => review.checks?.length === 4)).toBe(true);
  });
});
