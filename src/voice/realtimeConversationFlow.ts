export type InterruptionDecision = {
  kind: 'interrupt' | 'backchannel' | 'noise' | 'candidate';
  reason: string;
  normalizedText: string;
};

const ACKNOWLEDGEMENT_WORDS = new Set([
  'угу', 'ага', 'м', 'мм', 'ммм', 'а', 'аа', 'понятно', 'понял', 'поняла', 'ясно', 'хорошо', 'так', 'да',
]);

const FILLER_WORDS = new Set([
  ...ACKNOWLEDGEMENT_WORDS,
  'э', 'ээ', 'эм', 'ну', 'вот', 'типа', 'как', 'бы',
]);

const STRONG_COMMAND = /(?:^|\s)(стоп|стой|подожди|подождите|постой|постойте|хватит|отмена|замолчи|замолчите)(?:\s|$)/u;
const INTERRUPTION_INTENT = /(?:можно\s+(?:уточнить|спросить)|у\s+меня\s+вопрос|секунду(?:чку)?|минут(?:у|очку)|я\s+хотел(?:а)?\s+(?:сказать|спросить|уточнить)|а\s+скажите|но\s+я)/u;

export function normalizeConversationText(value: string): string {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[‐‑‒–—-]/g, ' ')
    .replace(/[^а-яa-z0-9\s]/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value: string): string[] {
  const normalized = normalizeConversationText(value);
  return normalized ? normalized.split(' ') : [];
}

export function classifyInterruption(
  text: string,
  options: { awaitingAnswer: boolean; final: boolean; minMeaningfulWords: number },
): InterruptionDecision {
  const normalizedText = normalizeConversationText(text);
  const tokens = words(normalizedText);
  if (!tokens.length) {
    return { kind: options.final ? 'noise' : 'candidate', reason: options.final ? 'empty_transcript' : 'no_text_yet', normalizedText };
  }
  if (STRONG_COMMAND.test(` ${normalizedText} `)) {
    return { kind: 'interrupt', reason: 'strong_command', normalizedText };
  }
  if (options.awaitingAnswer) {
    return { kind: 'interrupt', reason: 'answer_to_question', normalizedText };
  }
  if (INTERRUPTION_INTENT.test(normalizedText)) {
    return { kind: 'interrupt', reason: 'interruption_intent', normalizedText };
  }
  if (tokens.every((token) => ACKNOWLEDGEMENT_WORDS.has(token))) {
    return { kind: 'backchannel', reason: 'short_acknowledgement', normalizedText };
  }
  const meaningfulWords = tokens.filter((token) => !FILLER_WORDS.has(token));
  if (meaningfulWords.length >= options.minMeaningfulWords) {
    return { kind: 'interrupt', reason: 'meaningful_phrase', normalizedText };
  }
  if (options.final && meaningfulWords.length > 0) {
    return { kind: 'interrupt', reason: 'single_meaningful_word', normalizedText };
  }
  return { kind: 'candidate', reason: 'insufficient_evidence', normalizedText };
}

export function mergeTranscriptionHypothesis(previous: string, incoming: string, isDelta: boolean): string {
  const before = previous.trim();
  const next = incoming.trim();
  if (!next) return before;
  if (!isDelta) return next;
  if (!before) return next;
  if (next === before || before.endsWith(next)) return before;
  if (next.startsWith(before)) return next;
  if (before.startsWith(next)) return next;
  return `${before} ${next}`.replace(/\s+/g, ' ').trim();
}

export function mergeLogicalTurnText(previous: string, incoming: string): string {
  const before = previous.trim();
  const next = incoming.trim();
  if (!before) return next;
  if (!next) return before;
  const beforeNormalized = normalizeConversationText(before);
  const nextNormalized = normalizeConversationText(next);
  if (nextNormalized === beforeNormalized || nextNormalized.startsWith(`${beforeNormalized} `)) return next;
  if (beforeNormalized.startsWith(`${nextNormalized} `)) return before;
  const beforeWords = beforeNormalized.split(' ');
  const nextWords = nextNormalized.split(' ');
  if (nextWords.length >= beforeWords.length) {
    const matches = beforeWords.reduce((count, word, index) => {
      const candidate = nextWords[index] ?? '';
      const sameStem = Math.min(word.length, candidate.length) >= 5
        && (word.startsWith(candidate.slice(0, 5)) || candidate.startsWith(word.slice(0, 5)));
      return count + (word === candidate || sameStem ? 1 : 0);
    }, 0);
    if (matches / beforeWords.length >= 0.8) return next;
  }
  return `${before} ${next}`.replace(/\s+/g, ' ').trim();
}

export function looksLikeContinuingThought(text: string): boolean {
  const raw = text.trim();
  const normalized = normalizeConversationText(raw);
  if (!normalized) return false;
  if (/[,—–-]\s*$/.test(raw) || /\.{2,}\s*$/.test(raw)) return true;
  return /(?:^|\s)(и|а|но|или|потому|поскольку|если|когда|чтобы|который|которая|которые|короче|смотрите|понимаете|то\s+есть|в\s+общем|как\s+бы|ну|э|ээ|эм)$/u.test(normalized);
}

export type UserTurnCompletion = {
  incomplete: boolean;
  reason: 'continuation_marker' | 'hanging_function_word' | 'dangling_measurement' | 'short_open_answer' | 'complete';
};

