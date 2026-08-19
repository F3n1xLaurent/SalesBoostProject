import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import {
  createHolding,
  deleteHolding,
  fetchAnalyticsHoldingDetail,
  fetchAnalyticsHoldings,
  fetchAuditDetail,
  fetchDealerships,
  fetchHoldings,
  fetchHoldingRecommendations,
  updateHolding,
  type AnalyticsHoldingDealershipRow,
  type AnalyticsHoldingDetail,
  type AnalyticsHoldingRow,
  type AuditDetailItem,
  type DealershipItem,
  type HoldingItem,
  type HoldingType,
  type RecommendationResult,
  type RecommendationSignal,
} from '../../../shared/api/adminPanel';
import { ratingClass, scoreBarColor, deltaDisplay, statusBadgeClass } from '../../../shared/lib/admin-panel/utils';
import { STATUS_LABELS } from '../../../shared/lib/admin-panel/mockData';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { EditIcon } from '../../../shared/ui/icons/ActionIcons';
import { SingleSelectFilterPicker } from '../../../shared/ui/filter-picker/SingleSelectFilterPicker';
import { EfficiencyActivityChart } from '../../../shared/ui/efficiency-activity-chart/EfficiencyActivityChart';
import { ComparisonAISummary } from '../../../shared/ui/comparison-ai-summary/ComparisonAISummary';
import { useToast } from '../../../shared/ui/toast/ToastProvider';
import { SlideOver } from '../../../shared/ui/slide-over';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import { AuditHistoryBlock } from '../../../shared/ui/audit-history-block';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { BrutalSegmented } from '../../../shared/ui/brutal-segmented';
import { MetricComparisonModal } from '../../../shared/ui/metric-comparison-modal';
import { UnsavedChangesModal } from '../../../shared/ui/unsaved-changes-modal';
import { DeleteConfirmModal } from '../../../shared/ui/delete-confirm-modal';
import { RecommendationsBlock } from '../../../shared/ui/recommendations-block';

type HoldingFormState = {
  name: string;
  description: string;
  type: HoldingType;
  isActive: boolean;
  dealershipIds: string[];
};

type HoldingsPageProps = {
  holdingId?: string | null;
  onOpenHolding?: (id: string) => void;
  onBack?: () => void;
  onOpenDealership?: (id: string) => void;
};

const EMPTY_HOLDING_FORM: HoldingFormState = {
  name: '',
  description: '',
  type: 'own',
  isActive: true,
  dealershipIds: [],
};

const HOLDING_TYPE_FILTER_OPTIONS = [
  { value: 'all' as const, label: 'Тип: все' },
  { value: 'own' as const, label: 'Собственный' },
  { value: 'franchised' as const, label: 'Франчайзинговый' },
];

const HOLDING_TYPE_OPTIONS = [
  { value: 'own' as HoldingType, label: 'Собственный' },
  { value: 'franchised' as HoldingType, label: 'Франчайзинговый' },
];

const HOLDING_STATUS_FILTER_OPTIONS = [
  { value: 'all' as const, label: 'Статус: все' },
  { value: 'active' as const, label: 'Активный' },
  { value: 'inactive' as const, label: 'Деактивированный' },
];

type HoldingSortKey =
  | 'name'
  | 'type'
  | 'dealershipsCount'
  | 'avgScore'
  | 'calls'
  | 'noAnswers'
  | 'lowDealerships'
  | 'status';

type SortDir = 'asc' | 'desc';

