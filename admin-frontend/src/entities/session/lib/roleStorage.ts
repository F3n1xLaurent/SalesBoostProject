import type { AdminRole } from '../model/types';

const ROLE_STORAGE_PREFIX = 'salesboost.admin.role';
const ROLES: AdminRole[] = ['super', 'company', 'dealer', 'staff'];

function keyFor(accountId: string): string {
  return `${ROLE_STORAGE_PREFIX}.${accountId}`;
}

export function readStoredRole(accountId: string): AdminRole | null {
  try {
    const value = window.localStorage.getItem(keyFor(accountId));
    return ROLES.includes(value as AdminRole) ? value as AdminRole : null;
  } catch {
    return null;
  }
}

export function writeStoredRole(accountId: string, role: AdminRole): void {
  try {
    window.localStorage.setItem(keyFor(accountId), role);
  } catch {
    // Ignore storage errors: URL routing still keeps the current page usable.
  }
}
