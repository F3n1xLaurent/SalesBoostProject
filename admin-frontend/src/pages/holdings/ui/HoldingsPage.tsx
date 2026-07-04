import React, { useEffect, useMemo, useState } from 'react';
import {
  createHolding,
  deleteHolding,
  fetchAnalyticsHoldingDetail,
  fetchAnalyticsHoldings,
  fetchDealerships,
  fetchHoldings,
  updateHolding,
  type AnalyticsHoldingDealershipRow,
  type AnalyticsHoldingDetail,
  type AnalyticsHoldingRow,
  type DealershipItem,
  type HoldingItem,
  type HoldingType,
} from '../../../shared/api/adminPanel';
import { ratingClass } from '../../../shared/lib/admin-panel/utils';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { AISummaryBlock } from '../../../shared/ui/ai-summary-block/AISummaryBlock';
import { ComparisonAISummary } from '../../../shared/ui/comparison-ai-summary/ComparisonAISummary';
import { useToast } from '../../../shared/ui/toast/ToastProvider';

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

function overlayCardStyle(width = 760): React.CSSProperties {
  return {
    width: `min(100%, ${width}px)`,
    maxHeight: '88vh',
    overflowY: 'auto',
    background: '#fff',
    borderRadius: 24,
    boxShadow: '0 28px 80px rgba(15,23,42,0.28)',
    padding: 22,
  };
}

function ModalFrame(props: {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}) {
  if (!props.open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.48)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        zIndex: 120,
      }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle(props.width)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{props.title}</h2>
            {props.subtitle && (
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>{props.subtitle}</div>
            )}
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

