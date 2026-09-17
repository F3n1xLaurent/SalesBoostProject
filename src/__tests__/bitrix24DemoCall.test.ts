import { describe, expect, it } from 'vitest';
import {
  BITRIX24_LANDING_DEAL_CATEGORY_ID,
  BITRIX24_MARKETING_FIELD,
  BITRIX24_PERSONAL_DATA_FIELD,
  type Bitrix24Api,
} from '../integrations/bitrix24LandingLead';
import { submitDemoCallToBitrix24 } from '../integrations/bitrix24DemoCall';

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

const payload = { callId: 'demo-call-42', phone: '+79990000000' };

describe('Bitrix24 demo call submission', () => {
  it('создаёт контакт-заглушку и сделку для нового номера', async () => {
    const api = new FakeBitrix24Api({
      'crm.duplicate.findbycomm': [{}],
      'crm.contact.add': [101],
      'crm.deal.list': [[]],
      'crm.deal.add': [202],
    });

    await expect(submitDemoCallToBitrix24(api, payload)).resolves.toEqual({
      contactId: '101',
      dealId: '202',
      contactCreated: true,
      dealAlreadyExisted: false,
    });

    const contactFields = api.calls.find((call) => call.method === 'crm.contact.add')?.params.fields as Record<string, unknown>;
    expect(contactFields).toMatchObject({
      NAME: 'Клиент на демо',
      [BITRIX24_PERSONAL_DATA_FIELD]: 1,
      [BITRIX24_MARKETING_FIELD]: 0,
    });
    expect(contactFields.PHONE).toEqual([{ VALUE: payload.phone, VALUE_TYPE: 'WORK' }]);

    const dealFields = api.calls.find((call) => call.method === 'crm.deal.add')?.params.fields as Record<string, unknown>;
    expect(dealFields).toMatchObject({
      TITLE: 'Инициация демо-звонка',
      CATEGORY_ID: BITRIX24_LANDING_DEAL_CATEGORY_ID,
      CONTACT_ID: '101',
      ORIGINATOR_ID: 'salesboost_demo_call',
      ORIGIN_ID: payload.callId,
      SOURCE_DESCRIPTION: 'Демо-стенд Salsa',
    });
  });

  it('переиспользует контакт по телефону и не дублирует сделку по callId', async () => {
    const api = new FakeBitrix24Api({
      'crm.duplicate.findbycomm': [{ CONTACT: ['55'] }],
      'crm.deal.list': [[{ ID: '77' }]],
    });

    await expect(submitDemoCallToBitrix24(api, payload)).resolves.toEqual({
      contactId: '55',
      dealId: '77',
      contactCreated: false,
      dealAlreadyExisted: true,
    });
    expect(api.calls.map((call) => call.method)).toEqual([
      'crm.duplicate.findbycomm',
      'crm.deal.list',
    ]);
  });
});
