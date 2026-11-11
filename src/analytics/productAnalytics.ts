import * as amplitude from '@amplitude/analytics-node';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
export const PRODUCT_EVENT_NAMES = [
  'login_succeeded', 'session_started', 'page_viewed', 'analytics_opened', 'company_viewed', 'employee_viewed', 'branch_viewed', 'comparison_used', 'branch_recommendation_opened', 'call_plan_created', 'employees_imported', 'report_viewed', 'report_findings_opened', 'report_recommendations_opened', 'trainer_opened', 'training_started', 'training_completed', 'training_cancelled', 'training_processing_failed', 'trainer_daily_plan_completed', 'call_attempted', 'call_ended', 'call_check_completed', 'call_processing_failed',
] as const;
export type ProductEventName = typeof PRODUCT_EVENT_NAMES[number];
export type EventRole = 'superadmin' | 'company_admin' | 'branch_admin' | 'employee';
export type ProductRole = 'platform_superadmin' | 'holding_admin' | 'dealership_admin' | 'manager' | EventRole;
export type ProductEventProperty = string | number | boolean | null;
export function toEventRole(role: ProductRole | null | undefined): EventRole | null {
  const roles: Record<ProductRole, EventRole> = { platform_superadmin: 'superadmin', holding_admin: 'company_admin', dealership_admin: 'branch_admin', manager: 'employee', superadmin: 'superadmin', company_admin: 'company_admin', branch_admin: 'branch_admin', employee: 'employee' };
  return role ? roles[role] : null;
}
export type RecordProductEventInput = {
  eventName: ProductEventName;
  accountId?: string | null;
  role?: ProductRole | null;
  companyId?: string | null;
  branchId?: string | null;
  employeeId?: string | null;
  // Compatibility at existing call sites; persisted and exported names are always neutral.
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
const SYSTEM_EVENTS = new Set<ProductEventName>(['call_attempted', 'call_ended', 'call_check_completed', 'call_processing_failed', 'training_processing_failed']);
const CLIENT_EVENT_SET = new Set<ProductEventName>(['session_started', 'page_viewed', 'analytics_opened', 'company_viewed', 'employee_viewed', 'branch_viewed', 'comparison_used', 'report_viewed', 'report_findings_opened', 'report_recommendations_opened', 'trainer_opened', 'branch_recommendation_opened']);
const CLIENT_PROPERTY_KEYS = new Set(['section', 'route_template', 'report_type', 'is_own', 'surface', 'comparison_type', 'selected_count', 'recommendation_type', 'has_daily_plan', 'plan_items_done']);
const CLIENT_TARGET_TYPES = new Set(['company', 'branch', 'employee', 'voice_call', 'trainer_session', 'comparison']);
const ENUMS: Record<string, Set<string>> = {
  report_type: new Set(['call', 'training']), comparison_type: new Set(['employees', 'branches']),
  section: new Set(['dashboard', 'analytics', 'companies', 'branches', 'employees', 'audits', 'data', 'checklists', 'branch_directions', 'number_types', 'call_settings', 'billing', 'profile', 'trainer', 'internal_analytics', 'testing', 'dictionaries', 'settings']),
};
let amplitudeInitialized = false;
const actorCache = new Map<string, {
  until: number;
  createdAt: Date;
  roles: string[];
}>();
const identifiedContexts = new Map<string, string>();
const contextCache = new Map<string, {
  until: number;
  value: {
    companyId: string | null;
    companyName: string | null;
    branchName: string | null;
    isTest: boolean;
  };
}>();
function trimOptional(value: unknown, max: number): string | null { return typeof value === 'string' ? value.trim().slice(0, max) || null : null; }
function sanitizeProperties(value: Record<string, ProductEventProperty> | undefined, allowed?: Set<string>) {
  const out: Record<string, ProductEventProperty> = {};
  for (const [key, raw] of Object.entries(value ?? {}).slice(0, 40)) {
    if (allowed && !allowed.has(key))
      continue;
    if ((['is_own', 'has_daily_plan'].includes(key) && typeof raw !== 'boolean') || (['selected_count', 'plan_items_done'].includes(key) && (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || (key === 'plan_items_done' && raw > 3)))) {
      console.warn(`[analytics] invalid ${key}`);
      continue;
    }
    if (ENUMS[key] && (typeof raw !== 'string' || !ENUMS[key].has(raw))) {
      console.warn(`[analytics] invalid ${key}`);
      continue;
    }
    if (typeof raw === 'string')
      out[key.slice(0, 64)] = raw.slice(0, 160);
    else if ((typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'boolean' || raw === null)
      out[key] = raw;
  }
  return out;
}
export async function getProductOrganizationContext(companyId: string | null, branchId: string | null) {
  const key = `${companyId ?? ''}:${branchId ?? ''}`, cached = contextCache.get(key);
  if (cached && cached.until > Date.now())
    return cached.value;
  const branch = branchId ? await prisma.dealership.findUnique({ where: { id: branchId }, select: { name: true, holdingId: true } }) : null;
  const resolvedCompanyId = branch?.holdingId ?? companyId;
  const company = resolvedCompanyId ? await prisma.holding.findUnique({ where: { id: resolvedCompanyId }, select: { name: true, isTest: true } }) : null;
  const value = { companyId: resolvedCompanyId, companyName: company?.name ?? null, branchName: branch?.name ?? null, isTest: company?.isTest ?? false };
  contextCache.set(key, { until: Date.now() + 300000, value });
  if (contextCache.size > 1000)
    contextCache.delete(contextCache.keys().next().value!);
  return value;
}
export function clearProductAnalyticsContextCache() { contextCache.clear(); actorCache.clear(); identifiedContexts.clear(); }
function initializeAmplitude() {
  if (!config.amplitudeApiKey)
    return false;
  if (!amplitudeInitialized) {
    amplitude.init(config.amplitudeApiKey, { serverZone: config.amplitudeRegion === 'EU' ? amplitude.Types.ServerZone.EU : amplitude.Types.ServerZone.US, flushIntervalMillis: 10000, flushQueueSize: 20 });
    amplitudeInitialized = true;
  }
  return true;
}
async function persistProductEvent(input: RecordProductEventInput): Promise<boolean> {
  const branchId = trimOptional(input.branchId ?? input.dealershipId, 128), employeeId = trimOptional(input.employeeId ?? input.managerId, 128);
  const context = await getProductOrganizationContext(trimOptional(input.companyId ?? input.holdingId, 128), branchId);
  let role = toEventRole(input.role);
  let actor = input.accountId ? actorCache.get(input.accountId) : undefined;
  if (input.accountId && (!actor || actor.until <= Date.now())) {
    const account = await prisma.account.findUnique({ where: { id: input.accountId }, select: { createdAt: true, memberships: { select: { role: true } } } });
    if (account) {
      actor = { until: Date.now() + 300000, createdAt: account.createdAt, roles: account.memberships.map(item => item.role) };
      actorCache.set(input.accountId, actor);
      if (actorCache.size > 1000)
        actorCache.delete(actorCache.keys().next().value!);
    }
  }
  if (actor?.roles.includes('platform_superadmin'))
    role = 'superadmin';
  else if (role === 'employee' && actor && !actor.roles.includes('manager'))
    role = actor.roles.includes('holding_admin') ? 'company_admin' : actor.roles.includes('dealership_admin') ? 'branch_admin' : null;
  const initiatedBy = SYSTEM_EVENTS.has(input.eventName) ? 'system' : 'user';
  const properties = sanitizeProperties({ ...input.properties, company_id: context.companyId, company_name: context.companyName, branch_id: branchId, branch_name: context.branchName, employee_id: employeeId, role, initiated_by: initiatedBy, is_test: context.isTest, environment: config.sentryEnvironment, app_release: config.sentryRelease ?? null, client_session_id: input.clientSessionId ?? null });
  const data = { eventName: input.eventName, accountId: trimOptional(input.accountId, 128), role, companyId: context.companyId, branchId, employeeId, initiatedBy, targetType: trimOptional(input.targetType, 64), targetId: trimOptional(input.targetId, 160), route: trimOptional(input.route, 240), clientSessionId: trimOptional(input.clientSessionId, 96), propertiesJson: JSON.stringify(properties), deduplicationKey: trimOptional(input.deduplicationKey, 240), occurredAt: input.occurredAt ?? new Date() };
  let stored: {
    id: string;
  };
  try {
    stored = await prisma.productAnalyticsEvent.create({ data });
  }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && data.deduplicationKey)
      return false;
    throw error;
  }
  if (role === 'superadmin' || context.isTest || !initializeAmplitude())
    return true;
  const userId = data.accountId ?? (initiatedBy === 'system' && branchId ? `branch:${branchId}` : null);
  if (!userId)
    return true;
  const groups: Record<string, string> = {};
  if (context.companyId)
    groups.company = context.companyId;
  if (branchId)
    groups.branch = branchId;
  const warn = (error: unknown) => console.warn('[analytics] Amplitude delivery failed:', error instanceof Error ? error.message : error);
  const identityKey = JSON.stringify([role, context.companyId, branchId, context.isTest]);
  if (initiatedBy === 'user' && identifiedContexts.get(userId) !== identityKey) {
    identifiedContexts.set(userId, identityKey);
    if (identifiedContexts.size > 1000)
      identifiedContexts.delete(identifiedContexts.keys().next().value!);
    const identify = new amplitude.Identify();
    for (const key of ['role', 'company_id', 'company_name', 'branch_id', 'branch_name', 'is_test']) {
      const value = properties[key];
      if (value !== null)
        identify.set(key, value);
      else
        identify.unset(key);
    }
    if (actor)
      identify.set('account_created_at', actor.createdAt.toISOString());
    void amplitude.identify(identify, { user_id: userId }).promise.catch(warn);
  }
  for (const [type, id] of Object.entries(groups)) {
    const name = type === 'company' ? context.companyName : context.branchName;
    if (name)
      void amplitude.groupIdentify(type, id, new amplitude.Identify().set('name', name)).promise.catch(warn);
  }
  void amplitude.track(input.eventName, { ...properties, target_type: data.targetType, target_id: data.targetId }, { user_id: userId, time: data.occurredAt.getTime(), insert_id: data.deduplicationKey ?? stored.id, ...(Object.keys(groups).length ? { groups } : {}) }).promise.catch(warn);
  return true;
}
export type ParsedClientProductEvent = Pick<RecordProductEventInput, 'eventName' | 'targetType' | 'targetId' | 'route' | 'clientSessionId' | 'properties'>;
export function parseClientProductEvent(value: unknown): ParsedClientProductEvent | null {
  if (!value || typeof value !== 'object')
    return null;
  const body = value as Record<string, unknown>, name = trimOptional(body.eventName, 64);
  if (!name || !CLIENT_EVENT_SET.has(name as ProductEventName)) {
    console.warn('[analytics] unsupported client event');
    return null;
  }
  const routeValue = trimOptional(body.route, 240), route = routeValue?.startsWith('/') ? routeValue.split('?')[0] : null;
  const rawTarget = trimOptional(body.targetType, 64), targetType = rawTarget && CLIENT_TARGET_TYPES.has(rawTarget) ? rawTarget : null;
  const rawId = trimOptional(body.targetId, 160), targetId = targetType && rawId && /^[a-zA-Z0-9:_-]+$/.test(rawId) ? rawId : null;
  const raw = body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties) ? body.properties as Record<string, ProductEventProperty> : undefined;
  return { eventName: name as ProductEventName, route, targetType, targetId, clientSessionId: trimOptional(body.clientSessionId, 96), properties: sanitizeProperties(raw, CLIENT_PROPERTY_KEYS) };
}
const pendingWrites = new Set<Promise<boolean>>();
export function recordProductEvent(input: RecordProductEventInput): Promise<boolean> {
  const task = persistProductEvent(input);
  pendingWrites.add(task);
  void task.then(() => pendingWrites.delete(task), () => pendingWrites.delete(task));
  return task;
}
export async function flushProductAnalytics() {
  await Promise.allSettled([...pendingWrites]);
  if (amplitudeInitialized)
    await amplitude.flush().promise;
}
