import { describe, expect, it } from 'vitest';
import {
  assessUserTurnCompletion,
  classifyInterruption,
  looksLikeContinuingThought,
  mergeLogicalTurnText,
  mergeTranscriptionHypothesis,
  normalizeConversationText,
  openingTurnNeedsIntroGrace,
  sourceLooksLikeQuestion,
  userTurnEndpoint,
} from '../voice/realtimeConversationFlow';

const classify = (text: string, awaitingAnswer = false, final = true) => classifyInterruption(text, {
  awaitingAnswer,
  final,
  minMeaningfulWords: 2,
});

describe('realtime conversation flow', () => {
  it('normalizes punctuation and acknowledgement variants', () => {
    expect(normalizeConversationText('  М-м... АГА! ')).toBe('м м ага');
    expect(classify('м-м').kind).toBe('backchannel');
    expect(classify('ага, угу').kind).toBe('backchannel');
  });

  it('distinguishes acknowledgements from actual interruptions', () => {
    expect(classify('угу').kind).toBe('backchannel');
    expect(classify('да-да').kind).toBe('backchannel');
    expect(classify('так').kind).toBe('backchannel');
    expect(classify('понял').kind).toBe('backchannel');
    expect(classify('', false, true).kind).toBe('noise');
    expect(classify('подождите, пожалуйста').reason).toBe('strong_command');
    expect(classify('стоп', false, false).kind).toBe('interrupt');
    expect(classify('А можно уточнить?', false, false).kind).toBe('interrupt');
    expect(classify('угу, а скажите про скидку', false, false).kind).toBe('interrupt');
    expect(classify('скидка', false, false).kind).toBe('candidate');
  });

  it('keeps one-word answers when a question is awaiting an answer', () => {
    expect(classify('да', true).reason).toBe('answer_to_question');
    expect(classify('нет', true).kind).toBe('interrupt');
    expect(classify('угу', true).kind).toBe('interrupt');
  });
  it.each(['Вас.', 'Вам', 'Вы', 'Для вас'])('1181: does not invent an interruption topic from %s', text => {
    expect(classify(text).kind).toBe('candidate');
  });

  it('does not double-count repeated partial hypotheses', () => {
    expect(mergeTranscriptionHypothesis('подождите', 'подождите', true)).toBe('подождите');
    expect(mergeTranscriptionHypothesis('подождите', 'подождите пожалуйста', false)).toBe('подождите пожалуйста');
    expect(mergeTranscriptionHypothesis('у меня', 'вопрос', true)).toBe('у меня вопрос');
    expect(mergeLogicalTurnText('да всё верно', 'да всё верно пробег актуальный')).toBe(
      'да всё верно пробег актуальный',
    );
    expect(mergeLogicalTurnText(
      'на машину производится',
      'на машину производятся периодически тесты',
    )).toBe('на машину производятся периодически тесты');
  });

  it('recognizes conservative continuation markers and questions', () => {
    expect(looksLikeContinuingThought('Смотрите, у меня такая ситуация, и')).toBe(true);
    expect(looksLikeContinuingThought('На этом всё.')).toBe(false);
    expect(sourceLooksLikeQuestion('Вам удобно?')).toBe(true);
    expect(sourceLooksLikeQuestion('Добрый день. Звоню по Мерседес-Бенц')).toBe(false);
    expect(sourceLooksLikeQuestion('Назовите удобный день.')).toBe(false);
  });

  it('keeps unfinished answers open across a short pause', () => {
    expect(assessUserTurnCompletion('Нет, ничего не...', '').incomplete).toBe(true);
    expect(assessUserTurnCompletion('Нет, ничего не', '').reason).toBe('hanging_function_word');
    expect(assessUserTurnCompletion('Нет, не было.', '').incomplete).toBe(false);
    expect(assessUserTurnCompletion('Ну, за последний год там', 'Что с машиной было за последний год?')).toEqual({
      incomplete: true,
      reason: 'short_open_answer',
    });
    expect(assessUserTurnCompletion('Она была в', 'Что с машиной было?').reason).toBe('hanging_function_word');
    expect(assessUserTurnCompletion(
      'А, да блядь, не знаю рублей',
      'Сколько вы владеете машиной?',
    ).reason).toBe('dangling_measurement');
    expect(assessUserTurnCompletion(
      'А, да блядь, не знаю рублей пятьдесят, ну пятьдесят тысяч имею в виду',
      'Сколько вы владеете машиной?',
    ).incomplete).toBe(false);
    expect(assessUserTurnCompletion('Пробег пятьдесят тысяч', 'Какой пробег?').incomplete).toBe(false);
    expect(assessUserTurnCompletion('Последний владелец владел около года', 'Сколько он владел?').incomplete).toBe(false);
    expect(assessUserTurnCompletion(
      'Выглядит отлично, в хорошем состоянии',
      'Расскажите, что по машине?',
    ).incomplete).toBe(false);
    expect(assessUserTurnCompletion('Ничего не было', 'Что с машиной было?').incomplete).toBe(false);
    expect(assessUserTurnCompletion('Да, актуально', 'Предложение ещё актуально?').incomplete).toBe(false);
    expect(assessUserTurnCompletion(
      'Ну, за последний год там была замена двери',
      'Что с машиной было за последний год?',
    ).incomplete).toBe(false);
  });

  it('adds a bounded semantic grace period and protects split concise answers', () => {
    const openQuestion = 'Расскажите, что с машиной было за последний год?';
    expect(userTurnEndpoint(
      'Там меняли дверь и красили крыло',
      openQuestion,
      { incomplete: false, reason: 'complete' },
      750,
      1600,
    )).toEqual({ delayMs: 750, reason: 'semantic_open_answer' });
    expect(userTurnEndpoint(
      'Ну, там',
      openQuestion,
      { incomplete: true, reason: 'short_open_answer' },
      750,
      1600,
    )).toEqual({ delayMs: 1600, reason: 'short_open_answer' });
    expect(userTurnEndpoint(
      'Нет, не было',
      'ДТП были?',
      { incomplete: false, reason: 'complete' },
      750,
      1600,
    ).delayMs).toBe(750);
    expect(userTurnEndpoint(
      'Машина полностью обслужена у официального дилера',
      'Сообщите состояние автомобиля.',
      { incomplete: false, reason: 'complete' },
      750,
      1600,
    )).toEqual({ delayMs: 400, reason: 'semantic_answer_grace' });
  });

  it('lets the employee finish a short opening introduction', () => {
    expect(openingTurnNeedsIntroGrace('Алло')).toBe(true);
    expect(openingTurnNeedsIntroGrace('Добрый день, компания Авилон')).toBe(true);
    expect(openingTurnNeedsIntroGrace('Здравствуйте, меня зовут Анна')).toBe(true);
    expect(openingTurnNeedsIntroGrace('Добрый день, компания Авилон, Анна, отдел продаж, слушаю вас')).toBe(false);
    expect(openingTurnNeedsIntroGrace('Нет, машина ещё не продана')).toBe(false);
  });
});
