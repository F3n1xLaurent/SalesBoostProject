import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import {
  STATUS_LABELS,
  type DealershipDetail as Detail,
} from '../../../shared/lib/admin-panel/mockData';
import {
  excludeDealershipFromAnalyticsPlan,
  fetchAuditDetail,
  fetchAnalyticsDealershipDetail,
  fetchAnalyticsDealershipPlans,
  type AnalyticsAISummary,
  type AnalyticsPlanParticipation,
  type AuditDetailItem,
  type DealershipItem,
  type DealershipType,
} from '../../../shared/api/adminPanel';
import { DealershipModal, formatWorkingHours } from '../../../shared/ui/dealership-modal/DealershipModal';
import { DealershipPhoneNumbersModal } from '../../../shared/ui/dealership-phone-numbers/DealershipPhoneNumbersModal';
import { EditIcon, PhoneIcon } from '../../../shared/ui/icons/ActionIcons';
import { ratingClass, answerRateClass, answerTimeClass, statusBadgeClass, scoreBarColor } from '../../../shared/lib/admin-panel/utils';
import {
  ACTIVE_BATCH_STORAGE_KEY,
  fetchBatchWithSummary,
  type CallBatchSnapshot,
  type DealershipBatchSummary,
} from '../../../shared/lib/admin-panel/batchUtils';
import { EfficiencyActivityChart, type EfficiencyActivitySeries } from '../../../shared/ui/efficiency-activity-chart/EfficiencyActivityChart';
import { BrutalCard } from '../../../shared/ui/brutal-card';
import { AnsweredMissedDonut } from '../../../shared/ui/answered-missed-donut';
import { AnswerRateByHour } from '../../../shared/ui/answer-rate-by-hour';
import { PlanParticipationTable } from '../../../shared/ui/plan-participation-table';
import { SlideOver } from '../../../shared/ui/slide-over';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import { CallOutcomeBreakdown } from '../../../shared/ui/call-outcome-breakdown';
import { AuditHistoryBlock } from '../../../shared/ui/audit-history-block';

/* ────────────────────── Props ────────────────────── */

type OpenEmployeeHandler = (id: string, options?: { accountId?: string | null }) => void;

type Props = {
  dealershipId: string;
  dealership?: DealershipItem | null;
  onBack: () => void;
  onOpenEmployee?: OpenEmployeeHandler;
  onOpenBatchDetail?: (batchId: string) => void;
  onDealershipSaved?: (dealership: DealershipItem) => void;
  onDealershipDeleted?: (dealershipId: string) => void;
  mode?: 'default' | 'dealerDashboard';
};

type DealershipOutcomeBreakdown = {
  completed: number;
  no_answer: number;
  busy: number;
  failed: number;
  disconnected: number;
};

type DealershipAnalyticsDetail = Detail & {
  aiSummary?: AnalyticsAISummary;
  noAnswers?: number;
  activitySeries?: EfficiencyActivitySeries;
  outcomeBreakdown?: DealershipOutcomeBreakdown;
  communicationBreakdown?: { label: string; percent: number; color: string }[];
  scriptCompliance?: { block: string; rate: number; hint?: string }[];
};

/* ────────────────────── KPI Card ────────────────────── */

function DealershipMetricCard({
  label,
  value,
  description,
  valueClass,
  valueSuffix,
}: {
  label: string;
  value: React.ReactNode;
  description?: React.ReactNode;
  valueClass?: string;
  valueSuffix?: string;
}) {
  return (
    <div className="sa-card sa-kpi-card sa-kpi-card-air sa-brutal-card">
      <div className="sa-kpi-card-top">
        <div className="sa-kpi-card-heading">{label}</div>
      </div>
      <div className="sa-kpi-card-spacer" aria-hidden />
      <div className="sa-kpi-card-bottom">
        {valueSuffix ? (
          <div className="sa-kpi-value-row">
            <span className={`sa-kpi-value sa-kpi-value-large ${valueClass ?? ''}`}>{value}</span>
            <span className="sa-kpi-value-suffix">{valueSuffix}</span>
          </div>
        ) : (
          <div className={`sa-kpi-value sa-kpi-value-large ${valueClass ?? ''}`}>{value}</div>
        )}
        {description && <div className="sa-kpi-desc">{description}</div>}
      </div>
    </div>
  );
}

