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
    'system-template-auto-service-v1',
    NULL,
    'Шаблон отдела сервиса автомобилей',
    true,
    NULL,
    '[
      {"id":"SERVICE_GREETING","title":"Приветствие","instruction":"Проверь, поздоровался ли менеджер и представился ли по имени.","category":"Контакт","points":8,"allowNa":false},
      {"id":"SERVICE_COMPANY_NAME","title":"Название компании","instruction":"Проверь, назвал ли менеджер компанию или салон.","category":"Контакт","points":6,"allowNa":false},
      {"id":"SERVICE_REQUEST_IDENTIFICATION","title":"Идентификация запроса клиента","instruction":"Проверь, уточнил ли менеджер, о каком именно товаре или услуге идёт речь.","category":"Выявление запроса","points":7,"allowNa":false},
      {"id":"SERVICE_NEEDS_DISCOVERY","title":"Выявление потребностей","instruction":"Проверь, задал ли менеджер уточняющие вопросы о потребностях клиента.","category":"Выявление запроса","points":8,"allowNa":false},
      {"id":"SERVICE_INITIATIVE","title":"Инициативность","instruction":"Проверь, вёл ли менеджер разговор проактивно, а не только отвечал на вопросы.","category":"Коммуникация","points":7,"allowNa":false},
      {"id":"SERVICE_PRODUCT_PRESENTATION","title":"Презентация продукта","instruction":"Проверь, презентовал ли менеджер продукт с акцентом на выгоды для клиента, опираясь на факты из скрипта.","category":"Предложение решения","points":10,"allowNa":false},
      {"id":"SERVICE_CREDIT_EXPLANATION","title":"Объяснение условий кредита","instruction":"Проверь, понятно ли менеджер объяснил условия рассрочки или кредита, если это было уместно.","category":"Аргументация и доверие","points":8,"allowNa":true},
      {"id":"SERVICE_TRADEIN_OFFER","title":"Предложение трейд-ин","instruction":"Проверь, предложил ли менеджер и объяснил ли обмен старого товара, если это было уместно.","category":"Предложение решения","points":8,"allowNa":true},
      {"id":"SERVICE_OBJECTION_HANDLING","title":"Отработка возражений","instruction":"Проверь, грамотно ли менеджер отреагировал на возражения, заданные в сценарии.","category":"Аргументация и доверие","points":10,"allowNa":true},
      {"id":"SERVICE_NEXT_STEP","title":"Предложение следующего шага","instruction":"Проверь, предложил ли менеджер конкретное следующее действие.","category":"Следующий шаг","points":10,"allowNa":false},
      {"id":"SERVICE_DATE_FIXATION","title":"Фиксация даты","instruction":"Проверь, зафиксировал ли менеджер точную дату и время следующего контакта.","category":"Следующий шаг","points":8,"allowNa":false},
      {"id":"SERVICE_FOLLOW_UP","title":"Договорённость о повторном контакте","instruction":"Проверь, договорился ли менеджер при необходимости, кто и когда свяжется повторно.","category":"Следующий шаг","points":5,"allowNa":true},
      {"id":"SERVICE_COMMUNICATION_TONE","title":"Тон общения","instruction":"Проверь, поддерживал ли менеджер уважительный и профессиональный тон.","category":"Коммуникация","points":5,"allowNa":false}
    ]',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
