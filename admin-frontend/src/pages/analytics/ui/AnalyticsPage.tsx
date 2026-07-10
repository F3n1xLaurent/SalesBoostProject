import React, { useEffect, useState } from 'react';
import type { PlatformSummary } from '../../../shared/model/adminPanel';
import { fetchAnalyticsOverview, fetchHoldings, type AnalyticsOverview, type HoldingItem, type TimeSeriesPoint } from '../../../shared/api/adminPanel';
import { ratingClass, exportPageToPdf } from '../../../shared/lib/admin-panel/utils';
import type { AnalyticsImpact, AnalyticsPriority, AnalyticsSectionInsight } from '../../../shared/api/adminPanel';
import { AISummaryBlock } from '../../../shared/ui/ai-summary-block/AISummaryBlock';
import { ComparisonAISummary } from '../../../shared/ui/comparison-ai-summary/ComparisonAISummary';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { FixedOverlayPortal } from '../../../shared/ui/fixed-overlay-portal/FixedOverlayPortal';

type AnalyticsProps = {
  summary: PlatformSummary | null;
  timeSeries?: TimeSeriesPoint[];
  loading?: boolean;
  onDrill?: (type: 'employees' | 'dealership' | 'audits', filter?: string) => void;
};

/* ────────────────────── Small reusable sub-components ────────────────────── */

const IMPACT_ICON: Record<AnalyticsImpact, { icon: string; cls: string }> = {
  high: { icon: '🔴', cls: 'sa-impact-high' },
  medium: { icon: '🟡', cls: 'sa-impact-medium' },
  low: { icon: '🟢', cls: 'sa-impact-low' },
};

const PRIORITY_CLS: Record<AnalyticsPriority, string> = {
  P0: 'sa-priority-p0',
  P1: 'sa-priority-p1',
  P2: 'sa-priority-p2',
};

const EMPTY_ANALYTICS: AnalyticsOverview = {
  aiSummary: {
    summary: 'Пока нет привязанных звонков для устойчивой аналитики.',
    recommendations: ['Запустите плановый обзвон или привяжите существующие звонки к салонам.'],
    source: 'fallback',
  },
  keyInsights: [],
  actions: [],
  errorsInsight: { fact: 'Нет привязанных звонков', interpretation: 'Аналитика появится после плановых или размеченных звонков', action: '', stable: true },
  commInsight: { fact: 'Нет данных по коммуникации', interpretation: 'Нет оценённых привязанных звонков', action: '', stable: true },
  scriptInsight: { fact: 'Нет измерений', interpretation: 'Нет оценённых привязанных звонков', action: '', stable: true },
  trendInsight: { fact: 'Нет динамики', interpretation: 'Нет привязанных звонков по точкам', action: '', stable: true },
  avgScore: 0,
  totalAudits: 0,
  failRate: 0,
  commBreakdown: [],
  topErrors: [],
  dealershipComparison: [],
  dealershipRows: [],
  holdingRows: [],
  weeklyTypeTrend: [],
  scriptCompliance: [],
};

type ComparableDealership = NonNullable<AnalyticsOverview['dealershipRows']>[number];

function InsightMini({ insight }: { insight: AnalyticsSectionInsight }) {
  return (
    <div className={`sa-insight-mini ${insight.stable ? 'sa-insight-stable' : ''}`}>
      <div className="sa-insight-mini-fact">{insight.fact}</div>
      <div className="sa-insight-mini-interp">{insight.interpretation}</div>
      {insight.action && !insight.stable && (
        <div className="sa-insight-mini-action">→ {insight.action}</div>
      )}
    </div>
  );
}

/* ────────────────────── Horizontal bar chart for errors ────────────────────── */