function dealershipTypeLabel(type?: DealershipType | null): string {
  return type === 'franchised' ? 'Франчайзинговый' : 'Собственный';
}

function buildFallbackDetail(dealership: DealershipItem): DealershipAnalyticsDetail {
  return {
    id: dealership.id,
    name: dealership.name,
    city: dealership.city || '—',
    aiRating: 0,
    answerRate: null,
    avgAnswerTimeSec: null,
    avgCallDurationSec: null,
    auditsCount: 0,
    employeesCount: dealership.managersCount,
    deltaRating: null,
    status: 'no-data',
    employees: [],
    audits: [],
    timeSeries: [],
    hourlyAnswerRate: Array.from({ length: 24 }, () => 0),
    topIssues: [],
    topQuestions: [],
    recommendedTrainings: [],
    noAnswers: 0,
    outcomeBreakdown: { completed: 0, no_answer: 0, busy: 0, failed: 0, disconnected: 0 },
    communicationBreakdown: [],
    scriptCompliance: [],
  };
}

function CommunicationBreakdown({ data }: { data?: { label: string; percent: number; color: string }[] }) {
  const visible = (data ?? []).filter((item) => item.percent > 0);
  if (visible.length === 0) return <div className="sa-chart-empty">Нет оценки коммуникации</div>;
  return (
    <div className="sa-comm-grid">
      {visible.map((item) => (
        <div key={item.label} className="sa-comm-stat">
          <div className="sa-comm-stat-bar" style={{ background: item.color, width: `${Math.max(item.percent, 4)}%` }} />
          <div className="sa-comm-stat-info">
            <span className="sa-comm-stat-label">{item.label}</span>
            <span className="sa-comm-stat-pct" style={{ color: item.color }}>{item.percent}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ScriptCompliance({ data }: { data?: { block: string; rate: number; hint?: string }[] }) {
  if (!data || data.length === 0) return <div className="sa-chart-empty">Нет рассчитанных категорий</div>;
  return (
    <div className="sa-hbar-list sa-hbar-list-thin">
      {[...data].sort((a, b) => a.rate - b.rate).map((item) => (
        <div key={item.block} className="sa-hbar-row" title={item.hint}>
          <span className="sa-hbar-label">{item.block}</span>
          <div className="sa-hbar-track">
            <div
              className="sa-hbar-fill"
              style={{ width: `${item.rate}%`, background: scoreBarColor(item.rate) }}
            />
          </div>
          <span className={`sa-hbar-score ${ratingClass(item.rate)}`}>{item.rate}%</span>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────── Employees table ────────────────────── */

function EmployeeComparisonModal({
  rows,
  onClose,
  onOpenEmployee,
}: {
  rows: Detail['employees'];
  onClose: () => void;
  onOpenEmployee?: OpenEmployeeHandler;
}) {
  return (
    <MetricComparisonModal
      open={rows.length >= 2}
      onClose={onClose}
      title="Сравнение менеджеров салона"
      columns={rows.map((row) => ({
        id: row.id,
        label: row.name,
        onOpen: onOpenEmployee
          ? () => onOpenEmployee(row.id, { accountId: row.accountId })
          : undefined,
      }))}
      metrics={[
        {
          key: 'aiRating',
          label: 'AI-рейтинг',
          higherBetter: true,
          values: rows.map((row) => row.aiRating),
        },
        {
          key: 'auditsCount',
          label: 'Проверки',
          higherBetter: true,
          values: rows.map((row) => row.auditsCount),
        },
      ]}
      extraRows={[
        {
          key: 'status',
          label: 'Статус',
          cells: rows.map((row) => row.status),
        },
      ]}
      aiLevel="dealership-managers"
      aiItems={rows.map((row) => ({ ...row, fullName: row.name }))}
    />
  );
}

function EmployeesTable({ employees, onOpenEmployee }: { employees: Detail['employees']; onOpenEmployee?: OpenEmployeeHandler }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const selectedRows = employees.filter((employee) => selectedIds.includes(employee.id));

  function toggleEmployee(id: string) {
    const employee = employees.find((item) => item.id === id);
    if (employee && employee.auditsCount === 0) return;
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
  }

  function openEmployee(employee: Detail['employees'][number]) {
    onOpenEmployee?.(employee.id, { accountId: employee.accountId });
  }

  if (employees.length === 0) return <div className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Нет данных о сотрудниках</div>;
  return (
    <>
      <div className="sa-table-wrap">
        <table className="sa-table sa-table-sortable">
          <thead>
            <tr>
              <th style={{ width: 44 }} />
              <th>Сотрудник</th>
              <th className="sa-text-right">AI-рейтинг</th>
              <th className="sa-text-right">Проверки</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr
                key={e.id}
                className="sa-row-clickable"
                onClick={() => openEmployee(e)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => ev.key === 'Enter' && openEmployee(e)}
              >
                <td onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(e.id)}
                    disabled={e.auditsCount === 0 || (!selectedIds.includes(e.id) && selectedIds.length >= 6)}
                    onChange={() => toggleEmployee(e.id)}
                    aria-label={`Выбрать ${e.name}`}
                  />
                </td>
                <td style={{ fontWeight: 600 }}>{e.name}</td>
                <td className="sa-text-right"><span className={ratingClass(e.aiRating)}>{e.aiRating}</span></td>
                <td className="sa-text-right">{e.auditsCount}</td>
                <td>
                  <span className={statusBadgeClass(e.status)}>
                    {STATUS_LABELS[e.status as keyof typeof STATUS_LABELS] ?? e.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedRows.length > 0 && createPortal(
        <div className="theme-brutal" style={{ position: 'fixed', left: 24, right: 24, bottom: 24, zIndex: 60, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="sa-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', pointerEvents: 'auto', boxShadow: '0 16px 40px rgba(15,23,42,.18)' }}>
            <strong>Выбрано: {selectedRows.length}</strong>
            <button type="button" className="sa-btn-outline" disabled={selectedRows.length < 2} onClick={() => setComparisonOpen(true)}>Сравнить</button>
            <button type="button" className="sa-btn-text" onClick={() => setSelectedIds([])}>Сбросить</button>
          </div>
        </div>,
        document.body,
      )}
      {comparisonOpen && (
        <EmployeeComparisonModal rows={selectedRows} onClose={() => setComparisonOpen(false)} onOpenEmployee={onOpenEmployee} />
      )}
    </>
  );
}

/* ────────────────────── Top Issues ────────────────────── */

function TopIssues({ detail }: { detail: DealershipAnalyticsDetail }) {
  return (
    <div className="sa-detail-insights">
      <div className="sa-card">
        <h3 className="sa-card-heading">ТОП-5 типовых ошибок</h3>
        <ul className="sa-issue-list">
          {detail.topIssues.map((item, i) => (
            <li key={i} className="sa-issue-item">
              <span className="sa-issue-index">{i + 1}</span>
              <span className="sa-issue-name" title={item.issue}>{item.issue}</span>
              <span className="sa-issue-pct">{item.percent}%</span>
              <div className="sa-issue-bar"><div className="sa-issue-bar-fill" style={{ width: `${item.percent}%` }} /></div>
            </li>
          ))}
        </ul>
      </div>
      <div className="sa-card">
        <h3 className="sa-card-heading">ТОП-5 сложных вопросов</h3>
        <ul className="sa-issue-list">
          {detail.topQuestions.map((q, i) => (
            <li key={i} className="sa-issue-item sa-question-item">
              <span className="sa-issue-index">{i + 1}</span>
              <span className="sa-issue-name">{q}</span>
              <span className="sa-issue-pct sa-issue-pct-ghost" aria-hidden>00%</span>
              <div className="sa-question-rule" aria-hidden />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Recommendations({
  items,
  onOpenProblem,
}: {
  items: DealershipAnalyticsDetail['recommendedTrainings'];
  onOpenProblem?: (issue: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="sa-card sa-recommendations-empty">
        <div className="sa-recommendations-empty-title">Пока нет рекомендаций</div>
        <div className="sa-training-item-desc">Когда появятся повторяющиеся ошибки, здесь будут конкретные шаги по улучшению.</div>
      </div>
    );
  }
  return (
    <div className="sa-recommendations-grid">
      {items.map((t, i) => (
        <article key={i} className="sa-recommendation-card">
          <div className="sa-recommendation-card-index" aria-hidden>{i + 1}</div>
          <div className="sa-recommendation-card-body">
            <h3 className="sa-recommendation-card-title">{t.title}</h3>
            <p className="sa-recommendation-card-desc">{t.description}</p>
          </div>
          {onOpenProblem && (
            <button type="button" className="sa-btn-text sa-recommendation-card-action" onClick={() => onOpenProblem(t.title)}>
              Открыть проверки →
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

/* ────────────────────── Main Component ────────────────────── */

export function DealershipDetail({ dealershipId, dealership, onBack, onOpenEmployee, onOpenBatchDetail, onDealershipSaved, onDealershipDeleted, mode = 'default' }: Props) {
  const navigate = useNavigate();
  const isDealerDashboard = mode === 'dealerDashboard';
  const [realDetail, setRealDetail] = useState<DealershipAnalyticsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [planParticipation, setPlanParticipation] = useState<AnalyticsPlanParticipation[]>([]);
  const [planActionStatus, setPlanActionStatus] = useState<string | null>(null);
  const [excludingPlanId, setExcludingPlanId] = useState<string | null>(null);
  const detail = useMemo(
    () => realDetail || (dealership ? buildFallbackDetail(dealership) : null),
    [dealershipId, dealership, realDetail],
  );
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeBatch, setActiveBatch] = useState<CallBatchSnapshot | null>(null);
  const [batchSummary, setBatchSummary] = useState<DealershipBatchSummary | null>(null);
  const [editDealershipOpen, setEditDealershipOpen] = useState(false);
  const [phoneNumbersOpen, setPhoneNumbersOpen] = useState(false);
  const [analyticsDrawerOpen, setAnalyticsDrawerOpen] = useState(false);
  const [analyticsDrawerDetail, setAnalyticsDrawerDetail] = useState<AuditDetailItem | null>(null);
  const [analyticsDrawerLoading, setAnalyticsDrawerLoading] = useState(false);
  const [analyticsDrawerError, setAnalyticsDrawerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([
      fetchAnalyticsDealershipDetail(dealershipId),
      fetchAnalyticsDealershipPlans(dealershipId),
    ])
      .then(([item, plans]) => {
        if (!cancelled) {
          setRealDetail(item as DealershipAnalyticsDetail | null);
          setPlanParticipation(plans);
          setDetailLoading(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRealDetail(null);
          setPlanParticipation([]);
          setDetailError(error instanceof Error ? error.message : 'Не удалось загрузить данные точки');
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dealershipId]);

  async function reloadPlanParticipation() {
    const plans = await fetchAnalyticsDealershipPlans(dealershipId);
    setPlanParticipation(plans);
  }

  async function handleExcludePlan(plan: AnalyticsPlanParticipation) {
    const confirmed = window.confirm(`Исключить точку «${detail?.name ?? ''}» из расписания «${plan.name}»?`);
    if (!confirmed) return;
    setPlanActionStatus(null);
    setExcludingPlanId(plan.id);
    try {
      await excludeDealershipFromAnalyticsPlan(dealershipId, plan.id);
      await reloadPlanParticipation();
      setPlanActionStatus('Точка исключена из расписания');
    } catch (error) {
      setPlanActionStatus(error instanceof Error ? error.message : 'Не удалось исключить точку из расписания');
    } finally {
      setExcludingPlanId(null);
    }
  }

  function closeAnalyticsDrawer() {
    setAnalyticsDrawerOpen(false);
    setAnalyticsDrawerLoading(false);
    setAnalyticsDrawerError(null);
    setAnalyticsDrawerDetail(null);
  }

  async function handleOpenCallDetail(auditId: string) {
    setAnalyticsDrawerOpen(true);
    setAnalyticsDrawerDetail(null);
    setAnalyticsDrawerError(null);
    setAnalyticsDrawerLoading(true);
    try {
      const detail = await fetchAuditDetail(auditId);
      if (!detail) throw new Error('Аналитика звонка не найдена или ещё не готова.');
      setAnalyticsDrawerDetail(detail);
    } catch (error) {
      setAnalyticsDrawerError(error instanceof Error ? error.message : 'Не удалось загрузить аналитику звонка.');
    } finally {
      setAnalyticsDrawerLoading(false);
    }
  }

  useEffect(() => {
    try {
      const remembered = localStorage.getItem(ACTIVE_BATCH_STORAGE_KEY);
      if (remembered && remembered.trim()) {
        setActiveBatchId(remembered.trim());
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!activeBatchId || !detail) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      const data = await fetchBatchWithSummary(activeBatchId);
      if (!data || !data.batch) {
        if (!cancelled) {
          setActiveBatchId(null);
          setActiveBatch(null);
          setBatchSummary(null);
        }
        return;
      }
      if (cancelled) return;
      setActiveBatch(data.batch);
      const entry = (data.dealershipSummary || []).find(
        (d) => d.dealershipId === detail.id || (!d.dealershipId && d.dealershipName === detail.name),
      ) || null;
      setBatchSummary(entry);
      const isFinal = data.batch.status === 'completed' || data.batch.status === 'cancelled';
      if (!isFinal) {
        window.setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [activeBatchId, detail?.id, detail?.name]);

  if (detailLoading) {
    return (
      <div>
        {!isDealerDashboard && <button className="sa-btn-text" onClick={onBack}>← Точки</button>}
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Загружаем данные точки...</div>
      </div>
    );
  }

  if (detailError) {
    return (
      <div>
        {!isDealerDashboard && <button className="sa-btn-text" onClick={onBack}>← Точки</button>}
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>{detailError}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div>
        {!isDealerDashboard && <button className="sa-btn-text" onClick={onBack}>← Точки</button>}
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Точка не найдена</div>
      </div>
    );
  }

  const deltaSign = detail.deltaRating !== null ? (detail.deltaRating > 0 ? '+' : '') : '';
  const deltaText = detail.deltaRating !== null ? `${deltaSign}${detail.deltaRating}` : '—';
  const dealershipNoAnswers = detail.noAnswers ?? detail.outcomeBreakdown?.no_answer ?? 0;
  const dealershipCalls = detail.auditsCount || Object.values(detail.outcomeBreakdown ?? {}).reduce((sum, value) => sum + value, 0);
  const dealershipAnswerRate = detail.answerRate ?? 0;
  const hourlyAnswerRate = detail.hourlyAnswerRate?.length === 24 ? detail.hourlyAnswerRate : [];

  return (
    <div className="sa-detail-root sa-dealership-detail">
      {/* Breadcrumb */}
      {!isDealerDashboard && (
        <div className="sa-breadcrumb">
          <button className="sa-btn-text" onClick={onBack}>Точки</button>
          <span className="sa-breadcrumb-sep">→</span>
          <span>{detail.name}</span>
        </div>
      )}

      {/* Header */}
      <div className="sa-detail-header">
        <div>
          <div className="sa-holding-title-row" style={{ marginBottom: 4 }}>
            <h1 className="sa-page-title">{detail.name}</h1>
            {!isDealerDashboard && (
              <span className={statusBadgeClass(detail.status)}>{STATUS_LABELS[detail.status]}</span>
            )}
          </div>
          <p className="sa-page-subtitle" style={{ marginBottom: 0 }}>
            {dealership?.city || detail.city} · {dealershipTypeLabel(dealership?.type)} · {formatWorkingHours(dealership)}
          </p>
        </div>
        <div className="sa-detail-header-right">
          {!isDealerDashboard && (
            <button className="sa-btn-brutal-3d" onClick={() => setPhoneNumbersOpen(true)}>
              <PhoneIcon />
              Номера телефонов
            </button>
          )}
          {!isDealerDashboard && (
            <button className="sa-btn-brutal-3d" onClick={() => setEditDealershipOpen(true)}>
              <EditIcon />
              Редактировать
            </button>
          )}
        </div>
      </div>
      {activeBatch && batchSummary && (
        <div className="sa-meta" style={{ marginTop: -8, marginBottom: 12 }}>
          Сейчас идёт проверка этой точки ({batchSummary.completed}/{batchSummary.total}). Детали и управление — в трее проверок справа внизу.
        </div>
      )}
      {dealershipNoAnswers > 0 && (
        <div className="sa-batch-live-error" style={{ marginTop: -4, marginBottom: 16 }}>
          Недозвоны: {dealershipNoAnswers} из {dealershipCalls} звонков. Проверьте рабочие часы, доступность номеров и расписания прозвона.
        </div>
      )}

      <section className="sa-section sa-section-metrics" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Ключевые метрики</h2>
        <div className="sa-kpi-grid">
          <DealershipMetricCard
            label="AI рейтинг"
            value={detail.aiRating}
            valueSuffix="из 100"
            valueClass={ratingClass(detail.aiRating)}
            description={(
              <>
                Динамика за 30 дней{' '}
                <span className={`sa-kpi-delta${detail.deltaRating !== null ? (detail.deltaRating > 0 ? ' is-up' : detail.deltaRating < 0 ? ' is-down' : '') : ''}`}>
                  {deltaText}
                </span>
              </>
            )}
          />
          <DealershipMetricCard
            label="Проверки"
            value={detail.auditsCount}
            description="За выбранный период"
          />
          <DealershipMetricCard
            label="Сотрудники"
            value={detail.employeesCount}
            description="На точке"
          />
          <DealershipMetricCard
            label="Дозвон"
            value={detail.answerRate !== null ? `${detail.answerRate}%` : '—'}
            valueClass={detail.answerRate !== null ? answerRateClass(detail.answerRate) : undefined}
            description="Процент принятых звонков"
          />
          <DealershipMetricCard
            label="Время ответа"
            value={detail.avgAnswerTimeSec !== null ? detail.avgAnswerTimeSec : '—'}
            valueSuffix={detail.avgAnswerTimeSec !== null ? 'с' : undefined}
            valueClass={detail.avgAnswerTimeSec !== null ? answerTimeClass(detail.avgAnswerTimeSec) : undefined}
            description={`Время звонка: ${detail.avgCallDurationSec != null ? `${detail.avgCallDurationSec}с` : '—'}`}
          />
        </div>
      </section>

      {/* Schedules */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <div className="sa-section-header-row" style={{ marginBottom: 12 }}>
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Участвует в расписаниях</h2>
          {!isDealerDashboard && (
            <button type="button" className="sa-btn-text" onClick={() => navigate('/call-settings/plans')}>
              Настроить расписания →
            </button>
          )}
        </div>
        {planActionStatus && <div className="sa-meta" style={{ marginBottom: 10 }}>{planActionStatus}</div>}
        <PlanParticipationTable
          plans={planParticipation}
          excludingPlanId={excludingPlanId}
          onOpenPlan={(id) => navigate(`/call-settings/plans/${encodeURIComponent(id)}/edit`)}
          onExcludePlan={handleExcludePlan}
          readOnly={isDealerDashboard}
          variant="dealership"
        />
      </section>

      {/* Charts row */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Динамика эффективности</h2>
        <div className="sa-card sa-holding-detail-block sa-holding-activity-block" style={{ padding: 18, marginBottom: 12 }}>
          {detail.activitySeries ? (
            <EfficiencyActivityChart
              series={detail.activitySeries}
              showDealershipFilter={false}
            />
          ) : (
            <div className="sa-chart-empty">Нет данных за выбранный период</div>
          )}
        </div>
        <div className="sa-dashboard-grid">
          <BrutalCard title="Принятые и пропущенные" className="sa-grid-card sa-donut-card">
            <AnsweredMissedDonut
              rate={dealershipCalls > 0 ? dealershipAnswerRate : 0}
              totalCalls={dealershipCalls}
              embedded
            />
          </BrutalCard>
          <BrutalCard title="Дозвон по часам" className="sa-grid-card sa-chart-equal">
            <AnswerRateByHour hourly={hourlyAnswerRate} embedded />
          </BrutalCard>
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Исходы и категории</h2>
        <div className="sa-dashboard-grid">
          <div className="sa-card sa-grid-card">
            <h3 className="sa-card-heading">Исходы звонков</h3>
            <CallOutcomeBreakdown data={detail.outcomeBreakdown} />
          </div>
          <div className="sa-card sa-grid-card">
            <h3 className="sa-card-heading">Распределение по категориям</h3>
            <ScriptCompliance data={detail.scriptCompliance} />
          </div>
        </div>
      </section>

      {/* Employees */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Сотрудники</h2>
        <EmployeesTable employees={detail.employees} onOpenEmployee={onOpenEmployee} />
      </section>

      {/* Insights */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Аналитика по ошибкам</h2>
        <TopIssues detail={detail} />
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Рекомендации</h2>
        <Recommendations
          items={detail.recommendedTrainings}
          onOpenProblem={(issue) => {
            const params = new URLSearchParams();
            params.set('problem', issue);
            params.set('dealership', dealershipId);
            navigate(`/audits?${params.toString()}`);
          }}
        />
      </section>

      {/* Audit history */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">История проверок</h2>
        <AuditHistoryBlock
          variant="dealership"
          items={detail.audits}
          onOpenAudit={handleOpenCallDetail}
        />
      </section>

      <DealershipModal
        mode="edit"
        open={editDealershipOpen}
        dealership={dealership}
        onClose={() => setEditDealershipOpen(false)}
        onSaved={(saved) => onDealershipSaved?.(saved)}
        onDeleted={(id) => {
          setEditDealershipOpen(false);
          onDealershipDeleted?.(id);
        }}
      />
      <DealershipPhoneNumbersModal
        dealershipId={dealershipId}
        open={phoneNumbersOpen}
        onClose={() => setPhoneNumbersOpen(false)}
      />
      <SlideOver
        open={analyticsDrawerOpen}
        title={analyticsDrawerDetail?.type === 'trainer' ? 'Отчёт тренировки' : 'Аналитика звонка'}
        width="xl"
        onClose={closeAnalyticsDrawer}
      >
        {analyticsDrawerLoading ? (
          <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Загрузка аналитики...</div>
        ) : analyticsDrawerError ? (
          <div className="sa-card" style={{ padding: 20 }}>
            <div style={{ color: 'var(--tb-status-red)', fontWeight: 700 }}>Не удалось открыть аналитику</div>
            <div className="sa-meta" style={{ marginTop: 8 }}>{analyticsDrawerError}</div>
          </div>
        ) : analyticsDrawerDetail ? (
          <AuditAnalyticsReport
            detail={analyticsDrawerDetail}
            onOpenEmployee={(employeeId) => onOpenEmployee?.(employeeId)}
          />
        ) : (
          <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Выберите звонок.</div>
        )}
      </SlideOver>
    </div>
  );
}
