import { config } from '../config';
import { prisma } from '../db';
import { openai } from '../lib/openaiClient';
import type { CallSummary, ReplyImprovement } from './callSummary';
import type { TranscriptTurn } from './callHistory';
import {
  DEFAULT_CALL_REPORT_PROBLEMS,
  getCallReportProblemCatalog,
} from './problemCatalog';
import {
  normalizeUnifiedCallReport,
  UNIFIED_REPORT_CATEGORIES,
  unifiedVerdict,
  type UnifiedCallReport,
} from './unifiedCallReport';

type EvaluationInput = {
  overall_score_0_100?: number;
  dimension_scores?: unknown;
  checklist?: unknown;
  issues?: unknown;
  recommendations?: unknown[];
};

type AnalyticsBundle = {
  callSummary: CallSummary | null;
  replyImprovements: ReplyImprovement[] | null;
  unifiedCallReport: UnifiedCallReport | null;
};

function asText(value: unknown): string {
  return String(value ?? '').trim();
}

export async function generateCallAnalyticsBundle(input: {
  transcript: TranscriptTurn[];
  outcome: string | null;
  totalScore: number | null;
  evaluation: EvaluationInput;
  scenarioContext?: string;
}): Promise<AnalyticsBundle> {
  const totalScore = Math.max(0, Math.min(100, Math.round(
    Number(input.totalScore ?? input.evaluation.overall_score_0_100 ?? 0) || 0,
  )));
  const checklist = Array.isArray(input.evaluation.checklist) ? input.evaluation.checklist : [];
  const issues = Array.isArray(input.evaluation.issues) ? input.evaluation.issues : [];
  const recommendations = Array.isArray(input.evaluation.recommendations) ? input.evaluation.recommendations : [];
  const catalog = await getCallReportProblemCatalog(prisma);
  const problemCatalog = catalog
    .map((problem, index) => `${index + 1}. ${problem.category} — ${problem.title}`)
    .join('\n');
  const transcriptText = input.transcript
    .map((turn, index) => `${index + 1}. ${turn.role === 'manager' ? 'Менеджер' : 'Клиент'}: ${turn.text}`)
    .join('\n');

  const prompt = [
    'Сформируй компактный единый отчёт по звонку тайного покупателя. Верни ТОЛЬКО валидный JSON.',
    '',
    'Общие правила:',
    '- Все пользовательские тексты строго на русском.',
    '- Логика скоринга уже рассчитана, не переоценивай с нуля.',
    '- Используй totalScore, dimension_scores, checklist, issues и transcript как источник фактов.',
    '- Не придумывай цитаты. Цитаты бери только из диалога.',
    '- Отвечай кратко: без длинных абзацев, без повторения полной стенограммы.',
    '',
    `Исход звонка: ${input.outcome ?? '—'}`,
    `Итоговый балл: ${totalScore}/100`,
    `Вердикт: ${unifiedVerdict(totalScore)}`,
    ...(input.scenarioContext ? [
      '',
      'Сценарий и условия, по которым выполнялся звонок. Учитывай их при анализе ответов менеджера:',
      input.scenarioContext.slice(0, 16000),
    ] : []),
    '',
    `Справочник проблем для unifiedCallReport.keyFindings.problemTitle:\n${problemCatalog}`,
    '',
    `Evaluation JSON:\n${JSON.stringify(input.evaluation).slice(0, 12000)}`,
    '',
    `Проблемы:\n${issues.slice(0, 10).map((issue, index) => `${index + 1}. ${asText((issue as any).recommendation || (issue as any).issue_type)}`).filter(Boolean).join('\n') || '—'}`,
    '',
    `Рекомендации оценщика:\n${recommendations.slice(0, 8).map((item, index) => `${index + 1}. ${asText(item)}`).filter(Boolean).join('\n') || '—'}`,
    '',
    `Чеклист:\n${checklist.slice(0, 13).map((item) => `${asText((item as any).code)}: ${asText((item as any).status)}${asText((item as any).comment) ? ` — ${asText((item as any).comment)}` : ''}`).join('\n') || '—'}`,
    '',
    `Диалог:\n${transcriptText}`,
    '',
    '- version строго "call-report-v1"; source строго "call".',
    '- categories должны быть ровно 5 и только: Контакт, Диагностика, Продукт, Закрытие, Коммуникация.',
    '- keyFindings.problemTitle выбирай ТОЛЬКО из справочника проблем.',
    '- dialog не должен повторять текст реплик: верни только элементы с mark/comment в том же количестве и порядке, что исходный диалог.',
    '- Для реплики клиента mark=null и comment=null.',
    '- Для реплики менеджера mark: positive | normal | negative, comment короткий, до 90 символов.',
    '- keyFindings: 2-5 пунктов.',
    '- strengths/weaknesses/recommendations: по 2-4 коротких пункта.',
    '',
    'Верни JSON строго по схеме:',
    JSON.stringify({
      version: 'call-report-v1',
      source: 'call',
      summary: '...',
      totalScore,
      verdict: unifiedVerdict(totalScore),
      categories: UNIFIED_REPORT_CATEGORIES.map((name) => ({ name, score: totalScore, comment: '...' })),
      strengths: ['...'],
      weaknesses: ['...'],
      keyFindings: [{
        problemTitle: catalog[0]?.title ?? DEFAULT_CALL_REPORT_PROBLEMS[0].title,
        importance: 'Важно',
        category: catalog[0]?.category ?? 'Контакт',
        quote: '...',
        comment: '...',
        betterExample: '...',
      }],
      dialog: input.transcript.map((turn) => ({
        mark: turn.role === 'manager' ? 'normal' : null,
        comment: turn.role === 'manager' ? '...' : null,
      })),
      recommendations: [{ text: '...', category: 'Контакт', problemTitle: catalog[0]?.title ?? DEFAULT_CALL_REPORT_PROBLEMS[0].title }],
    }, null, 2),
  ].join('\n');

  const response = await openai.chat.completions.create({
    model: config.openaiChatModel,
    messages: [
      {
        role: 'system',
        content: 'Ты строгий аналитик качества продаж. Отвечай только валидным JSON по заданной схеме.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.25,
    max_tokens: 2200,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty call analytics bundle response');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    callSummary: null,
    replyImprovements: null,
    unifiedCallReport: normalizeUnifiedCallReport(
      parsed,
      { totalScore, transcript: input.transcript, source: 'call' },
      catalog,
    ),
  };
}
