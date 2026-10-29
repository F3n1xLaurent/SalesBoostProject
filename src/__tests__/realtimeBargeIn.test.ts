import { describe, expect, it } from 'vitest';
import {
  appendSpeechAlignment,
  audibleTextAt,
  isCumulativeTranscriptUpdate,
  type SpeechAlignmentPoint,
} from '../voice/realtimeBargeIn';

describe('realtime barge-in context', () => {
  it('maps ElevenLabs chunk alignment to the call playout timeline', () => {
    const points: SpeechAlignmentPoint[] = [];
    appendSpeechAlignment(points, {
      chars: ['Х', 'о'],
      char_start_times_ms: [0, 80],
      char_durations_ms: [80, 90],
    }, 400);
    expect(points).toEqual([
      { character: 'Х', endMs: 480 },
      { character: 'о', endMs: 570 },
    ]);
  });

  it('keeps only complete words that were heard before speech started', () => {
    const text = '[conversational] Хорошо. Тогда давайте так';
    const points = Array.from(text).map((character, index) => ({ character, endMs: (index + 1) * 50 }));
    expect(audibleTextAt(points, 1500, text, 2500)).toBe('Хорошо.');
  });

  it('never exposes a partial Eleven v4 direction tag as heard speech', () => {
    const partialTag = Array.from('[conversational,').map((character, index) => ({
      character,
      endMs: (index + 1) * 5,
    }));
    expect(audibleTextAt(partialTag, 300, 'Хорошо. Тогда продолжим', 2000)).toBe('');
  });

  it('falls back to a conservative word boundary without alignment', () => {
    expect(audibleTextAt([], 1100, 'Хорошо. Тогда задаю вопрос', 3000)).toBe('Хорошо.');
  });

  it('never imports damaged alignment spelling into conversation history', () => {
    const points = Array.from('брыйдень, меня зовут').map((character, index) => ({ character, endMs: index * 10 }));
    expect(audibleTextAt(points, 1500, 'Добрый день, меня зовут Алексей.', 3000)).toBe('');
    const goodThenBad = Array.from('Хорошо. дбрый день,').map((character, index) => ({ character, endMs: index * 10 }));
    expect(audibleTextAt(goodThenBad, 1500, 'Хорошо. Добрый день, меня зовут Алексей.', 3000)).toBe('Хорошо.');
  });

  it('uses original spacing and punctuation when alignment omits spaces', () => {
    const points = Array.from('Добрыйдень,').map((character, index) => ({ character, endMs: index * 10 }));
    expect(audibleTextAt(points, 1500, 'Добрый день, меня зовут Алексей.', 3000)).toBe('Добрый день,');
  });

  it('does not splice later characters around an unheard or missing character', () => {
    const points = [{ character: 'Д', endMs: 50 }, { character: 'а', endMs: 900 }, { character: ' ', endMs: 70 }];
    expect(audibleTextAt(points, 300, 'Да конечно', 1000)).toBe('');
    const missing: SpeechAlignmentPoint[] = [];
    appendSpeechAlignment(missing, { chars: ['Д', 'а', ' '], char_start_times_ms: [0, undefined, 80], char_durations_ms: [50, 50, 50] }, 0);
    expect(missing[1].endMs).toBe(Infinity);
    expect(audibleTextAt(missing, 400, 'Да конечно', 1000)).toBe('');
  });

  it('detects cumulative recognition updates but preserves separate turns', () => {
    expect(isCumulativeTranscriptUpdate(
      'да добрый день',
      'да добрый день актуально',
      '2026-10-23T05:06:17.500Z',
      '2026-10-23T05:06:18.100Z',
    )).toBe(true);
    expect(isCumulativeTranscriptUpdate(
      'да',
      'да можем обсудить',
      '2026-10-23T05:06:17.500Z',
      '2026-10-23T05:06:22.100Z',
    )).toBe(false);
    expect(isCumulativeTranscriptUpdate(
      'да все верно пробег актуальный только смотрите там на машину производится',
      'да все верно пробег актуальный только смотрите там на машину производятся периодически всякие тесты',
      '2026-10-23T05:06:17.500Z',
      '2026-10-23T05:06:21.100Z',
      6500,
    )).toBe(true);
  });
});
