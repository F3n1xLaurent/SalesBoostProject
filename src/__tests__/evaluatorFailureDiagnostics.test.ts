import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateSessionV2 } from '../llm/evaluatorV2';
import { openai } from '../lib/openaiClient';
import { getDefaultState } from '../state/defaultState';

afterEach(() => vi.restoreAllMocks());
const input = () => ({ dialogHistory: [{ role: 'manager' as const, content: 'Здравствуйте.' }],
  car: {} as any, state: getDefaultState(), earlyFail: false,
  evaluationChecklist: { id: 'test', name: 'Тест', items: [
    { id: 'intro', title: 'Представление', instruction: 'Проверить представление', category: 'Контакт', points: 100, allowNa: false },
  ] } });

describe('evaluator failure diagnostics', () => {
  it('preserves the actual checklist validation failure after both attempts', async () => {
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ checklist: [] }) } }] } as any);
    await expect(evaluateSessionV2(input())).rejects.toThrow('EVALUATOR_UNAVAILABLE: Incomplete evaluator checklist: expected 1 unique valid items');
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('distinguishes a provider failure from incomplete classification and retains its cause', async () => {
    const failure = new Error('Connection error');
    vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(failure);
    await expect(evaluateSessionV2(input())).rejects.toMatchObject({ message: 'EVALUATOR_UNAVAILABLE: Connection error', cause: failure });
  });
  it('does not retry invalid provider credentials', async () => {
    const failure = Object.assign(new Error('Invalid credentials'), { status: 401 });
    const create = vi.spyOn(openai.chat.completions, 'create').mockRejectedValue(failure);
    await expect(evaluateSessionV2(input())).rejects.toBe(failure);
    expect(create).toHaveBeenCalledOnce();
  });
});
