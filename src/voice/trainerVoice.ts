import type { TtsVoice } from '../state/userPreferences';

export type TrainerVoiceProvider = 'openai' | 'elevenlabs' | 'fallback';

export type TrainerVoiceSelection = {
  provider: TrainerVoiceProvider;
  voiceId: string | null;
  elevenLabsVoiceId: string | null;
  openaiVoiceId: string | null;
  fallbackVoice: TtsVoice;
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/** Resolve one immutable TTS voice from the profile stored in the session. */
export function resolveTrainerVoiceSelection(
  caseContext: Record<string, unknown>,
  preferredProvider: string,
  requestedFallback: TtsVoice = 'male',
): TrainerVoiceSelection {
  const clientProfile = caseContext.clientProfile && typeof caseContext.clientProfile === 'object'
    ? caseContext.clientProfile as Record<string, unknown>
    : {};
  const profileVoiceId = text(clientProfile.voiceId);
  const openaiVoiceId = text(clientProfile.openaiVoiceId) || profileVoiceId;
  const elevenLabsVoiceId = text(clientProfile.elevenLabsVoiceId);
  const voiceLabel = `${text(clientProfile.voiceName)} ${text(clientProfile.name)}`.toLocaleLowerCase('ru-RU');
  const fallbackVoice: TtsVoice = /женск|девуш|женщин/u.test(voiceLabel)
    ? 'female'
    : /мужск|мужчин/u.test(voiceLabel)
      ? 'male'
      : requestedFallback;

  if (preferredProvider === 'elevenlabs' && elevenLabsVoiceId) {
    return { provider: 'elevenlabs', voiceId: elevenLabsVoiceId, elevenLabsVoiceId, openaiVoiceId: openaiVoiceId || null, fallbackVoice };
  }
  if (preferredProvider === 'openai' && openaiVoiceId) {
    return { provider: 'openai', voiceId: openaiVoiceId, elevenLabsVoiceId: elevenLabsVoiceId || null, openaiVoiceId, fallbackVoice };
  }
  if (openaiVoiceId) {
    return { provider: 'openai', voiceId: openaiVoiceId, elevenLabsVoiceId: elevenLabsVoiceId || null, openaiVoiceId, fallbackVoice };
  }
  if (elevenLabsVoiceId) {
    return { provider: 'elevenlabs', voiceId: elevenLabsVoiceId, elevenLabsVoiceId, openaiVoiceId: null, fallbackVoice };
  }
  return { provider: 'fallback', voiceId: null, elevenLabsVoiceId: null, openaiVoiceId: null, fallbackVoice };
}
