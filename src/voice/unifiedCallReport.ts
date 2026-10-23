import { config } from '../config';
import { prisma } from '../db';
import { compatibleChatTemperature, openai } from '../lib/openaiClient';
import type { TranscriptTurn } from './callHistory';
import { prepareTranscriptForAnalysis } from './analysisTranscript';
import { isUnreliableManagerUtterance } from './transcriptReliability';
import { buildEvaluationHighlights, normalizeManagerNarrationGender } from '../logic/evaluationHighlights';
import { findManagerClientNameRequest, isClientNameRequest } from '../logic/conversationFacts';
import {
  DEFAULT_CALL_REPORT_PROBLEMS,
  getCallReportProblemCatalog,
  problemByTitle,
  type ProblemCatalogItem,
} from './problemCatalog';

export type UnifiedReportCategory = 'Контакт' | 'Диагностика' | 'Продукт' | 'Закрытие' | 'Коммуникация';
export type UnifiedFindingImportance = 'Критично' | 'Важно' | 'Средне';
export type UnifiedDialogMark = 'positive' | 'normal' | 'negative';

export type UnifiedCallReport = {
  version: 'call-report-v1';
  source: 'call' | 'trainer';
  summary: string;
  totalScore: number;
  verdict: 'Хорошо' | 'Средне' | 'Плохо';
  categories: Array<{
    name: UnifiedReportCategory;
    score: number;
    comment: string;
  }>;
  strengths: string[];
  weaknesses: string[];
  keyFindings: Array<{
    problemTitle: string;
    importance: UnifiedFindingImportance;
    category: UnifiedReportCategory;
    quote: string;
    comment: string;
    betterExample: string;
  }>;
  dialog: Array<{
    role: 'client' | 'manager';
    text: string;
    mark: UnifiedDialogMark | null;
    comment: string | null;
    betterExample: string | null;
  }>;
  recommendations: Array<{
    text: string;
    category: UnifiedReportCategory;
    problemTitle: string | null;
  }>;
};

type EvaluationInput = {
  overall_score_0_100?: number;
  dimension_scores?: unknown;
  checklist?: unknown;
  issues?: unknown;
  recommendations?: unknown[];
  call_summary?: unknown;
  reply_improvements?: unknown;
  plan_criteria?: unknown;
};

export const UNIFIED_REPORT_CATEGORIES: UnifiedReportCategory[] = [
  'Контакт',
  'Диагностика',
  'Продукт',
  'Закрытие',
  'Коммуникация',
];

export const UNIFIED_REPORT_PROBLEMS = DEFAULT_CALL_REPORT_PROBLEMS;

function clampScore(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

const DIMENSION_TO_CATEGORY: Record<string, UnifiedReportCategory> = {
  contact: 'Контакт',
  first_contact: 'Контакт',
  intro: 'Контакт',
  opening: 'Контакт',
  diagnosis: 'Диагностика',
  diagnostics: 'Диагностика',
  needs: 'Диагностика',
  needs_discovery: 'Диагностика',
  product: 'Продукт',
  product_and_sales: 'Продукт',
  presentation: 'Продукт',
  product_presentation: 'Продукт',
  closing: 'Закрытие',
  closing_commitment: 'Закрытие',
  objections: 'Закрытие',
  objection_handling: 'Закрытие',
  next_step: 'Закрытие',
  communication: 'Коммуникация',
  comm: 'Коммуникация',
  tone: 'Коммуникация',
};

function categoryScoresFromDimensions(dimensionScores: Record<string, number> | undefined): Partial<Record<UnifiedReportCategory, number>> {
  if (!dimensionScores) return {};
  const result: Partial<Record<UnifiedReportCategory, number>> = {};
  for (const [key, value] of Object.entries(dimensionScores)) {
    const category = DIMENSION_TO_CATEGORY[String(key || '').trim().toLowerCase()];
    if (!category) continue;
    const score = clampScore(value);
    result[category] = result[category] == null ? score : Math.round(((result[category] as number) + score) / 2);
  }
  return result;
}

export function unifiedVerdict(score: number): UnifiedCallReport['verdict'] {
  if (score >= 76) return 'Хорошо';
  if (score >= 50) return 'Средне';
  return 'Плохо';
}

function asText(value: unknown): string {
  return String(value ?? '').trim();
}

function isPlaceholderText(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    'короткий комментарий',
    'краткий комментарий',
    'комментарий',
    'пример, как стоило сказать',
    'как стоило сказать',
    'пример ответа',
    'цитата',
  ].includes(normalized);
}

function meaningfulText(value: unknown): string {
  const text = asText(value);
  return text && !isPlaceholderText(text) ? text : '';
}

export function normalizeCompanyWording(value: string): string {
  return value
    .replace(/название автосалона/giu, 'название компании')
    .replace(/название салона/giu, 'название компании')
    .replace(/не назвал автосалон/giu, 'не назвал компанию')
    .replace(/назвать автосалон/giu, 'назвать компанию')
    .replace(/называйте автосалон/giu, 'называйте компанию');
}

function arrayOfText(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const raw = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const text = meaningfulText(raw ? raw.text || raw.title || raw.comment : item);
    const key = text.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
    if (text && !result.some((existing) => existing.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ') === key)) {
      result.push(text);
    }
    if (result.length >= limit) break;
  }
  return result;
}

