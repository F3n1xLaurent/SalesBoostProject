import { readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../config', () => ({ config: { elevenLabsVoiceId: 'fallback-voice' } }));
import { createPipecatHypothesisRouter } from '../testing/pipecatHypothesis';

const plan = { planId: 'plan', planName: 'Plan', prompt: 'Business prompt', elevenLabsVoiceId: 'profile-voice', subjectTitle: 'Car', subjectDescription: 'Description' };
async function invoke(path: string, body: unknown, deps = {}, params = { id: 'bad/id' }, query = {}) {
  const resolvePlan = vi.fn().mockResolvedValue(plan);
  const request = vi.fn().mockResolvedValue({ id: 'prototype-session' });
  const resolveVoice = vi.fn().mockResolvedValue('fallback-voice');
  const router = createPipecatHypothesisRouter({ resolvePlan, request, resolveVoice, ...deps });
  const route = (router as any).stack.find((layer: any) => layer.route?.path === path).route;
  const req = { body, params, query } as unknown as Request;
  const state = { status: 200, body: undefined as unknown };
  const res = { status(value: number) { state.status = value; return this; }, json(value: unknown) { state.body = value; return this; } } as Response;
  await route.stack[0].handle(req, res);
  return { ...state, resolvePlan, request, resolveVoice, req };
}

describe('isolated Pipecat hypothesis', () => {
  it('passes the independent semantic experiment without replacing the controller', async () => {
    for (const dialogueMode of ['controller', 'semantic']) {
      const r = await invoke('/calls', { provider: 'openai_mini', ttsModel: 'eleven_v4_turbo', planId: 'plan', to: '+79991234567', dialogueMode, backchannel: true });
      expect(r.status).toBe(200);
      expect(r.request).toHaveBeenCalledWith('/sessions', expect.objectContaining({ dialogueMode, backchannel: true }));
    }
    const denied = await invoke('/calls', { provider: 'gemini', ttsModel: 'eleven_v4_turbo', planId: 'plan', to: '+79991234567', dialogueMode: 'semantic' });
    expect(denied.status).toBe(400);
  });
  it('passes the separate controller and backchannel choices to the prototype', async () => {
    const r = await invoke('/calls', { provider: 'openai_mini', ttsModel: 'eleven_v4_turbo', planId: 'plan', to: '+79991234567', dialogueMode: 'controller', backchannel: true });
    expect(r.status).toBe(200);
    expect(r.request).toHaveBeenCalledWith('/sessions', expect.objectContaining({ dialogueMode: 'controller', backchannel: true }));
  });
  it.each([{ provider: 'gemini', dialogueMode: 'controller' }, { provider: 'openai', dialogueMode: 'bad' }, { provider: 'openai', dialogueMode: 'legacy', backchannel: true }, { provider: 'openai', dialogueMode: 'controller', backchannel: 'false' }])('rejects unsupported controller settings: %j', async (settings) => {
    const r = await invoke('/calls', { ttsModel: 'eleven_v4_turbo', planId: 'plan', to: '+79991234567', ...settings });
    expect(r.status).toBe(400); expect(r.resolvePlan).not.toHaveBeenCalled();
  });
  it.each([['openai', 'low'], ['openai', 'minimal'], ['openai_mini', 'low'], ['openai_mini', 'minimal']])('passes %s reasoning %s to both preflight and the isolated call', async (provider, reasoningEffort) => {
    for (const path of ['/preflight', '/calls']) {
      const result = await invoke(path, { provider, ttsModel: 'eleven_v4_turbo', planId: 'plan', to: '+79991234567', reasoningEffort, trimIdleAudio: false });
      expect(result.status).toBe(200);
      expect(result.request).toHaveBeenCalledWith(path === '/calls' ? '/sessions' : '/preflight', expect.objectContaining({ provider, reasoningEffort, trimIdleAudio: false }));
    }
  });
  it.each([{ provider: 'openai', reasoningEffort: 'xhigh' }, { provider: 'gemini_proxyapi', reasoningEffort: 'minimal' }])('rejects unsupported speed settings before resolving a plan: %j', async (settings) => {
    const result = await invoke('/calls', { ...settings, ttsModel: 'eleven_v4_turbo', planId: 'plan', to: '+79991234567' });
    expect(result.status).toBe(400);
    expect(result.resolvePlan).not.toHaveBeenCalled();
  });
  it('loads archived history without dialing or resolving a plan', async () => {
    const result = await invoke('/history', undefined);
    expect(result.request).toHaveBeenCalledWith('/sessions');
    expect(result.resolvePlan).not.toHaveBeenCalled();
  });
  it.each(['diagnostics', 'export', 'summary'])('proxies private %s by shareable diagnostic ID', async (action) => {
    const id = 'pc-2f8a0b7d-fe21-4bdc-8d68-89dec06e5edb';
    const result = await invoke(`/calls/:id/${action}`, undefined, {}, { id }, { after: '1000' });
    expect(result.status).toBe(200);
    expect(result.request).toHaveBeenCalledWith(`/sessions/${id}/${action}${action === 'diagnostics' ? '?after=1000&limit=500' : ''}`);
    expect(result.resolvePlan).not.toHaveBeenCalled();
  });
  it('rejects diagnostic traversal and malformed cursors before contacting service', async () => {
    const invalidId = await invoke('/calls/:id/export', undefined);
    expect(invalidId.status).toBe(400);
    expect(invalidId.request).not.toHaveBeenCalled();
    const cursor = await invoke('/calls/:id/diagnostics', undefined, {}, { id: '2f8a0b7d-fe21-4bdc-8d68-89dec06e5edb' }, { after: '0&token=bad' });
    expect(cursor.status).toBe(400);
    expect(cursor.request).not.toHaveBeenCalled();
  });
  it.each(['eleven_v3', 'eleven_v4', 'eleven_v4_turbo'])('passes %s without production model fallback', async (ttsModel) => {
    const result = await invoke('/calls', { provider: 'openai', ttsModel, planId: 'plan', to: '+79991234567', prompt: 'browser override', voiceId: 'browser voice' });
    expect(result.status).toBe(200);
    expect(result.resolvePlan).toHaveBeenCalledWith(result.req, 'plan');
    expect(result.request).toHaveBeenCalledWith('/sessions', expect.objectContaining({ provider: 'openai', ttsModel,
      prompt: plan.prompt, voiceId: plan.elevenLabsVoiceId, context: expect.objectContaining({ planId: 'plan' }) }));
    expect(result.resolveVoice).not.toHaveBeenCalled();
  });
  it('checks scoped plan and voice without dialing during preflight', async () => {
    const result = await invoke('/preflight', { provider: 'gemini', ttsModel: 'eleven_v4', planId: 'plan' });
    expect(result.request).toHaveBeenCalledWith('/preflight', { provider: 'gemini', ttsModel: 'eleven_v4', voiceId: 'profile-voice' });
  });
  it('forwards the branch schedule to the test controller', async () => {
    const visitSchedule = { workingHoursFrom: '11:30', workingHoursTo: '20:00', timezoneOffsetMinutes: 240 };
    const result = await invoke('/calls', { provider: 'openai', ttsModel: 'eleven_v4_turbo', planId: 'plan', to: '+79991234567' },
      { resolvePlan: vi.fn().mockResolvedValue({ ...plan, visitSchedule }) });
    expect(result.status).toBe(200);
    expect(result.request).toHaveBeenCalledWith('/sessions', expect.objectContaining({ context: expect.objectContaining({ visitSchedule }) }));
  });
  it('keeps Gemini ProxyAPI as an explicit provider rather than substituting direct Google', async () => {
    const result = await invoke('/calls', { provider: 'gemini_proxyapi', ttsModel: 'eleven_v4_turbo', planId: 'plan', to: '+79991234567' });
    expect(result.status).toBe(200);
    expect(result.request).toHaveBeenCalledWith('/sessions', expect.objectContaining({ provider: 'gemini_proxyapi', ttsModel: 'eleven_v4_turbo' }));
  });
  it('does not contact prototype when plan scope denies access', async () => {
    const result = await invoke('/calls', { provider: 'openai', ttsModel: 'eleven_v3', planId: 'plan', to: '+79991234567' },
      { resolvePlan: vi.fn().mockRejectedValue(new Error('Нет доступа к плану.')) });
    expect(result.status).toBe(403);
    expect(result.request).not.toHaveBeenCalled();
  });
  it.each([
    { provider: 'unknown', ttsModel: 'eleven_v3', planId: 'plan', to: '+79991234567' },
    { provider: 'openai', ttsModel: 'eleven_flash_v2_5', planId: 'plan', to: '+79991234567' },
    { provider: 'openai', ttsModel: 'eleven_v4', planId: 'plan', to: 'default' },
  ])('rejects invalid experiment or destination before accessing a plan: %j', async (body) => {
    const result = await invoke('/calls', body);
    expect(result.status).toBe(400);
    expect(result.resolvePlan).not.toHaveBeenCalled();
    expect(result.request).not.toHaveBeenCalled();
  });
  it('keeps prototype under existing testing superadmin middleware', () => {
    const server = readFileSync('src/server.ts', 'utf8');
    expect(server.indexOf("app.use(['/api/admin/auto-testing', '/api/admin/realtime-test'], requireTestingSuperadmin)"))
      .toBeLessThan(server.indexOf("app.use('/api/admin/realtime-test/pipecat'"));
    const prototype = readFileSync('src/testing/pipecatHypothesis.ts', 'utf8');
    expect(prototype).not.toContain('startVoiceCall');
    expect(prototype).not.toContain('createCallPlan');
  });
});
