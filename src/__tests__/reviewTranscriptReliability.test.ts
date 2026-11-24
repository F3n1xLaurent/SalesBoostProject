import { describe, expect, it } from 'vitest';
import { parseTranscriptReliabilityReview } from '../voice/reviewTranscriptReliability';
import { managerReplyContext, groundReportTurnComment } from '../voice/reportTurnGrounding';

describe('ASR evidence review', () => {
  const turns = [{ role: 'client', content: 'Выбираю для себя.' }, { role: 'manager', content: 'Отличные тумбы.' }];
  it('accepts only exact manager quotes with a confident reason', () => {
    const row = { turnIndex: 1, quote: turns[1].content, confidence: .96, reason: 'Не связано с обсуждением автомобиля.' };
    expect(parseTranscriptReliabilityReview(turns, { uncertainTurns: [row] })).toMatchObject([{ turnIndex: 1, token: turns[1].content }]);
    for (const invalid of [{ ...row, quote: 'Исправленная речь' }, { ...row, turnIndex: 0, quote: turns[0].content },
      { ...row, confidence: .6 }, { ...row, confidence: 1.2 }, { ...row, reason: '' }]) {
      expect(parseTranscriptReliabilityReview(turns, { uncertainTurns: [invalid] })).toEqual([]);
    }
  });
  it('includes the complete manager reply without leaking a later client disclosure', () => {
    const transcript = [{ role: 'client' as const, text: 'Какие есть акции?' },
      { role: 'manager' as const, text: 'Есть скидка за покупку в кредит.' },
      { role: 'manager' as const, text: 'И при сдаче автомобиля в trade-in.' },
      { role: 'client' as const, text: 'У меня машина 2017 года.' }];
    expect(managerReplyContext(transcript, 1)).toEqual([transcript[0], { role: 'manager', text: 'Есть скидка за покупку в кредит. И при сдаче автомобиля в trade-in.' }]);
    expect(JSON.stringify(managerReplyContext(transcript, 1))).not.toContain('2017');
  });
  it('distinguishes asking about a purchase deadline from receiving it', () => {
    const transcript = [{ role: 'manager' as const, text: 'В какой срок планируете покупку?' },
      { role: 'client' as const, text: 'В вашем центре.' }];
    expect(groundReportTurnComment('Менеджер выяснил сроки покупки.', 0, transcript)).toContain('спросил о сроке');
    transcript[1].text = 'Планирую на следующей неделе.';
    expect(groundReportTurnComment('Менеджер выяснил сроки покупки.', 0, transcript)).toBe('Менеджер выяснил сроки покупки.');
  });
});
