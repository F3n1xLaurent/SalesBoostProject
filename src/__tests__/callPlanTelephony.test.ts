import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(), start: vi.fn(), lifecycle: vi.fn(), snapshot: vi.fn(), dispose: vi.fn(), markDialing: vi.fn(),
  register: vi.fn(), flush: vi.fn(), unregister: vi.fn(), update: vi.fn(), add: vi.fn(), voxId: vi.fn(),
}));
vi.mock('../voice/cometRealtimeTest', () => ({ prepareProductionOpenAiRealtimeCall: mocks.prepare, updateProductionRealtimeLifecycle: mocks.lifecycle }));
vi.mock('../voice/startVoiceCall', () => ({ startVoiceCall: mocks.start }));
vi.mock('../voice/callHistory', () => ({ addCall: mocks.add, setVoxSessionId: mocks.voxId }));
vi.mock('../voice/productionRealtimeState', () => ({ registerProductionRealtimeState: mocks.register,
  flushProductionRealtimeState: mocks.flush, unregisterProductionRealtimeState: mocks.unregister, realtimeWebhookTokenHash: () => 'hashed-not-raw' }));
vi.mock('../config', () => ({ config: { openaiRealtimeModel: 'test-realtime' } }));
vi.mock('../db', () => ({ prisma: { voiceCallSession: { updateMany: mocks.update }, callPlanCall: { updateMany: mocks.update } } }));
import { prepareCallPlanTelephony, resolveCallPlanTelephonyProvider } from '../voice/callPlanTelephony';
const plan = { planId: 'plan', planName: 'Тест', prompt: 'Сценарий', elevenLabsVoiceId: 'profile-voice', customerVoiceId: 'voice-row', subjectTitle: 'BMW', subjectDescription: null };
let prepared: Awaited<ReturnType<typeof prepareCallPlanTelephony>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CALL_PLAN_TELEPHONY_PROVIDER', '');
  mocks.prepare.mockResolvedValue({ streamToken: 'media-secret', voiceId: 'profile-voice', snapshot: mocks.snapshot, dispose: mocks.dispose, markDialing: mocks.markDialing });
  mocks.start.mockImplementation(async (_phone, options) => ({ callId: options.callId, startedAt: 'later', callSessionHistoryId: 456 }));
  mocks.flush.mockResolvedValue(null); mocks.update.mockResolvedValue({ count: 1 });
});
afterEach(async () => { await prepared?.dispose(); prepared = undefined; vi.unstubAllEnvs(); });
describe('call plan telephony selection and dispatch', () => {
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
