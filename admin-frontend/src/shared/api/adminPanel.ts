/**
 * Admin panel API — uses existing endpoints + panel-specific routes.
 * No backend schema changes; mock entities for local/test.
 */
import { apiFetch } from '../../entities/session';

const API_BASE = '';

export interface PlatformSummary {
  totalAttempts: number;
  avgScore: number;
  levelCounts: { Junior: number; Middle: number; Senior: number };
  topWeaknesses: { weakness: string; count: number }[];
  topStrengths?: { strength: string; count: number }[];
  expertSummary?: string | null;
}

export interface PlatformVoice {
  totalCalls: number;
  answeredPercent: number;
  missedPercent: number;
  avgDurationSec: number;
  outcomeBreakdown?: {
    completed: number;
    no_answer: number;
    busy: number;
    failed: number;
    disconnected: number;
  };
}

export interface AuditItem {
  id: string;
  type: 'attempt' | 'training' | 'call';
  company: string;
  dealer: string;
  date: string;
  aiScore: number;
  status: 'Good' | 'Medium' | 'Bad';
  userName: string | null;
  detailId: number;
  detailType: 'attempt' | 'training' | 'call';
}

export interface TimeSeriesPoint {
  date: string;
  avgScore: number;
  count: number;
}

export interface MockCompany {
  id: string;
  name: string;
  autodealers: number;
  avgAiScore: number;
  answerRate: number;
  lastAudit: string;
  trend: number;
}

export interface MockDealer {
  id: string;
  name: string;
  city: string;
  avgScore: number;
  audits: number;
  bestEmployee: string;
  worstMetric: string;
}

export interface SuperAdminSettings {
  totalScripts: number;
  totalPhones: number;
  platformLanguage: string;
  telephonyProvider: string;
}

export type AdminPanelSettings = SuperAdminSettings;

export interface RbacPermissionDefinition {
  key: string;
  description: string;
  scopes: string[];
}

export interface RbacMeta {
  roles: string[];
  permissions: RbacPermissionDefinition[];
  holdings: Array<{ id: string; name: string }>;
  dealerships: Array<{ id: string; name: string; holdingId: string | null; holdingName: string | null }>;
  permissionTemplates: PermissionTemplateItem[];
  canManageTemplates: boolean;
}

export type HoldingType = 'own' | 'franchised';
export type DealershipType = 'own' | 'franchised';
export type DealershipDirection = 'new_cars' | 'used_cars';

export interface HoldingItem {
  id: string;
  name: string;
  code: string | null;
  type: HoldingType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  dealershipsCount: number;
  dealerships: Array<{
    id: string;
    name: string;
    code: string | null;
    city: string | null;
    address: string | null;
    workingHoursFrom: string | null;
    workingHoursTo: string | null;
    isActive: boolean;
    holdingId: string | null;
  }>;
}

export interface DealershipItem {
  id: string;
  name: string;
  code: string | null;
  type: DealershipType;
  directions: DealershipDirection[];
  city: string | null;
  address: string | null;
  workingHoursFrom: string | null;
  workingHoursTo: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  holdingId: string | null;
  holdingName: string | null;
  managersCount: number;
}

