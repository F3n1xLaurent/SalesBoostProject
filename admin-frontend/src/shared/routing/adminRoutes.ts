import type { AdminRole, AdminTab } from '../../entities/session/model/types';

export type AdminRouteMatch = {
  role?: AdminRole;
  tab: AdminTab;
  dealershipId?: string;
  employeeId?: string;
  auditId?: string;
  batchId?: string;
};

const SUPER_COMPANY_TABS: AdminTab[] = [
  'dashboard',
  'holdings',
  'companies',
  'users',
  'autodealers',
  'audits',
  'analytics',
  'settings',
];

const TABS_BY_ROLE: Record<AdminRole, AdminTab[]> = {
  super: SUPER_COMPANY_TABS,
  company: SUPER_COMPANY_TABS.filter((tab) => tab !== 'holdings'),
  dealer: ['dealer-companies', 'dealer-calls', 'dealer-employees', 'dealer-team', 'settings'],
  staff: ['staff-profile', 'staff-trainer', 'settings'],
};

export function getDefaultTab(role: AdminRole): AdminTab {
  if (role === 'dealer') return 'dealer-calls';
  if (role === 'staff') return 'staff-profile';
  return 'dashboard';
}

export function isTabAllowedForRole(tab: AdminTab, role: AdminRole): boolean {
  return TABS_BY_ROLE[role].includes(tab);
}

export function normalizeTabForRole(tab: AdminTab | undefined, role: AdminRole): AdminTab {
  if (tab && isTabAllowedForRole(tab, role)) return tab;
  return getDefaultTab(role);
}

export function tabToPath(tab: AdminTab): string {
  switch (tab) {
    case 'dashboard':
      return '/dashboard';
    case 'holdings':
      return '/holdings';
    case 'companies':
      return '/companies';
    case 'users':
      return '/users';
    case 'autodealers':
      return '/autodealers';
    case 'audits':
      return '/audits';
    case 'analytics':
      return '/analytics';
    case 'settings':
      return '/settings';
    case 'dealer-companies':
      return '/dealer/companies';
    case 'dealer-calls':
      return '/dealer/calls';
    case 'dealer-employees':
      return '/dealer/employees';
    case 'dealer-team':
      return '/dealer/team';
    case 'staff-profile':
      return '/staff/profile';
    case 'staff-trainer':
      return '/staff/trainer';
  }
}

export function getRoleFromPath(pathname: string): AdminRole | undefined {
  if (pathname.startsWith('/dealer')) return 'dealer';
  if (pathname.startsWith('/staff')) return 'staff';
  return undefined;
}

export function parseAdminPath(pathname: string): AdminRouteMatch {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [section, resource, id] = parts;

  if (!section) return { tab: 'dashboard' };
  if (section === 'dashboard') return { tab: 'dashboard' };
  if (section === 'holdings') return { tab: 'holdings' };
  if (section === 'companies') return { tab: 'companies', dealershipId: resource };
  if (section === 'users') return { tab: 'users' };
  if (section === 'autodealers') return { tab: 'autodealers', employeeId: resource };
  if (section === 'analytics') return { tab: 'analytics' };
  if (section === 'settings') return { tab: 'settings' };
  if (section === 'audits' && resource === 'batches') return { tab: 'audits', batchId: id };
  if (section === 'audits') return { tab: 'audits', auditId: resource };

  if (section === 'dealer') {
    if (resource === 'companies') return { role: 'dealer', tab: 'dealer-companies' };
    if (resource === 'employees') return { role: 'dealer', tab: 'dealer-employees' };
    if (resource === 'team') return { role: 'dealer', tab: 'dealer-team' };
    return { role: 'dealer', tab: 'dealer-calls' };
  }

  if (section === 'staff') {
    if (resource === 'trainer') return { role: 'staff', tab: 'staff-trainer' };
    return { role: 'staff', tab: 'staff-profile' };
  }

  return { tab: 'dashboard' };
}

export function buildDealershipPath(id: string): string {
  return `/companies/${encodeURIComponent(id)}`;
}

export function buildEmployeePath(id: string): string {
  return `/autodealers/${encodeURIComponent(id)}`;
}

export function buildAuditPath(id: string): string {
  return `/audits/${encodeURIComponent(id)}`;
}

export function buildBatchPath(id: string): string {
  return `/audits/batches/${encodeURIComponent(id)}`;
}
