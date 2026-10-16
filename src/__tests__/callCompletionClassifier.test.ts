import { describe, expect, it } from 'vitest';
import {
  isClearlyTerminalFarewell,
  shouldAskAiCompletionClassifier,
} from '../voice/callCompletionClassifier';

describe('call completion classifier guards', () => {
  it.each([
    'До свидания!',
    'Спасибо за разговор. Всего доброго.',
    'Хорошего дня!',
    'Ну всё, пока.',
  ])('recognizes an explicit terminal farewell: %s', (text) => {
    expect(isClearlyTerminalFarewell(text)).toBe(true);
  });

  it.each([
    'Спасибо, а какая гарантия?',
    'Пока не знаю, нужно подумать.',
    'До свидания обычно говорят в конце разговора.',
    'Хорошо, спасибо за информацию.',
  ])('does not terminate an unfinished phrase: %s', (text) => {
    expect(isClearlyTerminalFarewell(text)).toBe(false);
  });

  it('sends an implicit ending to AI but skips questions', () => {
    expect(shouldAskAiCompletionClassifier('Извините, что потревожил, позвоню в другой день.')).toBe(true);
    expect(shouldAskAiCompletionClassifier('Подскажите, пожалуйста, ваш адрес?')).toBe(false);
  });
});