function KpiCard({ label, value, suffix, cls }: { label: string; value: React.ReactNode; suffix?: string; cls?: string }) {
  return (
    <div className="sa-card sa-kpi-card">
      <div className="sa-kpi-label">{label}</div>
      <div className={`sa-kpi-value sa-kpi-value-large ${cls ?? ''}`}>{value}{suffix ?? ''}</div>
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(15,23,42,.42)', display: 'grid', placeItems: 'center', padding: 20 }} onClick={onClose}>
      <div className="sa-card" style={{ width: 'min(980px, 100%)', maxHeight: '86vh', overflow: 'auto' }} onClick={(event) => event.stopPropagation()}>
        <div className="sa-section-header-row" style={{ marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0 }}>Сравнение салонов дилера</h3>
            <div className="sa-meta">{rows.length} выбранных точек</div>
          </div>
          <button type="button" className="sa-btn-outline" onClick={onClose}>Закрыть</button>
        </div>

        <div className="sa-kpi-grid" style={{ marginBottom: 18 }}>
          <KpiCard label="Лидер" value={leader.name} cls={ratingClass(leader.score)} />
          <KpiCard label="Нужна фокусировка" value={lagger.name} cls={ratingClass(lagger.score)} />
          <KpiCard label="Макс. звонков" value={bestCalls} />
          <KpiCard label="Макс. недозвонов" value={worstNoAnswers} />
        </div>

        <div className="sa-companies-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Салон</th>
                <th>Город</th>
                <th className="sa-text-right">Балл</th>
                <th className="sa-text-right">Динамика</th>
                <th className="sa-text-right">Звонки</th>
                <th className="sa-text-right">Недозвоны</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
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
                  <td className={`sa-text-right ${ratingClass(row.score)}`}>{row.score}</td>
                  <td className={`sa-text-right ${row.delta >= 0 ? 'sa-score-green' : 'sa-score-red'}`}>{row.delta > 0 ? '+' : ''}{row.delta}</td>
                  <td className="sa-text-right">{row.calls}</td>
                  <td className="sa-text-right">{row.noAnswers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 16 }}>
          <ComparisonAISummary level="holding-dealerships" items={rows.map((row) => ({ ...row }))} />
        </div>
      </div>
    </div>
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
  if (rows.length < 2) return null;
  const metrics = [
    { key: 'avgScore' as const, label: 'Средний балл', higherBetter: true },
    { key: 'dealershipsCount' as const, label: 'Салоны', higherBetter: true },
    { key: 'calls' as const, label: 'Звонки', higherBetter: true },
    { key: 'noAnswers' as const, label: 'Недозвоны', higherBetter: false },
    { key: 'lowDealerships' as const, label: 'Салонов ниже 50', higherBetter: false },
  ];
  const leader = [...rows].sort((a, b) => b.avgScore - a.avgScore)[0];
  const lagger = [...rows].sort((a, b) => a.avgScore - b.avgScore)[0];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(15,23,42,.42)', display: 'grid', placeItems: 'center', padding: 20 }} onClick={onClose}>
      <div className="sa-card" style={{ width: 'min(1040px, 100%)', maxHeight: '86vh', overflow: 'auto' }} onClick={(event) => event.stopPropagation()}>
        <div className="sa-section-header-row" style={{ marginBottom: 16 }}>
          <div>
            <h2 className="sa-section-title" style={{ marginBottom: 4 }}>Сравнение дилеров</h2>
            <div className="sa-meta">Выбрано: {rows.length}</div>
          </div>
          <button type="button" className="sa-btn-outline" onClick={onClose}>Закрыть</button>
        </div>
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Метрика</th>
                {rows.map((row) => (
                  <th key={row.id} className="sa-text-right">
                    <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenHolding?.(row.id)}>{row.name}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => {
                const values = rows.map((row) => Number(row[metric.key] ?? 0));
                const best = metric.higherBetter ? Math.max(...values) : Math.min(...values);
                const worst = metric.higherBetter ? Math.min(...values) : Math.max(...values);
                return (
                  <tr key={metric.key}>
                    <td>{metric.label}</td>
                    {rows.map((row) => {
                      const value = Number(row[metric.key] ?? 0);
                      const isBest = value === best;
                      const isWorst = value === worst && best !== worst;
                      return (
                        <td key={row.id} className="sa-text-right">
                          <span className={isBest ? 'sa-score-green' : isWorst ? 'sa-score-red' : ''}>{value}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr>
                <td>Топ-проблема</td>
                {rows.map((row) => (
                  <td key={row.id} className="sa-text-right">{row.topProblem ?? '—'}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 16 }}>
          <ComparisonAISummary level="holdings-directory" items={rows.map((row) => ({ ...row }))} />
        </div>
        <div className="sa-card" style={{ marginTop: 16 }}>
          <h3 className="sa-card-heading">Анализ различий</h3>
          <p className="sa-meta" style={{ lineHeight: 1.6 }}>
            Лидер по среднему баллу — <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenHolding?.(leader.id)}>{leader.name}</button>.
            {' '}Самый слабый показатель — <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenHolding?.(lagger.id)}>{lagger.name}</button>.
            {' '}Разницу стоит проверять через салоны дилера, недозвоны и повторяющиеся NO-блоки.
          </p>
        </div>
      </div>
    </div>
  );
}

function HoldingAnalyticsDetail({
  holdingId,
  onBack,
  onOpenDealership,
}: {
  holdingId: string;
  onBack?: () => void;
  onOpenDealership?: (id: string) => void;
}) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<AnalyticsHoldingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelectedIds([]);
    fetchAnalyticsHoldingDetail(holdingId)
      .then((item) => {
        if (!cancelled) setDetail(item);
      })
      .catch((error) => {
        if (cancelled) return;
        showToast({
          type: 'error',
          title: 'Не удалось загрузить аналитику дилера',
          description: error instanceof Error ? error.message : 'Попробуйте повторить действие.',
        });
        setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [holdingId, showToast]);

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

  if (loading) {
    return <div className="sa-meta" style={{ padding: 32 }}>Загрузка аналитики дилера...</div>;
  }

  if (!detail) {
    return (
      <div className="sa-detail-root">
        <button type="button" className="sa-btn-outline" onClick={onBack}>Назад</button>
        <div className="sa-card" style={{ padding: 20 }}>Дилер не найден или по нему пока нет данных.</div>
      </div>
    );
  }

  return (
    <div className="sa-detail-root">
      <div className="sa-detail-header">
        <div>
          <button type="button" className="sa-btn-outline" onClick={onBack}>← Назад к компаниям</button>
          <h1 className="sa-page-title" style={{ marginTop: 16 }}>{detail.name}</h1>
          <p className="sa-page-subtitle">
            Аналитика дилера по привязанным салонам и звонкам. Непривязанные звонки в расчёт не входят.
          </p>
        </div>
        <div className="sa-detail-header-right">
          <span className="sa-chip">{detail.type === 'own' ? 'Собственный дилер' : 'Франчайзинговый дилер'}</span>
          <span className="sa-chip">Оценённых: {detail.meta?.scoredCalls ?? 0}</span>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <AISummaryBlock title="AI-сводка по дилеру" summary={detail.aiSummary} loading={loading} />
      </div>

      <div className="sa-kpi-grid" style={{ marginBottom: 28 }}>
        <KpiCard label="Средний балл" value={detail.avgScore} cls={ratingClass(detail.avgScore)} />
        <KpiCard label="Салоны" value={detail.dealershipsCount} />
        <KpiCard label="Звонки" value={detail.calls} />
        <KpiCard label="Недозвоны" value={detail.noAnswers} />
        <KpiCard label="Салонов ниже 50" value={detail.lowDealerships} cls={detail.lowDealerships > 0 ? 'sa-score-red' : 'sa-score-green'} />
      </div>

      <div className="sa-detail-insights" style={{ marginBottom: 28 }}>
        <div className="sa-card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Проблемные блоки</h3>
          {detail.topIssues.length === 0 ? (
            <div className="sa-meta">Нет выраженных проблем.</div>
          ) : detail.topIssues.slice(0, 5).map((issue) => (
            <div key={issue.issue} className="sa-hbar-row">
              <span className="sa-hbar-label">{issue.issue}</span>
              <div className="sa-hbar-track">
                <div className="sa-hbar-fill" style={{ width: `${issue.percent}%`, background: issue.percent >= 30 ? 'var(--tb-status-red, #B91C1C)' : 'var(--tb-status-orange, #92400E)' }} />
              </div>
              <span className="sa-hbar-score">{issue.percent}%</span>
            </div>
          ))}
        </div>
        <div className="sa-card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Соблюдение скрипта</h3>
          {detail.scriptCompliance.length === 0 ? (
            <div className="sa-meta">Нет рассчитанных блоков скрипта.</div>
          ) : detail.scriptCompliance.slice(0, 5).map((block) => (
            <div key={block.block} className="sa-hbar-row">
              <span className="sa-hbar-label">{block.block}</span>
              <div className="sa-hbar-track">
                <div className="sa-hbar-fill" style={{ width: `${block.rate}%`, background: block.rate >= 80 ? 'var(--tb-status-green, #166534)' : block.rate >= 60 ? 'var(--tb-status-orange, #92400E)' : 'var(--tb-status-red, #B91C1C)' }} />
              </div>
              <span className={`sa-hbar-score ${ratingClass(block.rate)}`}>{block.rate}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="sa-card" style={{ marginBottom: selectedRows.length >= 2 ? 92 : 0 }}>
        <div className="sa-section-header-row" style={{ marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0 }}>Салоны дилера</h3>
            <div className="sa-meta">Выберите от 2 до 6 салонов для сравнения.</div>
          </div>
          <button
            type="button"
            className="sa-btn-outline"
            disabled={selectedRows.length < 2}
            onClick={() => setComparisonOpen(true)}
          >
            Сравнить
          </button>
        </div>
        <div className="sa-companies-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th style={{ width: 44 }} />
                <th>Салон</th>
                <th>Город</th>
                <th className="sa-text-right">Балл</th>
                <th className="sa-text-right">Динамика</th>
                <th className="sa-text-right">Звонки</th>
                <th className="sa-text-right">Недозвоны</th>
                <th className="sa-text-right">Менеджеры</th>
              </tr>
            </thead>
            <tbody>
              {detail.dealershipRows.length === 0 ? (
                <tr><td colSpan={8} className="sa-meta" style={{ padding: 24 }}>У дилера пока нет салонов.</td></tr>
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
                    <div className="sa-cell-city">{row.type === 'own' ? 'Собственный' : 'Франчайзинговый'}</div>
                  </td>
                  <td>{row.city}</td>
                  <td className={`sa-text-right ${ratingClass(row.score)}`}>{row.score}</td>
                  <td className={`sa-text-right ${row.delta >= 0 ? 'sa-score-green' : 'sa-score-red'}`}>{row.delta > 0 ? '+' : ''}{row.delta}</td>
                  <td className="sa-text-right">{row.calls}</td>
                  <td className="sa-text-right">{row.noAnswers}</td>
                  <td className="sa-text-right">{row.employeesCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedRows.length >= 2 && (
        <div style={{ position: 'fixed', left: 280, right: 24, bottom: 24, zIndex: 40, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="sa-card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', boxShadow: '0 18px 45px rgba(15,23,42,.22)', pointerEvents: 'auto' }}>
            <strong>{selectedRows.length} салона выбрано</strong>
            <button type="button" className="sa-btn-outline" onClick={() => setSelectedIds([])}>Сбросить</button>
            <button type="button" className="sa-btn-primary" onClick={() => setComparisonOpen(true)}>Сравнить</button>
          </div>
        </div>
      )}

      {comparisonOpen && (
        <HoldingComparisonModal rows={selectedRows} onClose={() => setComparisonOpen(false)} onOpenDealership={onOpenDealership} />
      )}
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
  const [deleteHoldingOpen, setDeleteHoldingOpen] = useState(false);
  const [holdingDealershipsOpen, setHoldingDealershipsOpen] = useState(false);
  const [attachDealershipOpen, setAttachDealershipOpen] = useState(false);
  const [selectedHoldingIds, setSelectedHoldingIds] = useState<string[]>([]);
  const [holdingComparisonOpen, setHoldingComparisonOpen] = useState(false);

  const [holdingForm, setHoldingForm] = useState<HoldingFormState>(EMPTY_HOLDING_FORM);
  const [initialHoldingForm, setInitialHoldingForm] = useState<HoldingFormState>(EMPTY_HOLDING_FORM);
  const [savingHolding, setSavingHolding] = useState(false);
  const [activeHolding, setActiveHolding] = useState<HoldingItem | null>(null);
  const [attachDealershipSearch, setAttachDealershipSearch] = useState('');

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
    setCreateHoldingOpen(true);
  }

  function openEditHolding(item: HoldingItem) {
    const nextForm = buildHoldingForm(item);
    setActiveHolding(item);
    setHoldingForm(nextForm);
    setInitialHoldingForm(nextForm);
    setEditHoldingOpen(true);
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

  const filteredAttachDealerships = useMemo(() => {
    const query = attachDealershipSearch.trim().toLowerCase();
    const items = unassignedDealerships.filter((item) => {
      if (!query) return true;
      const haystack = [item.name, item.city || '', item.address || '', item.code || ''].join(' ').toLowerCase();
      return haystack.includes(query);
    });
    return items.slice(0, 5);
  }, [attachDealershipSearch, unassignedDealerships]);

  async function handleEditHoldingSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!activeHolding) return;
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
      showToast({ type: 'success', title: 'Компания сохранена', description: holdingForm.name });
      await loadData();
    } catch (submitError) {
      showToast({
        type: 'error',
        title: 'Не удалось обновить компанию',
        description: submitError instanceof Error ? submitError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSavingHolding(false);
    }
  }

  async function handleDeleteHoldingConfirm() {
    if (!activeHolding) return;
    setSavingHolding(true);
    try {
      await deleteHolding(activeHolding.id);
      setDeleteHoldingOpen(false);
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
    const isSubmitDisabled = savingHolding || (!isCreate && !isDirty);

    return (
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 16 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Название</span>
          <input className="sa-input" value={holdingForm.name} onChange={(event) => setHoldingForm((current) => ({ ...current, name: event.target.value }))} required />
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
        <fieldset style={{ display: 'grid', gap: 8, border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 4 }}>Тип компании</legend>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={holdingForm.type === 'own' ? 'sa-btn-primary' : 'sa-btn-outline'}
              onClick={() => setHoldingForm((current) => ({ ...current, type: 'own' }))}
            >
              Собственный
            </button>
            <button
              type="button"
              className={holdingForm.type === 'franchised' ? 'sa-btn-primary' : 'sa-btn-outline'}
              onClick={() => setHoldingForm((current) => ({ ...current, type: 'franchised' }))}
            >
              Франчайзинговый
            </button>
          </div>
        </fieldset>
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" className="sa-btn-outline" onClick={() => { setCreateHoldingOpen(false); setEditHoldingOpen(false); }}>Отмена</button>
          <button type="submit" className="sa-btn-primary" disabled={isSubmitDisabled}>
            {savingHolding ? 'Сохраняем...' : submitLabel}
          </button>
        </div>
      </form>
    );
  }

  if (holdingId) {
    return (
      <HoldingAnalyticsDetail
        holdingId={holdingId}
        onBack={onBack}
        onOpenDealership={onOpenDealership}
      />
    );
  }

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

      <div className="sa-toolbar sa-toolbar-split">
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
          <select className="sa-select" value={holdingTypeFilter} onChange={(event) => setHoldingTypeFilter(event.target.value as 'all' | HoldingType)}>
            <option value="all">Тип: все</option>
            <option value="own">Собственный</option>
            <option value="franchised">Франчайзинговый</option>
          </select>
          <select className="sa-select" value={holdingStatusFilter} onChange={(event) => setHoldingStatusFilter(event.target.value as 'all' | 'active' | 'inactive')}>
            <option value="all">Статус: все</option>
            <option value="active">Активный</option>
            <option value="inactive">Деактивированный</option>
          </select>
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
          <button type="button" className="sa-btn-primary" onClick={openCreateHolding}>
            <LetsIcon name="add-light" size={16} bold />
            Новая компания
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
              <th>Компания</th>
              <th>Тип</th>
              <th className="sa-text-right">Точки</th>
              <th className="sa-text-right">Балл</th>
              <th className="sa-text-right">Звонки</th>
              <th className="sa-text-right">Недозвоны</th>
              <th className="sa-text-right">Ниже 50</th>
              <th>Статус</th>
              <th className="sa-text-right sa-holdings-actions-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>Загрузка структуры...</td></tr>
            ) : holdings.length === 0 ? (
              <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>По текущим фильтрам компании не найдены.</td></tr>
            ) : (
              holdings.map((item) => {
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
                      <div className="sa-cell-city">{analytics?.topProblem || item.code || 'Код не указан'}</div>
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
                        <button type="button" className="sa-btn-outline sa-btn-icon" onClick={() => openEditHolding(item)} aria-label="Редактировать компанию" title="Редактировать">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                          </svg>
                        </button>
                        <button type="button" className="sa-btn-danger sa-btn-icon" onClick={() => { setActiveHolding(item); setDeleteHoldingOpen(true); }} aria-label="Удалить компанию" title="Удалить">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M19 6l-1 14H6L5 6" />
                            <path d="M10 11v6M14 11v6" />
                          </svg>
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
          holdings.map((item) => {
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
                    <div className="sa-cell-city">{analytics?.topProblem || item.code || 'Код не указан'}</div>
                  </div>
                  <span className={`sa-status-badge ${item.isActive ? 'sa-status-norm' : 'sa-status-no-data'}`}>
                    {item.isActive ? 'Активен' : 'Выключен'}
                  </span>
                </div>
                <div className="sa-mobile-chips">
                  <span className="sa-metric-chip">{item.type === 'own' ? 'Собственный' : 'Франчайзинговый'}</span>
                  <span className="sa-metric-chip">{item.dealershipsCount} точек</span>
                  <span className="sa-metric-chip">Балл: {analytics?.avgScore ?? '—'}</span>
                  <span className="sa-metric-chip">Звонков: {analytics?.calls ?? '—'}</span>
                  <span className="sa-metric-chip">Недозвонов: {analytics?.noAnswers ?? '—'}</span>
                  <span className="sa-metric-chip">Ниже 50: {analytics?.lowDealerships ?? '—'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }} onClick={(event) => event.stopPropagation()}>
                  <button type="button" className="sa-btn-outline" onClick={() => openEditHolding(item)}>Редактировать</button>
                  <button type="button" className="sa-btn-danger" onClick={() => { setActiveHolding(item); setDeleteHoldingOpen(true); }}>Удалить</button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <ModalFrame title="Новая компания" subtitle="Создание компании, к которой после можно привязать точки" open={createHoldingOpen} onClose={() => setCreateHoldingOpen(false)}>
        {renderHoldingForm(handleCreateHoldingSubmit, 'Создать компанию', { mode: 'create' })}
      </ModalFrame>

      <ModalFrame title="Редактировать компанию" subtitle="Можно поменять состав точек внутри компании." open={editHoldingOpen && !!activeHolding} onClose={() => setEditHoldingOpen(false)}>
        {renderHoldingForm(handleEditHoldingSubmit, 'Сохранить компанию', { mode: 'edit' })}
      </ModalFrame>

      <ModalFrame title={activeHolding ? `Точки компании ${activeHolding.name}` : 'Точки компании'} open={holdingDealershipsOpen && !!activeHolding} onClose={() => setHoldingDealershipsOpen(false)}>
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

      <ModalFrame title={activeHolding ? `Привязать точки к ${activeHolding.name}` : 'Привязать точки'} open={attachDealershipOpen && !!activeHolding} onClose={() => setAttachDealershipOpen(false)}>
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

      <ModalFrame title="Удалить компанию" subtitle="Точки сохранятся и станут независимыми." open={deleteHoldingOpen && !!activeHolding} onClose={() => setDeleteHoldingOpen(false)} width={520}>
        {activeHolding && (
          <div style={{ display: 'grid', gap: 16 }}>
            <p style={{ margin: 0 }}>
              Удалить компанию <strong>{activeHolding.name}</strong>?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="sa-btn-outline" onClick={() => setDeleteHoldingOpen(false)}>Отмена</button>
              <button type="button" className="sa-btn-danger" onClick={handleDeleteHoldingConfirm} disabled={savingHolding}>
                {savingHolding ? 'Удаляем...' : 'Удалить'}
              </button>
            </div>
          </div>
        )}
      </ModalFrame>

      {selectedHoldingRows.length > 0 && (
        <div style={{ position: 'fixed', left: 24, right: 24, bottom: 24, zIndex: 60, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="sa-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', pointerEvents: 'auto', boxShadow: '0 16px 40px rgba(15,23,42,.18)' }}>
            <strong>Выбрано: {selectedHoldingRows.length}</strong>
            <button type="button" className="sa-btn-outline" disabled={selectedHoldingRows.length < 2} onClick={() => setHoldingComparisonOpen(true)}>Сравнить</button>
            <button type="button" className="sa-btn-text" onClick={() => setSelectedHoldingIds([])}>Сбросить</button>
          </div>
        </div>
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
