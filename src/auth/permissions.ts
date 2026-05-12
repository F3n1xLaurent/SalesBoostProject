import type { AccountMembership } from '@prisma/client';

export const APP_ROLES = {
  platformSuperadmin: 'platform_superadmin',
  holdingAdmin: 'holding_admin',
  dealershipAdmin: 'dealership_admin',
  manager: 'manager',
} as const;

export type AppRole = (typeof APP_ROLES)[keyof typeof APP_ROLES];

export const PERMISSIONS = {
  dashboard: {
    view: 'dashboard.view',
  },
  analytics: {
    view: 'analytics.view',
    export: 'analytics.export',
  },
  holding: {
    view: 'holding.view',
    edit: 'holding.edit',
  },
  dealer: {
    view: 'dealer.view',
    edit: 'dealer.edit',
  },
  manager: {
    view: 'manager.view',
    edit: 'manager.edit',
  },
  user: {
    view: 'user.view',
    create: 'user.create',
    edit: 'user.edit',
    delete: 'user.delete',
  },
  permissionTemplate: {
    view: 'permission_template.view',
    create: 'permission_template.create',
    edit: 'permission_template.edit',
    assign: 'permission_template.assign',
    delete: 'permission_template.delete',
  },
  audit: {
    view: 'audit.view',
    export: 'audit.export',
    run: 'audit.run',
    manage: 'audit.manage',
  },
  call: {
    view: 'call.view',
    start: 'call.start',
  },
  callBatch: {
    view: 'call_batch.view',
    create: 'call_batch.create',
    manage: 'call_batch.manage',
  },
  training: {
    view: 'training.view',
    run: 'training.run',
    review: 'training.review',
  },
  profile: {
    view: 'profile.view',
    edit: 'profile.edit',
  },
  settings: {
    view: 'settings.view',
    edit: 'settings.edit',
  },
  expenses: {
    view: 'expenses.view',
    export: 'expenses.export',
  },
  voice: {
    diagnostics: 'voice.diagnostics',
  },
} as const;

type PermissionTree = typeof PERMISSIONS;
type LeafValues<T> = T extends string ? T : T extends Record<string, unknown> ? LeafValues<T[keyof T]> : never;
export type PermissionKey = LeafValues<PermissionTree>;

export type PermissionScope =
  | 'platform'
  | 'holding'
  | 'dealer'
  | 'manager-self';

export type PermissionDefinition = {
  key: PermissionKey;
  description: string;
  scopes: PermissionScope[];
};

function flattenPermissions(tree: Record<string, unknown>): PermissionKey[] {
  const out: PermissionKey[] = [];
  for (const value of Object.values(tree)) {
    if (typeof value === 'string') {
      out.push(value as PermissionKey);
      continue;
    }
    if (value && typeof value === 'object') {
      out.push(...flattenPermissions(value as Record<string, unknown>));
    }
  }
  return out;
}

