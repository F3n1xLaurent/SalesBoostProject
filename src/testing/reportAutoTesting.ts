import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config } from '../config';
import { prisma } from '../db';
import { withCostContext } from '../economics/costContext';
import { reportReasoningProfile } from '../lib/chatReasoning';
import { getCallReportProblemCatalog, withReportProblemVariants } from '../voice/problemCatalog';
import { validRegressionId } from '../voice/realtimeRegressionHistory';
import { issueAutoTestingTicket, publishAutoTestingRun } from './autoTestingLive';
import { REPORT_BUILTIN_SUITE_ID, REPORT_FIXTURE_VERSION, REPORT_TEST_CHECKS, REPORT_TEST_SCENARIOS, selectReportTestScenarios, type ReportFixture } from './reportTestCatalog';
import { assessReportOutput, generateReportTestOutput, reportCheck, reportCodeChecks, type ReportCheck, type ReportOutput } from './reportTestEvaluation';
import { compareReportRuns, reportRunTiming } from './reportTestHistory';
import { REPORT_EXAMPLE_ACCEPTANCE_RULES, REPORT_QUALITY_RULES } from '../voice/reportQualityRules';

export const REPORT_TEST_ROOT = path.resolve('storage/report-regression');
const VERSION = 'report-2026-11-01.1';
const blocksProvider = (error: unknown) => [401, 402, 403, 404].includes(Number((error as { status?: unknown })?.status));
export type ReportTestCase = {
  id: string; title: string; status: 'pending' | 'running' | 'completed' | 'failed';
  phase?: 'dialogue' | 'assessing' | 'completed' | 'failed'; checks: ReportCheck[]; error?: string;
  fixture: ReportFixture; output?: ReportOutput; assessment?: ReportCheck[];
};
export type ReportTestRun = {
  id: string; ownerId: string; executorPid: number; target: 'report'; planId: string; planName: string; model: string;
  createdAt: string; endedAt?: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; progress: string; error?: string;
  parentRunId?: string; evaluatorVersion: string; configurationHash: string; configuration: Record<string, unknown>;
  checklist: ReportCheck[]; cases: ReportTestCase[];
};
type Dependencies = { generate: typeof generateReportTestOutput; assess: typeof assessReportOutput; configuration: () => Promise<Record<string, unknown>>; canRun: () => boolean };
const worst = (items: ReportCheck[]): ReportCheck['status'] => items.some((item) => item.status === 'fail') ? 'fail' : !items.length || items.some((item) => item.status !== 'pass') ? 'review' : 'pass';
export function aggregateReportChecks(run: Pick<ReportTestRun, 'cases'>): ReportCheck[] {
  return REPORT_TEST_CHECKS.map(([id]) => {
    const required = REPORT_TEST_SCENARIOS.filter((item) => item.checks.includes(id));
    const cases = run.cases.filter((item) => required.some((scenario) => scenario.id === item.id) && item.checks.some((point) => point.id === id));
    const points = cases.flatMap((item) => item.checks.filter((point) => point.id === id));
    const status = points.some((item) => item.status === 'fail') ? 'fail' : !cases.length || cases.every((item) => item.status === 'pending') ? 'not_run'
      : cases.length < required.length || cases.some((item) => item.status !== 'completed') ? 'review' : worst(points);
    return reportCheck(id, status, ...(cases.length && cases.length < required.length ? [`Частичное покрытие: ${cases.length}/${required.length} сценариев; оба источника не подтверждены полностью.`] : []), ...new Set(cases.flatMap((item) => item.checks.filter((point) => point.id === id).flatMap((point) => point.evidence.map((text) => `${item.title}: ${text}`)))));
  });
}

