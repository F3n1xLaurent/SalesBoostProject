import type { TranscriptTurn } from './callHistory';
import { prepareTranscriptForAnalysis } from './analysisTranscript';
import { filterUnreliableManagerTurns } from './transcriptReliability';
import { isTerminalAutomatedAnswer } from './terminalAutomatedAnswer';

export type CallReportEligibility =
  | { eligible: true }
  | { eligible: false; outcome: 'busy' | 'no_answer' | null; reason: string };

const BUSY = /(?:абонент|вызываемый\s+(?:абонент|номер)|номер|линия).{0,45}(?:занят|разговаривает)/iu;
const UNAVAILABLE = /(?:абонент|номер|телефон|аппарат).{0,60}(?:недоступен|не\s*доступен|выключен|не отвечает|не может\s+(?:ответить|принять)|вне зоны|не обслуживается|не существует)|(?:оставьте|оставить|запишите).{0,35}(?:сообщение|послание)|голосов(?:ая|ой)\s+(?:почта|почты|ящик)|(?:соединение|вызов).{0,30}не может быть установлен|вид связи.{0,20}недоступен|неправильно набран номер/iu;
const ANNOUNCEMENT_CONTINUATION = /^(?:пожалуйста[,\s]+)?(?:перезвоните\s+(?:позже|позднее)|попробуйте\s+(?:позвонить\s+)?(?:позже|позднее)|после\s+(?:звукового\s+)?сигнала)[.!?\s]*$/iu;

function normalized(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

// Greetings and acknowledgements alone do not provide material for an appraisal.
// A short substantive answer or refusal ("нет в наличии", "не звоните") does.
function isGreetingOnly(text: string): boolean {
  const words = normalized(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  return /^(?:(?:алло|ало|да|ага|угу|здравствуйте|здравствуй|привет|слушаю|вас|спасибо|до свидания|добрый день|добрый вечер|доброе утро|меня зовут\s+\p{L}+|менеджер\s+\p{L}+|отдел продаж|чем могу\s+(?:вам\s+)?помочь)\s*)+$/u.test(words);
}

/** The remote party is `manager`; the calling bot is `client`. */
export function assessCallReportEligibility(
  transcript: readonly TranscriptTurn[],
  options: { ivrDetected?: boolean } = {},
): CallReportEligibility {
  const reliable = filterUnreliableManagerTurns(transcript).filter((turn) => hasWords(turn.text));
  const remote = reliable.filter((turn) => turn.role === 'manager');
  const assistantIndex = remote.slice(0, 3).findIndex((turn) => isTerminalAutomatedAnswer(turn.text)
    && /(?:я|это)\s+(?:голосов(?:ой|ая)|виртуальн(?:ый|ая)|автоматическ(?:ий|ая))\s+(?:ассистент|помощни(?:к|ца))/iu.test(turn.text));
  if (assistantIndex >= 0 && remote.slice(0, assistantIndex).every((turn) =>
    isGreetingOnly(turn.text) || BUSY.test(normalized(turn.text)) || UNAVAILABLE.test(normalized(turn.text)))) {
    return { eligible: false, outcome: 'no_answer', reason: 'Недозвон: ответил голосовой ассистент абонента.' };
  }
  const analysis = prepareTranscriptForAnalysis(reliable, options).transcript;
  const announcements = remote.filter((turn) => BUSY.test(normalized(turn.text)) || UNAVAILABLE.test(normalized(turn.text)));
  // Do not discard a real conversation that preceded or followed an announcement.
  const humanSpeech = analysis.filter((turn) => turn.role === 'manager' && !announcements.includes(turn) && !isGreetingOnly(turn.text)
    && !ANNOUNCEMENT_CONTINUATION.test(normalized(turn.text)));
  if (announcements.length && !humanSpeech.length) {
    const busy = announcements.some((turn) => BUSY.test(normalized(turn.text)));
    return { eligible: false, outcome: busy ? 'busy' : 'no_answer',
      reason: busy ? 'Недозвон: автоинформатор сообщил, что абонент занят.' : 'Недозвон: ответил автоинформатор или голосовая почта.' };
  }
  const manager = analysis.filter((turn) => turn.role === 'manager');
  if (remote.length && (!manager.length || manager.every((turn) => isGreetingOnly(turn.text)))) {
    return { eligible: false, outcome: 'no_answer', reason: 'Недозвон: разговор не состоялся, только приветствие или ожидание соединения.' };
  }
  if (!manager.length || !analysis.some((turn) => turn.role === 'client')) {
    return { eligible: false, outcome: null, reason: 'Оценка не выполнена: недостаточно данных для подтверждения разговора с человеком.' };
  }
  return { eligible: true };
}
