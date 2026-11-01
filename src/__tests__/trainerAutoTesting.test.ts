import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRAINER_TEST_CHECKS, TRAINER_TEST_GROUPS, TRAINER_TEST_SCENARIOS, selectTrainerTestScenarios, type TrainerTestScenario } from '../testing/trainerTestCatalog';
import { aggregateTrainerChecks, compareTrainerRuns, createTrainerAutoTesting, parseTrainerAssessment, trainerTransportChecks, type TrainerTestDependencies, type TrainerTestRun, type TrainerTestSession, type TrainerTestTurn } from '../testing/trainerAutoTesting';
import { TrainerVoiceTurns } from '../trainer/trainerVoiceTurns';
import { trainerJudgeTranscript, TRAINER_JUDGE_INSTRUCTIONS } from '../testing/trainerAutoTesting';
import { TRAINER_BUILTIN_SUITE_ID } from '../testing/trainerBuiltinFixtures';

vi.mock('../trainer/trainerRecording', () => ({ renderTrainerRecording: vi.fn(async () => ({ durationSec: 1, turnCount: 2 })) }));
const directories: string[] = [];
afterEach(async () => { for (const root of directories.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const request = (body: object = {}, owner = 'owner', params = {}, query = {}) => ({ body, authAccount: owner ? { id: owner } : undefined, params, query } as unknown as Request);
function response() { const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), type: vi.fn(), sendFile: vi.fn(), end: vi.fn() }; res.status.mockReturnValue(res); res.type.mockReturnValue(res); return res; }
async function wait(run: TrainerTestRun) {
  // The in-memory status changes before the final atomic disk save and lock release.
  // Wait for the persisted terminal snapshot before starting another run or removing fixtures.
  const filename = path.join(directories.at(-1)!, run.id, 'report.json');
  for (let i = 0; i < 1000; i++) {
    if (run.status !== 'running') {
      const saved = JSON.parse(await fs.readFile(filename, 'utf8')) as TrainerTestRun;
      if (saved.status !== 'running') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Test run did not persist its terminal state');
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trainer-autotest-')); directories.push(root);
  const closed = vi.fn();
  const context = { scenario: { questions: [{ text: 'Какая цена?' }], objections: [] }, clientProfile: { name: 'Скептик' } };
  const deps: TrainerTestDependencies = {
    canRun: () => true,
    loadSource: vi.fn(async (_req, id) => { if (id === 'denied') throw new Error('Нет доступа к тренировке'); return { id, name: 'Сценарий · Скептик', companyId: 'company', context: structuredClone(context), female: id === 'female' }; }),
    listSources: vi.fn(async () => []),
    synthesize: vi.fn(async (text) => ({ audioBase64: Buffer.from(text.padEnd(600, ' ')).toString('base64'), mimeType: 'audio/wav' })),
    adaptiveReply: vi.fn(async () => 'Автомобиль в наличии, цена по объявлению, подробности уточню.'),
    assess: vi.fn(async (scenario: TrainerTestScenario) => scenario.checks.filter((id) => !['trainer-voice', 'trainer-audio', 'trainer-delivery', 'trainer-pronunciation'].includes(id)).map((id) => ({ id, title: id, status: 'pass' as const, evidence: ['[1] AI: Проверяемый ответ'] }))),
    createSession: vi.fn(async (_source, id) => {
      const transcript: TrainerTestTurn[] = [];
      const voices: ReturnType<TrainerTestSession['snapshot']>['voices'] = [];
      const tasks = new Set<string>();
      const voicesQueue = new TrainerVoiceTurns(tasks, 0);
      function answer(text: string) { const audio = Buffer.alloc(1024).toString('base64'); transcript.push({ role: 'client', text, audioBase64: audio, audioMimeType: 'audio/wav', timings: { totalMs: 200, ttsMs: 100, textMs: 80 } }); voices.push({ provider: 'elevenlabs', voiceId: 'one-voice', spokenText: text }); }
      return { initialize: async () => { answer('Здравствуйте, какая цена?'); }, voice: async ({ audioBase64 }: { audioBase64: string; mimeType: string }) => {
        return voicesQueue.submit(id, audioBase64, async (audio) => Buffer.from(audio, 'base64').toString().trim(), async (texts, control) => {
          control.commit(); transcript.push({ role: 'manager', text: texts.join('\n'), audioBase64, audioMimeType: 'audio/wav' });
          answer(texts.some((text) => text.includes('Поправлюсь')) ? 'Итоговая цена — 6 405 000 рублей.' : `Ответ номер ${voices.length}`); return { endConversation: false };
        });
      }, snapshot: () => ({ transcript, voices }), close: closed };
    }),
  };
  return { root, deps, api: createTrainerAutoTesting(deps, root), context, closed };
}

describe('trainer checklist and evidence (no billed providers)', () => {
  it('covers exactly the agreed twenty criteria in four groups and exercises each criterion', () => {
    expect(TRAINER_TEST_CHECKS).toHaveLength(20); expect(TRAINER_TEST_GROUPS).toHaveLength(4);
    expect(TRAINER_TEST_GROUPS.flatMap((group) => group.checks)).toEqual(TRAINER_TEST_CHECKS.map(([id]) => id));
    for (const [id] of TRAINER_TEST_CHECKS) expect(TRAINER_TEST_SCENARIOS.some((scenario) => scenario.checks.includes(id))).toBe(true);
    expect(selectTrainerTestScenarios({ checkIds: ['trainer-correction'] }).map((scenario) => scenario.id)).toEqual(['trainer-correction']);
    for (const selection of [{ checkIds: [] }, { checkIds: ['typo'] }, { scenarioIds: ['nope'] }, { checkIds: ['trainer-ending'], scenarioIds: ['trainer-script'] }]) expect(() => selectTrainerTestScenarios(selection)).toThrow();
  });
  it('requires real AI evidence and the correct evaluated role', () => {
    const turns: TrainerTestTurn[] = [{ role: 'manager', text: 'Как вас зовут?' }, { role: 'client', text: 'Меня зовут Мария.' }];
    const evaluate = (turnIndices: number[], evaluatedRole = 'ai_client') => parseTrainerAssessment(['trainer-identity'], turns, { checks: [{ id: 'trainer-identity', status: 'pass', reason: 'Имя сохранено', evaluatedRole, turnIndices }] })[0].status;
    expect(evaluate([1])).toBe('pass'); expect(evaluate([0])).toBe('review'); expect(evaluate([100])).toBe('review'); expect(evaluate([1], 'manager')).toBe('review');
    expect(evaluate([1, 100])).toBe('review');
    expect(trainerJudgeTranscript(turns)).toEqual([{ turnIndex: 0, speaker: 'manager_fixture', role: 'manager', text: turns[0].text }, { turnIndex: 1, speaker: 'ai_client', role: 'client', text: turns[1].text }]);
    expect(TRAINER_JUDGE_INSTRUCTIONS).toContain('индекс с НУЛЯ'); expect(TRAINER_JUDGE_INSTRUCTIONS).toContain('Esteo → Steo');
  });
  it('detects actual voice switching, missing audio, text truncation and dropped corrections', () => {
    const scenario = TRAINER_TEST_SCENARIOS[0];
    const base = { transcript: [{ role: 'client' as const, text: 'Длинная реплика, которую полностью должны были озвучить, а не обрезать.', audioBase64: Buffer.alloc(1024).toString('base64') }], voices: [{ provider: 'elevenlabs', voiceId: 'voice1', spokenText: 'Длинная' }, { provider: 'openai', voiceId: 'nova', spokenText: 'Другая' }] };
    const result = trainerTransportChecks(scenario, base, []);
    expect(result.find((point) => point.id === 'trainer-voice')?.status).toBe('fail'); expect(result.find((point) => point.id === 'trainer-audio')?.status).toBe('fail');
    const correction = trainerTransportChecks(TRAINER_TEST_SCENARIOS.find((item) => item.id === 'trainer-correction')!, base, [{ text: 'Исправление', accepted: false, error: '409' }]);
    expect(correction.find((point) => point.id === 'trainer-correction')?.status).toBe('fail');
  });
  it('never certifies acoustic qualities using text alone', () => {
    const scenario = TRAINER_TEST_SCENARIOS[2];
    const result = trainerTransportChecks(scenario, { transcript: [{ role: 'client', text: 'Шесть миллионов четыреста пять тысяч.' }], voices: [] }, []);
    expect(result.filter((point) => ['trainer-delivery', 'trainer-pronunciation'].includes(point.id)).every((point) => point.status === 'review')).toBe(true);
  });
  it('does not green incomplete or partially covered requirements, and surfaces failures from any case', () => {
    const scenario = TRAINER_TEST_SCENARIOS[0];
    const cases: TrainerTestRun['cases'] = [{ id: scenario.id, title: scenario.title, status: 'completed', checks: [{ id: 'trainer-voice', title: '', status: 'pass', evidence: [] }] }];
    expect(aggregateTrainerChecks({ cases }).find((point) => point.id === 'trainer-voice')?.status).toBe('review');
    cases.push({ id: 'other-case', title: '', status: 'failed', checks: [{ id: 'trainer-ending', title: '', status: 'fail', evidence: ['Ошибка'] }] });
    expect(aggregateTrainerChecks({ cases }).find((point) => point.id === 'trainer-ending')?.status).toBe('fail');
  });
});

describe('isolated trainer test runner, persistence and authorization', () => {
  it('runs without existing trainings or manual female selection using built-in profiles automatically', async () => {
    const { api, deps } = await setup();
    const run = await api.start(request({ scenarioIds: ['trainer-dialogue', 'trainer-female', 'trainer-context'] }));
    await wait(run);
    expect(deps.loadSource).not.toHaveBeenCalled(); expect(deps.listSources).not.toHaveBeenCalled();
    expect(run.sourceId).toBe(TRAINER_BUILTIN_SUITE_ID); expect(run.configuration.fixtureVersion).toBeDefined();
    const profiles = vi.mocked(deps.createSession).mock.calls.map(([source]) => (source.context.clientProfile as { name: string }).name);
    expect(profiles).toEqual(['Скептик', 'Сомневающаяся', 'Болтун']);
    expect(run.cases.every((item) => item.status === 'completed')).toBe(true);
    expect((run.configuration.femaleSource?.context.clientProfile as { openaiVoiceId: string }).openaiVoiceId).toBe('nova');
  });
  it('saves a UUID before starting, uses voice inputs, persists metrics/audio, and restores after restart', async () => {
    const { api, root, deps, context, closed } = await setup();
    const sourceBefore = JSON.stringify(context);
    const run = await api.start(request({ sourceId: 'source', scenarioIds: ['trainer-dialogue'] }));
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/); expect(JSON.parse(await fs.readFile(path.join(root, run.id, 'report.json'), 'utf8')).id).toBe(run.id);
    await wait(run); expect(run.status).toBe('completed'); expect(deps.synthesize).toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce();
    const fresh = createTrainerAutoTesting(deps, root);
    const saved = await fresh.load(run.id, 'owner'); expect(saved?.id).toBe(run.id); expect(saved?.cases[0].audioFile).toBe('trainer-dialogue.mp3');
    expect(saved?.cases[0].session?.transcript.at(-1)?.metrics?.totalMs).toBe(200);
    expect(JSON.stringify(saved)).not.toContain('audioBase64'); expect(JSON.stringify(context)).toBe(sourceBefore);
    expect(await fresh.load(run.id, 'another-owner')).toBeNull(); expect(await fresh.load('../report', 'owner')).toBeNull();
  });
  it('accepts two separate corrections through the shared coordinator and keeps one client reply', async () => {
    const { api } = await setup(); const run = await api.start(request({ sourceId: 'source', checkIds: ['trainer-correction'] })); await wait(run);
    expect(run.cases[0].inputs?.slice(0, 2).map((item) => item.accepted)).toEqual([true, true]);
    expect(run.cases[0].correctionReplyCount).toBe(1);
    expect(run.cases[0].session?.transcript[1].text).toContain('Поправлюсь');
    expect(run.checklist.find((point) => point.id === 'trainer-correction')?.status).toBe('pass');
  });
  it('does not fabricate a female persona or voice when no female source was supplied', async () => {
    const { api, deps } = await setup(); const run = await api.start(request({ sourceId: 'source', scenarioIds: ['trainer-female'] })); await wait(run);
    expect(deps.createSession).not.toHaveBeenCalled(); expect(run.cases[0].checks.every((point) => point.status === 'review')).toBe(true);
  });
  it('uses the actual female source and preserves its context unchanged', async () => {
    const { api, deps } = await setup(); const run = await api.start(request({ sourceId: 'source', femaleSourceId: 'female', scenarioIds: ['trainer-female'] })); await wait(run);
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'female', female: true }), expect.any(String), expect.any(AbortSignal));
  });
  it('protects source access, report ownership, and unavailable APIs', async () => {
    const { api, deps } = await setup();
    await expect(api.start(request({ sourceId: 'source' }, ''))).rejects.toThrow('авторизация');
    await expect(api.start(request({ sourceId: 'denied' }))).rejects.toThrow('Нет доступа'); expect(deps.createSession).not.toHaveBeenCalled();
    deps.canRun = () => false; await expect(api.start(request({ sourceId: 'source' }))).rejects.toThrow('не настроены');
    const res = response(); await api.handle(request({}, ''), res as unknown as Response, 'history'); expect(res.status).toHaveBeenCalledWith(401);
  });
  it('keeps old results immutable and links targeted reruns to the parent', async () => {
    const { api, root } = await setup(); const first = await api.start(request({ sourceId: 'source', scenarioIds: ['trainer-dialogue'] })); await wait(first);
    const before = await fs.readFile(path.join(root, first.id, 'report.json'), 'utf8');
    const second = await api.start(request({ sourceId: 'source', referenceRunId: first.id, scenarioIds: ['trainer-dialogue'] })); await wait(second);
    expect(second.id).not.toBe(first.id); expect(second.parentRunId).toBe(first.id); expect(await fs.readFile(path.join(root, first.id, 'report.json'), 'utf8')).toBe(before);
    second.configurationHash = 'changed'; expect(compareTrainerRuns(first, second).rows.every((row) => !row.comparable)).toBe(true);
  });
  it('cancels the last active scenario without reporting an ordinary failure', async () => {
    const { api, deps, closed } = await setup();
    let resume!: () => void;
    const original = deps.createSession;
    deps.createSession = async (...args) => { const session = await original(...args); return { ...session, initialize: async () => { await new Promise<void>((resolve) => { resume = resolve; }); await session.initialize(); } }; };
    const run = await api.start(request({ sourceId: 'source', scenarioIds: ['trainer-dialogue'] }));
    while (!resume) await new Promise((resolve) => setTimeout(resolve, 1));
    const res = response(); await api.handle(request({}, 'owner', { runId: run.id }), res as unknown as Response, 'cancel'); resume(); await wait(run);
    expect(run.status).toBe('cancelled'); expect(closed).toHaveBeenCalled();
  });
});
