import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  validateOrganizationName,
} from '../auth/organizationNameValidation';
import { validateOrganizationName as validateFrontendOrganizationName } from '../../admin-frontend/src/shared/lib/organization-name-validation';

describe('organization name validation', () => {
  it('accepts realistic company and dealership names', () => {
    expect(validateOrganizationName('ООО «Авто-Плюс №1»', 'holding')).toBeNull();
    expect(validateOrganizationName('Salsa Motors: Юг (Сервис/Trade-in)', 'dealership')).toBeNull();
  });

  it('rejects names made only from punctuation', () => {
    expect(validateOrganizationName('---', 'holding')).toBe('Название компании содержит недопустимые символы.');
  });

  it('rejects unsafe and unsupported special characters', () => {
    expect(validateOrganizationName('<script>alert(1)</script>', 'holding')).toBe('Название компании содержит недопустимые символы.');
    expect(validateOrganizationName('Точка @ Север', 'dealership')).toBe('Название точки содержит недопустимые символы.');
  });

  it('enforces the normalized length limits', () => {
    expect(validateOrganizationName('Я', 'dealership')).toContain('от 2 до 100');
    expect(validateOrganizationName('А'.repeat(ORGANIZATION_NAME_MAX_LENGTH + 1), 'holding')).toContain('от 2 до 100');
  });

  it('keeps frontend and backend validation rules in sync', () => {
    for (const value of ['ООО «Авто-Плюс №1»', 'Точка @ Север', '---', 'Я', 'Salsa Motors: Юг']) {
      expect(validateFrontendOrganizationName(value, 'holding')).toBe(validateOrganizationName(value, 'holding'));
      expect(validateFrontendOrganizationName(value, 'dealership')).toBe(validateOrganizationName(value, 'dealership'));
    }
  });
});
