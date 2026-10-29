export const REGRESSION_CHECKLIST = [
  ['automation', 'Молчит во время IVR, автоприветствия и музыки; выходит из IVR'],
  ['turns', 'Дожидается ответа; естественная пауза'],
  ['audio', 'Реплики слышны целиком, звук без обрывов и искажений'],
  ['loops', 'Не зацикливает фразы'],
  ['interruption', 'Останавливается при перебивании и продолжает с учётом услышанного'],
  ['questions', 'Не задаёт лишних встречных вопросов'],
  ['technical', 'Нет технических фраз'],
  ['identity', 'Постоянные имя и род, включая женский профиль'],
  ['pronunciation', 'Верные числа, бренды, склонения и произношение'],
  ['legend', 'Согласованная легенда, без выдуманных фактов'],
  ['relevance', 'Уточняет неотвеченный вопрос и принимает полный ответ'],
  ['changes', 'Реагирует на изменение имени, модели и года'],
  ['long-answer', 'Понимает развёрнутый ответ с внутренними паузами'],
  ['answers', 'Отвечает на все вопросы менеджера'],
  ['situations', 'Перезвон, перевод, ожидание и вопрос о роботе'],
  ['script', 'Соблюдает вопросы, возражения и порядок сценария'],
  ['ending', 'Единое естественное прощание и корректное завершение'],
] as const;
export type CheckId = typeof REGRESSION_CHECKLIST[number][0];
export type RegressionStep = {
  text?: string;
  silenceMs?: number;
  musicMs?: number;
  pauseAfterMs?: number;
  wait?: 'response' | 'quiet' | 'none' | 'hangup';
  overlap?: 'ack' | 'interrupt';
};
export type RegressionScenario = {
  id: string;
  title: string;
  checks: CheckId[];
  persona?: string;
  steps: RegressionStep[];
};

/** A goodbye after an already-completed call is optional, not missing coverage. */
export function hasOnlyFarewellSteps(steps: readonly RegressionStep[]): boolean {
  return steps.every((step) => step.wait === 'hangup' && Boolean(step.text)
    && hasNaturalFarewell(step.text!) && !step.text!.includes('?')
    && !step.musicMs && !step.silenceMs && !step.overlap);
}

export function selectRegressionScenarios(subject: string, selection: { scenarioIds?: string[]; checkIds?: string[] } = {}): RegressionScenario[] {
  const all = regressionScenarios(subject);
  if (selection.scenarioIds && selection.checkIds) throw new Error('Выберите либо пункты чеклиста, либо сценарии.');
  if (selection.scenarioIds) {
    if (!selection.scenarioIds.length || selection.scenarioIds.some((id) => !all.some((s) => s.id === id))) throw new Error('Выбран неизвестный сценарий или пустой список сценариев.');
    return all.filter((s) => selection.scenarioIds!.includes(s.id));
  }
  if (selection.checkIds) {
    if (!selection.checkIds.length || selection.checkIds.some((id) => !REGRESSION_CHECKLIST.some(([key]) => key === id))) throw new Error('Выбран неизвестный пункт или пустой список проверок.');
    return all.filter((s) => s.checks.some((id) => selection.checkIds!.includes(id)));
  }
  return all;
}