function ErrorsChart({ data }: { data: { error: string; count: number; percent: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (data.length === 0) return <div className="sa-chart-empty">Нет данных</div>;

  function barColor(pct: number) {
    if (pct >= 30) return '#F87171';
    if (pct >= 15) return '#FBBF24';
    return '#6366F1';
  }

  return (
    <div className="sa-hbar-list">
      {data.map((d, i) => (
        <div
          key={d.error}
          className={`sa-hbar-row ${hoverIdx === i ? 'sa-hbar-row-hover' : ''}`}
          onMouseEnter={() => setHoverIdx(i)}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <span className="sa-hbar-label">{d.error}</span>
          <div className="sa-hbar-track">
            <div className="sa-hbar-fill" style={{ width: `${d.percent}%`, background: barColor(d.percent) }} />
          </div>
          <span className="sa-hbar-score" style={{ color: 'var(--sa-text)' }}>{d.percent}%</span>
          {hoverIdx === i && (
            <div className="sa-hbar-tooltip">{d.count} сотрудников</div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────── Script compliance bars ────────────────────── */

function ScriptChart({ data }: { data: { block: string; rate: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  function barColor(rate: number) {
    if (rate >= 80) return '#34D399';
    if (rate >= 60) return '#FBBF24';
    return '#F87171';
  }

  return (
    <div className="sa-hbar-list">
      {data.map((d, i) => (
        <div
          key={d.block}
          className={`sa-hbar-row ${hoverIdx === i ? 'sa-hbar-row-hover' : ''}`}
          onMouseEnter={() => setHoverIdx(i)}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <span className="sa-hbar-label">{d.block}</span>
          <div className="sa-hbar-track">
            <div className="sa-hbar-fill" style={{ width: `${d.rate}%`, background: barColor(d.rate) }} />
          </div>
          <span className={`sa-hbar-score ${ratingClass(d.rate)}`}>{d.rate}%</span>
        </div>
      ))}
    </div>
  );
}

function WeeklyTypeTrendChart({ data }: { data: NonNullable<AnalyticsOverview['weeklyTypeTrend']> }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!data || data.length === 0) return <div className="sa-chart-empty">Нет данных</div>;

  const W = 760, H = 260;
  const pad = { top: 20, right: 24, bottom: 42, left: 44 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const step = data.length <= 1 ? 0 : cw / (data.length - 1);
  const xs = data.map((_, i) => pad.left + i * step);
  const y = (score: number) => pad.top + ch - (Math.max(0, Math.min(score, 100)) / 100) * ch;
  const path = (key: 'ownScore' | 'franchiseScore') => data
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${y(point[key])}`)
    .join(' ');

  return (
    <div className="sa-chart-wrap">
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="sa-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: '#6366F1', display: 'inline-block' }} />
          Собственные
        </span>
        <span className="sa-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: '#F59E0B', display: 'inline-block' }} />
          Франшиза
        </span>
      </div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setHoverIdx(null)}>
        {[0, 25, 50, 75, 100].map((value) => {
          const gy = y(value);
          return (
            <g key={value}>
              <line x1={pad.left} y1={gy} x2={pad.left + cw} y2={gy} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
              <text x={pad.left - 8} y={gy + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">{value}</text>
            </g>
          );
        })}
        {data.map((point, i) => (
          <text key={point.week} x={xs[i]} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">{point.week.slice(5)}</text>
        ))}
        <path d={path('ownScore')} fill="none" stroke="#6366F1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d={path('franchiseScore')} fill="none" stroke="#F59E0B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {data.map((_, i) => (
          <rect key={`hit-${i}`} x={xs[i] - step / 2} y={pad.top} width={step || 44} height={ch} fill="transparent" onMouseEnter={() => setHoverIdx(i)} />
        ))}
        {hoverIdx !== null && (() => {
          const point = data[hoverIdx];
          const tw = 190, th = 76;
          const tx = Math.min(Math.max(xs[hoverIdx] - tw / 2, 4), W - tw - 4);
          const ty = Math.max(4, y(Math.max(point.ownScore, point.franchiseScore)) - th - 12);
          return (
            <g>
              <line x1={xs[hoverIdx]} y1={pad.top} x2={xs[hoverIdx]} y2={pad.top + ch} stroke="var(--sa-text-secondary)" strokeWidth="1" strokeDasharray="3" opacity="0.35" />
              <rect x={tx} y={ty} width={tw} height={th} rx="8" fill="#1F2937" opacity="0.92" />
              <text x={tx + 12} y={ty + 18} fontSize="11" fill="#D1D5DB">Неделя: {point.week}</text>
              <text x={tx + 12} y={ty + 38} fontSize="11" fill="#F9FAFB">Собственные: {point.ownScore} ({point.ownCount})</text>
              <text x={tx + 12} y={ty + 58} fontSize="11" fill="#F9FAFB">Франшиза: {point.franchiseScore} ({point.franchiseCount})</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

/* ────────────────────── Dealership comparison bars ────────────────────── */

function DealershipBars({ data, onOpen }: { data: { id?: string; name: string; score: number; delta: number }[]; onOpen?: (id: string) => void }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  function barColor(s: number) {
    if (s >= 80) return '#34D399';
    if (s >= 50) return '#FBBF24';
    return '#F87171';
  }

  return (
    <div className="sa-hbar-list">
      {data.map((d, i) => (
        <div
          key={d.id ?? d.name}
          className={`sa-hbar-row ${hoverIdx === i ? 'sa-hbar-row-hover' : ''}`}
          role={d.id ? 'button' : undefined}
          tabIndex={d.id ? 0 : undefined}
          onMouseEnter={() => setHoverIdx(i)}
          onMouseLeave={() => setHoverIdx(null)}
          onClick={() => d.id && onOpen?.(d.id)}
          onKeyDown={(event) => {
            if (!d.id) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen?.(d.id);
            }
          }}
          style={d.id ? { cursor: 'pointer' } : undefined}
        >
          <span className="sa-hbar-label">{d.name}</span>
          <div className="sa-hbar-track">
            <div className="sa-hbar-fill" style={{ width: `${d.score}%`, background: barColor(d.score) }} />
          </div>
          <span className={`sa-hbar-score ${ratingClass(d.score)}`}>{d.score}</span>
          {hoverIdx === i && (
            <div className="sa-hbar-tooltip">
              Динамика: {d.delta > 0 ? '+' : ''}{d.delta}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────── Communication donut (simple HTML) ────────────────────── */

function CommBreakdown({ data }: { data: { label: string; percent: number; color: string }[] }) {
  return (
    <div className="sa-comm-grid">
      {data.filter((d) => d.percent > 0).map((d) => (
        <div key={d.label} className="sa-comm-stat">
          <div className="sa-comm-stat-bar" style={{ background: d.color, width: `${Math.max(d.percent, 4)}%` }} />
          <div className="sa-comm-stat-info">
            <span className="sa-comm-stat-label">{d.label}</span>
            <span className="sa-comm-stat-pct" style={{ color: d.color }}>{d.percent}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ComparisonModal({ rows, onClose, onOpenDealership }: { rows: ComparableDealership[]; onClose: () => void; onOpenDealership: (id: string) => void }) {
  if (rows.length < 2) return null;
  const bestScore = Math.max(...rows.map((row) => row.score));
  const worstScore = Math.min(...rows.map((row) => row.score));
  const bestDelta = Math.max(...rows.map((row) => row.delta));
  const worstDelta = Math.min(...rows.map((row) => row.delta));
  const bestCalls = Math.max(...rows.map((row) => row.calls));
  const worstCalls = Math.min(...rows.map((row) => row.calls));
  const bestNoAnswers = Math.min(...rows.map((row) => row.noAnswers));
  const worstNoAnswers = Math.max(...rows.map((row) => row.noAnswers));
  const leader = [...rows].sort((a, b) => b.score - a.score)[0];
  const lagger = [...rows].sort((a, b) => a.score - b.score)[0];
  const metrics = [
    { key: 'score' as const, label: 'Балл', best: bestScore, worst: worstScore },
    { key: 'delta' as const, label: 'Динамика', best: bestDelta, worst: worstDelta },
    { key: 'calls' as const, label: 'Звонков', best: bestCalls, worst: worstCalls },
    { key: 'noAnswers' as const, label: 'Недозвоны', best: bestNoAnswers, worst: worstNoAnswers },
  ];

  return (
    <FixedOverlayPortal>
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(15,23,42,.42)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div className="sa-card" style={{ width: 'min(980px, 100%)', maxHeight: '86vh', overflow: 'auto' }}>
        <div className="sa-section-header-row" style={{ marginBottom: 16 }}>
          <div>
            <h2 className="sa-section-title" style={{ marginBottom: 4 }}>Сравнение точек</h2>
            <div className="sa-meta">Выбрано: {rows.length}</div>
          </div>
          <button className="sa-btn-outline" onClick={onClose}>Закрыть</button>
        </div>
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Метрика</th>
                {rows.map((row) => (
                  <th key={row.id} className="sa-text-right">
                    <button className="sa-btn-text sa-btn-sm" onClick={() => onOpenDealership(row.id)}>{row.name}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.key}>
                  <td>{metric.label}</td>
                  {rows.map((row) => {
                    const value = Number(row[metric.key] ?? 0);
                    const best = value === metric.best;
                    const worst = value === metric.worst && metric.best !== metric.worst;
                    return (
                      <td key={row.id} className="sa-text-right">
                        <span className={best ? 'sa-score-green' : worst ? 'sa-score-red' : ''}>
                          {metric.key === 'delta' && value > 0 ? '+' : ''}{value}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 16 }}>
          <ComparisonAISummary level="dealerships" items={rows.map((row) => ({ ...row }))} />
        </div>
        <div className="sa-card" style={{ marginTop: 16 }}>
          <h3 className="sa-card-heading">Анализ различий</h3>
          <p className="sa-meta" style={{ lineHeight: 1.6 }}>
            Лидер сравнения — <button className="sa-btn-text sa-btn-sm" onClick={() => onOpenDealership(leader.id)}>{leader.name}</button> с баллом {leader.score}.
            {' '}Самая слабая точка — <button className="sa-btn-text sa-btn-sm" onClick={() => onOpenDealership(lagger.id)}>{lagger.name}</button> с баллом {lagger.score}.
            {' '}Разницу стоит разбирать через историю звонков и частые NO-блоки: слабым точкам нужны точечные тренировки по провальным этапам.
          </p>
        </div>
      </div>
    </div>
    </FixedOverlayPortal>
  );
}

/* ════════════════════ Main component ════════════════════ */

export function Analytics({ summary, timeSeries = [], loading = false, onDrill }: AnalyticsProps) {
  const [data, setData] = useState<AnalyticsOverview>(EMPTY_ANALYTICS);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState(false);
  const [selectedDealershipIds, setSelectedDealershipIds] = useState<string[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);

  useEffect(() => {
    let cancelled = false;
    setHoldingsLoading(true);
    fetchHoldings({ status: 'active' })
      .then((items) => {
        if (!cancelled) setHoldings(items);
      })
      .catch(() => {
        if (!cancelled) setHoldings([]);
      })
      .finally(() => {
        if (!cancelled) setHoldingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSelectedDealershipIds([]);
  }, [selectedHoldingId]);

  useEffect(() => {
    if (holdingsLoading) return;
    if (!selectedHoldingId) {
      setData(EMPTY_ANALYTICS);
      setAnalyticsError(false);
      setAnalyticsLoading(false);
      return;
    }
    let cancelled = false;
    setAnalyticsLoading(true);
    setAnalyticsError(false);
    fetchAnalyticsOverview({ holdingId: selectedHoldingId })
      .then((overview) => {
        if (cancelled) return;
        setData(overview ?? EMPTY_ANALYTICS);
      })
      .catch(() => {
        if (cancelled) return;
        setData(EMPTY_ANALYTICS);
        setAnalyticsError(true);
      })
      .finally(() => {
        if (!cancelled) setAnalyticsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [holdingsLoading, selectedHoldingId]);
  const isLoading = loading || holdingsLoading || analyticsLoading;
  const dealershipRows = data.dealershipRows ?? [];
  const selectedRows = dealershipRows.filter((row) => selectedDealershipIds.includes(row.id));
  const toggleDealership = (id: string) => {
    setSelectedDealershipIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 6 }}>Аналитика</h1>
          <p className="sa-page-subtitle" style={{ marginBottom: 0 }}>Анализ данных за выбранный период</p>
        </div>
        <select
          className="sa-select"
          value={selectedHoldingId}
          onChange={(event) => setSelectedHoldingId(event.target.value)}
          style={{ minWidth: 220 }}
          disabled={holdingsLoading || holdings.length === 0}
          title="Глобальный фильтр по компаниям"
        >
          {holdings.length === 0 ? <option value="">Нет компаний</option> : null}
          {holdings.map((holding) => (
            <option key={holding.id} value={holding.id}>{holding.name}</option>
          ))}
        </select>
      </div>

      {/* ═══════════════ 1) AI SUMMARY & ACTION PLAN ═══════════════ */}
      <div className="sa-card sa-analytics-summary">
        {/* ── Header ── */}
        <div className="sa-analytics-summary-header">
          <div className="sa-analytics-summary-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </div>
          <div>
            <h2 className="sa-analytics-summary-title">AI Summary</h2>
            <p className="sa-meta" style={{ marginTop: 0 }}>
              Автоматический анализ на основе {data.totalAudits} привязанных звонков
              {data.meta?.ignoredUnlinkedCalls ? ` · не учтено без привязок: ${data.meta.ignoredUnlinkedCalls}` : ''}
            </p>
          </div>
          <div className="sa-analytics-summary-kpis">
            <div className="sa-summary-kpi">
              <span className="sa-summary-kpi-label">Средний балл</span>
              <span className={`sa-summary-kpi-value ${ratingClass(data.avgScore)}`}>{data.avgScore}</span>
            </div>
            <div className="sa-summary-kpi">
              <span className="sa-summary-kpi-label">Провалы</span>
              <span className={`sa-summary-kpi-value ${data.failRate > 10 ? 'sa-score-red' : data.failRate > 5 ? 'sa-score-orange' : 'sa-score-green'}`}>{data.failRate}%</span>
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 22 }}>
          <AISummaryBlock
            title="AI-сводка по сети"
            summary={data.aiSummary}
            loading={isLoading}
            error={analyticsError ? 'Не удалось сформировать AI-сводку. Проверьте доступность backend API.' : null}
          />
        </div>

        {/* ── B) Key insights ── */}
        <div className="sa-key-insights">
          {analyticsError && (
            <div className="sa-key-insight">
              <div className="sa-key-insight-body">
                <div className="sa-key-insight-fact">Не удалось загрузить аналитику</div>
                <div className="sa-key-insight-interp">Проверьте доступность backend API.</div>
              </div>
            </div>
          )}
          {!analyticsError && data.keyInsights.length === 0 && (
            <div className="sa-key-insight">
              <div className="sa-key-insight-body">
                <div className="sa-key-insight-fact">Пока нет привязанных звонков</div>
                <div className="sa-key-insight-interp">Звонки без салона/менеджера/плана не попадают в управленческую аналитику.</div>
              </div>
            </div>
          )}
          {data.keyInsights.map((ins, i) => (
            <div key={i} className="sa-key-insight">
              <span className={`sa-impact-dot ${IMPACT_ICON[ins.impact].cls}`} title={`Влияние: ${ins.impact}`}>{IMPACT_ICON[ins.impact].icon}</span>
              <div className="sa-key-insight-body">
                <div className="sa-key-insight-fact">
                  {ins.fact}
                  {ins.delta && <span className="sa-key-insight-delta">{ins.delta}</span>}
                </div>
                <div className="sa-key-insight-interp">{ins.interpretation}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── C) Action block ── */}
        <div className="sa-action-block">
          <h3 className="sa-action-block-title">Рекомендуемые действия</h3>
          <div className="sa-action-list">
            {data.actions.map((act, i) => (
              <div key={i} className="sa-action-card">
                <div className="sa-action-card-header">
                  <span className={`sa-priority-badge ${PRIORITY_CLS[act.priority]}`}>{act.priority}</span>
                  <span className="sa-action-target">{act.target}</span>
                </div>
                <div className="sa-action-text">{act.action}</div>
                <div className="sa-action-details">
                  <span className="sa-action-reason">Причина: {act.reason}</span>
                  <span className="sa-action-effect">Ожидаемый эффект: {act.expectedEffect}</span>
                </div>
                <div className="sa-action-buttons">
                  {act.drillType === 'employees' && (
                    <button className="sa-btn-text sa-btn-sm" onClick={() => onDrill?.('employees', act.drillFilter)}>Открыть сотрудников →</button>
                  )}
                  {act.drillType === 'dealership' && (
                    <button className="sa-btn-text sa-btn-sm" onClick={() => onDrill?.('dealership', act.drillFilter)}>Открыть точку →</button>
                  )}
                  {act.drillType === 'audits' && (
                    <button className="sa-btn-text sa-btn-sm" onClick={() => onDrill?.('audits', act.drillFilter)}>Открыть проверки →</button>
                  )}
                  <button className="sa-btn-outline sa-btn-sm" onClick={() => exportPageToPdf('Аналитика_отчет')}>Экспорт отчёт</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══════════════ 2) ANALYTICAL SECTIONS ═══════════════ */}

      <section className="sa-section" style={{ marginTop: 28, marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Дилеры / компании</h2>
          <div className="sa-meta">Агрегация по точкам компании</div>
        </div>
        <div className="sa-card">
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Компания</th>
                  <th>Тип</th>
                  <th className="sa-text-right">Точек</th>
                  <th className="sa-text-right">Балл</th>
                  <th className="sa-text-right">Звонков</th>
                  <th className="sa-text-right">Недозвоны</th>
                  <th className="sa-text-right">Ниже 50</th>
                </tr>
              </thead>
              <tbody>
                {(data.holdingRows ?? []).length === 0 ? (
                  <tr><td colSpan={7} className="sa-meta" style={{ padding: 24 }}>Нет компаний с привязанными точками</td></tr>
                ) : (
                  (data.holdingRows ?? []).map((row) => (
                    <tr key={row.id}>
                      <td style={{ fontWeight: 600 }}>{row.name}</td>
                      <td>{row.type === 'franchised' ? 'Франшиза' : 'Собственная'}</td>
                      <td className="sa-text-right">{row.dealershipsCount}</td>
                      <td className="sa-text-right"><span className={ratingClass(row.score)}>{row.score}</span></td>
                      <td className="sa-text-right">{row.calls}</td>
                      <td className="sa-text-right">{row.noAnswers}</td>
                      <td className="sa-text-right">{row.lowDealerships}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Динамика сети: собственные vs франшиза</h2>
          <div className="sa-meta">12 недель по оценённым привязанным звонкам</div>
        </div>
        <div className="sa-card">
          <WeeklyTypeTrendChart data={data.weeklyTypeTrend ?? []} />
        </div>
      </section>

      {/* ── Dealership comparison ── */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Динамика по точкам</h2>
          <InsightMini insight={data.trendInsight} />
        </div>
        <div className="sa-card">
          <DealershipBars data={data.dealershipComparison} onOpen={(id) => onDrill?.('dealership', id)} />
        </div>
        <div className="sa-card" style={{ marginTop: 16 }}>
          <div className="sa-section-header-row" style={{ marginBottom: 12 }}>
            <h3 className="sa-card-heading" style={{ marginBottom: 0 }}>Таблица точек</h3>
            <div className="sa-meta">Выберите 2-6 точек для сравнения</div>
          </div>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th style={{ width: 44 }} />
                  <th>Точка</th>
                  <th>Дилер</th>
                  <th>Тип</th>
                  <th className="sa-text-right">Балл</th>
                  <th className="sa-text-right">Динамика</th>
                  <th className="sa-text-right">Звонков</th>
                  <th className="sa-text-right">Недозвоны</th>
                </tr>
              </thead>
              <tbody>
                {dealershipRows.length === 0 ? (
                  <tr><td colSpan={8} className="sa-meta" style={{ padding: 24 }}>Нет привязанных точек для аналитики</td></tr>
                ) : (
                  dealershipRows.map((row) => (
                    <tr key={row.id} className="sa-row-clickable" onClick={() => onDrill?.('dealership', row.id)}>
                      <td onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedDealershipIds.includes(row.id)}
                          disabled={!selectedDealershipIds.includes(row.id) && selectedDealershipIds.length >= 6}
                          onChange={() => toggleDealership(row.id)}
                        />
                      </td>
                      <td style={{ fontWeight: 600 }}>{row.name}</td>
                      <td>{row.dealer}</td>
                      <td>{row.type === 'franchised' ? 'Франшиза' : 'Собственная'}</td>
                      <td className="sa-text-right"><span className={ratingClass(row.score)}>{row.score}</span></td>
                      <td className="sa-text-right">{row.delta > 0 ? '+' : ''}{row.delta}</td>
                      <td className="sa-text-right">{row.calls}</td>
                      <td className="sa-text-right">{row.noAnswers}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Top errors ── */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Частые ошибки — Топ 10</h2>
          <InsightMini insight={data.errorsInsight} />
        </div>
        <div className="sa-card">
          {isLoading ? (
            <div className="sa-meta" style={{ padding: 24 }}>Загрузка…</div>
          ) : (
            <ErrorsChart data={data.topErrors} />
          )}
        </div>
      </section>

      {/* ── Script compliance ── */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Соблюдение скрипта</h2>
          <InsightMini insight={data.scriptInsight} />
        </div>
        <div className="sa-card">
          <ScriptChart data={data.scriptCompliance} />
        </div>
      </section>

      {/* ── Communication quality ── */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Качество коммуникации</h2>
          <InsightMini insight={data.commInsight} />
        </div>
        <div className="sa-card">
          <CommBreakdown data={data.commBreakdown} />
        </div>
      </section>
      {selectedDealershipIds.length > 0 && (
        <div style={{ position: 'fixed', left: 24, right: 24, bottom: 24, zIndex: 60, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="sa-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', pointerEvents: 'auto', boxShadow: '0 16px 40px rgba(15,23,42,.18)' }}>
            <strong>Выбрано: {selectedDealershipIds.length}</strong>
            <button className="sa-btn-outline" disabled={selectedDealershipIds.length < 2} onClick={() => setComparisonOpen(true)}>Сравнить</button>
            <button className="sa-btn-text" onClick={() => setSelectedDealershipIds([])}>Сбросить</button>
          </div>
        </div>
      )}
      {comparisonOpen && (
        <ComparisonModal
          rows={selectedRows}
          onClose={() => setComparisonOpen(false)}
          onOpenDealership={(id) => onDrill?.('dealership', id)}
        />
      )}
    </>
  );
}
