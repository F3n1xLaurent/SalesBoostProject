import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrainerTurnTimer, trainerTranscriptWithoutAudio } from '../trainer/trainerTurnPerformance';

afterEach(() => vi.useRealTimers());

describe('trainer whole-message response performance', () => {
  it('returns text history without retransmitting audio or mutating persisted turns', () => {
    const transcript = [
      { role: 'manager', text: 'Здравствуйте', audioBase64: 'large-manager-audio', audioMimeType: 'audio/wav' },
      { role: 'client', text: 'Добрый день', audioBase64: 'large-client-audio', audioMimeType: 'audio/ogg' },
    ];
    expect(trainerTranscriptWithoutAudio(transcript)).toEqual([
      { role: 'manager', text: 'Здравствуйте' }, { role: 'client', text: 'Добрый день' },
    ]);
    expect(transcript[0].audioBase64).toBe('large-manager-audio');
    expect(transcript[1].audioBase64).toBe('large-client-audio');
  });

  it('measures stages, accumulates retries, and preserves returned audio', async () => {
    vi.useFakeTimers();
    const timer = createTrainerTurnTimer();
    const pending = timer.measure('ttsMs', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return Buffer.from('whole-audio');
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual(Buffer.from('whole-audio'));
    await timer.measure('ttsMs', async () => { await vi.advanceTimersByTimeAsync(50); });
    await timer.measure('sttMs', async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(timer.snapshot()).toEqual({ ttsMs: 550, sttMs: 200, totalMs: 750 });
  });

  it('records failed-stage duration without swallowing errors', async () => {
    vi.useFakeTimers();
    const timer = createTrainerTurnTimer();
    await expect(timer.measure('sttMs', async () => {
      await vi.advanceTimersByTimeAsync(100);
      throw new Error('STT unavailable');
    })).rejects.toThrow('STT unavailable');
    expect(timer.snapshot().sttMs).toBe(100);
  });
});
