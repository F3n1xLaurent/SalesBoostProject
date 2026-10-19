import { describe, expect, it } from 'vitest';
import { mergeCallRetranscription } from '../voice/callRetranscription';

const original = [
  { role: 'manager' as const, text: 'Добрый день, меня зовут Никита. Чем могу помочь?' },
  { role: 'client' as const, text: 'Звоню по Шкоде Октавии. Она еще в продаже?' },
  { role: 'manager' as const, text: '¿Bien?' },
  { role: 'client' as const, text: 'Какой у нее пробег?' },
];

const segments = [
  { speaker: 'A', start: 1, end: 3, text: 'Добрый день, меня зовут Никита. Чем могу помочь?' },
  { speaker: 'B', start: 4, end: 6, text: 'Звоню по Шкоде Октавии. Она еще в продаже?' },
  { speaker: 'A', start: 7, end: 8, text: 'Нет.' },
  { speaker: 'B', start: 9, end: 10, text: 'Какой у нее пробег?' },
];

describe('call recording second-pass transcription', () => {
  it('corrects manager ASR but retains exact generated agent lines', () => {
    const corrected = mergeCallRetranscription(original, segments);
    expect(corrected).toEqual([
      original[0], original[1], { role: 'manager', text: 'Нет.' }, original[3],
    ]);
  });

  it('rejects a missing or reordered speaker turn', () => {
    expect(mergeCallRetranscription(original, segments.slice(0, 3))).toBeNull();
    expect(mergeCallRetranscription(original, segments.map((segment) => ({ ...segment, speaker: 'A' })))).toBeNull();
  });

  it('joins STT chunks from the same utterance before alignment', () => {
    const split = [
      segments[0],
      { speaker: 'B', start: 4, end: 5, text: 'Звоню по Шкоде Октавии.' },
      { speaker: 'B', start: 5.2, end: 6, text: 'Она еще в продаже?' },
      ...segments.slice(2),
    ];
    expect(mergeCallRetranscription(original, split)?.[2].text).toBe('Нет.');
  });
});
