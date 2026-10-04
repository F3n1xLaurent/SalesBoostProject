import { describe, expect, it } from 'vitest';
import { buildScriptCriteriaEvaluationPrompt } from '../llm/scriptCriteriaPrompt';

describe('buildScriptCriteriaEvaluationPrompt', () => {
  it('treats a short reference as a semantic minimum and preserves the full transcript', () => {
    const longAnswer = 'Да, автомобиль прошёл полную юридическую проверку, не находится в залоге, не имеет ограничений и дополнительно проверен по диагностике.';
    const prompt = buildScriptCriteriaEvaluationPrompt(
      [{ expectedAnswer: 'Автомобиль юридически проверен', score: 10 }],
      [{ role: 'client', text: 'Он проверен?' }, { role: 'manager', text: longAnswer }],
    );

    expect(prompt).toContain('минимальный обязательный смысл');
    expect(prompt).toContain('Не снижай балл только из-за длины ответа');
    expect(prompt).toContain('во всех репликах сотрудника');
    expect(prompt).toContain(longAnswer);
  });
});
