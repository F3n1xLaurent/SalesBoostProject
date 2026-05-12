import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import '../../../shared/ui/styles/admin-panel.css';
import { AdminSidebar, SIDEBAR_WIDTH } from '../../admin-sidebar/ui/AdminSidebar';
import type { AdminTab, AdminRole } from '../../admin-sidebar/ui/AdminSidebar';
import { Dashboard } from '../../../pages/dashboard/ui/DashboardPage';
import { HoldingsPage } from '../../../pages/holdings/ui/HoldingsPage';
import { Companies } from '../../../pages/companies/ui/CompaniesPage';
import { DealershipDetail } from '../../../pages/dealership-detail/ui/DealershipDetailPage';
import { UsersPage } from '../../../pages/users/ui/UsersPage';
import { Autodealers } from '../../../pages/autodealers/ui/AutodealersPage';
import { EmployeeDetail } from '../../../pages/employee-detail/ui/EmployeeDetailPage';
import { Audits } from '../../../pages/audits/ui/AuditsPage';
import { AuditDetail } from '../../../pages/audit-detail/ui/AuditDetailPage';
import { AuditBatchDetail } from '../../../pages/audit-batch-detail/ui/AuditBatchDetailPage';
import { Analytics } from '../../../pages/analytics/ui/AnalyticsPage';
import { Settings } from '../../../pages/settings/ui/SettingsPage';
import { DealerContent } from '../../../pages/dealer/ui/DealerContent';
import type { DealerTab } from '../../../pages/dealer/ui/DealerContent';
import { StaffProfileContent, StaffTrainerContent } from '../../../pages/staff/ui/StaffContent';
import type { PlatformSummary, PlatformVoice } from '../../../shared/model/adminPanel';
import { CallBatchTray } from '../../call-batch-tray/ui/CallBatchTray';
import {
  buildAuditPath,
  buildBatchPath,
  buildDealershipPath,
  buildEmployeePath,
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
  fetchMockEntities,
  fetchAdminPanelSettings,
  type AuditItem,
  type CallBatchListItem,
  type DealershipItem,
  type TimeSeriesPoint,
  type MockCompany,
  type MockDealer,
  type AdminPanelSettings,
} from '../../../shared/api/adminPanel';

export type SystemLayoutProps = {
  summary: PlatformSummary | null;
  voice: PlatformVoice | null;
  loadingSummary: boolean;
  role: AdminRole;
  profileName: string;
  onRoleChange: (role: AdminRole) => void;
  onLogout: () => void;
  allowedRoles: AdminRole[];
};

