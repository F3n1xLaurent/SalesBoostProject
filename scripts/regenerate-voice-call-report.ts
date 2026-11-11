import { withReportTrace } from '../src/voice/reportExecution';
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/db';
import { regenerateVoiceReport } from '../src/audits/regenerateVoiceReport';

async function main() {
  const id = process.argv[2]?.trim();
  if (!id) throw new Error('Usage: node --import tsx scripts/regenerate-voice-call-report.ts <numeric-id|UUID>');
  const session = await prisma.voiceCallSession.findFirst({ where: /^\d+$/.test(id) ? { id: Number(id) } : { callId: id } });
  if (!session) throw new Error('CALL_NOT_FOUND');
  const folder = path.resolve('storage/analytics-regeneration', session.callId, `report-${Date.now()}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(path.join(folder, 'before.json'), JSON.stringify(session, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ id: session.id, callId: session.callId, stage: 'report_only', previousScore: session.totalScore }));
  const resumeIndex = process.argv.indexOf('--resume');
  const artifact = resumeIndex >= 0 ? JSON.parse(await readFile(process.argv[resumeIndex + 1], 'utf8')) : undefined;
  const draft = artifact?.content ? JSON.parse(artifact.content) : artifact;
  let sequence = 0;
  const report = await withReportTrace(async (stage, result) => {
    await writeFile(path.join(folder, `${String(++sequence).padStart(2, '0')}-${stage}.json`), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  }, () => regenerateVoiceReport(session.callId, draft));
  console.log(JSON.stringify({ ok: true, id: session.id, totalScore: report.totalScore, findings: report.keyFindings?.length, backup: folder }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
