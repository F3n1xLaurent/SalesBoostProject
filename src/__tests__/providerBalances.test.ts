import { describe, expect, it } from 'vitest';
import {
  parseElevenLabsBalance,
  parseProxyApiBalance,
  parseVoximplantBalance,
} from '../economics/providerBalances';

describe('provider balance parsers', () => {
  it('reads ProxyAPI account and key-budget balances', () => {
    expect(parseProxyApiBalance({ balance: 37.66, budget: { limit: 50, used: 12.34 } })).toMatchObject({
      provider: 'proxyapi', balance: 37.66, used: 12.34, limit: 50, currency: 'RUB', unit: 'money',
    });
  });

  it('calculates remaining ElevenLabs credits', () => {
    expect(parseElevenLabsBalance({
      character_count: 81_413, character_limit: 1_800_000,
      next_character_count_reset_unix: 1_792_909_293,
    })).toMatchObject({
      provider: 'elevenlabs', balance: 1_718_587, used: 81_413, limit: 1_800_000, unit: 'credits',
    });
  });

  it('normalizes Voximplant RUR to RUB', () => {
    expect(parseVoximplantBalance({ result: { balance: 565.13, currency: 'RUR', credit_limit: 0 } })).toMatchObject({
      provider: 'voximplant', balance: 565.13, currency: 'RUB', unit: 'money',
    });
  });
});
