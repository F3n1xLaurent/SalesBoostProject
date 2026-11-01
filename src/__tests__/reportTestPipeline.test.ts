import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ evaluate: vi.fn(), call: vi.fn(), trainer: vi.fn() }));
vi.mock('../llm/evaluatorV2', () => ({ evaluateSessionV2: mocks.evaluate }));
vi.mock('../voice/callAnalyticsBundle', () => ({ generateCallAnalyticsBundle: mocks.call }));
vi.mock('../voice/unifiedCallReport', async (original) => ({ ...await original<typeof import('../voice/unifiedCallReport')>(), generateUnifiedTrainerReport: mocks.trainer }));
import { generateReportTestOutput } from '../testing/reportTestEvaluation';
import { REPORT_TEST_SCENARIOS } from '../testing/reportTestCatalog';

beforeEach(() => { vi.resetAllMocks(); mocks.evaluate.mockResolvedValue({ evaluation: { overall_score_0_100: 72, checklist: [], issues: [], recommendations: [] } }); mocks.call.mockResolvedValue({ unifiedCallReport: { source: 'call' } }); mocks.trainer.mockResolvedValue({ source: 'trainer' }); });
describe('report tests use the active production generation pipeline, without provider requests', () => {
  it('uses the actual call evaluator/bundle boundary with original/reviewed transcription alternatives', async () => {
    const fixture = REPORT_TEST_SCENARIOS.find((item) => item.id === 'call-asr')!;
    const result = await generateReportTestOutput(fixture, new AbortController().signal);
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.objectContaining({ earlyFail: false, transcriptionAlternatives: fixture.transcriptionAlternatives, dialogHistory: fixture.transcript.map(({ role, text }) => ({ role, content: text })) }));
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ totalScore: 72, evaluation: expect.objectContaining({ overall_score_0_100: 72 }), transcript: fixture.transcript }));
    expect(mocks.trainer).not.toHaveBeenCalled(); expect(result.report.source).toBe('call');
    // Gold assertions are only for the judge, never leaked into the report generator.
    expect(JSON.stringify(mocks.call.mock.calls)).not.toContain(fixture.expected[0]);
  });
  it('uses the actual trainer report function, not the call bundle or canned golden output', async () => {
    const fixture = REPORT_TEST_SCENARIOS.find((item) => item.id === 'trainer-asr')!;
    const result = await generateReportTestOutput(fixture, new AbortController().signal);
    expect(mocks.trainer).toHaveBeenCalledWith(expect.objectContaining({ totalScore: 72, transcript: fixture.transcript }));
    expect(mocks.evaluate.mock.calls[0][0].transcriptionAlternatives).toBeUndefined(); expect(mocks.call).not.toHaveBeenCalled(); expect(result.report.source).toBe('trainer');
  });
  it('stops before a second generation stage after cancellation, and propagates missing reports', async () => {
    const controller = new AbortController(); mocks.evaluate.mockImplementation(async () => { controller.abort(); return { evaluation: { overall_score_0_100: 72 } }; });
    await expect(generateReportTestOutput(REPORT_TEST_SCENARIOS[0], controller.signal)).rejects.toThrow(); expect(mocks.call).not.toHaveBeenCalled();
    mocks.evaluate.mockResolvedValue({ evaluation: { overall_score_0_100: 72 } }); mocks.call.mockResolvedValue({ unifiedCallReport: null });
    await expect(generateReportTestOutput(REPORT_TEST_SCENARIOS[0], new AbortController().signal)).rejects.toThrow('не вернул');
  });
});
