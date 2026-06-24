import React, { useEffect, useState } from 'react';
import { AISummaryBlock } from '../../../shared/ui/ai-summary-block/AISummaryBlock';
import { fetchDashboardOverview, fetchHoldings, type DashboardOverview, type HoldingItem, type TimeSeriesPoint } from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';

const SECTION_GAP = 48;

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
}: {
  label: string;
  value: string | number;
  description?: string;
  loading: boolean;
  noData?: boolean;
  valueClass?: string;
}) {
  const displayValue = noData ? 'Нет данных' : loading ? '—' : value;
  const isPlaceholder = loading || noData;
  return (
    <div className="sa-card sa-kpi-card">
      <div className="sa-kpi-label">{label}</div>
      <div className={`sa-kpi-value ${!isPlaceholder ? 'sa-kpi-value-large' : ''} ${valueClass ?? ''}`}>{displayValue}</div>
      {description && !isPlaceholder && <div className="sa-kpi-desc">{description}</div>}
    </div>
  );
}

/* ─── Performance Trend Chart ─── */
function PerformanceTrendChart({ points }: { points: TimeSeriesPoint[] }) {
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
  const padding = { top: 20, right: 20, bottom: 36, left: 44 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const step = points.length <= 1 ? 0 : chartWidth / (points.length - 1);
  const xs = points.map((_, i) => padding.left + i * step);
  const ys = points.map((p) => padding.top + chartHeight - (p.avgScore / 100) * chartHeight);
  const pathD = points.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${ys[i]}`).join(' ');

  return (
    <div className="sa-chart-wrap">
      <h3 className="sa-chart-title">Динамика эффективности</h3>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="trendFillGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary, #6366F1)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--primary, #6366F1)" stopOpacity="0.02" />
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
        <path
          d={`${pathD} L ${xs[xs.length - 1]} ${padding.top + chartHeight} L ${xs[0]} ${padding.top + chartHeight} Z`}
          fill="url(#trendFillGrad)"
        />
        <path d={pathD} fill="none" stroke="var(--primary, #6366F1)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
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
        {points.map((p, i) => (
          <circle
            key={p.date}
            cx={xs[i]}
            cy={ys[i]}
            r={hoverIdx === i ? 6 : 4}
            fill={hoverIdx === i ? '#fff' : 'var(--primary, #6366F1)'}
            stroke={hoverIdx === i ? 'var(--primary, #6366F1)' : 'none'}
            strokeWidth={hoverIdx === i ? 2.5 : 0}
            style={{ transition: 'r 0.15s ease, fill 0.15s ease', cursor: 'pointer' }}
          />
        ))}
        {hoverIdx !== null && (() => {
          const p = points[hoverIdx];
          const tx = xs[hoverIdx];
          const ty = ys[hoverIdx];
          const tooltipW = 150;
          const tooltipH = 62;
          const tooltipX = Math.min(Math.max(tx - tooltipW / 2, 4), width - tooltipW - 4);
          const tooltipY = ty - tooltipH - 14;
          return (
            <g>
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH} rx="8" fill="#1F2937" opacity="0.92" />
              <text x={tooltipX + 12} y={tooltipY + 18} fontSize="11" fill="#D1D5DB">Дата: {p.date}</text>
              <text x={tooltipX + 12} y={tooltipY + 34} fontSize="11" fill="#F9FAFB" fontWeight="600">Средний балл: {p.avgScore.toFixed(1)}</text>
              <text x={tooltipX + 12} y={tooltipY + 50} fontSize="11" fill="#D1D5DB">Проверок: {p.count}</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

/* ─── Salon Table — short names (no "Точка" prefix) ─── */
function SalonTable({
  rows,
  emptyLabel,
}: {
  rows: { rank: number; name: string; avgScore: number; answerRate: number; totalAudits: string }[];
  emptyLabel: string;
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
            <th>Балл</th>
            <th>Дозвон</th>
            <th>Проверки</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rank}>
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

/* ─── Average Answer Time — SVG bar chart with clamped tooltip ─── */
function AverageAnswerTimeChart({ data }: { data: { name: string; avgSec: number; totalCalls: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="sa-chart-wrap">
        <h3 className="sa-chart-title">Среднее время ответа</h3>
        <div className="sa-chart-empty">Нет данных за выбранный период</div>
      </div>
    );
  }

  const maxSec = Math.max(...data.map((d) => d.avgSec), 1);
  const svgW = 540;
  const svgH = 260;
  const pad = { top: 24, right: 12, bottom: 48, left: 40 };
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
      <h3 className="sa-chart-title">Средняя длительность звонка</h3>
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
                fill={isHover ? '#4F46E5' : '#6366F1'}
                opacity={isHover ? 1 : 0.85}
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
                    <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH} rx="8" fill="#1F2937" opacity="0.92" />
                    <text x={tooltipX + 10} y={tooltipY + 16} fontSize="11" fill="#F9FAFB" fontWeight="600">{d.name}</text>
                    <text x={tooltipX + 10} y={tooltipY + 32} fontSize="11" fill="#D1D5DB">Длительность: {d.avgSec} сек</text>
                    <text x={tooltipX + 10} y={tooltipY + 46} fontSize="11" fill="#D1D5DB">Звонков: {d.totalCalls}</text>
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

function AnswerRateByHour({ hourly }: { hourly: number[] }) {
  const [hoverHour, setHoverHour] = useState<number | null>(null);

  if (!hourly || hourly.length === 0) {
    return (
      <div className="sa-chart-wrap">
        <h3 className="sa-chart-title">Дозвон по часам</h3>
        <div className="sa-heatmap-empty">Нет данных за выбранный период</div>
      </div>
    );
  }

  const maxVal = Math.max(...hourly, 1);

  return (
    <div className="sa-chart-wrap sa-heatmap-fill">
      <h3 className="sa-chart-title">Дозвон по часам</h3>
      <div className="sa-heatmap-grid-12" onMouseLeave={() => setHoverHour(null)}>
        {hourly.slice(0, 24).map((pct, hour) => {
          const hasData = pct > 0;
          const opacity = hasData ? 0.15 + (pct / maxVal) * 0.85 : 0;
          const bg = hasData ? `rgba(34, 197, 94, ${opacity})` : 'rgba(17, 24, 39, 0.05)';
          return (
            <div
              key={hour}
              className={`sa-heatmap-cell ${hoverHour === hour ? 'sa-heatmap-cell-hover' : ''} ${!hasData ? 'sa-heatmap-closed' : ''}`}
              style={{ backgroundColor: bg }}
              onMouseEnter={() => setHoverHour(hour)}
            >
              <span className="sa-heatmap-label">{hour}</span>
              {hoverHour === hour && (
                <div className="sa-heatmap-tooltip">
                  <div>Час: {hour}:00</div>
                  <div>{hasData ? `Дозвон: ${pct.toFixed(0)}%` : 'Нет звонков'}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Answered vs Missed Donut ─── */
function AnsweredMissedDonut({ rate, totalCalls }: { rate: number; totalCalls: number }) {
  const [hover, setHover] = useState<'answered' | 'missed' | null>(null);
  const answered = Math.round((rate / 100) * totalCalls);
  const missed = totalCalls - answered;

  return (
    <div className="sa-donut-section">
      <h3 className="sa-chart-title">Принятые и пропущенные</h3>
      <div className="sa-donut-wrap-v2">
        <div
          className="sa-donut-v2"
          onMouseEnter={() => setHover('answered')}
          onMouseLeave={() => setHover(null)}
        >
          <svg viewBox="0 0 120 120" className="sa-donut-svg">
            <circle cx="60" cy="60" r="52" fill="none" stroke="#FEE2E2" strokeWidth="14" />
            <circle
              cx="60" cy="60" r="52"
              fill="none"
              stroke={hover === 'missed' ? '#F87171' : '#34D399'}
              strokeWidth="14"
              strokeDasharray={`${(rate / 100) * 326.73} 326.73`}
              strokeLinecap="round"
              transform="rotate(-90 60 60)"
              style={{ transition: 'stroke 0.2s ease' }}
            />
          </svg>
          <div className="sa-donut-center">
            <span className="sa-donut-center-num">{rate.toFixed(0)}%</span>
            <span className="sa-donut-center-label">Дозвон</span>
          </div>
          {hover && (
            <div className="sa-donut-tooltip">
              <div>Принятые: {answered}</div>
              <div>Пропущенные: {missed}</div>
              <div>Всего: {totalCalls}</div>
            </div>
          )}
        </div>
        <div className="sa-donut-legend-v2">
          <div className="sa-donut-legend-item">
            <span className="sa-dot sa-dot-answered" />
            Принятые {rate.toFixed(0)}%
          </div>
          <div className="sa-donut-legend-item">
            <span className="sa-dot sa-dot-missed-v2" />
            Пропущенные {(100 - rate).toFixed(0)}%
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Main Dashboard ─── */
export function Dashboard({ loading }: DashboardProps) {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
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
    fetchDashboardOverview({ holdingId: selectedHoldingId })
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
  }, [holdingsLoading, selectedHoldingId]);

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
      rank: i + 1,
      name: c.name,
      avgScore: c.avgAiScore,
      answerRate: c.answerRate,
      totalAudits: String(c.totalAudits),
    }));

  const worstSalons = (overview?.lowDealerships ?? [])
    .map((c, i) => ({
      rank: i + 1,
      name: c.name,
      avgScore: c.avgAiScore,
      answerRate: c.answerRate,
      totalAudits: String(c.totalAudits),
    }));

  const topWeakness = overview?.topWeakness ?? null;
  const badgePrimaryLabel = 'Частая ошибка';
  const badgePrimaryValue = topWeakness
    ? `${topWeakness.weakness} (${topWeakness.count})`
    : 'Нет данных';
  const badgeSecondaryLabel = 'Зона риска';
  const badgeSecondaryValue = overview?.riskLabel ?? 'Нет данных';
  const dashboardHeader = (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 20 }}>
      <div>
        <h1 className="sa-page-title" style={{ marginBottom: 6 }}>Дашборд</h1>
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

      <section className="sa-section" style={{ marginBottom: SECTION_GAP }}>
        <h2 className="sa-section-title">Ключевые метрики</h2>
        <div className="sa-kpi-grid">
          <KPICard label="Точки" value={totalSalons} loading={isLoading} noData={!isLoading && totalSalons === 0} description="Точки компании" />
          <KPICard label="Сотрудники" value={totalEmployees} loading={isLoading} noData={!isLoading && totalEmployees === 0} description="Менеджеры на точках" />
          <KPICard label="Проверки" value={totalAudits} description="Тесты, тренировки и звонки" loading={isLoading} />
          <KPICard
            label="Оценка качества"
            value={isLoading ? '—' : String(scoreInt)}
            description="Средний балл по всем проверкам (0–100)"
            loading={isLoading}
            valueClass={!isLoading ? scoreColorClass(platformAvgScore) : ''}
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

      <section className="sa-section" style={{ marginBottom: SECTION_GAP }}>
        <AISummaryBlock
          title="AI Резюме"
          summary={overview?.aiSummary}
          loading={isLoading}
          error={dashboardError}
          badgePrimaryLabel={badgePrimaryLabel}
          badgePrimaryValue={badgePrimaryValue}
          badgeSecondaryLabel={badgeSecondaryLabel}
          badgeSecondaryValue={badgeSecondaryValue}
        />
      </section>

      <section className="sa-section" style={{ marginBottom: SECTION_GAP }}>
        <h2 className="sa-section-title">Аналитика</h2>
        <div className="sa-dashboard-grid">
          <div className="sa-card sa-grid-card sa-chart-equal">
            <PerformanceTrendChart points={displayTimeSeries} />
          </div>
          <div className="sa-card sa-grid-card sa-chart-equal">
            <AnswerRateByHour hourly={hourly.length === 24 ? hourly : []} />
          </div>

          <div className="sa-card sa-grid-card">
            <h3 className="sa-card-heading">Лучшие точки</h3>
            <SalonTable rows={topSalons} emptyLabel="Нет данных" />
          </div>
          <div className="sa-card sa-grid-card">
            <h3 className="sa-card-heading">Точки с низким результатом</h3>
            <SalonTable rows={worstSalons} emptyLabel="Нет данных" />
          </div>

          <div className="sa-card sa-grid-card sa-donut-card">
            <AnsweredMissedDonut
              rate={totalCalls > 0 ? answerRate : 0}
              totalCalls={totalCalls}
            />
          </div>
          <div className="sa-card sa-grid-card">
            <AverageAnswerTimeChart data={answerTimeByCompany} />
          </div>
        </div>
      </section>
    </div>
  );
}
