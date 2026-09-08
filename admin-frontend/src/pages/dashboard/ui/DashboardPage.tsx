import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { BrutalCard } from '../../../shared/ui/brutal-card';
import { AnsweredMissedDonut } from '../../../shared/ui/answered-missed-donut';
import { AnswerRateByHour } from '../../../shared/ui/answer-rate-by-hour';
import type { AdminTab } from '../../../entities/session/model/types';
import { buildDealershipPath, buildUserEmployeePath, tabToPath } from '../../../shared/routing/adminRoutes';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import {
  fetchDashboardOverview,
  fetchDealershipDirections,
  fetchHoldings,
  type DashboardOverview,
  type DashboardEmployeeRatingRow,
  type DealershipDirectionItem,
  type HoldingItem,
  type TimeSeriesPoint,
} from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { SingleSelectFilterPicker } from '../../../shared/ui/filter-picker/SingleSelectFilterPicker';

const SECTION_GAP = 10;
type DashboardOwnershipFilter = 'all' | 'own' | 'franchised';
type DashboardDirectionFilter = 'all' | string;
/** Neutral chart ink — trend line, duration bars (not score-colored) */
const TB_CHART_INK = 'var(--tb-ink)';

type DashboardProps = {
  loading: boolean;
};

function scoreColorClass(score: number): 'sa-score-green' | 'sa-score-orange' | 'sa-score-red' {
  if (score >= 80) return 'sa-score-green';
  if (score >= 50) return 'sa-score-orange';
  return 'sa-score-red';
}

function rateColorClass(rate: number): 'sa-rate-green' | 'sa-rate-orange' | 'sa-rate-red' {
  if (rate >= 80) return 'sa-rate-green';
  if (rate >= 60) return 'sa-rate-orange';
  return 'sa-rate-red';
}

/** Strip common prefix "Точка " from salon names for compact display */
function shortName(name: string): string {
  return name.replace(/^Точка\s+/i, '');
}

function KPICard({
  label,
  value,
  description,
  loading,
  noData,
  valueClass,
  valueSuffix,
  navigateTo,
  onNavigate,
}: {
  label: string;
  value: string | number;
  description?: string;
  loading: boolean;
  noData?: boolean;
  valueClass?: string;
  valueSuffix?: string;
  navigateTo?: AdminTab;
  onNavigate?: (tab: AdminTab) => void;
}) {
  const displayValue = noData ? 'Нет данных' : loading ? '—' : value;
  const isPlaceholder = loading || noData;
  const isInteractive = Boolean(navigateTo && onNavigate);

  const content = (
    <>
      <div className="sa-kpi-card-top">
        <div className="sa-kpi-card-heading">{label}</div>
        {isInteractive && (
          <span className="sa-kpi-card-link-badge" aria-hidden>
            <LetsIcon name="arrow-right-long" size={18} strokeWidth={1.5} />
          </span>
        )}
      </div>
      <div className="sa-kpi-card-spacer" aria-hidden />
      <div className="sa-kpi-card-bottom">
        {valueSuffix && !isPlaceholder ? (
          <div className="sa-kpi-value-row">
            <span className={`sa-kpi-value sa-kpi-value-large ${valueClass ?? ''}`}>{displayValue}</span>
            <span className="sa-kpi-value-suffix">{valueSuffix}</span>
          </div>
        ) : (
          <div className={`sa-kpi-value ${!isPlaceholder ? 'sa-kpi-value-large' : ''} ${valueClass ?? ''}`}>{displayValue}</div>
        )}
        {description && !isPlaceholder && <div className="sa-kpi-desc">{description}</div>}
      </div>
    </>
  );

  if (isInteractive) {
    return (
      <button
        type="button"
        className="sa-card sa-kpi-card sa-kpi-card-air sa-brutal-card sa-kpi-card-interactive"
        onClick={() => onNavigate!(navigateTo!)}
      >
        {content}
      </button>
    );
  }

  return (
    <div className="sa-card sa-kpi-card sa-kpi-card-air sa-brutal-card">
      {content}
    </div>
  );
}

