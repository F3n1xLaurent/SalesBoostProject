import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { compatibleChatReasoning, compatibleReportReasoning, reportReasoningProfile } from '../lib/chatReasoning';
import { openai } from '../lib/openaiClient';
import { requestReportJson } from '../voice/reportGeneration';
import { reportExampleHash, reviewReportExamples, type ReportExampleTask } from '../voice/reportExampleReview';
import { assessReportOutput, type ReportOutput } from '../testing/reportTestEvaluation';
import { REPORT_TEST_SCENARIOS } from '../testing/reportTestCatalog';

const originalEffort = config.openaiReasoningEffort;
const originalModel = config.openaiChatModel;
beforeEach(() => { config.openaiChatModel = 'openai/gpt-5.6-luna'; });
afterEach(() => { config.openaiReasoningEffort = originalEffort; config.openaiChatModel = originalModel; vi.restoreAllMocks(); });
const completion = (data: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }) as any;
const truncated = () => ({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }) as any;

describe('report reasoning configuration', () => {
  it('supports ProxyAPI-prefixed and direct Luna without sending reasoning to legacy models', () => {
    expect(compatibleChatReasoning('openai/gpt-5.6-luna', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(compatibleChatReasoning('gpt-5.6-luna', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(compatibleChatReasoning('openai/gpt-4o-mini', 'high')).toEqual({});
    config.openaiReasoningEffort = undefined;
    expect(compatibleChatReasoning('openai/gpt-5.6-luna')).toEqual({});
  });
  it('uses medium for assembly and its incomplete-JSON retry while retaining the configured model', async () => {
    config.openaiReasoningEffort = 'high';
    const create = vi.spyOn(openai.chat.completions, 'create')
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: '{' } }] } as any)
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dialog: [], keyFindings: [], summary: 'Итог' }) } }] } as any);
    await requestReportJson({ model: 'openai/gpt-5.6-luna', messages: [{ role: 'user', content: 'Отчёт' }] });
    expect(create).toHaveBeenCalledTimes(2);
    for (const [request] of create.mock.calls) expect(request).toMatchObject({ model: 'openai/gpt-5.6-luna', reasoning_effort: 'medium' });
  });

  it('keeps high only in primary stages and snapshots the same effective profile used by requests', () => {
    config.openaiReasoningEffort = 'high';
    const snapshot = reportReasoningProfile();
    expect(snapshot).toEqual({ reasoningProfileVersion: 'report-staged-v2', reasoningByStage: {
      evaluation: 'high', generation: 'medium', findingCoverage: 'medium', dialogCoverage: 'medium',
      exampleRepair: 'medium', exampleReview: 'medium', testAssessment: 'medium',
    } });
    for (const [stage, expected] of Object.entries(snapshot.reasoningByStage)) {
      expect(compatibleReportReasoning(config.openaiChatModel, stage as keyof typeof snapshot.reasoningByStage)).toEqual({ reasoning_effort: expected });
    }
    expect(compatibleReportReasoning('gpt-4o-mini', 'exampleReview')).toEqual({});
    expect(Object.values(reportReasoningProfile('gpt-4o-mini').reasoningByStage)).toEqual(Array(7).fill('provider_default'));
  });

  it.each(['low', 'medium', undefined] as const)('does not increase the configured effort %s in auxiliary stages', (effort) => {
    config.openaiReasoningEffort = effort;
    const profile = reportReasoningProfile();
    expect(Object.values(profile.reasoningByStage)).toEqual(Array(7).fill(effort ?? 'provider_default'));
    expect(compatibleReportReasoning(config.openaiChatModel, 'exampleRepair')).toEqual(effort ? { reasoning_effort: effort } : {});
  });

  it('sends medium in the example review and its protocol retry without increasing its token limit', async () => {
    config.openaiReasoningEffort = 'high';
    const example = 'Здравствуйте! Меня зовут Дмитрий, я менеджер автоцентра «Тест». Цена — 6 405 000 рублей.';
    const task: ReportExampleTask = { turnIndex: 1, example,
      problems: [{ id: 'finding:0', code: 'NO_INTRO_COMPANY', title: 'Представление', comment: 'Не представился.' }],
      knownDialog: [{ role: 'client', text: 'Какая цена?' }, { role: 'manager', text: 'Цена — 6 405 000 рублей.' }], scenarioFacts: '' };
    const response = { items: [{ turnIndex: 1, exampleHash: reportExampleHash(example),
      checks: ['finding:0', 'direct-answer', 'preserves-facts', 'no-invention'].map((id) => ({ id, status: 'pass', reason: 'Подтверждено примером.', evidence: example })) }] };
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(truncated()).mockResolvedValueOnce(completion(response));
    expect((await reviewReportExamples([task]))[0].status).toBe('pass');
    expect(create).toHaveBeenCalledTimes(2);
    for (const [request] of create.mock.calls) expect(request).toMatchObject({ reasoning_effort: 'medium', max_completion_tokens: 7000 });
  });

  it('sends medium to the test judge, including its larger-budget retry', async () => {
    config.openaiReasoningEffort = 'high';
    const fixture = { ...REPORT_TEST_SCENARIOS[0], checks: ['report-summary' as const] };
    const output: ReportOutput = {
      report: { version: 'call-report-v1', source: fixture.source, totalScore: 80, verdict: 'Хорошо', summary: 'Итог',
        categories: [], strengths: [], weaknesses: [], keyFindings: [], dialog: [], recommendations: [] },
      evaluation: { overall_score_0_100: 80 }, transcript: fixture.transcript,
      timings: { evaluationMs: 1, reportMs: 1, totalMs: 2 },
    };
    const response = { checks: [{ id: 'report-summary', status: 'pass', reason: 'Оценка совпадает.', evaluatedRole: 'manager', turnIndices: [1], references: [{ path: '/report/totalScore', value: 80 }] }] };
    const create = vi.spyOn(openai.chat.completions, 'create').mockResolvedValueOnce(truncated()).mockResolvedValueOnce(completion(response));
    expect((await assessReportOutput(fixture, output, new AbortController().signal))[0].status).toBe('pass');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({ reasoning_effort: 'medium', max_completion_tokens: 6000 });
    expect(create.mock.calls[1][0]).toMatchObject({ reasoning_effort: 'medium', max_completion_tokens: 9000 });
  });
});
