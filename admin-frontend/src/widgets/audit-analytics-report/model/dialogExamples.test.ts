import { describe, expect, it } from 'vitest';
import { enrichDialogExamples, type DialogLine } from './dialogExamples';

describe('report checklist: examples remain visible for mixed normal turns', () => {
  const line: DialogLine = { role: 'manager', text: 'Обмен возможен.', mark: 'normal', comment: 'Не объяснил порядок оценки.', betterExample: 'Обмен возможен. После осмотра согласуем оценку и доплату.' };
  it('keeps the server canonical example for Можно лучше and Плохо, not for positive/client', () => {
    expect(enrichDialogExamples([line], [])[0].betterExample).toBe(line.betterExample);
    expect(enrichDialogExamples([{ ...line, mark: 'negative' }], [])[0].betterExample).toBe(line.betterExample);
    expect(enrichDialogExamples([{ ...line, mark: 'positive' }], [])[0].betterExample).toBeNull();
    expect(enrichDialogExamples([{ ...line, role: 'client' }], [])[0].betterExample).toBeNull();
  });
  it('can use a matching finding for legacy normal turns but does not match an unrelated quote prefix', () => {
    const findings = [{ problemTitle: 'Ошибка', category: 'Продукт' as const, importance: 'Важно' as const, quote: line.text, comment: 'Нет деталей.', betterExample: line.betterExample! }];
    expect(enrichDialogExamples([{ ...line, betterExample: null }], findings)[0].betterExample).toBe(line.betterExample);
    const prefix = 'Подробное описание автомобиля и условий предложения';
    expect(enrichDialogExamples([{ ...line, text: `${prefix} с другой ценой`, betterExample: null }], [{ ...findings[0], quote: `${prefix} с исходной ценой` }])[0].betterExample).toBeNull();
  });
});
