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

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
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

function checklistHighlight(item: Record<string, unknown>, status: 'YES' | 'PARTIAL' | 'NO'): string {
  const code = cleanText(item.code).toUpperCase();
  const label = CHECKLIST_LABELS[code] || cleanText(item.label) || code || 'Пункт чек-листа';
  const comment = cleanText(item.comment);
  if (comment) return `${label}: ${comment}`;
  if (status === 'YES') return `${label} — выполнено`;
  if (status === 'PARTIAL') return `${label} — выполнено частично`;
  return `${label} — не выполнено`;
}

function managerActionHighlight(item: Record<string, unknown>): string {
  const code = cleanText(item.code).toUpperCase();
  const comment = cleanText(item.comment);
  if (/(?:^|\s)(?:не|частично|но)(?=\s|[.,!])/iu.test(comment)) return '';
  if (/^(?:менеджер|сотрудник|консультант|продавец)\s+/iu.test(comment)
    && /(?:представил|представился|поздоровался|назвал|уточнил|спросил|выяснил|объяснил|предложил|согласовал|договорился|ответил|поддерживал|сохранял|презентовал|отработал)/iu.test(comment)) return comment;
  const action = MANAGER_ACTIONS[code];
  if (!action) return '';
  const evidence = Array.isArray(item.evidence) ? cleanText(item.evidence[0]) : '';
  const quote = evidence.replace(/^(?:менеджер|сотрудник|продавец|консультант)\s*:\s*/iu, '');
  return quote ? `${action}: «${quote.slice(0, 160)}»` : action;
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
    if (status === 'YES') appendUnique(strengths,
      transcript ? managerActionHighlight(item) : checklistHighlight(item, 'YES'), limit);
    else appendUnique(weaknesses, checklistHighlight(item, status as 'PARTIAL' | 'NO'), limit);
  }

  return { strengths, weaknesses, hasClassification };
}
