import type { AuditDetailItem } from '../../../shared/api/adminPanel';

export type DepartmentExampleId = 'sales' | 'appraisal' | 'service';

export type DepartmentExampleCard = {
  id: DepartmentExampleId;
  department: string;
  score: number;
  tone: 'bad' | 'mid' | 'good';
  level: string;
  caseLine: string;
  modalTitle: string;
};

export const DEPARTMENT_EXAMPLE_CARDS: DepartmentExampleCard[] = [
  {
    id: 'sales',
    department: 'Отдел продаж',
    score: 48,
    tone: 'bad',
    level: 'Слабо',
    caseLine: 'Не зафиксировал визит и потерял следующий шаг',
    modalTitle: 'Отдел продаж · пример разбора',
  },
  {
    id: 'appraisal',
    department: 'Отдел оценки',
    score: 74,
    tone: 'mid',
    level: 'Средне',
    caseLine: 'Озвучил цену trade-in, но слабо обосновал её',
    modalTitle: 'Отдел оценки · пример разбора',
  },
  {
    id: 'service',
    department: 'Отдел сервиса',
    score: 91,
    tone: 'good',
    level: 'Сильно',
    caseLine: 'Записал на ТО и предложил доп. работы',
    modalTitle: 'Отдел сервиса · пример разбора',
  },
];

