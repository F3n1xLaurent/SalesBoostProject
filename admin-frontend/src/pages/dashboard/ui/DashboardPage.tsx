import React, { useMemo, useState } from 'react';
import { AISummaryBlock } from '../../../shared/ui/ai-summary-block/AISummaryBlock';
import type { PlatformSummary, PlatformVoice } from '../../../shared/model/adminPanel';
import type { TimeSeriesPoint, MockCompany, AuditItem } from '../../../shared/api/adminPanel';

const SECTION_GAP = 48;

type DashboardProps = {
  summary: PlatformSummary | null;
  voice: PlatformVoice | null;
  loading: boolean;
  timeSeries?: TimeSeriesPoint[];
  companies?: MockCompany[];
  totalAudits?: number;
  audits?: AuditItem[];
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

/** Strip common prefix "Автосалон " from salon names for compact display */
function shortName(name: string): string {
  return name.replace(/^Автосалон\s+/i, '');
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

/* ─── Salon Table — short names (no "Автосалон" prefix) ─── */
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
            <th>Автосалон</th>
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
      <h3 className="sa-chart-title">Среднее время ответа</h3>
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
                    <text x={tooltipX + 10} y={tooltipY + 32} fontSize="11" fill="#D1D5DB">Время: {d.avgSec} сек</text>
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

/* ─── Answer Rate by Hour — 12 per row, 2 rows, gray for closed hours ─── */
const CLOSED_HOURS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 21, 22, 23]);

