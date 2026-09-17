export type ChecklistStatus = 'YES' | 'PARTIAL' | 'NO' | 'NA';

export const CHECKLIST_CODE = [
  'INTRODUCTION',
  'SALON_NAME',
  'CAR_IDENTIFICATION',
  'NEEDS_DISCOVERY',
  'INITIATIVE',
  'PRODUCT_PRESENTATION',
  'CREDIT_EXPLANATION',
  'TRADEIN_OFFER',
  'OBJECTION_HANDLING',
  'NEXT_STEP_PROPOSAL',
  'DATE_FIXATION',
  'FOLLOW_UP_AGREEMENT',
  'COMMUNICATION_TONE',
] as const;

export type ChecklistCode = (typeof CHECKLIST_CODE)[number];

export const CHECKLIST_WEIGHTS: Record<ChecklistCode, number> = {
  INTRODUCTION: 8,
  SALON_NAME: 6,
  CAR_IDENTIFICATION: 7,
  NEEDS_DISCOVERY: 8,
  INITIATIVE: 7,
  PRODUCT_PRESENTATION: 10,
  CREDIT_EXPLANATION: 8,
  TRADEIN_OFFER: 8,
  OBJECTION_HANDLING: 10,
  NEXT_STEP_PROPOSAL: 10,
  DATE_FIXATION: 8,
  FOLLOW_UP_AGREEMENT: 5,
  COMMUNICATION_TONE: 5,
};

export interface ChecklistItem {
  code: ChecklistCode;
  weight: number;
  status: ChecklistStatus;
  evidence: string[];
  comment: string;
}

export type IssueSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export const ISSUE_TYPES = [
  'NO_INTRO',
  'NO_SALON_NAME',
  'NO_NEEDS_DISCOVERY',
  'WEAK_PRESENTATION',
  'NO_NEXT_STEP',
  'NO_DATE_FIX',
  'WEAK_TRADEIN',
  'WEAK_CREDIT',
  'BAD_TONE',
  'PASSIVE_STYLE',
  'MISINFORMATION',
  'REDIRECT_TO_WEBSITE',
  'LOW_ENGAGEMENT',
  'PROFANITY',
] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

export interface EvaluationIssue {
  issue_type: IssueType;
  severity: IssueSeverity;
  evidence: string;
  recommendation: string;
}

export interface DimensionScores {
  first_contact: number;
  product_and_sales: number;
  closing_commitment: number;
  communication: number;
}

export interface EvaluationResult {
  overall_score_0_100: number;
  dimension_scores: DimensionScores;
  checklist: ChecklistItem[];
  issues: EvaluationIssue[];
  recommendations: string[];
}

const STATUS_MULTIPLIER: Record<ChecklistStatus, number> = {
  YES: 1.0,
  PARTIAL: 0.5,
  NO: 0.0,
  NA: -1,
};

const DIMENSION_CODES: Record<keyof DimensionScores, ChecklistCode[]> = {
  first_contact: ['INTRODUCTION', 'SALON_NAME', 'CAR_IDENTIFICATION', 'INITIATIVE'],
  product_and_sales: [
    'NEEDS_DISCOVERY',
    'PRODUCT_PRESENTATION',
    'CREDIT_EXPLANATION',
    'TRADEIN_OFFER',
    'OBJECTION_HANDLING',
  ],
  closing_commitment: ['NEXT_STEP_PROPOSAL', 'DATE_FIXATION', 'FOLLOW_UP_AGREEMENT'],
  communication: ['COMMUNICATION_TONE'],
};

function computeDimensionScore(checklist: ChecklistItem[], codes: ChecklistCode[]): number {
  const items = checklist.filter((c) => codes.includes(c.code) && c.status !== 'NA');
  if (items.length === 0) return 0;
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  if (totalWeight === 0) return 0;
  const earned = items.reduce((s, i) => {
    const mult = STATUS_MULTIPLIER[i.status];
    return s + i.weight * mult;
  }, 0);
  return Math.round((earned / totalWeight) * 100);
}