function HoldingIssueBars({ items }: { items: { issue: string; percent: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  return (
    <div className="sa-hbar-list sa-hbar-list-thin sa-hbar-list-mono">
      {items.map((issue, index) => (
        <div
          key={issue.issue}
          className={`sa-hbar-row ${hoverIdx === index ? 'sa-hbar-row-hover' : ''}`}
          onMouseEnter={() => setHoverIdx(index)}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <span className="sa-hbar-label">{issue.issue}</span>
          <div className="sa-hbar-track">
            <div className="sa-hbar-fill" style={{ width: `${issue.percent}%` }} />
          </div>
          <span className="sa-hbar-score">{issue.percent}%</span>
          {hoverIdx === index && (
            <div className="sa-hbar-tooltip sa-hbar-tooltip-name">{issue.issue}</div>
          )}
        </div>
      ))}
    </div>
  );
}

const HOLDING_COLUMN_DEFS: { key: HoldingSortKey; label: string; align?: 'right' }[] = [
  { key: 'name', label: 'Компания' },
  { key: 'type', label: 'Тип' },
  { key: 'dealershipsCount', label: 'Точки', align: 'right' },
  { key: 'avgScore', label: 'AI-рейтинг', align: 'right' },
  { key: 'calls', label: 'Звонки', align: 'right' },
  { key: 'noAnswers', label: 'Недозвоны', align: 'right' },
  { key: 'lowDealerships', label: 'Ниже 50', align: 'right' },
  { key: 'status', label: 'Статус' },
];

function getHoldingSortValue(
  item: HoldingItem,
  key: HoldingSortKey,
  analytics: AnalyticsHoldingRow | undefined,
): string | number {
  switch (key) {
    case 'name':
      return item.name;
    case 'type':
      return item.type;
    case 'dealershipsCount':
      return item.dealershipsCount;
    case 'avgScore':
      return analytics?.avgScore ?? -1;
    case 'calls':
      return analytics?.calls ?? -1;
    case 'noAnswers':
      return analytics?.noAnswers ?? -1;
    case 'lowDealerships':
      return analytics?.lowDealerships ?? -1;
    case 'status':
      return item.isActive ? 1 : 0;
  }
}

function holdingComparator(
  key: HoldingSortKey,
  dir: SortDir,
  analyticsByHoldingId: Map<string, AnalyticsHoldingRow>,
) {
  return (a: HoldingItem, b: HoldingItem): number => {
    const av = getHoldingSortValue(a, key, analyticsByHoldingId.get(a.id));
    const bv = getHoldingSortValue(b, key, analyticsByHoldingId.get(b.id));
    let cmp = 0;
    if (typeof av === 'string' && typeof bv === 'string') {
      cmp = av.localeCompare(bv, 'ru');
    } else {
      cmp = (av as number) - (bv as number);
    }
    return dir === 'asc' ? cmp : -cmp;
  };
}

function buildHoldingForm(item: HoldingItem): HoldingFormState {
  return {
    name: item.name,
    description: item.description || '',
    type: item.type,
    isActive: item.isActive,
    dealershipIds: item.dealerships.map((dealership) => dealership.id),
  };
}

function normalizeHoldingForm(form: HoldingFormState) {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    type: form.type,
    isActive: form.isActive,
    dealershipIds: [...form.dealershipIds].sort(),
  };
}

function ModalFrame(props: {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  width?: number;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <BrutalModal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      subtitle={props.subtitle}
      width={props.width ?? 'medium'}
      footer={props.footer}
    >
      {props.children}
    </BrutalModal>
  );
}

const HOLDING_FORM_ID = 'holding-modal-form';

function HoldingMetricCard({
  label,
  value,
  description,
  valueClass,
  valueSuffix,
  variant = 'default',
  numeric = false,
}: {
  label: string;
  value: React.ReactNode;
  description?: string;
  valueClass?: string;
  valueSuffix?: string;
  variant?: 'default' | 'comparison';
  numeric?: boolean;
}) {
  const isComparison = variant === 'comparison';
  return (
    <div className={`sa-card sa-kpi-card sa-kpi-card-air sa-brutal-card${isComparison ? ' sa-comparison-summary-card' : ''}`}>
      <div className="sa-kpi-card-top">
        <div className="sa-kpi-card-heading">{label}</div>
      </div>
      {!isComparison && <div className="sa-kpi-card-spacer" aria-hidden />}
      <div className="sa-kpi-card-bottom">
        {valueSuffix ? (
          <div className="sa-kpi-value-row">
            <span className={`sa-kpi-value ${isComparison ? 'sa-comparison-summary-value' : 'sa-kpi-value-large'} ${numeric ? 'is-numeric' : ''} ${valueClass ?? ''}`}>{value}</span>
            <span className="sa-kpi-value-suffix">{valueSuffix}</span>
          </div>
        ) : (
          <div className={`sa-kpi-value ${isComparison ? 'sa-comparison-summary-value' : 'sa-kpi-value-large'} ${numeric ? 'is-numeric' : ''} ${valueClass ?? ''}`}>{value}</div>
        )}
        {description && <div className="sa-kpi-desc">{description}</div>}
      </div>
    </div>
  );
}

function HoldingComparisonModal({
  rows,
  onClose,
  onOpenDealership,
}: {
  rows: AnalyticsHoldingDealershipRow[];
  onClose: () => void;
  onOpenDealership?: (id: string) => void;
}) {
  if (rows.length < 2) return null;
  const leader = [...rows].sort((a, b) => b.score - a.score)[0];
  const lagger = [...rows].sort((a, b) => a.score - b.score)[0];
  const bestCalls = Math.max(...rows.map((row) => row.calls));
  const worstNoAnswers = Math.max(...rows.map((row) => row.noAnswers));

  return (
    <BrutalModal
      open
      onClose={onClose}
      title="Сравнение точек компании"
      width="wide"
    >
      <div className="sa-comparison-modal">
        <div className="sa-comparison-summary-grid">
          <HoldingMetricCard variant="comparison" label="Лидер" value={leader.name} valueClass={ratingClass(leader.score)} />
          <HoldingMetricCard variant="comparison" label="Нужна фокусировка" value={lagger.name} valueClass={ratingClass(lagger.score)} />
          <HoldingMetricCard variant="comparison" label="Макс. звонков" value={bestCalls} numeric />
          <HoldingMetricCard variant="comparison" label="Макс. недозвонов" value={worstNoAnswers} numeric />
        </div>

        <div className="sa-comparison-table-panel">
          <div className="sa-comparison-table-scroll">
            <table className="sa-table sa-comparison-table" style={{ ['--sa-comparison-cols' as string]: String(rows.length) }}>
              <thead>
                <tr>
                  <th>Точка</th>
                  <th>Город</th>
                  <th className="sa-text-right">AI-рейтинг</th>
                  <th className="sa-text-right">Динамика</th>
                  <th className="sa-text-right">Звонки</th>
                  <th className="sa-text-right">Недозвоны</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const delta = deltaDisplay(row.delta);
                  return (
                    <tr
                      key={row.id}
                      className={onOpenDealership ? 'sa-row-clickable' : undefined}
                      onClick={() => onOpenDealership?.(row.id)}
                    >
                      <td>
                        <div className="sa-cell-name">{row.name}</div>
                        <div className="sa-cell-city">{row.type === 'own' ? 'Собственный' : 'Франчайзинговый'}</div>
                      </td>
                      <td>{row.city}</td>
                      <td className="sa-text-right"><span className={ratingClass(row.score)}>{row.score}</span></td>
                      <td className="sa-text-right"><span className={delta.cls}>{delta.text}</span></td>
                      <td className="sa-text-right">{row.calls}</td>
                      <td className="sa-text-right">{row.noAnswers}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="sa-comparison-ai-wrap">
          <ComparisonAISummary level="holding-dealerships" items={rows.map((row) => ({ ...row }))} />
        </div>
      </div>
    </BrutalModal>
  );
}

type HoldingListComparisonRow = {
  id: string;
  name: string;
  type: HoldingType;
  dealershipsCount: number;
  avgScore: number;
  calls: number;
  noAnswers: number;
  lowDealerships: number;
  topProblem: string | null;
};

function HoldingListComparisonModal({
  rows,
  onClose,
  onOpenHolding,
}: {
  rows: HoldingListComparisonRow[];
  onClose: () => void;
  onOpenHolding?: (id: string) => void;
}) {
  const metrics = [
    { key: 'avgScore' as const, label: 'AI-рейтинг', higherBetter: true },
    { key: 'dealershipsCount' as const, label: 'Точки', higherBetter: true },
    { key: 'calls' as const, label: 'Звонки', higherBetter: true },
    { key: 'noAnswers' as const, label: 'Недозвоны', higherBetter: false },
    { key: 'lowDealerships' as const, label: 'Точек ниже 50', higherBetter: false },
  ];

  return (
    <MetricComparisonModal
      open={rows.length >= 2}
      onClose={onClose}
      title="Сравнение компаний"
      columns={rows.map((row) => ({
        id: row.id,
        label: row.name,
        onOpen: onOpenHolding ? () => onOpenHolding(row.id) : undefined,
      }))}
      metrics={metrics.map((metric) => ({
        key: metric.key,
        label: metric.label,
        higherBetter: metric.higherBetter,
        values: rows.map((row) => Number(row[metric.key] ?? 0)),
      }))}
      extraRows={[
        {
          key: 'topProblem',
          label: 'Топ-проблема',
          cells: rows.map((row) => row.topProblem ?? '—'),
        },
      ]}
      aiLevel="holdings-directory"
      aiItems={rows.map((row) => ({ ...row }))}
    />
  );
}

function HoldingAnalyticsDetail({
  holdingId,
  onBack,
  onOpenDealership,
  onEdit,
  refreshKey = 0,
}: {
  holdingId: string;
  onBack?: () => void;
  onOpenDealership?: (id: string) => void;
  onEdit?: () => void;
  refreshKey?: number;
}) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [detail, setDetail] = useState<AnalyticsHoldingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [analyticsDrawerOpen, setAnalyticsDrawerOpen] = useState(false);
  const [analyticsDrawerDetail, setAnalyticsDrawerDetail] = useState<AuditDetailItem | null>(null);
  const [analyticsDrawerLoading, setAnalyticsDrawerLoading] = useState(false);
  const [analyticsDrawerError, setAnalyticsDrawerError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationResult | null>(null);
  const [recommendationsError, setRecommendationsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelectedIds([]);
    setRecommendations(null);
    setRecommendationsError(null);
    Promise.all([fetchAnalyticsHoldingDetail(holdingId), fetchHoldingRecommendations(holdingId)])
      .then(([item, recommendationResponse]) => {
        if (!cancelled) {
          setDetail(item);
          setRecommendations(recommendationResponse.recommendations);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        showToast({
          type: 'error',
          title: 'Не удалось загрузить аналитику компании',
          description: error instanceof Error ? error.message : 'Попробуйте повторить действие.',
        });
        setDetail(null);
        setRecommendationsError('Не удалось загрузить рекомендации.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [holdingId, showToast, refreshKey]);

  const selectedRows = useMemo(
    () => detail?.dealershipRows.filter((row) => selectedIds.includes(row.id)) ?? [],
    [detail?.dealershipRows, selectedIds],
  );

  function toggleRow(id: string) {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
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
      const item = await fetchAuditDetail(auditId);
      if (!item) throw new Error('Аналитика звонка не найдена или ещё не готова.');
      setAnalyticsDrawerDetail(item);
    } catch (error) {
      setAnalyticsDrawerError(error instanceof Error ? error.message : 'Не удалось загрузить аналитику звонка.');
    } finally {
      setAnalyticsDrawerLoading(false);
    }
  }

  if (loading) {
    return <div className="sa-meta" style={{ padding: 32 }}>Загрузка аналитики компании...</div>;
  }

  if (!detail) {
    return (
      <div className="sa-detail-root">
        <button type="button" className="sa-btn-outline" onClick={onBack}>Назад</button>
        <div className="sa-card" style={{ padding: 20 }}>Компания не найдена или по ней пока нет данных.</div>
      </div>
    );
  }

  const scoreInt = Math.round(detail.avgScore);

  return (
    <div className="sa-detail-root sa-holding-detail">
      <div className="sa-breadcrumb">
        <button type="button" className="sa-btn-text" onClick={onBack}>Компании</button>
        <span className="sa-breadcrumb-sep">→</span>
        <span>{detail.name}</span>
      </div>

      <div className="sa-detail-header">
        <div className="sa-detail-header-intro">
          <div className="sa-holding-title-row">
            <h1 className="sa-page-title">{detail.name}</h1>
            <span className="sa-chip sa-chip-static">
              {detail.type === 'own' ? 'Собственная компания' : 'Франчайзинговая компания'}
            </span>
          </div>
        </div>
        <div className="sa-detail-header-right">
          {onEdit && (
            <button type="button" className="sa-btn-brutal-3d" onClick={onEdit}>
              <EditIcon />
              Редактировать
            </button>
          )}
        </div>
      </div>

      <section className="sa-section sa-section-metrics">
        <h2 className="sa-section-title">Ключевые метрики</h2>
        <div className="sa-kpi-grid sa-holding-detail-kpis">
          <HoldingMetricCard
            label="AI рейтинг"
            value={scoreInt}
            valueSuffix="из 100"
            description="Среднее по всем проверкам"
            valueClass={ratingClass(detail.avgScore)}
          />
          <HoldingMetricCard
            label="Точки"
            value={detail.dealershipsCount}
            description="В сети компании"
          />
          <HoldingMetricCard
            label="Звонки"
            value={detail.calls}
            description="По всем точкам"
          />
          <HoldingMetricCard
            label="Недозвоны"
            value={detail.noAnswers}
            description="Неотвеченные звонки"
          />
          <HoldingMetricCard
            label="Точек ниже 50"
            value={detail.lowDealerships}
            description="Требуют внимания"
            valueClass={detail.lowDealerships > 0 ? 'sa-score-red' : 'sa-score-green'}
          />
        </div>
      </section>

      <section className="sa-section">
        <h2 className="sa-section-title">Точки компании</h2>
        <div className="sa-table-wrap sa-holding-detail-points-table">
          <table className="sa-table">
            <thead>
              <tr>
                <th style={{ width: 44 }} />
                <th>Точка</th>
                <th>Город</th>
                <th className="sa-text-right">AI-рейтинг</th>
                <th>Статус</th>
                <th className="sa-text-right">Звонки</th>
                <th className="sa-text-right">Недозвоны</th>
                <th className="sa-text-right">Менеджеры</th>
              </tr>
            </thead>
            <tbody>
              {detail.dealershipRows.length === 0 ? (
                <tr><td colSpan={8} className="sa-meta" style={{ padding: 24 }}>У компании пока нет точек.</td></tr>
              ) : detail.dealershipRows.map((row) => (
                <tr
                  key={row.id}
                  className="sa-row-clickable"
                  onClick={() => onOpenDealership?.(row.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => event.key === 'Enter' && onOpenDealership?.(row.id)}
                >
                  <td onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(row.id)}
                      disabled={!selectedIds.includes(row.id) && selectedIds.length >= 6}
                      onChange={() => toggleRow(row.id)}
                      aria-label={`Выбрать ${row.name}`}
                    />
                  </td>
                  <td>
                    <div className="sa-cell-name">{row.name}</div>
                    <div className="sa-cell-city">{row.type === 'own' ? 'Собственная' : 'Франчайзинговая'}</div>
                  </td>
                  <td>{row.city}</td>
                  <td className="sa-text-right"><span className={ratingClass(row.score)}>{row.score}</span></td>
                  <td><span className={statusBadgeClass(row.status)}>{STATUS_LABELS[row.status]}</span></td>
                  <td className="sa-text-right">{row.calls}</td>
                  <td className="sa-text-right">{row.noAnswers}</td>
                  <td className="sa-text-right">{row.employeesCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sa-section">
        <h2 className="sa-section-title">Динамика эффективности</h2>
        <div className="sa-card sa-holding-detail-block sa-holding-activity-block" style={{ padding: 18, marginBottom: 12 }}>
          {detail.activitySeries ? (
            <EfficiencyActivityChart
              series={detail.activitySeries}
              dealershipSeries={detail.dealershipActivitySeries}
              dealershipRows={detail.dealershipRows}
            />
          ) : (
            <div className="sa-chart-empty">Нет данных за выбранный период</div>
          )}
        </div>
      </section>

      <section className="sa-section">
        <h2 className="sa-section-title">Аналитика по ошибкам</h2>
        <div className="sa-detail-insights sa-holding-detail-insights">
          <div className="sa-card">
            <h3 className="sa-card-heading">Проблемные блоки</h3>
            {detail.topIssues.length === 0 ? (
              <div className="sa-meta">Нет выраженных проблем.</div>
            ) : (
              <HoldingIssueBars items={detail.topIssues.slice(0, 5)} />
            )}
          </div>
          <div className="sa-card">
            <h3 className="sa-card-heading">Распределение по категориям</h3>
            {detail.scriptCompliance.length === 0 ? (
              <div className="sa-meta">Нет рассчитанных категорий.</div>
            ) : (
              <div className="sa-hbar-list sa-hbar-list-thin">
                {detail.scriptCompliance.slice(0, 5).map((block) => (
                  <div key={block.block} className="sa-hbar-row">
                    <span className="sa-hbar-label" title={block.block}>{block.block}</span>
                    <div className="sa-hbar-track">
                      <div className="sa-hbar-fill" style={{ width: `${block.rate}%`, background: scoreBarColor(block.rate) }} />
                    </div>
                    <span className={`sa-hbar-score ${ratingClass(block.rate)}`}>{block.rate}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="sa-section">
        <h2 className="sa-section-title">Рекомендации</h2>
        <RecommendationsBlock
          data={recommendations}
          loading={loading && !recommendations}
          error={recommendationsError}
          onOpen={(signal: RecommendationSignal) => {
            if ((signal.kind === 'lagging' || signal.kind === 'checklist') && signal.scope === 'quick' && signal.entityId) {
              onOpenDealership?.(signal.entityId);
              return;
            }
            if (signal.scope === 'systemic' && signal.kind === 'missed') { navigate('/call-settings/plans'); return; }
            if (signal.scope === 'systemic' && signal.kind === 'source') { navigate('/analytics'); return; }
            const params = new URLSearchParams({ holding: holdingId });
            if (signal.problemCode) params.set('problem', signal.problemCode);
            if (signal.sourceTypeId) params.set('sourceTypeId', signal.sourceTypeId);
            if (signal.phoneNumberId) params.set('phoneNumberId', signal.phoneNumberId);
            if (signal.kind === 'missed') params.set('outcome', 'missed');
            if (signal.kind === 'answer_speed') params.set('sort', 'answerTimeDesc');
            navigate(`/audits?${params.toString()}`);
          }}
        />
      </section>

      {selectedRows.length > 0 && createPortal(
        <div className="theme-brutal sa-selection-tray">
          <div className="sa-selection-tray__card">
            <strong>Выбрано: {selectedRows.length}</strong>
            <button type="button" className="sa-btn-outline" disabled={selectedRows.length < 2} onClick={() => setComparisonOpen(true)}>Сравнить</button>
            <button type="button" className="sa-btn-text" onClick={() => setSelectedIds([])}>Сбросить</button>
          </div>
        </div>,
        document.body,
      )}

      {comparisonOpen && (
        <HoldingComparisonModal rows={selectedRows} onClose={() => setComparisonOpen(false)} onOpenDealership={onOpenDealership} />
      )}

      <section className="sa-section">
        <h2 className="sa-section-title">История проверок</h2>
        <AuditHistoryBlock
          variant="holding"
          items={detail.audits ?? []}
          onOpenAudit={handleOpenCallDetail}
          emptyText="Нет проверок за период"
        />
      </section>

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
          <AuditAnalyticsReport detail={analyticsDrawerDetail} />
        ) : (
          <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Выберите звонок.</div>
        )}
      </SlideOver>
    </div>
  );
}

export function HoldingsPage({ holdingId, onOpenHolding, onBack, onOpenDealership }: HoldingsPageProps = {}) {
  const { showToast } = useToast();
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [dealerships, setDealerships] = useState<DealershipItem[]>([]);
  const [analyticsRows, setAnalyticsRows] = useState<AnalyticsHoldingRow[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [holdingTypeFilter, setHoldingTypeFilter] = useState<'all' | HoldingType>('all');
  const [holdingStatusFilter, setHoldingStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const [createHoldingOpen, setCreateHoldingOpen] = useState(false);
  const [editHoldingOpen, setEditHoldingOpen] = useState(false);
  const [editDeleteConfirm, setEditDeleteConfirm] = useState(false);
  const [holdingDealershipsOpen, setHoldingDealershipsOpen] = useState(false);
  const [attachDealershipOpen, setAttachDealershipOpen] = useState(false);
  const [selectedHoldingIds, setSelectedHoldingIds] = useState<string[]>([]);
  const [holdingComparisonOpen, setHoldingComparisonOpen] = useState(false);

  const [holdingForm, setHoldingForm] = useState<HoldingFormState>(EMPTY_HOLDING_FORM);
  const [initialHoldingForm, setInitialHoldingForm] = useState<HoldingFormState>(EMPTY_HOLDING_FORM);
  const [savingHolding, setSavingHolding] = useState(false);
  const [holdingFormAttempted, setHoldingFormAttempted] = useState(false);
  const [holdingUnsavedOpen, setHoldingUnsavedOpen] = useState(false);
  const [activeHolding, setActiveHolding] = useState<HoldingItem | null>(null);
  const [attachDealershipSearch, setAttachDealershipSearch] = useState('');
  const [sortKey, setSortKey] = useState<HoldingSortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);

  async function loadData() {
    setLoading(true);
    try {
      const [nextHoldings, nextDealerships] = await Promise.all([
        fetchHoldings({
          search: debouncedSearch,
          type: holdingTypeFilter,
          status: holdingStatusFilter,
        }),
        fetchDealerships(),
      ]);
      setHoldings(nextHoldings);
      setDealerships(nextDealerships);
      setAnalyticsLoading(true);
      setAnalyticsError(null);
      fetchAnalyticsHoldings()
        .then(setAnalyticsRows)
        .catch((error) => {
          setAnalyticsRows([]);
          setAnalyticsError(error instanceof Error ? error.message : 'Не удалось загрузить аналитику компаний');
        })
        .finally(() => setAnalyticsLoading(false));
      setActiveHolding((current) => (current ? nextHoldings.find((item) => item.id === current.id) || null : current));
      return { nextHoldings, nextDealerships };
    } catch (loadError) {
      showToast({
        type: 'error',
        title: 'Не удалось загрузить структуру',
        description: loadError instanceof Error ? loadError.message : 'Попробуйте повторить действие.',
      });
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    loadData().catch(() => undefined);
  }, [debouncedSearch, holdingStatusFilter, holdingTypeFilter]);

  const unassignedDealerships = useMemo(
    () => dealerships.filter((item) => !item.holdingId),
    [dealerships],
  );
  const analyticsByHoldingId = useMemo(
    () => new Map(analyticsRows.map((item) => [item.id, item])),
    [analyticsRows],
  );
  const hasActiveFilters =
    searchInput.trim() !== '' ||
    holdingTypeFilter !== 'all' ||
    holdingStatusFilter !== 'all';
  const sortedHoldings = useMemo(
    () => [...holdings].sort(holdingComparator(sortKey, sortDir, analyticsByHoldingId)),
    [analyticsByHoldingId, holdings, sortDir, sortKey],
  );
  const selectedHoldingRows = useMemo<HoldingListComparisonRow[]>(
    () => holdings
      .filter((item) => selectedHoldingIds.includes(item.id))
      .map((item) => {
        const analytics = analyticsByHoldingId.get(item.id);
        return {
          id: item.id,
          name: item.name,
          type: item.type,
          dealershipsCount: item.dealershipsCount,
          avgScore: analytics?.avgScore ?? 0,
          calls: analytics?.calls ?? 0,
          noAnswers: analytics?.noAnswers ?? 0,
          lowDealerships: analytics?.lowDealerships ?? 0,
          topProblem: analytics?.topProblem ?? null,
        };
      }),
    [analyticsByHoldingId, holdings, selectedHoldingIds],
  );

  function handleSort(key: HoldingSortKey) {
    if (sortKey === key) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(key === 'name' || key === 'type' || key === 'status' ? 'asc' : 'desc');
  }

  function toggleHoldingCompare(id: string) {
    setSelectedHoldingIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
  }

  function openCreateHolding() {
    setHoldingForm(EMPTY_HOLDING_FORM);
    setInitialHoldingForm(EMPTY_HOLDING_FORM);
    setActiveHolding(null);
    setHoldingFormAttempted(false);
    setHoldingUnsavedOpen(false);
    setCreateHoldingOpen(true);
  }

  function openEditHolding(item: HoldingItem) {
    const nextForm = buildHoldingForm(item);
    setActiveHolding(item);
    setHoldingForm(nextForm);
    setInitialHoldingForm(nextForm);
    setHoldingFormAttempted(false);
    setHoldingUnsavedOpen(false);
    setEditDeleteConfirm(false);
    setEditHoldingOpen(true);
  }

  async function openEditHoldingFromDetail() {
    if (!holdingId) return;
    let item = holdings.find((holding) => holding.id === holdingId) ?? null;
    if (!item) {
      try {
        const all = await fetchHoldings();
        item = all.find((holding) => holding.id === holdingId) ?? null;
      } catch (error) {
        showToast({
          type: 'error',
          title: 'Не удалось открыть редактирование',
          description: error instanceof Error ? error.message : 'Попробуйте повторить действие.',
        });
        return;
      }
    }
    if (!item) {
      showToast({ type: 'error', title: 'Компания не найдена', description: 'Обновите страницу и попробуйте снова.' });
      return;
    }
    openEditHolding(item);
  }

  function openHoldingDealerships(item: HoldingItem) {
    setActiveHolding(item);
    setHoldingDealershipsOpen(true);
    setAttachDealershipOpen(false);
  }

  function openHoldingAnalytics(item: HoldingItem) {
    if (onOpenHolding) {
      onOpenHolding(item.id);
      return;
    }
    openHoldingDealerships(item);
  }

  function openAttachDealerships(item: HoldingItem) {
    setActiveHolding(item);
    setAttachDealershipSearch('');
    setAttachDealershipOpen(true);
  }

  async function handleCreateHoldingSubmit(event: React.FormEvent) {
    event.preventDefault();
    setHoldingFormAttempted(true);
    if (!holdingForm.name.trim()) {
      showToast({ type: 'error', title: 'Не удалось создать компанию', description: 'Название компании обязательно.' });
      return;
    }
    setSavingHolding(true);
    try {
      await createHolding({
        name: holdingForm.name,
        description: holdingForm.description.trim() || null,
        type: holdingForm.type,
        code: null,
        isActive: true,
        dealershipIds: [],
      });
      setCreateHoldingOpen(false);
      setHoldingFormAttempted(false);
      showToast({ type: 'success', title: 'Компания создана', description: holdingForm.name });
      await loadData();
    } catch (submitError) {
      showToast({
        type: 'error',
        title: 'Не удалось создать компанию',
        description: submitError instanceof Error ? submitError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSavingHolding(false);
    }
  }

  async function persistHoldingEdit(): Promise<boolean> {
    if (!activeHolding) return false;
    setHoldingFormAttempted(true);
    if (!holdingForm.name.trim()) {
      showToast({ type: 'error', title: 'Не удалось обновить компанию', description: 'Название компании обязательно.' });
      return false;
    }
    setSavingHolding(true);
    try {
      await updateHolding(activeHolding.id, {
        name: holdingForm.name,
        description: holdingForm.description.trim() || null,
        type: holdingForm.type,
        code: activeHolding.code || null,
        isActive: holdingForm.isActive,
        dealershipIds: holdingForm.dealershipIds,
      });
      setEditHoldingOpen(false);
      setHoldingUnsavedOpen(false);
      setHoldingFormAttempted(false);
      showToast({ type: 'success', title: 'Компания сохранена', description: holdingForm.name });
      await loadData();
      if (holdingId) setDetailRefreshKey((key) => key + 1);
      return true;
    } catch (submitError) {
      showToast({
        type: 'error',
        title: 'Не удалось обновить компанию',
        description: submitError instanceof Error ? submitError.message : 'Попробуйте повторить действие.',
      });
      return false;
    } finally {
      setSavingHolding(false);
    }
  }

  async function handleEditHoldingSubmit(event: React.FormEvent) {
    event.preventDefault();
    const isDirty = JSON.stringify(normalizeHoldingForm(holdingForm)) !== JSON.stringify(normalizeHoldingForm(initialHoldingForm));
    if (!isDirty) return;
    await persistHoldingEdit();
  }

  const filteredAttachDealerships = useMemo(() => {
    const query = attachDealershipSearch.trim().toLowerCase();
    const items = unassignedDealerships.filter((item) => {
      if (!query) return true;
      const haystack = [item.name, item.city || '', item.address || '', item.code || ''].join(' ').toLowerCase();
      return haystack.includes(query);
    });
    return items.slice(0, 5);
  }, [attachDealershipSearch, unassignedDealerships]);

  async function handleDeleteHoldingConfirm() {
    if (!activeHolding) return;
    setSavingHolding(true);
    try {
      await deleteHolding(activeHolding.id);
      setEditDeleteConfirm(false);
      setEditHoldingOpen(false);
      setActiveHolding(null);
      showToast({ type: 'success', title: 'Компания удалена', description: 'Точки отвязаны.' });
      await loadData();
    } catch (submitError) {
      showToast({
        type: 'error',
        title: 'Не удалось удалить компанию',
        description: submitError instanceof Error ? submitError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSavingHolding(false);
    }
  }

  async function handleAttachDealership(holdingId: string, dealershipId: string) {
    const targetHolding = holdings.find((item) => item.id === holdingId) || activeHolding;
    if (!targetHolding) return;
    setSavingHolding(true);
    try {
      await updateHolding(holdingId, {
        name: targetHolding.name,
        description: targetHolding.description || null,
        type: targetHolding.type,
        code: targetHolding.code || null,
        isActive: targetHolding.isActive,
        dealershipIds: [...targetHolding.dealerships.map((item) => item.id), dealershipId],
      });
      setAttachDealershipOpen(false);
      showToast({ type: 'success', title: 'Точка привязана к компании' });
      await loadData();
    } catch (attachError) {
      showToast({
        type: 'error',
        title: 'Не удалось привязать точку',
        description: attachError instanceof Error ? attachError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSavingHolding(false);
    }
  }

  function renderHoldingForm(onSubmit: (event: React.FormEvent) => void, submitLabel: string, options?: { mode: 'create' | 'edit' }) {
    const mode = options?.mode ?? 'edit';
    const isCreate = mode === 'create';
    const isDirty = JSON.stringify(normalizeHoldingForm(holdingForm)) !== JSON.stringify(normalizeHoldingForm(initialHoldingForm));
    const nameInvalid = holdingFormAttempted && !holdingForm.name.trim();
    const isSubmitDisabled = savingHolding || (!isCreate && !isDirty);

    return (
      <form id={HOLDING_FORM_ID} onSubmit={onSubmit} style={{ display: 'grid', gap: 16 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Название</span>
          <input
            className={`sa-input${nameInvalid ? ' sa-field-invalid' : ''}`}
            value={holdingForm.name}
            onChange={(event) => setHoldingForm((current) => ({ ...current, name: event.target.value }))}
            aria-invalid={nameInvalid || undefined}
          />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Описание</span>
          <textarea
            className="sa-input"
            rows={4}
            value={holdingForm.description}
            onChange={(event) => setHoldingForm((current) => ({ ...current, description: event.target.value }))}
            placeholder="Заполните информацию о компании, расскажите чем занимается, какое направление"
          />
        </label>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontWeight: 600 }}>Тип компании</span>
          <BrutalSegmented
            ariaLabel="Тип компании"
            value={holdingForm.type}
            options={HOLDING_TYPE_OPTIONS}
            onChange={(type) => setHoldingForm((current) => ({ ...current, type }))}
          />
        </div>
        {!isCreate && (
          <button
            type="button"
            className="sa-toggle-field"
            aria-pressed={holdingForm.isActive}
            onClick={() => setHoldingForm((current) => ({ ...current, isActive: !current.isActive }))}
          >
            <span className="sa-toggle-field__text">Компания включена и пользуется системой</span>
            <span className="sa-toggle-field__control" aria-hidden="true">
              <span className="sa-toggle-field__thumb" />
            </span>
          </button>
        )}
      </form>
    );
  }

  function renderHoldingFormFooter(options: { mode: 'create' | 'edit'; submitLabel: string; onRequestClose: () => void }) {
    const isCreate = options.mode === 'create';
    const isDirty = JSON.stringify(normalizeHoldingForm(holdingForm)) !== JSON.stringify(normalizeHoldingForm(initialHoldingForm));
    const isSubmitDisabled = savingHolding || !holdingForm.name.trim() || (!isCreate && !isDirty);
    return (
      <div className={`sa-modal-footer-row${isCreate ? '' : ''}`}>
        {!isCreate && (
          <button type="button" className="sa-btn-danger" onClick={() => setEditDeleteConfirm(true)}>
            Удалить компанию
          </button>
        )}
        <div className="sa-modal-footer-row__right">
          <button type="button" className="sa-btn-outline" onClick={options.onRequestClose} disabled={savingHolding}>
            Отмена
          </button>
          <button
            type="submit"
            form={HOLDING_FORM_ID}
            className="sa-btn-primary"
            disabled={isSubmitDisabled}
          >
            {savingHolding ? 'Сохраняем...' : options.submitLabel}
          </button>
        </div>
      </div>
    );
  }

  function requestCloseHoldingModal(mode: 'create' | 'edit') {
    const isDirty = JSON.stringify(normalizeHoldingForm(holdingForm)) !== JSON.stringify(normalizeHoldingForm(initialHoldingForm));
    if (mode === 'edit' && isDirty) {
      setHoldingUnsavedOpen(true);
      return;
    }
    setCreateHoldingOpen(false);
    setEditHoldingOpen(false);
    setEditDeleteConfirm(false);
    setHoldingFormAttempted(false);
    setHoldingUnsavedOpen(false);
  }

  function renderUnsavedHoldingModal() {
    return (
      <UnsavedChangesModal
        open={holdingUnsavedOpen && editHoldingOpen}
        saving={savingHolding}
        onCancel={() => setHoldingUnsavedOpen(false)}
        onDiscard={() => {
          setHoldingUnsavedOpen(false);
          setEditHoldingOpen(false);
          setEditDeleteConfirm(false);
          setHoldingFormAttempted(false);
        }}
        onSave={() => { void persistHoldingEdit(); }}
      />
    );
  }

  function renderDeleteHoldingModal() {
    return (
      <DeleteConfirmModal
        open={editDeleteConfirm && !!activeHolding}
        title="Удалить компанию?"
        saving={savingHolding}
        onCancel={() => setEditDeleteConfirm(false)}
        onConfirm={() => { void handleDeleteHoldingConfirm(); }}
      />
    );
  }

  if (holdingId) {
    return (
      <>
        <HoldingAnalyticsDetail
          holdingId={holdingId}
          refreshKey={detailRefreshKey}
          onBack={onBack}
          onOpenDealership={onOpenDealership}
          onEdit={() => void openEditHoldingFromDetail()}
        />
        <ModalFrame
          title="Редактировать компанию"
          subtitle="Редактирование основной информации о компании."
          open={editHoldingOpen && !!activeHolding}
          onClose={() => requestCloseHoldingModal('edit')}
          footer={renderHoldingFormFooter({ mode: 'edit', submitLabel: 'Сохранить', onRequestClose: () => requestCloseHoldingModal('edit') })}
        >
          {renderHoldingForm(handleEditHoldingSubmit, 'Сохранить', { mode: 'edit' })}
        </ModalFrame>
        {renderDeleteHoldingModal()}
        {renderUnsavedHoldingModal()}
      </>
    );
  }

  const SortIcon = ({ col }: { col: HoldingSortKey }) => {
    if (sortKey !== col) return <span className="sa-sort-icon sa-sort-icon-inactive">⇅</span>;
    return <span className="sa-sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  return (
    <div>
      <h1 className="sa-page-title">Компании</h1>
      {analyticsLoading && !loading && (
        <div className="sa-batch-live-note" style={{ marginBottom: 12 }}>
          Загружаем аналитику компаний...
        </div>
      )}
      {analyticsError && (
        <div className="sa-batch-live-error" style={{ marginBottom: 12 }}>
          {analyticsError}
        </div>
      )}

      <div className="sa-toolbar sa-toolbar-split sa-holdings-toolbar">
        <div className="sa-toolbar-filters">
          <div className="sa-search-wrap">
            <svg className="sa-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              className="sa-search-input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Поиск по компании или точке…"
            />
          </div>
          <div className="sa-tag-filter-picker-wrap">
            <SingleSelectFilterPicker
              options={HOLDING_TYPE_FILTER_OPTIONS}
              value={holdingTypeFilter}
              onChange={setHoldingTypeFilter}
            />
          </div>
          <div className="sa-tag-filter-picker-wrap">
            <SingleSelectFilterPicker
              options={HOLDING_STATUS_FILTER_OPTIONS}
              value={holdingStatusFilter}
              onChange={setHoldingStatusFilter}
            />
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              className="sa-btn-border-only"
              onClick={() => {
                setSearchInput('');
                setDebouncedSearch('');
                setHoldingTypeFilter('all');
                setHoldingStatusFilter('all');
              }}
            >
              Сбросить
            </button>
          )}
        </div>
        <div className="sa-toolbar-actions">
          <button type="button" className="sa-btn-brutal-3d" onClick={openCreateHolding}>
            <LetsIcon name="add-light" size={16} bold />
            Создать компанию
          </button>
        </div>
      </div>

      <div className="sa-companies-table-wrap sa-holdings-table-wrap sa-desktop-only">
        <table className="sa-table sa-table-sortable sa-holdings-table">
          <colgroup>
            <col className="sa-col-check" />
            <col className="sa-col-name" />
            <col className="sa-col-type" />
            <col className="sa-col-num" />
            <col className="sa-col-num" />
            <col className="sa-col-num" />
            <col className="sa-col-num" />
            <col className="sa-col-num" />
            <col className="sa-col-status" />
            <col className="sa-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th />
              {HOLDING_COLUMN_DEFS.map((col) => (
                <th
                  key={col.key}
                  className={`sa-th-sortable ${col.align === 'right' ? 'sa-text-right' : ''}`}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {' '}
                  <SortIcon col={col.key} />
                </th>
              ))}
              <th className="sa-text-right sa-holdings-actions-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>Загрузка структуры...</td></tr>
            ) : sortedHoldings.length === 0 ? (
              <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>По текущим фильтрам компании не найдены.</td></tr>
            ) : (
              sortedHoldings.map((item) => {
                const analytics = analyticsByHoldingId.get(item.id);
                return (
                  <tr
                    key={item.id}
                    className="sa-row-clickable"
                    onClick={() => openHoldingAnalytics(item)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => event.key === 'Enter' && openHoldingAnalytics(item)}
                  >
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedHoldingIds.includes(item.id)}
                        disabled={!selectedHoldingIds.includes(item.id) && selectedHoldingIds.length >= 6}
                        onChange={() => toggleHoldingCompare(item.id)}
                        aria-label={`Выбрать ${item.name}`}
                      />
                    </td>
                    <td>
                      <div className="sa-cell-name">{item.name}</div>
                    </td>
                    <td>{item.type === 'own' ? 'Собственный' : 'Франчайзинговый'}</td>
                    <td className="sa-text-right">{item.dealershipsCount}</td>
                    <td className="sa-text-right"><span className={analytics ? (analytics.avgScore >= 76 ? 'sa-score-green' : analytics.avgScore >= 50 ? 'sa-score-orange' : 'sa-score-red') : ''}>{analytics?.avgScore ?? '—'}</span></td>
                    <td className="sa-text-right">{analytics?.calls ?? '—'}</td>
                    <td className="sa-text-right">{analytics?.noAnswers ?? '—'}</td>
                    <td className="sa-text-right">{analytics?.lowDealerships ?? '—'}</td>
                    <td>
                      <span className={`sa-status-badge ${item.isActive ? 'sa-status-norm' : 'sa-status-no-data'}`}>
                        {item.isActive ? 'Активен' : 'Выключен'}
                      </span>
                    </td>
                    <td className="sa-holdings-actions-cell">
                      <div onClick={(event) => event.stopPropagation()}>
                        <button type="button" className="sa-btn-icon sa-btn-brutal-3d-icon" onClick={() => openEditHolding(item)} aria-label="Редактировать компанию" title="Редактировать">
                          <EditIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="sa-mobile-only">
        {loading ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка структуры...</div>
        ) : holdings.length === 0 ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>По текущим фильтрам компании не найдены.</div>
        ) : (
          sortedHoldings.map((item) => {
            const analytics = analyticsByHoldingId.get(item.id);
            return (
              <div
                key={item.id}
                className="sa-mobile-row"
                onClick={() => openHoldingAnalytics(item)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => event.key === 'Enter' && openHoldingAnalytics(item)}
              >
                <div onClick={(event) => event.stopPropagation()} style={{ marginBottom: 8 }}>
                  <label className="sa-filter-check" style={{ width: 'fit-content' }}>
                    <input
                      type="checkbox"
                      checked={selectedHoldingIds.includes(item.id)}
                      disabled={!selectedHoldingIds.includes(item.id) && selectedHoldingIds.length >= 6}
                      onChange={() => toggleHoldingCompare(item.id)}
                    />
                    Сравнить
                  </label>
                </div>
                <div className="sa-mobile-row-header">
                  <div>
                    <div className="sa-cell-name">{item.name}</div>
                  </div>
                  <span className={`sa-status-badge ${item.isActive ? 'sa-status-norm' : 'sa-status-no-data'}`}>
                    {item.isActive ? 'Активен' : 'Выключен'}
                  </span>
                </div>
                <div className="sa-mobile-chips">
                  <span className="sa-metric-chip">{item.type === 'own' ? 'Собственный' : 'Франчайзинговый'}</span>
                  <span className="sa-metric-chip">{item.dealershipsCount} точек</span>
                  <span className="sa-metric-chip">AI-рейтинг: {analytics?.avgScore ?? '—'}</span>
                  <span className="sa-metric-chip">Звонков: {analytics?.calls ?? '—'}</span>
                  <span className="sa-metric-chip">Недозвонов: {analytics?.noAnswers ?? '—'}</span>
                  <span className="sa-metric-chip">Ниже 50: {analytics?.lowDealerships ?? '—'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }} onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="sa-btn-icon sa-btn-brutal-3d-icon"
                    onClick={() => openEditHolding(item)}
                    aria-label="Редактировать компанию"
                    title="Редактировать"
                  >
                    <EditIcon />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <ModalFrame
        title="Новая компания"
        subtitle="Создание компании, к которой после можно привязать точки"
        open={createHoldingOpen}
        onClose={() => requestCloseHoldingModal('create')}
        footer={renderHoldingFormFooter({ mode: 'create', submitLabel: 'Создать компанию', onRequestClose: () => requestCloseHoldingModal('create') })}
      >
        {renderHoldingForm(handleCreateHoldingSubmit, 'Создать компанию', { mode: 'create' })}
      </ModalFrame>

      <ModalFrame
        title="Редактировать компанию"
        subtitle="Редактирование основной информации о компании."
        open={editHoldingOpen && !!activeHolding}
        onClose={() => requestCloseHoldingModal('edit')}
        footer={renderHoldingFormFooter({ mode: 'edit', submitLabel: 'Сохранить', onRequestClose: () => requestCloseHoldingModal('edit') })}
      >
        {renderHoldingForm(handleEditHoldingSubmit, 'Сохранить', { mode: 'edit' })}
      </ModalFrame>

      {renderDeleteHoldingModal()}
      {renderUnsavedHoldingModal()}
      <ModalFrame title={activeHolding ? `Точки компании ${activeHolding.name}` : 'Точки компании'} width="wide" open={holdingDealershipsOpen && !!activeHolding} onClose={() => setHoldingDealershipsOpen(false)}>
        {activeHolding && (
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13 }}>
                Здесь отображаются все точки, привязанные к компании.
              </div>
              <button type="button" className="sa-btn-primary" onClick={() => openAttachDealerships(activeHolding)}>+</button>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {activeHolding.dealerships.length === 0 ? (
                <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Пока нет привязанных точек.</div>
              ) : activeHolding.dealerships.map((dealership) => (
                <div key={dealership.id} className="sa-card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{dealership.name}</div>
                    <div style={{ fontSize: 13, color: 'var(--sa-text-secondary)' }}>
                      {dealership.city || '—'} · {dealership.address || 'Адрес не указан'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </ModalFrame>

      <ModalFrame title={activeHolding ? `Привязать точки к ${activeHolding.name}` : 'Привязать точки'} width="wide" open={attachDealershipOpen && !!activeHolding} onClose={() => setAttachDealershipOpen(false)}>
        {activeHolding && (
          <div style={{ display: 'grid', gap: 12 }}>
            <input
              className="sa-input"
              value={attachDealershipSearch}
              onChange={(event) => setAttachDealershipSearch(event.target.value)}
              placeholder="Поиск по названию, городу, адресу или коду"
            />
            {unassignedDealerships.length === 0 ? (
              <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Нет доступных для привязки точек.</div>
            ) : filteredAttachDealerships.length === 0 ? (
              <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Ничего не найдено.</div>
            ) : filteredAttachDealerships.map((item) => (
              <div key={item.id} className="sa-card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{item.name}</div>
                  <div style={{ fontSize: 13, color: 'var(--sa-text-secondary)' }}>
                    {item.city || '—'} · {item.address || 'Адрес не указан'}
                  </div>
                </div>
                <button type="button" className="sa-btn-primary" onClick={() => void handleAttachDealership(activeHolding.id, item.id)} disabled={savingHolding}>
                  Привязать
                </button>
              </div>
            ))}
          </div>
        )}
      </ModalFrame>

      {selectedHoldingRows.length > 0 && createPortal(
        <div className="theme-brutal sa-selection-tray">
          <div className="sa-selection-tray__card">
            <strong>Выбрано: {selectedHoldingRows.length}</strong>
            <button type="button" className="sa-btn-outline" disabled={selectedHoldingRows.length < 2} onClick={() => setHoldingComparisonOpen(true)}>Сравнить</button>
            <button type="button" className="sa-btn-text" onClick={() => setSelectedHoldingIds([])}>Сбросить</button>
          </div>
        </div>,
        document.body,
      )}
      {holdingComparisonOpen && (
        <HoldingListComparisonModal
          rows={selectedHoldingRows}
          onClose={() => setHoldingComparisonOpen(false)}
          onOpenHolding={onOpenHolding}
        />
      )}
    </div>
  );
}
