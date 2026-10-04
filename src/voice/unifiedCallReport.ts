import { config } from '../config';
import { prisma } from '../db';
import { compatibleChatTemperature, openai } from '../lib/openaiClient';
import type { TranscriptTurn } from './callHistory';
import { prepareTranscriptForAnalysis } from './analysisTranscript';
import { buildEvaluationHighlights } from '../logic/evaluationHighlights';
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

function isClientNameRequest(value: unknown): boolean {
  const text = asText(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ');
  return /(как (?:я )?могу к вам обращаться|как к вам обращаться|как вас зовут|назовите,? пожалуйста,? ваше имя|подскажите[^?.!]*(?:ваше имя|как[^?.!]*обращаться))/u.test(text);
}

function managerRequestedClientName(transcript: TranscriptTurn[]): boolean {
  return transcript.some((turn) => turn.role === 'manager' && isClientNameRequest(turn.text));
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
  const categories = UNIFIED_REPORT_CATEGORIES.map((name) => {
    const raw = categoriesSource.find((item) => item && typeof item === 'object' && asText((item as Record<string, unknown>).name) === name) as Record<string, unknown> | undefined;
    const score = fromDimensions[name] ?? totalScore;
    return {
      name,
      // Category scores are calculated data as well. Use the model only for
      // the explanatory comment, never for the numeric value.
      score,
      comment: scoreMismatch
        ? `Оценка блока по рассчитанным метрикам: ${score}/100.`
        : asText(raw?.comment) || 'Комментарий по категории не сформирован.',
    };
  });

  const findings = (Array.isArray(source.keyFindings) ? source.keyFindings : [])
    .map((item) => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const problem = resolveFindingProblem(catalog, raw, fallback.transcript);
      if (!problem) return null;
      return {
        problemTitle: problem.title,
        importance: normalizeImportance(raw.importance),
        category: problem.category,
        quote: resolveFindingQuote(problem, raw.quote, fallback.transcript),
        comment: normalizeCompanyWording(meaningfulText(raw.comment)),
        betterExample: normalizeCompanyWording(meaningfulText(raw.betterExample)),
      };
    })
    .filter((item): item is UnifiedCallReport['keyFindings'][number] => Boolean(item))
    .slice(0, 8);

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
    if (role === 'manager' && isClientNameRequest(turn.text)) {
      return {
        role,
        text: turn.text,
        mark: 'positive' as const,
        comment: 'Менеджер уточнил имя клиента.',
        betterExample: null,
      };
    }
    const betterExample = role === 'manager' ? meaningfulText(raw.betterExample) || null : null;
    const comment = role === 'manager' ? meaningfulText(raw.comment) || null : null;
    const rawMark = role === 'manager' ? normalizeMark(raw.mark) : null;
    return {
      role,
      text: turn.text,
      mark: rawMark,
      comment,
      betterExample,
    };
  }).map((line) => {
    if (line.role !== 'manager' || line.betterExample) return line;
    const matched = findings.find((finding) => {
      const quote = finding.quote.trim().toLowerCase();
      const text = line.text.trim().toLowerCase();
      if (!quote || !text) return false;
      return text.includes(quote) || quote.includes(text) || text.includes(quote.slice(0, Math.min(40, quote.length)));
    });
    const nextComment = line.comment || matched?.comment || null;
    const nextExample = line.betterExample || matched?.betterExample || null;
    const nextMark = line.mark ?? (nextExample || nextComment ? 'normal' : null);
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
        text: asText(raw.text || raw.recommendation || raw.title || raw.description || item),
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
  const aiStrengths = arrayOfText(source.strengths, 8);
  const aiWeaknesses = arrayOfText(source.weaknesses, 8);
  const evaluatedHighlights = buildEvaluationHighlights(
    fallback.evaluation,
    8,
    fallback.transcript,
  );
  const weaknessSummary = evaluatedHighlights.weaknesses.slice(0, 2).join('; ');
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
      : asText(source.summary) || 'Резюме разговора не сформировано.',
    totalScore,
    verdict: unifiedVerdict(totalScore),
    categories,
    strengths: evaluatedHighlights.hasClassification ? evaluatedHighlights.strengths : aiStrengths,
    weaknesses: evaluatedHighlights.hasClassification ? evaluatedHighlights.weaknesses : aiWeaknesses,
    keyFindings: findings,
    dialog,
    recommendations,
  };
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
    '- Заголовок, comment, quote и betterExample одной keyFinding должны описывать одну и ту же проблему. Не объединяй имя клиента и уточнение его запроса в одной находке.',
    '- Не добавляй проблему «Не уточнил / не подтвердил имя клиента», если менеджер спросил «Как вас зовут?» или «Как я могу к вам обращаться?».',
    '- keyFindings.quote должна быть реальной цитатой из диалога. Если точной цитаты нет, возьми самый близкий фрагмент из стенограммы.',
    '- Для проблем приветствия, представления или названия компании keyFindings.quote должна быть первой живой репликой менеджера, а не случайной репликой из середины разговора.',
    '- В keyFindings.comment и keyFindings.betterExample используй универсальную формулировку «название компании», а не «название автосалона».',
    '- dialog должен содержать ВСЕ реплики исходного диалога в том же порядке.',
    '- Для каждой реплики менеджера mark: positive | normal | negative. Для клиента mark=null, comment=null, betterExample=null.',
    '- Для реплик менеджера с mark=normal или negative добавь comment и, если уместно, betterExample — короткий пример, как стоило сказать.',
    '- Не помечай развёрнутый ответ как слабый только потому, что эталон или критерий сформулирован короче. Если обязательный смысл передан верно, учитывай ответ как выполненный; дополнительные уместные детали не являются ошибкой.',
    '- При проверке условия учитывай смысл нескольких последовательных реплик менеджера вместе, если ответ был разбит на части.',
    '- recommendations должны быть конкретными следующими шагами для менеджера/руководителя филиала.',
    '- Все пользовательские тексты строго на русском.',
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
  return normalized;
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