export function buildSalesDepartmentAudit(): AuditDetailItem {
  return {
    id: 'landing-sales',
    type: 'call',
    dateTime: '2026-07-18T10:12:00.000Z',
    employeeId: '',
    employeeName: 'Смирнов Д.',
    dealershipId: 'point-north',
    dealershipName: 'Точка «Север»',
    city: 'Москва',
    totalScore: 48,
    verdict: 'Плохо',
    status: 'completed',
    duration: 268,
    communicationFlag: 'ok',
    blocksBreakdown: [
      { block: 'Контакт', score: 72, hint: '' },
      { block: 'Диагностика', score: 55, hint: '' },
      { block: 'Продукт', score: 44, hint: '' },
      { block: 'Закрытие', score: 28, hint: '' },
      { block: 'Коммуникация', score: 60, hint: '' },
    ],
    checklist: [],
    transcript: [],
    events: [],
    errors: [],
    topQuestions: [],
    recommendedTrainings: [],
    answerTimeSec: 6,
    attempts: 1,
    callback: false,
    scenarioName: 'Продажи · Tucson кредит и запись на показ',
    assignedBy: null,
    failReason: null,
    recordingStatus: null,
    recordingUrl: null,
    unifiedReport: {
      version: 'call-report-v1',
      source: 'call',
      summary:
        'Менеджер подтвердил наличие и ответил на часть вопросов, но почти не вёл диалог к визиту: слабо уточнил потребность, ушёл от конкретики по кредиту и не зафиксировал дату следующего шага.',
      totalScore: 48,
      verdict: 'Плохо',
      categories: [
        { name: 'Контакт', score: 72, comment: 'Представился, но быстро ушёл в общие ответы.' },
        { name: 'Диагностика', score: 55, comment: 'Не уточнил бюджет, срок и приоритет клиента.' },
        { name: 'Продукт', score: 44, comment: 'Говорил общими фразами про наличие и кредит.' },
        { name: 'Закрытие', score: 28, comment: 'Не предложил дату и время показа.' },
        { name: 'Коммуникация', score: 60, comment: 'Вежливо, но пассивно вёл разговор.' },
      ],
      strengths: ['Представился в начале звонка', 'Подтвердил наличие модели'],
      weaknesses: [
        'Не уточнил потребность и бюджет',
        'Не отработал «подумаю»',
        'Не зафиксировал следующий шаг',
      ],
      keyFindings: [
        {
          problemTitle: 'Нет конкретного следующего шага',
          importance: 'Критично',
          category: 'Закрытие',
          quote: 'Ну приезжайте, когда будет удобно. Мы до восьми.',
          comment: 'Приглашение без даты оставляет клиента без обязательства.',
          betterExample:
            'Могу записать вас на субботу в 12:00 — посмотрим Tucson и за 20 минут посчитаем кредит под ваш взнос. Если не зайдёт, просто отмените.',
        },
        {
          problemTitle: 'Слабая диагностика запроса',
          importance: 'Важно',
          category: 'Диагностика',
          quote: 'Ну, разные комплектации есть, от базовой до максималки.',
          comment: 'Без бюджета и срока предложение остаётся общим.',
          betterExample:
            'Подскажите ориентир по бюджету и когда нужно авто — подберу 2–3 комплектации и сразу прикину платёж.',
        },
      ],
      dialog: [
        {
          role: 'client',
          text: 'Здравствуйте, Tucson в наличии есть? Хотели бы в кредит посмотреть.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Добрый день, Дмитрий, отдел продаж. Да, Tucson есть. Приезжайте посмотреть.',
          mark: 'normal',
          comment: 'Есть контакт, но сразу прыжок к визиту без диагностики.',
        },
        {
          role: 'client',
          text: 'А какие комплектации сейчас и цвет белый есть?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Ну, разные комплектации есть, от базовой до максималки. По цвету лучше на месте посмотрим, склад живой.',
          mark: 'negative',
          comment: 'Нет конкретики по наличию и комплектациям.',
          betterExample:
            'Сейчас Lifestyle и Prestige, белый есть в Lifestyle. Prestige — серый и чёрный. Могу сразу проверить VIN и комплектацию под вас.',
        },
        {
          role: 'client',
          text: 'Нам семейный вариант, двое детей. Бюджет примерно до 3,8. Платеж интересует при взносе около 30%.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Понял. По кредиту точнее на месте скажут, у нас банк свой. Там посчитают.',
          mark: 'negative',
          comment: 'Ушёл от расчёта платежа и не связал продукт с запросом семьи.',
          betterExample:
            'При взносе около 30% на Lifestyle платёж обычно выходит в диапазоне X–Y на 5–7 лет. Могу сразу прикинуть два варианта и сравнить с Prestige.',
        },
        {
          role: 'client',
          text: 'А trade-in у вас есть? У нас Creta 2020, 55 тысяч пробега.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Да, trade-in делаем. Оценку тоже на месте. По телефону не скажу.',
          mark: 'normal',
          comment: 'Факт подтверждён, но нет даже ориентира и моста к визиту.',
          betterExample:
            'Да, Creta 2020 с таким пробегом обычно смотрим в вилке A–B. На осмотре зафиксируем точно и сразу вычтем из расчёта Tucson.',
        },
        {
          role: 'client',
          text: 'Ладно, я подумаю. Может, ещё в других салонах спрошу.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Хорошо, ну приезжайте, когда будет удобно. Мы до восьми.',
          mark: 'negative',
          comment: 'Возражение не отработано, шаг не зафиксирован.',
          betterExample:
            'Понимаю. Давайте зафиксируем субботу в 12:00: посмотрим Lifestyle, посчитаем кредит и сразу оценим Creta. Если не зайдёт — просто отмените за час.',
        },
        {
          role: 'client',
          text: 'Ок, спасибо.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Пожалуйста, до свидания.',
          mark: 'normal',
          comment: 'Звонок закрыт без договорённости.',
        },
      ],
      recommendations: [
        {
          text: 'После наличия сразу уточнять бюджет, срок и приоритет.',
          category: 'Диагностика',
          problemTitle: 'Слабая диагностика запроса',
        },
        {
          text: 'Всегда предлагать конкретную дату и время визита.',
          category: 'Закрытие',
          problemTitle: 'Нет конкретного следующего шага',
        },
      ],
    },
  };
}

