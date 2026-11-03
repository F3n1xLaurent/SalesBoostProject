import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  billing: vi.fn(), plan: vi.fn(), prepare: vi.fn(), start: vi.fn(), lifecycle: vi.fn(), snapshot: vi.fn(), dispose: vi.fn(), markDialing: vi.fn(),
  register: vi.fn(), flush: vi.fn(), unregister: vi.fn(), update: vi.fn(), add: vi.fn(), voxId: vi.fn(),
}));
vi.mock('../voice/cometRealtimeTest', () => ({ prepareProductionOpenAiRealtimeCall: mocks.prepare, updateProductionRealtimeLifecycle: mocks.lifecycle }));
vi.mock('../voice/startVoiceCall', () => ({ startVoiceCall: mocks.start }));
vi.mock('../voice/callHistory', () => ({ addCall: mocks.add, setVoxSessionId: mocks.voxId }));
vi.mock('../voice/productionRealtimeState', () => ({ registerProductionRealtimeState: mocks.register,
  flushProductionRealtimeState: mocks.flush, unregisterProductionRealtimeState: mocks.unregister, realtimeWebhookTokenHash: () => 'hashed-not-raw' }));
vi.mock('../billing/access', () => ({ assertCompanyModule: mocks.billing }));
vi.mock('../config', () => ({ config: { openaiRealtimeModel: 'test-realtime' } }));
vi.mock('../db', () => ({ prisma: { callPlan: { findUnique: mocks.plan }, voiceCallSession: { updateMany: mocks.update }, callPlanCall: { updateMany: mocks.update } } }));
import { prepareCallPlanTelephony, prepareDemoCallTelephony, resolveCallPlanTelephonyProvider } from '../voice/callPlanTelephony';
const plan = { planId: 'plan', planName: 'Тест', prompt: 'Сценарий', elevenLabsVoiceId: 'profile-voice', customerVoiceId: 'voice-row', subjectTitle: 'BMW', subjectDescription: null };
let prepared: Awaited<ReturnType<typeof prepareCallPlanTelephony>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CALL_PLAN_TELEPHONY_PROVIDER', '');
  mocks.plan.mockResolvedValue({ holdingId: 'company' });
  mocks.billing.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue({ streamToken: 'media-secret', voiceId: 'profile-voice', snapshot: mocks.snapshot, dispose: mocks.dispose, markDialing: mocks.markDialing });
  mocks.start.mockImplementation(async (_phone, options) => ({ callId: options.callId, startedAt: 'later', callSessionHistoryId: 456 }));
  mocks.flush.mockResolvedValue(null); mocks.update.mockResolvedValue({ count: 1 });
});
afterEach(async () => { await prepared?.dispose(); prepared = undefined; vi.unstubAllEnvs(); });
describe('call plan telephony selection and dispatch', () => {
  it('uses the same production Realtime bridge for a demo without requiring a company plan', async () => {
    vi.stubEnv('CALL_PLAN_TELEPHONY_PROVIDER', 'elevenlabs_agent');
    prepared = await prepareDemoCallTelephony('+79507503215', { ...plan, planId: 'demo:script' });
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.billing).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith({ callId: prepared.callId, phone: '+79507503215', plan: { ...plan, planId: 'demo:script' } });
    expect(prepared.telephony).toMatchObject({ provider: 'openai_realtime', model: 'test-realtime', voiceId: 'profile-voice' });
    expect(mocks.register).toHaveBeenCalledWith(prepared.callId, expect.any(String), mocks.snapshot);
    await prepared.start();
    expect(mocks.start).toHaveBeenCalledWith('+79507503215', expect.objectContaining({
      scenario: 'openai_realtime', callId: prepared.callId, streamToken: 'media-secret', webhookToken: expect.any(String), elevenLabsVoiceId: 'profile-voice',
    }));
    expect(mocks.billing).not.toHaveBeenCalled();
  });
  it('defaults to direct OpenAI and rejects typos', () => {
    expect(resolveCallPlanTelephonyProvider()).toBe('openai_realtime');
    expect(resolveCallPlanTelephonyProvider(' elevenlabs_agent ')).toBe('elevenlabs_agent');
    expect(() => resolveCallPlanTelephonyProvider('comet')).toThrow();
  });
  it('prepares durable state before dialing and fixes the plan voice and id', async () => {
    prepared = await prepareCallPlanTelephony('+79507503215', plan);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.register).toHaveBeenCalledWith(prepared.callId, expect.any(String), mocks.snapshot);
    expect(mocks.flush).toHaveBeenCalledWith(prepared.callId);
    expect(prepared.telephony).toMatchObject({ provider: 'openai_realtime', voiceId: 'profile-voice', webhookTokenHash: 'hashed-not-raw' });
    const result = await prepared.start();
    expect(result.startedAt).toBe(prepared.startedAt);
    expect(mocks.start).toHaveBeenCalledWith('+79507503215', expect.objectContaining({
      scenario: 'openai_realtime', callId: prepared.callId, streamToken: 'media-secret', elevenLabsVoiceId: 'profile-voice', webhookToken: expect.any(String),
    }));
    expect(mocks.voxId).toHaveBeenCalledWith(prepared.callId, 456);
    await expect(prepared.start()).rejects.toThrow('уже был запущен');
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
  it('rolls back new calls to the unchanged Agent path without opening OpenAI', async () => {
    vi.stubEnv('CALL_PLAN_TELEPHONY_PROVIDER', 'elevenlabs_agent');
    prepared = await prepareCallPlanTelephony('+79507503215', plan);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    await prepared.start();
    expect(mocks.start).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ scenario: 'realtime_pure', instructions: plan.prompt, elevenLabsVoiceId: plan.elevenLabsVoiceId }));
  });
  it('blocks unpaid calls before preparing a provider and rechecks at actual dispatch', async () => {
    mocks.billing.mockRejectedValueOnce(new Error('Обзвон не оплачен'));
    await expect(prepareCallPlanTelephony('+79507503215', plan)).rejects.toThrow('Обзвон не оплачен');
    expect(mocks.prepare).not.toHaveBeenCalled();
    prepared = await prepareCallPlanTelephony('+79507503215', plan);
    mocks.billing.mockRejectedValueOnce(new Error('Срок доступа истёк'));
    await expect(prepared.start()).rejects.toThrow('Срок доступа истёк');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('prevents parallel start calls while the billing check is pending', async () => {
    prepared = await prepareCallPlanTelephony('+79507503215', plan);
    let release!: () => void;
    mocks.billing.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = prepared.start();
    await expect(prepared.start()).rejects.toThrow('уже был запущен');
    release();
    await first;
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
  it('fails before calling Vox when OpenAI preflight fails', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(prepareCallPlanTelephony('+79507503215', plan)).rejects.toThrow('provider unavailable');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('does not fallback or redial after a dispatch failure', async () => {
    prepared = await prepareCallPlanTelephony('+79507503215', plan);
    mocks.start.mockResolvedValueOnce({ error: 'network error' });
    await expect(prepared.start()).rejects.toThrow('network error');
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    await expect(prepared.start()).rejects.toThrow('закрыта');
  });
});
