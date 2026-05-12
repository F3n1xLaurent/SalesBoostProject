export type TranscriptTurn = { role: 'client' | 'manager'; text: string };

export type ChecklistStatus = 'YES' | 'PARTIAL' | 'NO' | 'NA';

export type ChecklistItem = {
  code: string;
  title: string;
  weight: number; // 0..1 relative
  status: ChecklistStatus;
  evidence?: string;
};

export type MockComputed = {
  outcome: string;
  durationSec: number;
  totalScore: number;
  qualityTag: string;
  dimensionScores: Record<string, number>;
  checklist: ChecklistItem[];
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  callSummary: {
    executiveSummary: string;
    detailedAnalysis: string;
    keyFindings: Array<{ title: string; description: string; examples?: string[] }>;
    actionPlan: Array<{ priority: string; action: string; target: string; timeline: string }>;
  };
  replyImprovements: Array<{
    order: number;
    customerMessage: string;
    managerAnswer: string;
    isOptimal: boolean;
    feedback: string;
    betterExample: string | null;
  }>;
};

function norm(s: string) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function anyIncludes(hay: string, needles: string[]) {
  const h = norm(hay);
  return needles.some((n) => h.includes(norm(n)));
}

function joinText(turns: TranscriptTurn[], role?: TranscriptTurn['role']) {
  const filtered = role ? turns.filter((t) => t.role === role) : turns;
  return filtered.map((t) => t.text).join('\n');
}

function scoreFromChecklist(items: ChecklistItem[]): number {
  const totalW = items.reduce((s, it) => s + it.weight, 0) || 1;
  const points = items.reduce((s, it) => {
    const k = it.status === 'YES' ? 1 : it.status === 'PARTIAL' ? 0.5 : it.status === 'NA' ? 1 : 0;
    return s + it.weight * k;
  }, 0);
  return Math.max(0, Math.min(100, Math.round((points / totalW) * 1000) / 10));
}

function qualityTagFromScore(score: number) {
  if (score >= 85) return 'Отлично';
  if (score >= 70) return 'Хорошо';
  if (score >= 55) return 'Есть потенциал';
  return 'Нужно улучшать';
}

function pickEvidence(turns: TranscriptTurn[], role: TranscriptTurn['role'], keywords: string[]) {
  const ks = keywords.map(norm);
  const t = turns.find((x) => x.role === role && ks.some((k) => norm(x.text).includes(k)));
  return t?.text || undefined;
}

function buildConversationPairs(turns: TranscriptTurn[]) {
  const pairs: Array<{ customerMessage: string; managerAnswer: string }> = [];
  for (let i = 0; i < turns.length - 1; i++) {
    if (turns[i].role === 'client' && turns[i + 1].role === 'manager') {
      pairs.push({ customerMessage: turns[i].text, managerAnswer: turns[i + 1].text });
    }
  }
  return pairs;
}

