export type TrainerTurnTimings = Partial<Record<
  'initializationMs' | 'sttMs' | 'textMs' | 'ttsMs' | 'persistenceMs', number
>> & { totalMs: number };

/** Whole-message delivery still needs stage timings, not a streaming connection. */
export function createTrainerTurnTimer() {
  const started = performance.now();
  const stages: Omit<TrainerTurnTimings, 'totalMs'> = {};
  return {
    async measure<T>(stage: keyof typeof stages, operation: () => Promise<T>): Promise<T> {
      const stepStarted = performance.now();
      try {
        return await operation();
      } finally {
        stages[stage] = Math.round((stages[stage] ?? 0) + performance.now() - stepStarted);
      }
    },
    snapshot(): TrainerTurnTimings {
      return { ...stages, totalMs: Math.round(performance.now() - started) };
    },
  };
}

/** POST already returns the new audio separately; history audio is loaded on GET. */
export function trainerTranscriptWithoutAudio<T extends { audioBase64?: unknown; audioMimeType?: unknown }>(
  transcript: T[],
): Array<Omit<T, 'audioBase64' | 'audioMimeType'>> {
  return transcript.map(({ audioBase64: _audio, audioMimeType: _mime, ...turn }) => turn);
}