export const ALL_PERMISSIONS: PermissionKey[] = flattenPermissions(PERMISSIONS);

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { key: PERMISSIONS.dashboard.view, description: 'Просмотр платформенного дашборда и сводных KPI.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.analytics.view, description: 'Просмотр аналитики и AI summary.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.analytics.export, description: 'Экспорт аналитических отчётов.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.holding.view, description: 'Просмотр холдингов и их агрегированных данных.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.holding.edit, description: 'Изменение холдингов и их конфигурации.', scopes: ['platform'] },
  { key: PERMISSIONS.dealer.view, description: 'Просмотр автосалонов и карточек автосалона.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.dealer.edit, description: 'Редактирование автосалонов и их конфигурации.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.manager.view, description: 'Просмотр сотрудников, попыток, профилей и связанных данных.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.manager.edit, description: 'Редактирование сотрудников и их организационной привязки.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.user.view, description: 'Просмотр web-аккаунтов и их прав.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.user.create, description: 'Создание аккаунтов пользователей.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.user.edit, description: 'Редактирование аккаунтов пользователей и их назначений.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.user.delete, description: 'Удаление аккаунтов пользователей.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.permissionTemplate.view, description: 'Просмотр шаблонов прав.', scopes: ['platform'] },
  { key: PERMISSIONS.permissionTemplate.create, description: 'Создание шаблонов прав.', scopes: ['platform'] },
  { key: PERMISSIONS.permissionTemplate.edit, description: 'Редактирование шаблонов прав.', scopes: ['platform'] },
  { key: PERMISSIONS.permissionTemplate.assign, description: 'Назначение шаблонов прав аккаунтам.', scopes: ['platform'] },
  { key: PERMISSIONS.permissionTemplate.delete, description: 'Удаление шаблонов прав.', scopes: ['platform'] },
  { key: PERMISSIONS.audit.view, description: 'Просмотр проверок, разборов, батчей и деталей аудита.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.audit.export, description: 'Экспорт разборов и проверок.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.audit.run, description: 'Запуск ручных проверок и батчей.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.audit.manage, description: 'Пауза, возобновление и остановка батчей проверок.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.call.view, description: 'Просмотр истории звонков и связанных метрик.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.call.start, description: 'Запуск одиночного звонка.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.callBatch.view, description: 'Просмотр списков batch-звонков и их jobs.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.callBatch.create, description: 'Создание batch-звонков.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.callBatch.manage, description: 'Управление batch-звонками: pause, resume, cancel.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.training.view, description: 'Просмотр тренировок и попыток.', scopes: ['platform', 'holding', 'dealer', 'manager-self'] },
  { key: PERMISSIONS.training.run, description: 'Запуск собственных тренировок.', scopes: ['manager-self'] },
  { key: PERMISSIONS.training.review, description: 'Просмотр детальных результатов тренировок.', scopes: ['platform', 'holding', 'dealer', 'manager-self'] },
  { key: PERMISSIONS.profile.view, description: 'Просмотр собственного профиля.', scopes: ['manager-self'] },
  { key: PERMISSIONS.profile.edit, description: 'Редактирование собственного профиля.', scopes: ['manager-self'] },
  { key: PERMISSIONS.settings.view, description: 'Просмотр системных и телеком-настроек.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.settings.edit, description: 'Изменение системных и телеком-настроек.', scopes: ['platform'] },
  { key: PERMISSIONS.expenses.view, description: 'Просмотр расходов и служебной финансовой сводки.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.expenses.export, description: 'Экспорт расходов и финансовой сводки.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.voice.diagnostics, description: 'Просмотр voice env checks, test numbers и оркестраторных диагностик.', scopes: ['platform', 'holding', 'dealer'] },
];

function permissionSet(values: PermissionKey[]): ReadonlySet<PermissionKey> {
  return new Set(values);
}

const HOLDING_ADMIN_PERMISSIONS = permissionSet([
  PERMISSIONS.dashboard.view,
  PERMISSIONS.analytics.view,
  PERMISSIONS.analytics.export,
  PERMISSIONS.holding.view,
  PERMISSIONS.dealer.view,
  PERMISSIONS.dealer.edit,
  PERMISSIONS.manager.view,
  PERMISSIONS.manager.edit,
  PERMISSIONS.user.view,
  PERMISSIONS.user.create,
  PERMISSIONS.user.edit,
  PERMISSIONS.user.delete,
  PERMISSIONS.audit.view,
  PERMISSIONS.audit.export,
  PERMISSIONS.audit.run,
  PERMISSIONS.audit.manage,
  PERMISSIONS.call.view,
  PERMISSIONS.call.start,
  PERMISSIONS.callBatch.view,
  PERMISSIONS.callBatch.create,
  PERMISSIONS.callBatch.manage,
  PERMISSIONS.training.view,
  PERMISSIONS.training.review,
  PERMISSIONS.settings.view,
  PERMISSIONS.expenses.view,
  PERMISSIONS.expenses.export,
  PERMISSIONS.voice.diagnostics,
]);

const DEALERSHIP_ADMIN_PERMISSIONS = permissionSet([
  PERMISSIONS.dashboard.view,
  PERMISSIONS.analytics.view,
  PERMISSIONS.analytics.export,
  PERMISSIONS.dealer.view,
  PERMISSIONS.dealer.edit,
  PERMISSIONS.manager.view,
  PERMISSIONS.manager.edit,
  PERMISSIONS.user.view,
  PERMISSIONS.user.create,
  PERMISSIONS.user.edit,
  PERMISSIONS.user.delete,
  PERMISSIONS.audit.view,
  PERMISSIONS.audit.export,
  PERMISSIONS.audit.run,
  PERMISSIONS.audit.manage,
  PERMISSIONS.call.view,
  PERMISSIONS.call.start,
  PERMISSIONS.callBatch.view,
  PERMISSIONS.callBatch.create,
  PERMISSIONS.callBatch.manage,
  PERMISSIONS.training.view,
  PERMISSIONS.training.review,
  PERMISSIONS.settings.view,
  PERMISSIONS.voice.diagnostics,
]);

const MANAGER_PERMISSIONS = permissionSet([
  PERMISSIONS.profile.view,
  PERMISSIONS.profile.edit,
  PERMISSIONS.training.view,
  PERMISSIONS.training.run,
  PERMISSIONS.training.review,
]);

export const ROLE_PERMISSION_PRESETS: Record<AppRole, ReadonlySet<PermissionKey>> = {
  [APP_ROLES.platformSuperadmin]: permissionSet(ALL_PERMISSIONS),
  [APP_ROLES.holdingAdmin]: HOLDING_ADMIN_PERMISSIONS,
  [APP_ROLES.dealershipAdmin]: DEALERSHIP_ADMIN_PERMISSIONS,
  [APP_ROLES.manager]: MANAGER_PERMISSIONS,
};

export const SUPER_ADMIN_TAB_PERMISSIONS = {
  dashboard: [PERMISSIONS.dashboard.view],
  holdings: [PERMISSIONS.holding.view, PERMISSIONS.dealer.view],
  companies: [PERMISSIONS.holding.view, PERMISSIONS.dealer.view],
  typesNumbers: [PERMISSIONS.dealer.view],
  users: [PERMISSIONS.user.view],
  autodealers: [PERMISSIONS.manager.view],
  audits: [PERMISSIONS.audit.view],
  analytics: [PERMISSIONS.analytics.view],
  settings: [PERMISSIONS.settings.view],
  'dealer-companies': [PERMISSIONS.dealer.view],
  'dealer-calls': [PERMISSIONS.call.view],
  'dealer-employees': [PERMISSIONS.manager.view],
  'dealer-team': [PERMISSIONS.analytics.view],
  'staff-profile': [PERMISSIONS.profile.view],
  'staff-trainer': [PERMISSIONS.training.run],
} as const;

export const ADMIN_API_PERMISSION_MAP = {
  '/api/admin/summary': [PERMISSIONS.dashboard.view],
  '/api/admin/voice-dashboard': [PERMISSIONS.dashboard.view],
  '/api/admin/expenses': [PERMISSIONS.expenses.view],
  '/api/admin/managers': [PERMISSIONS.manager.view],
  '/api/admin/managers/:managerId/attempts': [PERMISSIONS.manager.view, PERMISSIONS.training.view],
  '/api/admin/users': [PERMISSIONS.user.view],
  '/api/admin/users/:accountId': [PERMISSIONS.user.edit],
  '/api/admin/users/:accountId/password': [PERMISSIONS.user.edit],
  '/api/admin/me/password': [PERMISSIONS.profile.edit],
  '/api/admin/users/:accountId/delete': [PERMISSIONS.user.delete],
  '/api/admin/rbac/meta': [PERMISSIONS.user.view],
  '/api/admin/holdings': [PERMISSIONS.holding.view],
  '/api/admin/holdings/:holdingId': [PERMISSIONS.holding.edit],
  '/api/admin/dealerships': [PERMISSIONS.dealer.view],
  '/api/admin/dealerships/:dealershipId': [PERMISSIONS.dealer.edit],
  '/api/admin/phone-number-types': [PERMISSIONS.dealer.view],
  '/api/admin/phone-number-types/:typeId': [PERMISSIONS.dealer.edit],
  '/api/admin/dealerships/:dealershipId/phone-numbers': [PERMISSIONS.dealer.view],
  '/api/admin/dealership-phone-numbers/:phoneNumberId': [PERMISSIONS.dealer.edit],
  '/api/admin/organization/sync-mock': [PERMISSIONS.holding.edit, PERMISSIONS.dealer.edit],
  '/api/admin/permission-templates': [PERMISSIONS.permissionTemplate.view],
  '/api/admin/permission-templates/:templateId': [PERMISSIONS.permissionTemplate.edit],
  '/api/admin/permission-templates/:templateId/delete': [PERMISSIONS.permissionTemplate.delete],
  '/api/admin/attempts': [PERMISSIONS.training.view],
  '/api/admin/attempts/:attemptId': [PERMISSIONS.training.review],
  '/api/admin/training-sessions/:sessionId': [PERMISSIONS.training.review],
  '/api/admin/call-history': [PERMISSIONS.call.view],
  '/api/admin/call-history/:id': [PERMISSIONS.call.view],
  '/api/admin/start-voice-call': [PERMISSIONS.call.start],
  '/api/admin/call-batches': [PERMISSIONS.callBatch.view, PERMISSIONS.callBatch.create],
  '/api/admin/call-batches/:id': [PERMISSIONS.callBatch.view],
  '/api/admin/call-batches/:id/jobs': [PERMISSIONS.callBatch.view],
  '/api/admin/call-batches/:id/pause': [PERMISSIONS.callBatch.manage],
  '/api/admin/call-batches/:id/resume': [PERMISSIONS.callBatch.manage],
  '/api/admin/call-batches/:id/cancel': [PERMISSIONS.callBatch.manage],
  '/api/admin/voice-env-check': [PERMISSIONS.voice.diagnostics],
  '/api/admin/test-numbers': [PERMISSIONS.voice.diagnostics],
  '/api/admin/super-admin/audits': [PERMISSIONS.audit.view],
  '/api/admin/super-admin/time-series': [PERMISSIONS.analytics.view],
  '/api/admin/super-admin/mock-entities': [PERMISSIONS.holding.view, PERMISSIONS.dealer.view],
  '/api/admin/super-admin/settings': [PERMISSIONS.settings.view],
  '/api/admin/super-admin/dealership-schedules': [PERMISSIONS.voice.diagnostics],
  '/api/admin/super-admin/call-orchestrator-config': [PERMISSIONS.settings.view],
} as const;

export type PermissionScopeContext = {
  holdingId?: string | null;
  dealershipId?: string | null;
  allowSelf?: boolean;
};

export function getRolePermissions(role: AppRole): ReadonlySet<PermissionKey> {
  return ROLE_PERMISSION_PRESETS[role];
}

export function membershipGrantsPermission(
  membership: Pick<AccountMembership, 'role' | 'holdingId' | 'dealershipId'>,
  permission: PermissionKey,
  scope?: PermissionScopeContext,
): boolean {
  const role = membership.role as AppRole;
  const permissions = ROLE_PERMISSION_PRESETS[role];
  if (!permissions || !permissions.has(permission)) return false;

  if (role === APP_ROLES.platformSuperadmin) return true;
  if (role === APP_ROLES.holdingAdmin) {
    if (!scope?.holdingId) return true;
    return membership.holdingId === scope.holdingId;
  }
  if (role === APP_ROLES.dealershipAdmin) {
    if (!scope?.dealershipId) return true;
    return membership.dealershipId === scope.dealershipId;
  }
  if (role === APP_ROLES.manager) {
    if (permission === PERMISSIONS.profile.view || permission === PERMISSIONS.profile.edit) {
      return !!scope?.allowSelf;
    }
    if (
      permission === PERMISSIONS.training.view ||
      permission === PERMISSIONS.training.run ||
      permission === PERMISSIONS.training.review
    ) {
      if (scope?.dealershipId) {
        return membership.dealershipId === scope.dealershipId;
      }
      return !!scope?.allowSelf;
    }
  }

  return true;
}