export interface ScoringOptions {
  earlyFail: boolean;
  misinformationDetected: boolean;
  noNextStep: boolean;
  passiveStyle: boolean;
  passiveSeverity: 'mild' | 'strong';
}

export function computeDeterministicScore(
  checklist: ChecklistItem[],
  options: ScoringOptions
): { score: number; dimensions: DimensionScores } {
  const activeItems = checklist.filter((c) => c.status !== 'NA');
  const totalWeight = activeItems.reduce((s, i) => s + i.weight, 0);

  if (totalWeight === 0) {
    return {
      score: 0,
      dimensions: { first_contact: 0, product_and_sales: 0, closing_commitment: 0, communication: 0 },
    };
  }

  const earned = activeItems.reduce((s, i) => {
    const mult = STATUS_MULTIPLIER[i.status];
    return s + i.weight * mult;
  }, 0);

  let rawScore = Math.round((earned / totalWeight) * 100);

  if (options.misinformationDetected) {
    rawScore = Math.max(0, rawScore - 15);
  }
  if (options.noNextStep) {
    rawScore = Math.max(0, rawScore - 10);
  }
  if (options.passiveStyle) {
    const penalty = options.passiveSeverity === 'strong' ? 10 : 5;
    rawScore = Math.max(0, rawScore - penalty);
  }

  if (options.earlyFail) {
    rawScore = Math.min(40, rawScore);
  }

  const score = Math.max(0, Math.min(100, rawScore));

  const dimensions: DimensionScores = {
    first_contact: computeDimensionScore(checklist, DIMENSION_CODES.first_contact),
    product_and_sales: computeDimensionScore(checklist, DIMENSION_CODES.product_and_sales),
    closing_commitment: computeDimensionScore(checklist, DIMENSION_CODES.closing_commitment),
    communication: computeDimensionScore(checklist, DIMENSION_CODES.communication),
  };

  return { score, dimensions };
}

export function buildChecklistFromLLMClassification(
  classification: Array<{
    code?: unknown;
    status?: unknown;
    evidence?: unknown;
    comment?: unknown;
  }>
): ChecklistItem[] {
  const normalized = classification
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      code: String(item.code ?? '').trim().toUpperCase(),
      status: String(item.status ?? '').trim().toUpperCase(),
      evidence: Array.isArray(item.evidence)
        ? item.evidence.map((value) => String(value ?? '').trim()).filter(Boolean)
        : typeof item.evidence === 'string' && item.evidence.trim()
          ? [item.evidence.trim()]
          : [],
      comment: typeof item.comment === 'string' ? item.comment.trim() : '',
    }));

  return CHECKLIST_CODE.map((code) => {
    const match = normalized.find((item) => item.code === code);
    const weight = CHECKLIST_WEIGHTS[code];
    if (!match) {
      return { code, weight, status: 'NA' as ChecklistStatus, evidence: [], comment: '' };
    }
    const status = (['YES', 'PARTIAL', 'NO', 'NA'].includes(match.status)
      ? match.status
      : 'NO') as ChecklistStatus;
    return {
      code,
      weight,
      status,
      evidence: Array.isArray(match.evidence) ? match.evidence : [],
      comment: typeof match.comment === 'string' ? match.comment : '',
    };
  });
}

export type ChecklistTranscriptTurn = {
  role: string;
  content?: unknown;
  text?: unknown;
};

const CONDITIONAL_CHECKLIST_CODES = new Set<ChecklistCode>([
  'CREDIT_EXPLANATION',
  'TRADEIN_OFFER',
  'OBJECTION_HANDLING',
]);

