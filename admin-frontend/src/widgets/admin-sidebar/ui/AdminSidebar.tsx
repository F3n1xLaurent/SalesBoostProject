import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { AdminRole, AdminTab } from '../../../entities/session/model/types';
import { getDefaultTab } from '../../../shared/routing/adminRoutes';

export type { AdminRole };

const SIDEBAR_WIDTH = 260;

const ROLE_LABELS: Record<AdminRole, string> = {
  super: 'Суперадмин',
  company: 'Руководитель компании',
  dealer: 'Руководитель точки',
  staff: 'Менеджер',
};

type NavItem = { id: AdminTab; label: string; icon: React.ReactNode };

const SUPER_NAV: NavItem[] = [
  { id: 'dashboard', label: 'Дашборд', icon: <DashboardIcon /> },
  { id: 'holdings', label: 'Компании', icon: <CompaniesIcon /> },
  { id: 'companies', label: 'Точки', icon: <CompaniesIcon /> },
  { id: 'dealershipDirections', label: 'Направления точек', icon: <CompaniesIcon /> },
  { id: 'imports', label: 'Данные', icon: <AuditsIcon /> },
  { id: 'typesNumbers', label: 'Типы номеров', icon: <PhoneIcon /> },
  { id: 'users', label: 'Пользователи', icon: <DealersIcon /> },
  { id: 'audits', label: 'Проверки', icon: <AuditsIcon /> },
  { id: 'analytics', label: 'Аналитика', icon: <AnalyticsIcon /> },
  { id: 'callSettings', label: 'Настройки обзвона', icon: <PhoneIcon /> },
];

const COMPANY_NAV: NavItem[] = SUPER_NAV.filter((item) => item.id !== 'holdings' && item.id !== 'typesNumbers');

const DEALER_NAV: NavItem[] = [
  { id: 'dealer-companies', label: 'Дашборд', icon: <DashboardIcon /> },
  { id: 'audits', label: 'Проверки', icon: <AuditsIcon /> },
  { id: 'users', label: 'Сотрудники', icon: <DealersIcon /> },
  // { id: 'dealer-team', label: 'Команда', icon: <AnalyticsIcon /> },
];

function TrainerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2a3 3 0 00-3 3v6a3 3 0 106 0V5a3 3 0 00-3-3z" />
      <path d="M19 10a1 1 0 10-2 0 5 5 0 01-10 0 1 1 0 10-2 0 7 7 0 005 6.71V20H8a1 1 0 100 2h8a1 1 0 100-2h-3v-3.29A7 7 0 0019 10z" />
    </svg>
  );
}

const STAFF_NAV: NavItem[] = [
  { id: 'staff-profile', label: 'Профиль', icon: <ProfileIcon /> },
  { id: 'staff-trainer', label: 'Тренажёр', icon: <TrainerIcon /> },
];

function DashboardIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}
function CompaniesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z" />
      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </svg>
  );
}
function DealersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}
function AuditsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}
function AnalyticsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 20V10M12 20V4M6 20v-6" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}
function ProfileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

type Props = {
  activeTab: AdminTab;
  onTab: (tab: AdminTab) => void;
  role: AdminRole;
  profileName: string;
  onRoleChange: (role: AdminRole) => void;
  hasActiveBatch?: boolean;
  onLogout: () => void;
  allowedRoles: AdminRole[];
};

export function AdminSidebar({ activeTab, onTab, role, profileName, onRoleChange, hasActiveBatch = false, onLogout, allowedRoles }: Props) {
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

  return (
    <aside
      className="super-admin-sidebar"
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        bottom: 0,
        zIndex: 40,
        overflowY: 'auto',
        padding: '24px 16px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600, color: 'var(--sa-text)' }}>
          Sales Boost
        </h2>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--sa-text-secondary)' }}>
          {ROLE_LABELS[role]}
        </p>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
            onClick={() => onTab(item.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: '100%',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ flexShrink: 0, opacity: activeTab === item.id ? 1 : 0.7 }}>
              {item.icon}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {item.label}
              {item.id === 'audits' && hasActiveBatch && <span className="sa-batch-tray-dot" />}
            </span>
          </button>
        ))}
      </nav>

      <div className="sa-sidebar-profile" ref={profileRef} style={{ position: 'relative' }}>
        {profileOpen && (
          <div className="sa-sidebar-profile-menu">
            <button
              type="button"
              className={`sa-sidebar-profile-menu-item ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => { onTab('settings'); setProfileOpen(false); }}
            >
              <SettingsIcon />
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
              <span>⇠</span>
              <span>Выйти</span>
            </button>
          </div>
        )}

        <button
          type="button"
          className="sa-sidebar-profile-btn"
          onClick={() => setProfileOpen(!profileOpen)}
        >
          <div className="sa-sidebar-avatar">
            <ProfileIcon />
          </div>
          <div className="sa-sidebar-profile-info">
            <div className="sa-sidebar-profile-name">{profileName}</div>
            <div className="sa-sidebar-profile-role">{ROLE_LABELS[role]}</div>
          </div>
          <span className="sa-sidebar-profile-chevron">{profileOpen ? '▲' : '▼'}</span>
        </button>
      </div>
    </aside>
  );
}

export { SIDEBAR_WIDTH, getDefaultTab };
