import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregateReportChecks, createReportAutoTesting, type ReportTestRun } from '../testing/reportAutoTesting';
import { REPORT_TEST_CHECKS, REPORT_TEST_GROUPS, REPORT_TEST_SCENARIOS, selectReportTestScenarios, type ReportFixture } from '../testing/reportTestCatalog';
import { parseReportAssessment, reportCheck, reportCodeChecks, reportReference, type ReportOutput } from '../testing/reportTestEvaluation';
import { compareReportRuns } from '../testing/reportTestHistory';
import { issueAutoTestingTicket, consumeAutoTestingTicket } from '../testing/autoTestingLive';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const request = (body: object = {}, owner = 'owner', params = {}, query = {}) => ({ body, authAccount: owner ? { id: owner } : undefined, params, query } as unknown as Request);
function response() { const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), end: vi.fn() }; res.status.mockReturnValue(res); return res; }
function output(fixture: ReportFixture): ReportOutput {
  return { transcript: structuredClone(fixture.transcript), evaluation: { overall_score_0_100: 80 }, timings: { evaluationMs: 100, reportMs: 200, totalMs: 300 }, report: {
    version: 'call-report-v1', source: fixture.source, totalScore: 80, verdict: 'Хорошо', summary: 'Тестовый отчёт', strengths: ['Ответил на вопрос'], weaknesses: [], keyFindings: [], recommendations: [],
    categories: ['Контакт', 'Диагностика', 'Продукт', 'Закрытие', 'Коммуникация'].map((name) => ({ name, score: 80, comment: 'Проверено' })) as ReportOutput['report']['categories'],
    dialog: fixture.transcript.map((turn) => ({ ...turn, mark: turn.role === 'manager' ? 'positive' : null, comment: turn.role === 'manager' ? 'Ответил' : null, betterExample: null })),
  } };
}
async function setup(overrides: Parameters<typeof createReportAutoTesting>[0] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'report-autotest-')); roots.push(root);
  const generate = vi.fn(async (fixture: ReportFixture) => output(fixture));
  const assess = vi.fn(async (fixture: ReportFixture) => fixture.checks.map((id) => reportCheck(id, 'pass', 'Контрольный вывод с моковым провайдером')));
  const api = createReportAutoTesting({ canRun: () => true, configuration: async () => ({ model: 'mock', fixtureVersion: '1' }), generate, assess, ...overrides }, root);
  const wait = async (run: ReportTestRun) => {
    for (let i = 0; i < 1000; i++) {
      const saved = JSON.parse(await fs.readFile(path.join(root, run.id, 'report.json'), 'utf8')) as ReportTestRun;
      if (saved.status !== 'running') { await new Promise((resolve) => setTimeout(resolve, 5)); return saved; }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Run did not finish');
  };
  return { root, api, generate: overrides.generate ?? generate, assess, wait };
}
describe('report checklist from PDF and built-in data', () => {
  it('includes all 29 numbered criteria in five groups, with both real report directions', () => {
    expect(REPORT_TEST_CHECKS).toHaveLength(29); expect(REPORT_TEST_GROUPS).toHaveLength(5);
    expect(REPORT_TEST_GROUPS.flatMap((group) => group.checks)).toEqual(REPORT_TEST_CHECKS.map(([id]) => id));
    expect(REPORT_TEST_SCENARIOS).toHaveLength(12);
    for (const [id] of REPORT_TEST_CHECKS) for (const source of ['call', 'trainer']) expect(REPORT_TEST_SCENARIOS.some((item) => item.source === source && item.checks.includes(id))).toBe(true);
    expect(selectReportTestScenarios({ checkIds: ['report-short-closing'] }).map((item) => item.id)).toEqual(['call-closing', 'trainer-closing']);
    for (const selection of [{ checkIds: [] }, { checkIds: ['typo'] }, { scenarioIds: ['x'] }, { checkIds: ['report-summary'], scenarioIds: ['call-asr'] }]) expect(() => selectReportTestScenarios(selection)).toThrow();
    expect(REPORT_TEST_SCENARIOS.find((item) => item.id === 'trainer-asr')?.transcript[1].text).toContain('за 2006 год');
  });
  it('requires report-field evidence, exact values and manager references, not just model claims', () => {
    const fixture = { ...REPORT_TEST_SCENARIOS[0], checks: ['report-summary' as const] }, result = output(fixture);
    const grade = (overrides = {}) => parseReportAssessment(fixture, result, { checks: [{ id: 'report-summary', status: 'pass', reason: 'Балл совпадает', evaluatedRole: 'manager', turnIndices: [1], references: [{ path: '/report/totalScore', value: 80 }], ...overrides }] })[0].status;
    expect(grade()).toBe('pass'); expect(grade({ evaluatedRole: 'ai_client' })).toBe('review'); expect(grade({ turnIndices: [0] })).toBe('review');
    expect(grade({ turnIndices: [1, 100] })).toBe('review');
    expect(grade({ references: [{ path: '/report/totalScore', value: 80 }, { path: '/report/invented', value: 'x' }] })).toBe('review');
    expect(grade({ references: [{ path: '/report/totalScore', value: 0 }] })).toBe('review'); expect(grade({ references: [{ path: '/report/invented', value: 'x' }] })).toBe('review');
    expect(grade({ references: [{ path: '/transcript/1/text', value: fixture.transcript[1].text }] })).toBe('review');
    expect(reportReference(result, '/report/__proto__/constructor')).toBeUndefined(); expect(reportReference(result, 'report.totalScore')).toBeUndefined();
  });
  it('detects missing marks/examples, positive marks with findings and conflicting examples', () => {
    const fixture = REPORT_TEST_SCENARIOS[0], result = output(fixture);
    result.report.dialog[1].comment = null;
    result.report.keyFindings = [{ problemTitle: 'Ошибка', quote: fixture.transcript[1].text, category: 'Контакт', importance: 'Важно', comment: 'Нет подтверждения', betterExample: 'Подтверждаю запись.' }];
    result.report.dialog[1].betterExample = 'Совсем иной правильный ответ.';
    let checks = reportCodeChecks(fixture, result);
    expect(checks.find((point) => point.id === 'report-all-turns')?.status).toBe('fail'); expect(checks.find((point) => point.id === 'report-mark-findings')?.status).toBe('fail'); expect(checks.find((point) => point.id === 'report-single-example')?.status).toBe('fail');
    result.report.dialog[1].mark = 'normal'; result.report.dialog[1].betterExample = null;
    checks = reportCodeChecks(fixture, result); expect(checks.find((point) => point.id === 'report-example-present')?.status).toBe('fail');
    result.report.totalScore = 7; expect(reportCodeChecks(fixture, result).find((point) => point.id === 'report-summary')?.status).toBe('fail');
  });
});
describe('report runner, persistence, scopes, isolation and comparisons (mock providers)', () => {
  it('stops on billing errors without running remaining cases or marking them green', async () => {
    const generate = vi.fn().mockRejectedValue(Object.assign(new Error('402 status code (no body)'), { status: 402 }));
    const { api, wait } = await setup({ generate });
    const run = await api.start(request()); await wait(run);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('failed'); expect(run.error).toContain('HTTP 402');
    expect(run.error).toContain('баланс');
    expect(run.cases[0].checks.every((point) => point.status === 'review')).toBe(true);
    expect(run.cases.slice(1).every((item) => item.status === 'pending' && item.checks.every((point) => point.status === 'not_run'))).toBe(true);
    expect(run.checklist.some((point) => point.status === 'pass')).toBe(false);
  });
  it('saves the full suite with IDs, actual inputs/outputs, no false pass for audio/UI', async () => {
    const { api, root, wait, generate } = await setup(); const run = await api.start(request()); await wait(run);
    expect(run.status).toBe('completed'); expect(run.id).toMatch(/^[a-f0-9-]{36}$/); expect(generate).toHaveBeenCalledTimes(12);
    expect(run.checklist).toHaveLength(29); expect(run.cases[0].output?.report.source).toBe('call'); expect(run.cases[6].output?.report.source).toBe('trainer');
    for (const id of ['report-transcription', 'report-entities', 'report-roles', 'report-tooltip', 'report-regression']) expect(run.checklist.find((point) => point.id === id)?.status).toBe('review');
    expect((await createReportAutoTesting({}, root).load(run.id, 'owner'))?.cases[0].fixture.expected.length).toBeGreaterThan(0);
    expect(await api.load(run.id, 'other-owner')).toBeNull(); expect(await api.load('../escaped', 'owner')).toBeNull();
  });
  it('runs only the selected criterion in its relevant call and trainer cases, retaining parent snapshots', async () => {
    const { api, wait, generate, assess, root } = await setup();
    const first = await api.start(request({ checkIds: ['report-short-closing'] })); await wait(first);
    const prior = await fs.readFile(path.join(root, first.id, 'report.json'), 'utf8');
    const second = await api.start(request({ checkIds: ['report-short-closing'], referenceRunId: first.id })); await wait(second);
    expect(second.id).not.toBe(first.id); expect(second.parentRunId).toBe(first.id); expect(second.cases.map((item) => item.id)).toEqual(['call-closing', 'trainer-closing']);
    expect(generate).toHaveBeenCalledTimes(4); expect(assess.mock.calls[0][0].checks).toEqual(['report-short-closing']);
    expect(second.checklist.find((point) => point.id === 'report-short-closing')?.status).toBe('pass'); expect(second.checklist.find((point) => point.id === 'report-summary')?.status).toBe('not_run');
    expect(await fs.readFile(path.join(root, first.id, 'report.json'), 'utf8')).toBe(prior);
    expect(compareReportRuns(first, second).rows.find((row) => row.id === 'report-short-closing')?.comparable).toBe(true);
  });
  it('never calls a failed or incomplete generation a pass, and continues other scenarios', async () => {
    const { api, wait } = await setup({ generate: async () => { throw new Error('Provider offline'); } });
    const run = await api.start(request({ checkIds: ['report-short-closing'] })); await wait(run);
    expect(run.status).toBe('failed'); expect(run.cases.every((item) => item.status === 'failed')).toBe(true); expect(run.checklist.some((point) => point.status === 'pass')).toBe(false);
    const { api: judgeApi, wait: judgeWait } = await setup({ assess: async () => { throw new Error('Judge offline'); } });
    const review = await judgeApi.start(request({ checkIds: ['report-short-closing'] })); await judgeWait(review);
    expect(review.checklist.find((point) => point.id === 'report-short-closing')?.status).toBe('review');
  });
  it('does not greenwash partial coverage or label unlike conditions as fixed', async () => {
    const { api, wait } = await setup(); const run = await api.start(request({ scenarioIds: ['call-closing'] })); await wait(run);
    expect(run.checklist.find((point) => point.id === 'report-short-closing')?.status).toBe('review');
    const before = structuredClone(run), after = structuredClone(run); before.configurationHash = 'old'; after.configurationHash = 'new';
    before.checklist[0].status = 'fail'; after.checklist[0].status = 'pass';
    expect(compareReportRuns(before, after).warnings).toHaveLength(1); expect(compareReportRuns(before, after).rows[0].change).toBe('changed');
    expect(aggregateReportChecks({ cases: [] }).every((point) => point.status === 'not_run')).toBe(true);
  });
  it('cancels between requests and refuses concurrent starts without a second paid operation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api, wait, generate } = await setup({ generate: vi.fn(async (fixture) => { await gate; return output(fixture); }) });
    const run = await api.start(request({ checkIds: ['report-short-closing'] }));
    await expect(api.start(request())).rejects.toThrow('уже выполняется');
    const res = response(); await api.handle(request({}, 'owner', { runId: run.id }), res as unknown as Response, 'cancel'); release(); await wait(run);
    expect(run.status).toBe('cancelled'); expect(run.cases[1].status).toBe('pending'); expect(vi.mocked(generate).mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('enforces owner access for history, reading, comparing, tickets and cancelling', async () => {
    const { api, wait } = await setup(); const run = await api.start(request({ checkIds: ['report-short-closing'] })); await wait(run);
    for (const action of ['get', 'compare', 'ticket', 'cancel']) { const res = response(); await api.handle(request({}, 'other-owner', { runId: run.id }, { against: run.id }), res as unknown as Response, action); expect(res.status).toHaveBeenCalledWith(404); }
    const history = response(); await api.handle(request({}, 'other-owner'), history as unknown as Response, 'history'); expect(history.json.mock.calls[0][0].items).toEqual([]);
    const own = response(); await api.handle(request(), own as unknown as Response, 'history'); expect(own.json.mock.calls[0][0].checks).toHaveLength(29); expect(own.json.mock.calls[0][0].items[0].timing.medianMs).toBe(300);
    const unauth = response(); await api.handle(request({}, ''), unauth as unknown as Response, 'start'); expect(unauth.status).toHaveBeenCalledWith(401);
    await expect(api.start(request({ referenceRunId: run.id }, 'other-owner'))).rejects.toThrow('не найдена');
    const token = issueAutoTestingTicket(run.id, 'owner', 'report'); expect(consumeAutoTestingTicket(token, run.id, 'trainer')).toBeNull(); expect(consumeAutoTestingTicket(token, run.id, 'report')).toBeNull();
    const valid = issueAutoTestingTicket(run.id, 'owner', 'report'); expect(consumeAutoTestingTicket(valid, run.id, 'report')?.ownerId).toBe('owner');
  });
});
