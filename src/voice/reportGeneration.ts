import type OpenAI from 'openai';
import { compatibleChatMaxTokens, openai } from '../lib/openaiClient';
import { compatibleReportReasoning } from '../lib/chatReasoning';
import { updateAuditAnalyticsStage } from '../logic/auditAnalyticsProgress';
import { DEFAULT_CALL_REPORT_PROBLEMS, problemByTitle } from './problemCatalog';

/** Do not publish a factual-error label whose own explanation explicitly denies that error. */
export function reportGenerationIssues(report: Record<string, unknown>): string[] {
  return (Array.isArray(report.keyFindings) ? report.keyFindings : []).flatMap((finding, index) => {
    if (!finding || typeof finding !== 'object' || problemByTitle(DEFAULT_CALL_REPORT_PROBLEMS, finding.problemTitle)?.code !== 'PRODUCT_MISINFORMATION') return [];
    return /фактическ[а-яё]*\s+ошиб[а-яё]*(?:\s+[^.!?]{0,45})?\s+нет|нет\s+фактическ[а-яё]*\s+ошиб|не\s+(?:является|содержит)\s+(?:фактическ[а-яё]*\s+ошиб|дезинформац)/iu.test(String(finding.comment ?? ''))
      ? [`keyFindings[${index}]: комментарий явно отрицает фактическую ошибку, но выбран PRODUCT_MISINFORMATION. Не выдавай отсутствие уточнения или презентации за дезинформацию; перепроверь код проблемы и факты, не скрывая реальные противоречия.`] : [];
  });
}

/** Retry only incomplete/invalid JSON, never billing or authentication errors. */
export async function requestReportJson(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<Record<string, unknown>> {
  updateAuditAnalyticsStage('report');
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await openai.chat.completions.create({
      ...params,
      messages: attempt && lastError ? [...params.messages, { role: 'user' as const, content: `Исправь предыдущий результат и верни полный JSON. Причина отклонения: ${lastError instanceof Error ? lastError.message : String(lastError)}` }] : params.messages,
      ...compatibleChatMaxTokens(params.model, attempt === 0 ? 10000 : 16000),
      ...compatibleReportReasoning(params.model, 'generation'),
    }, { maxRetries: 0 });
    const choice = response.choices[0];
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Error('Report generation refused by provider');
    try {
      if (choice?.finish_reason === 'length' || !choice?.message?.content?.trim()) throw new Error('Incomplete report response: token limit or empty content');
      const parsed: unknown = JSON.parse(choice.message.content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid report JSON object');
      if (!Array.isArray((parsed as any).dialog) || !Array.isArray((parsed as any).keyFindings) || typeof (parsed as any).summary !== 'string') throw new Error('Incomplete report JSON schema');
      const issues = reportGenerationIssues(parsed as Record<string, unknown>);
      if (issues.length) throw new Error(issues.join(' '));
      return parsed as Record<string, unknown>;
    } catch (error) { lastError = error; }
  }
  throw new Error('Report generation did not return complete JSON', { cause: lastError });
}