function evaluateChecklist(turns: TranscriptTurn[]): ChecklistItem[] {
  const all = joinText(turns);
  const mgr = joinText(turns, 'manager');

  const INTRO = (() => {
    const ok = anyIncludes(mgr, ['здравствуйте', 'добрый день', 'доброе утро', 'добрый вечер']);
    return {
      code: 'INTRODUCTION',
      title: 'Приветствие',
      weight: 1,
      status: ok ? 'YES' : 'NO',
      evidence: pickEvidence(turns, 'manager', ['здравствуйте', 'добрый']),
    } satisfies ChecklistItem;
  })();

  const SALON = (() => {
    const ok = anyIncludes(mgr, ['автосалон', 'дилер', 'отдел продаж', 'салон']);
    return {
      code: 'SALON_NAME',
      title: 'Контекст автосалона/отдела продаж',
      weight: 1,
      status: ok ? 'PARTIAL' : 'NO',
      evidence: pickEvidence(turns, 'manager', ['автосалон', 'дилер', 'отдел продаж', 'салон']),
    } satisfies ChecklistItem;
  })();

  const NEEDS = (() => {
    const hasQuestions = anyIncludes(mgr, [
      'какая модель',
      'какую модель',
      'какой автомобиль',
      'какая комплектация',
      'какой бюджет',
      'когда планируете',
      'срок',
      'трейд-ин',
      'кредит',
      'первоначальный',
    ]);
    return {
      code: 'NEEDS_DISCOVERY',
      title: 'Выявление потребностей',
      weight: 2,
      status: hasQuestions ? 'YES' : 'NO',
      evidence: pickEvidence(turns, 'manager', ['модель', 'комплектац', 'бюджет', 'кредит', 'трейд-ин', 'срок']),
    } satisfies ChecklistItem;
  })();

  const PRESENTATION = (() => {
    const ok = anyIncludes(mgr, ['в наличии', 'комплектац', 'гарант', 'услов', 'цена', 'стоимость', 'акция']);
    return {
      code: 'PRODUCT_PRESENTATION',
      title: 'Презентация предложения',
      weight: 1.5,
      status: ok ? 'PARTIAL' : 'NO',
      evidence: pickEvidence(turns, 'manager', ['в наличии', 'комплектац', 'гарант', 'акция', 'цена']),
    } satisfies ChecklistItem;
  })();

  const CREDIT = (() => {
    const ok = anyIncludes(all, ['кредит', 'рассроч', 'ставк', 'первонач', 'ежемесяч']);
    return {
      code: 'CREDIT_EXPLANATION',
      title: 'Кредит/финусловия',
      weight: 1,
      status: ok ? 'PARTIAL' : 'NA',
      evidence: pickEvidence(turns, 'manager', ['кредит', 'ставк', 'первонач', 'ежемесяч']),
    } satisfies ChecklistItem;
  })();

  const TRADEIN = (() => {
    const ok = anyIncludes(all, ['трейд-ин', 'trade-in', 'обмен', 'оценк']);
    return {
      code: 'TRADEIN_OFFER',
      title: 'Трейд-ин/обмен',
      weight: 1,
      status: ok ? 'PARTIAL' : 'NA',
      evidence: pickEvidence(turns, 'manager', ['трейд', 'обмен', 'оценк']),
    } satisfies ChecklistItem;
  })();

  const OBJECTION = (() => {
    const hasObjection = anyIncludes(joinText(turns, 'client'), ['дорого', 'дорог', 'подумаю', 'не сейчас', 'посмотрю']);
    if (!hasObjection) {
      return {
        code: 'OBJECTION_HANDLING',
        title: 'Отработка возражений',
        weight: 1.5,
        status: 'NA',
      } satisfies ChecklistItem;
    }
    const ok = anyIncludes(mgr, ['понимаю', 'давайте уточ', 'могу предлож', 'вилка', 'вариант', 'что для вас важно']);
    return {
      code: 'OBJECTION_HANDLING',
      title: 'Отработка возражений',
      weight: 1.5,
      status: ok ? 'PARTIAL' : 'NO',
      evidence: pickEvidence(turns, 'manager', ['понимаю', 'уточ', 'вариант', 'вилка']),
    } satisfies ChecklistItem;
  })();

  const NEXT = (() => {
    const ok = anyIncludes(mgr, ['запис', 'приезж', 'тест-драйв', 'встреч', 'созвон', 'могу отправить', 'давайте договоримся', 'когда вам удобно']);
    return {
      code: 'NEXT_STEP_PROPOSAL',
      title: 'Следующий шаг',
      weight: 2,
      status: ok ? 'YES' : 'NO',
      evidence: pickEvidence(turns, 'manager', ['тест', 'встреч', 'созвон', 'когда вам удобно', 'запис']),
    } satisfies ChecklistItem;
  })();

  const TONE = (() => {
    const bad = anyIncludes(mgr, ['ну', 'короче', 'как хотите', 'не знаю']);
    return {
      code: 'COMMUNICATION_TONE',
      title: 'Тон и вежливость',
      weight: 1,
      status: bad ? 'PARTIAL' : 'YES',
    } satisfies ChecklistItem;
  })();

  return [INTRO, SALON, NEEDS, PRESENTATION, CREDIT, TRADEIN, OBJECTION, NEXT, TONE];
}

