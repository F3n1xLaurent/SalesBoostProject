import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTabAllowedForRole, normalizeTabForRole, parseAdminPath, tabToPath } from '../../admin-frontend/src/shared/routing/adminRoutes';

describe('standalone realtime testing navigation', () => {
  it('opens a separate section and preserves the old URL as an alias', () => {
    expect(tabToPath('testing')).toBe('/testing');
    expect(parseAdminPath('/testing')).toEqual({ tab: 'testing' });
    expect(parseAdminPath('/testing/')).toEqual({ tab: 'testing' });
    expect(parseAdminPath('/call-settings/realtime-test')).toEqual({ tab: 'testing' });
    expect(parseAdminPath('/call-settings/realtime-test/')).toEqual({ tab: 'testing' });
  });
  it('retains the same roles as the old call-settings tab', () => {
    for (const role of ['super', 'company', 'dealer', 'staff'] as const) {
      expect(isTabAllowedForRole('testing', role)).toBe(isTabAllowedForRole('callSettings', role));
    }
    expect(normalizeTabForRole('testing', 'dealer')).toBe('dealer-companies');
    expect(normalizeTabForRole('testing', 'staff')).toBe('staff-profile');
  });
  it('does not change the existing call-settings routes', () => {
    for (const path of ['/call-settings', '/call-settings/profiles', '/call-settings/scripts/new', '/call-settings/plans/plan-id/edit']) {
      expect(parseAdminPath(path)).toEqual({ tab: 'callSettings' });
    }
    expect(tabToPath('callSettings')).toBe('/call-settings/profiles');
  });
  it('places Testing in the requested menu group and removes the former inner tab', () => {
    const sidebar = readFileSync(resolve('admin-frontend/src/widgets/admin-sidebar/ui/AdminSidebar.tsx'), 'utf8');
    const internal = sidebar.indexOf("label: 'Внутренняя аналитика'");
    const testing = sidebar.indexOf("label: 'Тестирование'");
    expect(testing).toBeGreaterThan(internal);
    expect(testing).toBeLessThan(sidebar.indexOf("label: 'Справочники'"));
    const settings = readFileSync(resolve('admin-frontend/src/pages/call-settings/ui/CallSettingsPage.tsx'), 'utf8');
    expect(settings).not.toContain('Realtime-тест');
    expect(settings).not.toContain('YandexRealtimeTestPage');
  });
});
