import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import type WebSocket from 'ws';
import { config } from '../config';
import { compatibleChatMaxTokens, openai } from '../lib/openaiClient';
import { resolveRealtimeTestPlanConfiguration, type RealtimeTestPlanConfiguration } from './callSettingsManagement';
import { containsTechnicalRealtimeSpeech, createCallPlanSimulation, createHypothesis2Simulation, hasExplicitHoldInstruction, type Hypothesis2Snapshot } from './cometRealtimeTest';
import { autoTestingCatalog, callPlanAutoTestConfiguration } from '../testing/autoTestingTargets';
import { issueAutoTestingTicket, publishAutoTestingRun } from '../testing/autoTestingLive';
import { fetchElevenLabs } from './elevenLabsHttp';
import { resolveAgentTtsSettings, type ElevenLabsTtsSettings } from './yandexRealtimeTest';
import { SimulatedVoxSocket, type SimulationEvent } from './realtimeRegressionAudio';
import { hasOnlyFarewellSteps, managerReplyTo, REGRESSION_CHECKLIST, regressionScenarios, selectRegressionScenarios, type CheckId, type RegressionScenario } from './realtimeRegressionScenarios';
import { aggregateRegressionChecks, compareRegressionRuns, EVALUATOR_VERSION, listRegressionReports, loadRegressionReport, REGRESSION_ROOT, summarizeRegression } from './realtimeRegressionHistory';
import { parseRegressionAssessment, REGRESSION_JUDGE_INSTRUCTIONS, regressionAssessmentScope } from './realtimeRegressionAssessment';
import { farewellCount, hasClosingIntention, hasNaturalFarewell } from './hypothesis2Closing';

export type RegressionCheck = { id: CheckId; title: string; status: 'pass' | 'fail' | 'review' | 'not_run'; evidence: string[] };
export type RegressionCase = {
  id: string; title: string; status: 'pending' | 'running' | 'completed' | 'failed';
  checks: RegressionCheck[]; session?: Hypothesis2Snapshot; events?: SimulationEvent[];
  audioFile?: string; error?: string; startedAt?: string; endedAt?: string;
  assessment?: { model: string; finishReason?: string; response?: unknown; error?: string };
  phase?: 'preparing_audio' | 'connecting' | 'dialogue' | 'assessing' | 'completed' | 'failed';
  step?: { current: number; total: number };
};
export type RegressionRun = {
  id: string; ownerId: string; planId: string; planName: string; model: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed'; createdAt: string; endedAt?: string;
  cases: RegressionCase[]; checklist: RegressionCheck[]; error?: string; progress: string;
  evaluatorVersion?: string;
  selectedCheckIds?: CheckId[];
  parentRunId?: string;
  configurationHash?: string;
  configuration?: { plan: RealtimeTestPlanConfiguration; tts: ElevenLabsTtsSettings; runtime?: ReturnType<typeof callPlanAutoTestConfiguration> };
  executorPid?: number;
  target?: 'hypothesis2' | 'call_plan';
  executionMode?: 'simulation';
};
const ROOT = REGRESSION_ROOT;
const runs = new Map<string, RegressionRun>();
const aborters = new Map<string, AbortController>();
export function cancelRegression(id: string): void {
  const run = runs.get(id);
  if (run?.status === 'running') progress(run, 'Останавливаем тест… Сохраняем уже полученные результаты.');
  aborters.get(id)?.abort(new Error('Тест остановлен пользователем.'));
}
const check = (id: CheckId, status: RegressionCheck['status'], ...evidence: string[]): RegressionCheck => ({
  id, title: REGRESSION_CHECKLIST.find(([key]) => key === id)![1], status, evidence,
});
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function aggregate(run: RegressionRun): void {
  if (run.evaluatorVersion) { run.checklist = aggregateRegressionChecks(run); return; }
  run.checklist = REGRESSION_CHECKLIST.map(([id]) => {
    const items = run.cases.flatMap((c) => c.checks.filter((x) => x.id === id));
    const executed = items.filter((x) => x.status !== 'not_run');
    const status = items.some((x) => x.status === 'fail') ? 'fail'
      : items.some((x) => x.status === 'not_run') || !executed.length ? 'not_run'
      : items.some((x) => x.status === 'review') ? 'review' : 'pass';
    return check(id, status, ...items.flatMap((x) => x.evidence));
  });
}
async function save(run: RegressionRun): Promise<void> {
  aggregate(run);
  await fs.mkdir(path.join(ROOT, run.id), { recursive: true });
  const target = path.join(ROOT, run.id, 'report.json');
  await fs.writeFile(`${target}.tmp`, JSON.stringify(run, null, 2));
  await fs.rename(`${target}.tmp`, target);
  publishAutoTestingRun(run);
}