export function buildAppraisalDepartmentAudit(): AuditDetailItem {
  return {
    id: 'landing-appraisal',
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
    duration: 312,
    communicationFlag: 'ok',
    blocksBreakdown: [
      { block: 'Контакт', score: 88, hint: '' },
      { block: 'Диагностика', score: 82, hint: '' },
      { block: 'Продукт', score: 58, hint: '' },
      { block: 'Закрытие', score: 64, hint: '' },
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
    scenarioName: 'Оценка · trade-in Kia Sportage',
    assignedBy: null,
    failReason: null,
    recordingStatus: null,
    recordingUrl: null,
    unifiedReport: {
      version: 'call-report-v1',
      source: 'call',
      summary:
        'Оценщик собрал вводные и назвал вилку цены, но слабо объяснил, из чего она складывается, и не предложил понятный следующий шаг для удержания сделки.',
      totalScore: 74,
      verdict: 'Средне',
      categories: [
        { name: 'Контакт', score: 88, comment: 'Чётко представился и обозначил роль.' },
        { name: 'Диагностика', score: 82, comment: 'Уточнил год, пробег и комплектацию.' },
        { name: 'Продукт', score: 58, comment: 'Назвал цифру без прозрачной логики цены.' },
        { name: 'Закрытие', score: 64, comment: 'Не связал оценку с выгодой новой покупки.' },
        { name: 'Коммуникация', score: 80, comment: 'Спокойный тон, без давления.' },
      ],
      strengths: [
        'Собрал ключевые параметры авто',
        'Озвучил предварительную вилку оценки',
      ],
      weaknesses: [
        'Не расшифровал, из чего сложилась цена',
        'Не предложил очный осмотр с конкретной датой',
      ],
      keyFindings: [
        {
          problemTitle: 'Цена без обоснования',
          importance: 'Важно',
          category: 'Продукт',
          quote: 'Ориентир около 1,1–1,2 млн, точнее на месте.',
          comment: 'Клиент слышит цифру, но не понимает логику — доверие падает.',
          betterExample:
            'По рынку похожие Sportage 2021 с пробегом ~40 тыс. уходят в 1,15–1,25. Минус окрас крыла и шины — вилка 1,1–1,2. На осмотре зафиксируем точно.',
        },
        {
          problemTitle: 'Нет моста к сделке',
          importance: 'Важно',
          category: 'Закрытие',
          quote: 'Если решите — приезжайте на оценку, посмотрим.',
          comment: 'Нет связки оценки с покупкой и слота в календаре.',
          betterExample:
            'Могу на субботу в 11:00: осмотрим Kia и сразу покажем 2 Camry под ваш бюджет с учётом trade-in.',
        },
      ],
      dialog: [
        {
          role: 'client',
          text: 'Здравствуйте. Хотим сдать Kia Sportage 2021, примерно 40 тысяч пробега. Сколько дадите в trade-in?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Добрый день, Алексей, отдел оценки. Подскажите комплектацию и были ли окрасы или ДТП?',
          mark: 'positive',
          comment: 'Сразу уточнил критичные параметры.',
        },
        {
          role: 'client',
          text: 'Prestige, один окрас крыла после парковки, ДТП не было. Меняем на Camry.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Понял. Владельцев сколько было, ключи родные, сервисная книжка есть?',
          mark: 'positive',
          comment: 'Дожал диагностику по документам и истории.',
        },
        {
          role: 'client',
          text: 'Один хозяин, ключи оба, книжка есть, ТО у дилера.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Хорошо. Ориентир около 1,1–1,2 млн, точнее на месте.',
          mark: 'normal',
          comment: 'Цифра есть, обоснования почти нет.',
          betterExample:
            'По рынку ориентир 1,15–1,25, с учётом окраса крыла предварительная вилка 1,1–1,2. На осмотре подтвердим по ЛКП и комплектации.',
        },
        {
          role: 'client',
          text: 'А почему так? В объявлениях видел по 1,35–1,4.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Ну, объявления — это запрос, не факт сделки. Реально обычно ниже. Если решите — приезжайте на оценку, посмотрим.',
          mark: 'negative',
          comment: 'Возражение закрыто формально, без фактов и следующего шага.',
          betterExample:
            'Верно, в объявлениях часто выше. Мы опираемся на реальные сделки за 30 дней по похожим Sportage. Давайте на субботу в 11:00 осмотрим авто и сразу приложим оценку к расчёту Camry.',
        },
        {
          role: 'client',
          text: 'А если я сначала Camry посмотрю, а оценку потом?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Можно и так. Главное — привезти авто на осмотр, без него точную цифру не дадим.',
          mark: 'normal',
          comment: 'Не связал два шага в один визит и не зафиксировал слот.',
          betterExample:
            'Лучше совместить: за один визит осмотрим Kia и сразу посчитаем Camry с trade-in — так вы увидите итоговую сумму, а не две отдельные цифры.',
        },
        {
          role: 'client',
          text: 'Ладно, подумаю на выходных.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Хорошо, обращайтесь.',
          mark: 'negative',
          comment: 'Звонок закрыт без записи на осмотр.',
          betterExample:
            'Давайте тогда субботу 11:00 или воскресенье 12:30 — что удобнее? Забронирую мастера на осмотр и менеджера по Camry.',
        },
      ],
      recommendations: [
        {
          text: 'Каждую вилку цены сопровождать 2–3 факторами рынка и состояния.',
          category: 'Продукт',
          problemTitle: 'Цена без обоснования',
        },
        {
          text: 'Сразу предлагать слот осмотра и связку с покупкой.',
          category: 'Закрытие',
          problemTitle: 'Нет моста к сделке',
        },
      ],
    },
  };
}

export function buildServiceDepartmentAudit(): AuditDetailItem {
  return {
    id: 'landing-service',
    type: 'call',
    dateTime: '2026-07-21T15:05:00.000Z',
    employeeId: '',
    employeeName: 'Козлова М.',
    dealershipId: 'point-west',
    dealershipName: 'Точка «Запад»',
    city: 'Москва',
    totalScore: 91,
    verdict: 'Хорошо',
    status: 'completed',
    duration: 286,
    communicationFlag: 'ok',
    blocksBreakdown: [
      { block: 'Контакт', score: 96, hint: '' },
      { block: 'Диагностика', score: 90, hint: '' },
      { block: 'Продукт', score: 86, hint: '' },
      { block: 'Закрытие', score: 94, hint: '' },
      { block: 'Коммуникация', score: 92, hint: '' },
    ],
    checklist: [],
    transcript: [],
    events: [],
    errors: [],
    topQuestions: [],
    recommendedTrainings: [],
    answerTimeSec: 3,
    attempts: 1,
    callback: false,
    scenarioName: 'Сервис · запись на ТО и доработка',
    assignedBy: null,
    failReason: null,
    recordingStatus: null,
    recordingUrl: null,
    unifiedReport: {
      version: 'call-report-v1',
      source: 'call',
      summary:
        'Администратор быстро понял запрос, зафиксировал удобный слот на ТО и уместно предложил проверку ходовой — без давления и с понятной выгодой для клиента.',
      totalScore: 91,
      verdict: 'Хорошо',
      categories: [
        { name: 'Контакт', score: 96, comment: 'Тёплый вход, назвала имя и отдел.' },
        { name: 'Диагностика', score: 90, comment: 'Уточнила пробег, симптомы и срочность.' },
        { name: 'Продукт', score: 86, comment: 'Предложила релевантную доп. услугу по жалобе.' },
        { name: 'Закрытие', score: 94, comment: 'Предложила два слота и подтвердила запись.' },
        { name: 'Коммуникация', score: 92, comment: 'Ясно, спокойно, по делу.' },
      ],
      strengths: [
        'Зафиксировала точное время визита',
        'Уточнила симптомы до записи',
        'Предложила релевантную доп. услугу',
      ],
      weaknesses: ['Можно было сразу озвучить ориентир по длительности визита'],
      keyFindings: [
        {
          problemTitle: 'Сильная фиксация записи',
          importance: 'Средне',
          category: 'Закрытие',
          quote: 'Записала вас на субботу в 10:30, мастер Иван. Пришлю SMS с адресом и что взять с собой.',
          comment: 'Клиент уходит с конкретной договорённостью и подтверждением.',
          betterExample:
            'При записи сразу озвучивать ориентир: ТО около 1,5 часа, с проверкой ходовой — около 2 часов.',
        },
        {
          problemTitle: 'Уместная допродажа',
          importance: 'Средне',
          category: 'Продукт',
          quote: 'Раз стук на неровностях — могу сразу добавить экспресс-проверку ходовой, +20 минут.',
          comment: 'Доп. услуга связана с жалобой клиента, не выглядит навязчиво.',
          betterExample: 'Можно сразу назвать ориентир стоимости проверки, чтобы клиент не гадал.',
        },
      ],
      dialog: [
        {
          role: 'client',
          text: 'Здравствуйте, нужно ТО на Sportage, ещё стук где-то справа на кочках.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Добрый день, Мария, сервисный отдел. Подскажите пробег и удобный день — будни или выходные?',
          mark: 'positive',
          comment: 'Сразу диагностика потребности и удобства.',
        },
        {
          role: 'client',
          text: 'Около 42 тысяч, лучше суббота утром. Это регламентное ТО?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Да, на 40–45 тыс. обычно масло, фильтры и диагностика по регламенту. Стук на неровностях тоже зафиксируем в заказ-наряде.',
          mark: 'positive',
          comment: 'Пояснила состав ТО и связала с жалобой.',
        },
        {
          role: 'client',
          text: 'А по времени сколько займёт? Машину лучше оставить?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'ТО обычно около полутора часов. Если оставите — удобнее, будет подменный транспорт по записи. Могу предложить субботу 10:30 или 12:00.',
          mark: 'positive',
          comment: 'Два слота и ясный ориентир по времени.',
        },
        {
          role: 'client',
          text: 'Давайте 10:30. А по стуку отдельно сможете посмотреть?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Да. Раз стук на неровностях — добавлю экспресс-проверку ходовой, плюс минут 20. Если найдём люфт или износ — сразу согласуем по телефону, без сюрпризов.',
          mark: 'positive',
          comment: 'Релевантная допродажа с прозрачным процессом согласования.',
        },
        {
          role: 'client',
          text: 'Ок. Что с собой взять?',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Паспорт, СТС и сервисную книжку, если есть. Записала вас на субботу в 10:30, мастер Иван. Пришлю SMS с адресом, схемой проезда и списком документов.',
          mark: 'positive',
          comment: 'Полное подтверждение записи и следующий касание.',
        },
        {
          role: 'client',
          text: 'Отлично, спасибо.',
          mark: null,
          comment: null,
        },
        {
          role: 'manager',
          text: 'Пожалуйста. Если планы изменятся — напишите или позвоните, слот сниму. Хорошего дня!',
          mark: 'positive',
          comment: 'Мягкое закрытие с правом отмены — снижает no-show.',
        },
      ],
      recommendations: [
        {
          text: 'При записи озвучивать ориентир по длительности визита и стоимости доп. проверки.',
          category: 'Закрытие',
          problemTitle: 'Сильная фиксация записи',
        },
      ],
    },
  };
}

const BUILDERS: Record<DepartmentExampleId, () => AuditDetailItem> = {
  sales: buildSalesDepartmentAudit,
  appraisal: buildAppraisalDepartmentAudit,
  service: buildServiceDepartmentAudit,
};

export function buildDepartmentExampleAudit(id: DepartmentExampleId): AuditDetailItem {
  return BUILDERS[id]();
}
