import fs from 'node:fs/promises';
import path from 'node:path';
import type { RegressionRun } from '../voice/realtimeRegression';
import { REGRESSION_ROOT, regressionTiming, validRegressionId } from '../voice/realtimeRegressionHistory';

/** Trusted local filesystem only. HTTP access must continue using the owner-scoped loader. */
export async function readLocalAutoTestReport(id: string, root = REGRESSION_ROOT): Promise<RegressionRun> {
  if (!validRegressionId(id)) throw new Error('Некорректный ID проверки.');
  let raw: string;
  try { raw = await fs.readFile(path.join(root, id, 'report.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Проверка ${id} не найдена в локальном архиве. Если запуск был на другом сервере, нужен доступ к его storage/realtime-regression.`);
    throw error;
  }
  let run: RegressionRun;
  try { run = JSON.parse(raw) as RegressionRun; }
  catch { throw new Error(`Отчёт проверки ${id} содержит некорректный JSON.`); }
  if (!run || run.id !== id || !Array.isArray(run.cases) || !Array.isArray(run.checklist)) throw new Error(`Отчёт проверки ${id} повреждён или относится к другому ID.`);
  return run;
}

export function redactDiagnosticData(value: unknown): unknown {
  return redact(value);
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(authorization|api[-_]?key|.*ApiKey|access[-_]?token|refresh[-_]?token|token|secret|password)$/i.test(key) ? '[REDACTED]' : redact(entry)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  return value;
}

export function autoTestDiagnostics(run: RegressionRun, selection: { checkId?: string; scenarioId?: string } = {}) {
  const { checkId, scenarioId } = selection;
  if (checkId && !run.checklist.some((item) => item.id === checkId)) throw new Error(`В этой проверке нет пункта ${checkId}.`);
  if (scenarioId && !run.cases.some((item) => item.id === scenarioId)) throw new Error(`В этой проверке нет сценария ${scenarioId}.`);
  const cases = run.cases.filter((item) => (!scenarioId || item.id === scenarioId) && (!checkId || item.checks.some((check) => check.id === checkId)));
  if ((checkId || scenarioId) && !cases.length) throw new Error('В этом запуске нет сценариев для выбранного сочетания фильтров.');
  const plan = run.configuration?.plan;
  const tts = run.configuration?.tts;
  const runtime = run.configuration?.runtime;
  return {
    id: run.id, target: run.target ?? 'hypothesis2', status: run.status, planId: run.planId, planName: run.planName, model: run.model,
    createdAt: run.createdAt, endedAt: run.endedAt, parentRunId: run.parentRunId, evaluatorVersion: run.evaluatorVersion, configurationHash: run.configurationHash,
    progress: run.progress, error: redact(run.error), timing: regressionTiming({ ...run, cases }),
    warnings: [
      ...(run.status === 'running' ? ['Снимок выполняющегося теста может быть неполным; окончательные выводы ещё не сохранены.'] : []),
      ...(!run.configuration ? ['В архивном отчёте нет снимка конфигурации.'] : []),
      'Это эмуляция: реальную телефонную сеть и качество слышимости нужно проверить контрольным звонком.',
    ],
    // Deliberate allowlists: never dump environment, authentication, owner record or arbitrary configuration fields.
    configuration: {
      fixtureVersion: run.configuration?.fixtureVersion,
      plan: plan ? { prompt: redact(plan.prompt), subjectTitle: plan.subjectTitle, subjectDescription: plan.subjectDescription, elevenLabsVoiceId: plan.elevenLabsVoiceId, customerVoiceId: plan.customerVoiceId } : undefined,
      tts: tts ? { modelId: tts.modelId, defaultVoiceId: tts.defaultVoiceId, stability: tts.stability, similarityBoost: tts.similarityBoost, speed: tts.speed, source: tts.source, optimizeStreamingLatency: tts.optimizeStreamingLatency } : undefined,
      runtime: runtime ? { provider: runtime.provider, model: runtime.model, endpointSilenceMs: runtime.endpointSilenceMs, longTurnSilenceMs: runtime.longTurnSilenceMs, longTurnThresholdMs: runtime.longTurnThresholdMs, reasoningEffort: runtime.reasoningEffort, transcriptionModel: runtime.transcriptionModel } : undefined,
    },
    checklist: run.checklist.filter((item) => !checkId || item.id === checkId).map((item) => ({ id: item.id, title: item.title, status: item.status, evidence: item.evidence.map((text) => redact(text)) })),
    cases: cases.map((item) => ({
      id: item.id, title: item.title, status: item.status, phase: item.phase, step: item.step, startedAt: item.startedAt, endedAt: item.endedAt,
      error: redact(item.error), audioFile: item.audioFile ? `${run.id}/${path.basename(item.audioFile)}` : undefined,
      checks: redact(item.checks), transcript: redact(item.session?.transcript ?? []), tools: redact(item.session?.tools ?? []),
      events: redact(item.events ?? []), assessment: redact(item.assessment),
      session: item.session ? { callId: item.session.callId, provider: item.session.provider, status: item.session.status,
        createdAt: item.session.createdAt, connectedAt: item.session.connectedAt, providerConnectedAt: item.session.providerConnectedAt,
        providerReadyAt: item.session.providerReadyAt, endedAt: item.session.endedAt, errors: redact(item.session.errors),
      } : undefined,
    })),
  };
}

export function formatAutoTestDiagnostics(report: ReturnType<typeof autoTestDiagnostics>): string {
  const lines = [`ID ${report.id}`, `STATUS ${report.status} · ${report.target} · ${report.model}`, `PLAN ${report.planId} · ${report.planName}`,
    `CREATED ${report.createdAt}`, `PARENT ${report.parentRunId ?? '—'}`, `EVALUATOR ${report.evaluatorVersion ?? '—'}`,
    `TIMING median=${report.timing.medianMs ?? '—'}ms p95=${report.timing.p95Ms ?? '—'}ms samples=${report.timing.samples}`];
  if (report.error) lines.push(`ERROR ${report.error}`);
  for (const warning of report.warnings) lines.push(`NOTE ${warning}`);
  for (const check of report.checklist) lines.push(`\n${check.status.toUpperCase()} [${check.id}] ${check.title}`, ...check.evidence.map((evidence) => `  ${evidence}`));
  for (const scenario of report.cases) {
    lines.push(`\nSCENARIO ${scenario.id} · ${scenario.status} · ${scenario.title}`);
    if (scenario.error) lines.push(`ERROR ${scenario.error}`);
    if (scenario.audioFile) lines.push(`AUDIO storage/realtime-regression/${scenario.audioFile}`);
    lines.push(`DETAILS ${JSON.stringify({ checks: scenario.checks, transcript: scenario.transcript, tools: scenario.tools, events: scenario.events, assessment: scenario.assessment, session: scenario.session }, null, 2)}`);
  }
  return lines.join('\n');
}