export function createReportAutoTesting(overrides: Partial<Dependencies> = {}, root = REPORT_TEST_ROOT) {
  const deps: Dependencies = { generate: generateReportTestOutput, assess: assessReportOutput, canRun: () => Boolean(config.openaiApiKey || config.proxyApiKey), configuration: async () => ({
    model: config.openaiChatModel, reasoningEffort: config.openaiReasoningEffort ?? 'provider_default', evaluatorVersion: VERSION, fixtureVersion: REPORT_FIXTURE_VERSION,
    ...reportReasoningProfile(),
    fixtureHash: createHash('sha256').update(JSON.stringify(REPORT_TEST_SCENARIOS)).digest('hex'),
    reportRulesHash: createHash('sha256').update(`${REPORT_QUALITY_RULES}\n${REPORT_EXAMPLE_ACCEPTANCE_RULES}`).digest('hex'),
    problemCatalog: withReportProblemVariants(await getCallReportProblemCatalog(prisma)),
    pipelines: ['evaluateSessionV2 → generateCallAnalyticsBundle', 'evaluateSessionV2 → generateUnifiedTrainerReport'],
  }), ...overrides };
  const memory = new Map<string, ReportTestRun>(), aborters = new Map<string, AbortController>();
  async function save(run: ReportTestRun) {
    run.checklist = aggregateReportChecks(run);
    await fs.mkdir(path.join(root, run.id), { recursive: true });
    await fs.writeFile(path.join(root, run.id, 'report.json.tmp'), JSON.stringify(run, null, 2));
    await fs.rename(path.join(root, run.id, 'report.json.tmp'), path.join(root, run.id, 'report.json'));
    publishAutoTestingRun(run);
  }
  async function load(id: string, ownerId: string): Promise<ReportTestRun | null> {
    if (!validRegressionId(id)) return null;
    try {
      const run = memory.get(id) ?? JSON.parse(await fs.readFile(path.join(root, id, 'report.json'), 'utf8')) as ReportTestRun;
      if (run.id !== id || run.ownerId !== ownerId || run.target !== 'report' || !Array.isArray(run.cases) || !Array.isArray(run.checklist)) return null;
      if (run.status === 'running' && !aborters.has(id)) {
        if (run.executorPid === process.pid) { run.status = 'failed'; run.error = 'Исполнитель автотеста больше не активен.'; }
        else try { process.kill(run.executorPid, 0); } catch { run.status = 'failed'; run.error = 'Процесс автотеста завершился до сохранения результата.'; }
      }
      return run;
    } catch { return null; }
  }
  async function execute(run: ReportTestRun, item: ReportTestCase, parent: ReportTestRun | null, signal: AbortSignal) {
    const fixture = item.fixture;
    try {
      signal.throwIfAborted(); item.status = 'running'; item.phase = 'dialogue';
      run.progress = `${item.title} · оценка диалога и генерация отчёта`; await save(run);
      item.output = await deps.generate(fixture, signal); signal.throwIfAborted();
      item.phase = 'assessing'; run.progress = `${item.title} · сверка с чеклистом`; await save(run);
      const code = reportCodeChecks(fixture, item.output);
      const semanticIds = fixture.checks.filter((id) => !['report-transcription', 'report-roles', 'report-tooltip', 'report-regression', 'report-all-turns', 'report-example-present'].includes(id));
      try { item.assessment = semanticIds.length ? await deps.assess({ ...fixture, checks: semanticIds }, item.output, signal) : []; }
      catch (error) {
        if (blocksProvider(error)) throw error;
        signal.throwIfAborted(); item.assessment = semanticIds.map((id) => reportCheck(id, 'review', `Оценщик недоступен: ${error instanceof Error ? error.message : String(error)}`));
      }
      signal.throwIfAborted();
      item.checks = fixture.checks.map((id) => {
        const results = [...code, ...item.assessment!].filter((point) => point.id === id);
        if (['report-transcription', 'report-entities', 'report-roles'].includes(id)) {
          return reportCheck(id, results.some((point) => point.status === 'fail') ? 'fail' : 'review', ...results.flatMap((point) => point.evidence), 'Вход — текстовый эталон, не распознанная запись. Звуковая точность ASR/разделение говорящих требуют аудиопроверки; текстовая часть оценена отдельно.');
        }
        if (id === 'report-tooltip') return reportCheck(id, 'review', 'Проверьте (i) в обычном отчёте: наведение на десктопе и нажатие на мобильном. Серверный прогон не открывает браузер.');
        if (id === 'report-regression') {
          const before = parent?.cases.find((entry) => entry.id === item.id);
          return reportCheck(id, 'review', `Встроенный SAL-кейс ${item.id}, версия ${REPORT_FIXTURE_VERSION}; исходные данные и результат сохраняются с ID ${run.id}.`, before ? `Предыдущий запуск: ${parent!.id}; сравнение доступно. Само наличие архива не доказывает исправление всех ошибок — сверьте конкретные пункты.` : 'Первый запуск без базового результата. После исправления повторите кейс и сравните.');
        }
        return reportCheck(id, worst(results), ...results.flatMap((point) => point.evidence), ...(!results.length ? ['Недостаточно проверяемых свидетельств.'] : []));
      });
      item.status = 'completed'; item.phase = 'completed';
    } catch (error) {
      item.status = 'failed'; item.phase = 'failed'; item.error = error instanceof Error ? error.message : String(error);
      item.checks = fixture.checks.map((id) => reportCheck(id, 'review', `${signal.aborted ? 'Остановлено' : 'Не удалось проверить'}: ${item.error}`));
      if (blocksProvider(error)) throw error;
    }
  }
  async function start(req: Request): Promise<ReportTestRun> {
    if (!req.authAccount) throw new Error('Требуется авторизация.');
    if (!deps.canRun()) throw new Error('Для автотеста отчётов не настроен API генерации.');
    if (aborters.size) throw new Error('Автотест отчётов уже выполняется.');
    const selected = selectReportTestScenarios(req.body ?? {});
    const parent = req.body?.referenceRunId ? await load(String(req.body.referenceRunId), req.authAccount.id) : null;
    if (req.body?.referenceRunId && !parent) throw new Error('Исходная проверка отчётов не найдена.');
    const configuration = await deps.configuration();
    if (aborters.size) throw new Error('Автотест отчётов уже выполняется.');
    const run: ReportTestRun = { id: randomUUID(), ownerId: req.authAccount.id, executorPid: process.pid, target: 'report', planId: REPORT_BUILTIN_SUITE_ID,
      planName: 'Отчёты звонков и тренажёра · встроенный набор', model: config.openaiChatModel, createdAt: new Date().toISOString(), status: 'running', progress: 'Подготовка проверки отчётов', parentRunId: parent?.id,
      evaluatorVersion: VERSION, configuration, configurationHash: createHash('sha256').update(JSON.stringify(configuration)).digest('hex'), checklist: [],
      cases: selected.map((fixture) => { const data = structuredClone({ ...fixture, checks: req.body?.checkIds ? fixture.checks.filter((id) => req.body.checkIds.includes(id)) : fixture.checks }); return { id: data.id, title: data.title, fixture: data, status: 'pending', checks: data.checks.map((id) => reportCheck(id, 'not_run')) }; }),
    };
    const controller = new AbortController(); aborters.set(run.id, controller); memory.set(run.id, run);
    try { await save(run); } catch (error) { aborters.delete(run.id); memory.delete(run.id); throw error; }
    void withCostContext({ entityType: 'report_autotest', entityId: run.id, stage: 'suite' }, async () => {
      try {
        for (const item of run.cases) { controller.signal.throwIfAborted(); await execute(run, item, parent, controller.signal); await save(run); }
        controller.signal.throwIfAborted(); run.status = run.cases.some((item) => item.status === 'failed') ? 'failed' : 'completed'; run.progress = 'Проверка отчётов завершена';
      } catch (error) {
        run.status = controller.signal.aborted ? 'cancelled' : 'failed';
        run.error = blocksProvider(error)
          ? `Провайдер API недоступен (HTTP ${Number((error as { status?: unknown }).status)}). Проверьте баланс, ключ и доступ к модели. Оставшиеся сценарии не запускались; это не ошибки качества отчёта.`
          : error instanceof Error ? error.message : String(error);
        run.progress = controller.signal.aborted ? 'Проверка остановлена' : 'Проверка прервана из-за технической ошибки';
      }
      finally { run.endedAt = new Date().toISOString(); try { await save(run); } finally { aborters.delete(run.id); memory.delete(run.id); } }
    }).catch((error) => { aborters.delete(run.id); memory.delete(run.id); console.error('[report-autotest]', error); });
    return run;
  }
  async function handle(req: Request, res: Response, action: string) {
    if (!req.authAccount) { res.status(401).json({ error: 'Требуется авторизация.' }); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (action === 'start') { res.status(202).json(await start(req)); return; }
      if (action === 'history') {
        const dirs = await fs.readdir(root, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        const runs: ReportTestRun[] = [];
        for (const dir of dirs) if (dir.isDirectory()) { const run = await load(dir.name, req.authAccount.id); if (run) runs.push(run); }
        runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
        res.json({ items: runs.slice(offset, offset + 30).map(({ cases, configuration: _config, ownerId: _owner, executorPid: _pid, ...run }) => ({ ...run, scenarioIds: cases.map((item) => item.id), casesTotal: cases.length, casesCompleted: cases.filter((item) => item.status === 'completed').length, counts: Object.fromEntries(['pass', 'fail', 'review', 'not_run'].map((status) => [status, run.checklist.filter((point) => point.status === status).length])), timing: reportRunTiming({ cases }) })), total: runs.length, offset, limit: 30, checks: REPORT_TEST_CHECKS.map(([id, title], index) => ({ id, title: `${index + 1}. ${title}`, scenarioIds: REPORT_TEST_SCENARIOS.filter((item) => item.checks.includes(id)).map((item) => item.id) })), scenarios: REPORT_TEST_SCENARIOS.map(({ id, title, checks }) => ({ id, title, checks })) }); return;
      }
      const run = await load(String(req.params.runId ?? ''), req.authAccount.id); if (!run) { res.status(404).json({ error: 'Проверка отчётов не найдена.' }); return; }
      if (action === 'get') { res.json(run); return; }
      if (action === 'ticket') { res.json({ ticket: issueAutoTestingTicket(run.id, run.ownerId, 'report'), expiresInMs: 45000 }); return; }
      if (action === 'cancel') {
        if (run.status === 'running' && !aborters.has(run.id)) { res.status(409).json({ error: 'Тест выполняется другим процессом.' }); return; }
        if (run.status === 'running') { run.progress = 'Останавливаем после текущего запроса генерации…'; aborters.get(run.id)?.abort(); publishAutoTestingRun(run); }
        res.json({ ok: true }); return;
      }
      if (action === 'compare') { const after = await load(String(req.query.against ?? ''), req.authAccount.id); if (!after) { res.status(404).json({ error: 'Запуск для сравнения не найден.' }); return; } res.json(compareReportRuns(run, after)); return; }
      res.status(404).end();
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  }
  return { start, load, handle };
}
