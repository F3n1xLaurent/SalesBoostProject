import { AsyncLocalStorage } from 'node:async_hooks';
import type OpenAI from 'openai';
import { openai } from '../lib/openaiClient';
import { currentCostContext, withCostContext } from '../economics/costContext';

type ReportStage = 'generation' | 'findingCoverage' | 'dialogCoverage' | 'exampleRepair' | 'exampleReview';
const context = new AsyncLocalStorage<{ controller: AbortController; deadline: number }>();
export const REPORT_GENERATION_TIMEOUT_MS = 300_000;

/** Nested generators share a deadline. Cancellation reaches the actual HTTP
 * requests, and an expired task cannot publish a partially checked report. */
export async function withReportGenerationBudget<T>(task: () => Promise<T>, timeoutMs = REPORT_GENERATION_TIMEOUT_MS): Promise<T> {
  const parent = context.getStore();
  if (parent) { parent.controller.signal.throwIfAborted(); return task(); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('REPORT_GENERATION_TIMEOUT')), timeoutMs);
  timer.unref();
  try {
    return await context.run({ controller, deadline: Date.now() + timeoutMs }, async () => {
      const result = await task();
      controller.signal.throwIfAborted();
      return result;
    });
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function createReportCompletion(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, stage: ReportStage) {
  const current = context.getStore();
  current?.controller.signal.throwIfAborted();
  const remaining = current ? current.deadline - Date.now() : 120_000;
  if (remaining <= 0) throw new Error('REPORT_GENERATION_TIMEOUT');
  const options = { timeout: Math.min(stage === 'exampleReview' ? 90_000 : 120_000, remaining), maxRetries: 0,
    ...(current ? { signal: current.controller.signal } : {}) };
  const cost = currentCostContext();
  const started = performance.now();
  try {
    const response = await withCostContext({ entityType: cost?.entityType ?? 'report_generation', entityId: cost?.entityId ?? 'unattributed',
      ...cost, stage: `report_${stage}` }, () => openai.chat.completions.create(params, options));
    console.info('[report/stage]', { stage, ms: Math.round(performance.now() - started),
      inputTokens: response.usage?.prompt_tokens, outputTokens: response.usage?.completion_tokens,
      reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens, finishReason: response.choices[0]?.finish_reason });
    return response;
  } catch (error) {
    console.warn('[report/stage]', { stage, ms: Math.round(performance.now() - started), status: 'failed' });
    throw error;
  }
}

/** Independent groups run concurrently; output order and per-item checks stay
 * stable. This avoids one large grader response exhausting its token budget. */
export async function mapReportBatches<T, R>(items: readonly T[], size: number, concurrency: number, task: (batch: T[]) => Promise<R>): Promise<R[]> {
  if (size < 1 || concurrency < 1) throw new Error('Invalid report batch limits');
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  const results = new Array<R>(batches.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      const index = next++;
      context.getStore()?.controller.signal.throwIfAborted();
      results[index] = await task(batches[index]);
    }
  }));
  return results;
}