export interface PermissionTemplateItem {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  assignedAccountsCount: number;
  isSystem: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserAccountItem {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  memberships: Array<{
    id: string;
    role: string;
    holdingId: string | null;
    holdingName: string | null;
    dealershipId: string | null;
    dealershipName: string | null;
    dealershipType: DealershipType | null;
    scopeLabel: string;
  }>;
  managerProfiles: Array<{
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    status: string;
    dealershipId: string;
    dealershipName: string;
    dealershipType: DealershipType;
    holdingId: string | null;
    holdingName: string | null;
  }>;
  phoneNumbers: PhoneNumberItem[];
  permissionTemplates: Array<{
    id: string;
    name: string;
    description: string | null;
    permissions: string[];
  }>;
}

export interface CallBatchListItem {
  id: string;
  mode: 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily';
  status: 'running' | 'paused' | 'cancelled' | 'completed';
  title: string | null;
  totalJobs: number;
  queuedJobs: number;
  inProgressJobs: number;
  completedJobs: number;
  failedJobs: number;
  retryingJobs: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CallBatchJobItem {
  id: string;
  dealershipId: string | null;
  dealershipName: string | null;
  phone: string;
  status: 'queued' | 'dialing' | 'in_progress' | 'retry_wait' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  endedAt: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  linkedAuditId?: string | null;
  hasTranscript?: boolean;
  linkReason?: string | null;
}

export type PhoneNumberOwnership = 'dealership' | 'user';

export interface PhoneNumberTypeItem {
  id: string;
  name: string;
  ownership: PhoneNumberOwnership;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PhoneNumberItem {
  id: string;
  typeId: string;
  typeName: string;
  phone: string;
  dealershipId: string | null;
  accountId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function fetchSummary(): Promise<PlatformSummary | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/summary`);
  if (!res.ok) return null;
  const data = await res.json();
  return data as PlatformSummary;
}

export async function fetchHoldings(filters?: {
  search?: string;
  type?: 'all' | HoldingType;
  status?: 'all' | 'active' | 'inactive';
}): Promise<HoldingItem[]> {
  const params = new URLSearchParams();
  const search = filters?.search?.trim();
  if (search) params.set('search', search);
  if (filters?.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters?.status && filters.status !== 'all') params.set('status', filters.status);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/holdings${suffix}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchDealerships(): Promise<DealershipItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchCities(params?: { search?: string; limit?: number; offset?: number }): Promise<{ items: string[]; hasMore: boolean; offset: number; limit: number }> {
  const query = new URLSearchParams();
  const search = params?.search?.trim();
  query.set('limit', String(params?.limit ?? 100));
  query.set('offset', String(params?.offset ?? 0));
  if (search) query.set('search', search);

  const res = await apiFetch(`${API_BASE}/api/admin/cities?${query.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить города.');
  return {
    items: Array.isArray(data.items) ? data.items : [],
    hasMore: Boolean(data.hasMore),
    offset: typeof data.offset === 'number' ? data.offset : params?.offset ?? 0,
    limit: typeof data.limit === 'number' ? data.limit : params?.limit ?? 100,
  };
}

export async function createHolding(payload: {
  name: string;
  type?: HoldingType;
  code?: string | null;
  isActive?: boolean;
  dealershipIds?: string[];
}): Promise<HoldingItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/holdings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать холдинг.');
  return data.item as HoldingItem;
}

export async function updateHolding(
  holdingId: string,
  payload: {
    name?: string;
    type?: HoldingType;
    code?: string | null;
    isActive?: boolean;
    dealershipIds?: string[];
  },
): Promise<HoldingItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/holdings/${holdingId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить холдинг.');
  return data.item as HoldingItem;
}

export async function deleteHolding(holdingId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/holdings/${holdingId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить холдинг.');
}

export async function createDealership(payload: {
  name: string;
  code?: string | null;
  type?: DealershipType;
  directions?: DealershipDirection[];
  city?: string | null;
  address?: string | null;
  workingHoursFrom: string;
  workingHoursTo: string;
  holdingId?: string | null;
  isActive?: boolean;
}): Promise<DealershipItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать автосалон.');
  return data.item as DealershipItem;
}

export async function updateDealership(
  dealershipId: string,
  payload: {
    name?: string;
    code?: string | null;
    type?: DealershipType;
    directions?: DealershipDirection[];
    city?: string | null;
    address?: string | null;
    workingHoursFrom?: string;
    workingHoursTo?: string;
    holdingId?: string | null;
    isActive?: boolean;
  },
): Promise<DealershipItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships/${dealershipId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить автосалон.');
  return data.item as DealershipItem;
}

export async function deleteDealership(dealershipId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships/${dealershipId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить автосалон.');
}

export async function fetchPhoneNumberTypes(filters?: {
  ownership?: PhoneNumberOwnership;
  active?: boolean;
}): Promise<PhoneNumberTypeItem[]> {
  const params = new URLSearchParams();
  if (filters?.ownership) params.set('ownership', filters.ownership);
  if (filters?.active) params.set('active', 'true');
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/phone-number-types${suffix}`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as PhoneNumberTypeItem[] : [];
}

export async function createPhoneNumberType(payload: {
  name: string;
  ownership: PhoneNumberOwnership;
  isActive?: boolean;
}): Promise<PhoneNumberTypeItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/phone-number-types`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать тип номера.');
  return data.item as PhoneNumberTypeItem;
}

export async function updatePhoneNumberType(
  typeId: string,
  payload: {
    name?: string;
    ownership?: PhoneNumberOwnership;
    isActive?: boolean;
  },
): Promise<PhoneNumberTypeItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/phone-number-types/${typeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить тип номера.');
  return data.item as PhoneNumberTypeItem;
}

export async function fetchDealershipPhoneNumbers(dealershipId: string): Promise<PhoneNumberItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships/${dealershipId}/phone-numbers`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as PhoneNumberItem[] : [];
}

export async function createDealershipPhoneNumber(
  dealershipId: string,
  payload: { typeId: string; phone: string; isActive?: boolean },
): Promise<PhoneNumberItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealerships/${dealershipId}/phone-numbers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось добавить номер телефона.');
  return data.item as PhoneNumberItem;
}

export async function updateDealershipPhoneNumber(
  phoneNumberId: string,
  payload: { typeId?: string; phone?: string; isActive?: boolean },
): Promise<PhoneNumberItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealership-phone-numbers/${phoneNumberId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить номер телефона.');
  return data.item as PhoneNumberItem;
}

export async function deleteDealershipPhoneNumber(phoneNumberId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/dealership-phone-numbers/${phoneNumberId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить номер телефона.');
}

export async function fetchUserPhoneNumbers(accountId: string): Promise<PhoneNumberItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}/phone-numbers`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items as PhoneNumberItem[] : [];
}

export async function createUserPhoneNumber(
  accountId: string,
  payload: { typeId: string; phone: string; isActive?: boolean },
): Promise<PhoneNumberItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}/phone-numbers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось добавить номер телефона.');
  return data.item as PhoneNumberItem;
}

export async function updateUserPhoneNumber(
  phoneNumberId: string,
  payload: { typeId?: string; phone?: string; isActive?: boolean },
): Promise<PhoneNumberItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/user-phone-numbers/${phoneNumberId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить номер телефона.');
  return data.item as PhoneNumberItem;
}

export async function deleteUserPhoneNumber(phoneNumberId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/user-phone-numbers/${phoneNumberId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить номер телефона.');
}

export async function syncMockOrganization(): Promise<{
  holdingsCreated: number;
  dealershipsCreated: number;
  dealershipsUpdated: number;
}> {
  const res = await apiFetch(`${API_BASE}/api/admin/organization/sync-mock`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось синхронизировать моковую структуру.');
  return data.summary ?? { holdingsCreated: 0, dealershipsCreated: 0, dealershipsUpdated: 0 };
}

export async function fetchVoiceDashboard(): Promise<PlatformVoice | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/voice-dashboard`);
  if (!res.ok) return null;
  return (await res.json()) as PlatformVoice;
}

export async function fetchAudits(limit = 100): Promise<AuditItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/super-admin/audits?limit=${limit}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return [];
  const data = await res.json();
  return data.audits ?? [];
}

export async function fetchTimeSeries(): Promise<TimeSeriesPoint[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/super-admin/time-series`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return [];
  const data = await res.json();
  return data.series ?? [];
}

export async function fetchMockEntities(): Promise<{ companies: MockCompany[]; dealers: MockDealer[] }> {
  const res = await apiFetch(`${API_BASE}/api/admin/super-admin/mock-entities`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return { companies: [], dealers: [] };
  const data = await res.json();
  return { companies: data.companies ?? [], dealers: data.dealers ?? [] };
}

export async function fetchSuperAdminSettings(): Promise<SuperAdminSettings | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/super-admin/settings`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return null;
  return (await res.json()) as SuperAdminSettings;
}

export const fetchAdminPanelSettings = fetchSuperAdminSettings;

export async function fetchCallBatches(limit = 60, mode: 'all' | 'manual' | 'single_dealership' | 'all_dealerships' | 'auto_daily' = 'all'): Promise<CallBatchListItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-batches?limit=${limit}&mode=${mode}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchCallBatchJobs(batchId: string, limit = 300): Promise<CallBatchJobItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-batches/${batchId}/jobs?limit=${limit}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchCallBatchById(batchId: string): Promise<CallBatchListItem | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/call-batches/${batchId}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) return null;
  const data = await res.json();
  return (data?.batch ?? null) as CallBatchListItem | null;
}

export async function fetchRbacMeta(): Promise<RbacMeta> {
  const res = await apiFetch(`${API_BASE}/api/admin/rbac/meta`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) throw new Error('Не удалось загрузить RBAC-метаданные');
  return (await res.json()) as RbacMeta;
}

export async function fetchUsers(search = ''): Promise<{ items: UserAccountItem[]; canManageTemplates: boolean }> {
  const suffix = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  const res = await apiFetch(`${API_BASE}/api/admin/users${suffix}`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  if (!res.ok) throw new Error('Не удалось загрузить пользователей');
  return (await res.json()) as { items: UserAccountItem[]; canManageTemplates: boolean };
}

export async function createUser(payload: Record<string, unknown>): Promise<UserAccountItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать пользователя');
  return data.item as UserAccountItem;
}

export async function updateUser(accountId: string, payload: Record<string, unknown>): Promise<UserAccountItem | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить пользователя');
  return (data.item ?? null) as UserAccountItem | null;
}

export async function changeOwnPassword(password: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/me/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось изменить пароль');
}

export async function changeUserPassword(accountId: string, password: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось изменить пароль пользователя');
}

export async function deleteUser(accountId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/users/${accountId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить пользователя');
}

export async function fetchPermissionTemplates(): Promise<PermissionTemplateItem[]> {
  const res = await apiFetch(`${API_BASE}/api/admin/permission-templates`);
  if (res.status === 404) throw new Error('BACKEND_NOT_RUNNING');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить шаблоны прав');
  return Array.isArray(data.items) ? data.items as PermissionTemplateItem[] : [];
}

export async function createPermissionTemplate(payload: Record<string, unknown>): Promise<PermissionTemplateItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/permission-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось создать шаблон прав');
  return data.item as PermissionTemplateItem;
}

export async function updatePermissionTemplate(templateId: string, payload: Record<string, unknown>): Promise<PermissionTemplateItem> {
  const res = await apiFetch(`${API_BASE}/api/admin/permission-templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось обновить шаблон прав');
  return data.item as PermissionTemplateItem;
}

export async function deletePermissionTemplate(templateId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/admin/permission-templates/${templateId}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Не удалось удалить шаблон прав');
}
