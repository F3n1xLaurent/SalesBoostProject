import { config } from '../config';
import { prisma } from '../db';
import { openai } from '../lib/openaiClient';
import type { TranscriptTurn } from './callHistory';
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

function arrayOfText(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.map(asText).filter(Boolean).slice(0, limit)
    : [];
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

function normalizeMark(value: unknown): UnifiedDialogMark {
  const text = asText(value);
  return text === 'positive' || text === 'negative' || text === 'normal' ? text : 'normal';
}

export function normalizeUnifiedCallReport(
  value: unknown,
  fallback: {
    totalScore: number;
    transcript: TranscriptTurn[];
    source?: UnifiedCallReport['source'];
    dimensionScores?: Record<string, number>;
  },
  catalog: ProblemCatalogItem[] = DEFAULT_CALL_REPORT_PROBLEMS,
): UnifiedCallReport | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const totalScore = clampScore(source.totalScore ?? fallback.totalScore);
  const categoriesSource = Array.isArray(source.categories) ? source.categories : [];
  const fromDimensions = categoryScoresFromDimensions(fallback.dimensionScores);
  let categories = UNIFIED_REPORT_CATEGORIES.map((name) => {
    const raw = categoriesSource.find((item) => item && typeof item === 'object' && asText((item as Record<string, unknown>).name) === name) as Record<string, unknown> | undefined;
    const rawScore = raw?.score;
    const hasNumericScore = rawScore !== undefined && rawScore !== null && String(rawScore).trim() !== '' && Number.isFinite(Number(rawScore));
    const parsedScore = hasNumericScore ? clampScore(rawScore) : null;
    return {
      name,
      score: parsedScore ?? fromDimensions[name] ?? totalScore,
      comment: asText(raw?.comment) || 'Комментарий по категории не сформирован.',
    };
  });

  // LLM often copies schema stub with score: 0 for every category.
  const allZero = categories.every((item) => item.score === 0);
  if (allZero && totalScore > 0) {
    categories = categories.map((item) => ({
      ...item,
      score: clampScore(fromDimensions[item.name] ?? totalScore),
    }));
  }

  const findings = (Array.isArray(source.keyFindings) ? source.keyFindings : [])
    .map((item) => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const problem = problemByTitle(catalog, raw.problemTitle);
      if (!problem) return null;
      return {
        problemTitle: problem.title,
        importance: normalizeImportance(raw.importance),
        category: normalizeCategory(raw.category, problem.category),
        quote: asText(raw.quote),
        comment: asText(raw.comment),
        betterExample: asText(raw.betterExample),
      };
    })
    .filter((item): item is UnifiedCallReport['keyFindings'][number] => Boolean(item))
    .slice(0, 8);

  const dialogSource = Array.isArray(source.dialog) ? source.dialog : [];
  const dialog = fallback.transcript.map((turn, index) => {
    const raw = dialogSource[index] && typeof dialogSource[index] === 'object'
      ? dialogSource[index] as Record<string, unknown>
      : {};
    const role = turn.role;
    const betterExample = role === 'manager' ? asText(raw.betterExample) || null : null;
    return {
      role,
      text: turn.text,
      mark: role === 'manager' ? normalizeMark(raw.mark) : null,
      comment: role === 'manager' ? asText(raw.comment) || null : null,
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
    return matched?.betterExample
      ? { ...line, betterExample: matched.betterExample }
      : line;
  });

  const recommendations = (Array.isArray(source.recommendations) ? source.recommendations : [])
    .map((item) => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const problem = raw.problemTitle ? problemByTitle(catalog, raw.problemTitle) : null;
      return {
        text: asText(raw.text || item),
        category: normalizeCategory(raw.category, problem?.category ?? 'Коммуникация'),
        problemTitle: problem?.title ?? null,
      };
    })
    .filter((item) => item.text)
    .slice(0, 8);

  return {
    version: 'call-report-v1',
    source: source.source === 'trainer' || fallback.source === 'trainer' ? 'trainer' : 'call',
    summary: asText(source.summary) || 'Резюме разговора не сформировано.',
    totalScore,
    verdict: unifiedVerdict(totalScore),
    categories,
    strengths: arrayOfText(source.strengths, 8),
    weaknesses: arrayOfText(source.weaknesses, 8),
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
    '- keyFindings: problemTitle выбирай ТОЛЬКО из справочника ниже. Нельзя придумывать новые названия проблем.',
    '- keyFindings.quote должна быть реальной цитатой из диалога. Если точной цитаты нет, возьми самый близкий фрагмент из стенограммы.',
    '- dialog должен содержать ВСЕ реплики исходного диалога в том же порядке.',
    '- Для каждой реплики менеджера mark: positive | normal | negative. Для клиента mark=null, comment=null, betterExample=null.',
    '- Для реплик менеджера с mark=normal или negative добавь comment и, если уместно, betterExample — короткий пример, как стоило сказать.',
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
        quote: 'цитата',
        comment: 'что именно пошло не так',
        betterExample: 'как стоило сказать',
      }],
      dialog: input.transcript.map((turn) => ({
        role: turn.role,
        text: turn.text,
        mark: turn.role === 'manager' ? 'normal' : null,
        comment: turn.role === 'manager' ? 'короткий комментарий' : null,
        betterExample: turn.role === 'manager' ? 'пример, как стоило сказать' : null,
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
    temperature: 0.2,
    max_tokens: 3500,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty unified report response');
  const parsed = JSON.parse(content) as unknown;
  const dimensionScores = input.evaluation.dimension_scores && typeof input.evaluation.dimension_scores === 'object'
    ? input.evaluation.dimension_scores as Record<string, number>
    : undefined;
  const normalized = normalizeUnifiedCallReport(
    parsed,
    { totalScore, transcript: input.transcript, source, dimensionScores },
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