function mergeUniqueText(items: string[], limit: number): string[] {
  const result: string[] = [];
  for (const item of items) {
    const text = meaningfulText(item);
    const key = text.toLocaleLowerCase('ru-RU').replace(/[«»"'.,:;!?—–-]/g, '').replace(/\s+/g, ' ').trim();
    if (text && key && !result.some((existing) => existing.toLocaleLowerCase('ru-RU').replace(/[«»"'.,:;!?—–-]/g, '').replace(/\s+/g, ' ').trim() === key)) {
      result.push(text);
    }
    if (result.length >= limit) break;
  }
  return result;
}

function weaknessTopic(value: string): string | null {
  const text = findingTextKey(value);
  if (/(?:не представил|не представился|не назвал компани|приветств)/u.test(text)) return 'introduction';
  if (/(?:не уточнил запрос|уточнен[а-яa-z]* интересующ[а-яa-z]* автомобил|какой именно автомобил)/u.test(text)) {
    return 'request-clarification';
  }
  if (/презентац/u.test(text)) return 'product-presentation';
  if (/(?:следующ[а-яa-z]* шаг|повторн[а-яa-z]* контакт)/u.test(text)) return 'next-step';
  return null;
}

function mergeUniqueWeaknesses(primaryItems: string[], secondaryItems: string[], limit: number): string[] {
  const result = mergeUniqueText(primaryItems, limit);
  const primaryTopics = new Set(result.map(weaknessTopic).filter((topic): topic is string => Boolean(topic)));
  for (const item of secondaryItems) {
    const topic = weaknessTopic(item);
    if (topic && primaryTopics.has(topic)) continue;
    const merged = mergeUniqueText([...result, item], limit);
    result.splice(0, result.length, ...merged);
    if (result.length >= limit) break;
  }
  return result;
}

const GENERIC_EXAMPLE_WORDS = new Set([
  'автомобил', 'машин', 'модел', 'клиент', 'менеджер', 'сотрудник', 'компан',
  'предложен', 'услов', 'стоимост', 'цен', 'рубл', 'может', 'нужн', 'котор',
  'этот', 'ваш', 'наш', 'сказа', 'ответ', 'вопрос', 'хорош', 'понятн',
]);

function wordStem(value: string): string {
  const normalized = value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^а-яa-z0-9]/g, '');
  if (normalized.length < 5) return normalized;
  return normalized.replace(/(?:иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ов|ев|ом|ем|ам|ям|ой|ей|ую|юю|ая|яя|ое|ее|ые|ие|ый|ий|ым|им|а|я|ы|и|у|ю|е|о)$/u, '');
}

function contentStems(value: string): Set<string> {
  return new Set(value.split(/\s+/u)
    .map(wordStem)
    .filter((word) => word.length >= 4 && !GENERIC_EXAMPLE_WORDS.has(word)));
}

function matchingManagerTurnIndexes(quote: string, transcript: TranscriptTurn[]): number[] {
  const target = quote.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
  if (!target) return [];
  return transcript.flatMap((turn, index) => {
    const text = asText(turn.text).toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
    return turn.role === 'manager' && (text === target || text.includes(target) || target.includes(text))
      ? [index] : [];
  });
}

function findTranscriptQuoteIndex(quote: string, transcript: TranscriptTurn[]): number {
  return matchingManagerTurnIndexes(quote, transcript)[0] ?? -1;
}

function findingTextKey(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9]+/giu, ' ').trim();
}

function similarAdvice(left: string, right: string): boolean {
  const a = contentStems(left);
  const b = contentStems(right);
  if (a.size < 2 || b.size < 2) return false;
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / Math.min(a.size, b.size) >= 0.7;
}

function deduplicateFindings(
  items: UnifiedCallReport['keyFindings'],
  transcript: TranscriptTurn[],
): UnifiedCallReport['keyFindings'] {
  const result: UnifiedCallReport['keyFindings'] = [];
  const importance = { Критично: 3, Важно: 2, Средне: 1 };
  for (const item of items) {
    const quoteIndex = findTranscriptQuoteIndex(item.quote, transcript);
    const key = findingTextKey(item.quote);
    const existingIndex = result.findIndex((existing) => (
      quoteIndex >= 0
        ? findTranscriptQuoteIndex(existing.quote, transcript) === quoteIndex
        : findingTextKey(existing.quote) === key)
      && (existing.problemTitle === item.problemTitle
        || similarAdvice(existing.betterExample, item.betterExample)
        || similarAdvice(existing.comment, item.comment)));
    if (existingIndex < 0) {
      result.push(item);
    } else if (importance[item.importance] > importance[result[existingIndex].importance]
      || (importance[item.importance] === importance[result[existingIndex].importance]
        && !result[existingIndex].betterExample && item.betterExample)) {
      result[existingIndex] = item;
    }
  }
  return result;
}

/**
 * A coaching example may use only information already available when the
 * manager spoke. If it borrows a distinctive fact from a later client turn,
 * hiding it is safer than teaching the manager to rely on future context.
 */
function sanitizeBetterExample(
  value: unknown,
  quote: string,
  transcript: TranscriptTurn[],
  knownQuoteIndex?: number,
  knownFactsText = '',
): string {
  const example = normalizeCompanyWording(meaningfulText(value));
  if (!example) return '';
  const quoteIndex = knownQuoteIndex == null
    ? findTranscriptQuoteIndex(quote, transcript)
    : knownQuoteIndex;
  if (quoteIndex < 0) return '';

  const precedingClient = [...transcript.slice(0, quoteIndex)].reverse().find((turn) => turn.role === 'client');
  const asksForSpecifics = precedingClient
    && /(?:что\s+(?:входит|включает)|из\s+чего\s+состоит|что\s+провер|какие\s+(?:работы|этапы|операции)|перечислите|расскажите.*(?:провер|состав))/iu.test(precedingClient.text);
  // A direct request for a list of works needs a direct answer. A preceding
  // generic sentence must not make a counter-question look like an answer.
  if (asksForSpecifics && (example.includes('?')
    || /^(?:давайте|нужно|необходимо)\s+(?:сначала\s+)?уточн/iu.test(example))) return '';

  const quoteStems = contentStems(quote);
  const exampleStems = contentStems(example);
  const addedMeaning = [...exampleStems].some((word) => !quoteStems.has(word));
  if (!addedMeaning) return '';

  const knownBefore = contentStems(`${knownFactsText} ${transcript.slice(0, quoteIndex + 1).map((turn) => turn.text).join(' ')}`);
  const futureClient = contentStems(transcript.slice(quoteIndex + 1)
    .filter((turn) => turn.role === 'client')
    .map((turn) => turn.text)
    .join(' '));
  const leaksFutureFact = [...exampleStems].some((word) => futureClient.has(word) && !knownBefore.has(word));
  return leaksFutureFact ? '' : example;
}

function safeFallbackBetterExample(finding: UnifiedCallReport['keyFindings'][number]): string {
  const code = problemByTitle(DEFAULT_CALL_REPORT_PROBLEMS, finding.problemTitle)?.code;
  const byCode: Record<string, string> = {
    NO_INTRO_COMPANY: 'Здравствуйте! Меня зовут [имя], компания [название компании]. Чем могу вам помочь?',
    NO_CLIENT_NAME: 'Подскажите, пожалуйста, как я могу к вам обращаться?',
    WRONG_CLIENT_NAME: 'Спасибо, [имя клиента]. Будем ждать вас в согласованное время.',
    WEAK_DIALOG_OPENING: 'Здравствуйте! Подскажите, пожалуйста, по какому вопросу вы обращаетесь?',
    NO_NEEDS_DISCOVERY: 'Подскажите, пожалуйста, что для вас особенно важно при выборе?',
    NO_REQUEST_CLARIFICATION: 'Уточните, пожалуйста, какой именно вариант вас интересует и что вы хотели бы узнать?',
    NO_KEY_PARAMS: 'Подскажите, пожалуйста, какие параметры для вас важны и в какие сроки вы планируете принять решение?',
    PRODUCT_MISINFORMATION: 'Чтобы не вводить вас в заблуждение, я уточню информацию и вернусь к вам с точным ответом.',
    WEAK_BENEFIT_PRESENTATION: 'Подскажите, что для вас важнее всего, чтобы я мог рассказать именно о подходящих вам преимуществах?',
    NO_DIRECT_ANSWER: 'Сейчас у меня нет подтверждённых данных. Я уточню информацию и вернусь к вам с точным ответом.',
    WEAK_OBJECTION_HANDLING: 'Понимаю ваше сомнение. Подскажите, пожалуйста, что именно вас останавливает?',
    NO_NEXT_STEP: 'Предлагаю согласовать следующий шаг. Когда вам будет удобно продолжить разговор?',
    NO_CONCRETE_NEXT_STEP: 'Давайте сразу согласуем конкретные дату и время следующего контакта. Когда вам удобно?',
    PASSIVE_STYLE: 'Давайте я уточню ваши задачи и предложу подходящий следующий шаг.',
    BAD_TONE: 'Понимаю вас. Давайте спокойно уточним детали и найдём подходящее решение.',
    MONOLOGUE: 'Я обозначил основное. Подскажите, пожалуйста, что из этого для вас наиболее важно?',
    INTERRUPTS_CLIENT: 'Извините, что перебил. Пожалуйста, продолжайте — я вас внимательно слушаю.',
    CRITICAL_VIOLATION: 'Я уточню достоверную информацию и предложу корректный вариант решения без неподтверждённых обещаний.',
  };
  if (code && byCode[code]) return byCode[code];
  const byCategory: Record<UnifiedReportCategory, string> = {
    Контакт: 'Здравствуйте! Подскажите, пожалуйста, как я могу к вам обращаться и чем помочь?',
    Диагностика: 'Подскажите, пожалуйста, что для вас особенно важно и какой результат вы хотите получить?',
    Продукт: 'Уточните, пожалуйста, что для вас важно, чтобы я дал точный и полезный ответ.',
    Закрытие: 'Давайте согласуем конкретный следующий шаг, дату и удобное для вас время.',
    Коммуникация: 'Понимаю вас. Давайте спокойно уточним детали и продолжим разговор.',
  };
  return byCategory[finding.category];
}

function normalizeCategory(value: unknown, fallback: UnifiedReportCategory): UnifiedReportCategory {
  const text = asText(value);
  return UNIFIED_REPORT_CATEGORIES.includes(text as UnifiedReportCategory)
    ? text as UnifiedReportCategory
    : fallback;
}

function normalizeImportance(value: unknown): UnifiedFindingImportance {
  const text = asText(value);
  return text === 'Критично' || text === 'Важно' || text === 'Средне' ? text : 'Важно';
}

function managerRequestedClientName(transcript: TranscriptTurn[]): boolean {
  return Boolean(findManagerClientNameRequest(transcript));
}

function resolveFindingQuote(
  problem: ProblemCatalogItem,
  rawQuote: unknown,
  transcript: TranscriptTurn[],
): string {
  if (problem.code === 'NO_INTRO_COMPANY' || problem.code === 'WEAK_DIALOG_OPENING') {
    const liveTranscript = prepareTranscriptForAnalysis(transcript).transcript;
    const openingManagerTurn = liveTranscript.find((turn) => turn.role === 'manager' && meaningfulText(turn.text));
    if (openingManagerTurn) return openingManagerTurn.text.trim();
  }
  return meaningfulText(rawQuote);
}

function resolveFindingProblem(
  catalog: ProblemCatalogItem[],
  raw: Record<string, unknown>,
  transcript: TranscriptTurn[],
): ProblemCatalogItem | null {
  const selected = problemByTitle(catalog, raw.problemTitle);
  if (!selected) return null;

  if (selected.code === 'NO_CLIENT_NAME' && managerRequestedClientName(transcript)) {
    return null;
  }

  const evidenceText = `${meaningfulText(raw.comment)} ${meaningfulText(raw.quote)}`.toLocaleLowerCase('ru-RU');
  const isAboutClientName = /(имя|зовут|обращаться|представился клиент)/u.test(evidenceText);
  const isAboutRequest = /(запрос|интересует|интересовал|какой именно|товар|продукт|услуг|автомоб|модел|издели)/u.test(evidenceText);

  if (selected.code === 'NO_CLIENT_NAME' && !isAboutClientName && isAboutRequest) {
    return catalog.find((problem) => problem.code === 'NO_REQUEST_CLARIFICATION')
      ?? catalog.find((problem) => problem.code === 'NO_KEY_PARAMS')
      ?? selected;
  }

  return selected;
}

function normalizeMark(value: unknown): UnifiedDialogMark | null {
  const text = asText(value);
  return text === 'positive' || text === 'negative' || text === 'normal' ? text : null;
}

export function normalizeUnifiedCallReport(
  value: unknown,
  fallback: {
    totalScore: number;
    transcript: TranscriptTurn[];
    source?: UnifiedCallReport['source'];
    dimensionScores?: Record<string, number>;
    evaluation?: EvaluationInput | Record<string, unknown> | null;
    recommendations?: unknown[];
  },
  catalog: ProblemCatalogItem[] = DEFAULT_CALL_REPORT_PROBLEMS,
): UnifiedCallReport | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  // The score supplied by application code is authoritative. The LLM may copy
  // an inconsistent score into its JSON even though scoring has already been
  // completed by the evaluator.
  const totalScore = clampScore(fallback.totalScore);
  const sourceScoreValue = Number(source.totalScore);
  const scoreMismatch = Number.isFinite(sourceScoreValue) && clampScore(sourceScoreValue) !== totalScore;
  const categoriesSource = Array.isArray(source.categories) ? source.categories : [];
  const fromDimensions = categoryScoresFromDimensions(fallback.dimensionScores);
  let categories = UNIFIED_REPORT_CATEGORIES.map((name) => {
    const raw = categoriesSource.find((item) => item && typeof item === 'object' && asText((item as Record<string, unknown>).name) === name) as Record<string, unknown> | undefined;
    const score = fromDimensions[name] ?? totalScore;
    return {
      name,
      // Category scores are calculated data as well. Use the model only for
      // the explanatory comment, never for the numeric value.
      score,
      comment: scoreMismatch
        ? `Оценка блока по рассчитанным метрикам: ${score}/100.`
        : normalizeManagerNarrationGender(asText(raw?.comment)) || 'Комментарий по категории не сформирован.',
    };
  });

  const findings = deduplicateFindings((Array.isArray(source.keyFindings) ? source.keyFindings : [])
    .map((item) => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const problem = resolveFindingProblem(catalog, raw, fallback.transcript);
      if (!problem) return null;
      const quote = resolveFindingQuote(problem, raw.quote, fallback.transcript);
      const quoteIndex = findTranscriptQuoteIndex(quote, fallback.transcript);
      if (fallback.transcript.length > 0
        && (quoteIndex < 0 || isUnreliableManagerUtterance(fallback.transcript[quoteIndex].text))) return null;
      return {
        problemTitle: problem.title,
        importance: normalizeImportance(raw.importance),
        category: problem.category,
        quote,
        comment: normalizeManagerNarrationGender(normalizeCompanyWording(meaningfulText(raw.comment))),
        betterExample: sanitizeBetterExample(raw.betterExample, quote, fallback.transcript),
      };
    })
    .filter((item): item is UnifiedCallReport['keyFindings'][number] => Boolean(item))
    .slice(0, 8), fallback.transcript);

  const importanceScoreCap: Record<UnifiedFindingImportance, number> = {
    Критично: 49,
    Важно: 75,
    Средне: 90,
  };
  categories = categories.map((category) => {
    const categoryFindings = findings.filter((finding) => finding.category === category.name);
    const findingCap = categoryFindings.reduce(
      (cap, finding) => Math.min(cap, importanceScoreCap[finding.importance]),
      100,
    );
    const commentWithoutPositiveNegation = category.comment
      .replace(/нет замечаний|замечаний не выявлено|недостатков не выявлено/giu, '');
    const commentContainsConcern = /(?:(?:^|\s)не\s|недостат|частич|слаб|следует|нужно|стоит|необходимо|можно\s+лучше)/iu.test(commentWithoutPositiveNegation);
    const commentCap = commentContainsConcern ? 95 : 100;
    const adjustedScore = Math.min(category.score, findingCap, commentCap);
    const primaryFinding = categoryFindings[0];
    return {
      ...category,
      score: adjustedScore,
      comment: adjustedScore < category.score && primaryFinding
        ? primaryFinding.comment || primaryFinding.problemTitle
        : category.comment,
    };
  });

  const dialogSource = Array.isArray(source.dialog) ? source.dialog : [];
  let dialogSourceCursor = 0;
  const dialog = fallback.transcript.map((turn, index) => {
    let raw: Record<string, unknown> = {};
    if (dialogSource.length === fallback.transcript.length) {
      raw = dialogSource[index] && typeof dialogSource[index] === 'object'
        ? dialogSource[index] as Record<string, unknown>
        : {};
    } else {
      const normalizedTurnText = asText(turn.text).toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
      for (let sourceIndex = dialogSourceCursor; sourceIndex < dialogSource.length; sourceIndex += 1) {
        const candidate = dialogSource[sourceIndex] && typeof dialogSource[sourceIndex] === 'object'
          ? dialogSource[sourceIndex] as Record<string, unknown>
          : null;
        if (!candidate) continue;
        const candidateText = asText(candidate.text).toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
        const candidateRole = asText(candidate.role);
        if (candidateText === normalizedTurnText && (!candidateRole || candidateRole === turn.role)) {
          raw = candidate;
          dialogSourceCursor = sourceIndex + 1;
          break;
        }
      }
    }
    const role = turn.role;
    if (role === 'manager' && isUnreliableManagerUtterance(turn.text)) {
      return { role, text: turn.text, mark: null, comment: null, betterExample: null };
    }
    if (role === 'manager' && isClientNameRequest(turn.text)) {
      return {
        role,
        text: turn.text,
        mark: 'positive' as const,
        comment: 'Менеджер уточнил имя клиента.',
        betterExample: null,
      };
    }
    const rawMark = role === 'manager' ? normalizeMark(raw.mark) : null;
    const betterExample = role === 'manager' && rawMark === 'negative'
      ? sanitizeBetterExample(raw.betterExample, turn.text, fallback.transcript, index) || null
      : null;
    const comment = role === 'manager'
      ? normalizeManagerNarrationGender(meaningfulText(raw.comment)) || null
      : null;
    return {
      role,
      text: turn.text,
      mark: rawMark,
      comment,
      betterExample,
    };
  }).map((line, index) => {
    if (line.role !== 'manager' || isUnreliableManagerUtterance(line.text)) return line;
    const matched = findings.find((finding) => {
      const matches = matchingManagerTurnIndexes(finding.quote, fallback.transcript);
      if (matches.length === 0) return false;
      if (matches.length === 1) return matches[0] === index;
      const negativeMatches = dialogSource.length === fallback.transcript.length
        ? matches.filter((candidateIndex) => {
          const sourceLine = dialogSource[candidateIndex];
          return sourceLine && typeof sourceLine === 'object'
            && normalizeMark((sourceLine as Record<string, unknown>).mark) === 'negative';
        })
        : [];
      return index === (negativeMatches.length === 1 ? negativeMatches[0] : matches[0]);
    });
    if (matched) return {
      ...line,
      mark: 'negative' as const,
      comment: matched.comment || matched.problemTitle,
      betterExample: matched.betterExample || null,
    };
    if (line.mark === 'positive' || line.mark == null) return line;
    const nextComment = line.comment || null;
    const nextExample = line.mark === 'negative' ? line.betterExample : null;
    const nextMark = nextComment ? line.mark : null;
    return {
      ...line,
      mark: nextMark,
      comment: nextComment,
      betterExample: nextExample,
    };
  });

  const normalizeRecommendations = (items: unknown[]) => items
    .map((item) => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const problem = raw.problemTitle ? problemByTitle(catalog, raw.problemTitle) : null;
      return {
        text: normalizeManagerNarrationGender(asText(raw.text || raw.recommendation || raw.title || raw.description || item)),
        category: normalizeCategory(raw.category, problem?.category ?? 'Коммуникация'),
        problemTitle: problem?.title ?? null,
      };
    })
    .filter((item) => item.text)
    .slice(0, 8);
  const reportRecommendations = normalizeRecommendations(
    Array.isArray(source.recommendations) ? source.recommendations : [],
  );
  const evaluationRecommendations = fallback.evaluation
    && Array.isArray((fallback.evaluation as EvaluationInput).recommendations)
    ? (fallback.evaluation as EvaluationInput).recommendations as unknown[]
    : [];
  const recommendations = reportRecommendations.length > 0
    ? reportRecommendations
    : normalizeRecommendations(
      fallback.recommendations?.length ? fallback.recommendations : evaluationRecommendations,
    );

  const reportSource = source.source === 'trainer' || fallback.source === 'trainer' ? 'trainer' : 'call';
  const aiStrengths = arrayOfText(source.strengths, 8).map(normalizeManagerNarrationGender);
  const aiWeaknesses = arrayOfText(source.weaknesses, 8).map(normalizeManagerNarrationGender);
  const positiveManagerTurnIndexes = new Set(dialog.flatMap((line, index) => (
    line.role === 'manager' && line.mark === 'positive' ? [index] : []
  )));
  const evaluatedHighlights = buildEvaluationHighlights(
    fallback.evaluation,
    8,
    fallback.transcript,
    { positiveManagerTurnIndexes },
  );
  const demonstratedStrengths = dialog
    .filter((line) => line.role === 'manager' && line.mark === 'positive'
      && /^(?:менеджер|сотрудник|консультант|продавец)\s+/iu.test(line.comment ?? ''))
    .map((line) => line.comment as string);
  const weaknessSummary = evaluatedHighlights.weaknesses.slice(0, 2).join('; ');
  const baseWeaknesses = evaluatedHighlights.hasClassification
    ? evaluatedHighlights.weaknesses
    : aiWeaknesses;
  const findingWeaknesses = findings.map((finding) => finding.comment
    ? `${finding.problemTitle}: ${finding.comment}`
    : finding.problemTitle);
  const weaknesses = mergeUniqueWeaknesses(findingWeaknesses, baseWeaknesses, 8);
  const correctedSummary = totalScore < 50
    ? `Разговор требует существенной доработки.${weaknessSummary ? ` Основные зоны роста: ${weaknessSummary}.` : ''}`
    : totalScore < 76
      ? `Разговор проведён на среднем уровне.${weaknessSummary ? ` Зоны роста: ${weaknessSummary}.` : ''}`
      : 'Разговор проведён на хорошем уровне.';

  return {
    version: 'call-report-v1',
    source: reportSource,
    summary: scoreMismatch
      ? correctedSummary
      : normalizeManagerNarrationGender(asText(source.summary)) || 'Резюме разговора не сформировано.',
    totalScore,
    verdict: unifiedVerdict(totalScore),
    categories,
    strengths: fallback.transcript.length > 0
      ? mergeUniqueText([...evaluatedHighlights.strengths, ...demonstratedStrengths], 8)
      : evaluatedHighlights.hasClassification ? evaluatedHighlights.strengths : aiStrengths,
    weaknesses,
    keyFindings: findings,
    dialog,
    recommendations,
  };
}

