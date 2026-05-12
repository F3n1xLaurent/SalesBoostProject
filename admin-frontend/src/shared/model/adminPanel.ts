/* Minimal data shapes for Super Admin — compatible with existing API responses */

export interface PlatformSummary {
  totalAttempts: number;
  avgScore: number;
  levelCounts: { Junior: number; Middle: number; Senior: number };
  topWeaknesses: { weakness: string; count: number }[];
  topStrengths?: { strength: string; count: number }[];
  expertSummary?: string | null;
}

export interface PlatformVoice {
  totalCalls: number;
  answeredPercent: number;
  missedPercent: number;
  avgDurationSec: number;
  outcomeBreakdown?: {
    completed: number;
    no_answer: number;
    busy: number;
    failed: number;
    disconnected: number;
  };
}
