import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { lockBodyScroll, unlockBodyScroll } from '../../../shared/lib/body-scroll-lock';
import { useMobileAdminNav } from '../../../shared/lib/use-mobile-admin-nav';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import '../../../shared/ui/styles/admin-panel.css';
import '../../../shared/ui/styles/theme-brutal.css';
import '../../../shared/ui/styles/admin-responsive.css';
import { AdminSidebar } from '../../admin-sidebar/ui/AdminSidebar';
import type { AdminTab, AdminRole } from '../../admin-sidebar/ui/AdminSidebar';
import sidebarLogo from '../../../assets/logo.png';
import { Dashboard } from '../../../pages/dashboard/ui/DashboardPage';
import { HoldingsPage } from '../../../pages/holdings/ui/HoldingsPage';
import { Companies } from '../../../pages/companies/ui/CompaniesPage';
import { DealershipDirectionsPage } from '../../../pages/dealership-directions/ui/DealershipDirectionsPage';
import { ImportsPage } from '../../../pages/imports/ui/ImportsPage';
import { DealershipDetail } from '../../../pages/dealership-detail/ui/DealershipDetailPage';
import { UsersPage } from '../../../pages/users/ui/UsersPage';
import { TypesNumbersPage } from '../../../pages/types-numbers/ui/TypesNumbersPage';
import { Autodealers } from '../../../pages/autodealers/ui/AutodealersPage';
import { EmployeeDetail } from '../../../pages/employee-detail/ui/EmployeeDetailPage';
import { Audits } from '../../../pages/audits/ui/AuditsPage';
import { AuditDetail } from '../../../pages/audit-detail/ui/AuditDetailPage';
import { AuditBatchDetail } from '../../../pages/audit-batch-detail/ui/AuditBatchDetailPage';
import { Analytics } from '../../../pages/analytics/ui/AnalyticsPage';
import { CallSettingsPage } from '../../../pages/call-settings/ui/CallSettingsPage';
import { Settings } from '../../../pages/settings/ui/SettingsPage';
import { DealerContent } from '../../../pages/dealer/ui/DealerContent';
import type { DealerTab } from '../../../pages/dealer/ui/DealerContent';
import { TrainPage } from '../../../pages/train/ui/TrainPage';
import type { PlatformSummary, PlatformVoice } from '../../../shared/model/adminPanel';
import { CallBatchTray } from '../../call-batch-tray/ui/CallBatchTray';
import {
  buildAuditPath,
  buildBatchPath,
  buildDealershipPath,
  buildEmployeePath,
  buildHoldingPath,
  buildUserEmployeePath,
  getDefaultTab,
  normalizeTabForRole,
  parseAdminPath,
  isTabAllowedForRole,
  tabToPath,
} from '../../../shared/routing/adminRoutes';
import { StatusNotice } from '../../../shared/ui/StatusNotice';
import {
  fetchAudits,
  fetchCallBatches,
  fetchDealerships,
  fetchTimeSeries,
  fetchAdminPanelSettings,
  type AuditItem,
  type CallBatchListItem,
  type DealershipItem,
  type TimeSeriesPoint,
  type AdminPanelSettings,
} from '../../../shared/api/adminPanel';

export type SystemLayoutProps = {
  summary: PlatformSummary | null;
  voice: PlatformVoice | null;
  loadingSummary: boolean;
  role: AdminRole;
  dealerDealershipId?: string | null;
  accountId?: string | null;
  profileName: string;
  onRoleChange: (role: AdminRole) => void;
  onLogout: () => void;
  allowedRoles: AdminRole[];
};

