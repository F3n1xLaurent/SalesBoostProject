export type CallInsightDetail = {
  id: number;
  to: string;
  startedAt: string | null;
  endedAt: string | null;
  outcome: string | null;
  durationSec: number | null;
  totalScore: number | null;
  qualityTag: string | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  transcript: { role: 'client' | 'manager'; text: string }[];
  dimensionScores?: Record<string, number> | null;
  processingError?: string | null;
  callSummary?: {
    executiveSummary?: string;
    detailedAnalysis?: string;
    keyFindings?: Array<{ title?: string; description?: string; examples?: string[] }>;
    actionPlan?: Array<{ priority?: string; action?: string; target?: string; timeline?: string }>;
  } | null;
  replyImprovements?: Array<{
    order: number;
    customerMessage: string;
    managerAnswer: string;
    isOptimal: boolean;
    feedback: string;
    betterExample: string | null;
  }> | null;
};