function computeDimensionScores(items: ChecklistItem[]) {
  const byCode = new Map(items.map((i) => [i.code, i.status]));
  const v = (code: string) => byCode.get(code);
  const to10 = (s: ChecklistStatus | undefined) => (s === 'YES' ? 9 : s === 'PARTIAL' ? 6 : s === 'NO' ? 3 : 8);
  return {
    'контакт': to10(v('INTRODUCTION')),
    'диагностика': to10(v('NEEDS_DISCOVERY')),
    'презентация': to10(v('PRODUCT_PRESENTATION')),
    'возражения': to10(v('OBJECTION_HANDLING')),
    'следующий_шаг': to10(v('NEXT_STEP_PROPOSAL')),
  };
}

function buildStrengthsWeaknesses(items: ChecklistItem[]) {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const recs: string[] = [];

  const get = (code: string) => items.find((x) => x.code === code);
  const add = (arr: string[], s: string) => {
    if (!arr.includes(s)) arr.push(s);
  };

  const intro = get('INTRODUCTION');
  if (intro?.status === 'YES') add(strengths, 'Есть приветствие и вежливый вход в разговор.');
  else add(weaknesses, 'Нет чёткого приветствия в начале разговора.');

  const needs = get('NEEDS_DISCOVERY');
  if (needs?.status === 'YES') add(strengths, 'Есть уточняющие вопросы (модель/условия/сроки).');
  else {
    add(weaknesses, 'Слабая диагностика: мало вопросов про модель, бюджет, сроки, трейд-ин/кредит.');
    add(recs, 'Добавить 3–4 обязательных уточняющих вопроса (модель, бюджет, сроки, трейд-ин/кредит).');
  }

  const next = get('NEXT_STEP_PROPOSAL');
  if (next?.status === 'YES') add(strengths, 'Есть попытка закрыть на следующий шаг (встреча/тест-драйв/созвон).');
  else {
    add(weaknesses, 'Нет конкретного следующего шага и фиксации времени.');
    add(recs, 'Всегда завершать разговор конкретным шагом: тест-драйв/встреча/созвон + время.');
  }

  const objection = get('OBJECTION_HANDLING');
  if (objection?.status === 'NO') {
    add(weaknesses, 'Возражение клиента не обработано (нет ценности/вилки/уточнений).');
    add(recs, 'Отрабатывать “дорого” через ценность: уточнить критерии, дать вилку и предложить варианты.');
  }

  const salon = get('SALON_NAME');
  if (salon?.status === 'NO') {
    add(weaknesses, 'Не обозначен контекст: автосалон/отдел продаж/бренд.');
    add(recs, 'В начале: “Автосалон <название>, отдел продаж, меня зовут …”.');
  }

  if (!recs.length) add(recs, 'Закрепить стандарт скрипта: приветствие → диагностика → предложение → следующий шаг.');
  return { strengths, weaknesses, recommendations: recs };
}

