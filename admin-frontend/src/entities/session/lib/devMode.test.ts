import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_MODE_STORAGE_KEY, isDevModeEnabled, setDevModeEnabled, subscribeDevMode } from './devMode';

function browser() {
  const values = new Map<string, string>();
  return Object.assign(new EventTarget(), { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
}

beforeEach(() => vi.stubGlobal('window', browser()));
afterEach(() => vi.unstubAllGlobals());

describe('browser dev mode', () => {
  it('defaults to off and persists an explicit choice', () => {
    expect(isDevModeEnabled('super')).toBe(false);
    setDevModeEnabled('super', true);
    expect(window.localStorage.getItem(DEV_MODE_STORAGE_KEY)).toBe('true');
    expect(isDevModeEnabled('super')).toBe(true);
    setDevModeEnabled('super', false);
    expect(isDevModeEnabled('super')).toBe(false);
  });

  it.each(['company', 'dealer', 'staff'] as const)('never enables dev mode for %s, even with storage enabled', (role) => {
    setDevModeEnabled('super', true);
    expect(isDevModeEnabled(role)).toBe(false);
    setDevModeEnabled(role, false);
    expect(isDevModeEnabled('super')).toBe(true);
    window.localStorage.removeItem(DEV_MODE_STORAGE_KEY);
    setDevModeEnabled(role, true);
    expect(isDevModeEnabled('super')).toBe(false);
  });

  it('keeps different browsers independent under the same account', () => {
    const first = window;
    setDevModeEnabled('super', true);
    vi.stubGlobal('window', browser());
    expect(isDevModeEnabled('super')).toBe(false);
    vi.stubGlobal('window', first);
    expect(isDevModeEnabled('super')).toBe(true);
  });

  it('notifies the current tab and synchronizes storage changes from other tabs', () => {
    const changed = vi.fn();
    const unsubscribe = subscribeDevMode(changed);
    setDevModeEnabled('super', true);
    expect(changed).toHaveBeenCalledTimes(1);
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated' }));
    expect(changed).toHaveBeenCalledTimes(1);
    window.dispatchEvent(Object.assign(new Event('storage'), { key: DEV_MODE_STORAGE_KEY }));
    window.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
    setDevModeEnabled('super', false);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('stays off without crashing when localStorage is blocked', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage denied'); } });
    expect(isDevModeEnabled('super')).toBe(false);
    expect(() => setDevModeEnabled('super', true)).not.toThrow();
  });
});
