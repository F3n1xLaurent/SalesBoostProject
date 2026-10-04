import { describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  config: {
    bitrix24SupportTokenKey: 'test-only-support-token-encryption-key',
    bitrix24SupportClientId: undefined,
    bitrix24SupportClientSecret: undefined,
    bitrix24SupportLineId: undefined,
    bitrix24SupportDealCategoryId: undefined,
    bitrix24SupportConnectorId: 'salsa_support',
    bitrix24SupportFieldsJson: undefined,
    miniAppUrl: 'https://app.example.test',
  },
}));

import { decryptBitrixToken, encryptBitrixToken } from '../support/bitrix24';

describe('Bitrix24 support token storage', () => {
  it('encrypts tokens with a unique IV and decrypts them losslessly', () => {
    const token = 'oauth-token-that-must-not-be-stored-as-plain-text';
    const first = encryptBitrixToken(token);
    const second = encryptBitrixToken(token);

    expect(first).not.toBe(token);
    expect(second).not.toBe(first);
    expect(decryptBitrixToken(first)).toBe(token);
    expect(decryptBitrixToken(second)).toBe(token);
  });

  it('rejects a modified encrypted token', () => {
    const encrypted = encryptBitrixToken('secret');
    const [iv, tag, payload] = encrypted.split('.');
    const modifiedPayload = `${payload[0] === 'A' ? 'B' : 'A'}${payload.slice(1)}`;
    expect(() => decryptBitrixToken(`${iv}.${tag}.${modifiedPayload}`)).toThrow();
  });
});