export function regressionScenarios(subject: string): RegressionScenario[] {
  const greeting = { text: 'Алло. Добрый день, отдел продаж, меня зовут Никита, слушаю вас.', wait: 'response' as const };
  return [
    { id: 'ivr', title: 'IVR, музыка и живой сотрудник', checks: ['automation'], steps: [
      { text: 'Вас приветствует автосалон. Для связи с отделом продаж нажмите один. Для сервиса нажмите два.', wait: 'quiet' },
      { musicMs: 3000, wait: 'none' }, greeting,
    ] },
    { id: 'introduction', title: 'Приветствие и длинный ответ с паузами', checks: ['turns', 'long-answer'], steps: [
      { text: 'Алло, добрый день.', pauseAfterMs: 300, wait: 'none' },
      { text: 'Меня зовут Никита, я менеджер отдела продаж, чем могу помочь?', wait: 'response' },
      { text: 'Да, автомобиль в наличии. По состоянию смотрите, за последний год мы', pauseAfterMs: 500, wait: 'none' },
      { text: 'поменяли масло и фильтры, а ещё', pauseAfterMs: 450, wait: 'none' },
      { text: 'сделали диагностику двигателя. Ошибок нет, заказ-наряды можем показать.', wait: 'response' },
    ] },
    { id: 'acknowledgement', title: '«Угу» во время ответа', checks: ['interruption', 'audio'], steps: [
      { ...greeting, overlap: 'ack' },
      { text: 'Да, автомобиль в наличии, всё актуально.', wait: 'response' },
    ] },
    { id: 'interruption', title: 'Содержательное перебивание', checks: ['interruption'], steps: [
      { ...greeting, overlap: 'interrupt' },
      { text: 'Я хотел уточнить: вы спрашивали о наличии или о пробеге?', wait: 'response' },
    ] },
    { id: 'female', title: 'Женский профиль, имя и несколько вопросов', checks: ['identity', 'answers', 'legend'],
      persona: 'Для этого изолированного теста ты Анна, женщина. Отвечай о себе в женском роде. Бюджет 2 250 000 рублей, покупка в течение месяца, сейчас ездишь на Киа Рио 2018 года. Других данных о личной жизни нет: не выдумывай их, при необходимости естественно скажи, что пока не определилась.',
      steps: [greeting,
        { text: 'Автомобиль есть. Как вас зовут, какой у вас бюджет и какой автомобиль сейчас эксплуатируете?', wait: 'response' },
        { text: 'Слушайте, Алексей, а покупать будете за наличные или в кредит? И когда планируете покупку?', wait: 'response' },
        { text: 'Да, Нина, понял. А как зовут вашего супруга и сколько у вас детей?', wait: 'response' },
      ] },
    { id: 'changes', title: 'Другая марка, год и новое имя менеджера', checks: ['changes', 'relevance'], steps: [greeting,
      { text: 'Да, у Волги пробег тридцать тысяч километров.', wait: 'response' },
      { text: `Извините, перепутал карточку, говорим про ${subject}. Но год выпуска в объявлении неверный: на самом деле две тысячи двадцать четвёртый.`, wait: 'response' },
      { text: 'И поправка: меня зовут не Никита, а Антон. Обращайтесь ко мне Антон.', wait: 'response' },
      { text: 'Да, пробег тридцать тысяч километров, актуальный, подтверждён сервисной историей.', wait: 'response' },
    ] },
    { id: 'hold', title: 'Ожидание и перевод на другого сотрудника', checks: ['automation', 'situations', 'identity'], steps: [greeting,
      { text: 'Подождите, пожалуйста, сейчас переведу на другого сотрудника. Оставайтесь на линии.', wait: 'quiet' },
      { musicMs: 3000, wait: 'none' },
      { text: 'Алло, отдел продаж, меня зовут Сергей, коллега передал ваш звонок. Чем могу помочь?', wait: 'response' },
      { text: 'А вы робот или живой человек?', wait: 'response' },
    ] },
    { id: 'numbers', title: 'Числа, модель, противоречивый ответ', checks: ['pronunciation', 'relevance', 'legend'], steps: [greeting,
      { text: 'Цена два миллиона двести пятьдесят тысяч рублей. Повторите, пожалуйста, какая цена и по какой машине вы звоните?', wait: 'response' },
      { text: 'Который было не в любое время.', wait: 'response' },
      { text: 'По цене сейчас не могу уточнить, карточку нужно проверить. Могу сказать только про комплектацию: есть климат-контроль и круиз-контроль.', wait: 'response' },
    ] },
    { id: 'callback', title: 'Просьба перезвонить и завершение', checks: ['situations', 'ending', 'technical'], steps: [greeting,
      { text: 'Я сейчас занят. Перезвоните, пожалуйста, завтра после десяти утра.', wait: 'response' },
      { text: 'Да, договорились, до свидания.', wait: 'hangup' },
    ] },
    { id: 'script', title: 'Полный сценарий с ответами менеджера', checks: ['script', 'questions', 'loops', 'ending'], steps: [greeting] },
  ];
}

/** Deterministic manager replies, chosen from the question actually asked. */
export function managerReplyTo(text: string, subject: string): string {
  if (/(?:до свидания|всего доброго|хорошего дня)/iu.test(text)) return 'Спасибо, до свидания.';
  if (/как.*(?:зовут|обращаться)/iu.test(text)) return 'Меня зовут Никита.';
  // Specific facts take priority over generic "актуально"/"объявление".
  if (/(?:пробег|километр)/iu.test(text)) return 'Пробег тридцать тысяч километров, он актуальный и подтверждён сервисной историей.';
  if (/(?:актуаль|в наличии|продан|не ушла)/iu.test(text)) return `Да, ${subject} в наличии, объявление актуально.`;
  if (/(?:дтп|авари|красил|окрас)/iu.test(text)) return 'ДТП не было, кузов в заводском окрасе, готов показать отчёт.';
  if (/(?:порог|корроз|гнил|состояни|неисправ|проблем|ремонт|обслуж)/iu.test(text)) return 'Коррозии и неисправностей нет. Последнее обслуживание было в мае: заменили масло и фильтры, документы есть.';
  if (/(?:владел|собственник|птс)/iu.test(text)) return 'Один собственник, владел три года, ПТС оригинал.';
  if (/(?:скид|скинут|торг|цен|стоим)/iu.test(text)) return 'Цена два миллиона двести пятьдесят тысяч рублей. Возможен торг до пяти процентов после осмотра.';
  if (/(?:пришл|присла|отч[её]т|мессенджер)/iu.test(text)) return 'Да, отчёт по кузову и истории можем отправить в мессенджер на номер, с которого вы звоните.';
  if (/(?:адрес|улиц|находит|точка)/iu.test(text)) return 'Наш адрес: улица Пушкина, дом один.';
  if (/(?:приех|подъех|посмотр|встреч|во сколько|когда|сегодня)/iu.test(text)) return 'Да, приезжайте сегодня к семнадцати часам, менеджер будет на месте. Адрес: улица Пушкина, дом один.';
  return 'Да, всё верно. Уточните, пожалуйста, что именно вас интересует по автомобилю?';
}
import { hasNaturalFarewell } from './hypothesis2Closing';