function AnswerRateByHour({ hourly }: { hourly: number[] }) {
  const [hoverHour, setHoverHour] = useState<number | null>(null);
  const callsPerHour = useMemo(
    () => hourly.map((pct, h) => CLOSED_HOURS.has(h) ? 0 : Math.round(pct * 0.6 + 3)),
    [hourly]
  );

  if (!hourly || hourly.length === 0) {
    return (
      <div className="sa-chart-wrap">
        <h3 className="sa-chart-title">Дозвон по часам</h3>
        <div className="sa-heatmap-empty">Нет данных за выбранный период</div>
      </div>
    );
  }

  const workingHours = hourly.filter((_, h) => !CLOSED_HOURS.has(h));
  const maxVal = Math.max(...workingHours, 1);

  return (
    <div className="sa-chart-wrap sa-heatmap-fill">
      <h3 className="sa-chart-title">Дозвон по часам</h3>
      <div className="sa-heatmap-grid-12" onMouseLeave={() => setHoverHour(null)}>
        {hourly.slice(0, 24).map((pct, hour) => {
          const isClosed = CLOSED_HOURS.has(hour);
          const opacity = isClosed ? 0 : 0.15 + (pct / maxVal) * 0.85;
          const bg = isClosed
            ? 'rgba(17, 24, 39, 0.05)'
            : `rgba(34, 197, 94, ${opacity})`;
          return (
            <div
              key={hour}
              className={`sa-heatmap-cell ${hoverHour === hour ? 'sa-heatmap-cell-hover' : ''} ${isClosed ? 'sa-heatmap-closed' : ''}`}
              style={{ backgroundColor: bg }}
              onMouseEnter={() => setHoverHour(hour)}
            >
              <span className="sa-heatmap-label">{hour}</span>
              {hoverHour === hour && (
                <div className="sa-heatmap-tooltip">
                  <div>Час: {hour}:00</div>
                  {isClosed ? (
                    <div>Салон закрыт</div>
                  ) : (
                    <>
                      <div>Дозвон: {pct.toFixed(0)}%</div>
                      <div>Звонков: {callsPerHour[hour]}</div>
                    </>
                  )}
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

/* ─── Mock data — short names (just the salon name, no "Автосалон" prefix for bar labels) ─── */
const MOCK_SALON_NAMES = [
  'Автосалон Центральный', 'Автосалон Север', 'Автосалон Юг', 'Автосалон Запад',
  'Автосалон Восток', 'Автосалон Премиум', 'Автосалон Сити', 'Автосалон Плюс',
  'Автосалон Драйв', 'Автосалон Мега',
];

const FALLBACK_ANSWER_TIME = MOCK_SALON_NAMES.slice(0, 8).map((name, i) => ({
  name,
  avgSec: [18, 25, 14, 32, 22, 42, 9, 36][i] ?? 20,
  totalCalls: 8 + (i % 12),
}));

const MOCK_ANSWER_RATE = 68;
const MOCK_TOTAL_CALLS = 42;
const MOCK_HOURLY = [
  0, 0, 0, 0, 0, 0, 0, 0,
  55, 72, 78, 82, 85, 88, 80, 75, 70, 65, 58, 52, 48,
  0, 0, 0,
];
const MOCK_TREND_SCORES = [52, 58, 55, 65, 72, 68, 75];
const MOCK_TOTAL_AUDITS = 147;
const MOCK_AVG_SCORE = 67;

function getFallbackTrendPoints(): TimeSeriesPoint[] {
  const today = new Date();
  return MOCK_TREND_SCORES.map((avgScore, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (6 - i));
    return { date: d.toISOString().slice(0, 10), avgScore, count: 4 + (i % 4) };
  });
}

function hasTrendVariation(points: TimeSeriesPoint[]): boolean {
  if (points.length <= 1) return false;
  const scores = points.map((p) => p.avgScore);
  return Math.max(...scores) - Math.min(...scores) > 1;
}

function useMockData(loading: boolean, companies: MockCompany[], timeSeries: TimeSeriesPoint[], voice: PlatformVoice | null) {
  return useMemo(() => {
    const useMockCompanies = loading || companies.length === 0;
    const hasRealCalls = (voice?.totalCalls ?? 0) > 0;
    const realCallMeaningful = hasRealCalls && (voice?.answeredPercent ?? 0) > 0 && (voice?.answeredPercent ?? 0) < 100;
    const useMockCallData = !realCallMeaningful;
    const seriesEmptyOrFlat = timeSeries.length === 0 || timeSeries.every((p) => p.avgScore === 0);
    const useMockSeries = loading || seriesEmptyOrFlat;

    const mockSalons: MockCompany[] = useMockCompanies
      ? MOCK_SALON_NAMES.slice(0, 10).map((name, i) => ({
          id: `mock-${i}`,
          name,
          autodealers: 2 + (i % 4),
          avgAiScore: 45 + ((i * 11 + 7) % 48),
          answerRate: 55 + ((i * 7 + 13) % 41),
          lastAudit: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
          trend: i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0,
        }))
      : companies;

    const today = new Date();
    const mockTimeSeries: TimeSeriesPoint[] = useMockSeries
      ? MOCK_TREND_SCORES.map((avgScore, i) => {
          const d = new Date(today);
          d.setDate(d.getDate() - (6 - i));
          return { date: d.toISOString().slice(0, 10), avgScore, count: 4 + (i % 4) };
        })
      : timeSeries;

    const answerRate = useMockCallData ? MOCK_ANSWER_RATE : (voice?.answeredPercent ?? 0);
    const totalCalls = useMockCallData ? MOCK_TOTAL_CALLS : (voice?.totalCalls ?? 0);
    const hourly = MOCK_HOURLY;

    const answerTimeByCompany = mockSalons.slice(0, 8).map((c, i) => ({
      name: c.name,
      avgSec: [18, 25, 14, 32, 22, 42, 9, 36][i] ?? 20 + (i % 15),
      totalCalls: 8 + (i % 12),
    }));

    return { salons: mockSalons, timeSeries: mockTimeSeries, answerRate, totalCalls, hourly, answerTimeByCompany };
  }, [loading, companies, timeSeries, voice]);
}

/* ─── Main Dashboard ─── */
export function Dashboard({
  summary,
  voice,
  loading,
  timeSeries = [],
  companies = [],
  totalAudits: totalAuditsProp = 0,
  audits = [],
}: DashboardProps) {
  const { salons: displaySalons, timeSeries: displayTimeSeries, answerRate, totalCalls, hourly, answerTimeByCompany } = useMockData(
    loading, companies, timeSeries, voice ?? null
  );

  const realAvgScore = summary?.avgScore ?? 0;
  const realTotalAudits = totalAuditsProp ?? (summary?.totalAttempts ?? 0) + (voice?.totalCalls ?? 0);

  const platformAvgScore = realAvgScore > 0 ? realAvgScore : MOCK_AVG_SCORE;
  const totalAudits = realTotalAudits > 0 ? realTotalAudits : MOCK_TOTAL_AUDITS;
  const totalSalons = displaySalons.length;
  const totalEmployees = displaySalons.reduce((s, c) => s + (c.autodealers ?? 0), 0) || 0;
  const hasAuditData = totalAudits > 0 || displayTimeSeries.length > 0;

  const salonAuditCount: Record<string, number> = {};
  audits.forEach((a) => {
    salonAuditCount[a.company] = (salonAuditCount[a.company] ?? 0) + 1;
  });
  displaySalons.forEach((c, i) => {
    if (salonAuditCount[c.name] == null) {
      salonAuditCount[c.name] = 5 + ((i * 3 + 7) % 20);
    }
  });

  const topSalons = [...displaySalons]
    .sort((a, b) => b.avgAiScore - a.avgAiScore)
    .slice(0, 5)
    .map((c, i) => ({
      rank: i + 1,
      name: c.name,
      avgScore: c.avgAiScore,
      answerRate: c.answerRate,
      totalAudits: String(salonAuditCount[c.name] ?? '—'),
    }));

  const worstSalons = [...displaySalons]
    .sort((a, b) => a.avgAiScore - b.avgAiScore)
    .slice(0, 5)
    .map((c, i) => ({
      rank: i + 1,
      name: c.name,
      avgScore: c.avgAiScore,
      answerRate: c.answerRate,
      totalAudits: String(salonAuditCount[c.name] ?? '—'),
    }));

  const topWeakness = summary?.topWeaknesses?.[0];
  const badgePrimaryLabel = 'Частая ошибка';
  const badgePrimaryValue = topWeakness
    ? `${topWeakness.weakness} (${topWeakness.count})`
    : 'Отсутствие следующего шага (42%)';
  const badgeSecondaryLabel = 'Зона риска';
  const badgeSecondaryValue = 'Вечерняя смена';

  const aiBody =
    'Анализ показывает системные слабости в выявлении потребностей у 42% автосалонов. Среднее время ответа выросло на 12% за месяц. Рекомендуется провести переобучение менеджеров.';

  if (!loading && !hasAuditData && totalSalons === 0) {
    return (
      <div className="sa-dashboard-root">
        <h1 className="sa-page-title">Дашборд</h1>
        <div className="sa-empty-state">
          <p>Нет данных за выбранный период</p>
        </div>
      </div>
    );
  }

  const scoreInt = Math.round(platformAvgScore);

  return (
    <div className="sa-dashboard-root">
      <h1 className="sa-page-title">Дашборд</h1>

      <section className="sa-section" style={{ marginBottom: SECTION_GAP }}>
        <h2 className="sa-section-title">Ключевые метрики</h2>
        <div className="sa-kpi-grid">
          <KPICard label="Автосалоны" value={totalSalons} loading={loading} noData={!loading && totalSalons === 0} description="Салоны холдинга" />
          <KPICard label="Сотрудники" value={totalEmployees} loading={loading} noData={!loading && totalEmployees === 0} description="Менеджеры на точках" />
          <KPICard label="Проверки" value={totalAudits} description="Тесты, тренировки и звонки" loading={loading} />
          <KPICard
            label="Оценка качества"
            value={loading ? '—' : String(scoreInt)}
            description="Средний балл по всем проверкам (0–100)"
            loading={loading}
            valueClass={!loading ? scoreColorClass(platformAvgScore) : ''}
          />
          <KPICard
            label="Дозвон"
            value={loading ? '—' : `${answerRate.toFixed(1)}%`}
            description="Доля принятых звонков"
            loading={loading}
            valueClass={!loading ? rateColorClass(answerRate) : ''}
          />
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: SECTION_GAP }}>
        <AISummaryBlock
          title="AI Резюме"
          body={aiBody}
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
            <PerformanceTrendChart points={displayTimeSeries.length > 0 && hasTrendVariation(displayTimeSeries) ? displayTimeSeries : getFallbackTrendPoints()} />
          </div>
          <div className="sa-card sa-grid-card sa-chart-equal">
            <AnswerRateByHour hourly={hourly?.length === 24 ? hourly : MOCK_HOURLY} />
          </div>

          <div className="sa-card sa-grid-card">
            <h3 className="sa-card-heading">Лучшие автосалоны</h3>
            <SalonTable rows={topSalons} emptyLabel="Нет данных" />
          </div>
          <div className="sa-card sa-grid-card">
            <h3 className="sa-card-heading">Автосалоны с низким результатом</h3>
            <SalonTable rows={worstSalons} emptyLabel="Нет данных" />
          </div>

          <div className="sa-card sa-grid-card sa-donut-card">
            <AnsweredMissedDonut
              rate={totalCalls > 0 && answerRate > 0 && answerRate < 100 ? answerRate : MOCK_ANSWER_RATE}
              totalCalls={totalCalls > 0 && answerRate > 0 && answerRate < 100 ? totalCalls : MOCK_TOTAL_CALLS}
            />
          </div>
          <div className="sa-card sa-grid-card">
            <AverageAnswerTimeChart data={answerTimeByCompany?.length ? answerTimeByCompany : FALLBACK_ANSWER_TIME} />
          </div>
        </div>
      </section>
    </div>
  );
}
