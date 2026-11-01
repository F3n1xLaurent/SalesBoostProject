import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { autoTestingCatalog } from '../testing/autoTestingTargets';
import { handleStartCallPlanAutoTest, type RegressionRun } from '../voice/realtimeRegression';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), load: vi.fn() }));
vi.mock('../voice/callSettingsManagement', () => ({ resolveRealtimeTestPlanConfiguration: mocks.resolve }));
vi.mock('../voice/realtimeRegressionHistory', async (original) => ({ ...await original<typeof import('../voice/realtimeRegressionHistory')>(), loadRegressionReport: mocks.load }));
const original = { key: config.openaiRealtimeApiKey, eleven: config.elevenLabsApiKey, model: config.openaiRealtimeModel };
const currentPlan = { planId: 'plan', planName: 'Актуальный план', prompt: 'Текущий промпт',
  elevenLabsVoiceId: 'voice', customerVoiceId: null, subjectTitle: 'Kia', subjectDescription: null };
function response() { const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res); return res; }
const request = (body: object, owner: string | null = 'owner') => ({ body, params: {}, authAccount: owner ? { id: owner } : undefined } as unknown as Request);
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CALL_PLAN_TELEPHONY_PROVIDER', 'openai_realtime');
  config.openaiRealtimeApiKey = 'mock-key'; config.elevenLabsApiKey = 'mock-key'; config.openaiRealtimeModel = 'gpt-realtime-2.1';
  mocks.resolve.mockResolvedValue(currentPlan); mocks.load.mockResolvedValue(null);
});
afterEach(() => { config.openaiRealtimeApiKey = original.key; config.elevenLabsApiKey = original.eleven; config.openaiRealtimeModel = original.model; vi.unstubAllEnvs(); });

describe('production-call autotest configuration (no billed providers)', () => {
  it('uses current production model/plan instead of a browser model or frozen hypothesis prompt', async () => {
    mocks.load.mockResolvedValue({ id: 'reference', ownerId: 'owner', planId: 'plan', status: 'completed', configuration: { plan: { ...currentPlan, prompt: 'Старый тестовый промпт' } } });
    const start = vi.fn().mockResolvedValue({ id: 'new' } as RegressionRun); const res = response();
    const req = request({ planId: 'plan', model: 'gpt-realtime-2', referenceRunId: 'reference', checkIds: ['ending'] });
    await handleStartCallPlanAutoTest(req, res as unknown as Response, start);
    expect(mocks.resolve).toHaveBeenCalledWith(req, 'plan');
    expect(start).toHaveBeenCalledWith(currentPlan, 'owner', 'gpt-realtime-2.1', undefined,
      { checkIds: ['ending'], parentRunId: 'reference', target: 'call_plan' });
    expect(res.status).toHaveBeenCalledWith(202);
  });
  it('does not start tests without authentication or plan access', async () => {
    const start = vi.fn(); const unauth = response();
    await handleStartCallPlanAutoTest(request({ planId: 'plan' }, null), unauth as unknown as Response, start);
    expect(unauth.status).toHaveBeenCalledWith(401);
    mocks.resolve.mockRejectedValue(new Error('Нет доступа к плану'));
    const denied = response();
    await handleStartCallPlanAutoTest(request({ planId: 'plan' }), denied as unknown as Response, start);
    expect(denied.status).toHaveBeenCalledWith(400); expect(start).not.toHaveBeenCalled();
  });
  it('never silently tests the wrong engine when production is switched back to ElevenLabs Agent', async () => {
    vi.stubEnv('CALL_PLAN_TELEPHONY_PROVIDER', 'elevenlabs_agent');
    const start = vi.fn(); const res = response();
    await handleStartCallPlanAutoTest(request({ planId: 'plan' }), res as unknown as Response, start);
    expect(res.status).toHaveBeenCalledWith(409); expect(start).not.toHaveBeenCalled();
  });
  it('exposes extensible target metadata but no keys, and does not advertise unimplemented tests', () => {
    const catalog = autoTestingCatalog();
    expect(catalog.targets.map((target) => target.id)).toEqual(['call_plan', 'report', 'trainer']);
    expect(catalog.targets.map((target) => target.available)).toEqual([true, Boolean(config.openaiApiKey || config.proxyApiKey), Boolean(config.openaiApiKey || config.proxyApiKey)]);
    expect(JSON.stringify(catalog)).not.toContain('mock-key');
    expect(catalog.targets[0].configuration?.model).toBe('gpt-realtime-2.1');
  });
});
