import type { AdminTab } from '../../../entities/session/model/types';

/**
 * Tabs with brutal-minimal theme (UI only).
 * - dashboard — Дашборд
 * - holdings — Компании
 * - companies — Точки
 */
export const BRUTAL_THEME_TABS: AdminTab[] = ['dashboard', 'holdings', 'companies'];

export function isBrutalThemeTab(tab: AdminTab): boolean {
  return BRUTAL_THEME_TABS.includes(tab);
}
