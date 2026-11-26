import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateSessionV2 } from '../llm/evaluatorV2';
import { openai } from '../lib/openaiClient';
import { getDefaultState } from '../state/defaultState';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const input = () => ({ dialogHistory: [{ role: 'manager' as const, content: 'Здравствуйте.' }],
  car: {} as any, state: getDefaultState(), earlyFail: false,
  evaluationChecklist: { id: 'test', name: 'Тест', items: [
    { id: 'intro', title: 'Представление', instruction: 'Проверить представление', category: 'Контакт', points: 100, allowNa: false },
  ] } });

describe('evaluator failure diagnostics', () => {
  it('repairs a partial checklist using model assessments without filling missing items itself', async () => {
    const source = input();
    source.evaluationChecklist.items.push({ ...source.evaluationChecklist.items[0], id: 'details', title: 'Уточнение' });
    const signals = { profanity: false, misinformation: false, passive_style: false, passive_severity: 'mild',
      low_engagement: false, redirect_to_website: false, bad_tone: false };
    const response = (code: string) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      checklist: [{ code, status: 'YES', evidence: ['Здравствуйте.'], comment: 'Приветствие подтверждено.' }],
      extra_signals: signals, recommendations: [],
    }) } }] });
    const create = vi.spyOn(openai.chat.completions, 'create')
      .mockResolvedValueOnce(response('intro') as any)
      .mockResolvedValueOnce(response('details') as any);
    const result = await evaluateSessionV2(source);
    expect(result.evaluation.checklist.map(item => item.code)).toEqual(['intro', 'details']);
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[1][0])).toContain('missing or invalid codes: details');
  });

  it('rejects a repair that still has no model assessment for the missing item', async () => {
    const source = input();
    source.evaluationChecklist.items.push({ ...source.evaluationChecklist.items[0], id: 'missing', title: 'Уточнение' });
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      checklist: [{ code: 'intro', status: 'YES', evidence: ['Здравствуйте.'], comment: 'Приветствие.' }],
    }) } }] } as any);
    await expect(evaluateSessionV2(source)).rejects.toThrow('missing or invalid codes: missing');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('preserves the actual checklist validation failure after both attempts', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ checklist: [] }) } }] } as any);
    await expect(evaluateSessionV2(input())).rejects.toThrow('EVALUATOR_UNAVAILABLE: Incomplete evaluator checklist: expected 1 unique valid items');
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('distinguishes a provider failure from incomplete classification and retains its cause', async () => {
    const failure = new Error('Connection error');
    const create = vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(failure);
    await expect(evaluateSessionV2(input())).rejects.toMatchObject({ message: 'EVALUATOR_UNAVAILABLE: Connection error', cause: failure });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 120_000, maxRetries: 0, signal: expect.any(AbortSignal) });
  });
  it('releases an evaluation that ignores cancellation and never starts a late repair', async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    const create = vi.spyOn(openai.chat.completions, 'create').mockImplementation((() => new Promise(resolve => { release = resolve; })) as any);
    const pending = evaluateSessionV2(input());
    const settled = pending.then(() => 'ready', error => error.message);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await Promise.race([settled, Promise.resolve('still blocked')])).toContain('ANALYSIS_STAGE_TIMEOUT: evaluation');
    expect(create.mock.calls[0][1]?.signal?.aborted).toBe(true);
    release({ choices: [{ message: { content: '{"checklist":[]}' } }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(create).toHaveBeenCalledOnce();
  });
  it('does not retry invalid provider credentials', async () => {
    const failure = Object.assign(new Error('Invalid credentials'), { status: 401 });
    const create = vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(failure);
    await expect(evaluateSessionV2(input())).rejects.toBe(failure);
    expect(create).toHaveBeenCalledOnce();
  });
});
