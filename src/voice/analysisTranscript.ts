import type { TranscriptTurn } from './callHistory';

export interface AnalysisTranscriptResult {
  transcript: TranscriptTurn[];
  removedPrefixTurns: number;
  reason: 'automatic_anchor' | 'operator_handoff' | 'awaiting_handoff' | 'ivr_flag_with_handoff' | 'second_greeting' | null;
}

const AUTOMATIC_SPEECH_PATTERNS = [
  /добро пожаловать/i,
  /вы (?:позвонили|дозвонились)/i,
  /вас приветству(?:ет|ют)/i,
  /приветству(?:ет|ют|ем) вас/i,
  /рад(?:ы|а)? приветствовать вас/i,
  /разговор(?:ы)? (?:записыва|может быть записан)/i,
  /для (?:улучшения|контроля) качества/i,
  /дождитесь (?:ответа|соединения)/i,
  /подождите (?:связи|соединения|ответа) с оператором/i,
  /оставайтесь на линии/i,
  /все операторы/i,
  /ваш звонок .*важен/i,
  /нажмите/i,
  /выберите (?:пункт|раздел|цифру)/i,
  /голосов(?:ое|ого) меню/i,
  /для соединения с/i,
  /спасибо за ожидание/i,
  /ожидайте ответа/i,
];

const GREETING_PATTERN = /(?:^|[.!?]\s*)(?:алло|здравствуйте|добрый\s+(?:день|вечер|утро)|приветствую)(?=\s|[!,.:;?]|$)/i;
const SELF_INTRODUCTION_PATTERN = /(?:меня зовут|это\s+(?:администратор|менеджер|консультант)|отдел продаж|слушаю вас)/i;
const CLIENT_WAITING_PATTERN = /(?:буду ждать|я на линии|дождусь|жду|соедините|ответит оператор|голосов(?:ое|ого) (?:сообщение|приветствие|меню))/i;
const OPERATOR_HANDOFF_PATTERN = /(?:соедин(?:ю|им|яем|ите|ить)|переключ(?:у|им|аем|ить)|перевед(?:у|ем|ём|ите|ти)|передам|позову|приглашу|ожидайте\s+(?:ответа|соединения)).{0,90}(?:менеджер|специалист|отдел|сотрудник|оператор)|(?:менеджер|специалист|отдел|сотрудник|оператор).{0,90}(?:соедин(?:ю|им|яем|ить)|переключ(?:у|им|аем|ить)|перевед(?:у|ем|ём|ти)|передам|позову)/i;
const CALL_CENTER_INTRO_PATTERN = /(?:колл[ -]?центр|контактн(?:ый|ого)\s+центр|единая\s+(?:справочная|линия)|диспетчерская)/i;

