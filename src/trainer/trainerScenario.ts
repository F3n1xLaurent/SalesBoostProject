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
 * exposing its internal UI name to the employee. Imported data is only used
 * when the scenario has no concrete opening question.
 */
export function buildTrainerInitialClientMessage(caseContext: TrainerScenarioContext): string {
  const importedTitle = cleanText(caseContext.importedItem?.title);
  const questions = Array.isArray(caseContext.scenario?.questions) ? caseContext.scenario.questions : [];
  const firstQuestion = questions
    .map((question) => cleanText(question.text || question.question))
    .find(Boolean) || '';

  if (firstQuestion) {
    return `Здравствуйте. Подскажите, пожалуйста: ${sentence(firstQuestion)}`;
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
