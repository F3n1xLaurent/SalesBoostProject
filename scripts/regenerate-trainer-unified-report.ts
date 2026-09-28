import { prisma } from '../src/db';
import { generateUnifiedTrainerReport } from '../src/voice/unifiedCallReport';

type StoredTranscriptTurn = {
  role?: string;
  text?: string;
  content?: string;
};

async function main() {
  const sessionId = String(process.argv[2] || '').trim();
  if (!sessionId) {
    throw new Error('Usage: npx tsx scripts/regenerate-trainer-unified-report.ts <trainingId>');
  }

  const session = await prisma.trainerSession.findUnique({
    where: { id: sessionId },
    include: { scenario: { select: { name: true } } },
  });
  if (!session) throw new Error('TRAINER_SESSION_NOT_FOUND');

  const evaluation = session.evaluationJson
    ? JSON.parse(session.evaluationJson) as Record<string, unknown>
    : {};
  const transcriptRaw = JSON.parse(session.transcriptJson || '[]') as StoredTranscriptTurn[];
  const transcript = transcriptRaw
    .map((turn) => ({
      role: (turn.role === 'manager' || turn.role === 'assistant' ? 'manager' : 'client') as 'manager' | 'client',
      text: String(turn.text || turn.content || '').trim(),
    }))
    .filter((turn) => turn.text);
  if (transcript.length < 2) throw new Error('TRAINER_TRANSCRIPT_TOO_SHORT');

  console.log(`[trainer-report] unified report generation started session=${sessionId}`);
  const report = await generateUnifiedTrainerReport({
    transcript,
    totalScore: session.score ?? session.baseScore ?? 0,
    evaluation,
    scenarioName: session.scenario?.name ?? null,
  });
  await prisma.trainerSession.update({
    where: { id: session.id },
    data: {
      evaluationJson: JSON.stringify({
        ...evaluation,
        unified_call_report: report,
      }),
    },
  });
  console.log(JSON.stringify({
    ok: true,
    sessionId,
    score: session.score,
    findings: report.keyFindings.length,
    recommendations: report.recommendations.length,
  }));
}

main()
  .catch((error) => {
    console.error('[trainer-report] unified report generation failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
