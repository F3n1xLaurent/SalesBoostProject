import type { AuditDetailItem } from '../../../shared/api/adminPanel';

/** Пример отчёта в той же структуре, что генерирует продукт (`call-report-v1`). */
export function buildLandingExampleAudit(): AuditDetailItem {
  return {
    id: 'landing-example',
    type: 'call',
    dateTime: '2026-07-24T07:48:00.000Z',
    employeeId: '',
    employeeName: 'Иванов А.',
    dealershipId: 'point-center',
    dealershipName: 'Точка «Центр»',
    city: 'Москва',
    totalScore: 74,
    verdict: 'Средне',
    status: 'completed',
    duration: 167,
    communicationFlag: 'ok',
    blocksBreakdown: [
      { block: 'Контакт', score: 88, hint: '' },
      { block: 'Диагностика', score: 82, hint: '' },
      { block: 'Продукт', score: 70, hint: '' },
      { block: 'Закрытие', score: 48, hint: '' },
      { block: 'Коммуникация', score: 80, hint: '' },
    ],
    checklist: [],
    transcript: [],
    events: [],
    errors: [],
    topQuestions: [],
    recommendedTrainings: [],
    answerTimeSec: 4,
    attempts: 1,
    callback: false,
    scenarioName: 'Camry · кредит и trade-in',
    assignedBy: null,
    failReason: null,
    unifiedReport: {
      version: 'call-report-v1',
      source: 'call',
      summary:
        'Менеджер уточнил потребности и предложил комплектации, но на возражение «дорого» не показал выгоду trade-in и не зафиксировал следующий шаг.',
      totalScore: 74,
      verdict: 'Средне',
      categories: [
        { name: 'Контакт', score: 88, comment: 'Представился и сразу перешёл к запросу клиента.' },
        { name: 'Диагностика', score: 82, comment: 'Уточнил, что важнее — срок или цена.' },
        { name: 'Продукт', score: 70, comment: 'Назвал комплектации, но слабо связал их с выгодой.' },
        { name: 'Закрытие', score: 48, comment: 'Не предложил конкретную дату визита.' },
        { name: 'Коммуникация', score: 80, comment: 'Тон спокойный, без перебиваний.' },
      ],
      strengths: [
        'Представился по имени в начале разговора',
        'Уточнил ключевые параметры запроса',
        'Предложил несколько комплектаций на выбор',
      ],
      weaknesses: [
        'Не отработал возражение «дорого» через выгоду trade-in',
        'Не зафиксировал конкретный следующий шаг',
      ],
      keyFindings: [
        {
          problemTitle: 'Слабая работа с возражением «дорого»',
          importance: 'Важно',
          category: 'Продукт',
          quote: 'Ну, цены сейчас такие.',
          comment: 'Менеджер согласился с возражением вместо пересчёта выгоды.',
          betterExample: 'Понимаю. Давайте посчитаю выгоду с trade-in — обычно выходит на 10–15% интереснее.',
        },
        {
          problemTitle: 'Не предложен следующий шаг',
          importance: 'Критично',
          category: 'Закрытие',
          quote: 'Хорошо, приезжайте.',
          comment: 'Приглашение общее, без даты и времени.',
          betterExample: 'Могу записать вас на субботу в 12:00 — посмотрим Camry вживую и сразу прикинем trade-in.',
        },
      ],
      dialog: [
        { role: 'client', text: 'Здравствуйте. Camry в наличии? И что с trade-in?', mark: null, comment: null },
        {
          role: 'manager',
          text: 'Добрый день, меня зовут Алексей. Да, есть три комплектации. Что важнее — срок или цена?',
          mark: 'positive',
          comment: 'Представился и уточнил потребность.',
        },
        { role: 'client', text: 'Дорого получается.', mark: null, comment: null },
        {
          role: 'manager',
          text: 'Ну, цены сейчас такие.',
          mark: 'normal',
          comment: 'Возражение не отработано.',
          betterExample: 'Понимаю. Давайте посчитаю выгоду с trade-in — обычно выходит на 10–15% интереснее.',
        },
        { role: 'client', text: 'Я бы хотел приехать посмотреть.', mark: null, comment: null },
        {
          role: 'manager',
          text: 'Хорошо, приезжайте.',
          mark: 'negative',
          comment: 'Нет конкретного слота.',
          betterExample: 'Могу записать вас на субботу в 12:00 — посмотрим Camry и сразу прикинем trade-in.',
        },
      ],
      recommendations: [
        {
          text: 'На «дорого» сразу считать выгоду с trade-in и озвучивать цифру.',
          category: 'Продукт',
          problemTitle: 'Слабая работа с возражением «дорого»',
        },
        {
          text: 'Всегда предлагать конкретную дату и время визита.',
          category: 'Закрытие',
          problemTitle: 'Не предложен следующий шаг',
        },
      ],
    },
  };
}