function progress(run: RegressionRun, message: string): void {
  run.progress = message; aggregate(run); publishAutoTestingRun(run);
}

async function managerAudio(text: string, voiceId: string, signal: AbortSignal): Promise<Buffer> {
  const key = createHash('sha256').update(`${voiceId}:eleven_multilingual_v2:pcm_16000:${text}`).digest('hex');
  const target = path.join(ROOT, 'fixtures', `${key}.pcm`);
  try { return await fs.readFile(target); } catch { /* first synthesis */ }
  const response = await fetchElevenLabs(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_16000`, {
    method: 'POST', headers: { 'xi-api-key': config.elevenLabsApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.65, similarity_boost: 0.75, speed: 1.08 } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  });
  if (!response.ok) throw new Error(`Голос менеджера: ElevenLabs HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 3200 || audio.length % 2) throw new Error('Некорректное PCM-аудио менеджера.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, audio);
  return audio;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, signal: AbortSignal, detail: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(`Таймаут: ${detail}`);
    await pause(40);
  }
}

export function evaluateTransport(scenario: RegressionScenario, session: Hypothesis2Snapshot, events: SimulationEvent[]): RegressionCheck[] {
  const results: RegressionCheck[] = [];
  const responses = session.transcript.filter((x) => x.role === 'client' && !x.metrics.interrupted);
  const hasTechnical = responses.some((x) => containsTechnicalRealtimeSpeech(x.text) || /из\s+выборки/iu.test(x.text));
  results.push(check('technical', hasTechnical ? 'fail' : responses.length ? 'pass' : 'review',
    hasTechnical ? 'Техническая фраза найдена в транскрипте.' : `Проверено реплик: ${responses.length}.`));
  const closingIntention = responses.find((turn) => hasClosingIntention(turn.text));
  const doubleFarewell = responses.find((turn) => farewellCount(turn.text) > 1);
  let repeatedFarewell = false;
  let farewellPending = false;
  for (const turn of session.transcript) {
    if (turn.role === 'manager' && /\?/u.test(turn.text) && !hasNaturalFarewell(turn.text)) farewellPending = false;
    if (turn.role !== 'client' || turn.metrics.interrupted) continue;
    if (hasNaturalFarewell(turn.text)) {
      if (farewellPending) repeatedFarewell = true;
      farewellPending = true;
    }
  }
  if (closingIntention || doubleFarewell || repeatedFarewell) results.push(check('ending', 'fail',
    closingIntention ? `Озвучено служебное намерение: «${closingIntention.text}».` : 'ИИ попрощался несколько раз вместо одной финальной реплики.'));
  const hangup = events.find((event) => event.type === 'hangup');
  const finalPlayback = hangup && events.filter((event) => event.type === 'playback_ended' && event.atMs <= hangup.atMs).at(-1);
  if (hangup && finalPlayback && hangup.atMs - finalPlayback.atMs > 500) results.push(check('ending', 'fail',
    `После конца аудио до завершения звонка прошло ${hangup.atMs - finalPlayback.atMs} мс; ожидание ответного прощания отключено.`));
  const seenPhrases = new Set<string>();
  let repeated = false;
  for (const turn of session.transcript) {
    if (turn.role === 'manager' && hasExplicitHoldInstruction(turn.text)) { seenPhrases.clear(); continue; }
    if (turn.role !== 'client' || turn.metrics.interrupted) continue;
    const normalized = turn.text.toLocaleLowerCase('ru').replace(/[^а-яёa-z0-9]/gu, '');
    if (normalized.length > 20 && seenPhrases.has(normalized)) repeated = true;
    seenPhrases.add(normalized);
  }
  results.push(check('loops', repeated ? 'fail' : responses.length > 1 ? 'pass' : 'review', repeated ? 'Есть дословный повтор длинной фразы.' : 'Дословных повторов не обнаружено; смысловые повторы оцениваются отдельно.'));
  if (scenario.checks.includes('turns')) {
    const playback = events.filter((x) => x.type === 'playback_started');
    const speech = events.filter((x) => x.type === 'manager_started' || x.type === 'manager_ended');
    const overlaps = playback.filter((p) => {
      const last = speech.filter((x) => x.atMs <= p.atMs).at(-1);
      return last?.type === 'manager_started';
    });
    const latencies = responses.map((r) => r.metrics.speechToVoxPlaybackMs).filter((x): x is number => x != null);
    results.push(check('turns', overlaps.length || latencies.some((x) => x > 3000 || x < 180) ? 'fail' : latencies.length ? 'pass' : 'review',
      `Наложений на подготовленную речь: ${overlaps.length}; паузы до эмулируемого воспроизведения: ${latencies.join(', ')} мс.`));
  }
  if (scenario.checks.includes('automation')) {
    const hold = events.find((x) => x.type === 'manager_started' && /приветствует|переведу/iu.test(x.detail ?? ''));
    const live = events.find((x) => x.type === 'manager_started' && x.atMs > (hold?.atMs ?? 0) && /^Алло/iu.test(x.detail ?? ''));
    const leaked = hold && events.some((x) => x.type === 'playback_started' && x.atMs > hold.atMs && x.atMs < (live?.atMs ?? Infinity));
    const resumed = live && events.some((x) => x.type === 'playback_started' && x.atMs > live.atMs);
    const digits = events.filter((x) => x.type === 'send_dtmf');
    results.push(check('automation', leaked || digits.length > 2 ? 'fail' : hold && live && resumed ? 'pass' : 'review',
      `Речь во время IVR/ожидания: ${Boolean(leaked)}; разговор после живого приветствия: ${Boolean(resumed)}; нажатий DTMF: ${digits.length}.`));
  }
  if (scenario.id === 'acknowledgement') {
    const confirmed = session.conversationFlow.events.some((x) => x.type === 'barge_in_confirmed');
    const ignored = session.conversationFlow.events.some((x) => x.type === 'barge_in_ignored');
    results.push(check('interruption', confirmed ? 'fail' : ignored ? 'pass' : 'review', `Короткое «угу»: подтверждено перебивание=${confirmed}, проигнорировано=${ignored}.`));
  }
  if (scenario.id === 'interruption') {
    const interrupted = session.transcript.find((x) => x.metrics.interrupted);
    results.push(check('interruption', interrupted?.metrics.contextCorrected ? 'pass' : 'fail',
      interrupted ? `Услышанная часть: «${interrupted.metrics.heardTextOnInterruption ?? ''}»; контекст исправлен: ${interrupted.metrics.contextCorrected}.` : 'Перебивание не остановило ответ.'));
  }
  results.push(check('audio', 'review', 'Запись содержит PCM-выход ElevenLabs и эмулируемый телефонный кодек. Целостность, ударения и качество телефонной сети требуют прослушивания/контрольного звонка.'));
  if (scenario.checks.includes('pronunciation')) results.push(check('pronunciation', 'review', 'Проверьте числа и произношение по записи; транскрипт не подтверждает ударения.'));
  return results;
}

