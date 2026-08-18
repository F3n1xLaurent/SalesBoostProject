export const CHECKLIST_PROBLEM_WEIGHTS = {
  NO_INTRO_COMPANY: 6,
  NO_CLIENT_NAME: 2,
  WEAK_DIALOG_OPENING: 3,
  NO_NEEDS_DISCOVERY: 8,
  NO_KEY_PARAMS: 6,
  PRODUCT_MISINFORMATION: 12,
  WEAK_BENEFIT_PRESENTATION: 5,
  NO_DIRECT_ANSWER: 7,
  WEAK_OBJECTION_HANDLING: 8,
  NO_NEXT_STEP: 8,
  NO_CONCRETE_NEXT_STEP: 5,
  PASSIVE_STYLE: 5,
  BAD_TONE: 7,
  MONOLOGUE: 2,
  INTERRUPTS_CLIENT: 2,
  CRITICAL_VIOLATION: 14,
} as const;

export type ChecklistProblemCode = keyof typeof CHECKLIST_PROBLEM_WEIGHTS;
export type ChecklistResultStatus = 'YES' | 'PARTIAL' | 'NO';

export const PARTIAL_RESULT_VALUE = 0.5;
export const SIGNIFICANT_PROBLEM_SHARE = 0.3;
export const SYSTEMIC_ENTITY_SHARE = 0.6;
export const MIN_ENTITY_EVALUATED_CALLS = 5;
export const MIN_CHECKLIST_CALLS = 5;
export const MIN_LAGGING_CALLS = 3;
export const MIN_TREND_CALLS_PER_PERIOD = 5;
export const MIN_SOURCE_CALLS = 5;
export const MIN_MISSED_CALL_ATTEMPTS = 10;
export const MIN_ANSWERED_CALLS = 5;
export const MIN_MISSED_REGULAR_DAYS = 3;
export const MIN_SLOW_ANSWER_CONSECUTIVE_DAYS = 2;
export const LAGGING_SCORE_DELTA = 10;
export const TREND_SCORE_DROP = 8;
export const SOURCE_SCORE_DELTA = 10;
export const MISSED_RATE_EXCESS_PERCENT = 10;
export const OPERATIONAL_BASE_IMPORTANCE = 14;

export const PHONE_OWNERSHIP_NORMS = {
  dealership: { minimumAnswerRate: 95, maximumAnswerTimeSec: 10 },
  user: { minimumAnswerRate: 85, maximumAnswerTimeSec: 15 },
} as const;

export const CHECKLIST_CODE_TO_PROBLEM: Record<string, ChecklistProblemCode> = {
  INTRODUCTION: 'NO_INTRO_COMPANY',
  SALON_NAME: 'NO_INTRO_COMPANY',
  CAR_IDENTIFICATION: 'NO_KEY_PARAMS',
  NEEDS_DISCOVERY: 'NO_NEEDS_DISCOVERY',
  INITIATIVE: 'PASSIVE_STYLE',
  PRODUCT_PRESENTATION: 'WEAK_BENEFIT_PRESENTATION',
  CREDIT_EXPLANATION: 'WEAK_BENEFIT_PRESENTATION',
  TRADEIN_OFFER: 'WEAK_BENEFIT_PRESENTATION',
  OBJECTION_HANDLING: 'WEAK_OBJECTION_HANDLING',
  NEXT_STEP_PROPOSAL: 'NO_NEXT_STEP',
  DATE_FIXATION: 'NO_CONCRETE_NEXT_STEP',
  FOLLOW_UP_AGREEMENT: 'NO_CONCRETE_NEXT_STEP',
  COMMUNICATION_TONE: 'BAD_TONE',
};

export function normalizeChecklistProblemCode(code: string): ChecklistProblemCode | null {
  if (code in CHECKLIST_PROBLEM_WEIGHTS) return code as ChecklistProblemCode;
  return CHECKLIST_CODE_TO_PROBLEM[code] ?? null;
}

export function checklistResultValue(status: ChecklistResultStatus): number {
  if (status === 'YES') return 1;
  if (status === 'PARTIAL') return PARTIAL_RESULT_VALUE;
  return 0;
}

export function checklistProblemValue(status: ChecklistResultStatus): number {
  return 1 - checklistResultValue(status);
}

const totalWeight = Object.values(CHECKLIST_PROBLEM_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
if (totalWeight !== 100) throw new Error(`Checklist problem weights must total 100, got ${totalWeight}`);
