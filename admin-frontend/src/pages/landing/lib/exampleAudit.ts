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
    duration: 252,
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
          betterExample: 'Понимаю. Давайте прикину с trade-in: при оценке около 1,1–1,2 млн Elegance часто выходит на 10–15% интереснее Comfort.',
        },
        {
          problemTitle: 'Не предложен следующий шаг',
          importance: 'Критично',
          category: 'Закрытие',
          quote: 'Хорошо, приезжайте.',
          comment: 'Приглашение общее, без даты и времени.',
          betterExample: 'Могу записать вас на субботу в 12:00 — посмотрим Camry вживую и сразу оценим Kia в trade-in.',
        },
      ],
      dialog: [
        {
          role: 'client',
          text: 'Здравствуйте. Camry в наличии есть? И что у вас с trade-in?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Добрый день, меня зовут Алексей. Да, Camry есть в трёх комплектациях. Подскажите, вы сейчас на чём ездите и что важнее — срок или цена?',
          mark: 'positive',
          comment: 'Представился и сразу уточнил потребность.',
        },
        {
          role: 'client',
          text: 'Семья, нужен седан. Сейчас Kia 2021-го, хотели бы сдать. Бюджет около 3,5, в этом месяце.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Понял. На этот месяц есть Comfort и Elegance. Comfort — 3,49, Elegance ближе к 3,7, там пакет безопасности и кожа.',
          mark: 'positive',
          comment: 'Назвал конкретные комплектации и цены.',
        },
        {
          role: 'client',
          text: 'Elegance уже дорого получается. А Kia как оцениваете, 40 тысяч пробега?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Ну, цены сейчас такие. Оценку trade-in делают на месте, по телефону точно не скажу.',
          mark: 'normal',
          comment: 'Возражение «дорого» не отработано, выгоду trade-in не посчитал.',
          betterExample:
            'Понимаю. Давайте прикину с trade-in: при оценке около 1,1–1,2 млн Elegance часто выходит на 10–15% интереснее Comfort. Могу сразу записать на оценку.',
        },
        {
          role: 'client',
          text: 'Ладно, я бы хотел приехать посмотреть. На выходных получится?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Хорошо, приезжайте.',
          mark: 'negative',
          comment: 'Нет конкретной даты и времени.',
          betterExample:
            'Могу записать вас на субботу в 12:00 — посмотрим Camry вживую и сразу оценим Kia в trade-in.',
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
