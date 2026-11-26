import { afterEach, describe, expect, it, vi } from 'vitest';
import { openai } from '../lib/openaiClient';
import { createReportCompletion, mapReportBatches, withReportGenerationBudget, reportGenerationBudgetMs } from '../voice/reportExecution';
import { ensureFindingBetterExamples, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';
import { clarificationRequestIssues, reportExampleHash, reviewReportExamples } from '../voice/reportExampleReview';
import { DEFAULT_CALL_REPORT_PROBLEMS } from '../voice/problemCatalog';
import { withCostContext } from '../economics/costContext';
import { withAuditAnalyticsProgress } from '../logic/auditAnalyticsProgress';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const completion = (content: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }) as any;

it('finishes independently checked batches of a long call past the short-call deadline', async () => {
  vi.useFakeTimers();
  const create = vi.spyOn(openai.chat.completions, 'create').mockImplementation((() =>
    new Promise(resolve => setTimeout(() => resolve(completion({ checked: true })), 60_000))) as any);
  const task = withReportGenerationBudget(async () => {
    for (let batch = 0; batch < 6; batch++) {
      await createReportCompletion({ model: 'test', messages: [] }, 'exampleReview');
    }
    return 'all batches checked';
  }, reportGenerationBudgetMs(114));
  await vi.advanceTimersByTimeAsync(360_000);
  await expect(task).resolves.toBe('all batches checked');
  expect(create).toHaveBeenCalledTimes(6);
  expect(reportGenerationBudgetMs(20)).toBe(300_000);
  expect(reportGenerationBudgetMs(10000)).toBe(900_000);
});

describe('bounded report execution', () => {
  it('identifies both successful and failed report requests when several calls are being analysed', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('test provider failure');
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(completion({})).mockRejectedValueOnce(failure);
    await withAuditAnalyticsProgress('voice:call-log-test', 'report', () => withCostContext({ entityType: 'voice_call', entityId: 'call-log-test' }, async () => {
      await createReportCompletion({ model: 'test', messages: [] }, 'generation');
      await expect(createReportCompletion({ model: 'test', messages: [] }, 'exampleRepair')).rejects.toBe(failure);
    }));
    for (const log of [info, warn]) expect(log).toHaveBeenCalledWith('[report/stage]', expect.objectContaining({
      key: 'voice:call-log-test', entityType: 'voice_call', entityId: 'call-log-test',
    }));
  });
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
    const rejected = expect(task).rejects.toThrow('REPORT_GENERATION_TIMEOUT');
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
  it('settles at the deadline even if the task ignores the abort signal forever', async () => {
    vi.useFakeTimers();
    const task = withReportGenerationBudget(() => new Promise<void>(() => {}), 25);
    const rejected = expect(task).rejects.toThrow('REPORT_GENERATION_TIMEOUT');
    await vi.advanceTimersByTimeAsync(25); await rejected;
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
  it('repairs the complete fragmented manager reply against the same facts that the reviewer checks', async () => {
    const transcript = [
      { role: 'client' as const, text: 'Могу подъехать сегодня в 19:00. Какое состояние машины?' },
      { role: 'manager' as const, text: 'Да, будем ждать вас сегодня в 19:00.' },
      { role: 'manager' as const, text: 'Машина в отличном состоянии, ДТП не было, пороги не гнилые.' },
      { role: 'client' as const, text: 'Позднее раскрытая личная потребность.' },
    ];
    const report = normalizeUnifiedCallReport({ dialog: [{}, { mark: 'normal', comment: 'Подтвердил визит, но не уточнил приоритеты клиента.' },
      { mark: 'positive', comment: 'Сообщил состояние автомобиля.' }, {}] }, { totalScore: 80, transcript })!;
    const example = transcript[1].text + ' ' + transcript[2].text + ' Что для вас важнее при выборе машины?';
    const create = vi.spyOn(openai.chat.completions, 'create').mockImplementation((async (params: any) => {
      const text = params.messages.at(-1).content;
      const { items } = JSON.parse(text.slice(text.indexOf('{\n  "items":'), text.lastIndexOf('\nВерни JSON')));
      expect(items).toHaveLength(1);
      expect(items[0].quote).toBe(transcript[1].text);
      expect(items[0].originalReply).toBe(transcript[1].text + ' ' + transcript[2].text);
      expect(items[0].knownDialog).not.toContain(transcript[3].text);
      return completion({ items: items.map((item: any) => ({ index: item.index, betterExample: example })) });
    }) as any);
    const repaired = await ensureFindingBetterExamples(report, transcript);
    expect(create).toHaveBeenCalledOnce();
    expect(repaired.dialog[1].betterExample).toBe(example);
  });
  it('repairs a long dialogue in bounded batches and retries only the truncated batch', async () => {
    const transcript = Array.from({ length: 10 }, () => [
      { role: 'client' as const, text: 'Автомобиль есть в наличии?' }, { role: 'manager' as const, text: 'Не знаю.' },
    ]).flat();
    const report = normalizeUnifiedCallReport({ dialog: transcript.map(turn => turn.role === 'manager'
      ? { mark: 'normal', comment: 'Не ответил о наличии.', betterExample: null } : {}) }, { totalScore: 70, transcript })!;
    const seen: number[][] = [];
    let active = 0, maximum = 0, truncated = false;
    vi.spyOn(openai.chat.completions, 'create').mockImplementation((async (params: any) => {
      const content = params.messages.at(-1).content as string;
      const { items } = JSON.parse(content.slice(content.indexOf('{\n  "items":'), content.lastIndexOf('\nВерни JSON')));
      seen.push(items.map((item: any) => item.quoteIndex));
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 0)); active--;
      if (!truncated && items.some((item: any) => item.quoteIndex === 7)) {
        truncated = true; return { choices: [{ finish_reason: 'length', message: { content: '{"items":[' } }] };
      }
      return completion({ items: items.map((item: any) => ({ index: item.index, betterExample: 'Я проверю наличие автомобиля и сообщу подтверждённый ответ.' })) });
    }) as any);
    const repaired = await ensureFindingBetterExamples(report, transcript);
    expect(seen).toHaveLength(5);
    expect(seen.every(batch => batch.length <= 3)).toBe(true);
    expect(maximum).toBe(2);
    expect(seen.at(-1)).toEqual([7, 9, 11]);
    expect(repaired.dialog.filter(line => line.role === 'manager').every(line => !!line.betterExample)).toBe(true);
  });
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
