import { describe, expect, it } from 'vitest';
import { classifyLiveSpeakerLocally, normalizeLiveSpeakerDecision } from '../voice/callLiveSpeakerClassifier';

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

describe('fast local live speaker classifier', () => {
  it('accepts common live replies and introductions immediately', () => {
    expect(classifyLiveSpeakerLocally('Да?')?.speakerType).toBe('live_human');
    expect(classifyLiveSpeakerLocally('Здравствуйте, меня зовут Анна.')?.speakerType).toBe('live_human');
    expect(classifyLiveSpeakerLocally('Алексей, менеджер отдела продаж.')?.speakerType).toBe('live_human');
  });

  it('rejects recordings before considering greeting words', () => {
    expect(classifyLiveSpeakerLocally('Здравствуйте! Вас приветствует компания.')?.speakerType).toBe('ivr_or_recording');
    expect(classifyLiveSpeakerLocally('Это автоматический помощник.')?.speakerType).toBe('ivr_or_recording');
    expect(classifyLiveSpeakerLocally('Набранный вами абонент недоступен.')?.speakerType).toBe('ivr_or_recording');
  });

  it('leaves genuinely ambiguous speech for the remote decision model', () => {
    expect(classifyLiveSpeakerLocally('Автогарант.')).toBeNull();
    expect(classifyLiveSpeakerLocally('Минуточку.')).toBeNull();
  });
});
