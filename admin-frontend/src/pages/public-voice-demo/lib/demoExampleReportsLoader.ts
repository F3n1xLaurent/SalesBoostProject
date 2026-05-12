import type { CallInsightDetail } from '../../../shared/model/call-insight/types';
import type { ExampleTier } from '../model/types';
import weakReport from '../../../data/demo-example-reports/weak.json';
import mediumReport from '../../../data/demo-example-reports/medium.json';
import strongReport from '../../../data/demo-example-reports/strong.json';

/** Снимок ответа evaluateDemoExampleFromTranscript (scripts/generate-demo-example-reports.ts). */
export type DemoExampleEvalArtifact = {
  outcome: 'completed';
  durationSec: number;
  totalScore: number;
  qualityTag: string;
  dimensionScores: Record<string, number> | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  callSummary: CallInsightDetail['callSummary'];
  replyImprovements: CallInsightDetail['replyImprovements'];
  transcript: CallInsightDetail['transcript'];
};

const PACKS: Record<ExampleTier, DemoExampleEvalArtifact> = {
  weak: weakReport as DemoExampleEvalArtifact,
  medium: mediumReport as DemoExampleEvalArtifact,
  strong: strongReport as DemoExampleEvalArtifact,
};

const DEMO_TO = '+7 900 000 00 00';

const IDS: Record<ExampleTier, number> = {
  weak: -10,
  medium: -11,
  strong: -12,
};

/** Стабильные метки времени для UI (содержимое отчёта — из офлайн-прогона пайплайна). */
const STARTED_AT: Record<ExampleTier, string> = {
  weak: '2026-04-01T10:05:12.000Z',
  medium: '2026-04-01T11:18:44.000Z',
  strong: '2026-04-01T14:32:01.000Z',
};

const ENDED_AT: Record<ExampleTier, string> = {
  weak: '2026-04-01T10:06:47.000Z',
  medium: '2026-04-01T11:20:09.000Z',
  strong: '2026-04-01T14:34:28.000Z',
};

export function buildPrecomputedExampleDetail(tier: ExampleTier): CallInsightDetail {
  const data = PACKS[tier];
  return {
    id: IDS[tier],
    to: DEMO_TO,
    startedAt: STARTED_AT[tier],
    endedAt: ENDED_AT[tier],
    outcome: data.outcome,
    durationSec: data.durationSec,
    totalScore: data.totalScore,
    qualityTag: data.qualityTag,
    strengths: data.strengths ?? [],
    weaknesses: data.weaknesses ?? [],
    recommendations: data.recommendations ?? [],
    dimensionScores: data.dimensionScores ?? null,
    processingError: null,
    callSummary: data.callSummary ?? null,
    replyImprovements: Array.isArray(data.replyImprovements) ? data.replyImprovements : [],
    transcript: Array.isArray(data.transcript) ? data.transcript : [],
  };
}
