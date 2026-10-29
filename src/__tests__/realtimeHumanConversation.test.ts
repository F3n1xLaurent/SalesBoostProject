import { describe, expect, it } from 'vitest';
import {
  admitBackchannel,
  chooseBackchannelText,
  dialogueDeliveryDirective,
  effectiveAssistantContext,
  inferDialogueDelivery,
} from '../voice/realtimeHumanConversation';

describe('realtime human conversation helpers', () => {
  it('uses only the actually heard part of an interrupted assistant turn', () => {
    expect(effectiveAssistantContext({
      text: 'Хорошо. Тогда когда можно приехать посмотреть машину?',
      metrics: {
        interrupted: true,
        heardTextOnInterruption: 'Хорошо.',
      },
    })).toBe('Хорошо.');
    expect(effectiveAssistantContext({ text: 'Когда можно приехать?', metrics: {} }))
      .toBe('Когда можно приехать?');
  });

  it('selects a conversational delivery without another model request', () => {
    expect(inferDialogueDelivery('Подскажите, когда можно приехать?')).toBe('curious');
    expect(inferDialogueDelivery('Спасибо, договорились.')).toBe('warm');
    expect(inferDialogueDelivery('Простите, плохо слышно.')).toBe('gentle');
    expect(inferDialogueDelivery('То есть красили только дверь.')).toBe('engaged');
    expect(dialogueDeliveryDirective('Какой сейчас пробег?')).toContain('curious');
  });

  it('chooses backchannels from the meaning of the current manager turn', () => {
    const listening = ['Угу.', 'Ага.'];
    const thinking = ['Хм-м…', 'Так…'];
    expect(chooseBackchannelText('listening', 'Пробег сейчас пятьдесят тысяч', 0, listening)).toBe('Ага.');
    expect(chooseBackchannelText('listening', 'Нет, после ДТП меняли дверь', 1, listening)).toBe('Угу.');
    expect(chooseBackchannelText('thinking', 'Даже не знаю, сложный вопрос', 1, thinking)).toBe('Хм-м…');
    expect(chooseBackchannelText('thinking', 'Цена пять миллионов', 0, thinking)).toBe('Так…');
  });

  it('does not stack several backchannels within one manager turn', () => {
    expect(admitBackchannel({
      kind: 'listening',
      listeningCountInTurn: 1,
      configuredListeningLimit: 2,
      msSincePreviousBackchannel: 8000,
    })).toEqual({ allowed: false, reason: 'listening_limit_for_turn' });
    expect(admitBackchannel({
      kind: 'thinking',
      listeningCountInTurn: 1,
      configuredListeningLimit: 2,
      msSincePreviousBackchannel: 3000,
    })).toEqual({ allowed: false, reason: 'turn_already_acknowledged' });
    expect(admitBackchannel({
      kind: 'thinking',
      listeningCountInTurn: 0,
      configuredListeningLimit: 2,
      msSincePreviousBackchannel: 900,
    })).toEqual({ allowed: false, reason: 'backchannel_cluster_guard' });
    expect(admitBackchannel({
      kind: 'thinking',
      listeningCountInTurn: 0,
      configuredListeningLimit: 2,
      msSincePreviousBackchannel: 3000,
    })).toEqual({ allowed: true });
    expect(admitBackchannel({
      kind: 'thinking',
      listeningCountInTurn: 0,
      configuredListeningLimit: 1,
      msSincePreviousBackchannel: 3000,
      msSincePreviousThinking: 9000,
    })).toEqual({ allowed: false, reason: 'thinking_filler_cooldown' });
  });
});