export function SystemLayout({ summary, voice, loadingSummary, role, profileName, onRoleChange, onLogout, allowedRoles }: SystemLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const route = parseAdminPath(location.pathname);
  const activeTab = normalizeTabForRole(route.tab, role);
  const selectedDealershipId = route.dealershipId || null;
  const selectedEmployeeId = route.employeeId || null;
  const selectedAuditId = route.auditId || null;
  const selectedBatchDetailId = route.batchId || null;
  const auditsInitialScope = searchParams.get('scope') === 'dealerships' ? 'dealerships' : 'employees';
  const focusedBatchId = searchParams.get('batch_focus') || selectedBatchDetailId;
  const employeeSourceDealership = searchParams.get('source_dealership')
    ? {
      id: searchParams.get('source_dealership') || '',
      name: searchParams.get('source_dealership_name') || searchParams.get('source_dealership') || '',
    }
    : null;

  const navigateToTab = (tab: AdminTab) => {
    navigate(tabToPath(tab));
  };

  const navigateToBatch = (batchId: string) => {
    const params = new URLSearchParams({ scope: 'dealerships', batch_focus: batchId });
    navigate(`${buildBatchPath(batchId)}?${params.toString()}`);
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

  const setAuditsScope = (scope: 'employees' | 'dealerships') => {
    const next = new URLSearchParams(searchParams);
    if (scope === 'dealerships') next.set('scope', scope);
    else next.delete('scope');
    navigate({ pathname: location.pathname, search: next.toString() ? `?${next.toString()}` : '' }, { replace: true });
  };

  const handleTabChange = (tab: AdminTab) => {
    navigateToTab(tab);
  };

  const handleRoleChange = (newRole: AdminRole) => {
    onRoleChange(newRole);
    navigate(tabToPath(getDefaultTab(newRole)));
  };

  const [audits, setAudits] = useState<AuditItem[]>([]);
  const [auditsLoading, setAuditsLoading] = useState(true);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
  const [callBatches, setCallBatches] = useState<CallBatchListItem[]>([]);
  const [companies, setCompanies] = useState<MockCompany[]>([]);
  const [dealers, setDealers] = useState<MockDealer[]>([]);
  const [realDealerships, setRealDealerships] = useState<DealershipItem[]>([]);
  const [settings, setSettings] = useState<AdminPanelSettings | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [backendNotRunning, setBackendNotRunning] = useState(false);
  const [hasActiveBatch, setHasActiveBatch] = useState(false);

  useEffect(() => {
    if (role !== 'super' && role !== 'company') {
      setAudits([]);
      setTimeSeries([]);
      setCallBatches([]);
      setCompanies([]);
      setDealers([]);
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
    Promise.all([
      fetchAudits(200),
      fetchCallBatches(80, 'all'),
      fetchTimeSeries(),
      fetchMockEntities(),
      fetchDealerships(),
      fetchAdminPanelSettings(),
    ])
      .then(([a, batches, ts, mock, realD, st]) => {
        if (cancelled) return;
        setAudits(a);
        setCallBatches(batches);
        setTimeSeries(ts);
        setCompanies(mock.companies);
        setDealers(mock.dealers);
        setRealDealerships(realD);
        setSettings(st);
      })
      .catch(() => {
        if (!cancelled) {
          setAudits([]);
          setTimeSeries([]);
          setCallBatches([]);
          setCompanies([]);
          setDealers([]);
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
  }, [role]);

  useEffect(() => {
    if (role !== 'super' && role !== 'company') return;
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
  }, [role]);

  const isSuperOrCompany = role === 'super' || role === 'company';

  useEffect(() => {
    if (isTabAllowedForRole(activeTab, role)) return;
    navigate(tabToPath(getDefaultTab(role)), { replace: true });
  }, [activeTab, navigate, role]);

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
    <div className="super-admin-app">
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
          {backendNotRunning && isSuperOrCompany && (
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
                  summary={summary}
                  voice={voice}
                  loading={loadingSummary}
                  timeSeries={timeSeries}
                  companies={companies}
                  totalAudits={audits.length}
                  audits={audits}
                />
              )}
              {activeTab === 'holdings' && role === 'super' && (
                <HoldingsPage />
              )}
              {activeTab === 'companies' && !selectedDealershipId && (
                <Companies
                  dealerships={realDealerships}
                  loading={dataLoading}
                  onSelectDealership={(id) => navigate(buildDealershipPath(id))}
                  onOpenBatchInAudits={navigateToBatch}
                />
              )}
              {activeTab === 'companies' && selectedDealershipId && (
                <DealershipDetail
                  dealershipId={selectedDealershipId}
                  dealership={realDealerships.find((item) => item.id === selectedDealershipId) ?? null}
                  onBack={() => navigate('/companies')}
                  onOpenEmployee={(empId) => {
                    const sourceId = selectedDealershipId;
                    const sourceName = sourceId
                      ? (
                        realDealerships.find((item) => item.id === sourceId)?.name
                        ?? companies.find((c) => c.id === sourceId)?.name
                        ?? sourceId
                      )
                      : 'Автосалон';
                    navigateToEmployee(empId, sourceId ? { id: sourceId, name: sourceName } : null);
                  }}
                  onOpenBatchDetail={navigateToBatch}
                />
              )}
              {activeTab === 'users' && (
                <UsersPage role={role} />
              )}
              {activeTab === 'autodealers' && !selectedEmployeeId && (
                <Autodealers
                  dealers={dealers}
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
                  callBatches={callBatches}
                  callBatchesLoading={dataLoading}
                  onScopeChange={setAuditsScope}
                  loading={auditsLoading}
                  initialScope={auditsInitialScope}
                  focusedBatchId={focusedBatchId}
                  onOpenDetail={(auditId) => navigate(buildAuditPath(auditId))}
                  onOpenBatchDetail={navigateToBatch}
                />
              )}
              {activeTab === 'audits' && !selectedAuditId && selectedBatchDetailId && (
                <AuditBatchDetail
                  batchId={selectedBatchDetailId}
                  initialBatch={callBatches.find((b) => b.id === selectedBatchDetailId) ?? null}
                  onBack={() => navigate('/audits?scope=dealerships')}
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
            </>
          )}

          {/* ── Dealer role content ── */}
          {role === 'dealer' && activeTab.startsWith('dealer-') && (
            <DealerContent summary={summary} voice={voice} loadingSummary={loadingSummary} activeTab={activeTab as DealerTab} />
          )}

          {/* ── Staff role content ── */}
          {role === 'staff' && activeTab === 'staff-profile' && (
            <StaffProfileContent />
          )}
          {role === 'staff' && activeTab === 'staff-trainer' && (
            <StaffTrainerContent />
          )}

          {/* ── Settings (available for all roles) ── */}
          {activeTab === 'settings' && (
            <Settings settings={settings} loading={dataLoading} />
          )}
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