function buildReplyImprovements(turns: TranscriptTurn[]) {
  const pairs = buildConversationPairs(turns);
  const out: MockComputed['replyImprovements'] = [];
  pairs.forEach((p, idx) => {
    const c = norm(p.customerMessage);
    const m = norm(p.managerAnswer);
    const order = idx + 1;

    if (anyIncludes(c, ['сколько', 'цена', 'стоимость']) && !anyIncludes(m, ['вилка', 'диапазон', 'от', 'до', 'зависит от'])) {
      out.push({
        order,
        customerMessage: p.customerMessage,
        managerAnswer: p.managerAnswer,
        isOptimal: false,
        feedback: 'Нужна конкретика: хотя бы диапазон цен + уточняющий вопрос (модель/комплектация/сроки).',
        betterExample:
          'Обычно это в диапазоне X–Y в зависимости от модели и комплектации. Подскажите, какую модель рассматриваете и когда планируете покупку — уточню точнее и предложу варианты.',
      });
      return;
    }

    if (anyIncludes(c, ['дорого']) && !anyIncludes(m, ['понимаю', 'давайте уточ', 'что важно', 'вариант'])) {
      out.push({
        order,
        customerMessage: p.customerMessage,
        managerAnswer: p.managerAnswer,
        isOptimal: false,
        feedback: 'Возражение лучше развернуть: уточнить критерии и связать цену с выгодой/комплектацией.',
        betterExample:
          'Понимаю. Давайте уточню: что для вас важнее — цена, комплектация или срок? Тогда предложу 2–3 варианта, чтобы вы увидели разницу по цене и наполнению.',
      });
      return;
    }

    // «Дорого» / платёж: есть «понимаю», но нет вилки, сценариев и перехода к конкретному шагу
    if (
      anyIncludes(c, ['дорого', 'дорог', 'платеж', 'платежу', 'дорого по'])
      && anyIncludes(m, ['понимаю'])
      && !anyIncludes(m, [
        'вилка',
        'диапазон',
        'два вариант',
        'два сценар',
        'уточн',
        'запиш',
        'тест-драйв',
        'когда вам удобно',
        'удобно в',
        'слот',
        'суббот',
        'воскресен',
      ])
    ) {
      out.push({
        order,
        customerMessage: p.customerMessage,
        managerAnswer: p.managerAnswer,
        isOptimal: false,
        feedback:
          '«Понимаю» лучше подкрепить цифрами: вилка по цене/платежу или два понятных сценария, и сразу предложить время визита или звонка-уточнения.',
        betterExample:
          'Понимаю. Если ориентироваться на нашу вилку по этой линейке, платёж выходит в районе X–Y в месяц при вашем взносе. Могу прикинуть второй сценарий с большим сроком. И давайте зафиксируем осмотр: вам удобнее в четверг вечером или в субботу до обеда?',
      });
      return;
    }

    if (
      anyIncludes(c, ['можно приехать', 'когда', 'сегодня', 'завтра', 'посмотреть', 'приехать', 'глазами', 'осмотр'])
      && !anyIncludes(m, ['время', 'удобно', 'запиш', 'тест-драйв', 'встреч', 'суббот', 'воскресен', '11:', '12:', '13:', '14:', '15:', '16:', '17:', '18:'])
    ) {
      out.push({
        order,
        customerMessage: p.customerMessage,
        managerAnswer: p.managerAnswer,
        isOptimal: false,
        feedback: 'Нужно фиксировать следующий шаг конкретно: дата/время/адрес/что взять с собой.',
        betterExample:
          'Давайте запишу вас на тест-драйв. Вам удобнее сегодня после 18:00 или завтра утром? Адрес: …',
      });
      return;
    }
  });
  return out.slice(0, 12);
}

type ActionPlanRow = {
  priority: string;
  action: string;
  target: string;
  timeline: string;
};

/** План действий зависит от итогового балла, а не фиксированный один на все звонки. */
function buildActionPlanByScore(score: number): ActionPlanRow[] {
  if (score < 50) {
    return [
      {
        priority: 'Высокий',
        action: 'Открывать звонок: салон, имя, одна фраза «чем помогу по авто сегодня»',
        target: 'Контакт',
        timeline: 'Следующий звонок',
      },
      {
        priority: 'Высокий',
        action: 'Прогнать минимум 3 вопроса: модель/бюджет, срок покупки, трейд-ин и условия кредита',
        target: 'Диагностика',
        timeline: 'Сразу',
      },
      {
        priority: 'Высокий',
        action: 'На ценовые и «дорого» — вилка или сравнение комплектаций, затем предложить визит с датой',
        target: 'Возражения и закрытие',
        timeline: 'Сразу',
      },
    ];
  }
  if (score < 72) {
    return [
      {
        priority: 'Высокий',
        action: 'После «понимаю» по платежу/цене — назвать вилку или два платёжных сценария в цифрах',
        target: 'Возражения',
        timeline: 'Сразу',
      },
      {
        priority: 'Высокий',
        action: 'Когда клиент хочет «посмотреть» — дать 2 слота и записать, не уводить в «напишите сами»',
        target: 'Закрытие',
        timeline: 'Сразу',
      },
      {
        priority: 'Средний',
        action: 'Добавить в приветствие бренд/автосалон и короткую экспертизу («по кроссоверам до 2 млн подскажу лучшее»)',
        target: 'Контакт',
        timeline: '1–2 дня',
      },
    ];
  }
  return [
    {
      priority: 'Средний',
      action: 'За 1–2 часа до визита — SMS с адресом, контактом и напоминанием о тест-драйве',
      target: 'Сервис',
      timeline: 'До визита',
    },
    {
      priority: 'Низкий',
      action: 'Внести итог звонка, договорённости и следующий шаг в CRM',
      target: 'Процесс',
      timeline: '15 минут после звонка',
    },
    {
      priority: 'Низкий',
      action: 'Сверить с банком ставку/ежемесячный платёж под профиль клиента и иметь цифры к визиту',
      target: 'Финансы',
      timeline: 'В течение дня',
    },
  ];
}

