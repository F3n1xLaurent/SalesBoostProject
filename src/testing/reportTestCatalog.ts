// Source: «Чек-лист: расшифровка и отчёт тренажёра», 29 items, Salsa 26.10.2026.
// Pure data: also imported by the browser. Documents are test specifications, not prompts.
export const REPORT_BUILTIN_SUITE_ID = 'report-builtin-v1';
export const REPORT_FIXTURE_VERSION = '2026-10-30.1';
export const REPORT_TEST_CHECKS = [
  ['report-transcription', 'Расшифровка голосовых менеджера точная', 'Сверить аудио с текстом; искажённое распознавание не должно становиться основанием для «Ушёл от вопроса» или «Плохо».'],
  ['report-entities', 'Числа, годы, суммы, время и названия переданы верно', 'SAL-5, SAL-9: до 300 тыс. ₽, 18:00, Zeekr, Coolray, Esteo, Exlantix, Volga и имя. Искажение не должно становиться замечанием менеджеру.'],
  ['report-asr-uncertainty', 'Спорное распознавание не считается ошибкой менеджера', 'SAL-5: вероятный сбой ASR («за 2006 год») без явных доказательств не снижает оценку всей реплики.'],
  ['report-roles', 'Реплики приписаны верной роли', 'Клиент и менеджер не перепутаны; для проверки реального разделения говорящих нужна запись.'],
  ['report-all-turns', 'Каждая реплика менеджера оценена', 'У каждой реплики менеджера есть метка и содержательный комментарий.'],
  ['report-whole-turn', 'Оценка отражает реплику целиком', 'SAL-5: одна мелкая неточность не превращает развёрнутый сильный ответ целиком в «Плохо».'],
  ['report-equivalent', 'Ответ, совпадающий по смыслу с примером, не получает «Плохо»', 'SAL-7: нельзя ругать то, что сам пример рекомендует, или преувеличивать расхождение.'],
  ['report-short-closing', 'Односложное незакреплённое завершение оценено строго', 'SAL-3: «Ждём» после подтверждения визита без закрепления времени, адреса и контакта требует строгого замечания.'],
  ['report-credit-actions', 'Засчитаны выполненные действия и отдельно названы пробелы', 'SAL-9: нельзя писать «сумма/выгода не названа», если они есть в реплике.'],
  ['report-mark-findings', 'Метки реплик не противоречат находкам', 'Положительная метка не сочетается с негативной находкой по той же реплике.'],
  ['report-comment-example', 'Комментарий не противоречит примеру ответа', 'SAL-7: пример не повторяет именно то, что критикует комментарий.'],
  ['report-example-present', 'У «Можно лучше» и «Плохо» есть пример ответа', 'SAL-3: normal/negative без содержательного «Как лучше» — ошибка.'],
  ['report-known-context', 'Пример учитывает уже известный запрос клиента', 'SAL-2: не задаёт «Чем могу помочь?», когда запрос уже назван; не использует будущие сведения.'],
  ['report-all-conditions', 'Пример отвечает по существу и покрывает все условия', 'SAL-6: снег, дождь и загрязнение датчиков; нельзя заменить ответы одним встречным вопросом.'],
  ['report-one-question', 'В примере не больше одного полезного уточнения', 'SAL-6: не более одного уточняющего вопроса; не переспрашивать уже известное.'],
  ['report-preserve-strengths', 'Пример сохраняет сильные стороны и цифры', 'SAL-5, SAL-8, SAL-9: не теряет сумму, прямой ответ или согласованный следующий шаг.'],
  ['report-answer-bridge-slot', 'Пример: ответ → связка → конкретный следующий шаг', 'SAL-8: сначала ответ по существу, затем связка и конкретный слот, не широкий интервал. Только подтверждённые данные или честное уточнение.'],
  ['report-all-problems', 'Пример закрывает все проблемы реплики', 'SAL-4: недостаточно исправить представление, пропустив опасения клиента.'],
  ['report-better-only', 'Пример показывается, только если лучше оригинала', 'SAL-5: к сильной реплике не предлагается худший ответ или отсрочка вместо ответа по существу.'],
  ['report-single-example', 'Один и тот же пример на реплику во всех блоках', 'SAL-4: «Как лучше» в находках совпадает с примером в транскрипте, а не даёт альтернативные правильные ответы.'],
  ['report-grounded-strengths', 'Сильные стороны подтверждены действиями менеджера', 'Нельзя хвалить за пункт сценария, которого не было в диалоге.'],
  ['report-no-duplicates', 'Нет дублирующихся находок', 'Почти одинаковые выводы с одинаковым примером не дублируются; разные ошибки одной реплики допустимы.'],
  ['report-changes', 'Подмена модели, имени или года отражена в находках', 'Смена данных не только в резюме: нужна отдельная конкретная находка.'],
  ['report-main-problem', 'Главная ошибка названа точно', 'SAL-2: нельзя ограничиться отсутствием представления, пропустив неотвеченный вопрос клиента.'],
  ['report-summary', 'Резюме согласовано с находками, метками и баллом', 'Все части отчёта описывают один диалог и согласуются с рассчитанным баллом.'],
  ['report-strength-blocks', 'Сильные и слабые стороны резюме вынесены в отдельные блоки', 'Стороны не потеряны, не перепутаны местами и подтверждены диалогом.'],
  ['report-tooltip', 'Иконка (i) показывает подсказку или убрана', 'SAL-1: проверить hover на десктопе и нажатие на мобильном; текстовая проверка не подтверждает поведение интерфейса.'],
  ['report-consistent-data', 'Имя, модель, сумма и время согласованы между блоками', 'Итог, находки и транскрипт не противоречат друг другу по фактам.'],
  ['report-regression', 'Кейсы ошибок сохранены в регрессионном наборе', 'SAL-1–9: сохранять вход, результат и ID; после правки повторять соответствующий кейс и сравнивать. Отсутствие старого запуска не доказывает исправление.'],
] as const;
export type ReportCheckId = typeof REPORT_TEST_CHECKS[number][0];
export const REPORT_TEST_GROUPS = [
  { id: 'report-transcript', title: 'Расшифровка', description: 'Пункты 1–4 · текст, факты и роли', checks: REPORT_TEST_CHECKS.slice(0, 4).map(([id]) => id) },
  { id: 'report-marks', title: 'Оценка реплик', description: 'Пункты 5–11 · полнота и обоснованность', checks: REPORT_TEST_CHECKS.slice(4, 11).map(([id]) => id) },
  { id: 'report-examples', title: 'Примеры «Как лучше»', description: 'Пункты 12–19 · контекст и полезность', checks: REPORT_TEST_CHECKS.slice(11, 19).map(([id]) => id) },
  { id: 'report-findings', title: 'Находки и итог', description: 'Пункты 20–26 · единый непротиворечивый разбор', checks: REPORT_TEST_CHECKS.slice(19, 26).map(([id]) => id) },
  { id: 'report-ui', title: 'Интерфейс и регрессия', description: 'Пункты 27–29 · согласованность и повторяемость', checks: REPORT_TEST_CHECKS.slice(26).map(([id]) => id) },
];
export type ReportFixture = {
  id: string; title: string; source: 'call' | 'trainer'; checks: ReportCheckId[];
  transcript: Array<{ role: 'client' | 'manager'; text: string }>;
  expected: string[];
  transcriptionAlternatives?: Array<{ turnIndex: number; original: string; reviewed: string }>;
};
const common: ReportCheckId[] = ['report-all-turns', 'report-mark-findings', 'report-example-present', 'report-better-only', 'report-single-example', 'report-grounded-strengths', 'report-no-duplicates', 'report-summary', 'report-strength-blocks', 'report-consistent-data', 'report-regression'];
const client = (text: string) => ({ role: 'client' as const, text });
const manager = (text: string) => ({ role: 'manager' as const, text });
const cases: Array<Omit<ReportFixture, 'source'>> = [
  { id: 'strong', title: 'Сильный ответ, выгода и конкретный визит', checks: ['report-whole-turn', 'report-equivalent', 'report-credit-actions', 'report-comment-example', 'report-preserve-strengths', 'report-answer-bridge-slot'],
    transcript: [client('Здравствуйте, я Мария. Интересует Mercedes-Benz GLE 2023 года за 6 405 000 рублей. Есть ли доплаты? Могу приехать завтра в 18:00.'), manager('Добрый день, Мария! Автоцентр «Тест», меня зовут Дмитрий. GLE 2023 года в наличии. Цена 6 405 000 рублей, обязательных доплат нет. На дополнительные услуги можно получить выгоду до 300 тысяч рублей, условия посчитаем отдельно. Завтра в 18:00 запишу вас на осмотр по адресу Тестовая, 10. Независимая диагностика разрешена. Удобно отправить подтверждение на этот номер?'), client('Да, номер мой, присылайте подтверждение.'), manager('Мария, договорились: завтра в 18:00, Тестовая, 10. Отправлю подтверждение и мой контакт. Спасибо, до встречи!')],
    expected: ['Цена 6 405 000, а не 640 500; выгода ДО 300 000 на услуги, не гарантированная скидка на автомобиль.', 'Менеджер представился и назвал компанию; подтвердил визит, адрес и контакт.', 'Не ругать за отсутствующие приветствие, сумму, выгоду или запись, не ухудшать сильный ответ.'] },
  { id: 'asr', title: 'Спорное распознавание года и длинный ответ', checks: ['report-transcription', 'report-entities', 'report-asr-uncertainty', 'report-roles', 'report-whole-turn', 'report-credit-actions', 'report-tooltip'],
    transcript: [client('Меня зовут Мария, смотрю GLE 2023 года. Уточните цену, пробег и обслуживание.'), manager('Здравствуйте, Мария, я Дмитрий из компании «Тест». GLE 2023 года, пробег 18 000 километров, цена 6 405 000 рублей. Последнее обслуживание за 2023 год подтверждено документами, могу прислать заказ-наряды. Обязательных доплат нет. На осмотр можно завтра в 18:00 по адресу Тестовая, 10.'), client('Спасибо, сначала посмотрю документы.'), manager('Отправлю документы на этот номер. Если возникнут вопросы, звоните, я Дмитрий.')],
    transcriptionAlternatives: [{ turnIndex: 2, original: 'Последнее обслуживание за 2006 год подтверждено документами.', reviewed: 'Последнее обслуживание за 2023 год подтверждено документами.' }],
    expected: ['ASR-варианты 2006/2023 спорны, нельзя считать 2006 доказанной ошибкой менеджера.', 'Нет записи: точность звукового распознавания и диаризации остаётся ручной проверкой, не зелёной галочкой.'] },
  { id: 'closing', title: '«Ждём» вместо закрепления договорённости', checks: ['report-short-closing', 'report-known-context', 'report-comment-example', 'report-answer-bridge-slot'],
    transcript: [client('Здравствуйте! Можно приехать посмотреть GLE завтра в 18:00? Цена всё ещё 6 405 000 рублей?'), manager('Да, цена 6 405 000 рублей, автомобиль есть.'), client('Хорошо, завтра в шесть приеду. Пришлите адрес и контакт, пожалуйста, я Мария.'), manager('Ждём.')],
    expected: ['Последнее «Ждём» не подтверждает время, адрес и контакт; это существенный незакреплённый визит.', 'В примере сохранить цену и выбранное клиентом время; не выдумывать неизвестные адрес и личный номер менеджера.'] },
  { id: 'conditions', title: 'Дождь, снег и датчики: все условия вопроса', checks: ['report-known-context', 'report-all-conditions', 'report-one-question', 'report-preserve-strengths', 'report-all-problems', 'report-main-problem'],
    transcript: [client('Здравствуйте, я Мария. Как работают датчики и ассистенты GLE в снег, дождь и при загрязнении? Что с гарантией? Бюджет до 6 500 000, могу завтра в 18:00.'), manager('Приезжайте, всё расскажем. Когда вам удобно?'), client('Я уже сказала, завтра в 18:00. Но сначала расскажите про ограничения датчиков.'), manager('Да нормально всё.')],
    expected: ['Не отвечены ограничения в снег, дождь, загрязнение и гарантия. Не сводить главную проблему к представлению.', 'Технические характеристики и гарантия неизвестны: честно уточнить, не обещать безотказность.', 'Не переспрашивать уже названное время и не подменять ответ приглашением.'] },
  { id: 'changes', title: 'Перепутанные имя, модель и год', checks: ['report-changes', 'report-main-problem', 'report-all-problems', 'report-entities'],
    transcript: [client('Меня зовут Мария. Я по Mercedes-Benz GLE 2023 года за 6 405 000 рублей, пробег 18 000. Машина в наличии?'), manager('Здравствуйте, Мария, я Дмитрий, компания «Тест». Есть в наличии.'), client('Отлично. Что с историей обслуживания GLE?'), manager('Анна, у Haval 2020 года пробег 1838 километров, всё нормально.'), client('Я Мария и спрашивала про GLE, не Haval.'), manager('Приезжайте разберёмся.')],
    expected: ['Менеджер сначала знал имя Мария, потом назвал Анна. Ошибка имени отдельно от модели Haval и года 2020.', 'Подмена автомобиля должна быть в находках, а не только в summary.', 'Не придумывать отсутствующие документы об обслуживании.'] },
  { id: 'brands', title: 'Названия, суммы и сильный ответ с пробелом', checks: ['report-entities', 'report-whole-turn', 'report-equivalent', 'report-credit-actions', 'report-preserve-strengths', 'report-comment-example', 'report-one-question'],
    transcript: [client('Рассматриваю Zeekr, Coolray, Esteo, Exlantix и Volga. Что есть до 6 500 000 рублей? А текущую машину можно сдать?'), manager('Здравствуйте, меня зовут Дмитрий, компания «Тест». Из названного сейчас есть Coolray за 2 250 000 рублей, Zeekr и Exlantix уточню по складу. По Esteo и Volga пока нет подтверждения. Текущую машину можно оценить для обмена; по дополнительным услугам возможна выгода до 300 тысяч рублей, точные условия посчитаем. Хотите, подготовлю расчёт?'), client('Да. Мой бюджет до 6 500 000, приезжаю завтра в 18:00.'), manager('Хорошо, ждём.')],
    expected: ['Coolray 2 250 000, не 225 000; верхний бюджет 6 500 000 не равен стоимости.', 'Не обещать Zeekr/Exlantix/Esteo/Volga в наличии: менеджер честно уточняет.', 'Признать озвученные сумму и обмен; отдельно отметить незакреплённый визит.'] },
];
export const REPORT_TEST_SCENARIOS: ReportFixture[] = (['call', 'trainer'] as const).flatMap((source) => cases.map((item) => ({
  ...item, id: `${source}-${item.id}`, source, title: `${source === 'call' ? 'Звонок' : 'Тренажёр'} · ${item.title}`,
  // Calls can provide reviewed/original ASR alternatives. Trainer receives the
  // ambiguous raw version, as its current production evaluator does.
  transcript: source === 'trainer' && item.id === 'asr' ? item.transcript.map((turn, index) => index === 1 ? { ...turn, text: turn.text.replace('за 2023 год', 'за 2006 год') } : turn) : item.transcript,
  checks: [...new Set([...common, ...item.checks])],
})));
export function selectReportTestScenarios(selection: { checkIds?: string[]; scenarioIds?: string[] } = {}) {
  if (selection.checkIds !== undefined && selection.scenarioIds !== undefined) throw new Error('Выберите пункты или сценарии, не оба списка.');
  for (const [values, allowed] of [[selection.checkIds, REPORT_TEST_CHECKS.map(([id]) => id)], [selection.scenarioIds, REPORT_TEST_SCENARIOS.map((item) => item.id)]] as const) {
    if (values !== undefined && (!Array.isArray(values) || !values.length || values.some((id) => typeof id !== 'string' || !allowed.includes(id as never)))) throw new Error('Пустой список или неизвестный пункт/сценарий отчёта.');
  }
  return REPORT_TEST_SCENARIOS.filter((item) => (!selection.scenarioIds || selection.scenarioIds.includes(item.id)) && (!selection.checkIds || item.checks.some((id) => selection.checkIds!.includes(id))));
}