function normalizeEvidenceText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[\u00ab\u00bb"'`]/g, '')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceQuote(value: unknown): { speaker: 'manager' | 'client' | null; text: string } {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^\s*(менеджер|сотрудник|продавец|консультант|клиент|покупатель)\s*:\s*/i);
  if (!match) return { speaker: null, text: normalizeEvidenceText(raw) };

  const label = match[1].toLocaleLowerCase('ru-RU');
  const speaker = label === 'клиент' || label === 'покупатель' ? 'client' : 'manager';
  return { speaker, text: normalizeEvidenceText(raw.slice(match[0].length)) };
}

function isManagerEvidence(value: unknown, managerTurns: string[]): boolean {
  const evidence = evidenceQuote(value);
  if (evidence.speaker === 'client' || evidence.text.length < 2) return false;
  return managerTurns.some((turn) => turn === evidence.text || turn.includes(evidence.text) || evidence.text.includes(turn));
}

/**
 * Prevents an LLM from crediting the manager for something said only by the
 * client. Positive checklist statuses must be backed by a real manager quote.
 */
export function enforceManagerChecklistEvidence(
  checklist: ChecklistItem[],
  transcript: ChecklistTranscriptTurn[],
): ChecklistItem[] {
  const managerTurns = transcript
    .filter((turn) => turn.role === 'manager' || turn.role === 'assistant')
    .map((turn) => normalizeEvidenceText(turn.content ?? turn.text))
    .filter(Boolean);

  return checklist.map((item) => {
    if (item.status !== 'YES' && item.status !== 'PARTIAL') return item;
    if (item.evidence.some((evidence) => isManagerEvidence(evidence, managerTurns))) return item;

    return {
      ...item,
      status: CONDITIONAL_CHECKLIST_CODES.has(item.code) ? 'NA' : 'NO',
      evidence: [],
      comment: 'В стенограмме нет подтверждающей реплики менеджера.',
    };
  });
}

