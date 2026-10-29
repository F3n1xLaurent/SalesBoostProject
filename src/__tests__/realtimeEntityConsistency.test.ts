import { describe, expect, it } from 'vitest';
import {
  detectVehicleEntityMismatch,
  vehicleMismatchInstruction,
} from '../voice/realtimeEntityConsistency';

describe('realtime entity consistency', () => {
  it('detects another vehicle brand in a manager answer', () => {
    const mismatch = detectVehicleEntityMismatch(
      'Mercedes-Benz GLE, рестайлинг 2023 года',
      'Пробег у Хавейла тысяча восемьсот тридцать восемь километров',
    );
    expect(mismatch).toEqual({
      targetBrand: 'Мерседес-Бенц',
      mentionedBrand: 'Хавейл',
      targetSubject: 'Mercedes-Benz GLE, рестайлинг 2023 года',
    });
    expect(vehicleMismatchInstruction(mismatch!)).toContain('Не переноси');
  });

  it('does not flag inflected mentions of the target brand', () => {
    expect(detectVehicleEntityMismatch(
      'Mercedes-Benz GLE',
      'У Мерседеса пробег тысяча восемьсот километров',
    )).toBeNull();
  });

  it('stays inactive when the selected subject is not a known vehicle', () => {
    expect(detectVehicleEntityMismatch('Запись на сервис', 'У Хавейла небольшой пробег')).toBeNull();
  });
});
