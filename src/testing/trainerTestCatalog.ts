// Pure catalog shared by runner and UI. Numeric order matches the agreed checklist.
export const TRAINER_TEST_CHECKS = [
  ['trainer-voice', 'Голос и пол клиента постоянны'], ['trainer-audio', 'Голосовые слышны целиком, без обрывов'],
  ['trainer-responses', 'Один ответ на сообщение, без молчания и зацикливания'], ['trainer-identity', 'Постоянные имя и род, включая женский профиль'],
  ['trainer-pronunciation', 'Верные числа, бренды, склонения и произношение'], ['trainer-delivery', 'Естественная длина и вопросительная интонация'],
  ['trainer-technical', 'Нет технических фраз'], ['trainer-role', 'Остаётся клиентом, не подсказывает и не оценивает менеджера'],
  ['trainer-questions', 'Нет лишних встречных вопросов'], ['trainer-legend', 'Легенда непротиворечива, без выдумок'],
  ['trainer-personality', 'Тон соответствует профилю клиента'], ['trainer-answers', 'Отвечает на все вопросы менеджера'],
  ['trainer-relevance', 'Уточняет неполный ответ и принимает полный'], ['trainer-changes', 'Замечает смену имени, модели, года и комплектации'],
  ['trainer-long-answer', 'Учитывает развёрнутое сообщение целиком'], ['trainer-repeat', 'Адекватно реагирует на просьбу повторить'],
  ['trainer-correction', 'Учитывает исправленное голосовое, не отвечает на обе версии'],
  ['trainer-script', 'Все вопросы и возражения сценария, без раннего завершения'], ['trainer-loops', 'Не повторяет уже закрытые вопросы и возражения'],
  ['trainer-ending', 'Естественное прощание после последнего пункта'],
] as const;
export type TrainerCheckId = typeof TRAINER_TEST_CHECKS[number][0];
export const TRAINER_TEST_GROUPS = [
  { id: 'trainer-voice-group', title: 'Голос и подача', description: 'Пункты 1–6: стабильность голоса, слышимость и речь', checks: TRAINER_TEST_CHECKS.slice(0, 6).map(([id]) => id) },
  { id: 'trainer-role-group', title: 'Роль клиента', description: 'Пункты 7–11: роль, легенда и характер', checks: TRAINER_TEST_CHECKS.slice(6, 11).map(([id]) => id) },
  { id: 'trainer-answers-group', title: 'Работа с ответами менеджера', description: 'Пункты 12–17: понимание, уточнения и исправления', checks: TRAINER_TEST_CHECKS.slice(11, 17).map(([id]) => id) },
  { id: 'trainer-flow-group', title: 'Ход тренировки', description: 'Пункты 18–20: сценарий, повторы и завершение', checks: TRAINER_TEST_CHECKS.slice(17).map(([id]) => id) },
];
export type TrainerTestScenario = { id: string; title: string; checks: TrainerCheckId[]; female?: boolean; steps: Array<string | 'adaptive' | { correction: [string, string] }> };
const trainerScenarios: TrainerTestScenario[] = [
  { id: 'trainer-dialogue', title: 'Обычный диалог и голосовые ответы', checks: ['trainer-voice', 'trainer-audio', 'trainer-responses', 'trainer-delivery', 'trainer-technical', 'trainer-role', 'trainer-questions', 'trainer-personality'], steps: ['Здравствуйте! Меня зовут Алексей. Слушаю вас.', 'adaptive', 'adaptive'] },
  { id: 'trainer-female', title: 'Женский профиль, имя и легенда', female: true, checks: ['trainer-voice', 'trainer-identity', 'trainer-legend', 'trainer-answers'], steps: ['Здравствуйте. Как вас зовут? Вы уже смотрели этот автомобиль? Какой у вас бюджет и когда планируете покупку?', 'Напомните, пожалуйста, ваше имя и какой автомобиль у вас сейчас? Есть ли дети? Если не хотите обсуждать личное, так и скажите.', 'adaptive'] },
  { id: 'trainer-numbers', title: 'Числа, Esteo и Kia Carnival', checks: ['trainer-pronunciation', 'trainer-delivery', 'trainer-changes'], steps: ['Цена автомобиля — 6 405 000 рублей, шесть миллионов четыреста пять тысяч. Повторите, пожалуйста, какую сумму вы услышали?', 'А вместо выбранной модели предлагаю Esteo или Kia Carnival. Это же та самая модель, которую вы хотели, верно?', 'adaptive'] },
  { id: 'trainer-context', title: 'Длинный ответ, несколько вопросов и подмена данных', checks: ['trainer-answers', 'trainer-long-answer', 'trainer-changes', 'trainer-legend'], steps: ['Здравствуйте, меня зовут Алексей. Автомобиль в наличии. Сначала уточню: когда планируете покупку, какая форма оплаты и есть ли автомобиль на обмен? Если пока не решили, так и скажите.', 'Сначала про состояние: проводили диагностику, критических замечаний нет. Затем про комплектацию: список опций направлю отдельно. И последнее — цена по объявлению сохраняется, никаких обязательных кредитов и скрытых доплат нет. Подтвердите, пожалуйста, что услышали все три момента.', 'Кстати, я назвал неверное имя: меня зовут не Алексей, а Дмитрий. А машину сейчас обсуждаем другую — другого года и в базовой комплектации, правильно?', 'adaptive'] },
  { id: 'trainer-clarify', title: 'Уход от ответа, уточнение и просьба повторить', checks: ['trainer-relevance', 'trainer-repeat', 'trainer-loops', 'trainer-role'], steps: ['Здравствуйте. Прежде чем ответить, расскажу о нашей компании и о прекрасной погоде.', 'Извините, отвлёкся и не расслышал ваш вопрос. Повторите, пожалуйста.', 'adaptive', 'Да, вы правильно поняли мой предыдущий ответ. Дополнений к нему нет.'] },
  { id: 'trainer-correction', title: 'Два отдельных голосовых: исправление до ответа', checks: ['trainer-correction', 'trainer-responses'], steps: [{ correction: ['Стоимость — 640 500 рублей.', 'Поправлюсь: ошибся на порядок. Стоимость — 6 405 000 рублей, шесть миллионов четыреста пять тысяч. Верна только эта последняя сумма.'] }, 'Какую итоговую стоимость вы запомнили?'] },
  { id: 'trainer-script', title: 'Полный сценарий и естественное завершение', checks: ['trainer-script', 'trainer-loops', 'trainer-ending', 'trainer-technical', 'trainer-personality'], steps: Array.from({ length: 14 }, () => 'adaptive' as const) },
];
export const TRAINER_TEST_SCENARIOS: TrainerTestScenario[] = trainerScenarios.map((scenario) =>
  ['trainer-female', 'trainer-context'].includes(scenario.id) ? { ...scenario, checks: [...scenario.checks, 'trainer-personality'] } : scenario);
export function selectTrainerTestScenarios(selection: { checkIds?: string[]; scenarioIds?: string[] } = {}) {
  if (selection.checkIds !== undefined && selection.scenarioIds !== undefined) throw new Error('Выберите пункты или сценарии, не оба списка.');
  for (const [values, allowed] of [[selection.checkIds, TRAINER_TEST_CHECKS.map(([id]) => id)], [selection.scenarioIds, TRAINER_TEST_SCENARIOS.map((item) => item.id)]] as const) {
    if (values !== undefined && (!Array.isArray(values) || !values.length || values.some((id) => typeof id !== 'string' || !allowed.includes(id as never)))) throw new Error('Пустой список или неизвестный пункт/сценарий тренировки.');
  }
  return TRAINER_TEST_SCENARIOS.filter((item) => (!selection.scenarioIds || selection.scenarioIds.includes(item.id)) && (!selection.checkIds || item.checks.some((id) => selection.checkIds!.includes(id))));
}
