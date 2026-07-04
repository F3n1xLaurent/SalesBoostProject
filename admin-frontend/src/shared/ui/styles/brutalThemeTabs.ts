import type { AdminTab } from '../../../entities/session/model/types';

/**
 * Brutal-minimal theme is applied globally on `.super-admin-app`.
 * This helper is kept for compatibility with any tab-scoped checks.
 */
export function isBrutalThemeTab(_tab?: AdminTab): boolean {
  return true;
}