export function SystemLayout({ summary, voice, loadingSummary, role, dealerDealershipId = null, accountId = null, profileName, onRoleChange, onLogout, allowedRoles }: SystemLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const route = parseAdminPath(location.pathname);
  const selectedHoldingId = route.holdingId || null;
  const selectedDealershipId = route.dealershipId || null;
  const activeTab = role === 'dealer' && route.tab === 'companies' && selectedDealershipId
    ? 'dealer-companies'
    : normalizeTabForRole(route.tab, role);
  const selectedEmployeeId = route.employeeId || null;
  const selectedAuditId = route.auditId || null;
  const selectedBatchDetailId = route.batchId || null;
  const trainerSessionActive = role === 'staff' && activeTab === 'staff-trainer' && Boolean(route.trainerSessionId);
  const employeeSourceDealership = searchParams.get('source_dealership')
    ? {
      id: searchParams.get('source_dealership') || '',
      name: searchParams.get('source_dealership_name') || searchParams.get('source_dealership') || '',
    }
    : null;

  const navigateToTab = (tab: AdminTab) => {
    if (role === 'staff' && tab === 'staff-profile' && accountId) {
      navigate(buildUserEmployeePath(accountId));
      return;
    }
    if (role === 'dealer' && tab === 'dealer-companies' && dealerDealershipId) {
      navigate(buildDealershipPath(dealerDealershipId));
      return;
    }
    navigate(tabToPath(tab));
  };

  const navigateToBatch = (batchId: string) => {
    navigate(buildBatchPath(batchId));
  };

  const navigateToEmployee = (
    employeeId: string,
    sourceDealership?: { id: string; name: string } | null,
    options?: { accountId?: string | null },
  ) => {
    const accountId = options?.accountId?.trim() || null;
    const params = new URLSearchParams();
    if (sourceDealership?.id) {
      params.set('source_dealership', sourceDealership.id);
      params.set('source_dealership_name', sourceDealership.name || sourceDealership.id);
    }
    const qs = params.toString();
    if (accountId) {
      navigate(`${buildUserEmployeePath(accountId)}${qs ? `?${qs}` : ''}`);
      return;
    }
    navigate(`${buildEmployeePath(employeeId)}${qs ? `?${qs}` : ''}`);
  };

  const handleTabChange = (tab: AdminTab) => {
    navigateToTab(tab);
  };

  const handleRoleChange = (newRole: AdminRole) => {
    onRoleChange(newRole);
    if (newRole === 'dealer' && dealerDealershipId) {
      navigate(buildDealershipPath(dealerDealershipId));
      return;
    }
    navigate(tabToPath(getDefaultTab(newRole)));
  };

  const [audits, setAudits] = useState<AuditItem[]>([]);
  const [auditsLoading, setAuditsLoading] = useState(true);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
  const [callBatches, setCallBatches] = useState<CallBatchListItem[]>([]);
  const [realDealerships, setRealDealerships] = useState<DealershipItem[]>([]);
  const [settings, setSettings] = useState<AdminPanelSettings | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [backendNotRunning, setBackendNotRunning] = useState(false);
  const [hasActiveBatch, setHasActiveBatch] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isMobileAdminNav = useMobileAdminNav();
  const isSuperOrCompany = role === 'super' || role === 'company';
  const isDealerAudits = role === 'dealer' && activeTab === 'audits';
  const shouldLoadAuditData = isSuperOrCompany || isDealerAudits;

  const handleDealershipSaved = (dealership: DealershipItem) => {
    setRealDealerships((current) => {
      const exists = current.some((item) => item.id === dealership.id);
      const next = exists
        ? current.map((item) => (item.id === dealership.id ? dealership : item))
        : [...current, dealership];
      return [...next].sort((a, b) => (a.city || '').localeCompare(b.city || '', 'ru') || a.name.localeCompare(b.name, 'ru'));
    });
  };

  const handleDealershipDeleted = (dealershipId: string) => {
    setRealDealerships((current) => current.filter((item) => item.id !== dealershipId));
    if (selectedDealershipId === dealershipId) {
      navigate('/companies');
    }
  };

  useEffect(() => {
    if (!shouldLoadAuditData) {
      setAudits([]);
      setTimeSeries([]);
      setCallBatches([]);
      setRealDealerships([]);
      setSettings(null);
      setAuditsLoading(false);
      setDataLoading(false);
      setBackendNotRunning(false);
      return;
    }

    let cancelled = false;
    setDataLoading(true);
    setBackendNotRunning(false);

    if (isDealerAudits) {
      fetchAudits(200)
        .then((a) => {
          if (cancelled) return;
          setAudits(a);
          setCallBatches([]);
          setTimeSeries([]);
          setRealDealerships([]);
          setSettings(null);
        })
        .catch(() => {
          if (!cancelled) {
            setAudits([]);
            setTimeSeries([]);
            setCallBatches([]);
            setRealDealerships([]);
            setSettings(null);
            setBackendNotRunning(true);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setAuditsLoading(false);
            setDataLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    Promise.all([
      fetchAudits(200),
      fetchCallBatches(80, 'all'),
      fetchTimeSeries(),
      fetchDealerships(),
      fetchAdminPanelSettings(),
    ])
      .then(([a, batches, ts, realD, st]) => {
        if (cancelled) return;
        setAudits(a);
        setCallBatches(batches);
        setTimeSeries(ts);
        setRealDealerships(realD);
        setSettings(st);
      })
      .catch(() => {
        if (!cancelled) {
          setAudits([]);
          setTimeSeries([]);
          setCallBatches([]);
          setRealDealerships([]);
          setSettings(null);
          setBackendNotRunning(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAuditsLoading(false);
          setDataLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [role, activeTab, shouldLoadAuditData, isDealerAudits]);

  useEffect(() => {
    if (!isSuperOrCompany) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const batches = await fetchCallBatches(80, 'all');
        if (!cancelled) setCallBatches(batches);
      } catch {
        if (!cancelled) setCallBatches([]);
      }
    };
    pull();
    const timer = window.setInterval(pull, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isSuperOrCompany]);

  useEffect(() => {
    if (isTabAllowedForRole(activeTab, role)) return;
    navigate(tabToPath(getDefaultTab(role)), { replace: true });
  }, [activeTab, navigate, role]);

  useEffect(() => {
    if (role === 'dealer' && selectedBatchDetailId) {
      navigate('/audits', { replace: true });
    }
  }, [navigate, role, selectedBatchDetailId]);

  useEffect(() => {
    if (role !== 'staff' || !accountId) return;
    if (activeTab === 'staff-profile' || (activeTab === 'users' && selectedEmployeeId !== accountId)) {
      navigate(buildUserEmployeePath(accountId), { replace: true });
    }
  }, [accountId, activeTab, navigate, role, selectedEmployeeId]);

  useEffect(() => {
    if (role === 'dealer' && activeTab === 'dealer-companies' && !selectedDealershipId && dealerDealershipId) {
      navigate(buildDealershipPath(dealerDealershipId), { replace: true });
    }
  }, [activeTab, dealerDealershipId, navigate, role, selectedDealershipId]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
    const main = document.querySelector('.super-admin-main');
    if (main && 'scrollTop' in main) {
      (main as HTMLElement).scrollTop = 0;
    }
  }, [activeTab, selectedDealershipId, selectedEmployeeId, selectedAuditId, selectedBatchDetailId]);

  // Подсветка пункта "Проверки" в сайдбаре, если есть активный ручной batch
  useEffect(() => {
    if (!isSuperOrCompany) {
      setHasActiveBatch(false);
      return;
    }
    const has = callBatches.some(
      (b) =>
        (b.mode === 'manual' || b.mode === 'single_dealership' || b.mode === 'all_dealerships') &&
        (b.status === 'running' || b.status === 'paused'),
    );
    setHasActiveBatch(has);
  }, [isSuperOrCompany, callBatches]);

  useEffect(() => {
    if (!isMobileAdminNav) setMobileNavOpen(false);
  }, [isMobileAdminNav]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavOpen || !isMobileAdminNav) return;
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, [mobileNavOpen, isMobileAdminNav]);

  const handleMobileTabChange = (tab: AdminTab) => {
    handleTabChange(tab);
    setMobileNavOpen(false);
  };

  const sidebarProps = {
    activeTab,
    role,
    profileName,
    onRoleChange: handleRoleChange,
    hasActiveBatch,
    onLogout,
    allowedRoles,
  };

  return (
    <div className={`super-admin-app theme-brutal${trainerSessionActive ? ' super-admin-app--trainer-focus' : ''}`}>
      {!trainerSessionActive && !isMobileAdminNav && (
        <AdminSidebar {...sidebarProps} onTab={handleTabChange} />
      )}
      {!trainerSessionActive && isMobileAdminNav && mobileNavOpen && createPortal(
        <div className="sa-admin-mobile-nav-portal theme-brutal">
          <div
            className="sa-admin-mobile-backdrop"
            role="presentation"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <AdminSidebar
            {...sidebarProps}
            onTab={handleMobileTabChange}
            className="super-admin-sidebar--drawer is-open"
            isDrawer
          />
        </div>,
        document.body,
      )}
      <main className={`super-admin-main${trainerSessionActive ? ' super-admin-main--trainer-focus' : ''}`}>
        {!trainerSessionActive && (
          <header className="sa-admin-mobile-topbar">
            <img src={sidebarLogo} alt="Red Button" className="sa-admin-mobile-topbar-logo" />
            <button
              type="button"
              className="sa-admin-mobile-menu-btn"
              aria-label="Открыть меню"
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M4 7h16" />
                <path d="M4 12h16" />
                <path d="M4 17h16" />
              </svg>
            </button>
          </header>
        )}
        <div className={`super-admin-content${trainerSessionActive ? ' super-admin-content--trainer-focus' : ''}`}>
          <div className="sa-page-enter">
          {backendNotRunning && shouldLoadAuditData && (
            <StatusNotice tone="warning">
              <strong>Нет данных: бэкенд не запущен.</strong>
              <br />
              В отдельном терминале выполните: <code>npm run dev</code>
              <br />
              (сервер будет на порту 3000, Vite проксирует сюда запросы /api). Затем обновите страницу.
            </StatusNotice>
          )}

          {/* ── Super / Company role content ── */}
          {isSuperOrCompany && (
            <>
              {activeTab === 'dashboard' && (
                <Dashboard
                  loading={loadingSummary}
                />
              )}
              {activeTab === 'holdings' && role === 'super' && (
                <HoldingsPage
                  holdingId={selectedHoldingId}
                  onOpenHolding={(id) => navigate(buildHoldingPath(id))}
                  onBack={() => navigate('/holdings')}
                  onOpenDealership={(id) => navigate(buildDealershipPath(id))}
                />
              )}
              {activeTab === 'companies' && !selectedDealershipId && (
                <Companies
                  dealerships={realDealerships}
                  loading={dataLoading}
                  onSelectDealership={(id) => navigate(buildDealershipPath(id))}
                  onOpenBatchInAudits={navigateToBatch}
                  onDealershipSaved={handleDealershipSaved}
                  onDealershipDeleted={handleDealershipDeleted}
                />
              )}
              {activeTab === 'companies' && selectedDealershipId && (
                <DealershipDetail
                  dealershipId={selectedDealershipId}
                  dealership={realDealerships.find((item) => item.id === selectedDealershipId) ?? null}
                  onBack={() => navigate('/companies')}
                  onDealershipSaved={handleDealershipSaved}
                  onDealershipDeleted={handleDealershipDeleted}
                  onOpenEmployee={(empId, options) => {
                    const sourceId = selectedDealershipId;
                    const sourceName = sourceId
                      ? (realDealerships.find((item) => item.id === sourceId)?.name ?? sourceId)
                      : 'Точка';
                    navigateToEmployee(empId, sourceId ? { id: sourceId, name: sourceName } : null, options);
                  }}
                  onOpenBatchDetail={navigateToBatch}
                />
              )}
              {activeTab === 'dealershipDirections' && (
                <DealershipDirectionsPage />
              )}
              {activeTab === 'imports' && (
                <ImportsPage />
              )}
              {activeTab === 'users' && (
                <UsersPage
                  role={role}
                  employeeId={selectedEmployeeId}
                  onSelectEmployee={(id) => navigate(buildUserEmployeePath(id))}
                  onBackToUsers={() => {
                    if (employeeSourceDealership) {
                      navigate(buildDealershipPath(employeeSourceDealership.id));
                      return;
                    }
                    navigate('/users');
                  }}
                  onOpenDealership={(dealershipId) => navigate(buildDealershipPath(dealershipId))}
                  onOpenCompanies={() => navigate('/companies')}
                  sourceDealership={employeeSourceDealership}
                />
              )}
              {activeTab === 'typesNumbers' && role === 'super' && (
                <TypesNumbersPage />
              )}
              {activeTab === 'autodealers' && !selectedEmployeeId && (
                <Autodealers
                  loading={dataLoading}
                  onSelectEmployee={(id, options) => navigateToEmployee(id, null, options)}
                />
              )}
              {activeTab === 'autodealers' && selectedEmployeeId && (
                <EmployeeDetail
                  employeeId={selectedEmployeeId}
                  onBack={() => {
                    if (employeeSourceDealership) {
                      navigate(buildDealershipPath(employeeSourceDealership.id));
                      return;
                    }
                    navigate('/autodealers');
                  }}
                  onOpenDealership={(dealershipId) => navigate(buildDealershipPath(dealershipId))}
                  onOpenCompanies={() => navigate('/companies')}
                  sourceDealership={employeeSourceDealership}
                />
              )}
              {activeTab === 'audits' && !selectedAuditId && !selectedBatchDetailId && (
                <Audits
                  audits={audits}
                  loading={auditsLoading}
                />
              )}
              {activeTab === 'audits' && !selectedAuditId && selectedBatchDetailId && (
                <AuditBatchDetail
                  batchId={selectedBatchDetailId}
                  initialBatch={callBatches.find((b) => b.id === selectedBatchDetailId) ?? null}
                  onBack={() => navigate('/audits')}
                  onOpenAudit={(auditId) => navigate(buildAuditPath(auditId))}
                  onOpenDealership={(dealershipId) => navigate(buildDealershipPath(dealershipId))}
                />
              )}
              {activeTab === 'audits' && selectedAuditId && (
                <AuditDetail
                  auditId={selectedAuditId}
                  onBack={() => navigate('/audits')}
                  onNavigate={(auditId) => navigate(buildAuditPath(auditId))}
                  onOpenEmployee={(empId) => navigate(buildEmployeePath(empId))}
                />
              )}
              {activeTab === 'analytics' && (
                <Analytics
                  summary={summary}
                  timeSeries={timeSeries}
                  loading={loadingSummary}
                  onDrill={(type, filter) => {
                    if (type === 'employees') {
                      navigate('/autodealers');
                    } else if (type === 'dealership' && filter) {
                      navigate(buildDealershipPath(filter));
                    } else if (type === 'holding' && filter) {
                      navigate(buildHoldingPath(filter));
                    } else if (type === 'audits') {
                      navigate('/audits');
                    }
                  }}
                />
              )}
              {activeTab === 'callSettings' && (
                <CallSettingsPage />
              )}
            </>
          )}

          {/* ── Dealer role content ── */}
          {role === 'dealer' && activeTab.startsWith('dealer-') && activeTab !== 'dealer-companies' && (
            <DealerContent summary={summary} voice={voice} loadingSummary={loadingSummary} activeTab={activeTab as DealerTab} />
          )}
          {role === 'dealer' && activeTab === 'dealer-companies' && selectedDealershipId && (
            <DealershipDetail
              dealershipId={selectedDealershipId}
              dealership={null}
              mode="dealerDashboard"
              onBack={() => navigate(buildDealershipPath(selectedDealershipId))}
              onOpenEmployee={(empId, options) => navigateToEmployee(
                empId,
                { id: selectedDealershipId, name: 'Точка' },
                options,
              )}
            />
          )}
          {role === 'dealer' && activeTab === 'users' && (
            <UsersPage
              role={role}
              employeeId={selectedEmployeeId}
              onSelectEmployee={(id) => navigate(buildUserEmployeePath(id))}
              onBackToUsers={() => navigate('/users')}
              onOpenDealership={() => navigate('/dealer/companies')}
              onOpenCompanies={() => navigate('/dealer/companies')}
            />
          )}
          {role === 'dealer' && activeTab === 'audits' && !selectedAuditId && !selectedBatchDetailId && (
            <Audits
              audits={audits}
              loading={auditsLoading}
            />
          )}
          {role === 'dealer' && activeTab === 'audits' && selectedAuditId && (
            <AuditDetail
              auditId={selectedAuditId}
              onBack={() => navigate('/audits')}
              onNavigate={(auditId) => navigate(buildAuditPath(auditId))}
              onOpenEmployee={(empId) => navigate(buildUserEmployeePath(empId))}
            />
          )}

          {/* ── Staff role content ── */}
          {role === 'staff' && activeTab === 'users' && accountId && selectedEmployeeId === accountId && (
            <EmployeeDetail
              employeeId={accountId}
              onBack={() => navigate(buildUserEmployeePath(accountId))}
              readOnly
              selfView
            />
          )}
          {role === 'staff' && activeTab === 'staff-trainer' && (
            <TrainPage embedded />
          )}

          {/* ── Settings (available for all roles) ── */}
          {activeTab === 'settings' && (
            <Settings settings={settings} loading={dataLoading} />
          )}
          </div>
        </div>

        {/* Глобальный трей проверок в правом нижнем углу */}
        {isSuperOrCompany && (
          <CallBatchTray
            items={callBatches}
            onOpenBatchDetail={navigateToBatch}
          />
        )}
      </main>
    </div>
  );
}
