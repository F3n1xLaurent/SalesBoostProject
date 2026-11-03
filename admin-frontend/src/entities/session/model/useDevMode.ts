import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { isDevModeEnabled, setDevModeEnabled, subscribeDevMode } from '../lib/devMode';
import type { AdminRole } from './types';

/** Technical UI must check the active role as well as the browser preference. */
export const DevModeRoleContext = createContext<AdminRole>('staff');

export function useDevMode(role?: AdminRole) {
  const contextRole = useContext(DevModeRoleContext);
  const activeRole = role ?? contextRole;
  const getSnapshot = useCallback(() => isDevModeEnabled(activeRole), [activeRole]);
  const devMode = useSyncExternalStore(subscribeDevMode, getSnapshot, () => false);
  const setDevMode = useCallback((enabled: boolean) => setDevModeEnabled(activeRole, enabled), [activeRole]);
  return { devMode, setDevMode };
}
