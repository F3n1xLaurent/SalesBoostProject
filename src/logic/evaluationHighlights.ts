import {
  enforceManagerChecklistEvidence,
  type ChecklistItem,
  type ChecklistTranscriptTurn,
} from './diagnosticScoring';

const CHECKLIST_LABELS: Record<string, string> = {
  INTRODUCTION: 'Приветствие и представление',
  SALON_NAME: 'Представление компании / точки',
  CAR_IDENTIFICATION: 'Уточнение интересующего автомобиля',
  NEEDS_DISCOVERY: 'Выявление потребностей',
  INITIATIVE: 'Инициатива в диалоге',
  PRODUCT_PRESENTATION: 'Презентация продукта',
  CREDIT_EXPLANATION: 'Объяснение кредита и условий',
  TRADEIN_OFFER: 'Предложение trade-in',
  OBJECTION_HANDLING: 'Работа с возражениями',
  NEXT_STEP_PROPOSAL: 'Предложение следующего шага',
  DATE_FIXATION: 'Фиксация даты и времени',
  FOLLOW_UP_AGREEMENT: 'Договорённость о повторном контакте',
  COMMUNICATION_TONE: 'Тон и качество коммуникации',
};

const MANAGER_ACTIONS: Record<string, string> = {
  INTRODUCTION: 'Менеджер поздоровался и представился',
  SALON_NAME: 'Менеджер назвал компанию',
  CAR_IDENTIFICATION: 'Менеджер уточнил интересующий автомобиль',
  NEEDS_DISCOVERY: 'Менеджер выяснил потребности клиента',
  INITIATIVE: 'Менеджер вёл разговор проактивно',
  PRODUCT_PRESENTATION: 'Менеджер объяснил преимущества продукта',
  CREDIT_EXPLANATION: 'Менеджер объяснил условия кредита',
  TRADEIN_OFFER: 'Менеджер предложил trade-in',
  OBJECTION_HANDLING: 'Менеджер ответил на возражение клиента',
  NEXT_STEP_PROPOSAL: 'Менеджер предложил следующий шаг',
  DATE_FIXATION: 'Менеджер согласовал дату и время',
  FOLLOW_UP_AGREEMENT: 'Менеджер договорился о повторном контакте',
  COMMUNICATION_TONE: 'Менеджер сохранял профессиональный тон',
};

type EvaluationHighlights = {
  strengths: string[];
  weaknesses: string[];
  hasClassification: boolean;
};

