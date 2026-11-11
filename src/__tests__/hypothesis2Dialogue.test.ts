import { describe, expect, it } from 'vitest';
import { adaptHypothesis2Prompt, callbackFarewell, customerRoleResponse, pinSelfIntroduction, profileIdentity, dialogueProgressInstructions, explicitVisitOffer, hasVisitDecision, visitResponseCanEnd } from '../voice/hypothesis2Dialogue';
import { buildCustomerScenarioPromptCore } from '../voice/customerScenarioPrompt';
import { parseRegressionAssessment, REGRESSION_JUDGE_INSTRUCTIONS, regressionAssessmentScope } from '../voice/realtimeRegressionAssessment';

describe('hypothesis 2 dialogue guards', () => {
  it('agrees to a business card on the calling number without inventing ownership or delivery status', () => {
    const text = 'Звоните с вашего личного номера для отправки визитки с адресом ДЦ?';
    expect(customerRoleResponse([{ role: 'manager', text }], 'Анна')).toBe('Отправьте, пожалуйста, визитку с адресом на этот номер.');
    expect(customerRoleResponse([{ role: 'manager', text: 'Можно прислать адрес на этот номер?' }])).toBe('Отправьте, пожалуйста, визитку с адресом на этот номер.');
    expect(customerRoleResponse([{ role: 'manager', text: 'Это мой личный номер, запишите его.' }])).toBeNull();
    expect(customerRoleResponse([{ role: 'manager', text: 'Это ваш личный номер?' }])).toBe('Для связи используйте этот номер.');
    expect(customerRoleResponse([{ role: 'manager', text: 'Можно прислать адрес на этот номер? Какой автомобиль интересует?' }])).toBeNull();
  });
  it('1185: keeps the chosen name and returns to a real unanswered customer question', () => {
    const history = [{ role: 'client', text: 'Меня зовут Анна. Чёрный Туарег ещё в продаже?' }, { role: 'manager', text: 'Это робот?' }];
    expect(customerRoleResponse(history, 'Анна')).toBe('Меня зовут Анна. Чёрный Туарег ещё в продаже?');
    expect(customerRoleResponse([{ role: 'manager', text: 'Вы робот или живой человек?' }], 'Максим')).toBe('Меня зовут Максим. Я звоню по поводу автомобиля из объявления.');
    expect(customerRoleResponse([{ role: 'manager', text: 'У машины роботизированная коробка.' }], 'Максим')).toBeNull();
    expect(customerRoleResponse([{ role: 'manager', text: 'Вы роботизированную коробку рассматриваете?' }], 'Максим')).toBeNull();
  });
  it('remembers the clarification limit across paraphrases from 8cfa445a', () => {
    const turns = [
      { role: 'client', text: 'Есть ли запасное колесо в комплекте?' },
      { role: 'manager', text: 'Уточните, что интересует.' },
      { role: 'client', text: 'Интересует комплектность: запасное колесо, докатка или ремкомплект.' },
      { role: 'manager', text: 'Масло и фильтры заменены.' },
    ];
    const instructions = dialogueProgressInstructions(turns, '');
    expect(instructions).toContain('Не задавай её в третий раз'); expect(instructions).toContain('оставь факт неизвестным');
    expect(dialogueProgressInstructions(turns.slice(0, 2), '')).not.toContain('в третий раз');
    expect(dialogueProgressInstructions(turns.map((turn) => turn.role === 'client' ? { ...turn, metrics: { interrupted: true } } : turn), '')).not.toContain('в третий раз');
  });
  it('counts an overlapping mandatory discount question as the single optional topic', () => {
    const prompt = buildCustomerScenarioPromptCore({ questions: [{ text: 'Можете сделать скидку?', required: true }], objections: [{ phrase: 'Цена высокая, можно ли сделать скидку' }, { phrase: 'Есть ли запаска?' }] });
    expect(prompt).not.toContain('уклончивый ответ принимай как ответ');
    expect(dialogueProgressInstructions([{ role: 'client', text: 'Можете сделать скидку, если приеду?' }], prompt)).toContain('Не добавляй второе возражение');
    expect(dialogueProgressInstructions([{ role: 'client', text: 'Какой пробег?' }], prompt)).not.toContain('Не добавляй второе возражение');
  });
  it('keeps the unresolved car/year question after a name-only correction', () => {
    const instructions = dialogueProgressInstructions([{ role: 'client', text: 'Если там 2024 год, это другой автомобиль?' }, { role: 'manager', text: 'И поправка: меня зовут не Никита, а Антон. Обращайтесь ко мне Антон.' }], '');
    expect(instructions).toContain('не ответил на вопрос'); expect(instructions).toContain('2024');
    expect(dialogueProgressInstructions([{ role: 'client', text: 'Какой год?' }, { role: 'manager', text: 'Меня зовут Антон. Год 2018.' }], '')).not.toContain('не ответил на вопрос');
  });
  it('requires an audible visit decision, never an end_call.reason claim', () => {
    const offer = explicitVisitOffer('Да, приезжайте сегодня к семнадцати часам, менеджер будет на месте. Адрес: улица Пушкина, дом один.')!;
    expect(offer.time).toBe('сегодня к семнадцати часам');
    expect(explicitVisitOffer('Приезжайте завтра в пять тридцать вечера.')?.time).toBe('завтра в пять тридцать вечера');
    expect(explicitVisitOffer('Приезжайте послезавтра в 17:30.')?.time).toBe('послезавтра в 17:30');
    expect(hasVisitDecision('Спасибо за ответы, всего доброго.')).toBe(false);
    expect(visitResponseCanEnd('Приеду сегодня к пяти. До свидания.', offer)).toBe(true);
    expect(visitResponseCanEnd('Приеду завтра к пяти. До свидания.', offer)).toBe(false);
    expect(visitResponseCanEnd('Сегодня не смогу. Можно завтра?', offer)).toBe(false);
    for (const text of ['Не приезжайте сегодня к пяти.', 'Можете перезвонить завтра в 17:30?', 'Приезжайте сегодня или завтра к пяти.', 'Наш адрес: улица Пушкина, дом один.']) expect(explicitVisitOffer(text)).toBeNull();
  });
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
