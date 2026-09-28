INSERT OR IGNORE INTO "evaluation_checklists" (
    "id",
    "holdingId",
    "name",
    "isTemplate",
    "sourceTemplateId",
    "itemsJson",
    "isArchived",
    "createdAt",
    "updatedAt"
) VALUES (
    'system-template-auto-sales-v1',
    NULL,
    'Шаблон отдела продаж автомобилей',
    true,
    NULL,
    '[
      {"id":"INTRODUCTION","title":"Представление менеджера","instruction":"Проверь, представился ли менеджер по имени.","category":"Контакт","points":8,"allowNa":false},
      {"id":"SALON_NAME","title":"Название автосалона","instruction":"Проверь, назвал ли менеджер автосалон или компанию.","category":"Контакт","points":6,"allowNa":false},
      {"id":"CAR_IDENTIFICATION","title":"Уточнение автомобиля","instruction":"Проверь, уточнил ли менеджер, какой именно автомобиль интересует клиента.","category":"Выявление запроса","points":7,"allowNa":false},
      {"id":"NEEDS_DISCOVERY","title":"Выявление потребностей","instruction":"Проверь, задавал ли менеджер вопросы о потребностях клиента.","category":"Выявление запроса","points":8,"allowNa":false},
      {"id":"INITIATIVE","title":"Инициатива","instruction":"Проверь, проявлял ли менеджер инициативу: предлагал варианты и вёл диалог.","category":"Коммуникация","points":7,"allowNa":false},
      {"id":"PRODUCT_PRESENTATION","title":"Презентация автомобиля","instruction":"Проверь, провёл ли менеджер структурированную презентацию автомобиля с привязкой к потребностям клиента.","category":"Предложение решения","points":10,"allowNa":false},
      {"id":"CREDIT_EXPLANATION","title":"Объяснение кредитных условий","instruction":"Проверь, объяснил ли менеджер кредитные условия, если тема кредита поднималась.","category":"Аргументация и доверие","points":8,"allowNa":true},
      {"id":"TRADEIN_OFFER","title":"Предложение trade-in","instruction":"Проверь, предложил ли менеджер trade-in, если эта тема была уместна в разговоре.","category":"Предложение решения","points":8,"allowNa":true},
      {"id":"OBJECTION_HANDLING","title":"Работа с возражениями","instruction":"Проверь, обработал ли менеджер возражения профессионально, если клиент высказывал возражения.","category":"Аргументация и доверие","points":10,"allowNa":true},
      {"id":"NEXT_STEP_PROPOSAL","title":"Предложение следующего шага","instruction":"Проверь, предложил ли менеджер конкретный следующий шаг: визит, тест-драйв или звонок.","category":"Следующий шаг","points":10,"allowNa":false},
      {"id":"DATE_FIXATION","title":"Фиксация даты и времени","instruction":"Проверь, зафиксировал ли менеджер конкретную дату и время следующего действия.","category":"Следующий шаг","points":8,"allowNa":false},
      {"id":"FOLLOW_UP_AGREEMENT","title":"Договорённость о повторном контакте","instruction":"Проверь, договорился ли менеджер о повторном контакте.","category":"Следующий шаг","points":5,"allowNa":false},
      {"id":"COMMUNICATION_TONE","title":"Профессиональный тон","instruction":"Проверь, был ли тон общения менеджера профессиональным и уместным.","category":"Коммуникация","points":5,"allowNa":false}
    ]',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
