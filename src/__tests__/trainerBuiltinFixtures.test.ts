import { describe, expect, it } from 'vitest';
import { TRAINER_BUILTIN_SUITE_ID, isTrainerBuiltinSource, trainerBuiltinSources } from '../testing/trainerBuiltinFixtures';
import { createBuiltinTrainerSimulationRow } from '../trainer/trainerSimulationStore';
import { resolveTrainerVoiceSelection } from '../voice/trainerVoice';

describe('self-contained trainer test fixtures', () => {
  it('contains a complete scenario, fixed legends and male/female/talkative profiles without employee data', () => {
    const fixtures = trainerBuiltinSources();
    expect(fixtures.source.id).toBe(TRAINER_BUILTIN_SUITE_ID);
    for (const source of Object.values(fixtures)) {
      expect(isTrainerBuiltinSource(source.id)).toBe(true); expect(source.companyId).toBeNull();
      const scenario = source.context.scenario as { context: string; questions: unknown[]; objections: unknown[] };
      expect(scenario.questions).toHaveLength(4); expect(scenario.objections).toHaveLength(2);
      expect(scenario.context).toContain('6 500 000'); expect(scenario.context).toContain('Toyota Camry 2018');
      const car = (source.context.runtime as { car: { price_rub: number; model: string } }).car;
      expect(car.price_rub).toBe(6405000); expect(car.model).toBe('GLE');
    }
    expect(JSON.stringify(fixtures.femaleSource.context)).toContain('Мария');
    expect(resolveTrainerVoiceSelection(fixtures.femaleSource.context, 'elevenlabs')).toMatchObject({ provider: 'openai', voiceId: 'nova', fallbackVoice: 'female' });
    expect(resolveTrainerVoiceSelection(fixtures.source.context, 'openai')).toMatchObject({ voiceId: 'onyx', fallbackVoice: 'male' });
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(trainerBuiltinSources()));
    expect(isTrainerBuiltinSource('a-real-training-id')).toBe(false);
  });
  it('automatically uses configured matching ElevenLabs voices without mixing profile genders', () => {
    const voices = [
      { id: 'female', name: 'Женский голос', elevenLabsCode: 'female-eleven', openaiCode: 'nova' },
      { id: 'male', name: 'Мужской голос', elevenLabsCode: 'male-eleven', openaiCode: 'onyx' },
    ];
    const fixtures = trainerBuiltinSources(voices);
    expect(resolveTrainerVoiceSelection(fixtures.source.context, 'elevenlabs')).toMatchObject({ provider: 'elevenlabs', voiceId: 'male-eleven' });
    expect(resolveTrainerVoiceSelection(fixtures.femaleSource.context, 'elevenlabs')).toMatchObject({ provider: 'elevenlabs', voiceId: 'female-eleven' });
    expect(trainerBuiltinSources([...voices].reverse())).toEqual(fixtures);
  });
  it('creates an isolated session row without looking up, creating or modifying a real training', () => {
    const source = trainerBuiltinSources().femaleSource;
    const row = createBuiltinTrainerSimulationRow('isolated-test', source.context);
    expect(row.id).toBe('isolated-test'); expect(row.employeeId).toBe('autotest-fixture'); expect(row.transcriptJson).toBe('[]');
    expect(row.status).toBe('in_progress'); expect(row.score).toBeNull(); expect(row.companyId).toBeNull();
    expect(JSON.parse(row.caseContextJson)).toEqual(source.context);
  });
});
