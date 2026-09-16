import { describe, expect, it } from 'vitest';
import {
  BITRIX24_LANDING_DEAL_CATEGORY_ID,
  BITRIX24_MARKETING_FIELD,
  BITRIX24_PERSONAL_DATA_FIELD,
  Bitrix24WebhookClient,
  normalizeRussianPhone,
  parseLandingLead,
  submitLandingLeadToBitrix24,
  type Bitrix24Api,
} from '../integrations/bitrix24LandingLead';

class FakeBitrix24Api implements Bitrix24Api {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(private readonly responses: Record<string, unknown[]>) {}

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const queue = this.responses[method];
    if (!queue?.length) throw new Error(`Unexpected Bitrix24 method: ${method}`);
    return queue.shift() as T;
  }
}

const lead = {
  name: 'Анна',
  company: 'ООО Сальса',
  phone: '+79990000000',
  comment: 'Позвонить после 15:00',
  personalDataConsent: true as const,
  marketingConsent: true,
};

describe('landing lead validation', () => {
  it('normalizes Russian phone formats', () => {
    expect(normalizeRussianPhone('+7 999 000-00-00')).toBe('+79990000000');
    expect(normalizeRussianPhone('8 (999) 000-00-00')).toBe('+79990000000');
    expect(normalizeRussianPhone('9990000000')).toBe('+79990000000');
    expect(normalizeRussianPhone('+1 999 000-00-00')).toBeNull();
  });

  it('requires personal-data consent and accepts the optional honeypot', () => {
    expect(parseLandingLead({
      ...lead,
      personalDataConsent: false,
      website: '',
    }).ok).toBe(false);
    expect(parseLandingLead({ ...lead, website: 'spam.example' })).toMatchObject({
      ok: true,
      honeypotTriggered: true,
    });
  });
});

describe('Bitrix24 landing lead submission', () => {
  it('creates a company, contact and deal in category 2', async () => {
    const api = new FakeBitrix24Api({
      'crm.company.list': [[]],
      'crm.company.add': [101],
      'crm.duplicate.findbycomm': [{}],
      'crm.contact.add': [202],
      'crm.deal.list': [[]],
      'crm.deal.add': [303],
    });

    await expect(submitLandingLeadToBitrix24(api, lead, 'landing-test')).resolves.toEqual({
      companyId: '101',
      contactId: '202',
      dealId: '303',
      dealAlreadyExisted: false,
    });

    const contactFields = api.calls.find((call) => call.method === 'crm.contact.add')?.params.fields as Record<string, unknown>;
    expect(contactFields).toMatchObject({
      NAME: lead.name,
      COMPANY_ID: '101',
      [BITRIX24_PERSONAL_DATA_FIELD]: 1,
      [BITRIX24_MARKETING_FIELD]: 1,
    });
    expect(contactFields.PHONE).toEqual([{ VALUE: lead.phone, VALUE_TYPE: 'WORK' }]);

    const dealFields = api.calls.find((call) => call.method === 'crm.deal.add')?.params.fields as Record<string, unknown>;
    expect(dealFields).toMatchObject({
      CATEGORY_ID: BITRIX24_LANDING_DEAL_CATEGORY_ID,
      CONTACT_ID: '202',
      COMPANY_ID: '101',
      COMMENTS: lead.comment,
      ORIGINATOR_ID: 'salesboost_landing',
      ORIGIN_ID: 'landing-test',
    });
  });

  it('reuses existing entities and does not create a duplicate deal', async () => {
    const api = new FakeBitrix24Api({
      'crm.company.list': [[{ ID: '11', TITLE: 'ООО Сальса' }]],
      'crm.duplicate.findbycomm': [{ CONTACT: ['22'] }],
      'crm.contact.update': [true],
      'crm.deal.list': [[{ ID: '33' }]],
    });

    await expect(submitLandingLeadToBitrix24(api, { ...lead, marketingConsent: false }, 'same-request')).resolves.toEqual({
      companyId: '11',
      contactId: '22',
      dealId: '33',
      dealAlreadyExisted: true,
    });
    expect(api.calls.map((call) => call.method)).toEqual([
      'crm.company.list',
      'crm.duplicate.findbycomm',
      'crm.contact.update',
      'crm.deal.list',
    ]);
    const updatedFields = api.calls.find((call) => call.method === 'crm.contact.update')?.params.fields as Record<string, unknown>;
    expect(updatedFields[BITRIX24_MARKETING_FIELD]).toBe(0);
  });

  it('rejects unsafe webhook URLs before making requests', () => {
    expect(() => new Bitrix24WebhookClient('http://example.bitrix24.ru/rest/20/token/')).toThrow('HTTPS');
    expect(() => new Bitrix24WebhookClient('https://example.bitrix24.ru/not-a-webhook/')).toThrow('inbound webhook');
  });
});
