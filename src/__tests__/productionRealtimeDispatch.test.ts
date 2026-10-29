import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const http = vi.hoisted(() => vi.fn());
vi.mock('undici', () => ({ request: http }));
vi.mock('../tunnel', () => ({ getTunnelUrl: () => null }));
import { startVoiceCall } from '../voice/startVoiceCall';
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ VOX_ACCOUNT_ID: 'account', VOX_API_KEY: 'vox-key', VOX_APP_ID: 'app',
    VOICE_DIALOG_BASE_URL: 'https://media.example', PUBLIC_BASE_URL: 'https://events.example',
    VOX_OPENAI_REALTIME_SCENARIO_NAME: 'voice_openai_realtime', VOX_OPENAI_REALTIME_RULE_NAME: 'voice_openai_realtime_rule',
    OPENAI_REALTIME_API_KEY: 'secret-openai-key', ELEVENLABS_API_KEY: 'secret-eleven-key' })) vi.stubEnv(key, value);
  http.mockResolvedValue({ statusCode: 200, body: { text: async () => JSON.stringify({ result: 1, call_session_history_id: 123 }) } });
});
afterEach(() => vi.unstubAllEnvs());
describe('production Vox dispatch', () => {
  it('uses a separate scenario, authenticated events and media without provider keys or prompts', async () => {
    const result = await startVoiceCall('+79507503215', { scenario: 'openai_realtime', callId: 'call-id', streamToken: 'media-token', webhookToken: 'hook-token', instructions: 'private plan prompt' });
    expect(result).toMatchObject({ callId: 'call-id', callSessionHistoryId: 123, scenario: 'openai_realtime' });
    const form = new URLSearchParams(http.mock.calls[0][1].body);
    expect(form.get('script_name')).toBe('voice_openai_realtime');
    expect(form.get('rule_name')).toBe('voice_openai_realtime_rule');
    const data = JSON.parse(form.get('script_custom_data')!);
    expect(data).toMatchObject({ event_url: 'https://events.example/webhooks/vox-openai-realtime', event_token: 'hook-token',
      stream_url: 'wss://media.example/voice/openai-realtime?call_id=call-id&token=media-token' });
    expect(JSON.stringify(data)).not.toMatch(/secret-openai-key|secret-eleven-key|private plan prompt/);
  });
  it('never dispatches a production call without authentication tokens', async () => {
    expect(await startVoiceCall('+79507503215', { scenario: 'openai_realtime' })).toHaveProperty('error');
    expect(http).not.toHaveBeenCalled();
  });
  it('keeps the Agent scenario and its voice/prompt contract for rollback', async () => {
    vi.stubEnv('VOX_REALTIME_PURE_SCENARIO_NAME', 'voice_realtime_pure');
    await startVoiceCall('+79507503215', { scenario: 'realtime_pure', instructions: 'old prompt', elevenLabsVoiceId: 'old-voice' });
    const form = new URLSearchParams(http.mock.calls[0][1].body);
    expect(form.get('script_name')).toBe('voice_realtime_pure');
    expect(JSON.parse(form.get('script_custom_data')!)).toMatchObject({ instructions: 'old prompt', elevenlabs_voice_id: 'old-voice', event_url: 'https://events.example/webhooks/vox' });
  });
});
