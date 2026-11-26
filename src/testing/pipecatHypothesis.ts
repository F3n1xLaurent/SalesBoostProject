import { Router, type Request } from 'express';
import { config } from '../config';

const PROVIDERS = new Set(['openai', 'openai_mini', 'gemini', 'gemini_proxyapi']);
const OPENAI_PROVIDERS = new Set(['openai', 'openai_mini']);
const TTS_MODELS = new Set(['eleven_v3', 'eleven_v4', 'eleven_v4_turbo']);

type Plan = { planId: string; planName: string; prompt: string; elevenLabsVoiceId: string | null;
  subjectTitle: string | null; subjectDescription: string | null; customerNeed?: string | null; companyName?: string | null;
  targetLocation?: { name: string | null; city: string | null; address: string | null } | null;
  visitSchedule?: { workingHoursFrom: string; workingHoursTo: string; timezoneOffsetMinutes: number } | null };
type Dependencies = {
  resolvePlan: (req: Request, id: string) => Promise<Plan>;
  request: (path: string, body?: unknown) => Promise<unknown>;
  resolveVoice: () => Promise<string | null | undefined>;
};

/** A dedicated prototype service; no production telephony configuration or dialer. */
async function prototypeRequest(path: string, body?: unknown): Promise<unknown> {
  const base = process.env.PIPECAT_HYPOTHESIS_URL?.replace(/\/$/u, '');
  const token = process.env.PIPECAT_HYPOTHESIS_TOKEN;
  if (!base || !token || token.length < 32) throw new Error('Настройте PIPECAT_HYPOTHESIS_URL и PIPECAT_HYPOTHESIS_TOKEN для отдельного сервиса.');
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = await response.json() as { detail?: unknown };
  if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : `Сервис прототипа: HTTP ${response.status}`);
  return payload;
}

export function createPipecatHypothesisRouter(overrides: Partial<Dependencies> = {}): Router {
  const deps: Dependencies = {
    resolvePlan: async (req, id) => (await import('../voice/callSettingsManagement')).resolveRealtimeTestPlanConfiguration(req, id),
    request: prototypeRequest,
    resolveVoice: async () => (await (await import('../voice/yandexRealtimeTest')).resolveAgentTtsSettings()).defaultVoiceId || config.elevenLabsVoiceId,
    ...overrides,
  };
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/history', async (_req, res) => {
    try { res.json(await deps.request('/sessions')); }
    catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Не удалось загрузить журналы.' }); }
  });
  router.get('/health', async (_req, res) => {
    try { res.json(await deps.request('/health')); }
    catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Сервис прототипа недоступен.' }); }
  });
  for (const action of ['preflight', 'calls'] as const) {
    router.post(`/${action}`, async (req, res) => {
      const { provider, ttsModel, planId, to, reasoningEffort, trimIdleAudio, dialogueMode = 'legacy', backchannel = false } = req.body ?? {};
      if (!['legacy', 'controller', 'semantic'].includes(dialogueMode) || typeof backchannel !== 'boolean'
        || (['controller', 'semantic'].includes(dialogueMode) && !OPENAI_PROVIDERS.has(provider)) || (backchannel && !['controller', 'semantic'].includes(dialogueMode))) {
        res.status(400).json({ error: 'Выберите поддерживаемый режим диалога. Контроллер и реакции доступны для OpenAI Realtime.' }); return;
      }
      if (trimIdleAudio !== undefined && (typeof trimIdleAudio !== 'boolean' || !OPENAI_PROVIDERS.has(provider))) {
        res.status(400).json({ error: 'Сокращение аудиобуфера доступно только для OpenAI.' }); return;
      }
      if (reasoningEffort !== undefined && (!['low', 'minimal'].includes(reasoningEffort) || !OPENAI_PROVIDERS.has(provider))) {
        res.status(400).json({ error: 'Выберите low или minimal для OpenAI Realtime.' }); return;
      }
      if (!PROVIDERS.has(provider) || !TTS_MODELS.has(ttsModel) || typeof planId !== 'string' || !planId.trim()) {
        res.status(400).json({ error: 'Выберите план, модель диалога и вариант ElevenLabs.' }); return;
      }
      if (action === 'calls' && (typeof to !== 'string' || !/^\+[1-9]\d{9,14}$/u.test(to))) {
        res.status(400).json({ error: 'Введите номер в международном формате, например +79991234567.' }); return;
      }
      try {
        // Existing scope checks, business prompt and profile voice, read only.
        const plan = await deps.resolvePlan(req, planId);
        const voiceId = plan.elevenLabsVoiceId || await deps.resolveVoice();
        if (!voiceId) { res.status(400).json({ error: 'В профиле плана или ELEVENLABS_VOICE_ID не задан голос.' }); return; }
        const options = { provider, ttsModel, voiceId, ...(['controller', 'semantic'].includes(dialogueMode) ? { dialogueMode, backchannel } : {}), ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(trimIdleAudio === undefined ? {} : { trimIdleAudio }) };
        res.json(await deps.request(action === 'calls' ? '/sessions' : '/preflight', action === 'calls'
          ? { ...options, to, prompt: plan.prompt, context: { planId: plan.planId, planName: plan.planName,
            subjectTitle: plan.subjectTitle, subjectDescription: plan.subjectDescription, customerNeed: plan.customerNeed ?? null, companyName: plan.companyName ?? null,
            ...(plan.targetLocation ? { targetLocation: plan.targetLocation } : {}),
            ...(plan.visitSchedule ? { visitSchedule: plan.visitSchedule } : {}) } }
          : options));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Ошибка отдельного прототипа.';
        res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 503).json({ error: message });
      }
    });
  }
  router.get('/calls/:id', async (req, res) => {
    if (!/^(?:pc-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(req.params.id)) { res.status(400).json({ error: 'Некорректный ID прототипа.' }); return; }
    try { res.json(await deps.request(`/sessions/${encodeURIComponent(req.params.id)}`)); }
    catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Не удалось загрузить эксперимент.' }); }
  });
  for (const action of ['diagnostics', 'export', 'summary'] as const) {
    router.get(`/calls/:id/${action}`, async (req, res) => {
      const id = req.params.id;
      if (!/^(?:pc-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
        res.status(400).json({ error: 'Некорректный ID журнала.' }); return;
      }
      const after = String(req.query.after ?? '0');
      if (!/^\d+$/u.test(after)) { res.status(400).json({ error: 'Некорректная позиция журнала.' }); return; }
      try { res.json(await deps.request(`/sessions/${encodeURIComponent(id)}/${action}${action === 'diagnostics' ? `?after=${after}&limit=500` : ''}`)); }
      catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Журнал не найден или недоступен.' }); }
    });
  }
  return router;
}
