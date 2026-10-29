import { describe, expect, it } from 'vitest';
import { adaptHypothesis2Prompt, callbackFarewell, pinSelfIntroduction, profileIdentity } from '../voice/hypothesis2Dialogue';
import { parseRegressionAssessment, REGRESSION_JUDGE_INSTRUCTIONS, regressionAssessmentScope } from '../voice/realtimeRegressionAssessment';

describe('hypothesis 2 dialogue guards', () => {
  it('adapts legacy tools without modifying business questions or the original plan', () => {
    const plan = 'Уточни пробег. Когда всё согласовано, используй существующую процедуру Finish call. При voicemail используй отдельную процедуру. Не вызывай end_call напрямую и не создавай обычную финальную реплику перед процедурой.';
    const adapted = adaptHypothesis2Prompt(plan);
    expect(adapted).toContain('Уточни пробег.');
    expect(adapted).toContain('вызови end_call');
    expect(adapted).not.toContain('Finish call');
    expect(adapted).not.toContain('Не вызывай end_call');
    expect(plan).toContain('Finish call');
  });
  it('pins the explicit test persona over the plan voice', () => {
    expect(profileIdentity('Голос клиента: Мужской. Для этого теста ты Анна, женщина.')).toEqual({ name: 'Анна', gender: 'женский' });
    expect(profileIdentity('Голос клиента: Женский, Разговорный.')).toEqual({ name: null, gender: 'женский' });
  });
  it('corrects only self-introductions, not manager names or first-person verbs', () => {
    expect(pinSelfIntroduction('Сергей, меня зовут Алексей. Я понял.', 'Анна')).toBe('Сергей, меня зовут Анна. Я понял.');
    expect(pinSelfIntroduction('Я Алексей, звоню по машине.', 'Анна')).toBe('Я Анна, звоню по машине.');
    expect(pinSelfIntroduction('Меня зовут не Нина, а Анна.', 'Анна')).toBe('Меня зовут Анна.');
  });
  it('confirms the requested callback time, without inventing a time or biography', () => {
    expect(callbackFarewell('Я сейчас занят. Перезвоните, пожалуйста, завтра после десяти утра.')).toBe('Хорошо, перезвоню завтра после десяти утра. До свидания.');
    expect(callbackFarewell('Можете перезвонить сегодня в 17:30?')).toBe('Хорошо, перезвоню сегодня в 17:30. До свидания.');
    expect(callbackFarewell('Перезвоните, пожалуйста.')).toBe('Хорошо, перезвоню. До свидания.');
  });
  it('does not end on a negation or discard another question', () => {
    expect(callbackFarewell('Не перезванивайте.')).toBeNull();
    expect(callbackFarewell('Перезвоните завтра. А какой у вас бюджет?')).toBeNull();
    expect(callbackFarewell('Как вас зовут? Перезвоните завтра.')).toBeNull();
    expect(callbackFarewell('Автомобиль в наличии.')).toBeNull();
    expect(callbackFarewell('Мы перезвоним вам завтра.')).toBeNull();
  });
});

describe('regression judge roles and scope', () => {
  const turns = [{ role: 'manager', text: 'Как зовут супруга?' }, { role: 'client', text: 'Личные данные обсуждать не буду.' }];
  it('rejects a grade targeting the manager, even if it cites an AI turn', () => {
    for (const evaluatedRole of ['manager', undefined]) {
      expect(parseRegressionAssessment(['answers'], turns, { checks: [{ id: 'answers', status: 'pass', evaluatedRole, turnIndices: [0, 1] }] })[0].status).toBe('review');
    }
  });
  it('requires AI evidence even with the correct role declaration', () => {
    expect(parseRegressionAssessment(['answers'], turns, { checks: [{ id: 'answers', status: 'pass', evaluatedRole: 'ai_client', turnIndices: [0] }] })[0].status).toBe('review');
    expect(parseRegressionAssessment(['answers'], turns, { checks: [{ id: 'answers', status: 'pass', evaluatedRole: 'ai_client', turnIndices: [0, 1] }] })[0].status).toBe('pass');
  });
  it('instructs the judge to accept legitimate non-disclosure, and only assess the triggered branch', () => {
    expect(REGRESSION_JUDGE_INSTRUCTIONS).toContain('Отказ — НЕ пропущенный вопрос');
    expect(REGRESSION_JUDGE_INSTRUCTIONS).toContain('Явное отсутствие у менеджера информации');
    expect(regressionAssessmentScope('callback')).toContain('Только просьба перезвонить');
    expect(regressionAssessmentScope('hold')).toContain('Перезвон не проверяется');
  });
});
