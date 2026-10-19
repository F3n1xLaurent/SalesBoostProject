import { prisma } from '../db';
import { prepareTranscriptForAnalysis } from '../voice/analysisTranscript';
import {
  ensureFindingBetterExamples,
  generateUnifiedCallReport,
  normalizeUnifiedCallReport,
} from '../voice/unifiedCallReport';
import { getCallReportProblemCatalog } from '../voice/problemCatalog';

type StoredTurn = { role?: unknown; text?: unknown; content?: unknown };

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function moscowDayBounds(day: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Дата должна быть в формате YYYY-MM-DD.');
  const from = new Date(`${day}T00:00:00+03:00`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  if (!Number.isFinite(from.getTime())) throw new Error('Некорректная дата.');
  return { from, to };
}

async function main(): Promise<void> {
  const day = process.argv[2] || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const { from, to } = moscowDayBounds(day);
  const sessions = await prisma.voiceCallSession.findMany({
    where: {
      startedAt: { gte: from, lt: to },
      evaluationJson: { not: null },
      transcriptJson: { not: null },
    },
    orderBy: { id: 'asc' },
  });
  const catalog = await getCallReportProblemCatalog(prisma);
  let repaired = 0;
  let generated = 0;
  let unchanged = 0;

  for (const session of sessions) {
    const evaluation = parseJson<Record<string, any>>(session.evaluationJson, {});
    const storedTurns = parseJson<StoredTurn[]>(session.transcriptJson, []);
    const sourceTranscript = storedTurns
      .map((turn) => ({
        role: (turn.role === 'manager' || turn.role === 'assistant' ? 'manager' : 'client') as 'manager' | 'client',
        text: String(turn.text ?? turn.content ?? '').trim(),
      }))
      .filter((turn) => turn.text);
    const transcript = prepareTranscriptForAnalysis(sourceTranscript, {
      ivrDetected: session.ivrDetected,
    }).transcript;
    if (transcript.length < 2) {
      console.log(`[repair-call-reports] call=${session.id} skipped: transcript is too short`);
      unchanged += 1;
      continue;
    }
    const dimensionScores = evaluation.dimension_scores && typeof evaluation.dimension_scores === 'object'
      ? evaluation.dimension_scores as Record<string, number>
      : parseJson<Record<string, number> | undefined>(session.dimensionsJson, undefined);
    const totalScore = Number(session.totalScore ?? evaluation.overall_score_0_100 ?? 0);
    let report = normalizeUnifiedCallReport(
      evaluation.unified_call_report,
      { totalScore, transcript, dimensionScores, evaluation },
      catalog,
    );
    const hadReport = Boolean(report);
    report = report
      ? await ensureFindingBetterExamples(report, transcript)
      : await generateUnifiedCallReport({
        transcript,
        outcome: session.outcome,
        totalScore,
        evaluation,
        source: 'call',
      });
    const previous = JSON.stringify(evaluation.unified_call_report ?? null);
    const next = JSON.stringify(report);
    if (previous === next) {
      unchanged += 1;
      console.log(`[repair-call-reports] call=${session.id} unchanged`);
      continue;
    }
    evaluation.unified_call_report = report;
    await prisma.voiceCallSession.update({
      where: { id: session.id },
      data: { evaluationJson: JSON.stringify(evaluation) },
    });
    if (hadReport) repaired += 1;
    else generated += 1;
    console.log(`[repair-call-reports] call=${session.id} ${hadReport ? 'repaired' : 'generated'}`);
  }

  console.log(JSON.stringify({ day, scanned: sessions.length, repaired, generated, unchanged }));
}

main()
  .catch((error) => {
    console.error('[repair-call-reports] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