function buildDetailedAnalysisByScore(score: number): string {
  if (score >= 72) {
    return (
      'Структура звонка выстроена последовательно: контакт → диагностика → предложение с конкретикой → отработка возражения → зафиксированный следующий шаг.\n\n' +
      'Дальше важнее дисциплина постобработки: CRM, SMS-подтверждение и подготовка автомобиля к визиту.'
    );
  }
  if (score >= 45) {
    return (
      'Тон и часть вопросов на месте, но клиент остаётся без опоры: мало цифр после возражения по цене/платежу и нет жёсткой даты после интереса к осмотру.\n\n' +
      'Усильте цепочку: «понимаю» → вилка или два сценария → «предлагаю слот в календаре вот такой-то».'
    );
  }
  return (
    'Структура звонка читается как «вопрос → общий ответ». Лучше вести клиента по сценарию: приветствие → диагностика → предложение → следующий шаг.\n\n' +
    'Главное: не оставлять клиента без конкретики (вилка, варианты) и без фиксации следующего шага.'
  );
}

function buildCallSummary(turns: TranscriptTurn[], items: ChecklistItem[], score: number, strengths: string[], weaknesses: string[]) {
  const client = joinText(turns, 'client');
  const hasPrice = anyIncludes(client, ['цена', 'стоимость', 'сколько']);
  const hasTradeIn = anyIncludes(client, ['трейд', 'обмен']);
  const hasCredit = anyIncludes(client, ['кредит', 'рассроч']);

  const weak = items.filter((i) => i.status === 'NO').map((i) => i.title);
  const plus = strengths[0] || 'Есть контакт и понятный тон.';
  const minus = weaknesses[0] || (weak.length ? `Провалы: ${weak.slice(0, 2).join(', ')}.` : 'Нет явных провалов.');
  const exec =
    `Коротко: ${hasPrice ? 'запрос по цене' : 'запрос по авто'}${hasTradeIn ? ' + трейд-ин' : ''}${hasCredit ? ' + кредит' : ''}. ` +
    `Плюс: ${plus} Минус: ${minus}`;

  const findings: Array<{ title: string; description: string; examples?: string[] }> = [];
  items.forEach((it) => {
    if (it.status === 'NO') {
      findings.push({
        title: it.title,
        description: 'Блок не был закрыт в разговоре. Это снижает конверсию и качество консультации.',
        examples: it.code === 'NEEDS_DISCOVERY'
          ? ['“Какую модель/комплектацию рассматриваете?”', '“На какие сроки планируете покупку?”']
          : it.code === 'NEXT_STEP_PROPOSAL'
            ? ['“Запишу вас на тест-драйв: сегодня или завтра?”']
            : undefined,
      });
    }
  });

  return {
    executiveSummary: exec,
    detailedAnalysis: buildDetailedAnalysisByScore(score),
    keyFindings: findings.slice(0, 6),
    actionPlan: buildActionPlanByScore(score),
  };
}

export function computeMockFromTranscript(turns: TranscriptTurn[]): MockComputed {
  const checklist = evaluateChecklist(turns);
  const totalScore = scoreFromChecklist(checklist);
  const qualityTag = qualityTagFromScore(totalScore);
  const dimensionScores = computeDimensionScores(checklist);
  const { strengths, weaknesses, recommendations } = buildStrengthsWeaknesses(checklist);
  const replyImprovements = buildReplyImprovements(turns);
  const callSummary = buildCallSummary(turns, checklist, totalScore, strengths, weaknesses);

  return {
    outcome: 'completed',
    durationSec: Math.max(30, Math.min(240, 20 + turns.length * 12)),
    totalScore,
    qualityTag,
    dimensionScores,
    checklist,
    strengths,
    weaknesses,
    recommendations,
    callSummary,
    replyImprovements,
  };
}

