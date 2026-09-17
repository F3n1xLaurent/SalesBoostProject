import {
  BITRIX24_LANDING_DEAL_CATEGORY_ID,
  BITRIX24_MARKETING_FIELD,
  BITRIX24_PERSONAL_DATA_FIELD,
  Bitrix24RequestError,
  Bitrix24WebhookClient,
  type Bitrix24Api,
} from './bitrix24LandingLead';

const DEMO_CONTACT_NAME = 'Клиент на демо';
const DEMO_DEAL_TITLE = 'Инициация демо-звонка';
const DEMO_ORIGINATOR_ID = 'salesboost_demo_call';

type DuplicateSearchResult = Record<string, Array<string | number> | undefined> | unknown[];
type BitrixEntity = { ID?: string | number };

export type DemoCallBitrix24Payload = {
  callId: string;
  phone: string;
};

export type DemoCallBitrix24Result = {
  contactId: string;
  dealId: string;
  contactCreated: boolean;
  dealAlreadyExisted: boolean;
};

function entityId(value: unknown, method: string): string {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!id || !/^\d+$/.test(id)) throw new Bitrix24RequestError(method, 200, 'INVALID_RESULT');
  return id;
}

async function resolveDemoContact(
  api: Bitrix24Api,
  phone: string,
): Promise<{ contactId: string; contactCreated: boolean }> {
  const duplicates = await api.call<DuplicateSearchResult>('crm.duplicate.findbycomm', {
    entity_type: 'CONTACT',
    type: 'PHONE',
    values: [phone],
  });
  const duplicateIds = duplicates && typeof duplicates === 'object' && !Array.isArray(duplicates)
    ? (duplicates.CONTACT ?? duplicates.contact)
    : undefined;
  if (Array.isArray(duplicateIds) && duplicateIds.length > 0) {
    return {
      contactId: entityId(duplicateIds[0], 'crm.duplicate.findbycomm'),
      contactCreated: false,
    };
  }

  const contactId = entityId(await api.call<string | number>('crm.contact.add', {
    fields: {
      NAME: DEMO_CONTACT_NAME,
      PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }],
      [BITRIX24_PERSONAL_DATA_FIELD]: 1,
      [BITRIX24_MARKETING_FIELD]: 0,
    },
    params: { REGISTER_SONET_EVENT: 'N' },
  }), 'crm.contact.add');
  return { contactId, contactCreated: true };
}

export async function submitDemoCallToBitrix24(
  api: Bitrix24Api,
  payload: DemoCallBitrix24Payload,
): Promise<DemoCallBitrix24Result> {
  const { contactId, contactCreated } = await resolveDemoContact(api, payload.phone);
  const existingDeals = await api.call<BitrixEntity[]>('crm.deal.list', {
    filter: {
      '=ORIGINATOR_ID': DEMO_ORIGINATOR_ID,
      '=ORIGIN_ID': payload.callId,
    },
    select: ['ID'],
    order: { ID: 'ASC' },
  });
  if (!Array.isArray(existingDeals)) throw new Bitrix24RequestError('crm.deal.list', 200, 'INVALID_RESULT');
  if (existingDeals[0]?.ID != null) {
    return {
      contactId,
      dealId: entityId(existingDeals[0].ID, 'crm.deal.list'),
      contactCreated,
      dealAlreadyExisted: true,
    };
  }

  const dealId = entityId(await api.call<string | number>('crm.deal.add', {
    fields: {
      TITLE: DEMO_DEAL_TITLE,
      CATEGORY_ID: BITRIX24_LANDING_DEAL_CATEGORY_ID,
      CONTACT_ID: contactId,
      COMMENTS: `Инициирован звонок с демо-стенда.\nCall ID: ${payload.callId}`,
      SOURCE_ID: 'WEB',
      SOURCE_DESCRIPTION: 'Демо-стенд Salsa',
      ORIGINATOR_ID: DEMO_ORIGINATOR_ID,
      ORIGIN_ID: payload.callId,
    },
    params: { REGISTER_SONET_EVENT: 'Y' },
  }), 'crm.deal.add');

  return { contactId, dealId, contactCreated, dealAlreadyExisted: false };
}

export type DemoCallBitrix24Notifier = (payload: DemoCallBitrix24Payload) => void;

export function createDemoCallBitrix24Notifier(webhookUrl: string | undefined): DemoCallBitrix24Notifier {
  let api: Bitrix24WebhookClient | null = null;
  if (webhookUrl) {
    try {
      api = new Bitrix24WebhookClient(webhookUrl);
    } catch {
      console.error('[demo-call/bitrix24] invalid BITRIX24_WEBHOOK_URL; CRM notification disabled');
    }
  }

  return (payload) => {
    if (!api) {
      console.warn(`[demo-call/bitrix24] skipped call_id=${payload.callId} reason=not_configured`);
      return;
    }
    console.info(`[demo-call/bitrix24] scheduled call_id=${payload.callId}`);
    void submitDemoCallToBitrix24(api, payload)
      .then((result) => {
        console.info(`[demo-call/bitrix24] saved call_id=${payload.callId} deal_id=${result.dealId}`);
      })
      .catch((error) => {
        if (error instanceof Bitrix24RequestError) {
          console.error(
            `[demo-call/bitrix24] failed call_id=${payload.callId} method=${error.method} status=${error.upstreamStatus ?? 'network'} code=${error.upstreamCode ?? 'unknown'}`,
          );
          return;
        }
        console.error(`[demo-call/bitrix24] failed call_id=${payload.callId} reason=unexpected_error`);
      });
  };
}
