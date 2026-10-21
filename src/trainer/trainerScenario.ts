import { stripLeadingClientGreetings } from '../voice/customerScenarioPrompt';

type TrainerScenarioQuestion = {
  text?: string;
  question?: string;
  required?: boolean;
};

type TrainerScenarioContext = {
  scenario?: {
    id?: string;
    name?: string;
    questions?: TrainerScenarioQuestion[];
  } | null;
  company?: {
    city?: string;
  } | null;
  clientProfile?: {
    city?: string;
  } | null;
  importedItem?: {
    title?: string;
  } | null;
};

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function sentence(value: string): string {
  if (!value) return '';
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

/**
 * Builds a deterministic opening anchored to the selected scenario without
 * exposing its internal UI name to the employee. When a concrete imported
 * item is selected, name it before asking the first scenario question so the
 * employee always understands which car/product the client is calling about.
 */
export function buildTrainerInitialClientMessage(caseContext: TrainerScenarioContext): string {
  const importedTitle = cleanText(caseContext.importedItem?.title);
  const questions = Array.isArray(caseContext.scenario?.questions) ? caseContext.scenario.questions : [];
  const firstQuestion = questions
    .map((question) => stripLeadingClientGreetings(question.text || question.question))
    .find(Boolean) || '';

  if (firstQuestion) {
    const openingQuestion = /^(?:подскажите|скажите|уточните|можно\s+ли|могу\s+ли)(?=\s|[,.!?;:—–-]|$)/i.test(firstQuestion)
      ? sentence(firstQuestion)
      : `Подскажите, пожалуйста: ${sentence(firstQuestion)}`;
    const subject = importedTitle ? ` Я звоню по поводу «${importedTitle}».` : '';
    return `Здравствуйте.${subject} ${openingQuestion}`;
  }

  if (importedTitle) {
    return `Здравствуйте. Я звоню по поводу «${importedTitle}». Подскажите, пожалуйста, можете сориентировать?`;
  }

  return 'Здравствуйте. Хочу уточнить информацию по вашему предложению. Подскажите, пожалуйста, можете сориентировать?';
}

export function importedItemMatchesTrainerTags(itemTags: string[], requiredTags: string[]): boolean {
  if (requiredTags.length === 0) return true;
  const available = new Set(itemTags.map(cleanText).filter(Boolean));
  return requiredTags.map(cleanText).filter(Boolean).every((tag) => available.has(tag));
}

/**
 * A bare acknowledgement does not advance a trainer dialog. It is valid as
 * the beginning of a response, but only when followed by a new topic,
 * question, objection or a natural closing phrase.
 */
export function isNonProgressingTrainerReply(value: unknown): boolean {
  const normalized = cleanText(value)
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^а-я\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;
  return /^(?:(?:да|ну)\s+)?(?:понял|поняла|понятно|хорошо|ладно|ясно|ага|угу)(?:\s+(?:понял|поняла|понятно|хорошо|ладно|ясно|ага|угу))*$/.test(normalized);
}

function normalizeDialogText(value: unknown): string {
  return cleanText(value)
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scheduling is a role-sensitive moment: the employee asks when the customer
 * can visit, so another customer question is not a valid answer even if it
 * advances the scripted checklist.
 */
export function trainerReplyMissesVisitSchedulingAnswer(managerMessage: unknown, clientReply: unknown): boolean {
  const manager = normalizeDialogText(managerMessage);
  const mentionsVisit = /(?:приех|подъех|заех|визит|встреч|запис)/u.test(manager);
  const asksWhen = /(?:сегодня|завтра|послезавтра|когда|во\s+сколько|какое\s+время|в\s+какое\s+время|какой\s+день|дату|удобн|получится|смож)/u.test(manager);
  if (!mentionsVisit || !asksWhen) return false;

  const reply = normalizeDialogText(clientReply);
  if (!reply) return true;
  if (manager.includes('сегодня') && manager.includes('завтра')) {
    const selectsOfferedDay = /(?:сегодня|завтра|оба\s+варианта|любой\s+(?:день|вариант))/u.test(reply);
    return !selectsOfferedDay;
  }
  const hasDirectAnswer = /(?:^|\s)(?:да|нет)(?:\s|$)|(?:сегодня|завтра|послезавтра|могу|не\s+могу|смогу|не\s+смогу|получится|не\s+получится|подходит|не\s+подходит|удобно|неудобно|приеду|подъеду|заеду)|(?:в|к)\s+\d{1,2}(?:\s+\d{2})?/u.test(reply);
  return !hasDirectAnswer;
}

export function ensureTrainerVisitSchedulingAnswer(managerMessage: unknown, clientReply: unknown): string {
  const reply = cleanText(clientReply);
  if (!trainerReplyMissesVisitSchedulingAnswer(managerMessage, reply)) return reply;

  const manager = normalizeDialogText(managerMessage);
  if (manager.includes('завтра')) {
    return 'Да, завтра подходит. Подскажите, пожалуйста, на какое время?';
  }
  if (manager.includes('сегодня')) {
    return 'Да, сегодня подходит. Подскажите, пожалуйста, на какое время?';
  }
  return 'Завтра подходит. Подскажите, пожалуйста, на какое время?';
}
