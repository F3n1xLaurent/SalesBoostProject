CREATE TABLE "demo_call_voices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "gender" TEXT NOT NULL,
    "elevenLabsVoiceId" TEXT NOT NULL,
    "communicationModifier" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "demo_call_voices_isEnabled_sortOrder_idx" ON "demo_call_voices"("isEnabled", "sortOrder");

CREATE TABLE "demo_call_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "ageFrom" INTEGER NOT NULL DEFAULT 35,
    "ageTo" INTEGER NOT NULL DEFAULT 35,
    "character" TEXT NOT NULL DEFAULT '',
    "temperament" TEXT NOT NULL,
    "patience" TEXT NOT NULL,
    "replyLength" TEXT NOT NULL,
    "communicationStyle" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "demo_call_scripts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyName" TEXT NOT NULL DEFAULT '',
    "companyDescription" TEXT NOT NULL DEFAULT '',
    "itemTitle" TEXT NOT NULL DEFAULT '',
    "context" TEXT NOT NULL DEFAULT '',
    "dataText" TEXT NOT NULL DEFAULT '',
    "objectionsJson" TEXT NOT NULL DEFAULT '[]',
    "questionsJson" TEXT NOT NULL DEFAULT '[]',
    "successCriteriaJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "demo_call_scripts_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "demo_call_profiles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "demo_call_scripts_profileId_idx" ON "demo_call_scripts"("profileId");

INSERT INTO "demo_call_voices" (
    "id", "name", "description", "gender", "elevenLabsVoiceId", "communicationModifier", "sortOrder", "isEnabled", "updatedAt"
) VALUES
    ('mikhail', 'Михаил', 'Спокойный и дотошный', 'male', '13JzN9jg1ViUP8Pf3uet', 'Говори неторопливо, уточняй детали и проси конкретику. Используй мужской род.', 1, true, CURRENT_TIMESTAMP),
    ('sergey', 'Сергей', 'Торопится и давит', 'male', 'AkDFEBceDTNk1RLYPzi1', 'Говори коротко, настойчиво и проси ответить по существу. Используй мужской род.', 2, true, CURRENT_TIMESTAMP),
    ('anna', 'Анна', 'Сомневается и сравнивает', 'female', 'sk83Bye6Z8drwXh0KBFz', 'Задавай уточнения, проговаривай сомнения и сопоставляй варианты. Используй женский род.', 3, true, CURRENT_TIMESTAMP);

INSERT INTO "demo_call_profiles" (
    "id", "name", "age", "ageFrom", "ageTo", "character", "temperament", "patience", "replyLength", "communicationStyle", "updatedAt"
) VALUES (
    'default',
    'Профиль клиента демо-стенда',
    33,
    33,
    33,
    '',
    'calm',
    'medium',
    'detailed',
    'Говори естественно, как реальный клиент по телефону. Хочешь купить эту машину, но не понимаешь, как проверить, что она в хорошем состоянии, сколько ещё сможет проездить и есть ли риск поломки. Уточняй слабые места, цену и условия покупки. Не превращай разговор в анкету: реагируй на ответы сотрудника и спрашивай только то, что осталось непонятным.',
    CURRENT_TIMESTAMP
);

INSERT INTO "demo_call_scripts" (
    "id", "profileId", "name", "companyName", "companyDescription", "itemTitle", "context", "dataText", "objectionsJson", "questionsJson", "successCriteriaJson", "updatedAt"
) VALUES (
    'default',
    'default',
    'Демо-звонок: покупка автомобиля',
    'ООО "Тестовый салон"',
    'Автосалон проверенных автомобилей',
    'Porsche Cayenne, III 2020',
    'Хочет купить машину, но сомневается. Не понимает, надо ли покупать. А если купит, то хорошая ли она будет? Не сломается ли сразу?',
    'Тип сущности: Легковой
Название: Porsche Cayenne, III 2020
Данные:
- vin: WP1ZZZ9YZMDA14014
- make: Porsche
- model: Cayenne, III
- year: 2020
- comment: Данный автомобиль в наличии, в свободной продаже

ПРЕИМУЩЕСТВА:
- Один собственник
- Прозрачная история эксплуатации
- Пробег подтвержден нашей диагностикой
- Родное лакокрасочное покрытие
- 2 ключа

КОМПЛЕКТАЦИЯ:
- Двухзонный климат-контроль
- Адаптивная оптика
- Start/Stop
- Черный потолок
- Пневмоподвеска
- Электропривод крышки багажника
- Легкосплавные диски R-21
- Бортовой компьютер
- Датчик света
- Проекционный дисплей
- Навигационная система
- CarPlay
- Адаптивный круиз-контроль
- Сиденья с регулировкой в 18 положениях
- Sport Chrono
- Drive Modes
- Обогрев зеркал
- Камера заднего вида
- Центральный замок
- Контроль слепых зон
- Усилитель рулевого управления
- Подогрев руля
- Электрообогрев лобового стекла
- Подогрев сидений
- Мультируль
- Парктроники спереди и сзади

- Цена: 6 151 444 рублей
- Пробег: 151 189 км
- Владельцев: 1
- ПТС: оригинал
- Цвет: черный
- Кузов: внедорожник
- Двигатель: гибридный, 462 л.с.
- Трансмиссия: автомат
- Привод: полный
- Состояние: отличное
- Наличие: в наличии
- Категория: подержанный
- Версия: E-Hybrid 3.0hyb AT (462 л.с.) 4WD
- Комплектация: Cayenne E-Hybrid
- Адрес: Калужское шоссе, 21-й километр, 3
- Возможен торг: да
- Телефон продавца: +7 495 165-05-69
- Дата поступления: 7 мая 2026 года
- Статус поступления: комиссия',
    '[{"id":"demo-objection-price","phrase":"Видел дешевле у конкурентов","whenAppropriate":"В любом случае"}]',
    '[{"id":"demo-question-damage","text":"Есть ли сколы на автомобиле?","required":true},{"id":"demo-question-installment","text":"Можно ли купить в рассрочку?","required":true},{"id":"demo-question-documents","text":"Какие документы нужны при оформлении?","required":true}]',
    '[{"id":"demo-criterion-damage","sourceType":"question","sourceId":"demo-question-damage","expectedAnswer":"Косметический окрас или сколов нет","score":100},{"id":"demo-criterion-installment","sourceType":"question","sourceId":"demo-question-installment","expectedAnswer":"Да, возможно купить в рассрочку","score":80},{"id":"demo-criterion-documents","sourceType":"question","sourceId":"demo-question-documents","expectedAnswer":"Паспорт","score":20},{"id":"demo-criterion-discount","sourceType":"objection","sourceId":"demo-objection-price","expectedAnswer":"Можем предложить скидку","score":80}]',
    CURRENT_TIMESTAMP
);
