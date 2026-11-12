import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), persist: vi.fn(), plan: vi.fn(), snapshot: vi.fn(), jobPersist: vi.fn(), error: vi.fn(), session: null as any, job: null as any }));
vi.mock('../db', () => {
  const db = {
    voiceCallSession: {
      findUnique: async () => ({ ...mocks.session }),
      updateMany: mocks.persist,
    },
    callPlanCall: { updateMany: mocks.plan, findUnique: mocks.snapshot },
    callAnalysisJob: {
      findUnique: async () => mocks.job,
      upsert: async ({ create, update }: any) => { mocks.job = mocks.job ? { ...mocks.job, ...update } : create; return mocks.job; },
      updateMany: mocks.jobPersist,
    },
    $transaction: async (task: any) => task(db),
  };
  return { prisma: db };
});
vi.mock('../voice/unifiedCallReport', () => ({ generateUnifiedCallReport: mocks.generate }));
vi.mock('../economics/costContext', () => ({ withCostContext: (_: unknown, task: () => unknown) => task() }));
vi.mock('../monitoring/reportError', () => ({ reportError: mocks.error }));
import { regenerateVoiceReport } from '../audits/regenerateVoiceReport';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { callId: 'repair-call', endedAt: new Date(), totalScore: 52, outcome: 'disconnected',
    transcriptJson: JSON.stringify([{ role: 'manager', text: 'Здравствуйте, слушаю.' }, { role: 'client', text: 'Спасибо.' }]),
    evaluationJson: JSON.stringify({ overall_score_0_100: 52, plan_criteria: { percent: 71 }, unified_call_report: null }), caseContextJson: '{}', failureReason: null };
  mocks.job = { callId: 'repair-call', status: 'done', runId: 'old' };
  mocks.generate.mockResolvedValue({ version: 'call-report-v1', totalScore: 52, keyFindings: [] });
  mocks.persist.mockImplementation(async ({ where, data }: any) => {
    if (where.evaluationJson !== mocks.session.evaluationJson || where.transcriptJson !== mocks.session.transcriptJson) return { count: 0 };
    Object.assign(mocks.session, data); return { count: 1 };
  });
  mocks.plan.mockResolvedValue({ count: 0 });
  mocks.snapshot.mockResolvedValue(null);
  mocks.jobPersist.mockImplementation(async ({ data }: any) => { Object.assign(mocks.job, data); return { count: 1 }; });
});
describe('report-only voice repair', () => {
  it('1147: restores frozen scenario and assessment facts when the session stores only plan IDs', async () => {
    const prompt = 'Контекст легенды клиента. '.repeat(700);
    mocks.snapshot.mockResolvedValue({ promptText: prompt, criteriaJson: JSON.stringify([{ expectedAnswer: 'ТО, диагностика и шиномонтаж в МореАвто Сервис.' }]) });
    mocks.session.caseContextJson = JSON.stringify({ planId: 'plan', scriptId: 'original-script' });
    await regenerateVoiceReport('repair-call');
    const context = mocks.generate.mock.calls[0][0].scenarioContext;
    expect(context.slice(0, 10_000)).toContain('ТО, диагностика и шиномонтаж');
    expect(JSON.parse(context).scenario).toBe(prompt.trim());
    expect(mocks.snapshot).toHaveBeenCalledWith({ where: { callId: 'repair-call' }, select: { promptText: true, criteriaJson: true } });
    expect(mocks.session.totalScore).toBe(52);
  });
  it('uses a self-contained demo snapshot without consulting a mutable plan', async () => {
    mocks.session.caseContextJson = JSON.stringify({ prompt: 'Исходная легенда.', criteria: [{ expectedAnswer: 'Исходные условия.' }] });
    await regenerateVoiceReport('repair-call');
    expect(JSON.parse(mocks.generate.mock.calls[0][0].scenarioContext)).toEqual({ assessmentCriteria: [{ expectedAnswer: 'Исходные условия.' }], scenario: 'Исходная легенда.' });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('preserves the original score and checklist while saving the missing report', async () => {
    await regenerateVoiceReport('repair-call');
    expect(mocks.session.totalScore).toBe(52);
    expect(JSON.parse(mocks.session.evaluationJson)).toMatchObject({ overall_score_0_100: 52, plan_criteria: { percent: 71 }, unified_call_report: { totalScore: 52 } });
    expect(mocks.session.failureReason).toBeNull();
    expect(mocks.job.status).toBe('done');
  });
  it('persists generation errors and fails the durable job without deleting the assessment', async () => {
    const before = mocks.session.evaluationJson;
    mocks.generate.mockRejectedValue(new Error('quality check rejected'));
    await expect(regenerateVoiceReport('repair-call')).rejects.toThrow('quality check rejected');
    expect(mocks.session.evaluationJson).toBe(before);
    expect(mocks.session.failureReason).toBe('REPORT_GENERATION_FAILED: quality check rejected');
    expect(mocks.job.status).toBe('failed');
    expect(mocks.error).toHaveBeenCalledOnce();
  });
  it('does not replace data changed by another worker during generation', async () => {
    mocks.generate.mockImplementation(async () => { mocks.session.evaluationJson = '{"newer":true}'; return { totalScore: 52 }; });
    await expect(regenerateVoiceReport('repair-call')).rejects.toThrow('CALL_CHANGED_DURING_REPORT_REPAIR');
    expect(mocks.session.evaluationJson).toBe('{"newer":true}');
    expect(mocks.plan).not.toHaveBeenCalled();
  });
  it('does not duplicate paid work when another processing job is active', async () => {
    mocks.job.status = 'processing';
    await expect(regenerateVoiceReport('repair-call')).rejects.toThrow('CALL_ANALYSIS_ALREADY_RUNNING');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('returns an existing report without starting another generation', async () => {
    mocks.session.evaluationJson = '{"unified_call_report":{"totalScore":52}}';
    expect(await regenerateVoiceReport('repair-call')).toEqual({ totalScore: 52 });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
