import { describe, expect, it } from 'vitest';
import { parseVoximplantExpense } from '../economics/providerCosts';

describe('Voximplant transaction parser', () => {
  it('turns a phone number debit into a positive expense', () => {
    expect(parseVoximplantExpense({
      transaction_id: 42,
      transaction_type: 'phone_number_charge',
      amount: '-412.765',
      currency: 'RUR',
      performed_at: '2026-10-01 12:30:00',
    })).toMatchObject({
      externalId: 'transaction:42', category: 'phone_number', type: 'phone_number_charge',
      amount: 412.765, currency: 'RUB', occurredAt: new Date('2026-10-01T12:30:00Z'),
    });
  });

  it('does not treat an account top-up as an expense', () => {
    expect(parseVoximplantExpense({
      transaction_id: 43,
      transaction_type: 'rub_card_payment',
      amount: '2000',
      currency: 'RUR',
      performed_at: '2026-10-01 12:30:00',
    })).toBeNull();
  });
});
