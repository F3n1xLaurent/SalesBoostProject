import { describe, expect, it } from 'vitest';
import { sanitizeTranscriptText, sanitizeTranscriptTurns } from '../voice/transcriptSanitizer';

describe('transcript sanitizer', () => {
  it('removes English annotations in square brackets', () => {
    expect(sanitizeTranscriptText('Это [expensive] слишком дорого [background noise].'))
      .toBe('Это слишком дорого.');
  });

  it('removes Russian annotations too', () => {
    expect(sanitizeTranscriptText('[неразборчиво] Повторите, пожалуйста.'))
      .toBe('Повторите, пожалуйста.');
  });

  it('drops turns that contain only a service annotation', () => {
    expect(sanitizeTranscriptTurns([
      { role: 'client' as const, text: '[laughter]' },
      { role: 'manager' as const, text: 'Добрый день [crosstalk]' },
    ])).toEqual([
      { role: 'manager', text: 'Добрый день' },
    ]);
  });
});
