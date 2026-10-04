import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import {
  MAX_SUPPORT_ATTACHMENT_BYTES,
  supportAttachmentExtension,
  supportAttachmentKey,
  supportAttachmentStorage,
} from '../storage/supportAttachmentStorage';
import { signSupportAttachmentLink } from './attachmentLinks';

const PROCESS_INTERVAL_MS = 15_000;
const CONNECTOR_NAME = 'Salsa · Техническая поддержка';
const MAX_ATTEMPTS = 12;
const ATTACHMENT_LINK_TTL_MS = 24 * 60 * 60 * 1000;
let schedulerStarted = false;
let processorRunning = false;
let refreshPromise: Promise<void> | null = null;
let configurationRecoveryAttempted = false;
let discoveredFieldsCache: { expiresAt: number; value: DealFieldMap } | null = null;
let dealFieldsCache: { expiresAt: number; value: Record<string, Record<string, unknown>> } | null = null;
let staleSupportCategories: string[] = [];
let contactProductIdFieldCache: string | null = null;

type BitrixAuth = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  domain?: unknown;
  client_endpoint?: unknown;
  server_endpoint?: unknown;
  member_id?: unknown;
  application_token?: unknown;
};

type DealFieldMap = Partial<Record<
  'ticketNumber' | 'productUserId' | 'productDialogId' | 'bitrixSessionId' |
  'initiatorConfirmed' | 'category' | 'subcategory' | 'priority' | 'firstMessageAt' | 'channel',
  string
>>;

class BitrixSupportError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = 'BitrixSupportError';
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenKey(): Buffer {
  const secret = config.bitrix24SupportTokenKey;
  if (!secret || secret.length < 24) throw new BitrixSupportError('TOKEN_KEY_NOT_CONFIGURED');
  return createHash('sha256').update(secret).digest();
}

export function encryptBitrixToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptBitrixToken(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new BitrixSupportError('INVALID_ENCRYPTED_TOKEN');
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function endpoint(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.')) throw new BitrixSupportError('INVALID_ENDPOINT');
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function fieldMap(): DealFieldMap {
  if (!config.bitrix24SupportFieldsJson) return {};
  try {
    const value = JSON.parse(config.bitrix24SupportFieldsJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, field]) => typeof field === 'string' && /^UF_CRM_[A-Z0-9_]+$/i.test(field))) as DealFieldMap;
  } catch {
    throw new BitrixSupportError('INVALID_SUPPORT_FIELDS_JSON');
  }
}

const DEAL_FIELD_TITLES: Record<keyof DealFieldMap, string[]> = {
  ticketNumber: ['номер обращения'],
  productUserId: ['id пользователя продукта'],
  productDialogId: ['id диалога продукта'],
  bitrixSessionId: ['id сессии / диалога б24', 'id сессии диалога б24'],
  initiatorConfirmed: ['инициатор подтверждён', 'инициатор подтвержден'],
  category: ['категория технической поддержки'],
  subcategory: ['подкатегория технической поддержки'],
  priority: ['приоритет'],
  firstMessageAt: ['дата первого сообщения'],
  channel: ['канал обращения'],
};

const CONNECTOR_ICON_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 70"><rect width="70" height="70" rx="18" fill="#171714"/><path d="M20 23h30v20H33l-9 8v-8h-4z" fill="white"/><circle cx="29" cy="33" r="2.5" fill="#171714"/><circle cx="35" cy="33" r="2.5" fill="#171714"/><circle cx="41" cy="33" r="2.5" fill="#171714"/></svg>',
);

const CONNECTOR_ICON = {
  DATA_IMAGE: `data:image/svg+xml;charset=US-ASCII,${CONNECTOR_ICON_SVG}`,
  COLOR: '#171714',
  SIZE: '100%',
  POSITION: 'center',
};

function normalizedTitle(value: unknown): string {
  return stringValue(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
}

async function resolvedFieldMap(): Promise<DealFieldMap> {
  const overrides = fieldMap();
  if (discoveredFieldsCache && discoveredFieldsCache.expiresAt > Date.now()) {
    return { ...discoveredFieldsCache.value, ...overrides };
  }
  const fields = await loadDealFields();
  const discovered: DealFieldMap = {};
  for (const [fieldCode, description] of Object.entries(fields || {})) {
    if (!/^UF_CRM_/i.test(fieldCode)) continue;
    const titles = [description.title, description.listLabel, description.formLabel, description.filterLabel]
      .map(normalizedTitle)
      .filter(Boolean);
    for (const [logicalName, aliases] of Object.entries(DEAL_FIELD_TITLES)) {
      if (aliases.map(normalizedTitle).some((alias) => titles.includes(alias))) {
        discovered[logicalName as keyof DealFieldMap] = fieldCode;
      }
    }
  }
  discoveredFieldsCache = { expiresAt: Date.now() + 30 * 60_000, value: discovered };
  return { ...discovered, ...overrides };
}

async function loadDealFields(): Promise<Record<string, Record<string, unknown>>> {
  if (dealFieldsCache && dealFieldsCache.expiresAt > Date.now()) return dealFieldsCache.value;
  const value = await bitrixCall<Record<string, Record<string, unknown>>>('crm.deal.fields', {});
  dealFieldsCache = { expiresAt: Date.now() + 30 * 60_000, value };
  return value;
}

export async function getBitrixSupportCategories(): Promise<string[]> {
  try {
    const [map, fields] = await Promise.all([resolvedFieldMap(), loadDealFields()]);
    const items = map.category && Array.isArray(fields[map.category]?.items)
      ? fields[map.category].items as Array<Record<string, unknown>>
      : [];
    const categories = items.map((item) => stringValue(item.VALUE ?? item.value)).filter(Boolean);
    if (categories.length) staleSupportCategories = categories;
    return categories.length ? categories : staleSupportCategories;
  } catch {
    return staleSupportCategories;
  }
}

async function categoryValueForDeal(category: string, map: DealFieldMap): Promise<string> {
  if (!map.category) return category;
  const fields = await loadDealFields();
  const description = fields[map.category];
  if (!description || !Array.isArray(description.items)) return category;
  const item = (description.items as Array<Record<string, unknown>>).find((candidate) => (
    normalizedTitle(candidate.VALUE ?? candidate.value) === normalizedTitle(category)
  ));
  return stringValue(item?.ID ?? item?.id) || category;
}

async function ensureContactProductIdField(): Promise<string> {
  if (contactProductIdFieldCache) return contactProductIdFieldCache;
  const findField = async () => {
    const fields = await bitrixCall<Record<string, Record<string, unknown>>>('crm.contact.fields', {});
    return Object.entries(fields || {}).find(([code, description]) => (
      /^UF_CRM_/i.test(code)
      && [description.title, description.listLabel, description.formLabel, description.filterLabel]
        .map(normalizedTitle)
        .includes('id пользователя продукта')
    ))?.[0] || null;
  };
  const existing = await findField();
  if (existing) {
    contactProductIdFieldCache = existing;
    return existing;
  }
  await bitrixCall('crm.contact.userfield.add', {
    fields: {
      FIELD_NAME: 'SALSA_PRODUCT_USER_ID',
      XML_ID: 'SALSA_PRODUCT_USER_ID',
      USER_TYPE_ID: 'string',
      MULTIPLE: 'N',
      MANDATORY: 'N',
      SHOW_FILTER: 'Y',
      SHOW_IN_LIST: 'Y',
      EDIT_IN_LIST: 'N',
      IS_SEARCHABLE: 'Y',
      EDIT_FORM_LABEL: { ru: 'ID пользователя продукта', en: 'Product user ID' },
      LIST_COLUMN_LABEL: { ru: 'ID пользователя продукта', en: 'Product user ID' },
      LIST_FILTER_LABEL: { ru: 'ID пользователя продукта', en: 'Product user ID' },
    },
  });
  const created = await findField();
  if (!created) throw new BitrixSupportError('CONTACT_PRODUCT_ID_FIELD_NOT_FOUND');
  contactProductIdFieldCache = created;
  return created;
}

function integrationConfigured(): boolean {
  return Boolean(
    config.bitrix24SupportClientId
    && config.bitrix24SupportClientSecret
    && config.bitrix24SupportTokenKey
    && config.bitrix24SupportLineId,
  );
}

async function validateInitialAccessToken(clientEndpoint: string, accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('app.info.json', endpoint(clientEndpoint)), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth: accessToken }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as {
      result?: { STATUS?: unknown; INSTALLED?: unknown };
      error?: unknown;
    };
    return response.ok && !payload.error && payload.result?.STATUS === 'L';
  } catch {
    return false;
  }
}

