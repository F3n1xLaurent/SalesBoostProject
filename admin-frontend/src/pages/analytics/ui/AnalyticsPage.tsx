import React, { useEffect, useMemo, useState } from 'react';
import type { PlatformSummary } from '../../../shared/model/adminPanel';
import { fetchAnalyticsOverview, fetchHoldings, type AnalyticsOverview, type HoldingItem, type TimeSeriesPoint } from '../../../shared/api/adminPanel';
import { ratingClass, scoreBarColor } from '../../../shared/lib/admin-panel/utils';
import type { AnalyticsImpact, AnalyticsPriority, AnalyticsSectionInsight } from '../../../shared/api/adminPanel';
import { MetricComparisonModal } from '../../../shared/ui/metric-comparison-modal';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';

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

function NetworkTrendChart({ points }: { points: TimeSeriesPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!points.length) return <div className="sa-chart-empty">Нет данных</div>;
  const W = 760, H = 240;
  const pad = { top: 18, right: 18, bottom: 34, left: 42 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const step = points.length <= 1 ? 0 : cw / (points.length - 1);
  const xs = points.map((_, index) => pad.left + index * step);
  const y = (score: number) => pad.top + ch - (Math.max(0, Math.min(score, 100)) / 100) * ch;
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xs[index]} ${y(point.avgScore)}`).join(' ');
  return (
    <div className="sa-chart-wrap">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {[0, 25, 50, 75, 100].map((value) => {
          const gy = y(value);
          return (
            <g key={value}>
              <line x1={pad.left} y1={gy} x2={pad.left + cw} y2={gy} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
              <text x={pad.left - 8} y={gy + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">{value}</text>
            </g>
          );
        })}
        <path d={path} fill="none" stroke="var(--tb-ink)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((_, index) => (
          <rect
            key={`hit-${index}`}
            x={xs[index] - (step || 40) / 2}
            y={pad.top}
            width={step || 40}
            height={ch}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(index)}
          />
        ))}
        {hoverIdx !== null && (
          <line x1={xs[hoverIdx]} y1={pad.top} x2={xs[hoverIdx]} y2={pad.top + ch} stroke="var(--sa-text-secondary)" strokeWidth="1" strokeDasharray="3" opacity="0.4" />
        )}
        {points.map((point, index) => (
          <g key={point.date}>
            <circle
              cx={xs[index]}
              cy={y(point.avgScore)}
              r={hoverIdx === index ? 5.5 : 4}
              fill={hoverIdx === index ? '#fff' : 'var(--tb-ink)'}
              stroke="var(--tb-ink)"
              strokeWidth={hoverIdx === index ? 2.5 : 0}
            />
            <text x={xs[index]} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">{point.date.slice(5)}</text>
          </g>
        ))}
      </svg>
      {hoverIdx !== null && (() => {
        const point = points[hoverIdx];
        const leftPct = (xs[hoverIdx] / W) * 100;
        const topPct = (y(point.avgScore) / H) * 100;
        const placeBelow = topPct < 28;
        return (
          <div
            className={`sa-chart-hover-tooltip${placeBelow ? ' sa-chart-hover-tooltip-below' : ''}`}
            style={{ left: `${leftPct}%`, top: `${topPct}%` }}
          >
            <div className="sa-chart-hover-tooltip-row">Дата: {point.date}</div>
            <div className="sa-chart-hover-tooltip-row is-strong">Средний балл: {point.avgScore.toFixed(1)}</div>
            <div className="sa-chart-hover-tooltip-row">Проверок: {point.count}</div>
          </div>
        );
      })()}
    </div>
  );
}

function BestWorstCards({ rows, onOpen }: { rows: ComparableDealership[]; onOpen?: (id: string) => void }) {
  const active = rows.filter((row) => row.calls > 0);
  const best = [...active].sort((a, b) => b.score - a.score).slice(0, 3);
  const worst = [...active].sort((a, b) => a.score - b.score).slice(0, 3);
  const renderList = (items: ComparableDealership[]) => items.length === 0
    ? <div className="sa-meta">Нет данных</div>
    : items.map((row, index) => (
      <button key={row.id} type="button" className="sa-btn-text" style={{ justifyContent: 'space-between', width: '100%', padding: '8px 0' }} onClick={() => onOpen?.(row.id)}>
        <span>{index + 1}. {row.name}</span>
        <span className={ratingClass(row.score)}>{row.score}</span>
      </button>
    ));
  return (
    <div className="sa-dashboard-grid" style={{ marginBottom: 28 }}>
      <div className="sa-card sa-grid-card">
        <h3 className="sa-card-heading">Лучшие точки</h3>
        {renderList(best)}
      </div>
      <div className="sa-card sa-grid-card">
        <h3 className="sa-card-heading">Худшие точки</h3>
        {renderList(worst)}
      </div>
    </div>
  );
}

function InlineComparisonChart({ rows }: { rows: ComparableDealership[] }) {
  if (rows.length < 2) return <div className="sa-chart-empty">Выберите от 2 до 6 точек</div>;
  const max = Math.max(100, ...rows.map((row) => row.score));
  return (
    <div className="sa-hbar-list">
      {rows.map((row) => {
        const previous = Math.max(0, Math.min(100, row.score - row.delta));
        return (
          <div key={row.id} className="sa-hbar-row">
            <span className="sa-hbar-label" title={row.name}>{row.name}</span>
            <div className="sa-hbar-track">
              <div className="sa-hbar-fill" style={{ width: `${Math.round((previous / max) * 100)}%`, background: 'rgba(99,102,241,.25)' }} />
              <div className="sa-hbar-fill" style={{ width: `${Math.round((row.score / max) * 100)}%`, background: scoreBarColor(row.score), marginTop: -8 }} />
            </div>
            <span className={`sa-hbar-score ${ratingClass(row.score)}`}>{row.score}</span>
          </div>
        );
      })}
    </div>
  );
}

function MultiDealershipTrendChart({ series }: { series: Array<{ id: string; name: string; points: TimeSeriesPoint[] }> }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (series.length < 2) return <div className="sa-chart-empty">Выберите от 2 до 6 точек</div>;
  const W = 760, H = 260;
  const pad = { top: 18, right: 18, bottom: 38, left: 42 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const dates = [...new Set(series.flatMap((item) => item.points.map((point) => point.date)))].sort();
  const step = dates.length <= 1 ? 0 : cw / (dates.length - 1);
  const xs = dates.map((_, index) => pad.left + index * step);
  const y = (score: number) => pad.top + ch - (Math.max(0, Math.min(score, 100)) / 100) * ch;
  const colors = ['#111827', '#2563EB', '#D97706', '#059669', '#DC2626', '#7C3AED'];
  const scoreAt = (points: TimeSeriesPoint[], date: string) => {
    const found = points.find((point) => point.date === date);
    return found?.avgScore ?? 0;
  };
  const pathFor = (points: TimeSeriesPoint[]) => dates
    .map((date, index) => `${index === 0 ? 'M' : 'L'} ${xs[index]} ${y(scoreAt(points, date))}`)
    .join(' ');
  return (
    <div className="sa-chart-wrap">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        {series.map((item, index) => (
          <span key={item.id} className="sa-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: colors[index % colors.length], display: 'inline-block' }} />
            {item.name}
          </span>
        ))}
      </div>
      <div className="sa-chart-plot">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {[0, 25, 50, 75, 100].map((value) => {
          const gy = y(value);
          return (
            <g key={value}>
              <line x1={pad.left} y1={gy} x2={pad.left + cw} y2={gy} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
              <text x={pad.left - 8} y={gy + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">{value}</text>
            </g>
          );
        })}
        {dates.map((date, index) => (
          <text key={date} x={xs[index]} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">{date.slice(5)}</text>
        ))}
        {series.map((item, index) => (
          <path key={item.id} d={pathFor(item.points)} fill="none" stroke={colors[index % colors.length]} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {dates.map((_, index) => (
          <rect
            key={`hit-${index}`}
            x={xs[index] - (step || 40) / 2}
            y={pad.top}
            width={step || 40}
            height={ch}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(index)}
          />
        ))}
        {hoverIdx !== null && (
          <line x1={xs[hoverIdx]} y1={pad.top} x2={xs[hoverIdx]} y2={pad.top + ch} stroke="var(--sa-text-secondary)" strokeWidth="1" strokeDasharray="3" opacity="0.4" />
        )}
      </svg>
      {hoverIdx !== null && (() => {
        const date = dates[hoverIdx];
        const leftPct = (xs[hoverIdx] / W) * 100;
        const topPct = ((pad.top + 8) / H) * 100;
        return (
          <div
            className="sa-chart-hover-tooltip sa-chart-hover-tooltip-below"
            style={{ left: `${leftPct}%`, top: `${topPct}%` }}
          >
            <div className="sa-chart-hover-tooltip-row">Дата: {date}</div>
            {series.map((item) => (
              <div key={item.id} className="sa-chart-hover-tooltip-row is-strong">
                {item.name}: {scoreAt(item.points, date).toFixed(1)}
              </div>
            ))}
          </div>
        );
      })()}
      </div>
    </div>
  );
}

function IssueList({ items, labelKey = 'issue' }: { items: Array<{ issue?: string; question?: string; percent: number; count: number }>; labelKey?: 'issue' | 'question' }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!items.length) return <div className="sa-meta">Нет данных</div>;
  return (
    <div className="sa-hbar-list sa-hbar-list-thin sa-hbar-list-mono">
      {items.slice(0, 5).map((item, index) => {
        const label = labelKey === 'question' ? item.question : item.issue;
        return (
          <div
            key={`${label}-${index}`}
            className={`sa-hbar-row ${hoverIdx === index ? 'sa-hbar-row-hover' : ''}`}
            onMouseEnter={() => setHoverIdx(index)}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <span className="sa-hbar-label">{label}</span>
            <div className="sa-hbar-track">
              <div className="sa-hbar-fill" style={{ width: `${item.percent}%` }} />
            </div>
            <span className="sa-hbar-score">{item.percent}%</span>
            {hoverIdx === index && label && (
              <div className="sa-hbar-tooltip sa-hbar-tooltip-name">{label}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ────────────────────── Horizontal bar chart for errors ────────────────────── */

function ErrorsChart({ data }: { data: { error: string; count: number; percent: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (data.length === 0) return <div className="sa-chart-empty">Нет данных</div>;

  return (
    <div className="sa-hbar-list sa-hbar-list-thin sa-hbar-list-mono">
      {data.map((d, i) => (
        <div
          key={d.error}
          className={`sa-hbar-row ${hoverIdx === i ? 'sa-hbar-row-hover' : ''}`}
          onMouseEnter={() => setHoverIdx(i)}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <span className="sa-hbar-label">{d.error}</span>
          <div className="sa-hbar-track">
            <div className="sa-hbar-fill" style={{ width: `${d.percent}%` }} />
          </div>
          <span className="sa-hbar-score">{d.percent}%</span>
          {hoverIdx === i && (
            <div className="sa-hbar-tooltip sa-hbar-tooltip-name">{d.error} · {d.count} сотрудников</div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────── Script compliance bars ────────────────────── */

function ScriptChart({ data }: { data: { block: string; rate: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  return (
    <div className="sa-hbar-list sa-hbar-list-thin">
      {data.map((d, i) => (
        <div
          key={d.block}
          className={`sa-hbar-row ${hoverIdx === i ? 'sa-hbar-row-hover' : ''}`}
          onMouseEnter={() => setHoverIdx(i)}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <span className="sa-hbar-label">{d.block}</span>
          <div className="sa-hbar-track">
            <div className="sa-hbar-fill" style={{ width: `${d.rate}%`, background: scoreBarColor(d.rate) }} />
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
            <div className="sa-hbar-fill" style={{ width: `${d.score}%`, background: scoreBarColor(d.score) }} />
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
  return (
    <MetricComparisonModal
      open={rows.length >= 2}
      onClose={onClose}
      title="Сравнение точек"
      columns={rows.map((row) => ({
        id: row.id,
        label: row.name,
        onOpen: () => onOpenDealership(row.id),
      }))}
      metrics={[
        {
          key: 'score',
          label: 'Балл',
          higherBetter: true,
          values: rows.map((row) => row.score),
        },
        {
          key: 'delta',
          label: 'Динамика',
          higherBetter: true,
          values: rows.map((row) => row.delta),
          format: (value) => {
            if (value === null) return '—';
            return value > 0 ? `+${value}` : value;
          },
        },
        {
          key: 'calls',
          label: 'Звонков',
          higherBetter: true,
          values: rows.map((row) => row.calls),
        },
        {
          key: 'noAnswers',
          label: 'Недозвоны',
          higherBetter: false,
          values: rows.map((row) => row.noAnswers),
        },
      ]}
      aiLevel="dealerships"
      aiItems={rows.map((row) => ({ ...row }))}
    />
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
  const networkTrend = data.timeSeries ?? timeSeries;
  const rankedRows = useMemo(
    () => [...dealershipRows].sort((a, b) => b.score - a.score),
    [dealershipRows],
  );
  const selectedSeries = useMemo(
    () => (data.dealershipTimeSeries ?? []).filter((item) => selectedDealershipIds.includes(item.id)),
    [data.dealershipTimeSeries, selectedDealershipIds],
  );
  const ownAvg = useMemo(() => {
    const own = dealershipRows.filter((row) => row.type === 'own' && row.calls > 0);
    return own.length ? Math.round(own.reduce((sum, row) => sum + row.score, 0) / own.length) : 0;
  }, [dealershipRows]);
  const franchiseAvg = useMemo(() => {
    const franchise = dealershipRows.filter((row) => row.type === 'franchised' && row.calls > 0);
    return franchise.length ? Math.round(franchise.reduce((sum, row) => sum + row.score, 0) / franchise.length) : 0;
  }, [dealershipRows]);
  const typeComparisonInsight = ownAvg || franchiseAvg
    ? `${ownAvg >= franchiseAvg ? 'Собственные точки' : 'Франшиза'} выше на ${Math.abs(ownAvg - franchiseAvg)} балл(ов): ${ownAvg} против ${franchiseAvg}.`
    : 'Недостаточно данных для сравнения собственных точек и франшизы.';
  const topProblemInsight = data.leadersLaggards?.laggardsErrors[0]
    ? `У отстающих чаще всего встречается «${data.leadersLaggards.laggardsErrors[0].issue}»: ${data.leadersLaggards.laggardsErrors[0].percent}% по текущей выборке.`
    : 'Недостаточно данных для выделения системной топ-проблемы.';
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

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-card">
          <div className="sa-section-header-row" style={{ marginBottom: 12 }}>
            <div>
              <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Динамика среднего балла по сети</h2>
              <div className="sa-meta">Одна линия по оценённым привязанным звонкам</div>
            </div>
            <div className={`sa-kpi-value ${ratingClass(data.avgScore)}`}>{data.avgScore}</div>
          </div>
          <NetworkTrendChart points={networkTrend} />
        </div>
      </section>

      <BestWorstCards rows={dealershipRows} onOpen={(id) => onDrill?.('dealership', id)} />

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-card">
          <h2 className="sa-section-title">Рекомендуемые действия</h2>
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
                {act.drillType && (
                  <button className="sa-btn-text sa-btn-sm" onClick={() => onDrill?.(act.drillType, act.drillFilter)}>
                    Перейти →
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sa-section" style={{ marginTop: 28, marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Рейтинг компаний</h2>
          <div className="sa-meta">Позиция относительно среднего по сети: {data.avgScore}</div>
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
                  <th className="sa-text-right">Отклонение</th>
                  <th className="sa-text-right">Звонков</th>
                  <th className="sa-text-right">Недозвоны</th>
                  <th className="sa-text-right">Ниже 50</th>
                </tr>
              </thead>
              <tbody>
                {(data.holdingRows ?? []).length === 0 ? (
                  <tr><td colSpan={8} className="sa-meta" style={{ padding: 24 }}>Нет компаний с привязанными точками</td></tr>
                ) : (
                  (data.holdingRows ?? []).map((row) => (
                    <tr key={row.id}>
                      <td style={{ fontWeight: 600 }}>{row.name}</td>
                      <td>{row.type === 'franchised' ? 'Франшиза' : 'Собственная'}</td>
                      <td className="sa-text-right">{row.dealershipsCount}</td>
                      <td className="sa-text-right"><span className={ratingClass(row.score)}>{row.score}</span></td>
                      <td className="sa-text-right">{row.score - data.avgScore > 0 ? '+' : ''}{row.score - data.avgScore}</td>
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
          {!!data.typeCategoryComparison?.length && (
            <div className="sa-table-wrap" style={{ marginTop: 16 }}>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Категория</th>
                    <th className="sa-text-right">Собственные</th>
                    <th className="sa-text-right">Франшиза</th>
                    <th className="sa-text-right">Разница</th>
                  </tr>
                </thead>
                <tbody>
                  {data.typeCategoryComparison.map((row) => (
                    <tr key={row.category}>
                      <td>{row.category}</td>
                      <td className="sa-text-right"><span className={ratingClass(row.ownScore)}>{row.ownScore}</span></td>
                      <td className="sa-text-right"><span className={ratingClass(row.franchiseScore)}>{row.franchiseScore}</span></td>
                      <td className="sa-text-right">{row.ownScore - row.franchiseScore > 0 ? '+' : ''}{row.ownScore - row.franchiseScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="sa-dashboard-grid" style={{ marginTop: 16 }}>
            <div>
              <h3 className="sa-card-heading">Топ-ошибки собственных</h3>
              <IssueList items={data.typeTopErrors?.own ?? []} />
            </div>
            <div>
              <h3 className="sa-card-heading">Топ-ошибки франшизы</h3>
              <IssueList items={data.typeTopErrors?.franchise ?? []} />
            </div>
          </div>
          <div className="sa-meta" style={{ marginTop: 12 }}>{typeComparisonInsight}</div>
        </div>
      </section>

      {/* ── Dealership comparison ── */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Сравнительная динамика</h2>
          <div className="sa-meta">Выберите от 2 до 6 точек</div>
        </div>
        <div className="sa-card">
          <MultiDealershipTrendChart series={selectedSeries} />
        </div>
        <div className="sa-card" style={{ marginTop: 16 }}>
          <div className="sa-section-header-row" style={{ marginBottom: 12 }}>
            <h3 className="sa-card-heading" style={{ marginBottom: 0 }}>Рейтинг точек</h3>
            <div className="sa-meta">Позиция, отклонение от среднего сети и тренд</div>
          </div>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th style={{ width: 44 }} />
                  <th className="sa-text-right">#</th>
                  <th>Точка</th>
                  <th>Дилер</th>
                  <th>Тип</th>
                  <th className="sa-text-right">Балл</th>
                  <th className="sa-text-right">Отклонение</th>
                  <th className="sa-text-right">Динамика</th>
                  <th className="sa-text-right">Звонков</th>
                  <th className="sa-text-right">Недозвоны</th>
                </tr>
              </thead>
              <tbody>
                {dealershipRows.length === 0 ? (
                  <tr><td colSpan={10} className="sa-meta" style={{ padding: 24 }}>Нет привязанных точек для аналитики</td></tr>
                ) : (
                  rankedRows.map((row, index) => (
                    <tr key={row.id} className="sa-row-clickable" onClick={() => onDrill?.('dealership', row.id)}>
                      <td onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedDealershipIds.includes(row.id)}
                          disabled={!selectedDealershipIds.includes(row.id) && selectedDealershipIds.length >= 6}
                          onChange={() => toggleDealership(row.id)}
                        />
                      </td>
                      <td className="sa-text-right">{index + 1}</td>
                      <td style={{ fontWeight: 600 }}>{row.name}</td>
                      <td>{row.dealer}</td>
                      <td>{row.type === 'franchised' ? 'Франшиза' : 'Собственная'}</td>
                      <td className="sa-text-right"><span className={ratingClass(row.score)}>{row.score}</span></td>
                      <td className="sa-text-right">{row.score - data.avgScore > 0 ? '+' : ''}{row.score - data.avgScore}</td>
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
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Топ-проблема: лидеры vs отстающие</h2>
          <div className="sa-meta">Проблемы из фиксированного справочника</div>
        </div>
        <div className="sa-card">
          <div className="sa-dashboard-grid">
            <div>
              <h3 className="sa-card-heading">Ошибки лидеров</h3>
              <IssueList items={data.leadersLaggards?.leadersErrors ?? []} />
            </div>
            <div>
              <h3 className="sa-card-heading">Ошибки отстающих</h3>
              <IssueList items={data.leadersLaggards?.laggardsErrors ?? []} />
            </div>
          </div>
          <div className="sa-dashboard-grid" style={{ marginTop: 16 }}>
            <div>
              <h3 className="sa-card-heading">Сложные вопросы лидеров</h3>
              <IssueList items={data.leadersLaggards?.leadersQuestions ?? []} labelKey="question" />
            </div>
            <div>
              <h3 className="sa-card-heading">Сложные вопросы отстающих</h3>
              <IssueList items={data.leadersLaggards?.laggardsQuestions ?? []} labelKey="question" />
            </div>
          </div>
          <div className="sa-meta" style={{ marginTop: 12 }}>{topProblemInsight}</div>
        </div>
      </section>

      {/* ── Script compliance ── */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Распределение по категориям</h2>
          <div className="sa-meta">Контакт / Диагностика / Продукт / Закрытие / Коммуникация</div>
        </div>
        <div className="sa-card">
          <ScriptChart data={data.scriptCompliance} />
        </div>
      </section>

      {selectedDealershipIds.length > 0 && (
        <div className="sa-meta" style={{ marginTop: -12, marginBottom: 28 }}>
          Выбрано точек: {selectedDealershipIds.length}.{' '}
          <button className="sa-btn-text sa-btn-sm" onClick={() => setSelectedDealershipIds([])}>Сбросить выбор</button>
        </div>
      )}
    </>
  );
}
