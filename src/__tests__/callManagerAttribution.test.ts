import { describe, expect, it } from 'vitest';
import {
  evidenceBelongsToTranscript,
  extractExplicitManagerIntroduction,
  matchIntroducedManager,
  normalizePersonToken,
  rankProbableManagers,
} from '../voice/callManagerAttribution';

describe('call manager attribution', () => {
  const candidates = [
    { id: 'one', fullName: 'Михайлов Иван Сергеевич' },
    { id: 'two', fullName: 'Петров Иван Андреевич' },
  ];

  it('matches a unique first and last name regardless of stored order', () => {
    expect(matchIntroducedManager(
      { givenName: 'Иван', familyName: 'Михайлов' },
      candidates,
    )).toEqual({ reason: 'matched_unique_employee', candidate: candidates[0] });
  });

  it('rejects an incomplete or unknown name', () => {
    expect(matchIntroducedManager(
      { givenName: 'Иван', familyName: '' },
      candidates,
    ).reason).toBe('incomplete_name');
    expect(matchIntroducedManager(
      { givenName: 'Иван', familyName: 'Сидоров' },
      candidates,
    ).reason).toBe('employee_not_found');
  });

  it('rejects duplicate full-name matches', () => {
    expect(matchIntroducedManager(
      { givenName: 'Иван', familyName: 'Михайлов' },
      [...candidates, { id: 'duplicate', fullName: 'Иван Михайлов' }],
    ).reason).toBe('ambiguous_employee_match');
  });

  it('normalizes Russian names and validates an exact evidence quote', () => {
    expect(normalizePersonToken('  СЕМЁН! ')).toBe('семен');
    expect(evidenceBelongsToTranscript(
      'Добрый день, я Иван Михайлов',
      'Добрый день, я Иван Михайлов. Чем могу помочь?',
    )).toBe(true);
    expect(evidenceBelongsToTranscript(
      'Я Иван Сидоров',
      'Добрый день, я Иван Михайлов.',
    )).toBe(false);
  });

  it('extracts an explicit introduction without relying on the classifier', () => {
    expect(extractExplicitManagerIntroduction(
      'Добрый день, меня зовут Никита Жажин. Скажите, по какому вопросу звоните?',
    )).toEqual({
      isSelfIntroduction: true,
      givenName: 'Никита',
      familyName: 'Жажин',
      evidence: 'меня зовут Никита Жажин',
      confidence: 1,
    });
  });

  it('does not mistake an ordinary phrase for a self-introduction', () => {
    expect(extractExplicitManagerIntroduction(
      'Добрый день. Я могу подсказать стоимость автомобиля.',
    )).toBeNull();
  });

  it('suggests a close employee without treating it as an exact match', () => {
    expect(rankProbableManagers('Никита Жажин', [
      { id: 'nikita', fullName: 'Шачин Никита' },
      { id: 'ivan', fullName: 'Сидоров Иван' },
    ])).toEqual([
      { id: 'nikita', fullName: 'Шачин Никита', confidence: 0.8 },
    ]);
  });

  it('keeps equally probable employees visible as an ambiguous hint', () => {
    expect(rankProbableManagers('Никита Жажин', [
      { id: 'one', fullName: 'Шачин Никита' },
      { id: 'two', fullName: 'Шачин Никита РТ' },
    ])).toHaveLength(2);
  });

  it('does not suggest a candidate based only on a common first name', () => {
    expect(rankProbableManagers('Никита Жажин', [
      { id: 'other', fullName: 'Иванов Никита' },
    ])).toEqual([]);
  });
});
