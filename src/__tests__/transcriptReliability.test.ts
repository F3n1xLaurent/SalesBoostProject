import { describe, expect, it } from 'vitest';
import { filterUnreliableManagerTurns, isUnreliableManagerUtterance } from '../voice/transcriptReliability';

describe('analysis transcript reliability', () => {
  it('does not score visibly broken ASR as manager answers', () => {
    const transcript = [
      { role: 'client' as const, text: 'На что обращать внимание?' },
      { role: 'manager' as const, text: 'обращать внимание физиче' },
      { role: 'manager' as const, text: 'для вас ха-- актуально' },
      { role: 'manager' as const, text: 'Рекомендую проверить двигатель и ходовую часть.' },
    ];
    expect(filterUnreliableManagerTurns(transcript)).toEqual([transcript[0], transcript[3]]);
  });

  it('keeps short but clear answers and ordinary hyphenated words', () => {
    expect(isUnreliableManagerUtterance('Нет, автомобиль в наличии.')).toBe(false);
    expect(isUnreliableManagerUtterance('Тест-драйв можно согласовать на завтра.')).toBe(false);
  });
});