/**
 * A recommendation linked to a catalog problem means the report has already
 * classified a concrete coaching issue. Do not let that issue disappear from
 * key findings merely because the first model response omitted its card.
 */
export async function ensureRecommendationFindingCoverage(
  report: UnifiedCallReport,
  transcript: TranscriptTurn[],
  catalog: ProblemCatalogItem[] = DEFAULT_CALL_REPORT_PROBLEMS,
  evaluation?: EvaluationInput | Record<string, unknown> | null,
): Promise<UnifiedCallReport> {
  const existingTitles = new Set(report.keyFindings.map((finding) => finding.problemTitle));
  const missingProblems = report.recommendations
    .map((recommendation) => recommendation.problemTitle
      ? problemByTitle(catalog, recommendation.problemTitle)
      : null)
    .filter((problem): problem is ProblemCatalogItem => Boolean(problem))
    .filter((problem, index, items) => !existingTitles.has(problem.title)
      && items.findIndex((item) => item.code === problem.code) === index)
    .slice(0, Math.max(0, 8 - report.keyFindings.length));
  if (missingProblems.length === 0 || transcript.length === 0) return report;

  const transcriptText = transcript
    .map((turn, index) => `${index + 1}. ${turn.role === 'manager' ? 'Менеджер' : 'Клиент'}: ${turn.text}`)
    .join('\n');
  const context = [
    `Итог: ${report.summary}`,
    ...report.categories.map((category) => `${category.name}: ${category.comment}`),
    ...report.weaknesses.map((weakness) => `Слабая сторона: ${weakness}`),
    ...report.recommendations.map((recommendation) => `Рекомендация: ${recommendation.text}`),
  ].join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      messages: [
        {
          role: 'system',
          content: 'Ты проверяешь полноту отчёта по разговору. Возвращай только валидный JSON и не придумывай факты или цитаты.',
        },
        {
          role: 'user',
          content: [
            'В отчёте есть рекомендации по подтверждённым проблемам, но для них отсутствуют карточки keyFindings.',
            'Для КАЖДОЙ перечисленной проблемы верни отдельную находку только при наличии реальной подтверждающей реплики менеджера.',
            'quote скопируй дословно из реплики менеджера. Не заменяй проблему другой и не объединяй разные ошибки одной реплики.',
            'betterExample должен исправлять именно эту ошибку без новых неподтверждённых фактов.',
            `Пропущенные проблемы:\n${missingProblems.map((problem) => `- ${problem.title} (${problem.category})`).join('\n')}`,
            `Контекст отчёта:\n${context}`,
            `Диалог:\n${transcriptText}`,
            'Формат: {"keyFindings":[{"problemTitle":"точно из списка","importance":"Важно","category":"категория из списка","quote":"дословная реплика менеджера","comment":"что именно сделано неверно","betterExample":"как ответить лучше"}]}',
          ].join('\n\n'),
        },
      ],
      response_format: { type: 'json_object' },
      ...compatibleChatTemperature(config.openaiChatModel, 0.1),
      max_completion_tokens: 2500,
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return report;
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const repairedItems = Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [];
    if (repairedItems.length === 0) return report;
    // This is a repair of an already-normalized report. Preserve its
    // authoritative calculated category scores while normalizing only the
    // newly returned findings.
    const preservedDimensionScores: Record<string, number> = {
      first_contact: report.categories.find((item) => item.name === 'Контакт')?.score ?? report.totalScore,
      needs_discovery: report.categories.find((item) => item.name === 'Диагностика')?.score ?? report.totalScore,
      product_and_sales: report.categories.find((item) => item.name === 'Продукт')?.score ?? report.totalScore,
      closing_commitment: report.categories.find((item) => item.name === 'Закрытие')?.score ?? report.totalScore,
      communication: report.categories.find((item) => item.name === 'Коммуникация')?.score ?? report.totalScore,
    };
    return normalizeUnifiedCallReport(
      { ...report, keyFindings: [...report.keyFindings, ...repairedItems] },
      {
        totalScore: report.totalScore,
        transcript,
        source: report.source,
        dimensionScores: preservedDimensionScores,
        evaluation,
      },
      catalog,
    ) ?? report;
  } catch (error) {
    console.warn('[unified-report] finding coverage repair failed:', error instanceof Error ? error.message : error);
    return report;
  }
}

