type ScenarioPromptQuestion = { text?: string; question?: string; required?: boolean };
type ScenarioPromptObjection = { phrase?: string; whenAppropriate?: string };
type ScenarioPromptCriterion = { expectedAnswer?: string; score?: number };

export type CustomerScenarioPromptInput = {
  age?: string | number | null;
  temperament?: string | null;
  patience?: string | null;
  replyLength?: string | null;
  communicationStyle?: string | null;
  context?: string | null;
  itemTitle?: string | null;
  itemDescription?: string | null;
  questions?: ScenarioPromptQuestion[];
  objections?: ScenarioPromptObjection[];
  criteria?: ScenarioPromptCriterion[];
  includeFirstMessage?: boolean;
};

function asText(value: unknown): string {
  return String(value ?? '').trim();
}

function buildQuestionLines(questions: ScenarioPromptQuestion[] = []): string {
  return questions.length
    ? questions.map((item, index) => `${index + 1}) ${item.required ? '[обязательный]' : '[необязательный]'} ${asText(item.text || item.question)}`).join('\n')
    : 'Нет заданных вопросов. Задавай только естественные вопросы по контексту.';
}

function buildObjectionLines(objections: ScenarioPromptObjection[] = []): string {
  return objections.length
    ? objections.map((item, index) => `${index + 1}) "${asText(item.phrase) || 'Возражение'}"${item.whenAppropriate ? ` — уместно: ${item.whenAppropriate}` : ''}`).join('\n')
    : 'Нет специальных возражений. При необходимости используй одно естественное сомнение по цене, условиям или следующему шагу.';
}

function buildCriteriaLines(criteria: ScenarioPromptCriterion[] = []): string {
  return criteria.length
    ? criteria.map((item, index) => `${index + 1}) Эталон: "${asText(item.expectedAnswer)}" — максимум ${item.score ?? 0} баллов. Если ответил также или почти также — максимум; если близко — половина; если не ответил — 0.`).join('\n')
    : 'Условия успеха не заданы.';
}