function normalizedText(text: string): string {
  return text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function isNoise(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

function isAutomaticSpeech(text: string): boolean {
  return AUTOMATIC_SPEECH_PATTERNS.some((pattern) => pattern.test(text));
}

function isGreeting(text: string): boolean {
  return GREETING_PATTERN.test(text);
}

function isLikelyHumanStart(text: string): boolean {
  return isGreeting(text) || SELF_INTRODUCTION_PATTERN.test(text);
}

function meaningfulManagerIndexes(turns: readonly TranscriptTurn[]): number[] {
  return turns.flatMap((turn, index) => turn.role === 'manager' && !isNoise(turn.text) ? [index] : []);
}

function hasBothSides(turns: readonly TranscriptTurn[]): boolean {
  return turns.some((turn) => turn.role === 'manager' && !isNoise(turn.text))
    && turns.some((turn) => turn.role === 'client' && !isNoise(turn.text));
}

function hasPreconnectionEvidence(turns: readonly TranscriptTurn[], boundaryIndex: number): boolean {
  const prefix = turns.slice(0, boundaryIndex);
  if (prefix.some((turn) => turn.role === 'client' && CLIENT_WAITING_PATTERN.test(turn.text))) return true;
  if (prefix.filter((turn) => turn.role === 'manager' && isNoise(turn.text)).length >= 2) return true;

  const clientCounts = new Map<string, number>();
  for (const turn of prefix) {
    if (turn.role !== 'client' || isNoise(turn.text)) continue;
    const text = normalizedText(turn.text);
    clientCounts.set(text, (clientCounts.get(text) ?? 0) + 1);
  }
  return [...clientCounts.values()].some((count) => count >= 2);
}

function resultFromBoundary(
  turns: readonly TranscriptTurn[],
  boundaryIndex: number,
  reason: 'automatic_anchor' | 'operator_handoff' | 'ivr_flag_with_handoff' | 'second_greeting',
): AnalysisTranscriptResult | null {
  if (boundaryIndex <= 0) return null;
  const transcript = turns.slice(boundaryIndex).filter((turn) => !isNoise(turn.text));
  if (!hasBothSides(transcript)) return null;
  return { transcript, removedPrefixTurns: boundaryIndex, reason };
}

/**
 * Keeps the stored transcript intact, but removes a confidently detected
 * automatic greeting / queue block from the copy sent to call analytics.
 */
export function prepareTranscriptForAnalysis(
  turns: readonly TranscriptTurn[],
  options: { ivrDetected?: boolean } = {},
): AnalysisTranscriptResult {
  const managerIndexes = meaningfulManagerIndexes(turns);
  const firstManagerIndex = managerIndexes[0];
  const automaticIndex = firstManagerIndex != null && isAutomaticSpeech(turns[firstManagerIndex].text)
    ? firstManagerIndex
    : undefined;

  // A live switchboard operator is still a human, but must not be graded as
  // the employee who receives the transferred call. Prefer this later boundary
  // over the first non-IVR voice.
  const earlyManagerIndexes = managerIndexes.slice(0, 4);
  const callCenterIndex = earlyManagerIndexes.find((index) => CALL_CENTER_INTRO_PATTERN.test(turns[index].text));
  const handoffIndex = [...earlyManagerIndexes].reverse().find((index) => OPERATOR_HANDOFF_PATTERN.test(turns[index].text));
  if (handoffIndex != null) {
    const nextHumanIndex = managerIndexes.find((index) => index > handoffIndex && isLikelyHumanStart(turns[index].text)
      && !isAutomaticSpeech(turns[index].text));
    if (nextHumanIndex != null) {
      const result = resultFromBoundary(turns, nextHumanIndex, 'operator_handoff');
      if (result) return result;
    }
    // Only discard an unfinished transfer when we know the preceding speaker
    // was IVR / the call centre. A real manager may legitimately offer to
    // transfer to a colleague near the end of an otherwise scorable call.
    if (automaticIndex != null || callCenterIndex != null) {
      return { transcript: [], removedPrefixTurns: turns.length, reason: 'awaiting_handoff' };
    }
  }

  if (callCenterIndex != null) {
    const nextHumanIndex = managerIndexes.find((index) => index > callCenterIndex && isLikelyHumanStart(turns[index].text)
      && !isAutomaticSpeech(turns[index].text));
    if (nextHumanIndex != null) {
      const result = resultFromBoundary(turns, nextHumanIndex, 'operator_handoff');
      if (result) return result;
    }
  }

  if (automaticIndex != null) {
    const boundaryIndex = managerIndexes.find((index) => index > automaticIndex && !isAutomaticSpeech(turns[index].text));
    if (boundaryIndex != null) {
      const result = resultFromBoundary(turns, boundaryIndex, 'automatic_anchor');
      if (result) return result;
    }
    return { transcript: [], removedPrefixTurns: turns.length, reason: 'awaiting_handoff' };
  }

  const greetingIndexes = managerIndexes.filter((index) => isGreeting(turns[index].text));
  if (greetingIndexes.length >= 2) {
    const boundaryIndex = greetingIndexes.find((index) => index > greetingIndexes[0] && isLikelyHumanStart(turns[index].text));
    if (boundaryIndex != null && hasPreconnectionEvidence(turns, boundaryIndex)) {
      const reason = options.ivrDetected ? 'ivr_flag_with_handoff' : 'second_greeting';
      const result = resultFromBoundary(turns, boundaryIndex, reason);
      if (result) return result;
    }
  }

  return { transcript: [...turns], removedPrefixTurns: 0, reason: null };
}
