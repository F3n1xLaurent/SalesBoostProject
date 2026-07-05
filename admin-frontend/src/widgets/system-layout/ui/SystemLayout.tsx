import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import '../../../shared/ui/styles/admin-panel.css';
import '../../../shared/ui/styles/theme-brutal.css';
import { AdminSidebar, SIDEBAR_WIDTH } from '../../admin-sidebar/ui/AdminSidebar';
import type { AdminTab, AdminRole } from '../../admin-sidebar/ui/AdminSidebar';
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
import { StaffProfileContent } from '../../../pages/staff/ui/StaffContent';
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
  profileName: string;
  onRoleChange: (role: AdminRole) => void;
  onLogout: () => void;
  allowedRoles: AdminRole[];
};

export function SystemLayout({ summary, voice, loadingSummary, role, dealerDealershipId = null, profileName, onRoleChange, onLogout, allowedRoles }: SystemLayoutProps) {
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
  const employeeSourceDealership = searchParams.get('source_dealership')
    ? {
      id: searchParams.get('source_dealership') || '',
      name: searchParams.get('source_dealership_name') || searchParams.get('source_dealership') || '',
    }
    : null;

  const navigateToTab = (tab: AdminTab) => {
    if (role === 'dealer' && tab === 'dealer-companies' && dealerDealershipId) {
      navigate(buildDealershipPath(dealerDealershipId));
      return;
    }
    navigate(tabToPath(tab));
  };

  const navigateToBatch = (batchId: string) => {
    navigate(buildBatchPath(batchId));
  };

  const navigateToEmployee = (employeeId: string, sourceDealership?: { id: string; name: string } | null) => {
    if (!sourceDealership?.id) {
      navigate(buildEmployeePath(employeeId));
      return;
    }
    const params = new URLSearchParams({
      source_dealership: sourceDealership.id,
      source_dealership_name: sourceDealership.name || sourceDealership.id,
    });
    navigate(`${buildEmployeePath(employeeId)}?${params.toString()}`);
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

  return (
    <div className="super-admin-app theme-brutal">
      <AdminSidebar
        activeTab={activeTab}
        onTab={handleTabChange}
        role={role}
        profileName={profileName}
        onRoleChange={handleRoleChange}
        hasActiveBatch={hasActiveBatch}
        onLogout={onLogout}
        allowedRoles={allowedRoles}
      />
      <main
        className="super-admin-main"
        style={{
          marginLeft: SIDEBAR_WIDTH,
          minHeight: '100vh',
          paddingTop: 32,
          paddingBottom: 48,
        }}
      >
        <div className="super-admin-content">
          <div key={location.pathname} className="sa-page-enter">
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
                />
              )}
              {activeTab === 'companies' && selectedDealershipId && (
                <DealershipDetail
                  dealershipId={selectedDealershipId}
                  dealership={realDealerships.find((item) => item.id === selectedDealershipId) ?? null}
                  onBack={() => navigate('/companies')}
                  onDealershipSaved={handleDealershipSaved}
                  onOpenEmployee={(empId) => {
                    const sourceId = selectedDealershipId;
                    const sourceName = sourceId
                      ? (
                        realDealerships.find((item) => item.id === sourceId)?.name
                        ?? companies.find((c) => c.id === sourceId)?.name
                        ?? sourceId
                      )
                      : 'Точка';
                    navigateToEmployee(empId, sourceId ? { id: sourceId, name: sourceName } : null);
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
                  onBackToUsers={() => navigate('/users')}
                  onOpenDealership={(dealershipId) => navigate(buildDealershipPath(dealershipId))}
                  onOpenCompanies={() => navigate('/companies')}
                />
              )}
              {activeTab === 'typesNumbers' && role === 'super' && (
                <TypesNumbersPage />
              )}
              {activeTab === 'autodealers' && !selectedEmployeeId && (
                <Autodealers
                  loading={dataLoading}
                  onSelectEmployee={(id) => navigate(buildEmployeePath(id))}
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
                  onOpenDetail={(auditId) => navigate(buildAuditPath(auditId))}
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
              onOpenEmployee={(empId) => navigate(buildUserEmployeePath(empId))}
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
              onOpenDetail={(auditId) => navigate(buildAuditPath(auditId))}
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
          {role === 'staff' && activeTab === 'staff-profile' && (
            <StaffProfileContent />
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