async function judge(scenario: RegressionScenario, plan: RealtimeTestPlanConfiguration, session: Hypothesis2Snapshot, item: RegressionCase, signal?: AbortSignal): Promise<RegressionCheck[]> {
  const ids = scenario.checks.filter((id) => !['automation', 'turns', 'interruption', 'audio', 'pronunciation', 'technical'].includes(id));
  if (!ids.length) return [];
  try {
    const response = await openai.chat.completions.create({
      model: config.openaiChatModel,
      messages: [{ role: 'system', content: REGRESSION_JUDGE_INSTRUCTIONS },
        { role: 'user', content: JSON.stringify({ checks: REGRESSION_CHECKLIST.filter(([id]) => ids.includes(id)).map(([id, title]) => ({ id, title })), scenario: scenario.title, persona: scenario.persona, plan: plan.prompt,
          scope: regressionAssessmentScope(scenario.id), evaluatedRole: 'ai_client',
          transcript: session.transcript.map((turn, turnIndex) => ({ turnIndex, role: turn.role, speaker: turn.role === 'client' ? 'ai_client' : 'manager_fixture', text: turn.text })), tools: session.tools, errors: session.errors }) }],
      response_format: { type: 'json_object' }, ...compatibleChatMaxTokens(config.openaiChatModel, 2400),
    }, { timeout: 45_000, maxRetries: 0, signal });
    const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}');
    item.assessment = { model: config.openaiChatModel, finishReason: response.choices[0]?.finish_reason, response: parsed };
    return parseRegressionAssessment(ids, session.transcript, parsed);
  } catch (error) {
    item.assessment = { model: config.openaiChatModel, error: error instanceof Error ? error.message : String(error) };
    return ids.map((id) => check(id, 'review', `Смысловая оценка недоступна: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function executeCase(run: RegressionRun, item: RegressionCase, scenario: RegressionScenario,
  plan: RealtimeTestPlanConfiguration, tts: ElevenLabsTtsSettings, signal: AbortSignal): Promise<void> {
  item.status = 'running'; item.startedAt = new Date().toISOString();
  item.phase = 'preparing_audio';
  const vox = new SimulatedVoxSocket();
  let simulation: Awaited<ReturnType<typeof createHypothesis2Simulation>> | undefined;
  let liveTimer: ReturnType<typeof setInterval> | undefined;
  const stop = () => vox.close();
  signal.addEventListener('abort', stop, { once: true });
  try {
    const voice = plan.elevenLabsVoiceId || tts.defaultVoiceId || config.elevenLabsVoiceId!;
    // Prepare ALL fixed utterances before the clocked conversation. Otherwise
    // REST synthesis between fragments would turn a 450ms pause into seconds.
    const prepared: Array<{ pcm: Buffer | null; overlapPcm: Buffer | null }> = [];
    for (let i = 0; i < scenario.steps.length; i++) {
      signal.throwIfAborted();
      item.step = { current: i + 1, total: scenario.steps.length };
      progress(run, `${scenario.title}: подготовка аудио ${i + 1}/${scenario.steps.length}`);
      const step = scenario.steps[i];
      prepared.push({ pcm: step.text ? await managerAudio(step.text, voice, signal) : null,
        overlapPcm: step.overlap ? await managerAudio(step.overlap === 'ack' ? 'Угу.' : 'Подождите, пожалуйста. У меня другой вопрос, я хотел уточнить комплектацию.', voice, signal) : null });
    }
    item.phase = 'connecting'; progress(run, `${scenario.title}: подключение к основной цепочке`);
    const scenarioPlan = { ...plan, prompt: plan.prompt + (scenario.persona ? `\n\n${scenario.persona}` : '') };
    simulation = run.target === 'call_plan'
      ? await createCallPlanSimulation(scenarioPlan, vox as unknown as WebSocket, tts)
      : await createHypothesis2Simulation(scenarioPlan, run.model, vox as unknown as WebSocket, tts);
    const snapshot = simulation.snapshot;
    item.phase = 'dialogue';
    let lastLive = '';
    liveTimer = setInterval(() => {
      item.session = snapshot(); item.events = vox.events;
      const signature = JSON.stringify({ transcript: item.session.transcript, tools: item.session.tools,
        errors: item.session.errors, events: vox.events.length });
      if (signature !== lastLive) { lastLive = signature; aggregate(run); publishAutoTestingRun(run); }
    }, 700);
    // A continuous silent microphone is essential for endpoint and interruption timers.
    let streaming = false;
    const silentMic = setInterval(() => { if (!streaming) vox.input(Buffer.alloc(640)); }, 20);
    try {
      const speak = async (pcm: Buffer, text: string) => {
        if (vox.hungUp) throw new Error('Контур завершил диалог до следующей реплики менеджера.');
        streaming = true;
        vox.recordManager(pcm, text);
        const speechStartedAt = Date.now();
        for (let at = 0; at < pcm.length; at += 640) {
          signal.throwIfAborted();
          if (vox.hungUp) throw new Error('Контур оборвал звонок во время речи менеджера.');
          vox.input(pcm.subarray(at, Math.min(at + 640, pcm.length)));
          await pause(Math.max(0, speechStartedAt + (at + 640) / 32 - Date.now()));
        }
        vox.events.push({ atMs: vox.now, type: 'manager_ended', detail: text });
        streaming = false;
      };
      for (let index = 0; index < scenario.steps.length; index++) {
        signal.throwIfAborted();
        if (vox.hungUp) {
          if (!hasOnlyFarewellSteps(scenario.steps.slice(index))) throw new Error('Звонок завершён до проверки содержательных реплик сценария.');
          break;
        }
        item.step = { current: index + 1, total: scenario.steps.length };
        progress(run, `${scenario.title}: реплика ${index + 1}/${scenario.steps.length}`);
        const step = scenario.steps[index];
        // Synthesize before the manager turn; this network time is not dialogue latency.
        const { pcm, overlapPcm } = prepared[index];
        let previousStarts = vox.events.filter((x) => x.type === 'playback_started').length;
        if (pcm) await speak(pcm, step.text!);
        if (step.musicMs) {
          const music = Buffer.alloc(step.musicMs * 32);
          for (let n = 0; n < music.length / 2; n++) music.writeInt16LE(Math.round((Math.sin(n * 2 * Math.PI * 440 / 16000) + Math.sin(n * 2 * Math.PI * 660 / 16000)) * 650), n * 2);
          await speak(music, '[мелодия ожидания]');
        }
        if (step.silenceMs) await pause(step.silenceMs);
        if (step.overlap && overlapPcm) {
          await waitUntil(() => vox.playing, 20_000, signal, 'начало речи ИИ для перебивания');
          await pause(500);
          if (step.overlap === 'interrupt') previousStarts = vox.events.filter((x) => x.type === 'playback_started').length;
          await speak(overlapPcm, step.overlap === 'ack' ? 'Угу.' : 'Подождите, пожалуйста. У меня другой вопрос, я хотел уточнить комплектацию.');
        }
        if (step.pauseAfterMs) await pause(step.pauseAfterMs);
        if (step.wait === 'response') {
          await waitUntil(() => vox.hungUp || vox.events.filter((x) => x.type === 'playback_started').length > previousStarts, 25_000, signal, 'ответ ИИ');
          await waitUntil(() => !vox.playing, 35_000, signal, 'завершение аудио ИИ');
          await pause(400);
        } else if (step.wait === 'quiet') await pause(2500);
        else if (step.wait === 'hangup') await waitUntil(() => vox.hungUp, 15_000, signal, 'завершение звонка');
      }
      if (scenario.id === 'script') {
        for (let i = 0; i < 16 && !vox.hungUp; i++) {
          item.step = { current: i + 1, total: 16 };
          progress(run, `${scenario.title}: ответ менеджера ${i + 1}/16`);
          const last = [...snapshot().transcript].reverse().find((x) => x.role === 'client')?.text ?? '';
          const text = managerReplyTo(last, plan.subjectTitle ?? 'выбранный автомобиль');
          const pcm = await managerAudio(text, voice, signal);
          if (vox.hungUp) break;
          const previousStarts = vox.events.filter((x) => x.type === 'playback_started').length;
          await speak(pcm, text);
          if (/до свидания/iu.test(last)) {
            await waitUntil(() => vox.hungUp, 15_000, signal, 'завершение сценария'); break;
          }
          await waitUntil(() => vox.hungUp || vox.events.filter((x) => x.type === 'playback_started').length > previousStarts, 25_000, signal, 'следующий вопрос');
          await waitUntil(() => !vox.playing, 35_000, signal, 'конец реплики');
        }
      }
      item.session = snapshot(); item.events = vox.events;
      item.checks = evaluateTransport(scenario, item.session, vox.events);
      item.phase = 'assessing'; progress(run, `${scenario.title}: проверка результатов и смысловая оценка`);
      item.checks.push(...await judge(scenario, plan, item.session, item, signal));
      item.status = item.session.errors.length ? 'failed' : 'completed';
      if (item.session.errors.length) item.error = item.session.errors.join('; ');
      item.phase = item.status === 'failed' ? 'failed' : 'completed';
    } finally { clearInterval(silentMic); }
  } catch (error) {
    item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error);
    item.phase = 'failed';
    if (simulation) {
      item.session = simulation.snapshot();
      item.checks = evaluateTransport(scenario, item.session, vox.events);
    }
    // Failed/incomplete execution cannot turn an unexercised requirement green.
    for (const id of scenario.checks) {
      if (!item.checks.some((x) => x.id === id && x.status === 'fail')) item.checks.push(check(id, 'review', item.error));
    }
  } finally {
    if (liveTimer) clearInterval(liveTimer);
    item.events = vox.events;
    item.audioFile = `${scenario.id}.wav`;
    try {
      await fs.mkdir(path.join(ROOT, run.id), { recursive: true });
      await fs.writeFile(path.join(ROOT, run.id, item.audioFile), vox.recording());
    } finally {
      simulation?.close(); vox.close(); signal.removeEventListener('abort', stop);
      if (simulation) item.session = simulation.snapshot();
    }
    item.endedAt = new Date().toISOString();
    aggregate(run); publishAutoTestingRun(run);
  }
}

export async function startRegression(plan: RealtimeTestPlanConfiguration, ownerId: string, model: string, selected?: string[],
  options: { checkIds?: string[]; parentRunId?: string; target?: 'hypothesis2' | 'call_plan' } = {}): Promise<RegressionRun> {
  if (aborters.size) throw new Error('Другой регрессионный тест уже выполняется. Дождитесь окончания или остановите его.');
  if (!config.openaiRealtimeApiKey || !config.elevenLabsApiKey) throw new Error('Не заданы ключи OpenAI Realtime или ElevenLabs.');
  if (!['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'].includes(model)) throw new Error('Неподдерживаемая Realtime-модель.');
  const scenarios = selectRegressionScenarios(plan.subjectTitle ?? 'выбранный автомобиль', { scenarioIds: selected, checkIds: options.checkIds });
  if (!scenarios.length) throw new Error('Не выбраны тестовые сценарии.');
  const run: RegressionRun = { id: randomUUID(), ownerId, planId: plan.planId, planName: plan.planName, model,
    target: options.target ?? 'hypothesis2', executionMode: 'simulation',
    status: 'running', createdAt: new Date().toISOString(), cases: scenarios.map((s) => ({ id: s.id, title: s.title, status: 'pending', checks: s.checks.map((id) => check(id, 'not_run')) })), checklist: [], progress: 'Подготовка голосов и соединения',
    evaluatorVersion: EVALUATOR_VERSION, selectedCheckIds: options.checkIds as CheckId[] | undefined, parentRunId: options.parentRunId, executorPid: process.pid };
  const controller = new AbortController(); aborters.set(run.id, controller); runs.set(run.id, run);
  try { await save(run); }
  catch (error) { aborters.delete(run.id); runs.delete(run.id); throw error; }
  void (async () => {
    try {
      const tts = await resolveAgentTtsSettings();
      run.configuration = { plan: structuredClone(plan), tts,
        ...(run.target === 'call_plan' ? { runtime: callPlanAutoTestConfiguration() } : {}) };
      run.configurationHash = createHash('sha256').update(JSON.stringify({ plan, tts, target: run.target, model,
        endpointSilenceMs: config.openaiRealtimeEndpointSilenceMs,
        longTurnSilenceMs: config.openaiRealtimeLongTurnEndpointSilenceMs,
        transcriptionModel: config.openaiRealtimeTranscriptionModel,
        longTurnThresholdMs: config.openaiRealtimeLongTurnThresholdMs,
        reasoningEffort: config.openaiRealtimeReasoningEffort,
      })).digest('hex');
      await save(run);
      for (let i = 0; i < scenarios.length; i++) {
        controller.signal.throwIfAborted();
        await executeCase(run, run.cases[i], scenarios[i], plan, tts, controller.signal);
        await save(run);
      }
      run.status = 'completed'; run.progress = 'Серия завершена';
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      run.error = error instanceof Error ? error.message : String(error);
    } finally {
      run.endedAt = new Date().toISOString(); aborters.delete(run.id); await save(run);
    }
  })().catch((error) => console.error('[realtime-regression]', error));
  return run;
}

function markInterruptedRun(run: RegressionRun): void {
  if (run.status !== 'running' || aborters.has(run.id)) return;
  if (run.executorPid) {
    try { process.kill(run.executorPid, 0); return; } catch { /* executor exited */ }
  }
  run.status = 'failed'; run.error = 'Процесс, выполнявший тест, завершился.';
}
async function authorizedRun(req: Request, id = String(req.params.runId ?? '')): Promise<RegressionRun | null> {
  if (!req.authAccount) return null;
  const memory = runs.get(id);
  const run = memory?.ownerId === req.authAccount.id ? memory : await loadRegressionReport(id, req.authAccount.id);
  if (run) markInterruptedRun(run);
  return run;
}
export async function handleStartRealtimeRegression(req: Request, res: Response): Promise<void> {
  return handleStartRegression(req, res, 'hypothesis2');
}
export async function handleStartCallPlanAutoTest(req: Request, res: Response, startRun: typeof startRegression = startRegression): Promise<void> {
  return handleStartRegression(req, res, 'call_plan', startRun);
}
async function handleStartRegression(req: Request, res: Response, target: 'hypothesis2' | 'call_plan', startRun = startRegression): Promise<void> {
  try {
    if (!req.authAccount) { res.status(401).json({ error: 'Требуется авторизация.' }); return; }
    if (target === 'call_plan') {
      const current = callPlanAutoTestConfiguration();
      if (!current.available) { res.status(409).json({ error: current.reason }); return; }
    }
    const referenceRunId = typeof req.body?.referenceRunId === 'string' ? req.body.referenceRunId : undefined;
    const reference = referenceRunId ? await authorizedRun(req, referenceRunId) : null;
    if (referenceRunId && !reference) { res.status(404).json({ error: 'Исходный тест не найден.' }); return; }
    if (reference && reference.planId !== req.body?.planId) throw new Error('Исходный тест относится к другому плану.');
    const resolvedPlan = await resolveRealtimeTestPlanConfiguration(req, String(req.body?.planId ?? ''));
    // Preserve the sampled client/profile/subject on repeat, even when a plan
    // normally selects them randomly. Recheck current plan access first.
    const plan = target === 'call_plan' ? resolvedPlan : reference?.configuration?.plan ?? resolvedPlan;
    const scenarioIds = req.body?.scenarioIds;
    const checkIds = req.body?.checkIds;
    for (const value of [scenarioIds, checkIds]) {
      if (value !== undefined && (!Array.isArray(value) || value.some((x: unknown) => typeof x !== 'string'))) throw new Error('Список проверок должен содержать идентификаторы.');
    }
    const model = target === 'call_plan' ? config.openaiRealtimeModel : String(req.body?.model || config.openaiRealtimeModel);
    if (!['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'].includes(model)) throw new Error('Неподдерживаемая Realtime-модель.');
    res.status(202).json(await startRun(plan, req.authAccount.id, model, scenarioIds, { checkIds, parentRunId: reference?.id, target }));
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
}
export async function loadOwnedRegressionRun(id: string, ownerId: string): Promise<RegressionRun | null> {
  const memory = runs.get(id);
  const run = memory?.ownerId === ownerId ? memory : await loadRegressionReport(id, ownerId);
  if (run) markInterruptedRun(run);
  return run;
}
export async function handleAutoTestingCatalog(req: Request, res: Response): Promise<void> {
  if (!req.authAccount) { res.status(401).end(); return; }
  res.json(autoTestingCatalog());
}
export async function handleAutoTestingLiveTicket(req: Request, res: Response): Promise<void> {
  const run = await authorizedRun(req);
  if (!run) { res.status(404).json({ error: 'Тест не найден.' }); return; }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ ticket: issueAutoTestingTicket(run.id, run.ownerId), expiresInMs: 45_000 });
}
export async function handleGetRealtimeRegression(req: Request, res: Response): Promise<void> {
  const run = await authorizedRun(req);
  if (!run) { res.status(404).json({ error: 'Тест не найден.' }); return; }
  if (aborters.has(run.id)) aggregate(run);
  res.json(run);
}
export async function handleListRealtimeRegressions(req: Request, res: Response): Promise<void> {
  if (!req.authAccount) { res.status(401).end(); return; }
  const planId = typeof req.query.planId === 'string' ? req.query.planId : undefined;
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit) || 30)));
  const disk = await listRegressionReports(req.authAccount.id, planId);
  const merged = new Map(disk.map((r) => [r.id, r]));
  for (const run of runs.values()) if (run.ownerId === req.authAccount.id && (!planId || run.planId === planId)) { aggregate(run); merged.set(run.id, run); }
  const sorted = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  for (const run of sorted) markInterruptedRun(run);
  res.json({ items: sorted.slice(offset, offset + limit).map(summarizeRegression), total: sorted.length, offset, limit,
    checks: REGRESSION_CHECKLIST.map(([id, title]) => ({ id, title, scenarioIds: regressionScenarios('').filter((s) => s.checks.includes(id)).map((s) => s.id) })),
    scenarios: regressionScenarios('').map(({ id, title, checks }) => ({ id, title, checks })) });
}
export async function handleCompareRealtimeRegressions(req: Request, res: Response): Promise<void> {
  const before = await authorizedRun(req);
  const after = await authorizedRun(req, String(req.query.against ?? ''));
  if (!before || !after) { res.status(404).json({ error: 'Тест не найден.' }); return; }
  res.json(compareRegressionRuns(before, after));
}
export async function handleCancelRealtimeRegression(req: Request, res: Response): Promise<void> {
  const run = await authorizedRun(req);
  if (!run) { res.status(404).json({ error: 'Тест не найден.' }); return; }
  if (run.status === 'running' && !aborters.has(run.id)) { res.status(409).json({ error: 'Этот тест запущен из другого процесса. Остановите его в консоли через Ctrl+C.' }); return; }
  cancelRegression(run.id); res.json({ ok: true });
}
export async function handleRegressionAudio(req: Request, res: Response): Promise<void> {
  const run = await authorizedRun(req);
  const item = run?.cases.find((c) => c.id === req.params.caseId);
  if (!run || !item?.audioFile) { res.status(404).end(); return; }
  res.type('audio/wav').setHeader('Cache-Control', 'private, no-store');
  res.sendFile(path.join(ROOT, run.id, item.audioFile));
}
