import {
  buildChecklistFromLLMClassification,
  enforceManagerChecklistEvidence,
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
    const label = cleanText(item.expectedAnswer || item.title || item.name || item.question);
    const maxScore = numeric(item.maxScore);
    const score = numeric(item.score);
    if (!label || maxScore === null || maxScore <= 0 || score === null) continue;

    hasClassification = true;
    const ratio = Math.max(0, Math.min(1, score / maxScore));
    if (ratio >= 0.8) {
      appendUnique(strengths, `${label} — выполнено`, limit);
    } else if (ratio >= 0.4) {
      appendUnique(weaknesses, `${label} — выполнено частично`, limit);
    } else {
      appendUnique(weaknesses, `${label} — не выполнено`, limit);
    }
  }

  const checklistSource = Array.isArray(source.checklist) ? source.checklist : [];
  const checklist = transcript
    ? enforceManagerChecklistEvidence(
      buildChecklistFromLLMClassification(
        checklistSource.filter((item): item is Record<string, unknown> => Boolean(recordOf(item))),
      ),
      transcript,
    )
    : checklistSource;
  for (const rawItem of checklist) {
    const item = recordOf(rawItem);
    if (!item) continue;
    const status = cleanText(item.status).toUpperCase();
    if (status === 'NA' || !['YES', 'PARTIAL', 'NO'].includes(status)) continue;

    hasClassification = true;
    const highlight = checklistHighlight(item, status as 'YES' | 'PARTIAL' | 'NO');
    if (status === 'YES') appendUnique(strengths, highlight, limit);
    else appendUnique(weaknesses, highlight, limit);
  }

  return { strengths, weaknesses, hasClassification };
}
