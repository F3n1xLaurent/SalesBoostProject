import { existsSync } from 'node:fs';
import type { Request, Response } from 'express';
import type { TrainerRecordingInfo } from './trainerRecording';

export function createTrainerRecordingHandler(deps: {
  findScopedSession: (req: Request, id: string) => Promise<{ id: string; status: string } | null>;
  forReport: (id: string, status: string) => Promise<TrainerRecordingInfo>;
  recordingPath: (id: string) => string;
}) {
  return async (req: Request, res: Response) => {
    try {
      if (!req.authAccount) return res.status(401).json({ error: 'Требуется авторизация.' });
      const id = String(req.params.sessionId || '');
      const action = String(req.params.action || '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !['', 'status', 'download'].includes(action)) {
        return res.status(404).json({ error: 'Не найдено.' });
      }
      // Scope is checked before looking at the file or starting a background job.
      const session = await deps.findScopedSession(req, id);
      if (!session) return res.status(404).json({ error: 'Тренировка не найдена.' });
      const recording = await deps.forReport(id, session.status);
      res.setHeader('Cache-Control', 'private, no-store');
      if (action === 'status') return res.json(recording);
      if (recording.recordingStatus !== 'ready') {
        return res.status(409).json({ error: recording.recordingError || 'Запись ещё не готова.' });
      }
      const filePath = deps.recordingPath(id);
      if (!existsSync(filePath)) return res.status(404).json({ error: 'Файл записи недоступен.' });
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `${action === 'download' ? 'attachment' : 'inline'}; filename="trainer-${id}.mp3"`);
      return res.sendFile(filePath);
    } catch (error) {
      console.warn('[trainer-recording] request failed:', error instanceof Error ? error.message : error);
      return res.status(500).json({ error: 'Не удалось получить запись тренировки.' });
    }
  };
}
