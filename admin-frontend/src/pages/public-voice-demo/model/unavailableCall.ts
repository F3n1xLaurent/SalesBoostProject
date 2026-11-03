import { assessCallReportEligibility } from '../../../../../src/voice/callReportEligibility';
import { isUnavailableCallOutcome } from '../../../../../src/voice/voxCallOutcome';

export type UnavailableCall = 'missed' | 'insufficient';

export function getUnavailableCall(detail: {
  endedAt: string | null;
  outcome: string | null;
  isProcessing: boolean;
  transcript: { role: 'client' | 'manager'; text: string }[];
} | null): UnavailableCall | null {
  if (!detail) return null;
  if (isUnavailableCallOutcome(detail.outcome)) return 'missed';
  if (!detail.endedAt) return null;
  // Older calls may have a report even though only an answering service spoke.
  const eligibility = assessCallReportEligibility(detail.transcript);
  if (eligibility.eligible) return null;
  if (eligibility.outcome) return 'missed';
  return detail.isProcessing ? null : 'insufficient';
}