type EvaluationHighlightOptions = {
  /**
   * When supplied, a checklist strength must be evidenced by one of these
   * final, positively marked manager turns. This prevents a turn marked
   * "negative" in the dialog from also producing report strengths.
   */
  positiveManagerTurnIndexes?: ReadonlySet<number>;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

const FEMININE_MANAGER_VERBS: Record<string, string> = {
  представилась: 'представился',
  представила: 'представил',
  поздоровалась: 'поздоровался',
  назвала: 'назвал',
  уточнила: 'уточнил',
  спросила: 'спросил',
  выяснила: 'выяснил',
  объяснила: 'объяснил',
  предложила: 'предложил',
  согласовала: 'согласовал',
  договорилась: 'договорился',
  ответила: 'ответил',
  подтвердила: 'подтвердил',
  поддерживала: 'поддерживал',
  сохраняла: 'сохранял',
  презентовала: 'презентовал',
  отработала: 'отработал',
  вела: 'вёл',
  получила: 'получил',
  перевела: 'перевёл',
  связала: 'связал',
  провела: 'провёл',
  раскрыла: 'раскрыл',
  дополнила: 'дополнил',
  обозначила: 'обозначил',
  проявила: 'проявил',
  использовала: 'использовал',
  зафиксировала: 'зафиксировал',
  озвучила: 'озвучил',
  продемонстрировала: 'продемонстрировал',
  сформулировала: 'сформулировал',
  перешла: 'перешёл',
  реагировала: 'реагировал',
  задала: 'задал',
  рассказала: 'рассказал',
  сообщила: 'сообщил',
  указала: 'указал',
  помогла: 'помог',
  сделала: 'сделал',
  дала: 'дал',
  смогла: 'смог',
  начала: 'начал',
  продолжила: 'продолжил',
  завершила: 'завершил',
};

/** Keep the generic role name "менеджер" grammatically masculine in report prose. */
export function normalizeManagerNarrationGender(value: string): string {
  if (!/(?:^|[^а-яёa-z])менеджер(?:$|[^а-яёa-z])/iu.test(value)) return value;
  return value.split(/(?<=[.!?])(?=\s|$)/u).map((sentence) => {
    const subjectPattern = /(^|[^а-яёa-z])(менеджер|клиент|клиентка|покупатель|покупательница|компания|организация|команда|девушка|женщина|она)(?=$|[^а-яёa-z])/giu;
    const subjects = [...sentence.matchAll(subjectPattern)];
    if (!subjects.some((match) => match[2]?.toLocaleLowerCase('ru-RU') === 'менеджер')) return sentence;

    let result = '';
    let cursor = 0;
    subjects.forEach((subject, index) => {
      if (subject[2]?.toLocaleLowerCase('ru-RU') !== 'менеджер') return;
      const clauseStart = (subject.index ?? 0) + (subject[1]?.length ?? 0);
      const nextSubject = subjects[index + 1];
      const clauseEnd = nextSubject
        ? (nextSubject.index ?? sentence.length) + (nextSubject[1]?.length ?? 0)
        : sentence.length;
      result += sentence.slice(cursor, clauseStart);
      const clause = sentence.slice(clauseStart, clauseEnd)
        .replace(/(^|[^а-яёa-z])должна была(?=$|[^а-яёa-z])/giu, '$1должен был')
        .replace(/(^|[^а-яёa-z])должна(?=$|[^а-яёa-z])/giu, '$1должен');
      result += Object.entries(FEMININE_MANAGER_VERBS).reduce((text, [feminine, masculine]) => (
        text.replace(new RegExp(`(^|[^а-яёa-z])${feminine}(?=$|[^а-яёa-z])`, 'giu'), `$1${masculine}`)
      ), clause);
      cursor = clauseEnd;
    });
    return `${result}${sentence.slice(cursor)}`;
  }).join('');
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function appendUnique(target: string[], value: string, limit: number): void {
  if (!value || target.length >= limit) return;
  const normalized = value.toLocaleLowerCase('ru-RU').replace(/[«»"'.,:;!?—–-]/g, '').replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  if (target.some((item) => item.toLocaleLowerCase('ru-RU').replace(/[«»"'.,:;!?—–-]/g, '').replace(/\s+/g, ' ').trim() === normalized)) return;
  target.push(value);
}

/** Resolve a custom criterion from the checklist snapshot stored with its evaluation. */
export function resolveChecklistItemLabel(evaluation: unknown, rawItem: unknown): string | null {
  const item = recordOf(rawItem);
  if (!item) return null;
  const code = cleanText(item.code).toUpperCase();
  const source = recordOf(evaluation);
  const definition = recordOf(source?.checklist_definition);
  const definitions = Array.isArray(definition?.items) ? definition.items : [];
  const matchingDefinition = definitions
    .map(recordOf)
    .find((candidate) => candidate && cleanText(candidate.id).toUpperCase() === code);
  return cleanText(matchingDefinition?.title)
    || cleanText(item.label || item.title)
    || CHECKLIST_LABELS[code]
    || null;
}

function checklistHighlight(item: Record<string, unknown>, status: 'YES' | 'PARTIAL' | 'NO'): string {
  const label = cleanText(item.label) || 'Пункт чек-листа';
  const comment = normalizeManagerNarrationGender(cleanText(item.comment));
  if (comment && !cleanText(item.label)) return comment;
  if (comment) return `${label}: ${comment}`;
  if (status === 'YES') return `${label} — выполнено`;
  if (status === 'PARTIAL') return `${label} — выполнено частично`;
  return `${label} — не выполнено`;
}

function managerActionHighlight(item: Record<string, unknown>): string {
  const code = cleanText(item.code).toUpperCase();
  const comment = normalizeManagerNarrationGender(cleanText(item.comment));
  if (/(?:^|\s)(?:не|частично|но)(?=\s|[.,!])/iu.test(comment)) return '';
  if (/^(?:менеджер|сотрудник|консультант|продавец)\s+/iu.test(comment)
    && /(?:представил|представился|поздоровался|назвал|уточнил|спросил|выяснил|объяснил|предложил|согласовал|договорился|ответил|поддерживал|сохранял|презентовал|отработал)/iu.test(comment)) return comment;
  const action = MANAGER_ACTIONS[code];
  if (!action) return '';
  const evidence = Array.isArray(item.evidence) ? cleanText(item.evidence[0]) : '';
  const quote = evidence.replace(/^(?:менеджер|сотрудник|продавец|консультант)\s*:\s*/iu, '');
  return quote ? `${action}: «${quote.slice(0, 160)}»` : action;
}

function normalizeEvidenceText(value: unknown): string {
  return cleanText(value)
    .replace(/^(менеджер|сотрудник|продавец|консультант)\s*:\s*/iu, '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceMatchesTurn(evidence: string, turnText: unknown): boolean {
  const expected = normalizeEvidenceText(evidence);
  const actual = normalizeEvidenceText(turnText);
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  if ((expected.length >= 12 && actual.includes(expected))
    || (actual.length >= 12 && expected.includes(actual))) return true;

  const expectedTokens = new Set(expected.split(' ').filter((token) => token.length > 2));
  const actualTokens = new Set(actual.split(' ').filter((token) => token.length > 2));
  if (expectedTokens.size < 3 || actualTokens.size < 3) return false;
  const common = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
  return common / expectedTokens.size >= 0.75 && common / actualTokens.size >= 0.45;
}

function hasPositiveTurnEvidence(
  item: Record<string, unknown>,
  transcript: ChecklistTranscriptTurn[],
  positiveManagerTurnIndexes: ReadonlySet<number>,
): boolean {
  const evidence = Array.isArray(item.evidence)
    ? item.evidence.map(cleanText).filter(Boolean)
    : cleanText(item.evidence) ? [cleanText(item.evidence)] : [];
  return evidence.some((quote) => {
    const matchingManagerTurnIndexes = transcript.flatMap((turn, index) => (
      (turn.role === 'manager' || turn.role === 'assistant')
      && evidenceMatchesTurn(quote, turn.content ?? turn.text)
        ? [index]
        : []
    ));

    // When the same quote occurs more than once, its provenance is ambiguous.
    // Treat it as positive only if every matching manager turn is positive.
    return matchingManagerTurnIndexes.length > 0
      && matchingManagerTurnIndexes.every((index) => positiveManagerTurnIndexes.has(index));
  });
}

/**
 * Builds report highlights from the scored sources of truth instead of asking a
 * second LLM response to classify the same item again. NA items are deliberately
 * ignored because they were not applicable to the dialogue.
 */
export function buildEvaluationHighlights(
  evaluation: unknown,
  limit = 8,
  transcript?: ChecklistTranscriptTurn[],
  options: EvaluationHighlightOptions = {},
): EvaluationHighlights {
  const source = recordOf(evaluation);
  if (!source) return { strengths: [], weaknesses: [], hasClassification: false };

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  let hasClassification = false;

  const planCriteria = recordOf(source.plan_criteria);
  const planItems = Array.isArray(planCriteria?.items) ? planCriteria.items : [];
  for (const rawItem of planItems) {
    const item = recordOf(rawItem);
    if (!item) continue;
    const status = cleanText(item.status).toUpperCase();
    if (status === 'NA') continue;
    const label = cleanText(item.expectedAnswer || item.title || item.name || item.question);
    const maxScore = numeric(item.maxScore);
    const score = numeric(item.score);
    if (!label || maxScore === null || maxScore <= 0 || score === null) continue;

    const ratio = Math.max(0, Math.min(1, score / maxScore));
    // Legacy evaluations did not record whether the client actually reached
    // the linked script question. Keep confirmed successes, but do not turn an
    // ambiguous old zero into a manager weakness.
    if (!status && ratio < 0.8) continue;

    hasClassification = true;
    if (ratio >= 0.8) {
      // Script expectedAnswer is a task, not evidence of a manager action.
      // When a transcript is available, only grounded checklist actions may
      // appear in the strengths block.
      if (!transcript) appendUnique(strengths, `${label} — выполнено`, limit);
    } else if (ratio >= 0.4) {
      appendUnique(weaknesses, `${label} — выполнено частично`, limit);
    } else {
      appendUnique(weaknesses, `${label} — не выполнено`, limit);
    }
  }

  const checklistSource = Array.isArray(source.checklist) ? source.checklist : [];
  // Evaluator results may use company-defined item IDs. Rebuilding them via
  // the legacy fixed-code catalog silently drops every custom checklist item.
  const checklistItems = checklistSource
    .filter((item): item is Record<string, unknown> => Boolean(recordOf(item)))
    .map((item) => ({
      code: cleanText(item.code).toUpperCase() as ChecklistItem['code'],
      label: resolveChecklistItemLabel(source, item),
      weight: numeric(item.weight) ?? 0,
      status: cleanText(item.status).toUpperCase() as ChecklistItem['status'],
      evidence: Array.isArray(item.evidence)
        ? item.evidence.map(cleanText).filter(Boolean)
        : cleanText(item.evidence) ? [cleanText(item.evidence)] : [],
      comment: cleanText(item.comment),
    }))
    .filter((item) => item.code && ['YES', 'PARTIAL', 'NO', 'NA'].includes(item.status));
  const checklist = transcript
    ? enforceManagerChecklistEvidence(checklistItems, transcript)
    : checklistItems;
  for (const rawItem of checklist) {
    const item = recordOf(rawItem);
    if (!item) continue;
    const status = cleanText(item.status).toUpperCase();
    if (status === 'NA' || !['YES', 'PARTIAL', 'NO'].includes(status)) continue;

    hasClassification = true;
    if (status === 'YES') {
      const allowedByDialogMark = !transcript || !options.positiveManagerTurnIndexes
        || hasPositiveTurnEvidence(item, transcript, options.positiveManagerTurnIndexes);
      if (allowedByDialogMark) appendUnique(strengths,
        transcript ? managerActionHighlight(item) : checklistHighlight(item, 'YES'), limit);
    }
    else appendUnique(weaknesses, checklistHighlight(item, status as 'PARTIAL' | 'NO'), limit);
  }

  return { strengths, weaknesses, hasClassification };
}
