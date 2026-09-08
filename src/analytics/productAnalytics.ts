import * as amplitude from '@amplitude/analytics-node';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';

export const PRODUCT_EVENT_NAMES = [
  'login_succeeded',
  'session_started',
  'page_viewed',
  'analytics_opened',
  'manager_viewed',
  'dealership_viewed',
  'comparison_used',
  'report_viewed',
  'score_viewed',
  'errors_viewed',
  'recommendations_viewed',
  'training_started',
  'training_completed',
  'call_check_completed',
  'call_processing_failed',
] as const;

export type ProductEventName = typeof PRODUCT_EVENT_NAMES[number];
export type ProductRole = 'platform_superadmin' | 'holding_admin' | 'dealership_admin' | 'manager';
export type ProductEventProperty = string | number | boolean | null;

export type RecordProductEventInput = {
  eventName: ProductEventName;
  accountId?: string | null;
  role?: ProductRole | null;
  holdingId?: string | null;
  dealershipId?: string | null;
  managerId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  route?: string | null;
  clientSessionId?: string | null;
  properties?: Record<string, ProductEventProperty>;
  deduplicationKey?: string | null;
  occurredAt?: Date;
};

const PRODUCT_EVENT_SET = new Set<string>(PRODUCT_EVENT_NAMES);
const CLIENT_EVENT_SET = new Set<ProductEventName>([
  'session_started',
  'page_viewed',
  'analytics_opened',
  'manager_viewed',
  'dealership_viewed',
  'comparison_used',
  'report_viewed',
  'score_viewed',
  'errors_viewed',
  'recommendations_viewed',
]);
const CLIENT_PROPERTY_KEYS = new Set([
  'report_type',
  'comparison_type',
  'selected_count',
  'surface',
]);
const CLIENT_TARGET_TYPES = new Set([
  'manager',
  'dealership',
  'comparison',
  'voice_call',
  'trainer_session',
  'analytics_recommendations',
]);

let amplitudeInitialized = false;

function trimOptional(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function sanitizeProperties(
  value: Record<string, ProductEventProperty> | undefined,
  allowedKeys?: Set<string>,
): Record<string, ProductEventProperty> {
  if (!value) return {};
  const out: Record<string, ProductEventProperty> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 20)) {
    const key = rawKey.trim().slice(0, 64);
    if (!key || (allowedKeys && !allowedKeys.has(key))) continue;
    if (typeof rawValue === 'string') out[key] = rawValue.slice(0, 160);
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) out[key] = rawValue;
    else if (typeof rawValue === 'boolean' || rawValue === null) out[key] = rawValue;
  }
  return out;
}

function initializeAmplitude(): boolean {
  if (!config.amplitudeApiKey) return false;
  if (amplitudeInitialized) return true;
  amplitude.init(config.amplitudeApiKey, {
    serverZone: config.amplitudeRegion === 'EU'
      ? amplitude.Types.ServerZone.EU
      : amplitude.Types.ServerZone.US,
    flushIntervalMillis: 10_000,
    flushQueueSize: 20,
  });
  amplitudeInitialized = true;
  console.log(`[analytics] Amplitude enabled region=${config.amplitudeRegion}`);
  return true;
}

function sendToAmplitude(input: RecordProductEventInput, properties: Record<string, ProductEventProperty>): void {
  if (!initializeAmplitude()) return;
  const managerId = trimOptional(input.managerId, 120);
  const userId = trimOptional(input.accountId, 128)
    || (managerId ? `manager:${managerId}` : null);
  if (!userId) return;

  const eventProperties: Record<string, ProductEventProperty> = {
    ...properties,
    role: input.role ?? null,
    holding_id: trimOptional(input.holdingId, 128),
    dealership_id: trimOptional(input.dealershipId, 128),
    manager_id: trimOptional(input.managerId, 128),
    target_type: trimOptional(input.targetType, 64),
    target_id: trimOptional(input.targetId, 160),
    route: trimOptional(input.route, 240),
    client_session_id: trimOptional(input.clientSessionId, 96),
    environment: config.sentryEnvironment,
  };
  const groups: Record<string, string> = {};
  if (input.holdingId) groups.holding_id = input.holdingId;
  if (input.dealershipId) groups.dealership_id = input.dealershipId;

  void amplitude.track(input.eventName, eventProperties, {
    user_id: userId,
    ...(Object.keys(groups).length ? { groups } : {}),
  }).promise.catch((error) => {
    console.warn('[analytics] Amplitude delivery failed:', error instanceof Error ? error.message : error);
  });
}

export async function recordProductEvent(input: RecordProductEventInput): Promise<boolean> {
  const properties = sanitizeProperties(input.properties);
  const data = {
    eventName: input.eventName,
    accountId: trimOptional(input.accountId, 128),
    role: input.role ?? null,
    holdingId: trimOptional(input.holdingId, 128),
    dealershipId: trimOptional(input.dealershipId, 128),
    managerId: trimOptional(input.managerId, 128),
    targetType: trimOptional(input.targetType, 64),
    targetId: trimOptional(input.targetId, 160),
    route: trimOptional(input.route, 240),
    clientSessionId: trimOptional(input.clientSessionId, 96),
    propertiesJson: JSON.stringify(properties),
    deduplicationKey: trimOptional(input.deduplicationKey, 240),
    occurredAt: input.occurredAt ?? new Date(),
  };

  try {
    await prisma.productAnalyticsEvent.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && data.deduplicationKey) {
      return false;
    }
    throw error;
  }

  sendToAmplitude(input, properties);
  return true;
}

export type ParsedClientProductEvent = Pick<
  RecordProductEventInput,
  'eventName' | 'targetType' | 'targetId' | 'route' | 'clientSessionId' | 'properties'
>;

export function parseClientProductEvent(value: unknown): ParsedClientProductEvent | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const eventName = trimOptional(body.eventName, 64);
  if (!eventName || !PRODUCT_EVENT_SET.has(eventName) || !CLIENT_EVENT_SET.has(eventName as ProductEventName)) return null;

  const routeValue = trimOptional(body.route, 240);
  const route = routeValue?.startsWith('/') ? routeValue.split('?')[0] : null;
  const targetTypeValue = trimOptional(body.targetType, 64);
  const targetType = targetTypeValue && CLIENT_TARGET_TYPES.has(targetTypeValue) ? targetTypeValue : null;
  const targetIdValue = trimOptional(body.targetId, 160);
  // Entity identifiers in this application are UUIDs/CUIDs or compact synthetic IDs.
  // Reject free-form text so authenticated clients cannot smuggle PII into analytics.
  const targetId = targetType && targetIdValue && /^[a-zA-Z0-9:_-]+$/.test(targetIdValue)
    ? targetIdValue
    : null;
  const rawProperties = body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties)
    ? body.properties as Record<string, ProductEventProperty>
    : undefined;

  return {
    eventName: eventName as ProductEventName,
    targetType,
    targetId,
    route,
    clientSessionId: trimOptional(body.clientSessionId, 96),
    properties: sanitizeProperties(rawProperties, CLIENT_PROPERTY_KEYS),
  };
}

export async function flushProductAnalytics(): Promise<void> {
  if (!amplitudeInitialized) return;
  await amplitude.flush().promise;
}