/* ─── Performance Trend Chart ─── */
function PerformanceTrendChart({
  points,
  embedded = false,
  ownershipFilter = 'all',
}: {
  points: TimeSeriesPoint[];
  embedded?: boolean;
  ownershipFilter?: DashboardOwnershipFilter;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className="sa-chart-empty">
        <p>Нет данных за выбранный период</p>
      </div>
    );
  }

  const width = 560;
  const height = 260;
  const padding = { top: 20, right: 10, bottom: 36, left: 36 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const step = points.length <= 1 ? 0 : chartWidth / (points.length - 1);
  const xs = points.map((_, i) => padding.left + i * step);
  const y = (value: number) => padding.top + chartHeight - (Math.max(0, Math.min(100, value)) / 100) * chartHeight;
  const ownPathD = points.map((point, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${y(point.ownScore ?? point.avgScore)}`).join(' ');
  const franchisePathD = points.map((point, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${y(point.franchiseScore ?? point.avgScore)}`).join(' ');
  const hasTypedSeries = points.some((point) => (point.ownCount ?? 0) > 0 || (point.franchiseCount ?? 0) > 0);
  const showOwn = ownershipFilter !== 'franchised';
  const showFranchise = ownershipFilter !== 'own';
  const ownColor = 'var(--tb-status-green)';
  const franchiseColor = 'var(--tb-status-orange)';

  return (
    <div className="sa-chart-wrap">
      {!embedded && <h3 className="sa-chart-title">Динамика эффективности</h3>}
      {(showOwn && showFranchise) && (
        <div className="sa-chart-legend">
          <span><i style={{ background: ownColor }} /> Свои салоны</span>
          <span><i style={{ background: franchiseColor }} /> Салоны франчайзи</span>
        </div>
      )}
      <div className="sa-chart-plot">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="trendFillGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ownColor} stopOpacity="0.12" />
            <stop offset="100%" stopColor={ownColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((v) => {
          const y = padding.top + chartHeight - (v / 100) * chartHeight;
          return (
            <g key={v}>
              <line x1={padding.left} y1={y} x2={padding.left + chartWidth} y2={y} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
              <text x={padding.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">{v}</text>
            </g>
          );
        })}
        {points.map((p, i) => (
          <text key={p.date} x={xs[i]} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">
            {p.date.slice(5)}
          </text>
        ))}
        {hasTypedSeries && showOwn && (
          <path
            d={`${ownPathD} L ${xs[xs.length - 1]} ${padding.top + chartHeight} L ${xs[0]} ${padding.top + chartHeight} Z`}
            fill="url(#trendFillGrad)"
          />
        )}
        {showOwn && (
          <path d={ownPathD} fill="none" stroke={ownColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {showFranchise && (
          <path d={franchisePathD} fill="none" stroke={franchiseColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {points.map((_, i) => (
          <rect
            key={`hit-${i}`}
            x={xs[i] - step / 2}
            y={padding.top}
            width={step || 40}
            height={chartHeight}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(i)}
          />
        ))}
        {hoverIdx !== null && (
          <line x1={xs[hoverIdx]} y1={padding.top} x2={xs[hoverIdx]} y2={padding.top + chartHeight} stroke="var(--sa-text-secondary)" strokeWidth="1" strokeDasharray="3" opacity="0.4" />
        )}
        {points.map((p, i) => {
          const ownScore = p.ownScore ?? p.avgScore;
          const franchiseScore = p.franchiseScore ?? p.avgScore;
          return (
            <React.Fragment key={p.date}>
              {showOwn && (
                <circle
                  cx={xs[i]}
                  cy={y(ownScore)}
                  r={hoverIdx === i ? 5.5 : 4}
                  fill={hoverIdx === i ? '#fff' : ownColor}
                  stroke={ownColor}
                  strokeWidth={hoverIdx === i ? 2.5 : 0}
                  style={{ transition: 'r 0.15s ease, fill 0.15s ease', cursor: 'pointer' }}
                />
              )}
              {showFranchise && (
                <circle
                  cx={xs[i]}
                  cy={y(franchiseScore)}
                  r={hoverIdx === i ? 5.5 : 4}
                  fill={hoverIdx === i ? '#fff' : franchiseColor}
                  stroke={franchiseColor}
                  strokeWidth={hoverIdx === i ? 2.5 : 0}
                  style={{ transition: 'r 0.15s ease, fill 0.15s ease', cursor: 'pointer' }}
                />
              )}
            </React.Fragment>
          );
        })}
      </svg>
      {hoverIdx !== null && (() => {
        const p = points[hoverIdx];
        const tx = xs[hoverIdx];
        const ownScore = p.ownScore ?? p.avgScore;
        const franchiseScore = p.franchiseScore ?? p.avgScore;
        const visibleScores = [
          ...(showOwn ? [ownScore] : []),
          ...(showFranchise ? [franchiseScore] : []),
        ];
        const ty = visibleScores.length ? Math.min(...visibleScores.map((score) => y(score))) : padding.top;
        const leftPct = (tx / width) * 100;
        const topPct = (ty / height) * 100;
        const placeBelow = topPct < 28;
        return (
          <div
            className={`sa-chart-hover-tooltip${placeBelow ? ' sa-chart-hover-tooltip-below' : ''}`}
            style={{ left: `${leftPct}%`, top: `${topPct}%` }}
          >
            <div className="sa-chart-hover-tooltip-row">Дата: {p.date}</div>
            {showOwn && (
              <div className="sa-chart-hover-tooltip-row is-strong">Свои: {ownScore.toFixed(1)} ({p.ownCount ?? p.count})</div>
            )}
            {showFranchise && (
              <div className="sa-chart-hover-tooltip-row is-strong">Франчайзи: {franchiseScore.toFixed(1)} ({p.franchiseCount ?? p.count})</div>
            )}
          </div>
        );
      })()}
      </div>
    </div>
  );
}

/* ─── Salon Table — short names (no "Точка" prefix) ─── */
function SalonTable({
  rows,
  emptyLabel,
  onOpenDealership,
}: {
  rows: { id: string; rank: number; name: string; avgScore: number; answerRate: number; totalAudits: string }[];
  emptyLabel: string;
  onOpenDealership: (id: string) => void;
}) {
  if (rows.length === 0) {
    return <div className="sa-table-empty">{emptyLabel}</div>;
  }
  return (
    <div className="sa-table-wrap sa-table-in-card">
      <table className="sa-table sa-table-colored">
        <thead>
          <tr>
            <th>#</th>
            <th>Точка</th>
            <th>AI-рейтинг</th>
            <th>Дозвон</th>
            <th>Проверки</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="sa-row-clickable"
              role="button"
              tabIndex={0}
              onClick={() => onOpenDealership(r.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpenDealership(r.id);
                }
              }}
            >
              <td>{r.rank}</td>
              <td>{shortName(r.name)}</td>
              <td><span className={scoreColorClass(r.avgScore)}>{r.avgScore.toFixed(1)}</span></td>
              <td><span className={rateColorClass(r.answerRate)}>{r.answerRate}%</span></td>
              <td>{r.totalAudits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeRatingTable({ rows, onOpenEmployee }: { rows: DashboardEmployeeRatingRow[]; onOpenEmployee: (id: string) => void }) {
  if (rows.length === 0) {
    return <div className="sa-table-empty">Нет сотрудников с рейтингом</div>;
  }
  return (
    <div className="sa-table-wrap sa-table-in-card">
      <table className="sa-table sa-table-colored">
        <thead>
          <tr>
            <th>#</th>
            <th>Сотрудник</th>
            <th className="sa-text-right">Проверки</th>
            <th className="sa-text-right">AI-рейтинг</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((employee, index) => (
            <tr
              key={employee.id}
              className="sa-row-clickable"
              role="button"
              tabIndex={0}
              onClick={() => onOpenEmployee(employee.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpenEmployee(employee.id);
                }
              }}
            >
              <td>{index + 1}</td>
              <td>{employee.name}</td>
              <td className="sa-text-right">{employee.auditsCount}</td>
              <td className="sa-text-right">
                <span className={scoreColorClass(employee.aiRating)}>{employee.aiRating.toFixed(1)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Average Answer Time — SVG bar chart with clamped tooltip ─── */
function AverageAnswerTimeChart({ data, embedded = false }: { data: { name: string; avgSec: number; totalCalls: number }[]; embedded?: boolean }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="sa-chart-wrap">
        {!embedded && <h3 className="sa-chart-title">Средняя длительность звонка</h3>}
        <div className="sa-chart-empty">Нет данных за выбранный период</div>
      </div>
    );
  }

  const maxSec = Math.max(...data.map((d) => d.avgSec), 1);
  const svgW = 560;
  const svgH = 260;
  const pad = { top: 24, right: 10, bottom: 48, left: 36 };
  const chartW = svgW - pad.left - pad.right;
  const chartH = svgH - pad.top - pad.bottom;
  const barGap = 10;
  const barW = Math.min(40, (chartW - barGap * (data.length - 1)) / data.length);
  const totalBarsW = data.length * barW + (data.length - 1) * barGap;
  const offsetX = pad.left + (chartW - totalBarsW) / 2;

  const niceMax = Math.ceil(maxSec / 5) * 5;
  const yTicks = [0, Math.round(niceMax / 3), Math.round((niceMax * 2) / 3), niceMax];

  return (
    <div className="sa-chart-wrap">
      {!embedded && <h3 className="sa-chart-title">Средняя длительность звонка</h3>}
      <svg
        width="100%"
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverIdx(null)}
        style={{ overflow: 'visible' }}
      >
        {yTicks.map((v) => {
          const y = pad.top + chartH - (v / niceMax) * chartH;
          return (
            <g key={v}>
              <line x1={pad.left} y1={y} x2={pad.left + chartW} y2={y} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
              <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">{v}с</text>
            </g>
          );
        })}
        <line x1={pad.left} y1={pad.top + chartH} x2={pad.left + chartW} y2={pad.top + chartH} stroke="var(--sa-divider)" strokeWidth="1" />

        {data.map((d, i) => {
          const barH = (d.avgSec / niceMax) * chartH;
          const x = offsetX + i * (barW + barGap);
          const y = pad.top + chartH - barH;
          const isHover = hoverIdx === i;
          const label = shortName(d.name);
          return (
            <g key={d.name} onMouseEnter={() => setHoverIdx(i)}>
              <rect x={x - 4} y={pad.top} width={barW + 8} height={chartH + pad.bottom} fill="transparent" />
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={4}
                fill={TB_CHART_INK}
                opacity={isHover ? 1 : 0.88}
                style={{ transition: 'opacity 0.15s ease, fill 0.15s ease' }}
              />
              {isHover && (
                <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize="11" fill="var(--sa-text)" fontWeight="600">
                  {d.avgSec}с
                </text>
              )}
              <text
                x={x + barW / 2}
                y={pad.top + chartH + 16}
                textAnchor="middle"
                fontSize="9"
                fill="var(--sa-text-secondary)"
              >
                {label.length > 10 ? label.slice(0, 9) + '…' : label}
              </text>

              {isHover && (() => {
                const tooltipW = 160;
                const tooltipH = 56;
                const tooltipX = Math.min(Math.max(x + barW / 2 - tooltipW / 2, 4), svgW - tooltipW - 4);
                const above = y - tooltipH - 14;
                const tooltipY = above >= 0 ? above : y + barH + 10;
                return (
                  <g>
                    <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH} rx="10" fill="var(--tb-ink)" />
                    <text x={tooltipX + 10} y={tooltipY + 16} fontSize="11" fill="#F1F0EC" fontWeight="600">{d.name}</text>
                    <text x={tooltipX + 10} y={tooltipY + 32} fontSize="11" fill="rgba(241, 240, 236, 0.78)">Длительность: {d.avgSec} сек</text>
                    <text x={tooltipX + 10} y={tooltipY + 46} fontSize="11" fill="rgba(241, 240, 236, 0.78)">Звонков: {d.totalCalls}</text>
                  </g>
                );
              })()}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ─── Main Dashboard ─── */
export function Dashboard({ loading }: DashboardProps) {
  const navigate = useNavigate();
  const handleKpiNavigate = (tab: AdminTab) => navigate(tabToPath(tab));
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [directionOptions, setDirectionOptions] = useState<DealershipDirectionItem[]>([]);
  const [directionFilter, setDirectionFilter] = useState<DashboardDirectionFilter>('all');
  const [ownershipFilter, setOwnershipFilter] = useState<DashboardOwnershipFilter>('all');

  const directionSelectOptions = useMemo(
    () => [
      { value: 'all' as const, label: 'Все направления' },
      ...directionOptions.map((direction) => ({ value: direction.id, label: direction.name })),
    ],
    [directionOptions],
  );

  const ownershipSelectOptions = useMemo(
    () => [
      { value: 'all' as const, label: 'Все' },
      { value: 'own' as const, label: 'Свои' },
      { value: 'franchised' as const, label: 'Франшиза' },
    ],
    [],
  );

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
    if (holdingsLoading || !selectedHoldingId) {
      setDirectionOptions([]);
      setDirectionFilter('all');
      return;
    }
    let cancelled = false;
    fetchDealershipDirections({ holdingId: selectedHoldingId, active: true })
      .then((items) => {
        if (cancelled) return;
        setDirectionOptions(items);
        setDirectionFilter((current) => (
          current === 'all' || items.some((item) => item.id === current) ? current : 'all'
        ));
      })
      .catch(() => {
        if (!cancelled) {
          setDirectionOptions([]);
          setDirectionFilter('all');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [holdingsLoading, selectedHoldingId]);

  useEffect(() => {
    setOwnershipFilter('all');
  }, [selectedHoldingId]);

  useEffect(() => {
    if (holdingsLoading) return;
    if (!selectedHoldingId) {
      setOverview(null);
      setDashboardError(null);
      setDashboardLoading(false);
      return;
    }
    let cancelled = false;
    setDashboardLoading(true);
    setDashboardError(null);
    fetchDashboardOverview({
      holdingId: selectedHoldingId,
      directionId: directionFilter === 'all' ? null : directionFilter,
      dealershipType: ownershipFilter === 'all' ? null : ownershipFilter,
    })
      .then((next) => {
        if (!cancelled) setOverview(next);
      })
      .catch(() => {
        if (!cancelled) {
          setOverview(null);
          setDashboardError('Не удалось загрузить данные дашборда.');
        }
      })
      .finally(() => {
        if (!cancelled) setDashboardLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [holdingsLoading, selectedHoldingId, directionFilter, ownershipFilter]);

  const isLoading = loading || holdingsLoading || dashboardLoading;
  const platformAvgScore = overview?.avgScore ?? 0;
  const totalAudits = overview?.totalAudits ?? 0;
  const totalSalons = overview?.totalDealerships ?? 0;
  const totalEmployees = overview?.totalEmployees ?? 0;
  const answerRate = overview?.answerRate ?? 0;
  const totalCalls = overview?.totalCalls ?? 0;
  const displayTimeSeries = overview?.timeSeries ?? [];
  const hourly = overview?.hourlyAnswerRate ?? [];
  const answerTimeByCompany = overview?.answerTimeByCompany ?? [];

  const topSalons = (overview?.topDealerships ?? [])
    .map((c, i) => ({
      id: c.id,
      rank: i + 1,
      name: c.name,
      avgScore: c.avgAiScore,
      answerRate: c.answerRate,
      totalAudits: String(c.totalAudits),
    }));

  const worstSalons = (overview?.lowDealerships ?? [])
    .map((c, i) => ({
      id: c.id,
      rank: i + 1,
      name: c.name,
      avgScore: c.avgAiScore,
      answerRate: c.answerRate,
      totalAudits: String(c.totalAudits),
    }));


  const dashboardHeader = (
    <div className="sa-page-header sa-dashboard-page-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
      <div>
        <h1 className="sa-page-title" style={{ marginBottom: 6 }}>Дашборд</h1>
      </div>
      <div className="sa-dashboard-header-filters">
        <div className="sa-tag-filter-picker-wrap">
          <HoldingSelectPicker
            holdings={holdings}
            value={selectedHoldingId}
            onChange={setSelectedHoldingId}
            disabled={holdingsLoading || holdings.length === 0}
            loading={holdingsLoading}
            compact
          />
        </div>
        {selectedHoldingId && directionSelectOptions.length > 1 && (
          <div className="sa-tag-filter-picker-wrap">
            <SingleSelectFilterPicker
              options={directionSelectOptions}
              value={directionFilter}
              onChange={setDirectionFilter}
              placeholder="Направление"
              compact
            />
          </div>
        )}
        {selectedHoldingId && (
          <div className="sa-tag-filter-picker-wrap">
            <SingleSelectFilterPicker
              options={ownershipSelectOptions}
              value={ownershipFilter}
              onChange={setOwnershipFilter}
              placeholder="Тип точки"
              compact
            />
          </div>
        )}
      </div>
    </div>
  );

  if (!isLoading && !dashboardError && !overview) {
    return (
      <div className="sa-dashboard-root">
        {dashboardHeader}
        <div className="sa-empty-state">
          <p>Нет данных за выбранный период</p>
        </div>
      </div>
    );
  }

  const scoreInt = Math.round(platformAvgScore);

  return (
    <div className="sa-dashboard-root">
      {dashboardHeader}

      <section className="sa-section sa-section-metrics" style={{ marginBottom: SECTION_GAP }}>
        <h2 className="sa-section-title">Ключевые метрики</h2>
        <div className="sa-kpi-grid">
          <KPICard
            label="Рейтинг"
            value={isLoading ? '—' : String(scoreInt)}
            valueSuffix="из 100"
            description="Среднее по всем проверкам"
            loading={isLoading}
            valueClass={!isLoading ? scoreColorClass(platformAvgScore) : ''}
            navigateTo="analytics"
            onNavigate={handleKpiNavigate}
          />
          <KPICard
            label="Точки"
            value={totalSalons}
            loading={isLoading}
            noData={!isLoading && totalSalons === 0}
            description="Точки компании"
            navigateTo="companies"
            onNavigate={handleKpiNavigate}
          />
          <KPICard
            label="Сотрудники"
            value={totalEmployees}
            loading={isLoading}
            noData={!isLoading && totalEmployees === 0}
            description="Менеджеры на точках"
            navigateTo="users"
            onNavigate={handleKpiNavigate}
          />
          <KPICard
            label="Проверки"
            value={totalAudits}
            description="Тесты, тренировки и звонки"
            loading={isLoading}
            navigateTo="audits"
            onNavigate={handleKpiNavigate}
          />
          <KPICard
            label="Дозвон"
            value={isLoading ? '—' : `${answerRate.toFixed(1)}%`}
            description="Доля принятых звонков"
            loading={isLoading}
            valueClass={!isLoading ? rateColorClass(answerRate) : ''}
          />
        </div>
      </section>

      <section className="sa-section sa-section-analytics" style={{ marginBottom: SECTION_GAP }}>
        <h2 className="sa-section-title">Аналитика</h2>
        <div className="sa-dashboard-grid">
          <BrutalCard title="Принятые и пропущенные" className="sa-grid-card sa-donut-card">
            <AnsweredMissedDonut
              rate={totalCalls > 0 ? answerRate : 0}
              totalCalls={totalCalls}
              embedded
            />
          </BrutalCard>
          <BrutalCard title="Динамика эффективности" className="sa-grid-card sa-chart-equal">
            <PerformanceTrendChart points={displayTimeSeries} embedded ownershipFilter={ownershipFilter} />
          </BrutalCard>

          <BrutalCard title="Лучшие точки" className="sa-grid-card">
            <SalonTable
              rows={topSalons}
              emptyLabel="Нет данных"
              onOpenDealership={(id) => navigate(buildDealershipPath(id))}
            />
          </BrutalCard>
          <BrutalCard title="Точки с низким результатом" className="sa-grid-card">
            <SalonTable
              rows={worstSalons}
              emptyLabel="Нет данных"
              onOpenDealership={(id) => navigate(buildDealershipPath(id))}
            />
          </BrutalCard>

          <BrutalCard title="Дозвон по часам" className="sa-grid-card sa-chart-equal">
            <AnswerRateByHour hourly={hourly.length === 24 ? hourly : []} embedded />
          </BrutalCard>
          <BrutalCard title="Средняя длительность звонка" className="sa-grid-card sa-chart-equal">
            <AverageAnswerTimeChart data={answerTimeByCompany} embedded />
          </BrutalCard>
        </div>
      </section>

      <section className="sa-section sa-section-employee-ratings">
        <h2 className="sa-section-title">Рейтинг сотрудников</h2>
        <div className="sa-dashboard-grid">
          <BrutalCard title="ТОП-10 самых эффективных" className="sa-grid-card">
            <EmployeeRatingTable rows={overview?.topEmployees ?? []} onOpenEmployee={(id) => navigate(buildUserEmployeePath(id))} />
          </BrutalCard>
          <BrutalCard title="ТОП-10 самых провальных" className="sa-grid-card">
            <EmployeeRatingTable rows={overview?.lowEmployees ?? []} onOpenEmployee={(id) => navigate(buildUserEmployeePath(id))} />
          </BrutalCard>
        </div>
      </section>
    </div>
  );
}
