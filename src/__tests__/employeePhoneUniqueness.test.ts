import { describe, expect, it, vi } from 'vitest';
import {
  assertEmployeePhoneUniqueWithinDealerships,
  normalizeEmployeePhoneKey,
} from '../auth/employeePhoneUniqueness';

describe('employee phone uniqueness normalization', () => {
  it('treats common Russian phone formats as the same number', () => {
    const expected = '79991234567';
    expect(normalizeEmployeePhoneKey('+7 999 123-45-67')).toBe(expected);
    expect(normalizeEmployeePhoneKey('8 (999) 123 45 67')).toBe(expected);
    expect(normalizeEmployeePhoneKey('9991234567')).toBe(expected);
  });

  it('keeps non-Russian international numbers comparable by digits', () => {
    expect(normalizeEmployeePhoneKey('+375 (29) 123-45-67')).toBe('375291234567');
  });

  it('reports the employee who already owns the number in the same dealership', async () => {
    const managerProfileFindMany = vi.fn()
      .mockResolvedValueOnce([{ dealershipId: 'dealership-1' }])
      .mockResolvedValueOnce([
        { accountId: 'account-1', fullName: 'Пётр Петров', dealershipId: 'dealership-1', phone: null },
        { accountId: 'account-2', fullName: 'Иван Иванов', dealershipId: 'dealership-1', phone: null },
      ]);
    const db = {
      managerProfile: { findMany: managerProfileFindMany },
      phoneNumber: {
        findMany: vi.fn().mockResolvedValue([
          { accountId: 'account-2', phone: '8 999 123-45-67' },
        ]),
      },
    };

    await expect(assertEmployeePhoneUniqueWithinDealerships(db as never, {
      accountId: 'account-1',
      phone: '+7 (999) 123-45-67',
    })).rejects.toThrow('Номер телефона уже принадлежит сотруднику Иван Иванов');
  });

  it('also detects a legacy phone stored in the employee profile', async () => {
    const db = {
      managerProfile: {
        findMany: vi.fn()
          .mockResolvedValueOnce([{ dealershipId: 'dealership-1' }])
          .mockResolvedValueOnce([
            { accountId: 'account-2', fullName: 'Иван Иванов', dealershipId: 'dealership-1', phone: '89991234567' },
          ]),
      },
      phoneNumber: { findMany: vi.fn() },
    };

    await expect(assertEmployeePhoneUniqueWithinDealerships(db as never, {
      accountId: 'account-1',
      phone: '+7 999 123 45 67',
    })).rejects.toThrow('Номер телефона уже принадлежит сотруднику Иван Иванов');
    expect(db.phoneNumber.findMany).not.toHaveBeenCalled();
  });
});
