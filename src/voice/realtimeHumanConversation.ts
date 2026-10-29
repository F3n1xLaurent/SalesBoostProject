import { normalizeConversationText } from './realtimeConversationFlow';

export const HUMAN_CONVERSATION_INSTRUCTIONS = [
  '=== ЕСТЕСТВЕННЫЙ РАЗГОВОР ДЛЯ ТЕСТОВОГО КОНТУРА ===',
  'Не веди разговор как анкету. Реагируй на смысл последней законченной мысли сотрудника и только затем двигайся дальше по сценарию.',
  'Когда сотрудник сообщил значимый новый факт, иногда коротко отрази ровно один конкретный факт своими словами: например, «То есть красили только дверь». Не пересказывай всю реплику и не делай это после каждого ответа.',
  'Не вставляй содержательную реплику в середину незаконченной мысли. Пауза распознавания сама по себе не означает, что сотрудник закончил; особенно жди продолжения после вводных слов, перечисления, причины, уточнения или самокоррекции.',
  'Короткие «ага» и «угу» во время речи сотрудника, а также звук размышления перед твоим ответом воспроизводит телефония. Не дублируй их отдельным текстовым ответом и не начинай содержательную реплику со слов «ага», «угу», «хм» или «так».',
  'Подстраивай длину: на короткий простой ответ реагируй одной короткой фразой; на подробный или эмоциональный ответ можно ответить двумя короткими предложениями. Не произноси монологи.',
  'Меняй формулировки и связки. Не начинай подряд несколько реплик одинаково и не повторяй дословно вопрос, который сотрудник уже понял.',
  'Допустима редкая естественная самокоррекция внутри реплики, если она уместна: «точнее», «вернее», «я имею в виду». Не добавляй искусственные слова-паразиты и не делай оговорку в каждой реплике.',
  'Если сотрудник перебил содержательным ответом, сначала учти новую информацию. Не начинай оборванную реплику заново и не заявляй, что вопрос уже был задан, если его вопросительная часть не успела прозвучать.',
  'Если сотрудник лишь коротко подтвердил услышанное, не переспрашивай контекст и естественно продолжи с фактически услышанного места.',
  'Речь должна звучать разговорно: простые слова, короткие смысловые группы, естественная пунктуация. Избегай канцелярита, длинных вводных конструкций и нескольких вопросов в одной реплике.',
].join('\n');

export type DialogueDelivery = 'curious' | 'warm' | 'gentle' | 'engaged' | 'neutral';
export type BackchannelAdmission = { allowed: true } | { allowed: false; reason: string };

export function admitBackchannel(input: {
  kind: 'listening' | 'thinking';
  listeningCountInTurn: number;
  configuredListeningLimit: number;
  msSincePreviousBackchannel: number | null;
  msSincePreviousThinking?: number | null;
}): BackchannelAdmission {
  // In a phone conversation one audible acknowledgement per logical speaker
  // turn is enough. More quickly starts sounding like a soundboard.
  const listeningLimit = Math.min(1, Math.max(0, input.configuredListeningLimit));
  if (input.kind === 'listening' && input.listeningCountInTurn >= listeningLimit) {
    return { allowed: false, reason: 'listening_limit_for_turn' };
  }
  // "Ага" while listening already bridges this manager turn. Adding "хм-м"
  // at its endpoint produces an unnatural stack of consecutive fillers.
  if (input.kind === 'thinking' && input.listeningCountInTurn > 0) {
    return { allowed: false, reason: 'turn_already_acknowledged' };
  }
  if (
    input.kind === 'thinking'
    && input.msSincePreviousThinking != null
    && input.msSincePreviousThinking < 15_000
  ) {
    return { allowed: false, reason: 'thinking_filler_cooldown' };
  }
  if (input.msSincePreviousBackchannel != null && input.msSincePreviousBackchannel < 2500) {
    return { allowed: false, reason: 'backchannel_cluster_guard' };
  }
  return { allowed: true };
}

