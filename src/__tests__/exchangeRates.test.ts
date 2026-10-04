import { describe, expect, it } from 'vitest';
import { parseCbrDailyRates } from '../economics/exchangeRates';

describe('CBR daily exchange rates', () => {
  it('normalizes nominal values and comma decimals', () => {
    const result = parseCbrDailyRates(`<?xml version="1.0" encoding="windows-1251"?>
      <ValCurs Date="02.10.2026" name="Foreign Currency Market">
        <Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Value>95,5000</Value></Valute>
        <Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>10</Nominal><Value>130,2500</Value></Valute>
      </ValCurs>`, ['USD', 'CNY']);

    expect(result.effectiveDate.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(result.rates).toEqual([
      { currency: 'USD', rate: 95.5 },
      { currency: 'CNY', rate: 13.025 },
    ]);
  });

  it('returns only requested currencies', () => {
    const result = parseCbrDailyRates(`<ValCurs Date="02.10.2026">
      <Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>95,5</Value></Valute>
      <Valute><CharCode>EUR</CharCode><Nominal>1</Nominal><Value>111,2</Value></Valute>
    </ValCurs>`, ['EUR']);
    expect(result.rates).toEqual([{ currency: 'EUR', rate: 111.2 }]);
  });
});
