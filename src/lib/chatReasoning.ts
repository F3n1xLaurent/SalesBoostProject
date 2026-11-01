import { config } from '../config';

/** Keep the provider default unless explicitly configured; never send this to legacy chat models. */
export function compatibleChatReasoning(
  model: string,
  effort = config.openaiReasoningEffort,
): { reasoning_effort?: 'low' | 'medium' | 'high' } {
  const name = model.trim().toLowerCase().split('/').pop() || '';
  return effort && /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/.test(name)
    ? { reasoning_effort: effort }
    : {};
}

// Main analysis keeps the configured budget. Mechanical edits and graders must
// leave enough of their smaller completion budget for the visible JSON answer.
const REPORT_REASONING_STAGES = {
  evaluation: 'primary',
  generation: 'primary',
  findingCoverage: 'auxiliary',
  dialogCoverage: 'auxiliary',
  exampleRepair: 'auxiliary',
  exampleReview: 'auxiliary',
  testAssessment: 'auxiliary',
} as const;
export type ReportReasoningStage = keyof typeof REPORT_REASONING_STAGES;

export function compatibleReportReasoning(model: string, stage: ReportReasoningStage) {
  const effort = config.openaiReasoningEffort;
  return compatibleChatReasoning(model,
    REPORT_REASONING_STAGES[stage] === 'auxiliary' && effort === 'high' ? 'medium' : effort);
}

/** Use the same resolver as the requests so archived settings cannot drift from execution. */
export function reportReasoningProfile(model = config.openaiChatModel) {
  return {
    reasoningProfileVersion: 'report-staged-v1',
    reasoningByStage: Object.fromEntries(
      (Object.keys(REPORT_REASONING_STAGES) as ReportReasoningStage[]).map((stage) =>
        [stage, compatibleReportReasoning(model, stage).reasoning_effort ?? 'provider_default']),
    ) as Record<ReportReasoningStage, 'low' | 'medium' | 'high' | 'provider_default'>,
  };
}
