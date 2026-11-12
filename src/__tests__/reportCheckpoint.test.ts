import { afterEach, describe, expect, it, vi } from 'vitest';
import { openai } from '../lib/openaiClient';
import { cachedReportReview, rememberReportRejection, savedReportDraft, savedReportRejections, saveReportDraft, saveReportReview, withReportCheckpoint, type ReportCheckpointStore } from '../voice/reportCheckpoint';
import { reportExampleHash, reviewReportExamples, type ReportExampleTask } from '../voice/reportExampleReview';
import { ensureFindingBetterExamples, generateUnifiedCallReport, normalizeUnifiedCallReport } from '../voice/unifiedCallReport';
import { generateCallAnalyticsBundle } from '../voice/callAnalyticsBundle';
import { withReportGenerationBudget } from '../voice/reportExecution';

afterEach(() => vi.restoreAllMocks());
vi.mock('../voice/problemCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../voice/problemCatalog')>();
  return { ...actual, getCallReportProblemCatalog: async () => actual.DEFAULT_CALL_REPORT_PROBLEMS };
});
const input = { transcript: [{ role: 'client', text: 'Есть автомобиль?' }], evaluation: { overall_score_0_100: 70 }, totalScore: 70, scenarioContext: 'Сценарий', source: 'call' as const };
const completion = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) as any;
function memoryStore() {
  let payload: string | null = null;
  let context = 'frozen-case';
  const store: ReportCheckpointStore = {
    load: async () => ({ payload, caseContextHash: context }),
    save: async (expected, next) => { if (payload !== expected) return false; payload = next; return true; },
  };
  return { store, read: () => JSON.parse(payload!), changeCase: () => { context += '-changed'; } };
}
const tasks: ReportExampleTask[] = [1, 3, 5].map(turnIndex => ({ turnIndex, example: 'Я проверю наличие автомобиля и сообщу подтверждённый ответ.',
  problems: [{ id: `dialog:${turnIndex}`, code: 'NO_DIRECT_ANSWER', title: 'Прямой ответ', comment: 'Не ответил.' }],
  knownDialog: [{ role: 'client', text: 'Есть автомобиль?' }, { role: 'manager', text: 'Не знаю.' }], scenarioFacts: 'Нет подтверждённого наличия.' }));
const passed = (task: ReportExampleTask) => ({ turnIndex: task.turnIndex, exampleHash: reportExampleHash(task.example), status: 'pass' as const, issues: [],
  checks: [...task.problems.map(problem => problem.id), 'direct-answer', 'preserves-facts', 'no-invention'].map(id => ({ id, status: 'pass', reason: 'Ответ соответствует контексту.', evidence: task.example })) });

