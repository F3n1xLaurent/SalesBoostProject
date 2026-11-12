import { describe, expect, it } from 'vitest';
import { filterUnreliableManagerTurns, isConnectionCheckTurn, isUnreliableManagerUtterance } from '../voice/transcriptReliability';

describe('analysis transcript reliability', () => {
  it('1147: treats a known customer name after an audibility check as a connection check', () => {
    const transcript = [{ role: 'manager' as const, text: 'Дмитрий, давайте обсудим визит.' },
      { role: 'client' as const, text: 'Хорошо.' }, { role: 'manager' as const, text: 'Алло.' }, { role: 'manager' as const, text: 'Дмитрий.' }];
    expect(isConnectionCheckTurn(transcript, 3)).toBe(true);
    expect(isConnectionCheckTurn([...transcript.slice(0, 3), { role: 'manager', text: 'Автомат.' }], 3)).toBe(false);
    expect(isConnectionCheckTurn([{ role: 'manager', text: 'Дмитрий.' }], 0)).toBe(false);
  });
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
