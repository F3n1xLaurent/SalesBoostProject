import { prisma } from '../src/db';
import { regenerateTrainerSessionReport } from '../src/server';

async function main() {
  const sessionId = String(process.argv[2] || '').trim();
  if (!sessionId) {
    throw new Error('Usage: npx tsx scripts/regenerate-trainer-report.ts <trainingId>');
  }

  console.log(`[trainer-report] regeneration started session=${sessionId}`);
  const session = await regenerateTrainerSessionReport(sessionId);
  console.log(JSON.stringify({
    ok: true,
    sessionId: session.id,
    status: session.status,
    score: session.score,
    baseScore: session.baseScore,
    finalPoints: session.finalPoints,
    updatedAt: session.updatedAt.toISOString(),
  }));
}

main()
  .catch((error) => {
    console.error('[trainer-report] regeneration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
