import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { AdminRole, AdminTab } from '../../../entities/session/model/types';
import { getDefaultTab } from '../../../shared/routing/adminRoutes';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import sidebarLogo from '../../../assets/logo.png';

export type { AdminRole };

const SIDEBAR_WIDTH = 260;
const NAV_ICON_SIZE = 23;

const ROLE_LABELS: Record<AdminRole, string> = {
  super: 'Суперадмин',
  company: 'Руководитель компании',
  dealer: 'Руководитель точки',
  staff: 'Менеджер',
};

function getProfileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

type NavItem = { id: AdminTab; label: string; icon: string };
type NavEntry = NavItem | { type: 'separator' };

const SUPER_NAV_MAIN: NavItem[] = [
  { id: 'dashboard', label: 'Дашборд', icon: 'chart' },
  { id: 'analytics', label: 'Аналитика', icon: 'pie-chart' },
  { id: 'holdings', label: 'Компании', icon: 'shop' },
  { id: 'companies', label: 'Точки', icon: 'pin' },
  { id: 'users', label: 'Сотрудники', icon: 'user' },
  { id: 'audits', label: 'Проверки', icon: 'check-ring' },
];

const SUPER_NAV_SECONDARY: NavItem[] = [
  { id: 'imports', label: 'Данные', icon: 'database' },
  { id: 'dealershipDirections', label: 'Направления точек', icon: 'filter' },
  { id: 'typesNumbers', label: 'Типы номеров', icon: 'phone' },
  { id: 'callSettings', label: 'Настройки обзвона', icon: 'setting-alt-line' },
];

function buildNav(main: NavItem[], secondary: NavItem[]): NavEntry[] {
  return [...main, { type: 'separator' }, ...secondary];
}

const SUPER_NAV: NavEntry[] = [
  ...buildNav(SUPER_NAV_MAIN, SUPER_NAV_SECONDARY),
  { type: 'separator' },
  { id: 'internalAnalytics', label: 'Внутренняя аналитика', icon: 'chart' },
];

const COMPANY_NAV: NavEntry[] = buildNav(
  SUPER_NAV_MAIN.filter((item) => item.id !== 'holdings'),
  SUPER_NAV_SECONDARY.filter((item) => item.id !== 'typesNumbers'),
);

const DEALER_NAV: NavItem[] = [
  { id: 'dealer-companies', label: 'Дашборд', icon: 'chart' },
  { id: 'audits', label: 'Проверки', icon: 'check-ring' },
  { id: 'users', label: 'Сотрудники', icon: 'user' },
];

const STAFF_NAV: NavItem[] = [
  { id: 'staff-profile', label: 'Профиль', icon: 'user' },
  { id: 'staff-trainer', label: 'Тренажёр', icon: 'mic' },
];

type Props = {
  activeTab: AdminTab;
  onTab: (tab: AdminTab) => void;
  role: AdminRole;
  profileName: string;
  onRoleChange: (role: AdminRole) => void;
  hasActiveBatch?: boolean;
  onLogout: () => void;
  allowedRoles: AdminRole[];
  className?: string;
  isDrawer?: boolean;
};

export function AdminSidebar({
  activeTab,
  onTab,
  role,
  profileName,
  onRoleChange,
  hasActiveBatch = false,
  onLogout,
  allowedRoles,
  className,
  isDrawer = false,
}: Props) {
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!profileOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [profileOpen]);

  const navItems = useMemo(() => {
    if (role === 'dealer') return DEALER_NAV;
    if (role === 'staff') return STAFF_NAV;
    if (role === 'company') return COMPANY_NAV;
    return SUPER_NAV;
  }, [role]);

  const profileInitials = useMemo(() => getProfileInitials(profileName), [profileName]);

  return (
    <aside
      className={['super-admin-sidebar', className].filter(Boolean).join(' ')}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        bottom: 0,
        zIndex: isDrawer ? 1 : 40,
        overflowY: 'auto',
        padding: '24px 16px',
        display: 'flex',
        flexDirection: 'column',
        ...(isDrawer
          ? {
              background: '#F2F2F2',
              boxShadow: '8px 0 32px rgba(22, 22, 19, 0.14)',
            }
          : null),
      }}
    >
      <div className="sa-sidebar-brand-wrap" style={{ marginBottom: 24 }}>
        <img src={sidebarLogo} alt="Red Button" className="sa-sidebar-brand-logo" />
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        {navItems.map((item, index) => {
          if ('type' in item && item.type === 'separator') {
            return <div key={`sep-${index}`} className="sa-sidebar-nav-separator" aria-hidden />;
          }
          const navItem = item as NavItem;
          return (
          <button
            key={navItem.id}
            type="button"
            className={`nav-item ${activeTab === navItem.id ? 'active' : ''}`}
            onClick={() => onTab(navItem.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: '100%',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span className={`sa-sidebar-nav-icon ${activeTab === navItem.id ? 'sa-sidebar-nav-icon-active' : ''}`}>
              <LetsIcon name={navItem.icon} size={NAV_ICON_SIZE} strokeWidth={1.5} />
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {navItem.label}
              {navItem.id === 'audits' && hasActiveBatch && <span className="sa-batch-tray-dot" />}
            </span>
          </button>
          );
        })}
      </nav>

      <div className="sa-sidebar-profile" ref={profileRef} style={{ position: 'relative' }}>
        {profileOpen && (
          <div className="sa-sidebar-profile-menu">
            <button
              type="button"
              className={`sa-sidebar-profile-menu-item ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => { onTab('settings'); setProfileOpen(false); }}
            >
              <LetsIcon name="setting-alt-line" size={18} strokeWidth={1.5} />
              <span>Настройки</span>
            </button>

            <div className="sa-sidebar-role-section">
              <div className="sa-sidebar-role-label">Сменить роль (MVP)</div>
              {allowedRoles.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`sa-sidebar-role-item ${role === r ? 'active' : ''}`}
                  onClick={() => {
                    onRoleChange(r);
                    onTab(getDefaultTab(r));
                    setProfileOpen(false);
                  }}
                >
                  {role === r && <span className="sa-sidebar-role-dot" />}
                  {ROLE_LABELS[r]}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="sa-sidebar-profile-menu-item"
              onClick={() => {
                onLogout();
                setProfileOpen(false);
              }}
            >
              <LetsIcon name="sign-out" size={18} strokeWidth={1.5} />
              <span>Выйти</span>
            </button>
          </div>
        )}

        <button
          type="button"
          className="sa-sidebar-profile-btn"
          onClick={() => setProfileOpen(!profileOpen)}
        >
          <div className="sa-sidebar-avatar" aria-hidden>
            <span className="sa-sidebar-avatar-initials">{profileInitials}</span>
          </div>
          <div className="sa-sidebar-profile-info">
            <div className="sa-sidebar-profile-name">{profileName}</div>
            <div className="sa-sidebar-profile-role">{ROLE_LABELS[role]}</div>
          </div>
          <span
            className="sa-sidebar-profile-chevron"
            style={{ display: 'inline-flex', transform: profileOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.16s ease' }}
          >
            <LetsIcon name="expand-down" size={14} strokeWidth={1.5} />
          </span>
        </button>
      </div>
    </aside>
  );
}

export { SIDEBAR_WIDTH, getDefaultTab };
