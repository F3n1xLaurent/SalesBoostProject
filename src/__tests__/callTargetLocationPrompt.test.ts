import { describe, expect, it } from 'vitest';
import {
  buildCallTargetLocationSection,
  upsertCallTargetLocationSection,
} from '../voice/customerScenarioPrompt';

describe('call plan target location prompt', () => {
  it('pins the call to the target dealership city', () => {
    const section = buildCallTargetLocationSection({
      name: 'Точка Борисоглебск',
      city: 'Борисоглебск',
      address: 'ул. Советская, 1',
    });

    expect(section).toContain('Целевой город звонка: Борисоглебск.');
    expect(section).toContain('единственным целевым городом');
    expect(section).toContain('Не проси соединить с другим городом.');
  });

  it('adds the target city even when an old scheduled prompt mentions another city', () => {
    const prompt = upsertCallTargetLocationSection(
      'Описание компании: главный офис находится в Воронеже.',
      { name: 'Филиал', city: 'Борисоглебск' },
    );

    expect(prompt.startsWith('=== ЦЕЛЕВАЯ ТОЧКА ЗВОНКА (КРИТИЧНО) ===')).toBe(true);
    expect(prompt).toContain('Целевой город звонка: Борисоглебск.');
    expect(prompt).toContain('Описание компании: главный офис находится в Воронеже.');
  });

  it('replaces an existing target section instead of duplicating it', () => {
    const initial = upsertCallTargetLocationSection('Остальной prompt', { city: 'Воронеж' });
    const updated = upsertCallTargetLocationSection(initial, { city: 'Борисоглебск' });

    expect(updated).not.toContain('Целевой город звонка: Воронеж.');
    expect(updated.match(/ЦЕЛЕВАЯ ТОЧКА ЗВОНКА/g)).toHaveLength(1);
  });
});