/**
 * The main report generation intentionally drops coaching examples that use
 * future context or merely paraphrase the manager. A missing example should
 * not silently remove the "Как лучше" block, though, so make one focused
 * repair pass using only the context that was available at that moment.
 */
export async function ensureFindingBetterExamples(
  report: UnifiedCallReport,
  transcript: TranscriptTurn[],
  scenarioContext = '',
): Promise<UnifiedCallReport> {
  const allMissing = report.keyFindings
    .map((finding, index) => ({ finding, index, quoteIndex: findTranscriptQuoteIndex(finding.quote, transcript) }))
    .filter(({ finding }) => !finding.betterExample.trim());
  if (allMissing.length === 0) return report;
  const missing = allMissing.filter(({ quoteIndex }) => quoteIndex >= 0);

  const items = missing.map(({ finding, index, quoteIndex }) => ({
    index,
    quoteIndex,
    problemTitle: finding.problemTitle,
    comment: finding.comment,
    quote: finding.quote,
    knownDialog: transcript
      .slice(0, quoteIndex + 1)
      .map((turn) => `${turn.role === 'manager' ? 'Менеджер' : 'Клиент'}: ${turn.text}`)
      .join('\n'),
    scenarioFacts: scenarioContext.slice(0, 10000),
  }));

  let repaired = report.keyFindings.map((finding) => ({ ...finding }));
  let pending = items;
  for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt += 1) {
    try {
      const response = await openai.chat.completions.create({
        model: config.openaiChatModel,
        messages: [
          {
            role: 'system',
            content: 'Ты редактор учебных примеров для менеджеров. Отвечай только валидным JSON.',
          },
          {
            role: 'user',
            content: [
              'Для каждой находки создай один конкретный вариант «Как лучше».',
              'Это должна быть готовая реплика менеджера, которая действительно устраняет указанное замечание.',
              'Не пересказывай исходную реплику и не объясняй оценку.',
              'Используй только сведения из knownDialog и scenarioFacts: факты сценария были известны менеджеру до звонка. Нельзя использовать факты, которые клиент сообщил позднее.',
              'Если клиент спросил, что входит в проверку, работы или услугу, перечисли подтверждённые пункты из scenarioFacts. Не заменяй ответ встречным вопросом. Если перечень неизвестен, честно предложи уточнить его и вернуться с прямым ответом.',
              'Не придумывай цены, сроки, характеристики, наличие или обещания. Уточняющий вопрос допустим только если он помогает ответить на вопрос клиента, а не подменяет прямой ответ.',
              attempt > 1 ? 'Это повторная попытка: предыдущие варианты не прошли проверку. Сделай их содержательно лучше исходной реплики.' : '',
              '',
              JSON.stringify({ items: pending }, null, 2),
              '',
              'Верни JSON: {"items":[{"index":0,"betterExample":"готовая реплика менеджера"}]}',
            ].filter(Boolean).join('\n'),
          },
        ],
        response_format: { type: 'json_object' },
        ...compatibleChatTemperature(config.openaiChatModel, attempt === 1 ? 0.2 : 0.1),
        max_completion_tokens: 1200,
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty better-example repair response');
      const parsed = JSON.parse(content) as { items?: Array<{ index?: unknown; betterExample?: unknown }> };
      const candidates = Array.isArray(parsed.items) ? parsed.items : [];
      const stillMissing: typeof pending = [];
      for (const item of pending) {
        const candidate = candidates.find((value) => Number(value.index) === item.index);
        const betterExample = sanitizeBetterExample(
          candidate?.betterExample,
          item.quote,
          transcript,
          item.quoteIndex,
          scenarioContext,
        );
        if (betterExample) {
          repaired[item.index] = { ...repaired[item.index], betterExample };
        } else {
          stillMissing.push(item);
        }
      }
      pending = stillMissing;
    } catch (error) {
      console.warn('[unified-report] better examples repair failed:', error instanceof Error ? error.message : error);
      break;
    }
  }

  for (const { finding, index } of allMissing) {
    if (!repaired[index]?.betterExample.trim()) {
      repaired[index] = {
        ...repaired[index],
        betterExample: (() => {
          const quoteIndex = findTranscriptQuoteIndex(finding.quote, transcript);
          const precedingClient = quoteIndex >= 0
            ? [...transcript.slice(0, quoteIndex)].reverse().find((turn) => turn.role === 'client')
            : undefined;
          return precedingClient && /(?:что\s+(?:входит|включает)|из\s+чего\s+состоит|что\s+провер|какие\s+(?:работы|этапы|операции))/iu.test(precedingClient.text)
            ? 'Я уточню полный перечень работ по этой проверке и перечислю его вам, чтобы не пропустить важное.'
            : safeFallbackBetterExample(finding);
        })(),
      };
    }
  }

  return repaired.some((finding, index) => finding.betterExample !== report.keyFindings[index]?.betterExample)
    ? { ...report, keyFindings: repaired }
    : report;
}

export async function generateUnifiedCallReport(input: {
  transcript: TranscriptTurn[];
  outcome: string | null;
  totalScore: number | null;
  evaluation: EvaluationInput;
  source?: UnifiedCallReport['source'];
  scenarioName?: string | null;
}): Promise<UnifiedCallReport> {
  const source = input.source ?? 'call';
  const totalScore = clampScore(input.totalScore ?? input.evaluation.overall_score_0_100 ?? 0);
  const catalog = await getCallReportProblemCatalog(prisma);
  const problemCatalog = catalog
    .map((problem, index) => `${index + 1}. ${problem.category} — ${problem.title}`)
    .join('\n');
  const transcriptText = input.transcript
    .map((turn, index) => `${index + 1}. ${turn.role === 'manager' ? 'Менеджер' : 'Клиент'}: ${turn.text}`)
    .join('\n');

  const prompt = [
    source === 'trainer'
      ? 'Сформируй единый отчёт по тренировочной сессии менеджера строго в том же формате, что и отчёт по звонку. Верни ТОЛЬКО валидный JSON.'
      : 'Сформируй единый отчёт по звонку тайного покупателя строго по ТЗ. Верни ТОЛЬКО валидный JSON.',
    '',
    'Правила:',
    '- Логика скоринга уже рассчитана, не переоценивай с нуля. Используй totalScore, evaluation.dimension_scores, checklist и issues как источник.',
    source === 'trainer'
      ? '- Отчёт по тренировке: оценивай поведение менеджера в диалоге с виртуальным клиентом, но структуру отчёта сохраняй такой же, как для звонка.'
      : '- Отчёт только по звонку, не по тренировке.',
    '- Общий балл 0-100 и verdict: Хорошо для 76-100, Средне для 50-75, Плохо для 0-49.',
    '- categories должны быть ровно 5 и только: Контакт, Диагностика, Продукт, Закрытие, Коммуникация.',
    '- Для каждой категории score — реалистичное число 0-100 на основе dimension_scores / checklist / issues. Не ставь 0 всем категориям, если общий балл > 0.',
    '- strengths включают только пункты checklist со статусом YES и условия plan_criteria, выполненные минимум на 80%.',
    '- weaknesses включают только пункты checklist со статусом PARTIAL/NO и условия plan_criteria, выполненные менее чем на 80%.',
    '- Пункты checklist со статусом NA не включай ни в strengths, ни в weaknesses. Один пункт не может одновременно быть сильной и слабой стороной.',
    '- keyFindings: problemTitle выбирай ТОЛЬКО из справочника ниже. Нельзя придумывать новые названия проблем.',
    '- Каждая существенная ошибка менеджера, упомянутая в summary, комментарии категории, weaknesses или recommendations, ОБЯЗАТЕЛЬНО должна иметь отдельный пункт keyFindings с реальной цитатой менеджера. Перед возвратом JSON сверь эти четыре раздела с keyFindings.',
    '- Разные ошибки в одной реплике не объединяй и не выбрасывай: например, неверная модель автомобиля и отсутствие презентации — это две отдельные keyFindings, даже если quote совпадает.',
    '- Если менеджер назвал другую модель, марку, цену, характеристику или иной факт вопреки словам клиента, обязательно добавь keyFinding «Слабое знание характеристик / фактическая ошибка (дезинформация)» и пометь реплику negative.',
    '- Если менеджер сначала узнал имя клиента, а затем назвал его другим именем, обязательно добавь keyFinding «Перепутал имя клиента» с ошибочной репликой в quote. Не подменяй эту ошибку проблемой «Пассивный стиль, низкая вовлечённость».',
    '- Если менеджер не ответил на прямой вопрос клиента, обязательно добавь отдельную keyFinding «Ушёл от вопроса клиента / не дал прямого ответа», даже когда в той же реплике есть другая ошибка.',
    '- keyFindings должны содержать все подтверждённые существенные ошибки, но не более 8 пунктов. Не добавляй замечания без подтверждения в диалоге.',
    '- Заголовок, comment, quote и betterExample одной keyFinding должны описывать одну и ту же проблему. Не объединяй имя клиента и уточнение его запроса в одной находке.',
    '- Не добавляй проблему «Не уточнил / не подтвердил имя клиента», если менеджер спросил «Как вас зовут?» или «Как я могу к вам обращаться?».',
    '- keyFindings.quote должна быть реальной цитатой из диалога. Если точной цитаты нет, возьми самый близкий фрагмент из стенограммы.',
    '- Для каждой keyFinding обязательно сформируй betterExample: готовую реплику менеджера, которая устраняет именно это замечание. Если конкретных данных недостаточно, используй нейтральный уточняющий вопрос без выдуманных фактов.',
    '- Для проблем приветствия, представления или названия компании keyFindings.quote должна быть первой живой репликой менеджера, а не случайной репликой из середины разговора.',
    '- В keyFindings.comment и keyFindings.betterExample используй универсальную формулировку «название компании», а не «название автосалона».',
    '- dialog должен содержать ВСЕ реплики исходного диалога в том же порядке.',
    '- Для каждой реплики менеджера mark: positive | normal | negative. Для клиента mark=null, comment=null, betterExample=null.',
    '- Для реплики менеджера с mark=negative можно добавить betterExample только если он явно лучше исходного ответа. Для positive/normal betterExample=null.',
    '- Для mark=normal или mark=negative comment обязателен и должен конкретно объяснять пометку. Если объяснения нет, ставь mark=null.',
    '- betterExample должен отвечать на тот же вопрос, сохранять все корректные факты исходной реплики и не добавлять новые цены, сроки, характеристики или обещания. Используй только сведения, известные ДО анализируемой реплики включительно. Запрещено опираться на потребности и факты, которые клиент сообщил позднее. Если пример не устраняет замечание, лишь перефразирует исходную реплику или требует будущего контекста, верни null.',
    '- Не помечай развёрнутый ответ как слабый только потому, что эталон или критерий сформулирован короче. Если обязательный смысл передан верно, учитывай ответ как выполненный; дополнительные уместные детали не являются ошибкой.',
    '- При проверке условия учитывай смысл нескольких последовательных реплик менеджера вместе, если ответ был разбит на части.',
    '- recommendations должны быть конкретными следующими шагами для менеджера/руководителя филиала.',
    '- Все пользовательские тексты строго на русском.',
    '- Слово «менеджер» во всех аналитических формулировках согласуй только в мужском роде: «менеджер представился», «назвал», «ответил», независимо от пола или голоса сотрудника.',
    '',
    'Справочник проблем:',
    problemCatalog,
    '',
    source === 'trainer'
      ? `Сценарий тренировки: ${input.scenarioName ?? '—'}`
      : `Исход звонка: ${input.outcome ?? '—'}`,
    `Итоговый балл: ${totalScore}/100`,
    '',
    `Evaluation JSON:\n${JSON.stringify(input.evaluation).slice(0, 12000)}`,
    '',
    `Диалог:\n${transcriptText}`,
    '',
    'Верни JSON строго по схеме:',
    JSON.stringify({
      version: 'call-report-v1',
      source,
      summary: '2-3 предложения, общее впечатление от разговора простым языком',
      totalScore,
      verdict: unifiedVerdict(totalScore),
      categories: UNIFIED_REPORT_CATEGORIES.map((name) => ({ name, score: totalScore, comment: 'краткий комментарий' })),
      strengths: ['короткий буллет без цитат'],
      weaknesses: ['короткий буллет без цитат'],
      keyFindings: [{
        problemTitle: catalog[0]?.title ?? DEFAULT_CALL_REPORT_PROBLEMS[0].title,
        importance: 'Важно',
        category: 'Контакт',
        quote: 'реальный фрагмент из диалога',
        comment: 'конкретно, что в этой реплике было хорошо или плохо',
        betterExample: 'конкретный вариант, как стоило ответить',
      }],
      dialog: input.transcript.map((turn) => ({
        role: turn.role,
        text: turn.text,
        mark: turn.role === 'manager' ? 'positive' : null,
        comment: turn.role === 'manager' ? null : null,
        betterExample: turn.role === 'manager' ? null : null,
      })),
      recommendations: [{ text: 'конкретное действие', category: 'Контакт', problemTitle: catalog[0]?.title ?? DEFAULT_CALL_REPORT_PROBLEMS[0].title }],
    }, null, 2),
  ].join('\n');

  const response = await openai.chat.completions.create({
    model: config.openaiChatModel,
    messages: [
      { role: 'system', content: 'Ты строгий аналитик качества продаж. Отвечай только валидным JSON по заданной схеме.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    ...compatibleChatTemperature(config.openaiChatModel, 0.2),
    // Reasoning models count hidden reasoning and the full dialog JSON against
    // this limit. A smaller cap can produce an empty visible response.
    max_completion_tokens: 8000,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty unified report response');
  const parsed = JSON.parse(content) as unknown;
  const dimensionScores = input.evaluation.dimension_scores && typeof input.evaluation.dimension_scores === 'object'
    ? input.evaluation.dimension_scores as Record<string, number>
    : undefined;
  const normalized = normalizeUnifiedCallReport(
    parsed,
    { totalScore, transcript: input.transcript, source, dimensionScores, evaluation: input.evaluation },
    catalog,
  );
  if (!normalized) throw new Error('Invalid unified report JSON');
  const covered = await ensureRecommendationFindingCoverage(normalized, input.transcript, catalog, input.evaluation);
  return ensureFindingBetterExamples(covered, input.transcript);
}

export async function generateUnifiedTrainerReport(input: {
  transcript: TranscriptTurn[];
  totalScore: number | null;
  evaluation: EvaluationInput;
  scenarioName?: string | null;
}): Promise<UnifiedCallReport> {
  return generateUnifiedCallReport({
    transcript: input.transcript,
    outcome: 'trainer',
    totalScore: input.totalScore,
    evaluation: input.evaluation,
    source: 'trainer',
    scenarioName: input.scenarioName,
  });
}
