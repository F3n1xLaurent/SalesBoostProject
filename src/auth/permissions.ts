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
    platformView: 'dashboard.platform.view',
    holdingView: 'dashboard.holding.view',
    dealershipView: 'dashboard.dealership.view',
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
    platformView: 'settings.platform.view',
    holdingView: 'settings.holding.view',
    dealershipView: 'settings.dealership.view',
    managerView: 'settings.manager.view',
  },
  expenses: {
    view: 'expenses.view',
    export: 'expenses.export',
  },
  voice: {
    diagnostics: 'voice.diagnostics',
  },
  ux: {
    holdings: {
      view: 'ux.holdings.view',
    },
    dealerships: {
      list: 'ux.dealerships.list',
      detail: 'ux.dealerships.detail',
    },
    phoneNumberTypes: {
      view: 'ux.phone_number_types.view',
    },
    users: {
      view: 'ux.users.view',
    },
    employees: {
      list: 'ux.employees.list',
      detail: 'ux.employees.detail',
    },
    audits: {
      employeesView: 'ux.audits.employees.view',
      dealershipsView: 'ux.audits.dealerships.view',
      detail: 'ux.audits.detail',
      batchesView: 'ux.audits.batches.view',
    },
    analytics: {
      platformView: 'ux.analytics.platform.view',
      holdingView: 'ux.analytics.holding.view',
      dealershipTeamView: 'ux.analytics.dealership_team.view',
    },
    dealershipWorkspace: {
      overview: 'ux.dealership_workspace.overview',
      calls: 'ux.dealership_workspace.calls',
      employees: 'ux.dealership_workspace.employees',
      team: 'ux.dealership_workspace.team',
    },
    staffWorkspace: {
      profile: 'ux.staff_workspace.profile',
      trainer: 'ux.staff_workspace.trainer',
    },
    permissionTemplates: {
      view: 'ux.permission_templates.view',
    },
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
  { key: PERMISSIONS.dashboard.platformView, description: 'Просмотр платформенного дашборда суперадмина.', scopes: ['platform'] },
  { key: PERMISSIONS.dashboard.holdingView, description: 'Просмотр дашборда холдинга.', scopes: ['holding'] },
  { key: PERMISSIONS.dashboard.dealershipView, description: 'Просмотр дашборда/сводки автосалона.', scopes: ['dealer'] },
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
  { key: PERMISSIONS.settings.platformView, description: 'Просмотр настроек в роли суперадмина платформы.', scopes: ['platform'] },
  { key: PERMISSIONS.settings.holdingView, description: 'Просмотр настроек в роли администратора холдинга.', scopes: ['holding'] },
  { key: PERMISSIONS.settings.dealershipView, description: 'Просмотр настроек в роли администратора автосалона.', scopes: ['dealer'] },
  { key: PERMISSIONS.settings.managerView, description: 'Просмотр настроек аккаунта менеджера.', scopes: ['manager-self'] },
  { key: PERMISSIONS.expenses.view, description: 'Просмотр расходов и служебной финансовой сводки.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.expenses.export, description: 'Экспорт расходов и финансовой сводки.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.voice.diagnostics, description: 'Просмотр voice env checks, test numbers и оркестраторных диагностик.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.ux.holdings.view, description: 'UX-блок: страница холдингов.', scopes: ['platform'] },
  { key: PERMISSIONS.ux.dealerships.list, description: 'UX-блок: список автосалонов.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.ux.dealerships.detail, description: 'UX-блок: карточка автосалона.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.ux.phoneNumberTypes.view, description: 'UX-блок: типы телефонных номеров.', scopes: ['platform'] },
  { key: PERMISSIONS.ux.users.view, description: 'UX-блок: страница пользователей.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.ux.employees.list, description: 'UX-блок: список сотрудников.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.ux.employees.detail, description: 'UX-блок: карточка сотрудника.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.ux.audits.employeesView, description: 'UX-блок: проверки по сотрудникам.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.ux.audits.dealershipsView, description: 'UX-блок: проверки по автосалонам.', scopes: ['platform', 'holding'] },
  { key: PERMISSIONS.ux.audits.detail, description: 'UX-блок: детальный разбор проверки.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.ux.audits.batchesView, description: 'UX-блок: batch-проверки.', scopes: ['platform', 'holding', 'dealer'] },
  { key: PERMISSIONS.ux.analytics.platformView, description: 'UX-блок: аналитика платформы.', scopes: ['platform'] },
  { key: PERMISSIONS.ux.analytics.holdingView, description: 'UX-блок: аналитика холдинга.', scopes: ['holding'] },
  { key: PERMISSIONS.ux.analytics.dealershipTeamView, description: 'UX-блок: аналитика команды автосалона.', scopes: ['dealer'] },
  { key: PERMISSIONS.ux.dealershipWorkspace.overview, description: 'UX-блок дилера: автосалон.', scopes: ['dealer'] },
  { key: PERMISSIONS.ux.dealershipWorkspace.calls, description: 'UX-блок дилера: звонки.', scopes: ['dealer'] },
  { key: PERMISSIONS.ux.dealershipWorkspace.employees, description: 'UX-блок дилера: сотрудники.', scopes: ['dealer'] },
  { key: PERMISSIONS.ux.dealershipWorkspace.team, description: 'UX-блок дилера: команда.', scopes: ['dealer'] },
  { key: PERMISSIONS.ux.staffWorkspace.profile, description: 'UX-блок менеджера: профиль.', scopes: ['manager-self'] },
  { key: PERMISSIONS.ux.staffWorkspace.trainer, description: 'UX-блок менеджера: тренажёр.', scopes: ['manager-self'] },
  { key: PERMISSIONS.ux.permissionTemplates.view, description: 'UX-блок: вкладка шаблонов прав.', scopes: ['platform'] },
];

function permissionSet(values: PermissionKey[]): ReadonlySet<PermissionKey> {
  return new Set(values);
}

const HOLDING_ADMIN_PERMISSIONS = permissionSet([
  PERMISSIONS.dashboard.view,
  PERMISSIONS.dashboard.holdingView,
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
  PERMISSIONS.settings.holdingView,
  PERMISSIONS.expenses.view,
  PERMISSIONS.expenses.export,
  PERMISSIONS.voice.diagnostics,
  PERMISSIONS.ux.dealerships.list,
  PERMISSIONS.ux.dealerships.detail,
  PERMISSIONS.ux.users.view,
  PERMISSIONS.ux.employees.list,
  PERMISSIONS.ux.employees.detail,
  PERMISSIONS.ux.audits.employeesView,
  PERMISSIONS.ux.audits.dealershipsView,
  PERMISSIONS.ux.audits.detail,
  PERMISSIONS.ux.audits.batchesView,
  PERMISSIONS.ux.analytics.holdingView,
]);

const DEALERSHIP_ADMIN_PERMISSIONS = permissionSet([
  PERMISSIONS.dashboard.view,
  PERMISSIONS.dashboard.dealershipView,
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
  PERMISSIONS.settings.dealershipView,
  PERMISSIONS.voice.diagnostics,
  PERMISSIONS.ux.dealerships.detail,
  PERMISSIONS.ux.employees.list,
  PERMISSIONS.ux.employees.detail,
  PERMISSIONS.ux.audits.detail,
  PERMISSIONS.ux.audits.batchesView,
  PERMISSIONS.ux.analytics.dealershipTeamView,
  PERMISSIONS.ux.dealershipWorkspace.overview,
  PERMISSIONS.ux.dealershipWorkspace.calls,
  PERMISSIONS.ux.dealershipWorkspace.employees,
  PERMISSIONS.ux.dealershipWorkspace.team,
]);

const MANAGER_PERMISSIONS = permissionSet([
  PERMISSIONS.profile.view,
  PERMISSIONS.profile.edit,
  PERMISSIONS.training.view,
  PERMISSIONS.training.run,
  PERMISSIONS.training.review,
  PERMISSIONS.settings.managerView,
  PERMISSIONS.ux.staffWorkspace.profile,
  PERMISSIONS.ux.staffWorkspace.trainer,
]);

export const ROLE_PERMISSION_PRESETS: Record<AppRole, ReadonlySet<PermissionKey>> = {
  [APP_ROLES.platformSuperadmin]: permissionSet(ALL_PERMISSIONS),
  [APP_ROLES.holdingAdmin]: HOLDING_ADMIN_PERMISSIONS,
  [APP_ROLES.dealershipAdmin]: DEALERSHIP_ADMIN_PERMISSIONS,
  [APP_ROLES.manager]: MANAGER_PERMISSIONS,
};

function setToPermissions(values: ReadonlySet<PermissionKey>): PermissionKey[] {
  return Array.from(values);
}

export type SystemPermissionTemplate = {
  name: string;
  description: string;
  permissions: PermissionKey[];
};

export const SYSTEM_PERMISSION_TEMPLATES: SystemPermissionTemplate[] = [
  {
    name: 'Суперадмин платформы',
    description: 'Полный доступ ко всем разделам платформы, включая RBAC, шаблоны прав, холдинги, автосалоны, аудиты, аналитику и настройки.',
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'Администратор холдинга',
    description: 'Дашборд холдинга, автосалоны холдинга, сотрудники, пользователи-менеджеры, проверки, аналитика, расходы и настройки холдинга.',
    permissions: setToPermissions(ROLE_PERMISSION_PRESETS[APP_ROLES.holdingAdmin]),
  },
  {
    name: 'Администратор автосалона',
    description: 'Рабочее пространство автосалона: карточка салона, звонки, сотрудники, команда, проверки и настройки автосалона.',
    permissions: setToPermissions(ROLE_PERMISSION_PRESETS[APP_ROLES.dealershipAdmin]),
  },
  {
    name: 'Менеджер автосалона',
    description: 'Личный профиль менеджера, тренажёр, результаты тренировок и настройки собственного аккаунта.',
    permissions: setToPermissions(ROLE_PERMISSION_PRESETS[APP_ROLES.manager]),
  },
  {
    name: 'Аудитор звонков',
    description: 'Просмотр звонков, проверок, batch-проверок и аналитики без управления пользователями и оргструктурой.',
    permissions: [
      PERMISSIONS.dashboard.view,
      PERMISSIONS.analytics.view,
      PERMISSIONS.audit.view,
      PERMISSIONS.audit.export,
      PERMISSIONS.call.view,
      PERMISSIONS.callBatch.view,
      PERMISSIONS.ux.audits.employeesView,
      PERMISSIONS.ux.audits.dealershipsView,
      PERMISSIONS.ux.audits.detail,
      PERMISSIONS.ux.audits.batchesView,
    ],
  },
  {
    name: 'Оператор проверок',
    description: 'Запуск и управление одиночными и batch-проверками, просмотр истории звонков и результатов.',
    permissions: [
      PERMISSIONS.audit.view,
      PERMISSIONS.audit.run,
      PERMISSIONS.audit.manage,
      PERMISSIONS.call.view,
      PERMISSIONS.call.start,
      PERMISSIONS.callBatch.view,
      PERMISSIONS.callBatch.create,
      PERMISSIONS.callBatch.manage,
      PERMISSIONS.ux.audits.dealershipsView,
      PERMISSIONS.ux.audits.detail,
      PERMISSIONS.ux.audits.batchesView,
    ],
  },
  {
    name: 'Администратор пользователей',
    description: 'Управление web-аккаунтами, ролями, назначениями и шаблонами прав без доступа к операционным разделам.',
    permissions: [
      PERMISSIONS.user.view,
      PERMISSIONS.user.create,
      PERMISSIONS.user.edit,
      PERMISSIONS.user.delete,
      PERMISSIONS.permissionTemplate.view,
      PERMISSIONS.permissionTemplate.create,
      PERMISSIONS.permissionTemplate.edit,
      PERMISSIONS.permissionTemplate.assign,
      PERMISSIONS.permissionTemplate.delete,
      PERMISSIONS.ux.users.view,
      PERMISSIONS.ux.permissionTemplates.view,
    ],
  },
];

export const SUPER_ADMIN_TAB_PERMISSIONS = {
  dashboard: [PERMISSIONS.dashboard.platformView, PERMISSIONS.dashboard.holdingView],
  holdings: [PERMISSIONS.ux.holdings.view, PERMISSIONS.holding.view],
  companies: [PERMISSIONS.ux.dealerships.list, PERMISSIONS.dealer.view],
  dealershipDirections: [PERMISSIONS.dealer.view],
  typesNumbers: [PERMISSIONS.ux.phoneNumberTypes.view, PERMISSIONS.dealer.view],
  users: [PERMISSIONS.ux.users.view, PERMISSIONS.user.view],
  autodealers: [PERMISSIONS.ux.employees.list, PERMISSIONS.manager.view],
  audits: [PERMISSIONS.ux.audits.employeesView, PERMISSIONS.ux.audits.dealershipsView, PERMISSIONS.audit.view],
  analytics: [PERMISSIONS.ux.analytics.platformView, PERMISSIONS.ux.analytics.holdingView, PERMISSIONS.analytics.view],
  settings: [PERMISSIONS.settings.platformView, PERMISSIONS.settings.holdingView, PERMISSIONS.settings.dealershipView, PERMISSIONS.settings.managerView],
  'dealer-companies': [PERMISSIONS.ux.dealershipWorkspace.overview, PERMISSIONS.dealer.view],
  'dealer-calls': [PERMISSIONS.ux.dealershipWorkspace.calls, PERMISSIONS.call.view],
  'dealer-employees': [PERMISSIONS.ux.dealershipWorkspace.employees, PERMISSIONS.manager.view],
  'dealer-team': [PERMISSIONS.ux.dealershipWorkspace.team, PERMISSIONS.ux.analytics.dealershipTeamView],
  'staff-profile': [PERMISSIONS.ux.staffWorkspace.profile, PERMISSIONS.profile.view],
  'staff-trainer': [PERMISSIONS.ux.staffWorkspace.trainer, PERMISSIONS.training.run],
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
  '/api/admin/dealership-directions': [PERMISSIONS.dealer.view],
  '/api/admin/dealership-directions/:directionId': [PERMISSIONS.dealer.edit],
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
