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
  source: 'call';
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
  fallback: { totalScore: number; transcript: TranscriptTurn[] },
  catalog: ProblemCatalogItem[] = DEFAULT_CALL_REPORT_PROBLEMS,
): UnifiedCallReport | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const totalScore = clampScore(source.totalScore ?? fallback.totalScore);
  const categoriesSource = Array.isArray(source.categories) ? source.categories : [];
  const categories = UNIFIED_REPORT_CATEGORIES.map((name) => {
    const raw = categoriesSource.find((item) => item && typeof item === 'object' && asText((item as Record<string, unknown>).name) === name) as Record<string, unknown> | undefined;
    return {
      name,
      score: clampScore(raw?.score ?? totalScore),
      comment: asText(raw?.comment) || 'Комментарий по категории не сформирован.',
    };
  });

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
    return {
      role,
      text: turn.text,
      mark: role === 'manager' ? normalizeMark(raw.mark) : null,
      comment: role === 'manager' ? asText(raw.comment) || null : null,
    };
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
    source: 'call',
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
}): Promise<UnifiedCallReport> {
  const totalScore = clampScore(input.totalScore ?? input.evaluation.overall_score_0_100 ?? 0);
  const catalog = await getCallReportProblemCatalog(prisma);
  const problemCatalog = catalog
    .map((problem, index) => `${index + 1}. ${problem.category} — ${problem.title}`)
    .join('\n');
  const transcriptText = input.transcript
    .map((turn, index) => `${index + 1}. ${turn.role === 'manager' ? 'Менеджер' : 'Клиент'}: ${turn.text}`)
    .join('\n');

  const prompt = [
    'Сформируй единый отчёт по звонку тайного покупателя строго по ТЗ. Верни ТОЛЬКО валидный JSON.',
    '',
    'Правила:',
    '- Логика скоринга уже рассчитана, не переоценивай с нуля. Используй totalScore, evaluation.dimension_scores, checklist и issues как источник.',
    '- Отчёт только по звонку, не по тренировке.',
    '- Общий балл 0-100 и verdict: Хорошо для 76-100, Средне для 50-75, Плохо для 0-49.',
    '- categories должны быть ровно 5 и только: Контакт, Диагностика, Продукт, Закрытие, Коммуникация.',
    '- keyFindings: problemTitle выбирай ТОЛЬКО из справочника ниже. Нельзя придумывать новые названия проблем.',
    '- keyFindings.quote должна быть реальной цитатой из диалога. Если точной цитаты нет, возьми самый близкий фрагмент из стенограммы.',
    '- dialog должен содержать ВСЕ реплики исходного диалога в том же порядке.',
    '- Для каждой реплики менеджера mark: positive | normal | negative. Для клиента mark=null и comment=null.',
    '- recommendations должны быть конкретными следующими шагами для менеджера/руководителя филиала.',
    '- Все пользовательские тексты строго на русском.',
    '',
    'Справочник проблем:',
    problemCatalog,
    '',
    `Исход звонка: ${input.outcome ?? '—'}`,
    `Итоговый балл: ${totalScore}/100`,
    '',
    `Evaluation JSON:\n${JSON.stringify(input.evaluation).slice(0, 12000)}`,
    '',
    `Диалог:\n${transcriptText}`,
    '',
    'Верни JSON строго по схеме:',
    JSON.stringify({
      version: 'call-report-v1',
      source: 'call',
      summary: '2-3 предложения, общее впечатление от разговора простым языком',
      totalScore,
      verdict: unifiedVerdict(totalScore),
      categories: UNIFIED_REPORT_CATEGORIES.map((name) => ({ name, score: 0, comment: 'краткий комментарий' })),
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
  if (!content) throw new Error('Empty unified call report response');
  const parsed = JSON.parse(content) as unknown;
  const normalized = normalizeUnifiedCallReport(parsed, { totalScore, transcript: input.transcript }, catalog);
  if (!normalized) throw new Error('Invalid unified call report JSON');
  return normalized;
}
