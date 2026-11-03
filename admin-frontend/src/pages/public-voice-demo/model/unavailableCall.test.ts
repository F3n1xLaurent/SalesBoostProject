import { describe, expect, it } from 'vitest';
import { getUnavailableCall } from './unavailableCall';

const call = {
  endedAt: '2026-11-03T10:41:00Z', outcome: 'disconnected', isProcessing: false,
  transcript: [
    { role: 'manager' as const, text: 'Здравствуйте, слушаю вас.' },
    { role: 'client' as const, text: 'Сколько стоит автомобиль?' },
    { role: 'manager' as const, text: 'Два миллиона рублей.' },
  ],
};

describe('demo call without a conversation', () => {
  it('keeps active calls on the waiting screen', () => {
    expect(getUnavailableCall(null)).toBeNull();
    expect(getUnavailableCall({ ...call, endedAt: null, outcome: 'ringing' })).toBeNull();
  });

  it.each(['no_answer', 'busy', 'failed', 'cancelled'])('shows a terminal %s immediately, even if processing was set', (outcome) => {
    expect(getUnavailableCall({ ...call, outcome, isProcessing: true, transcript: [] })).toBe('missed');
    expect(getUnavailableCall({ ...call, outcome, endedAt: null })).toBe('missed');
  });

  it('hides the old empty report for call 51cc6f39, regardless of the old disconnected status', () => {
    const transcript = [
      { role: 'manager' as const, text: 'Приветствую! Линия абонента сейчас занята. Что важного ему передать?' },
      { role: 'manager' as const, text: 'Я голосовой ассистент Миа. Запишу всё слово в слово. Попробуем? Вы не хотите со мной разговаривать? Или меня просто не слышно?' },
      { role: 'manager' as const, text: 'Со мной интересно? Честно-честно. Может быть, кто-нибудь всё-таки захочет поговорить со мной?' },
    ];
    expect(getUnavailableCall({ ...call, transcript })).toBe('missed');
  });

  it('keeps a real conversation eligible for the report', () => {
    expect(getUnavailableCall(call)).toBeNull();
    expect(getUnavailableCall({ ...call, isProcessing: true })).toBeNull();
  });

  it('waits for a missing transcript while processing and shows insufficient data when it finishes', () => {
    expect(getUnavailableCall({ ...call, transcript: [], isProcessing: true })).toBeNull();
    expect(getUnavailableCall({ ...call, transcript: [] })).toBe('insufficient');
  });
});
