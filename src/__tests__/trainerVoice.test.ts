import { describe, expect, it } from 'vitest';
import { resolveTrainerVoiceSelection } from '../voice/trainerVoice';

describe('trainer voice selection', () => {
  it('keeps the exact OpenAI voice stored with the selected profile', () => {
    const context = {
      clientProfile: {
        name: 'Тестовый голос Дмитрия',
        voiceId: 'verse',
        voiceName: 'Мужской, разговорный',
        openaiVoiceId: 'verse',
        elevenLabsVoiceId: 'eleven-male-id',
      },
    };

    expect(resolveTrainerVoiceSelection(context, 'openai', 'male')).toEqual({
      provider: 'openai',
      voiceId: 'verse',
      elevenLabsVoiceId: 'eleven-male-id',
      openaiVoiceId: 'verse',
      fallbackVoice: 'male',
    });
    expect(resolveTrainerVoiceSelection(context, 'openai', 'female')).toEqual({
      provider: 'openai',
      voiceId: 'verse',
      elevenLabsVoiceId: 'eleven-male-id',
      openaiVoiceId: 'verse',
      fallbackVoice: 'male',
    });
  });

  it('does not replace a female profile with the male request fallback', () => {
    const context = {
      clientProfile: {
        name: 'Сомневающаяся девушка',
        voiceId: 'marin',
        voiceName: 'Женский',
        openaiVoiceId: 'marin',
        elevenLabsVoiceId: 'eleven-female-id',
      },
    };

    expect(resolveTrainerVoiceSelection(context, 'openai', 'male')).toEqual({
      provider: 'openai',
      voiceId: 'marin',
      elevenLabsVoiceId: 'eleven-female-id',
      openaiVoiceId: 'marin',
      fallbackVoice: 'female',
    });
  });

  it('keeps the matching OpenAI profile voice for ElevenLabs fallback', () => {
    const context = {
      clientProfile: {
        name: 'Сомневающаяся девушка',
        voiceId: 'marin',
        voiceName: 'Женский',
        openaiVoiceId: 'marin',
        elevenLabsVoiceId: 'eleven-female-id',
      },
    };

    expect(resolveTrainerVoiceSelection(context, 'elevenlabs', 'male')).toEqual({
      provider: 'elevenlabs',
      voiceId: 'eleven-female-id',
      elevenLabsVoiceId: 'eleven-female-id',
      openaiVoiceId: 'marin',
      fallbackVoice: 'female',
    });
  });

  it('supports existing sessions that stored only the profile voice id', () => {
    const context = {
      clientProfile: {
        name: 'Сомневающаяся девушка',
        voiceId: 'marin',
        voiceName: 'Женский',
        elevenLabsVoiceId: 'eleven-female-id',
      },
    };

    expect(resolveTrainerVoiceSelection(context, 'openai', 'male')).toMatchObject({
      provider: 'openai',
      voiceId: 'marin',
      fallbackVoice: 'female',
    });
  });
});
