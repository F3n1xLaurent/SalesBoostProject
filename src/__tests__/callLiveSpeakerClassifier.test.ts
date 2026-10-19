import { describe, expect, it } from 'vitest';
import { normalizeLiveSpeakerDecision } from '../voice/callLiveSpeakerClassifier';

describe('live speaker classifier contract', () => {
  it('accepts only a high-confidence live human decision', () => {
    expect(normalizeLiveSpeakerDecision({
      speakerType: 'live_human',
      confidence: 0.92,
      reason: 'Человек ответил на звонок.',
    })).toMatchObject({ speakerType: 'live_human', confidence: 0.92 });

    expect(normalizeLiveSpeakerDecision({
      speakerType: 'live_human',
      confidence: 0.74,
      reason: 'Недостаточно контекста.',
    })).toMatchObject({ speakerType: 'uncertain', confidence: 0.74 });
  });

  it('keeps conservative non-human decisions and clamps confidence', () => {
    expect(normalizeLiveSpeakerDecision({
      speakerType: 'ivr_or_recording',
      confidence: 4,
      reason: 'Автоматическая просьба ожидать.',
    })).toMatchObject({ speakerType: 'ivr_or_recording', confidence: 1 });

    expect(normalizeLiveSpeakerDecision({
      speakerType: 'unexpected',
      confidence: Number.NaN,
    })).toMatchObject({ speakerType: 'uncertain', confidence: 0 });
  });
});
