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

  it('excludes a separate IVR waiting message before the live manager', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Вы позвонили в автосалон «Тестовый». Для отдела продаж нажмите 1, для отдела сервиса нажмите 2.' },
      { role: 'manager', text: 'Пожалуйста, подождите связи с оператором.' },
      { role: 'manager', text: 'Добрый день! Меня зовут Никита, менеджер отдела продаж. Чем я могу вам помочь?' },
      { role: 'client', text: 'Добрый день! Звоню по Mercedes-Benz GLE Coupe.' },
    ];

    const result = prepareTranscriptForAnalysis(transcript, { ivrDetected: true });

    expect(result.reason).toBe('automatic_anchor');
    expect(result.removedPrefixTurns).toBe(2);
    expect(result.transcript).toEqual(transcript.slice(2));
  });

  it('preserves a live manager asking for time to check details', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Вы позвонили в автосалон «Тестовый». Для отдела продаж нажмите 1.' },
      { role: 'manager', text: 'Добрый день, меня зовут Анна. Чем могу помочь?' },
      { role: 'client', text: 'Подскажите стоимость обслуживания.' },
      { role: 'manager', text: 'Подождите, я уточню стоимость у специалиста.' },
    ];

    expect(prepareTranscriptForAnalysis(transcript).transcript).toEqual(transcript.slice(1));
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

  it('excludes both IVR and live call-centre operator before the salesperson', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Добро пожаловать. Для отдела продаж нажмите один.' },
      { role: 'client', text: '...' },
      { role: 'manager', text: 'Здравствуйте, кол-центр. Что вас интересует?' },
      { role: 'client', text: 'Автомобиль Шкода.' },
      { role: 'manager', text: 'Сейчас соединю вас с менеджером отдела продаж.' },
      { role: 'client', text: 'Спасибо, жду.' },
      { role: 'manager', text: 'Добрый день, меня зовут Анна. Чем помогу?' },
      { role: 'client', text: 'Подскажите цену автомобиля.' },
    ];
    const result = prepareTranscriptForAnalysis(transcript, { ivrDetected: true });
    expect(result.reason).toBe('operator_handoff');
    expect(result.removedPrefixTurns).toBe(6);
    expect(result.transcript).toEqual(transcript.slice(6));
  });

  it('does not grade the IVR or call-centre operator when transfer never completes', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Добро пожаловать в нашу компанию.' },
      { role: 'client', text: 'Соедините с продажами.' },
      { role: 'manager', text: 'Сейчас переключу на менеджера.' },
      { role: 'client', text: 'Жду.' },
    ];
    const result = prepareTranscriptForAnalysis(transcript, { ivrDetected: true });
    expect(result.reason).toBe('awaiting_handoff');
    expect(result.transcript).toEqual([]);
  });

  it('recognizes a call-centre introduction followed by a new employee even without explicit transfer words', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Здравствуйте, контактный центр. Чем помочь?' },
      { role: 'client', text: 'По объявлению на автомобиль.' },
      { role: 'manager', text: 'Добрый день, отдел продаж, меня зовут Ирина.' },
      { role: 'client', text: 'Автомобиль ещё есть?' },
    ];
    const result = prepareTranscriptForAnalysis(transcript);
    expect(result.reason).toBe('operator_handoff');
    expect(result.transcript).toEqual(transcript.slice(2));
  });

  it('keeps a real manager conversation when the manager offers a later transfer', () => {
    const transcript: TranscriptTurn[] = [
      { role: 'manager', text: 'Здравствуйте, меня зовут Ирина, менеджер по продажам.' },
      { role: 'client', text: 'Подскажите условия кредита.' },
      { role: 'manager', text: 'Сейчас соединю вас с кредитным специалистом.' },
      { role: 'client', text: 'Хорошо, спасибо.' },
    ];
    expect(prepareTranscriptForAnalysis(transcript).transcript).toEqual(transcript);
  });
});
