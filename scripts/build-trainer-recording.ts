import 'dotenv/config';
import { prisma } from '../src/db';
import { trainerRecordingService, trainerRecordingPath } from '../src/trainer/trainerRecording';

async function main() {
  const id = String(process.argv[2] || '').trim();
  if (!id) throw new Error('Usage: node --import tsx scripts/build-trainer-recording.ts <sessionId>');
  const info = await trainerRecordingService.schedule(id);
  console.log(JSON.stringify({ sessionId: id, ...info, path: info.recordingStatus === 'ready' ? trainerRecordingPath(id) : null }, null, 2));
  if (info.recordingStatus !== 'ready') process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