describe('durable report checkpoints', () => {
  it('resumes an initial call bundle through the retry generator without regenerating the report', async () => {
    const memory = memoryStore(), options = { key: 'voice:initial-to-retry', store: memory.store };
    const transcript = [{ role: 'client' as const, text: 'Автомобиль есть?' }, { role: 'manager' as const, text: 'Не знаю.' }];
    const source = { ...input, transcript, outcome: 'completed' };
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(completion({ summary: 'Менеджер не уточнил наличие автомобиля.', keyFindings: [],
      dialog: [{}, { mark: 'normal', comment: 'Не ответил о наличии.', betterExample: tasks[0].example }] }));
    create.mockRejectedValueOnce(Object.assign(new Error('API unavailable'), { status: 402 }));
    await expect(withReportCheckpoint(source, effective => generateCallAnalyticsBundle(effective), options)).rejects.toThrow('API unavailable');
    create.mockImplementation((async (params: any) => {
      const { items } = JSON.parse(params.messages.at(-1).content);
      return completion({ items: items.map(passed) });
    }) as any);
    const report = await withReportCheckpoint({ ...source, evaluation: { ...source.evaluation, call_summary: null, unified_call_report: null, reply_improvements: null } },
      effective => generateUnifiedCallReport(effective), options);
    expect(create).toHaveBeenCalledTimes(3); // draft, failed review, resumed review
    expect(report.dialog[1].betterExample).toBe(tasks[0].example);
    expect(report.totalScore).toBe(70);
  });

  it('resumes only the failed review batch across attempts without replacing good examples', async () => {
    const memory = memoryStore();
    const options = { key: 'voice:1190', store: memory.store };
    let fail = true;
    const seen: number[][] = [];
    vi.spyOn(openai.chat.completions, 'create').mockImplementation((async (params: any) => {
      const { items } = JSON.parse(params.messages.at(-1).content);
      seen.push(items.map((item: any) => item.turnIndex));
      if (fail && items.some((item: any) => item.turnIndex === 5)) {
        // Allow the independent successful batch to reach durable storage first.
        await vi.waitFor(() => expect(Object.keys(memory.read().reviews)).toHaveLength(2));
        throw Object.assign(new Error('payment unavailable'), { status: 402 });
      }
      return completion({ items: items.map(passed) });
    }) as any);
    await expect(withReportCheckpoint(input, async () => {
      await saveReportDraft({ dialog: tasks.map(task => ({ betterExample: task.example })) });
      await reviewReportExamples(tasks);
    }, options)).rejects.toThrow('payment unavailable');
    fail = false;
    const results = await withReportCheckpoint(input, async () => {
      expect(savedReportDraft()).toEqual({ dialog: tasks.map(task => ({ betterExample: task.example })) });
      return reviewReportExamples(tasks);
    }, options);
    expect(seen).toEqual([[1, 3], [5], [5]]);
    expect(results.map(result => result.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('keeps completed repair batches when another request fails and repairs only missing turns next time', async () => {
    const memory = memoryStore();
    const options = { key: 'voice:1147', store: memory.store };
    const transcript = Array.from({ length: 7 }, () => [
      { role: 'client' as const, text: 'Автомобиль есть в наличии?' }, { role: 'manager' as const, text: 'Не знаю.' },
    ]).flat();
    const report = normalizeUnifiedCallReport({ dialog: transcript.map(turn => turn.role === 'manager'
      ? { mark: 'normal', comment: 'Не ответил о наличии.', betterExample: null } : {}) }, { totalScore: 70, transcript })!;
    const seen: number[][] = [];
    let fail = true;
    vi.spyOn(openai.chat.completions, 'create').mockImplementation((async (params: any) => {
      const content = params.messages.at(-1).content as string;
      const { items } = JSON.parse(content.slice(content.indexOf('{\n  "items":'), content.lastIndexOf('\nВерни JSON')));
      seen.push(items.map((item: any) => item.quoteIndex));
      if (fail && items[0].quoteIndex === 7) {
        await vi.waitFor(() => expect(memory.read().report.dialog.filter((line: any) => line.betterExample)).toHaveLength(4));
        throw Object.assign(new Error('API unavailable'), { status: 402 });
      }
      return completion({ items: items.map((item: any) => ({ index: item.index, betterExample: tasks[0].example })) });
    }) as any);
    await expect(withReportCheckpoint({ ...input, transcript }, () => withReportGenerationBudget(() => ensureFindingBetterExamples(report, transcript)), options)).rejects.toThrow('API unavailable');
    fail = false;
    const repaired = await withReportCheckpoint({ ...input, transcript }, () => withReportGenerationBudget(() => ensureFindingBetterExamples(savedReportDraft() as typeof report, transcript)), options);
    expect(seen).toEqual([[1, 3, 5], [7, 9, 11], [13], [7, 9, 11]]);
    expect(repaired.dialog.filter(line => line.role === 'manager').map(line => line.betterExample)).toEqual(Array(7).fill(tasks[0].example));
  });

  it('reuses harmless metadata changes but invalidates changed source facts, score and case', async () => {
    for (const change of [
      { totalScore: 71 }, { transcript: [{ role: 'client', text: 'Другой вопрос' }] },
      { evaluation: { overall_score_0_100: 69 } }, { scenarioContext: 'Иные факты' }, { outcome: 'changed' },
    ]) {
      const memory = memoryStore(), options = { key: 'trainer:one', store: memory.store };
      await withReportCheckpoint(input, () => saveReportDraft({ summary: 'ready' }), options);
      await withReportCheckpoint({ ...input, transcript: input.transcript.map(turn => ({ ...turn, timestampMs: 99 })) }, async () => expect(savedReportDraft()).toEqual({ summary: 'ready' }), options);
      await withReportCheckpoint({ ...input, ...change }, async () => expect(savedReportDraft()).toBeUndefined(), options);
    }
    const memory = memoryStore(), options = { key: 'trainer:one', store: memory.store };
    await withReportCheckpoint(input, () => saveReportDraft({ summary: 'ready' }), options);
    memory.changeCase();
    await withReportCheckpoint(input, async () => expect(savedReportDraft()).toBeUndefined(), options);
  });

  it('binds successful reviews to the exact example, problems and preceding dialog, and persists rejections', async () => {
    const memory = memoryStore(), options = { key: 'voice:1147', store: memory.store };
    await withReportCheckpoint(input, async () => {
      await Promise.all(tasks.map(task => saveReportReview(task, passed(task))));
      rememberReportRejection(1, 'Неверный вариант', ['Придуман факт']);
      await saveReportDraft({ summary: 'ready' });
    }, options);
    await withReportCheckpoint(input, async () => {
      expect(cachedReportReview(tasks[0])?.status).toBe('pass');
      for (const task of [{ ...tasks[0], example: 'Другой вариант' }, { ...tasks[0], scenarioFacts: 'Другие факты' },
        { ...tasks[0], problems: [] }, { ...tasks[0], knownDialog: [] }]) expect(cachedReportReview(task)).toBeUndefined();
      expect(savedReportRejections().get(1)).toEqual([{ text: 'Неверный вариант', issues: ['Придуман факт'] }]);
    }, options);
    expect(Object.keys(memory.read().reviews)).toHaveLength(3);
  });

  it('rejects stale writers before starting paid work', async () => {
    const task = vi.fn();
    await expect(withReportCheckpoint(input, task, { key: 'voice:one', store: {
      load: async () => ({ payload: null, caseContextHash: 'case' }), save: async () => false,
    } })).rejects.toThrow('REPORT_CHECKPOINT_CONFLICT');
    expect(task).not.toHaveBeenCalled();
  });
});