export function detectIssuesFromChecklist(
  checklist: ChecklistItem[],
  extraSignals: {
    profanity: boolean;
    misinformation: boolean;
    passiveStyle: boolean;
    lowEngagement: boolean;
    redirectToWebsite: boolean;
    badTone: boolean;
  }
): EvaluationIssue[] {
  const issues: EvaluationIssue[] = [];

  const find = (code: ChecklistCode) => checklist.find((c) => c.code === code);

  const intro = find('INTRODUCTION');
  if (intro && intro.status === 'NO') {
    issues.push({
      issue_type: 'NO_INTRO',
      severity: 'MEDIUM',
      evidence: intro.evidence[0] ?? 'Менеджер не представился.',
      recommendation: 'Всегда начинайте разговор с приветствия и представления по имени.',
    });
  }

  const salon = find('SALON_NAME');
  if (salon && salon.status === 'NO') {
    issues.push({
      issue_type: 'NO_SALON_NAME',
      severity: 'MEDIUM',
      evidence: salon.evidence[0] ?? 'Название салона не было озвучено.',
      recommendation: 'Называйте автосалон в начале разговора — это повышает доверие клиента.',
    });
  }

  const needs = find('NEEDS_DISCOVERY');
  if (needs && needs.status === 'NO') {
    issues.push({
      issue_type: 'NO_NEEDS_DISCOVERY',
      severity: 'HIGH',
      evidence: needs.evidence[0] ?? 'Не были заданы уточняющие вопросы о потребностях клиента.',
      recommendation: 'Задайте минимум 2–3 вопроса, чтобы понять мотивацию клиента, прежде чем презентовать.',
    });
  }

  const pres = find('PRODUCT_PRESENTATION');
  if (pres && (pres.status === 'NO' || pres.status === 'PARTIAL')) {
    issues.push({
      issue_type: 'WEAK_PRESENTATION',
      severity: pres.status === 'NO' ? 'HIGH' : 'MEDIUM',
      evidence: pres.evidence[0] ?? 'Презентация автомобиля была слабой или отсутствовала.',
      recommendation: 'Стройте презентацию вокруг потребностей клиента и ключевых преимуществ.',
    });
  }

  const nextStep = find('NEXT_STEP_PROPOSAL');
  if (nextStep && nextStep.status === 'NO') {
    issues.push({
      issue_type: 'NO_NEXT_STEP',
      severity: 'HIGH',
      evidence: nextStep.evidence[0] ?? 'Следующий шаг не был предложен.',
      recommendation: 'Всегда предлагайте конкретный следующий шаг: визит, тест-драйв или повторный звонок.',
    });
  }

  const dateFix = find('DATE_FIXATION');
  if (dateFix && dateFix.status === 'NO') {
    issues.push({
      issue_type: 'NO_DATE_FIX',
      severity: 'HIGH',
      evidence: dateFix.evidence[0] ?? 'Конкретная дата и время не были зафиксированы.',
      recommendation: 'Фиксируйте точную дату и время следующей встречи или контакта.',
    });
  }

  const tradein = find('TRADEIN_OFFER');
  if (tradein && tradein.status === 'PARTIAL') {
    issues.push({
      issue_type: 'WEAK_TRADEIN',
      severity: 'LOW',
      evidence: tradein.evidence[0] ?? 'Trade-in был упомянут, но не раскрыт полностью.',
      recommendation: 'Проактивно предлагайте оценку trade-in и объясняйте процесс.',
    });
  }

  const credit = find('CREDIT_EXPLANATION');
  if (credit && credit.status === 'PARTIAL') {
    issues.push({
      issue_type: 'WEAK_CREDIT',
      severity: 'LOW',
      evidence: credit.evidence[0] ?? 'Кредитные условия были упомянуты поверхностно.',
      recommendation: 'Объясняйте условия кредита подробно: банки-партнёры, примерный ежемесячный платёж, первый взнос.',
    });
  }

  if (extraSignals.badTone) {
    issues.push({
      issue_type: 'BAD_TONE',
      severity: 'HIGH',
      evidence: 'Обнаружен негативный или непрофессиональный тон общения.',
      recommendation: 'Поддерживайте дружелюбный и профессиональный тон на протяжении всего разговора.',
    });
  }

  if (extraSignals.passiveStyle) {
    issues.push({
      issue_type: 'PASSIVE_STYLE',
      severity: 'MEDIUM',
      evidence: 'Менеджер был пассивен — ждал вопросов вместо проактивной работы.',
      recommendation: 'Проявляйте инициативу: предлагайте варианты, задавайте вопросы, ведите диалог.',
    });
  }

  if (extraSignals.misinformation) {
    issues.push({
      issue_type: 'MISINFORMATION',
      severity: 'HIGH',
      evidence: 'Менеджер сообщил неверную информацию об автомобиле.',
      recommendation: 'Всегда проверяйте факты перед тем, как озвучивать их клиенту.',
    });
  }

  if (extraSignals.redirectToWebsite) {
    issues.push({
      issue_type: 'REDIRECT_TO_WEBSITE',
      severity: 'MEDIUM',
      evidence: 'Менеджер перенаправил клиента на сайт вместо того, чтобы ответить.',
      recommendation: 'Отвечайте на вопросы напрямую; сайт — только как дополнительная ссылка.',
    });
  }

  if (extraSignals.lowEngagement) {
    issues.push({
      issue_type: 'LOW_ENGAGEMENT',
      severity: 'MEDIUM',
      evidence: 'Менеджер проявил низкую вовлечённость и интерес к клиенту.',
      recommendation: 'Проявляйте искренний интерес: задавайте уточняющие вопросы, обращайтесь по имени, учитывайте потребности.',
    });
  }

  if (extraSignals.profanity) {
    issues.push({
      issue_type: 'PROFANITY',
      severity: 'HIGH',
      evidence: 'Обнаружена ненормативная лексика.',
      recommendation: 'Ненормативная лексика абсолютно недопустима в профессиональном общении.',
    });
  }

  return issues;
}
