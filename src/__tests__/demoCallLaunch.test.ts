import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), prepare: vi.fn(), create: vi.fn(), start: vi.fn(), dispose: vi.fn(), failed: vi.fn() }));
vi.mock('../db', () => ({ prisma: { voiceCallSession: { create: mocks.create } } }));
vi.mock('../voice/demoCallConfiguration', () => ({ resolveDemoCallRuntime: mocks.runtime }));
vi.mock('../voice/callPlanTelephony', () => ({ prepareDemoCallTelephony: mocks.prepare, markCallPlanLaunchFailed: mocks.failed }));
import { createDemoCallStartHandler, launchDemoCall } from '../voice/demoCallLaunch';

const runtime = {
  voice: { id: 'sergey', elevenLabsVoiceId: 'selected-voice', updatedAt: 'voice-version' },
  profile: { id: 'profile', updatedAt: 'profile-version' },
  script: { id: 'script', name: 'Demo script', itemTitle: 'Demo car', dataText: 'Car description', updatedAt: 'script-version' },
  prompt: 'Ты Сергей. Уточни стоимость автомобиля.', criteria: [{ expectedAnswer: 'Цена', score: 10 }],
};
const prepared = {
  callId: 'demo-call', startedAt: '2026-11-03T12:00:00Z', scenario: 'openai_realtime',
  telephony: { provider: 'openai_realtime', model: 'gpt-realtime-2.1', voiceId: 'selected-voice', webhookTokenHash: 'hash-only' },
  start: mocks.start, dispose: mocks.dispose,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtime.mockResolvedValue(runtime);
  mocks.prepare.mockResolvedValue(prepared);
  mocks.create.mockResolvedValue({});
  mocks.start.mockResolvedValue({ callId: prepared.callId });
  mocks.dispose.mockResolvedValue(undefined); mocks.failed.mockResolvedValue(undefined);
});

describe('public demo through production Realtime telephony', () => {
  it('persists the selected persona and evaluation context before initiating the call', async () => {
    mocks.start.mockImplementationOnce(async () => {
      expect(mocks.create).toHaveBeenCalledOnce(); // Simulate an immediate lifecycle webhook.
      return { callId: prepared.callId };
    });
    const result = await launchDemoCall('+79990000000', 'sergey', '127.0.0.1');
    expect(mocks.prepare).toHaveBeenCalledWith('+79990000000', expect.objectContaining({
      planId: 'demo:script', prompt: runtime.prompt, elevenLabsVoiceId: 'selected-voice', customerVoiceId: 'sergey', subjectTitle: 'Demo car',
    }));
    const saved = mocks.create.mock.calls[0][0].data;
    expect(saved).toMatchObject({ source: 'demo', scenario: 'openai_realtime', callId: 'demo-call', ipAddress: '127.0.0.1' });
    expect(saved.planId).toBeUndefined();
    expect(JSON.parse(saved.caseContextJson)).toMatchObject({
      kind: 'fixed_demo_call', demoClientId: 'sergey', demoProfileId: 'profile', demoScriptId: 'script',
      prompt: runtime.prompt, criteria: runtime.criteria, telephony: prepared.telephony,
    });
    expect(result).toEqual({ callId: 'demo-call', startedAt: prepared.startedAt, to: '+79990000000', client: 'sergey', scenario: 'openai_realtime' });
  });

  it('does not dial if persistence fails and releases the prepared provider', async () => {
    mocks.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(launchDemoCall('+79990000000', 'sergey', null)).rejects.toThrow('database unavailable');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('records dispatch failure and releases providers without falling back or redialing', async () => {
    mocks.start.mockRejectedValueOnce(new Error('Vox unavailable'));
    await expect(launchDemoCall('+79990000000', 'sergey', null)).rejects.toThrow('Vox unavailable');
    expect(mocks.failed).toHaveBeenCalledWith('demo-call', expect.any(Error));
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('does not create a call when provider preflight fails', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('Realtime unavailable'));
    await expect(launchDemoCall('+79990000000', 'sergey', null)).rejects.toThrow('Realtime unavailable');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe('public demo start endpoint', () => {
  async function request(body: object, launch = vi.fn().mockResolvedValue({ callId: 'demo-call', startedAt: prepared.startedAt, to: '+79990000000', client: 'sergey', scenario: 'openai_realtime' })) {
    const notify = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req = { body, headers: { 'x-real-ip': '127.0.0.1' }, socket: {} } as unknown as Request;
    await createDemoCallStartHandler({ launch, notify })(req, res as unknown as Response, () => {});
    return { launch, notify, res };
  }
  it.each(['realtime_pure', 'dialog', 'realtime', 'elevenlabs_agent'])('ignores a client-supplied legacy engine %s', async (scenario) => {
    const { launch, notify, res } = await request({ to: '+7 (999) 000-00-00', client: 'sergey', scenario });
    expect(launch).toHaveBeenCalledWith('+79990000000', 'sergey', '127.0.0.1');
    expect(notify).toHaveBeenCalledWith({ callId: 'demo-call', phone: '+79990000000' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'openai_realtime' }));
  });
  it('rejects an invalid number before any provider work', async () => {
    const { launch, notify, res } = await request({ to: '123' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(launch).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it('returns a retryable error without a CRM notification when launch fails', async () => {
    const { notify, res } = await request({ to: '+79990000000' }, vi.fn().mockRejectedValue(new Error('provider not ready')));
    expect(res.status).toHaveBeenCalledWith(503);
    expect(notify).not.toHaveBeenCalled();
  });
});
