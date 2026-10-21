import { describe, expect, it } from 'vitest';
import { buildCustomerScenarioPromptCore } from '../voice/customerScenarioPrompt';
import {
  buildTrainerInitialClientMessage,
  ensureTrainerVisitSchedulingAnswer,
  importedItemMatchesTrainerTags,
  isNonProgressingTrainerReply,
  trainerReplyMissesVisitSchedulingAnswer,
} from '../trainer/trainerScenario';
import { buildProgressingVirtualClientFallback } from '../llm/virtualClient';

describe('trainer scenario selection', () => {
  it('names the selected item before the scenario question without voicing the internal scenario name', () => {
    const message = buildTrainerInitialClientMessage({
      scenario: {
        id: 'service-script',
        name: 'Звонок в сервисную службу',
        questions: [{ text: 'Можно записаться на диагностику?', required: true }],
      },
      company: { city: 'Воронеж' },
      importedItem: { title: 'Audi A5 Sportback' },
    });

    expect(message).toContain('Можно записаться на диагностику?');
    expect(message).not.toContain('Звонок в сервисную службу');
    expect(message).toContain('Я звоню по поводу «Audi A5 Sportback»');
    expect(message).not.toContain('есть в наличии');
    expect(message).not.toContain('предложение актуально');
  });

  it('identifies the imported car before asking the first script question', () => {
    const message = buildTrainerInitialClientMessage({
      scenario: {
        questions: [{ text: 'Актуальный ли пробег в объявлении?', required: true }],
      },
      importedItem: { title: 'Kia Carnival, IV Рестайлинг 2025' },
    });

    expect(message).toBe(
      'Здравствуйте. Я звоню по поводу «Kia Carnival, IV Рестайлинг 2025». Подскажите, пожалуйста: Актуальный ли пробег в объявлении?',
    );
  });

  it('does not repeat a greeting already stored in the first scenario question', () => {
    const message = buildTrainerInitialClientMessage({
      scenario: {
        questions: [{ text: 'Здравствуйте! Здравствуйте! Черная Toyota Corolla 2008 года еще в продаже?' }],
      },
    });

    expect(message).toBe('Здравствуйте. Подскажите, пожалуйста: Черная Toyota Corolla 2008 года еще в продаже?');
    expect(message.match(/здравствуйте/gi)).toHaveLength(1);
  });

  it('does not duplicate an existing polite question lead-in', () => {
    const message = buildTrainerInitialClientMessage({
      scenario: {
        questions: [{ text: 'Здравствуйте! Подскажите, пожалуйста, автомобиль еще в продаже?' }],
      },
    });

    expect(message).toBe('Здравствуйте. Подскажите, пожалуйста, автомобиль еще в продаже?');
  });

  it('uses a concrete imported item when the scenario has no opening question', () => {
    const message = buildTrainerInitialClientMessage({
      scenario: { id: 'car-script', name: 'Покупка автомобиля', questions: [] },
      importedItem: { title: 'Audi A5 Sportback' },
    });

    expect(message).toContain('Audi A5 Sportback');
    expect(message).not.toContain('Покупка автомобиля');
  });

  it('uses generic client instructions for trainer scenarios', () => {
    const prompt = buildCustomerScenarioPromptCore({
      mode: 'generic',
      context: 'Клиент хочет записаться на техническое обслуживание.',
      itemTitle: 'Звонок в сервисную службу',
      includeFirstMessage: false,
    });

    expect(prompt).toContain('реальный клиент');
    expect(prompt).not.toContain('реалистичный покупатель');
    expect(prompt).not.toContain('актуально ли предложение');
  });

  it('keeps live dialog separate from post-call answer evaluation', () => {
    const prompt = buildCustomerScenarioPromptCore({
      mode: 'generic',
      questions: [{ text: 'Какой пробег у автомобиля?', required: true }],
      criteria: [{ expectedAnswer: 'Пробег автомобиля составляет 40 000 километров', score: 10 }],
    });

    expect(prompt).toContain('«40 тысяч» является нормальным ответом на вопрос о пробеге');
    expect(prompt).toContain('отдельная аналитика после разговора');
    expect(prompt).toContain('Не добивайся эталонной формулировки');
    expect(prompt).not.toContain('Пробег автомобиля составляет 40 000 километров');
    expect(prompt).not.toContain('Если ответил также или почти также');
  });

  it('gives the client a direct answer when the manager asks their name', () => {
    const prompt = buildCustomerScenarioPromptCore({ mode: 'generic' });

    expect(prompt).toContain('обязательно выбери себе одно обычное человеческое русское имя');
    expect(prompt).toContain('запомни его и не меняй');
    expect(prompt).toContain('сразу и прямо ответь: «Меня зовут [выбранное имя]»');
    expect(prompt).toContain('Запрещено скрывать своё имя');
    expect(prompt).toContain('На «Как вас представить?»');
    expect(prompt).toContain('Не спрашивай в ответ «А вы меня как можете называть?»');
  });

  it('keeps the AI in the customer role and waiting for the employee to finish', () => {
    for (const runtime of ['call', 'trainer'] as const) {
      const prompt = buildCustomerScenarioPromptCore({ runtime });
      expect(prompt).toContain('Не начинай следующую реплику, пока сотрудник не закончил говорить');
      expect(prompt).toContain('не задавай продавцу вопрос «Когда вам удобно приехать?»');
      expect(prompt).toContain('Если вопрос из сценария обращён к клиенту, отвечай на него');
      expect(prompt).toContain('всегда сначала ответь на последний вопрос сотрудника');
      expect(prompt).toContain('получится ли приехать сегодня или завтра');
    }
  });

  it('rejects a new scenario question when the employee asks when the client can visit', () => {
    const managerMessage = 'У вас получится приехать сегодня или завтра?';

    expect(trainerReplyMissesVisitSchedulingAnswer(
      managerMessage,
      'А сколько времени занимает диагностика?',
    )).toBe(true);
    expect(trainerReplyMissesVisitSchedulingAnswer(
      managerMessage,
      'Да. А сколько времени занимает диагностика?',
    )).toBe(true);
    expect(trainerReplyMissesVisitSchedulingAnswer(
      managerMessage,
      'Завтра смогу, ближе к вечеру.',
    )).toBe(false);
    expect(trainerReplyMissesVisitSchedulingAnswer(
      managerMessage,
      'Мне подойдет любой вариант.',
    )).toBe(false);
    expect(trainerReplyMissesVisitSchedulingAnswer(
      'Вы сможете подъехать сегодня?',
      'Могу к 18:00.',
    )).toBe(false);
  });

  it('replaces an ignored repeated scheduling question with a direct answer', () => {
    const managerMessage = 'Я еще раз уточню: получится ли вам подъехать сегодня или завтра?';
    const reply = ensureTrainerVisitSchedulingAnswer(
      managerMessage,
      'Подскажите, а какая гарантия предусмотрена?',
    );

    expect(reply).toContain('завтра подходит');
    expect(reply).toContain('на какое время');
    expect(reply).not.toContain('гарантия');
  });

  it('preserves valid scheduling answers and leaves unrelated questions untouched', () => {
    expect(ensureTrainerVisitSchedulingAnswer(
      'Можете приехать завтра?',
      'Да, завтра смогу к шести.',
    )).toBe('Да, завтра смогу к шести.');
    expect(ensureTrainerVisitSchedulingAnswer(
      'Какой у вас бюджет?',
      'А какая гарантия предусмотрена?',
    )).toBe('А какая гарантия предусмотрена?');
    expect(ensureTrainerVisitSchedulingAnswer(
      'Когда вам удобно записаться на повторный звонок?',
      'А какие еще есть условия?',
    )).toBe('Завтра подходит. Подскажите, пожалуйста, на какое время?');
  });

  it('does not start the substantive scenario before a live employee answers', () => {
    const prompt = buildCustomerScenarioPromptCore({
      itemTitle: 'Skoda Octavia',
    });

    expect(prompt).toContain('ТОЛЬКО после осмысленной реплики живого сотрудника');
    expect(prompt).toContain('Автоматическое приветствие, сообщения «ожидайте», музыка');
    expect(prompt).toContain('Первый вопрос сценария из-за тишины не повторяй');
    expect(prompt).toContain('если сотрудник явно попросил повторить');
    expect(prompt).toContain('ровно ОДНО приветствие');
  });

  it('removes greetings embedded in scenario questions before giving them to the call agent', () => {
    const prompt = buildCustomerScenarioPromptCore({
      questions: [{ text: 'Здравствуйте! Автомобиль еще в продаже?', required: true }],
    });

    expect(prompt).toContain('1. Автомобиль еще в продаже? [обязательная тема]');
    expect(prompt).not.toContain('1. Здравствуйте! Автомобиль еще в продаже?');
  });

  it('omits telephone transport rules in trainer runtime', () => {
    const prompt = buildCustomerScenarioPromptCore({
      mode: 'generic',
      runtime: 'trainer',
      includeFirstMessage: false,
    });

    expect(prompt).not.toContain('# Подключение, IVR и ожидание');
    expect(prompt).not.toContain('send_dtmf');
    expect(prompt).toContain('кратко и естественно заверши диалог');
  });

  it('forbids acknowledgement-only replies from stalling the trainer dialog', () => {
    const prompt = buildCustomerScenarioPromptCore({
      mode: 'generic',
      runtime: 'trainer',
      includeFirstMessage: false,
    });

    expect(prompt).toContain('никогда не должна быть всей репликой');
    expect(prompt).toContain('Запрещено отвечать только «Понял»');
    expect(isNonProgressingTrainerReply('Понял, хорошо.')).toBe(true);
    expect(isNonProgressingTrainerReply('Ладно.')).toBe(true);
    expect(isNonProgressingTrainerReply('Хорошо. А какая гарантия предусмотрена?')).toBe(false);
    expect(isNonProgressingTrainerReply('Тогда я подумаю, спасибо.')).toBe(false);
  });

  it('uses a progressing emergency reply instead of a bare acknowledgement', () => {
    const state = { client_turns: 2 } as any;
    const reply = buildProgressingVirtualClientFallback({
      manager_last_message: 'Да, машина есть в наличии.',
      state,
    });

    expect(reply).not.toBe('Понял, хорошо.');
    expect(isNonProgressingTrainerReply(reply)).toBe(false);
  });

  it('does not accept an unrelated imported item when script tags are configured', () => {
    expect(importedItemMatchesTrainerTags(['Продажа', 'Авто'], ['Сервис'])).toBe(false);
    expect(importedItemMatchesTrainerTags(['Сервис', 'Диагностика'], ['Сервис'])).toBe(true);
  });
});
