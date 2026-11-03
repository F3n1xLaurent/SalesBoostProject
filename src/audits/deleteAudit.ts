import type { PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import { deletedAuditMarkerId } from './deletedAudit';
import { isUnavailableCallOutcome } from '../voice/voxCallOutcome';

function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
const day = (date: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const dayNumber = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86400000;

export function calculateTrainerStreak(dates: Date[], now = new Date()) {
  const days = [...new Set(dates.map(day))].sort();
  let run = 0;
  let longestStreak = 0;
  days.forEach((value, index) => {
    run = index && dayNumber(value) - dayNumber(days[index - 1]) === 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  });
  const lastActiveDate = days.at(-1) ?? null;
  const age = lastActiveDate ? dayNumber(day(now)) - dayNumber(lastActiveDate) : Infinity;
  return { currentStreak: age >= 0 && age <= 1 ? run : 0, longestStreak, lastActiveDate };
}

export function createDeleteAuditHandler({ db, invalidateAnalytics, isCallProcessing = () => false }: {
  db: PrismaClient;
  invalidateAnalytics: () => void;
  isCallProcessing?: (callId: string) => boolean;
}): RequestHandler {
  return async (req, res) => {
    if (!req.authAccount) { res.status(401).json({ error: 'Требуется авторизация.' }); return; }
    if (!req.authAccount.memberships.some((membership) => membership.role === 'platform_superadmin')) {
      res.status(403).json({ error: 'Удалять проверки может только суперадмин.' }); return;
    }
    const id = String(req.params.id ?? '');
    const callMatch = /^call-([1-9]\d*)$/.exec(id);
    const trainerMatch = /^trainer-([a-zA-Z0-9_-]{1,100})$/.exec(id);
    if ((!callMatch && !trainerMatch) || (callMatch && !Number.isSafeInteger(Number(callMatch[1])))) {
      res.status(400).json({ error: 'Некорректный идентификатор проверки.' }); return;
    }
    try {
      await db.$transaction(async (tx) => {
        if (callMatch) {
          const session = await tx.voiceCallSession.findUnique({ where: { id: Number(callMatch[1]) } });
          if (!session) fail(404, 'Звонок не найден.');
          if (!session.endedAt || isCallProcessing(session.callId)) fail(409, 'Дождитесь завершения звонка и обработки отчёта.');
          const jobs = await tx.callBatchJob.findMany({ where: { OR: [
            { lastVoiceCallId: session.callId }, { linkedAuditId: id }, { attempts: { some: { voiceCallId: session.callId } } },
          ] } });
          if (jobs.some((job) => ['queued', 'dialing', 'in_progress', 'retry_wait'].includes(job.status))) {
            fail(409, 'Дождитесь завершения прозвона, прежде чем удалять эту проверку.');
          }
          await tx.productAnalyticsEvent.deleteMany({ where: { targetType: 'voice_call', targetId: session.callId } });
          await tx.productAnalyticsEvent.create({ data: {
            id: deletedAuditMarkerId(session.callId), eventName: 'audit_deleted', accountId: req.authAccount!.id,
            role: 'platform_superadmin', targetType: 'deleted_voice_call', targetId: session.callId,
          } });
          await tx.callPlanCall.deleteMany({ where: { callId: session.callId } });
          await tx.callBatchAttempt.deleteMany({ where: { voiceCallId: session.callId } });
          for (const job of jobs) {
            const lastAttempt = await tx.callBatchAttempt.findFirst({ where: { jobId: job.id }, orderBy: { attempt: 'desc' } });
            if (!lastAttempt) {
              await tx.callBatchJob.delete({ where: { id: job.id } });
            } else {
              const remainingSession = await tx.voiceCallSession.findUnique({ where: { callId: lastAttempt.voiceCallId }, select: { id: true } });
              await tx.callBatchJob.update({ where: { id: job.id }, data: {
                status: job.status === 'cancelled' ? 'cancelled' : isUnavailableCallOutcome(lastAttempt.outcome) ? 'failed' : 'completed',
                lastVoiceCallId: lastAttempt.voiceCallId,
                linkedAuditId: remainingSession ? `call-${remainingSession.id}` : null,
                lastOutcome: lastAttempt.outcome, lastError: lastAttempt.error, endedAt: lastAttempt.endedAt,
                linkReason: remainingSession ? null : 'no_call_review_yet',
              } });
            }
          }
          for (const batchId of new Set(jobs.map((job) => job.batchId))) {
            const remaining = await tx.callBatchJob.findMany({ where: { batchId }, select: { status: true } });
            const count = (...statuses: string[]) => remaining.filter((job) => statuses.includes(job.status)).length;
            await tx.callBatch.update({ where: { id: batchId }, data: {
              totalJobs: remaining.length, queuedJobs: count('queued'), inProgressJobs: count('dialing', 'in_progress'),
              completedJobs: count('completed'), failedJobs: count('failed'), cancelledJobs: count('cancelled'), retryingJobs: count('retry_wait'),
            } });
          }
          await tx.voiceCallSession.delete({ where: { id: session.id } });
        } else {
          const session = await tx.trainerSession.findUnique({ where: { id: trainerMatch![1] } });
          if (!session) fail(404, 'Тренировка не найдена.');
          if (!['completed', 'failed', 'cancelled'].includes(session.status)) fail(409, 'Дождитесь завершения тренировки.');
          await tx.productAnalyticsEvent.deleteMany({ where: { targetType: 'trainer_session', targetId: session.id } });
          await tx.productAnalyticsEvent.create({ data: {
            eventName: 'audit_deleted', accountId: req.authAccount!.id, role: 'platform_superadmin',
            targetType: 'deleted_trainer_session', targetId: session.id,
          } });
          await tx.trainerSession.delete({ where: { id: session.id } }); // TrainerScore is removed by the FK cascade.
          const plans = await tx.trainerDailyPlan.findMany({ where: { employeeId: session.employeeId } });
          for (const plan of plans) {
            let items: unknown;
            try { items = JSON.parse(plan.sessionsJson); } catch { continue; }
            if (!Array.isArray(items)) continue;
            const next = items.filter((item) => item?.trainerSessionId !== session.id);
            if (next.length !== items.length) await tx.trainerDailyPlan.update({ where: { id: plan.id }, data: { sessionsJson: JSON.stringify(next) } });
          }
          const completed = await tx.trainerSession.findMany({ where: { employeeId: session.employeeId, status: 'completed' }, select: { startedAt: true } });
          const streak = calculateTrainerStreak(completed.map((item) => item.startedAt));
          await tx.trainerStreak.upsert({ where: { employeeId: session.employeeId }, create: { employeeId: session.employeeId, ...streak }, update: streak });
        }
      }, { timeout: 15000 });
      invalidateAnalytics();
      res.json({ success: true });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status) { res.status(status).json({ error: (error as Error).message }); return; }
      console.error('[audits] delete failed', error);
      res.status(500).json({ error: 'Не удалось удалить проверку. Попробуйте ещё раз.' });
    }
  };
}