export type UserTurnEndpoint = {
  delayMs: number;
  reason: UserTurnCompletion['reason'] | 'semantic_open_answer' | 'semantic_answer_grace' | 'opening_introduction_grace';
};

const HANGING_FUNCTION_WORD = /(?:^|\s)(в|во|на|за|по|с|со|к|ко|от|до|для|из|у|о|об|про|при|без|через|между|и|а|но|или|что|чтобы|потому|если|когда)$/u;
const OPEN_QUESTION = /(?:\?|\bчто\b|\bкак\b|\bпочему\b|\bкакие?\b|\bрасскажите\b|\bопишите\b|\bуточните\b)/iu;
const CONCISE_COMPLETE_ANSWER = /^(?:да|нет|не\s+знаю|ничего|все|всё|нормально|хорошо|плохо|актуально|продан[ао]?|в\s+наличии|не\s+было|без\s+дтп)(?:\s|$)/u;
const MEASUREMENT_UNIT_AT_END = /(?:^|\s)(?:рубл(?:ь|я|ей)|тысяч(?:а|и)?|миллион(?:а|ов)?|километр(?:а|ов)?|лет|год(?:а|ов)?|месяц(?:а|ев)?|дн(?:я|ей)|час(?:а|ов)?)$/u;
const NUMBER_ANCHOR = /(?:^|\s)(?:\d+|ноль|один|одна|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто|двести|триста|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот)(?:\s|$)/u;

/**
 * A short first phrase is often only the beginning of the employee's phone
 * introduction ("Алло", "добрый день", "компания ..., слушаю"). Give it a
 * wider pause than an ordinary complete answer so the AI never talks over the
 * employee's name or company.
 */
export function openingTurnNeedsIntroGrace(text: string): boolean {
  const normalized = normalizeConversationText(text);
  if (!normalized) return false;
  if (normalized.split(' ').length > 8) return false;
  return /^(?:алло|здравствуйте|добрый\s+(?:день|вечер|утро)|да\s+слушаю|слушаю)(?:\s|$)/u.test(normalized)
    || /(?:^|\s)(?:меня\s+зовут|компания|автосалон|дилерский\s+центр)(?:\s|$)/u.test(normalized);
}

export function assessUserTurnCompletion(text: string, previousAssistantText: string): UserTurnCompletion {
  const normalized = normalizeConversationText(text);
  if (!normalized) return { incomplete: false, reason: 'complete' };
  if (looksLikeContinuingThought(text)) return { incomplete: true, reason: 'continuation_marker' };
  if (HANGING_FUNCTION_WORD.test(normalized)) return { incomplete: true, reason: 'hanging_function_word' };
  const endsWithMeasurement = MEASUREMENT_UNIT_AT_END.test(normalized);
  const hasNumberAnchor = NUMBER_ANCHOR.test(normalized);
  if (endsWithMeasurement && !hasNumberAnchor && /(?:не\s+знаю|не\s+помню)/u.test(normalized)) {
    return { incomplete: true, reason: 'dangling_measurement' };
  }
  const tokenCount = normalized.split(' ').length;
  if (
    tokenCount <= 5
    && OPEN_QUESTION.test(previousAssistantText)
    && !(endsWithMeasurement && hasNumberAnchor)
    && !CONCISE_COMPLETE_ANSWER.test(normalized)
    && (looksLikeContinuingThought(text) || /(?:^|\s)(?:там|вот|это|так)$/u.test(normalized))
  ) {
    return { incomplete: true, reason: 'short_open_answer' };
  }
  return { incomplete: false, reason: 'complete' };
}

/**
 * Server VAD only tells us that there was a pause, not that the speaker has
 * finished the thought. Keep open/descriptive answers alive for a short,
 * bounded grace period. A resumed VAD segment cancels the pending response
 * and becomes part of the same logical manager turn.
 */
export function userTurnEndpoint(
  text: string,
  previousAssistantText: string,
  completion: UserTurnCompletion,
  normalGraceMs: number,
  incompleteGraceMs: number,
): UserTurnEndpoint {
  if (completion.incomplete) {
    return { delayMs: incompleteGraceMs, reason: completion.reason };
  }

  const normalized = normalizeConversationText(text);
  if (!normalized) return { delayMs: 0, reason: 'complete' };
  if (CONCISE_COMPLETE_ANSWER.test(normalized) && normalized.split(' ').length <= 6) {
    // Yandex may emit the first short VAD segment (for example "да") while
    // the same speaker immediately continues the sentence. Use the normal
    // grace window so that continuation can cancel/restart this commit.
    return { delayMs: normalGraceMs, reason: 'semantic_answer_grace' };
  }
  if (OPEN_QUESTION.test(previousAssistantText)) {
    return { delayMs: normalGraceMs, reason: 'semantic_open_answer' };
  }
  if (normalized.split(' ').length >= 5) {
    // A substantial answer to a closed question has already survived the
    // provider VAD silence window. Keep a small continuation guard, but do
    // not add the full open-answer delay on every dialogue turn.
    return { delayMs: Math.min(normalGraceMs, 400), reason: 'semantic_answer_grace' };
  }
  return { delayMs: 0, reason: 'complete' };
}

export function sourceLooksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  return /\?\s*$/.test(trimmed)
    || /(?:ли|кто|что|где|когда|куда|почему|зачем|сколько|какой|какая|какие|можно|удобно)\b[^.!?]*$/iu.test(trimmed);
}