async function refreshInstallation(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const installation = await prisma.supportBitrixInstallation.findFirst({ where: { status: 'active' } });
    if (!installation) throw new BitrixSupportError('INSTALLATION_NOT_FOUND');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.bitrix24SupportClientId || '',
      client_secret: config.bitrix24SupportClientSecret || '',
      refresh_token: decryptBitrixToken(installation.refreshTokenEncrypted),
    });
    const response = await fetch(`https://oauth.bitrix24.tech/oauth/token/?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const accessToken = stringValue(payload.access_token);
    const refreshToken = stringValue(payload.refresh_token);
    if (!response.ok || !accessToken || !refreshToken) {
      throw new BitrixSupportError(stringValue(payload.error) || 'TOKEN_REFRESH_FAILED');
    }
    const expiresIn = Math.max(60, Number(payload.expires_in) || 3600);
    await prisma.supportBitrixInstallation.update({
      where: { memberId: installation.memberId },
      data: {
        accessTokenEncrypted: encryptBitrixToken(accessToken),
        refreshTokenEncrypted: encryptBitrixToken(refreshToken),
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        clientEndpoint: stringValue(payload.client_endpoint) ? endpoint(stringValue(payload.client_endpoint)) : installation.clientEndpoint,
        lastRefreshedAt: new Date(),
        lastError: null,
      },
    });
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function bitrixCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
  if (!/^[a-z0-9_.]+$/i.test(method)) throw new BitrixSupportError('INVALID_METHOD');
  let installation = await prisma.supportBitrixInstallation.findFirst({ where: { status: 'active' } });
  if (!installation) throw new BitrixSupportError('INSTALLATION_NOT_FOUND');
  if (installation.accessTokenExpiresAt.getTime() <= Date.now() + 120_000) {
    await refreshInstallation();
    installation = await prisma.supportBitrixInstallation.findUnique({ where: { memberId: installation.memberId } });
    if (!installation) throw new BitrixSupportError('INSTALLATION_NOT_FOUND');
  }

  const call = async () => {
    const response = await fetch(new URL(`${method}.json`, endpoint(installation!.clientEndpoint)), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, auth: decryptBitrixToken(installation!.accessTokenEncrypted) }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as { result?: T; error?: string; error_description?: string };
    return { response, payload };
  };

  let result = await call();
  if (result.payload.error === 'expired_token') {
    await refreshInstallation();
    installation = await prisma.supportBitrixInstallation.findUnique({ where: { memberId: installation.memberId } });
    result = await call();
  }
  if (!result.response.ok || result.payload.error || result.payload.result === undefined) {
    throw new BitrixSupportError(result.payload.error || `HTTP_${result.response.status}`, result.payload.error_description);
  }
  return result.payload.result;
}

function installationAuth(body: any): BitrixAuth {
  return body?.auth && typeof body.auth === 'object' ? body.auth as BitrixAuth : {};
}

function publicBaseUrl(): string {
  return String(
    process.env.PUBLIC_BASE_URL
    || process.env.VOICE_DIALOG_BASE_URL
    || config.miniAppUrl,
  ).trim().replace(/\/$/, '');
}

async function configureConnector(): Promise<void> {
  const handler = `${publicBaseUrl()}/api/integrations/bitrix24/support/events`;
  const connector = config.bitrix24SupportConnectorId;
  const line = Number(config.bitrix24SupportLineId);
  if (!Number.isInteger(line) || line <= 0) throw new BitrixSupportError('INVALID_LINE_ID');
  await bitrixCall('imconnector.register', {
    ID: connector,
    NAME: CONNECTOR_NAME,
    ICON: CONNECTOR_ICON,
    ICON_DISABLED: { ...CONNECTOR_ICON, COLOR: '#9b9b94' },
    PLACEMENT_HANDLER: handler,
    // Bitrix CRM tracking is disabled for CHAT_GROUP connectors. Keep the
    // one-to-one mode and make user.id ticket-scoped below: every ticket still
    // gets its own dialog, while Bitrix can attach it to the existing contact.
    CHAT_GROUP: false,
  });
  for (const event of ['OnImConnectorMessageAdd', 'OnImConnectorDialogFinish']) {
    try {
      await bitrixCall('event.bind', { event, handler });
    } catch (error) {
      if (!(error instanceof BitrixSupportError) || error.code !== 'ERROR_CORE') throw error;
    }
  }
  await bitrixCall('imconnector.activate', { CONNECTOR: connector, LINE: line, ACTIVE: '1' });
  await bitrixCall('imconnector.connector.data.set', {
    CONNECTOR: connector,
    LINE: line,
    DATA: { ID: 'salsa-support', NAME: CONNECTOR_NAME, URL: publicBaseUrl() },
  });
}

export async function repairBitrixSupportConfiguration(): Promise<void> {
  if (!integrationConfigured()) return;
  const installation = await prisma.supportBitrixInstallation.findFirst({
    where: { status: { in: ['active', 'error'] } },
    orderBy: { installedAt: 'desc' },
  });
  if (!installation) return;
  if (installation.status === 'error') {
    await prisma.supportBitrixInstallation.update({
      where: { memberId: installation.memberId },
      data: { status: 'active', lastError: null },
    });
  }
  try {
    await configureConnector();
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1_000) : 'CONNECTOR_SETUP_FAILED';
    await prisma.supportBitrixInstallation.update({
      where: { memberId: installation.memberId },
      data: { status: 'error', lastError: message },
    });
    throw error;
  }
}

export async function inspectBitrixSupportConfiguration(): Promise<{ status: unknown; line: unknown; lines: unknown }> {
  const connector = config.bitrix24SupportConnectorId;
  const lineId = Number(config.bitrix24SupportLineId);
  const [status, line, lines] = await Promise.all([
    bitrixCall('imconnector.status', { CONNECTOR: connector, LINE: lineId }),
    bitrixCall('imopenlines.config.get', { CONFIG_ID: lineId, WITH_QUEUE: 'Y' }),
    bitrixCall('imopenlines.config.list.get', {
      PARAMS: {
        select: ['ID', 'LINE_NAME', 'ACTIVE'],
        order: { ID: 'ASC' },
        filter: { ACTIVE: 'Y' },
        limit: 50,
        offset: 0,
      },
      OPTIONS: { QUEUE: 'Y', CONFIG_QUEUE: 'Y' },
    }),
  ]);
  return { status, line, lines };
}

export async function handleBitrixSupportInstall(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!integrationConfigured()) {
    res.status(503).json({ error: 'Интеграция поддержки с Битрикс24 ещё не настроена в окружении.' });
    return;
  }
  const auth = installationAuth(req.body);
  const applicationToken = stringValue(auth.application_token);
  const memberId = stringValue(auth.member_id);
  const accessToken = stringValue(auth.access_token);
  const refreshToken = stringValue(auth.refresh_token);
  const domain = stringValue(auth.domain);
  const clientEndpoint = stringValue(auth.client_endpoint);
  if (!memberId || !accessToken || !refreshToken || !domain || !clientEndpoint || !applicationToken) {
    res.status(400).json({ error: 'Битрикс24 не передал обязательные параметры установки.' });
    return;
  }
  const existingInstallation = await prisma.supportBitrixInstallation.findUnique({ where: { memberId } });
  if (existingInstallation) {
    if (!secureEqual(sha256(applicationToken), existingInstallation.applicationTokenHash)) {
      res.status(403).json({ error: 'Токен приложения не совпадает с сохранённым при первой установке.' });
      return;
    }
  } else if (!await validateInitialAccessToken(clientEndpoint, accessToken)) {
    res.status(403).json({ error: 'Не удалось подтвердить установочный запрос через API Битрикс24.' });
    return;
  }
  const expiresIn = Math.max(60, Number(auth.expires_in) || 3600);
  await prisma.supportBitrixInstallation.upsert({
    where: { memberId },
    create: {
      memberId,
      domain,
      clientEndpoint: endpoint(clientEndpoint),
      serverEndpoint: stringValue(auth.server_endpoint) || 'https://oauth.bitrix24.tech/rest/',
      accessTokenEncrypted: encryptBitrixToken(accessToken),
      refreshTokenEncrypted: encryptBitrixToken(refreshToken),
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      applicationTokenHash: sha256(applicationToken),
      scope: stringValue(auth.scope),
    },
    update: {
      domain,
      clientEndpoint: endpoint(clientEndpoint),
      serverEndpoint: stringValue(auth.server_endpoint) || 'https://oauth.bitrix24.tech/rest/',
      accessTokenEncrypted: encryptBitrixToken(accessToken),
      refreshTokenEncrypted: encryptBitrixToken(refreshToken),
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      applicationTokenHash: sha256(applicationToken),
      scope: stringValue(auth.scope),
      status: 'active',
      lastError: null,
      installedAt: new Date(),
    },
  });
  try {
    await configureConnector();
    await enqueueBitrixInboundAttachmentBackfill();
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CONNECTOR_SETUP_FAILED';
    await prisma.supportBitrixInstallation.update({ where: { memberId }, data: { status: 'error', lastError: message } });
    res.status(502).json({ error: 'Приложение установлено, но коннектор Открытой линии пока не настроен.', detail: message });
  }
}

async function validateEvent(body: any): Promise<boolean> {
  const auth = installationAuth(body);
  const memberId = stringValue(auth.member_id);
  const applicationToken = stringValue(auth.application_token);
  if (!memberId || !applicationToken) return false;
  const installation = await prisma.supportBitrixInstallation.findUnique({ where: { memberId } });
  return Boolean(installation && secureEqual(sha256(applicationToken), installation.applicationTokenHash));
}

function cleanBitrixText(value: unknown): string {
  return stringValue(value)
    .replace(/\[br\s*\/?\]/gi, '\n')
    .replace(/\[(?:\/?(?:b|i|u|s|url|color|size|quote))[^\]]*\]/gi, '')
    .trim()
    .slice(0, 10_000);
}

async function receiveOperatorMessages(body: any): Promise<void> {
  const messages = Array.isArray(body?.data?.MESSAGES) ? body.data.MESSAGES : [];
  for (const item of messages) {
    const ticketId = stringValue(item?.chat?.id);
    const bitrixMessageId = stringValue(item?.im?.message_id);
    const text = cleanBitrixText(item?.message?.text);
    if (!ticketId || !bitrixMessageId) continue;
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) continue;
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const savedMessage = await tx.supportMessage.create({
          data: {
            ticketId,
            authorType: 'support',
            source: 'bitrix24',
            visibility: 'public',
            body: text || 'Вложение',
            bitrixMessageId,
            deliveryStatus: 'received',
            sentAt: now,
          },
        });
        const nextStatus = ticket.status === 'new' || ticket.status === 'reopened' ? 'open' : ticket.status;
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: nextStatus,
            firstResponseAt: ticket.firstResponseAt ?? now,
            lastMessageAt: now,
            supportLastReadAt: now,
            bitrixChatId: stringValue(item?.im?.chat_id) || ticket.bitrixChatId,
            syncStatus: 'synced',
          },
        });
        if (nextStatus !== ticket.status) {
          await tx.supportTicketStatusHistory.create({
            data: { ticketId, fromStatus: ticket.status, toStatus: nextStatus, source: 'bitrix24', reason: 'Ответ оператора' },
          });
        }
        await tx.supportIntegrationOutbox.upsert({
          where: { deduplicationKey: `bitrix.attachments.pull:${bitrixMessageId}` },
          create: {
            ticketId,
            eventType: 'bitrix.attachments.pull',
            payloadJson: JSON.stringify({
              messageId: savedMessage.id,
              bitrixMessageId,
              bitrixChatId: stringValue(item?.im?.chat_id) || ticket.bitrixChatId,
            }),
            deduplicationKey: `bitrix.attachments.pull:${bitrixMessageId}`,
            nextAttemptAt: new Date(Date.now() + 2_000),
          },
          update: {},
        });
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
    // Bitrix treats imconnector.send.status.delivery as an actual read receipt,
    // not merely as webhook acknowledgement. It is sent later, when the
    // customer really opens the dialog in Salsa.
  }
}

async function receiveDialogFinish(body: any): Promise<void> {
  const items = Array.isArray(body?.data?.DATA) ? body.data.DATA : [];
  for (const item of items) {
    const sessionId = stringValue(item?.session?.id);
    if (!sessionId || item?.session?.closed !== 'Y') continue;
    const ticket = await prisma.supportTicket.findFirst({ where: { bitrixSessionId: sessionId } });
    if (!ticket || ['resolved', 'closed', 'duplicate', 'spam'].includes(ticket.status)) continue;
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.supportTicket.update({ where: { id: ticket.id }, data: { status: 'resolved', resolvedAt: now, lastMessageAt: now, syncStatus: 'synced' } });
      await tx.supportTicketStatusHistory.create({
        data: { ticketId: ticket.id, fromStatus: ticket.status, toStatus: 'resolved', source: 'bitrix24', reason: 'Диалог закрыт оператором' },
      });
    });
  }
}

export async function handleBitrixSupportEvent(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!await validateEvent(req.body)) {
    res.status(403).json({ error: 'Событие не прошло проверку.' });
    return;
  }
  const event = stringValue((req.body as any)?.event).toUpperCase();
  if (event === 'ONIMCONNECTORMESSAGEADD') await receiveOperatorMessages(req.body);
  if (event === 'ONIMCONNECTORDIALOGFINISH') await receiveDialogFinish(req.body);
  res.json({ ok: true });
}

function uniqueValues(values: unknown[]): string[] {
  return [...new Set(values.map(stringValue).filter(Boolean))];
}

function uniquePhones(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const phone = stringValue(value);
    if (!phone) continue;
    const normalized = phone.replace(/\D/g, '');
    const key = normalized.length === 11 && normalized.startsWith('8') ? `7${normalized.slice(1)}` : normalized;
    if (key.length < 7 || seen.has(key)) continue;
    seen.add(key);
    result.push(phone);
  }
  return result;
}

function ticketContactData(ticket: any) {
  const phones = uniquePhones([
    ticket.requesterPhone,
    ...(ticket.requester?.phoneNumbers || []).filter((item: any) => item.isActive).map((item: any) => item.phone),
    ...(ticket.requester?.managerProfiles || []).filter((item: any) => item.status !== 'inactive').map((item: any) => item.phone),
    ...(ticket.requester?.telegramUsers || [])
      .filter((item: any) => item.managerProfile?.status !== 'inactive')
      .map((item: any) => item.managerProfile?.phone),
  ]);
  const emails = uniqueValues([
    ticket.requesterEmail,
    ticket.requester?.email,
    ...(ticket.requester?.managerProfiles || []).map((item: any) => item.email),
    ...(ticket.requester?.telegramUsers || []).map((item: any) => item.managerProfile?.email),
  ]);
  return {
    name: ticket.requesterName || ticket.requester?.displayName || emails[0] || phones[0] || 'Клиент Salsa',
    phones,
    emails,
  };
}

async function duplicateContactId(type: 'PHONE' | 'EMAIL', values: string[]): Promise<string | null> {
  if (!values.length) return null;
  const result = await bitrixCall<Record<string, unknown> | unknown[]>('crm.duplicate.findbycomm', {
    entity_type: 'CONTACT', type, values,
  });
  if (!result || Array.isArray(result)) return null;
  const contacts = (result as Record<string, unknown>).CONTACT;
  return Array.isArray(contacts) ? stringValue(contacts[0]) || null : null;
}

async function ensureContact(ticket: any): Promise<string> {
  const productIdField = ticket.requesterAccountId ? await ensureContactProductIdField() : null;
  const contact = ticketContactData(ticket);
  let contactId = stringValue(ticket.bitrixContactId);
  if (!contactId && productIdField && ticket.requesterAccountId) {
    const byProductId = await bitrixCall<Array<{ ID?: string | number }>>('crm.contact.list', {
      filter: { [`=${productIdField}`]: ticket.requesterAccountId }, select: ['ID'], order: { ID: 'ASC' },
    });
    contactId = stringValue(byProductId?.[0]?.ID);
  }
  if (!contactId) contactId = await duplicateContactId('PHONE', contact.phones) || '';
  if (!contactId) contactId = await duplicateContactId('EMAIL', contact.emails) || '';

  const identityFields: Record<string, unknown> = {};
  if (productIdField && ticket.requesterAccountId) identityFields[productIdField] = ticket.requesterAccountId;
  if (contactId) {
    const existing = await bitrixCall<any>('crm.contact.get', { id: Number(contactId) });
    const phones = uniquePhones([...(existing?.PHONE || []).map((item: any) => item.VALUE), ...contact.phones]);
    const emails = uniqueValues([...(existing?.EMAIL || []).map((item: any) => item.VALUE), ...contact.emails]);
    await bitrixCall('crm.contact.update', {
      id: Number(contactId),
      fields: {
        NAME: existing?.NAME || contact.name,
        PHONE: phones.map((value) => ({ VALUE: value, VALUE_TYPE: 'WORK' })),
        EMAIL: emails.map((value) => ({ VALUE: value, VALUE_TYPE: 'WORK' })),
        ...identityFields,
      },
      params: { REGISTER_SONET_EVENT: 'N' },
    });
  } else {
    contactId = stringValue(await bitrixCall<string | number>('crm.contact.add', {
      fields: {
        NAME: contact.name,
        PHONE: contact.phones.map((value) => ({ VALUE: value, VALUE_TYPE: 'WORK' })),
        EMAIL: contact.emails.map((value) => ({ VALUE: value, VALUE_TYPE: 'WORK' })),
        ...identityFields,
      },
      params: { REGISTER_SONET_EVENT: 'N' },
    }));
  }
  if (!/^\d+$/.test(contactId)) throw new BitrixSupportError('INVALID_CONTACT_ID');
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { bitrixContactId: contactId } });
  return contactId;
}

async function linkContactToDeal(dealId: string, contactId: string): Promise<void> {
  const existing = await bitrixCall<Array<{ CONTACT_ID?: string | number; IS_PRIMARY?: string; SORT?: number }>>(
    'crm.deal.contact.items.get', { id: Number(dealId) },
  );
  const items = Array.isArray(existing) ? existing.map((item, index) => ({
    CONTACT_ID: Number(item.CONTACT_ID),
    IS_PRIMARY: item.IS_PRIMARY === 'Y' ? 'Y' : 'N',
    SORT: item.SORT ?? (index + 1) * 100,
  })).filter((item) => Number.isInteger(item.CONTACT_ID) && item.CONTACT_ID > 0) : [];
  if (!items.some((item) => String(item.CONTACT_ID) === contactId)) {
    items.push({ CONTACT_ID: Number(contactId), IS_PRIMARY: items.length ? 'N' : 'Y', SORT: (items.length + 1) * 100 });
  }
  await bitrixCall('crm.deal.contact.items.set', { id: Number(dealId), items });
}

async function linkOpenLineToContact(chatId: string, contactId: string): Promise<void> {
  const chats = await bitrixCall<Array<{ CHAT_ID?: string | number }>>('imopenlines.crm.chat.get', {
    CRM_ENTITY_TYPE: 'contact',
    CRM_ENTITY: Number(contactId),
    ACTIVE_ONLY: 'N',
  });
  if (!Array.isArray(chats) || !chats.some((item) => stringValue(item.CHAT_ID) === chatId)) {
    throw new BitrixSupportError('OPEN_LINE_CONTACT_LINK_NOT_VISIBLE');
  }
}

async function dealFields(ticket: any, map: DealFieldMap): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {
    TITLE: `[${ticket.number}] ${ticket.subject || ticket.category}`,
    CATEGORY_ID: Number(config.bitrix24SupportDealCategoryId || 0),
    COMMENTS: ticket.messages[0]?.body || '',
    SOURCE_ID: 'WEB',
    SOURCE_DESCRIPTION: ticket.channel === 'login' ? 'Поддержка с экрана входа Salsa' : 'Поддержка в продукте Salsa',
    ORIGINATOR_ID: 'salsa_support',
    ORIGIN_ID: ticket.id,
  };
  const values: Record<keyof DealFieldMap, unknown> = {
    ticketNumber: ticket.number,
    productUserId: ticket.requesterAccountId || '',
    productDialogId: ticket.id,
    bitrixSessionId: ticket.bitrixSessionId || '',
    initiatorConfirmed: ticket.requesterVerified ? 1 : 0,
    category: await categoryValueForDeal(ticket.category, map),
    subcategory: ticket.subcategory || '',
    priority: ticket.priority,
    firstMessageAt: ticket.firstMessageAt.toISOString(),
    channel: ticket.channel,
  };
  for (const [key, field] of Object.entries(map)) if (field) fields[field] = values[key as keyof DealFieldMap];
  return fields;
}

async function ensureDeal(ticket: any): Promise<string> {
  const contactId = await ensureContact(ticket);
  ticket.bitrixContactId = contactId;
  if (ticket.bitrixDealId) {
    await linkContactToDeal(ticket.bitrixDealId, contactId);
    return ticket.bitrixDealId;
  }
  const existing = await bitrixCall<Array<{ ID?: string | number }>>('crm.deal.list', {
    filter: { '=ORIGINATOR_ID': 'salsa_support', '=ORIGIN_ID': ticket.id }, select: ['ID'], order: { ID: 'ASC' },
  });
  const map = await resolvedFieldMap();
  const dealId = stringValue(existing?.[0]?.ID) || stringValue(await bitrixCall<string | number>('crm.deal.add', {
    fields: await dealFields(ticket, map), params: { REGISTER_SONET_EVENT: 'Y' },
  }));
  if (!/^\d+$/.test(dealId)) throw new BitrixSupportError('INVALID_DEAL_ID');
  await linkContactToDeal(dealId, contactId);
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { bitrixDealId: dealId, bitrixContactId: contactId } });
  return dealId;
}

function bitrixAttachmentFiles(message: any): Array<{ url: string; name: string }> {
  const secret = config.bitrix24SupportTokenKey || '';
  if (!secret) throw new BitrixSupportError('TOKEN_KEY_NOT_CONFIGURED');
  const expiresAt = Date.now() + ATTACHMENT_LINK_TTL_MS;
  return (message.attachments || []).map((attachment: any) => {
    const url = new URL(`/api/integrations/bitrix24/support/attachments/${encodeURIComponent(attachment.id)}`, `${publicBaseUrl()}/`);
    url.searchParams.set('expires', String(expiresAt));
    url.searchParams.set('signature', signSupportAttachmentLink(attachment.id, expiresAt, secret));
    return { url: url.toString(), name: attachment.originalName };
  });
}

function customerMessagePayload(ticket: any, message: any, externalId = message.id) {
  const contact = ticketContactData(ticket);
  const files = bitrixAttachmentFiles(message);
  return {
    user: {
      id: `${ticket.requesterAccountId || 'guest'}:${ticket.id}`,
      name: ticket.requesterName || 'Клиент Salsa',
      email: ticket.requesterEmail || undefined,
      phone: contact.phones[0] || undefined,
      skip_phone_validate: 'Y',
    },
    message: {
      id: externalId,
      date: Math.floor(message.sentAt.getTime() / 1000),
      text: message.body,
      ...(files.length ? { files } : {}),
    },
    chat: { id: ticket.id, name: `${ticket.number} · ${ticket.subject || ticket.category}`, url: publicBaseUrl() },
  };
}

async function sendCustomerMessage(ticket: any, message: any, externalId = message.id): Promise<void> {
  const result = await bitrixCall<any>('imconnector.send.messages', {
    CONNECTOR: config.bitrix24SupportConnectorId,
    LINE: Number(config.bitrix24SupportLineId),
    MESSAGES: [customerMessagePayload(ticket, message, externalId)],
  });
  if (result?.SUCCESS !== true) {
    throw new BitrixSupportError('MESSAGE_REJECTED', JSON.stringify(result?.ERRORS || result || []));
  }
  const item = result?.DATA?.RESULT?.[0] ?? result?.data?.result?.[0] ?? result?.RESULT?.[0];
  if (!item || item.SUCCESS !== true) {
    throw new BitrixSupportError('MESSAGE_REJECTED', JSON.stringify(item?.ERRORS || item || []));
  }
  const session = item?.session;
  const bitrixSessionId = stringValue(session?.ID ?? session?.id);
  const bitrixChatId = stringValue(session?.CHAT_ID ?? session?.chat_id);
  if (!bitrixSessionId || !bitrixChatId) {
    throw new BitrixSupportError('OPEN_LINE_SESSION_NOT_CREATED', JSON.stringify({
      success: item.SUCCESS,
      user: item.user,
      chat: item.chat?.id,
      extra: item.extra,
      errors: item.ERRORS,
      session: item.session,
    }));
  }
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { bitrixSessionId: bitrixSessionId || undefined, bitrixChatId: bitrixChatId || undefined },
  });
  if (ticket.bitrixContactId) await linkOpenLineToContact(bitrixChatId, ticket.bitrixContactId);
  const map = await resolvedFieldMap();
  const sessionFields: Record<string, unknown> = {};
  if (map.bitrixSessionId && bitrixSessionId) sessionFields[map.bitrixSessionId] = bitrixSessionId;
  if (map.productDialogId) sessionFields[map.productDialogId] = ticket.id;
  if (ticket.bitrixDealId && Object.keys(sessionFields).length) {
    await bitrixCall('crm.deal.update', {
      id: Number(ticket.bitrixDealId),
      fields: sessionFields,
      params: { REGISTER_SONET_EVENT: 'N' },
    });
  }
  await prisma.supportMessage.updateMany({ where: { id: message.id }, data: { deliveryStatus: 'sent', deliveryError: null } });
}

async function updateCustomerMessage(ticket: any, message: any): Promise<void> {
  const result = await bitrixCall<any>('imconnector.update.messages', {
    CONNECTOR: config.bitrix24SupportConnectorId,
    LINE: Number(config.bitrix24SupportLineId),
    MESSAGES: [customerMessagePayload(ticket, message)],
  });
  const item = result?.DATA?.RESULT?.[0] ?? result?.data?.result?.[0] ?? result?.RESULT?.[0];
  if (result?.SUCCESS !== true || !item || item.SUCCESS !== true) {
    throw new BitrixSupportError('MESSAGE_UPDATE_REJECTED', JSON.stringify(item?.ERRORS || result?.ERRORS || item || result || []));
  }
}

async function addTimelineComment(dealId: string, comment: string): Promise<void> {
  await bitrixCall('crm.timeline.comment.add', { fields: { ENTITY_ID: Number(dealId), ENTITY_TYPE: 'deal', COMMENT: comment } });
}

function recordValues(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object'));
  if (value && typeof value === 'object') return Object.values(value).filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object'));
  return [];
}

function bitrixFileIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  return uniqueValues(values);
}

function mimeTypeFromFileName(fileName: string): string | null {
  const extension = fileName.toLowerCase().split('.').pop();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  } as Record<string, string>)[extension || ''] || null;
}

function safeInboundAttachmentName(value: unknown): string {
  return stringValue(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'вложение';
}

function hasExpectedFileSignature(data: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/png') return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'application/pdf') return data.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType.includes('openxmlformats-officedocument')) return data.subarray(0, 2).toString('ascii') === 'PK';
  return true;
}

async function downloadBitrixAttachment(
  urlValue: string,
  fileName: string,
  expectedSize: number | null,
): Promise<{ data: Buffer; mimeType: string }> {
  const installation = await prisma.supportBitrixInstallation.findFirst({ where: { status: 'active' } });
  if (!installation) throw new BitrixSupportError('INSTALLATION_NOT_FOUND');
  const url = new URL(urlValue, installation.clientEndpoint);
  const portalHost = new URL(installation.clientEndpoint).hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== portalHost) {
    throw new BitrixSupportError('INVALID_ATTACHMENT_URL');
  }
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'SalsaSupport/1.0',
      Accept: '*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      Referer: `${new URL(installation.clientEndpoint).origin}/`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new BitrixSupportError(`ATTACHMENT_HTTP_${response.status}`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_SUPPORT_ATTACHMENT_BYTES) {
    throw new BitrixSupportError('ATTACHMENT_TOO_LARGE');
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new BitrixSupportError('ATTACHMENT_EMPTY');
  if (data.length > MAX_SUPPORT_ATTACHMENT_BYTES) throw new BitrixSupportError('ATTACHMENT_TOO_LARGE');
  const responseMime = stringValue(response.headers.get('content-type')).toLowerCase().split(';')[0];
  if (responseMime === 'text/html' || data.subarray(0, 32).toString('utf8').toLowerCase().includes('<!doctype html')) {
    throw new BitrixSupportError('ATTACHMENT_AUTH_HTML_RECEIVED');
  }
  const mimeType = supportAttachmentExtension(responseMime) ? responseMime : mimeTypeFromFileName(fileName);
  if (!mimeType || !supportAttachmentExtension(mimeType)) throw new BitrixSupportError('ATTACHMENT_TYPE_UNSUPPORTED');
  if (expectedSize && data.length !== expectedSize) throw new BitrixSupportError('ATTACHMENT_SIZE_MISMATCH');
  if (!hasExpectedFileSignature(data, mimeType)) throw new BitrixSupportError('ATTACHMENT_CONTENT_INVALID');
  return { data, mimeType };
}

async function pullBitrixMessageAttachments(ticket: any, payload: Record<string, unknown>): Promise<void> {
  const messageId = stringValue(payload.messageId);
  const bitrixMessageId = stringValue(payload.bitrixMessageId);
  const bitrixChatId = stringValue(payload.bitrixChatId) || ticket.bitrixChatId;
  if (!messageId || !bitrixMessageId || !bitrixChatId) throw new BitrixSupportError('ATTACHMENT_MESSAGE_NOT_FOUND');
  const history = await bitrixCall<any>('imopenlines.session.history.get', { CHAT_ID: Number(bitrixChatId) });
  const historyMessage = recordValues(history?.message ?? history?.MESSAGE).find((item) => (
    stringValue(item.id ?? item.ID) === bitrixMessageId
  ));
  if (!historyMessage) throw new BitrixSupportError('ATTACHMENT_HISTORY_NOT_READY');
  const params = historyMessage.params ?? historyMessage.PARAMS ?? {};
  const fileIds = bitrixFileIds(params.fileId ?? params.FILE_ID);
  if (!fileIds.length) return;
  const files = recordValues(history?.files ?? history?.FILES);
  for (const fileId of fileIds) {
    const file = files.find((item) => stringValue(item.id ?? item.ID) === fileId);
    if (!file) throw new BitrixSupportError('ATTACHMENT_METADATA_NOT_READY');
    const name = safeInboundAttachmentName(file.name ?? file.NAME);
    const download = await bitrixCall<any>('im.v2.File.download', {
      dialogId: `chat${bitrixChatId}`,
      fileId: Number(fileId),
    });
    const downloadUrl = stringValue(download?.downloadUrl ?? download?.DOWNLOAD_URL);
    if (!downloadUrl) throw new BitrixSupportError('ATTACHMENT_URL_NOT_FOUND');
    const attachmentId = `b24_${sha256(`${ticket.id}:${bitrixMessageId}:${fileId}`).slice(0, 32)}`;
    const expectedSizeValue = Number(file.size ?? file.SIZE);
    const expectedSize = Number.isSafeInteger(expectedSizeValue) && expectedSizeValue > 0 ? expectedSizeValue : null;
    const existing = await prisma.supportMessageAttachment.findUnique({ where: { id: attachmentId } });
    if (existing && expectedSize && existing.sizeBytes === expectedSize) continue;
    const { data, mimeType } = await downloadBitrixAttachment(downloadUrl, name, expectedSize);
    const storageKey = supportAttachmentKey(ticket.id, attachmentId, mimeType);
    await supportAttachmentStorage.save(storageKey, data);
    try {
      await prisma.supportMessageAttachment.upsert({
        where: { id: attachmentId },
        create: { id: attachmentId, messageId, originalName: name, mimeType, sizeBytes: data.length, storageKey },
        update: { messageId, originalName: name, mimeType, sizeBytes: data.length, storageKey },
      });
    } catch (error) {
      await supportAttachmentStorage.remove(storageKey).catch(() => undefined);
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }
}

async function markOperatorMessagesRead(ticket: any, payload: Record<string, unknown>): Promise<void> {
  const readAtValue = stringValue(payload.readAt);
  const readAt = readAtValue ? new Date(readAtValue) : new Date();
  if (Number.isNaN(readAt.getTime())) throw new BitrixSupportError('INVALID_READ_AT');
  const messages = ticket.messages.filter((message: any) => (
    message.source === 'bitrix24'
    && message.authorType === 'support'
    && message.deliveryStatus === 'received'
    && message.bitrixMessageId
    && message.sentAt.getTime() <= readAt.getTime()
  ));
  if (!messages.length) return;
  if (!ticket.bitrixChatId) throw new BitrixSupportError('OPEN_LINE_NOT_FOUND');
  await bitrixCall('imconnector.send.status.delivery', {
    CONNECTOR: config.bitrix24SupportConnectorId,
    LINE: Number(config.bitrix24SupportLineId),
    MESSAGES: messages.map((message: any) => ({
      im: { chat_id: Number(ticket.bitrixChatId), message_id: Number(message.bitrixMessageId) },
      message: { id: [message.id], date: Math.floor(readAt.getTime() / 1000) },
      chat: { id: ticket.id },
    })),
  });
  await prisma.supportMessage.updateMany({
    where: { id: { in: messages.map((message: any) => message.id) }, deliveryStatus: 'received' },
    data: { deliveryStatus: 'read', deliveryError: null },
  });
}

async function processOutboxEvent(event: any): Promise<void> {
  const payload = JSON.parse(event.payloadJson || '{}') as Record<string, unknown>;
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: event.ticketId },
    include: {
      messages: { orderBy: { sentAt: 'asc' }, include: { attachments: true } },
      rating: true,
      requester: {
        include: {
          phoneNumbers: true,
          managerProfiles: { select: { phone: true, email: true, status: true } },
          telegramUsers: {
            select: {
              managerProfile: { select: { phone: true, email: true, status: true } },
            },
          },
        },
      },
    },
  });
  if (!ticket) return;
  if (event.eventType === 'ticket.created') {
    ticket.bitrixDealId = await ensureDeal(ticket);
    const message = ticket.messages.find((item) => item.id === payload.messageId);
    if (message) await sendCustomerMessage(ticket, message);
    return;
  }
  if (event.eventType === 'message.created') {
    if (!ticket.bitrixDealId) throw new BitrixSupportError('WAITING_FOR_TICKET_SYNC');
    const message = ticket.messages.find((item) => item.id === payload.messageId);
    if (message) await sendCustomerMessage(ticket, message);
    return;
  }
  if (event.eventType === 'dialog.sync') {
    ticket.bitrixDealId = await ensureDeal(ticket);
    const message = ticket.messages.find((item) => item.authorType === 'customer') || ticket.messages[0];
    if (!message) throw new BitrixSupportError('TICKET_MESSAGE_NOT_FOUND');
    await sendCustomerMessage(ticket, message, `dialog-sync-v4-${ticket.id}-${message.id}`);
    return;
  }
  if (event.eventType === 'attachment.created') {
    if (!ticket.bitrixDealId) throw new BitrixSupportError('WAITING_FOR_TICKET_SYNC');
    const message = ticket.messages.find((item) => item.id === payload.messageId);
    if (!message) throw new BitrixSupportError('TICKET_MESSAGE_NOT_FOUND');
    await updateCustomerMessage(ticket, message);
    return;
  }
  if (event.eventType === 'bitrix.attachments.pull') {
    await pullBitrixMessageAttachments(ticket, payload);
    return;
  }
  if (event.eventType === 'messages.read') {
    await markOperatorMessagesRead(ticket, payload);
    return;
  }
  if (event.eventType === 'contact.sync') {
    const contactId = await ensureContact(ticket);
    if (ticket.bitrixDealId) await linkContactToDeal(ticket.bitrixDealId, contactId);
    if (ticket.bitrixChatId) await linkOpenLineToContact(ticket.bitrixChatId, contactId);
    return;
  }
  if (event.eventType === 'crm-chat.sync') {
    if (!ticket.bitrixChatId || !ticket.bitrixContactId) throw new BitrixSupportError('OPEN_LINE_OR_CONTACT_NOT_FOUND');
    await linkOpenLineToContact(ticket.bitrixChatId, ticket.bitrixContactId);
    return;
  }
  if (!ticket.bitrixDealId) throw new BitrixSupportError('WAITING_FOR_TICKET_SYNC');
  if (event.eventType === 'ticket.rating_changed' && ticket.rating) {
    await addTimelineComment(ticket.bitrixDealId, `Оценка поддержки: ${ticket.rating.isSatisfied ? 'положительная' : 'отрицательная'}${ticket.rating.comment ? `\n${ticket.rating.comment}` : ''}`);
    return;
  }
  if (event.eventType === 'ticket.sla_breached') {
    await addTimelineComment(ticket.bitrixDealId, `Нарушен SLA: ${stringValue(payload.metric) || 'неизвестная метрика'}.`);
    return;
  }
  if (event.eventType.includes('closed')) {
    await addTimelineComment(ticket.bitrixDealId, 'Обращение закрыто в Salsa.');
  }
}

export async function runBitrixSupportOutbox(): Promise<number> {
  if (!integrationConfigured()) return 0;
  const installation = await prisma.supportBitrixInstallation.findFirst({ where: { status: 'active' } });
  if (!installation) return 0;
  const events = await prisma.supportIntegrationOutbox.findMany({
    where: { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: new Date() }, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  let processed = 0;
  for (const event of events) {
    const claimed = await prisma.supportIntegrationOutbox.updateMany({
      where: { id: event.id, status: event.status }, data: { status: 'processing', attempts: { increment: 1 } },
    });
    if (!claimed.count) continue;
    try {
      await processOutboxEvent(event);
      await prisma.$transaction([
        prisma.supportIntegrationOutbox.update({ where: { id: event.id }, data: { status: 'sent', processedAt: new Date(), lastError: null } }),
        prisma.supportTicket.update({ where: { id: event.ticketId }, data: { syncStatus: 'synced', lastSyncedAt: new Date(), syncError: null } }),
      ]);
      processed += 1;
    } catch (error) {
      const attempts = event.attempts + 1;
      const message = error instanceof Error ? error.message.slice(0, 1_000) : 'UNKNOWN_ERROR';
      const delay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 8));
      await prisma.$transaction([
        prisma.supportIntegrationOutbox.update({ where: { id: event.id }, data: { status: 'failed', lastError: message, nextAttemptAt: new Date(Date.now() + delay) } }),
        prisma.supportTicket.update({ where: { id: event.ticketId }, data: { syncStatus: 'failed', syncError: message } }),
      ]);
    }
  }
  return processed;
}

export async function enqueueBitrixSupportContactBackfill(): Promise<number> {
  if (!integrationConfigured()) return 0;
  const tickets = await prisma.supportTicket.findMany({
    where: { bitrixDealId: { not: null }, bitrixContactId: null },
    select: { id: true },
    take: 500,
  });
  for (const ticket of tickets) {
    await prisma.supportIntegrationOutbox.upsert({
      where: { deduplicationKey: `contact.sync:${ticket.id}` },
      create: {
        ticketId: ticket.id,
        eventType: 'contact.sync',
        payloadJson: JSON.stringify({ ticketId: ticket.id }),
        deduplicationKey: `contact.sync:${ticket.id}`,
      },
      update: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), processedAt: null, lastError: null },
    });
  }
  return tickets.length;
}

export async function enqueueBitrixSupportDialogBackfill(): Promise<number> {
  if (!integrationConfigured()) return 0;
  const tickets = await prisma.supportTicket.findMany({
    where: {
      bitrixDealId: { not: null },
      OR: [{ bitrixSessionId: null }, { bitrixChatId: null }],
      status: { notIn: ['closed', 'duplicate', 'spam'] },
    },
    select: { id: true },
    take: 500,
  });
  for (const ticket of tickets) {
    await prisma.supportIntegrationOutbox.upsert({
      where: { deduplicationKey: `dialog.sync:${ticket.id}` },
      create: {
        ticketId: ticket.id,
        eventType: 'dialog.sync',
        payloadJson: JSON.stringify({ ticketId: ticket.id }),
        deduplicationKey: `dialog.sync:${ticket.id}`,
      },
      update: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), processedAt: null, lastError: null },
    });
  }
  return tickets.length;
}

export async function enqueueBitrixSupportCrmChatBackfill(): Promise<number> {
  if (!integrationConfigured()) return 0;
  const tickets = await prisma.supportTicket.findMany({
    where: { bitrixChatId: { not: null }, bitrixContactId: { not: null } },
    select: { id: true },
    take: 500,
  });
  for (const ticket of tickets) {
    await prisma.supportIntegrationOutbox.upsert({
      where: { deduplicationKey: `crm-chat.sync:${ticket.id}` },
      create: {
        ticketId: ticket.id,
        eventType: 'crm-chat.sync',
        payloadJson: JSON.stringify({ ticketId: ticket.id }),
        deduplicationKey: `crm-chat.sync:${ticket.id}`,
      },
      update: {},
    });
  }
  return tickets.length;
}

export async function enqueueBitrixInboundAttachmentBackfill(): Promise<number> {
  if (!integrationConfigured()) return 0;
  const messages = await prisma.supportMessage.findMany({
    where: {
      source: 'bitrix24',
      authorType: 'support',
      bitrixMessageId: { not: null },
      ticket: { bitrixChatId: { not: null } },
    },
    select: { id: true, ticketId: true, bitrixMessageId: true, ticket: { select: { bitrixChatId: true } } },
    take: 500,
  });
  for (const message of messages) {
    await prisma.supportIntegrationOutbox.upsert({
      where: { deduplicationKey: `bitrix.attachments.pull:${message.bitrixMessageId}` },
      create: {
        ticketId: message.ticketId,
        eventType: 'bitrix.attachments.pull',
        payloadJson: JSON.stringify({
          messageId: message.id,
          bitrixMessageId: message.bitrixMessageId,
          bitrixChatId: message.ticket.bitrixChatId,
        }),
        deduplicationKey: `bitrix.attachments.pull:${message.bitrixMessageId}`,
      },
      update: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), processedAt: null, lastError: null },
    });
  }
  return messages.length;
}

export function startBitrixSupportScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const run = async () => {
    if (processorRunning) return;
    processorRunning = true;
    try {
      if (!configurationRecoveryAttempted) {
        configurationRecoveryAttempted = true;
        await repairBitrixSupportConfiguration();
        await enqueueBitrixSupportContactBackfill();
        await enqueueBitrixSupportDialogBackfill();
        await enqueueBitrixInboundAttachmentBackfill();
      }
      await runBitrixSupportOutbox();
    }
    catch (error) { console.error('[support/bitrix24] outbox failed:', error instanceof Error ? error.message : error); }
    finally { processorRunning = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); }, PROCESS_INTERVAL_MS);
  timer.unref?.();
}