function containsAny(normalized: string, values: readonly string[]): boolean {
  const padded = ` ${normalized} `;
  return values.some((value) => padded.includes(` ${value} `));
}

export function effectiveAssistantContext(turn: {
  text: string;
  metrics?: { interrupted?: boolean; heardTextOnInterruption?: string | null };
} | undefined): string {
  if (!turn) return '';
  if (!turn.metrics?.interrupted) return turn.text;
  return turn.metrics.heardTextOnInterruption?.trim() ?? '';
}

export function inferDialogueDelivery(text: string): DialogueDelivery {
  const normalized = normalizeConversationText(text);
  if (!normalized) return 'neutral';
  if (text.includes('?') || containsAny(normalized, ['подскажите', 'скажите', 'расскажите', 'можно', 'когда', 'сколько', 'какой', 'какая', 'почему'])) {
    return 'curious';
  }
  if (containsAny(normalized, ['спасибо', 'отлично', 'здорово', 'договорились', 'до свидания', 'хорошего дня'])) {
    return 'warm';
  }
  if (containsAny(normalized, ['извините', 'простите', 'сочувствую', 'жаль', 'не расслышал', 'плохо слышно'])) {
    return 'gentle';
  }
  if (containsAny(normalized, ['то есть', 'получается', 'правильно понимаю', 'верно', 'интересно'])) {
    return 'engaged';
  }
  return 'neutral';
}

export function dialogueDeliveryDirective(text: string): string {
  const delivery = inferDialogueDelivery(text);
  const styles: Record<DialogueDelivery, string> = {
    curious: 'curious, conversational, natural, attentive, moderately fast-paced',
    warm: 'warm, conversational, natural, lightly upbeat, moderately fast-paced',
    gentle: 'gentle, calm, conversational, attentive, moderately fast-paced',
    engaged: 'engaged, conversational, natural, attentive, moderately fast-paced',
    neutral: 'conversational, natural, warm, attentive, moderately fast-paced',
  };
  return `[${styles[delivery]}]`;
}

export function chooseBackchannelText(
  kind: 'listening' | 'thinking',
  managerText: string,
  variant: number,
  available: readonly string[],
): string | null {
  if (!available.length) return null;
  const normalized = normalizeConversationText(managerText);
  const find = (value: string) => available.find((candidate) => candidate === value);
  if (kind === 'listening') {
    if (containsAny(normalized, ['нет', 'не', 'проблема', 'проблемы', 'дтп', 'авария', 'ремонт', 'красили', 'меняли', 'сломалась', 'жаль'])) {
      return find('Угу.') ?? available[variant % available.length];
    }
    if (/\d/u.test(normalized) || containsAny(normalized, ['тысяч', 'тысяча', 'миллион', 'километров', 'год', 'года', 'месяц', 'рублей', 'пробег', 'цена'])) {
      return find('Ага.') ?? available[variant % available.length];
    }
  } else {
    const nonVerbal = available.find((candidate) => candidate.startsWith('['));
    // A throat-clear can be useful in an experiment, but cycling it every
    // third answer sounds theatrical. Keep it genuinely occasional.
    if (nonVerbal && variant > 0 && variant % 12 === 11) return nonVerbal;
    if (containsAny(normalized, ['не знаю', 'сложно', 'проблема', 'проблемы', 'дтп', 'авария', 'ремонт', 'подумаю', 'вопрос'])) {
      return find('Хм-м…') ?? available[variant % available.length];
    }
    if (/\d/u.test(normalized) || containsAny(normalized, ['цена', 'пробег', 'срок', 'дата', 'день', 'рублей', 'тысяч'])) {
      return find('Так…') ?? available[variant % available.length];
    }
    const verbal = available.filter((candidate) => !candidate.startsWith('['));
    if (verbal.length) return verbal[variant % verbal.length];
  }
  return available[variant % available.length];
}
