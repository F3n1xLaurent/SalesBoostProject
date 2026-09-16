import { z } from 'zod';

export const BITRIX24_PERSONAL_DATA_FIELD = 'UF_CRM_1789548403944';
export const BITRIX24_MARKETING_FIELD = 'UF_CRM_1789548426686';
export const BITRIX24_LANDING_DEAL_CATEGORY_ID = 2;

const LandingLeadSchema = z.object({
  name: z.string().trim().min(2).max(100),
  company: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(10).max(32),
  comment: z.string().trim().max(2_000).optional().default(''),
  personalDataConsent: z.literal(true),
  marketingConsent: z.boolean(),
  // Invisible field on the landing. A non-empty value means that a bot filled the form.
  website: z.string().max(200).optional().default(''),
}).strict();

export type LandingLead = {
  name: string;
  company: string;
  phone: string;
  comment: string;
  personalDataConsent: true;
  marketingConsent: boolean;
};

export type LandingLeadParseResult =
  | { ok: true; value: LandingLead; honeypotTriggered: boolean }
  | { ok: false };

export function normalizeRussianPhone(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length !== 11 || !digits.startsWith('7')) return null;
  return `+${digits}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function parseLandingLead(value: unknown): LandingLeadParseResult {
  const parsed = LandingLeadSchema.safeParse(value);
  if (!parsed.success) return { ok: false };
  const phone = normalizeRussianPhone(parsed.data.phone);
  if (!phone) return { ok: false };
  return {
    ok: true,
    honeypotTriggered: parsed.data.website.trim().length > 0,
    value: {
      name: singleLine(parsed.data.name),
      company: singleLine(parsed.data.company),
      phone,
      comment: parsed.data.comment,
      personalDataConsent: true,
      marketingConsent: parsed.data.marketingConsent,
    },
  };
}

type Bitrix24Envelope<T> = {
  result?: T;
  error?: string;
  error_description?: string;
};

export class Bitrix24RequestError extends Error {
  constructor(
    public readonly method: string,
    public readonly upstreamStatus: number | null,
    public readonly upstreamCode: string | null,
  ) {
    super(`Bitrix24 request failed: ${method}`);
    this.name = 'Bitrix24RequestError';
  }
}

export interface Bitrix24Api {
  call<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export class Bitrix24WebhookClient implements Bitrix24Api {
  private readonly webhookBaseUrl: URL;

  constructor(webhookUrl: string, private readonly timeoutMs = 15_000) {
    const url = new URL(webhookUrl);
    if (url.protocol !== 'https:') {
      throw new Error('BITRIX24_WEBHOOK_URL must use HTTPS');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('BITRIX24_WEBHOOK_URL must not contain credentials, query parameters or a hash');
    }
    if (!/^\/rest\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
      throw new Error('BITRIX24_WEBHOOK_URL must point to a Bitrix24 inbound webhook');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    this.webhookBaseUrl = url;
  }

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!/^[a-z0-9_.]+$/i.test(method)) throw new Error('Invalid Bitrix24 method name');
    const endpoint = new URL(`${method}.json`, this.webhookBaseUrl);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Bitrix24RequestError(method, null, 'NETWORK_ERROR');
    }

    let payload: Bitrix24Envelope<T> | null = null;
    try {
      payload = await response.json() as Bitrix24Envelope<T>;
    } catch {
      throw new Bitrix24RequestError(method, response.status, 'INVALID_RESPONSE');
    }
    if (!response.ok || payload.error || payload.result === undefined) {
      throw new Bitrix24RequestError(method, response.status, payload.error ?? 'UNKNOWN_ERROR');
    }
    return payload.result;
  }
}

type BitrixEntity = {
  ID?: string | number;
  TITLE?: string;
};

type DuplicateSearchResult = Record<string, Array<string | number> | undefined> | unknown[];

export type Bitrix24LandingLeadResult = {
  contactId: string;
  companyId: string;
  dealId: string;
  dealAlreadyExisted: boolean;
};

function entityId(value: unknown, method: string): string {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!id || !/^\d+$/.test(id)) throw new Bitrix24RequestError(method, 200, 'INVALID_RESULT');
  return id;
}

function comparableTitle(value: string): string {
  return singleLine(value).toLocaleLowerCase('ru-RU');
}

async function resolveCompany(api: Bitrix24Api, companyTitle: string): Promise<string> {
  const companies = await api.call<BitrixEntity[]>('crm.company.list', {
    filter: { '=TITLE': companyTitle },
    select: ['ID', 'TITLE'],
    order: { ID: 'ASC' },
  });
  if (!Array.isArray(companies)) throw new Bitrix24RequestError('crm.company.list', 200, 'INVALID_RESULT');
  const expectedTitle = comparableTitle(companyTitle);
  const existing = companies.find((company) =>
    company.TITLE != null && comparableTitle(String(company.TITLE)) === expectedTitle,
  );
  if (existing?.ID != null) return entityId(existing.ID, 'crm.company.list');

  const added = await api.call<string | number>('crm.company.add', {
    fields: { TITLE: companyTitle },
    params: { REGISTER_SONET_EVENT: 'N' },
  });
  return entityId(added, 'crm.company.add');
}

async function resolveContact(
  api: Bitrix24Api,
  lead: LandingLead,
  companyId: string,
): Promise<string> {
  const duplicates = await api.call<DuplicateSearchResult>('crm.duplicate.findbycomm', {
    entity_type: 'CONTACT',
    type: 'PHONE',
    values: [lead.phone],
  });
  const duplicateIds = duplicates && typeof duplicates === 'object' && !Array.isArray(duplicates)
    ? (duplicates.CONTACT ?? duplicates.contact)
    : undefined;
  const existingId = Array.isArray(duplicateIds) && duplicateIds.length > 0
    ? entityId(duplicateIds[0], 'crm.duplicate.findbycomm')
    : null;
  const consentFields = {
    [BITRIX24_PERSONAL_DATA_FIELD]: 1,
    [BITRIX24_MARKETING_FIELD]: lead.marketingConsent ? 1 : 0,
  };

  if (existingId) {
    await api.call<boolean>('crm.contact.update', {
      id: existingId,
      fields: {
        NAME: lead.name,
        COMPANY_ID: companyId,
        ...consentFields,
      },
      params: { REGISTER_SONET_EVENT: 'N' },
    });
    return existingId;
  }

  const added = await api.call<string | number>('crm.contact.add', {
    fields: {
      NAME: lead.name,
      COMPANY_ID: companyId,
      PHONE: [{ VALUE: lead.phone, VALUE_TYPE: 'WORK' }],
      ...consentFields,
    },
    params: { REGISTER_SONET_EVENT: 'N' },
  });
  return entityId(added, 'crm.contact.add');
}

export async function submitLandingLeadToBitrix24(
  api: Bitrix24Api,
  lead: LandingLead,
  originId: string,
): Promise<Bitrix24LandingLeadResult> {
  const companyId = await resolveCompany(api, lead.company);
  const contactId = await resolveContact(api, lead, companyId);

  const existingDeals = await api.call<BitrixEntity[]>('crm.deal.list', {
    filter: {
      '=ORIGINATOR_ID': 'salesboost_landing',
      '=ORIGIN_ID': originId,
    },
    select: ['ID'],
    order: { ID: 'ASC' },
  });
  if (!Array.isArray(existingDeals)) throw new Bitrix24RequestError('crm.deal.list', 200, 'INVALID_RESULT');
  if (existingDeals[0]?.ID != null) {
    return {
      contactId,
      companyId,
      dealId: entityId(existingDeals[0].ID, 'crm.deal.list'),
      dealAlreadyExisted: true,
    };
  }

  const dealId = entityId(await api.call<string | number>('crm.deal.add', {
    fields: {
      TITLE: `Заявка на демо — ${lead.company}`,
      CATEGORY_ID: BITRIX24_LANDING_DEAL_CATEGORY_ID,
      CONTACT_ID: contactId,
      COMPANY_ID: companyId,
      COMMENTS: lead.comment,
      SOURCE_ID: 'WEB',
      SOURCE_DESCRIPTION: 'Лендинг Salsa',
      ORIGINATOR_ID: 'salesboost_landing',
      ORIGIN_ID: originId,
    },
    params: { REGISTER_SONET_EVENT: 'Y' },
  }), 'crm.deal.add');

  return { contactId, companyId, dealId, dealAlreadyExisted: false };
}
