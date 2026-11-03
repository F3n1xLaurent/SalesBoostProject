import type { AdminRole } from '../model/types';

export const DEV_MODE_STORAGE_KEY = 'salesboost.admin.dev-mode';
const CHANGE_EVENT = 'salesboost:dev-mode-change';

/** A preference of this browser, never an account permission. */
export function isDevModeEnabled(role: AdminRole): boolean {
  if (role !== 'super') return false;
  try {
    return window.localStorage.getItem(DEV_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setDevModeEnabled(role: AdminRole, enabled: boolean): void {
  if (role !== 'super') return;
  try {
    window.localStorage.setItem(DEV_MODE_STORAGE_KEY, String(enabled));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Keep the mode off when browser storage is unavailable.
  }
}

export function subscribeDevMode(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key === DEV_MODE_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}
