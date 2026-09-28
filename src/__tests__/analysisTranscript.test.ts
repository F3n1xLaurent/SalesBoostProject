import { describe, expect, it } from 'vitest';
import { prepareTranscriptForAnalysis } from '../voice/analysisTranscript';
import type { TranscriptTurn } from '../voice/callHistory';

describe('analysis transcript preparation', () => {
  it('removes the automatic prefix from call 199 using the IVR greeting', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Добро пожаловать в группу компаний «Канавто». Все разговоры записываются. Пожалуйста, дождитесь ответа оператора.' },
      { role: 'client', text: 'Я буду ждать, когда мне ответит живой оператор.' },
      { role: 'manager', text: 'Алло, это консультант, администратор Камила. Добрый день.' },
      { role: 'client', text: 'Здравствуйте! Автомобиль ещё в продаже?' },
    ];

    const result = prepareTranscriptForAnalysis(transcript, { ivrDetected: true });

    expect(result.removedPrefixTurns).toBe(2);
    expect(result.reason).toBe('automatic_anchor');
    expect(result.transcript[0]?.text).toContain('Камила');
  });

  it('finds the live conversation in call 235 even when ivrDetected is false', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Добро пожаловать в группу компаний «Канавто». Для улучшения качества обслуживания клиентов все разговоры записываются.' },
      { role: 'client', text: 'Понял, буду ждать.' },
      { role: 'manager', text: '...' },
      { role: 'client', text: 'Здравствуйте! Автомобиль ещё в продаже?' },
      { role: 'manager', text: '...' },
      { role: 'client', text: 'Здравствуйте! Автомобиль ещё в продаже?' },
      { role: 'manager', text: 'Здравствуйте, Сергей! Дамир меня зовут, отдел продаж «Канавто».' },
      { role: 'client', text: 'Привет, Дамир! Автомобиль ещё не продали?' },
    ];

    const result = prepareTranscriptForAnalysis(transcript, { ivrDetected: false });

    expect(result.removedPrefixTurns).toBe(6);
    expect(result.reason).toBe('automatic_anchor');
    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[0]?.text).toContain('Дамир');
  });

  it('uses a second greeting only when the prefix looks like connection waiting', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Здравствуйте! Компания «Ромашка».' },
      { role: 'client', text: 'Алло?' },
      { role: 'manager', text: '...' },
      { role: 'client', text: 'Алло?' },
      { role: 'manager', text: '...' },
      { role: 'manager', text: 'Добрый день, Анна меня зовут. Чем могу помочь?' },
      { role: 'client', text: 'Подскажите стоимость товара.' },
    ];

    const result = prepareTranscriptForAnalysis(transcript);

    expect(result.removedPrefixTurns).toBe(5);
    expect(result.reason).toBe('second_greeting');
  });

  it('does not cut a normal conversation merely because a greeting was repeated', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Здравствуйте!' },
      { role: 'client', text: 'Добрый день, подскажите стоимость автомобиля.' },
      { role: 'manager', text: 'Здравствуйте ещё раз. Сейчас посмотрю стоимость.' },
      { role: 'client', text: 'Хорошо.' },
    ];

    const result = prepareTranscriptForAnalysis(transcript);

    expect(result.removedPrefixTurns).toBe(0);
    expect(result.transcript).toEqual(transcript);
  });

  it('recognizes a voice menu that does not ask the caller to wait', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Для отдела продаж нажмите один. Для сервиса нажмите два.' },
      { role: 'client', text: '...' },
      { role: 'manager', text: 'Алло, отдел продаж, слушаю вас.' },
      { role: 'client', text: 'Здравствуйте, подскажите по автомобилю.' },
    ];

    const result = prepareTranscriptForAnalysis(transcript);

    expect(result.removedPrefixTurns).toBe(2);
    expect(result.transcript[0]?.text).toContain('отдел продаж');
  });
});
