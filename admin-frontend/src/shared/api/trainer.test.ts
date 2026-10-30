import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('../../entities/session', () => ({ apiJson }));
import { fetchTrainerDialog, sendTrainerVoiceMessage } from './trainer';

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('trainer whole voice messages', () => {
  it('keeps complete voice messages and records end-to-end response time separately', async () => {
    vi.useFakeTimers();
    apiJson.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(2100);
      return { audioBase64: 'whole-voice', transcript: [{ text: 'Ответ', role: 'client' }],
        timings: { sttMs: 300, textMs: 400, ttsMs: 1000, totalMs: 1800 } };
    });
    const response = await sendTrainerVoiceMessage('session', { audioBase64: 'whole-recording', mimeType: 'audio/wav', durationSec: 4 });
    expect(response.audioBase64).toBe('whole-voice');
    expect(response.timings).toEqual({ sttMs: 300, textMs: 400, ttsMs: 1000, totalMs: 1800, roundTripMs: 2100, transferAndParsingMs: 300 });
    expect(apiJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(apiJson.mock.calls[0][1].body)).toEqual({
      audioBase64: 'whole-recording', mimeType: 'audio/wav', durationSec: 4, replyMode: 'text+voice',
    });
  });

  it('still loads all saved audio for replay when reopening the dialog', async () => {
    const saved = { transcript: [{ role: 'client', text: 'Здравствуйте', audioBase64: 'saved-voice', audioMimeType: 'audio/ogg' }] };
    apiJson.mockResolvedValue(saved);
    expect(await fetchTrainerDialog('session')).toBe(saved);
  });

  it('supports old responses without timings', async () => {
    const old = { audioBase64: 'whole-voice', transcript: [] };
    apiJson.mockResolvedValue(old);
    expect(await sendTrainerVoiceMessage('session', { audioBase64: 'input', mimeType: 'audio/wav', durationSec: 1 })).toBe(old);
  });
});
