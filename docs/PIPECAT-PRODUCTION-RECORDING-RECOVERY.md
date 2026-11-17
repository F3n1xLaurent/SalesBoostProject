# Восстановление записи старого Pipecat-звонка

Для звонка `/audits?callId=1260` через диагностический API подтверждён `callId=8c6a9669-dc47-4c58-9cd8-32ff6eb0631c`. Read-only GetCallHistory подтвердил соответствующую сессию Voximplant `5252226572` с одной записью. На момент проверки в платформе `voxSessionId` и `recordingStatus` были пустыми.

Сначала выложить исправления шлюза, подготовки звонка и проверки времени:

```sh
docker compose -f compose.prod.yaml -f compose.pipecat.prod.yaml up -d --build app pipecat
```

Сценарий `voice_pipecat` уже обновлён через Management API: исправлено поле `AppEvents.Started.sessionID`, сохранён вызов stereo record. Новый SHA-256: `729fcb22a2cf13a26382bf91ecc012891a10a09543c4f7da5629560748c68a47`. Предыдущая версия сохранена локально скриптом выкладки.

Чтобы подтянуть существующую запись 1260 в платформу, выполнить на production из `/srv/salesboost`:

```sh
docker compose -f compose.prod.yaml -f compose.pipecat.prod.yaml exec -T app node <<'NODE'
const { prisma } = require('./dist/src/db.js');
const { scheduleRecordingFetch } = require('./dist/src/voice/voximplantRecordingService.js');
const callId = '8c6a9669-dc47-4c58-9cd8-32ff6eb0631c';
const voxSessionId = '5252226572';
async function main() {
  const row = await prisma.voiceCallSession.findUnique({ where: { callId } });
  if (!row || row.id !== 1260 || row.scenario !== 'pipecat' || !row.endedAt) throw new Error('Звонок не соответствует проверенному завершённому звонку 1260');
  if (row.voxSessionId && row.voxSessionId !== voxSessionId) throw new Error('У звонка уже указан другой Vox session ID');
  if (row.recordingStatus === 'ready') { console.log('Запись уже загружена'); return; }
  const job = await prisma.callAnalysisJob.findUnique({ where: { callId } });
  if (job && ['queued', 'processing'].includes(job.status)) throw new Error('Дождитесь завершения текущего анализа');
  await prisma.voiceCallSession.update({ where: { callId }, data: { voxSessionId, recordingStatus: 'pending' } });
  await scheduleRecordingFetch(callId, voxSessionId);
  const saved = await prisma.voiceCallSession.findUnique({ where: { callId }, select: { recordingStatus: true } });
  if (saved?.recordingStatus !== 'ready') throw new Error('Запись не загрузилась; проверьте сообщения Voximplant recording выше');
  console.log('Запись звонка 1260 загружена. Можно повторить подготовку отчёта на странице проверки.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
NODE
```

Команда не совершает звонок и не запускает оценку. После загрузки записи нажать повторную подготовку отчёта на странице 1260: backend заново выполнит оценку с исправленной проверкой времени. Пакет диагностики, использованный для расследования, не изменял production-данные. Команда восстановления записи на production в ходе исправления не выполнялась.