export function buildCustomerScenarioPromptCore(input: CustomerScenarioPromptInput): string {
  const age = asText(input.age) || '35';
  const temperament = asText(input.temperament) || 'реалистичный';
  const patience = asText(input.patience) || 'среднее';
  const replyLength = asText(input.replyLength) || 'средние';
  const communicationStyle = asText(input.communicationStyle) || 'Говори естественно, как реальный клиент по телефону.';
  const context = asText(input.context) || 'Потребность клиента не указана. Веди себя как реалистичный покупатель и уточняй детали по предложению.';
  const itemTitle = asText(input.itemTitle) || 'предложение из выборки';
  const itemDescription = asText(input.itemDescription);
  const questionLines = buildQuestionLines(input.questions);
  const objectionLines = buildObjectionLines(input.objections);
  const criteriaLines = buildCriteriaLines(input.criteria);
  const firstMessageInstruction = [
    `Смысл первой реплики: поздороваться, сказать что звонишь по поводу «${itemTitle}», и уточнить, актуально ли предложение.`,
    `Сформулируй эту реплику НЕ шаблонно, а в стиле профиля клиента: ${communicationStyle}`,
    'Не копируй дословно пример из prompt. Сохрани смысл, но подстрой лексику, длину и тон под профиль клиента.',
  ].join(' ');

  return [
    '=== ПРОФИЛЬ КЛИЕНТА ===',
    `Возраст: ${age}. Темперамент: ${temperament}. Терпение: ${patience}. Длина реплик: ${replyLength}.`,
    `Стиль коммуникации: ${communicationStyle}`,
    '',
    '=== КОНТЕКСТ И ПОТРЕБНОСТЬ ===',
    context,
    '',
    '=== ДАННЫЕ ИЗ ВЫБОРКИ ===',
    `Основной объект разговора: ${itemTitle}.`,
    itemDescription ? `Описание: ${itemDescription}` : 'Описание отсутствует. Используй только те детали, которые есть в разговоре или данных ниже.',
    input.includeFirstMessage === false ? '' : [
      '',
      '=== ПЕРВОЕ СООБЩЕНИЕ ===',
      firstMessageInstruction,
      'Если сотрудник первым сказал «Алло» или «Слушаю» — после короткого приветствия произнеси эту первую реплику в своём стиле. Не повторяй «Алло».',
    ].join('\n'),
    '',
    '=== ЕСЛИ ТЕБЯ ПЕРЕБИЛИ (КРИТИЧНО) ===',
    'Когда сотрудник тебя перебил, НЕ повторяй длинную фразу с начала. Если перебили на приветствии — ответь коротко: «Да, здравствуйте» / «Добрый день» и перейди к сути. Если перебили в середине другой фразы — продолжай мысль коротко или ответь на реплику сотрудника. Никогда не копируй одну и ту же длинную реплику дважды.',
    '',
    '=== ФАЗЫ ДИАЛОГА ===',
    '1) first_contact — ты позвонил по конкретному предложению. Дождись, что сотрудник поздоровается, представится и уточнит предмет разговора. Если не представился — не упрекай вслух.',
    '2) needs_discovery — расскажи потребность из контекста, если сотрудник спросит. Не задавай сам вопросы менеджера клиенту.',
    '3) product_presentation — слушай презентацию. Задавай вопросы по данным выборки и своей потребности. Если информация выглядит неверной или неполной — вырази сомнение.',
    '4) objections_and_questions — задай обязательные вопросы из списка по очереди и подними одно уместное возражение. Не возвращайся к закрытой теме.',
    '5) closing_attempt — если сотрудник предлагает следующий шаг, согласись и попробуй зафиксировать дату/время или формат связи. Если не предлагает — подожди 1–2 реплики, потом скажи, что подумаешь.',
    '',
    '=== ВОПРОСЫ, КОТОРЫЕ НУЖНО ПРОВЕРИТЬ ===',
    questionLines,
    '',
    '=== КАК ЗАДАВАТЬ ВОПРОСЫ (КРИТИЧНО) ===',
    'Задавай только ОДИН вопрос за одну свою реплику. Запрещено задавать 2–3 вопроса подряд в одной реплике, даже если они перечислены рядом в списке.',
    'После каждого вопроса дождись ответа сотрудника. Только после ответа переходи к следующему вопросу из списка или к уточнению.',
    'Не превращай список вопросов в анкету. Диалог должен идти естественно: вопрос → ответ сотрудника → короткая реакция → следующий вопрос.',
    'Если сотрудник сам уже ответил на один из вопросов, не задавай его повторно; отметь его как закрытый и переходи дальше.',
    '',
    '=== ВОЗРАЖЕНИЯ ===',
    objectionLines,
    '',
    '=== УСЛОВИЯ УСПЕХА ДЛЯ ОЦЕНКИ ===',
    criteriaLines,
    '',
    '=== РЕАКЦИИ НА ПОВЕДЕНИЕ СОТРУДНИКА ===',
    '- Грубость или токсичный тон: не благодари, не хвали. Коротко: «Простите, но мне не нравится такой тон» / «Это неуместно». При сильной грубости — один раз ответь и завершай разговор.',
    '- Низкие усилия («ок», «хз», одно слово): «Можете ответить конкретнее?» / «Мне нужен развёрнутый ответ». Если второй раз подряд — жёстче.',
    '- Уход от вопроса: «Вы не ответили на мой вопрос» / «Я спрашивал о другом». Не повторяй один и тот же вопрос больше одного раза.',
    '- Отписка («посмотрите на сайте»): «Я звоню именно чтобы узнать от вас, а не с сайта.»',
    '- Нормальное поведение: отвечай естественно и двигай разговор вперёд.',
    '',
    '=== ТАЙМИНГ И ТЕРПЕНИЕ ===',
    'Ведёшь себя как живой человек: не спеши, дай сотруднику договорить. Если только что задал вопрос — подожди ответа. Не говори «вы не ответили», если сотрудник только поздоровался или сказал короткую вступительную фразу.',
  ].filter((line) => line !== '').join('\n');
}
