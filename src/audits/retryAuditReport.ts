import type { Request, RequestHandler } from 'express';
import { auditAnalyticsProgress, scheduleAuditReportBackfill, type AnalyticsStage } from '../logic/auditAnalyticsProgress';

export type AuditReportRetryJob = {
  key: string;
  stage: AnalyticsStage;
  finished: boolean;
  unavailable: boolean;
  reportReady: boolean;
  run: () => Promise<void>;
};

/** The loader must apply exactly the same account scope as the audit detail endpoint. */
export function createRetryAuditReportHandler(loadScopedJob: (req: Request, id: string) => Promise<AuditReportRetryJob | null>): RequestHandler {
  return async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!/^(?:trainer-.+|(?:call-)?\d+)$/.test(id)) return void res.status(400).json({ error: 'Некорректная проверка.' });
      const job = await loadScopedJob(req, id);
      if (!job) return void res.status(404).json({ error: 'Проверка не найдена.' });
      if (!job.finished || job.unavailable || job.reportReady) {
        return void res.status(409).json({ error: job.unavailable ? 'Разговор не состоялся. Отчёт не формируется.' : job.reportReady ? 'Отчёт уже готов.' : 'Дождитесь завершения разговора.' });
      }
      const started = scheduleAuditReportBackfill(job.key, job.run, { retry: true, stage: job.stage });
      const progress = auditAnalyticsProgress({
        key: job.key, transcriptReady: job.stage !== 'transcription', evaluationReady: job.stage === 'report', reportReady: false,
      });
      if (!started && progress.status !== 'processing') {
        return void res.status(503).json({ error: 'Сервис подготовки отчётов занят. Попробуйте ещё раз позже.' });
      }
      // An already running job is a successful, idempotent response to a repeated click.
      res.status(202).json({ started, analyticsProgress: progress });
    } catch (error) {
      console.error('[audit-report] retry request failed:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Не удалось запустить подготовку отчёта. Попробуйте ещё раз.' });
    }
  };
}
