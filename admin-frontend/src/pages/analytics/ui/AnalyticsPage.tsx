import React, { useEffect, useMemo, useState } from 'react';
import type { PlatformSummary } from '../../../shared/model/adminPanel';
import { fetchAnalyticsOverview, fetchHoldings, type AnalyticsOverview, type HoldingItem, type TimeSeriesPoint } from '../../../shared/api/adminPanel';
import { ratingClass, scoreBarColor } from '../../../shared/lib/admin-panel/utils';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';

type AnalyticsProps = {
  summary: PlatformSummary | null;
  timeSeries?: TimeSeriesPoint[];
  loading?: boolean;
  onDrill?: (type: 'employees' | 'dealership' | 'audits' | 'holding', filter?: string) => void;
};

const ANALYTICS_CATEGORY_LABELS = ['Контакт', 'Диагностика', 'Продукт', 'Закрытие', 'Коммуникация'] as const;

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

function NetworkTrendChart({ points }: { points: TimeSeriesPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!points.length) return <div className="sa-chart-empty">Нет данных</div>;
  const W = 960, H = 240;
  const pad = { top: 18, right: 18, bottom: 34, left: 42 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const step = points.length <= 1 ? 0 : cw / (points.length - 1);
  const xs = points.map((_, index) => pad.left + index * step);
  const y = (score: number) => pad.top + ch - (Math.max(0, Math.min(score, 100)) / 100) * ch;
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xs[index]} ${y(point.avgScore)}`).join(' ');
  return (
    <div className="sa-chart-wrap sa-chart-wrap-full">
      <svg
        className="sa-trend-chart-svg"
        width="100%"
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
    : (
      <ul className="sa-analytics-rank-list">
        {items.map((row, index) => (
          <li key={row.id}>
            <button type="button" className="sa-analytics-rank-row" onClick={() => onOpen?.(row.id)}>
              <span className="sa-analytics-rank-idx">{index + 1}</span>
              <span className="sa-analytics-rank-name">{row.name}</span>
              <span className={`sa-analytics-rank-score ${ratingClass(row.score)}`}>{row.score}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="sa-analytics-rank-grid" style={{ marginBottom: 28 }}>
      <div className="sa-analytics-panel">
        <h3 className="sa-analytics-panel-title">Лучшие точки</h3>
        {renderList(best)}
      </div>
      <div className="sa-analytics-panel">
        <h3 className="sa-analytics-panel-title">Худшие точки</h3>
        {renderList(worst)}
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

function ScriptChart({ data }: { data: { block: string; rate: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const rows = ANALYTICS_CATEGORY_LABELS.map((block) => {
    const found = data.find((item) => item.block === block);
    return { block, rate: found?.rate ?? 0 };
  });

  return (
    <div className="sa-hbar-list sa-hbar-list-thin">
      {rows.map((d, i) => (
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

  const W = 960, H = 260;
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
    <div className="sa-chart-wrap sa-chart-wrap-full">
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="sa-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: 'var(--tb-ink, #161613)', display: 'inline-block' }} />
          Собственные
        </span>
        <span className="sa-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: '#9CA3AF', display: 'inline-block' }} />
          Франшиза
        </span>
      </div>
      <svg
        className="sa-trend-chart-svg"
        width="100%"
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
        {data.map((point, i) => (
          <text key={point.week} x={xs[i]} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">{point.week.slice(5)}</text>
        ))}
        <path d={path('ownScore')} fill="none" stroke="var(--tb-ink, #161613)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d={path('franchiseScore')} fill="none" stroke="#9CA3AF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
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

/* ════════════════════ Main component ════════════════════ */

function AnalyticsPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="sa-analytics-panel">
      <h3 className="sa-analytics-panel-title">{title}</h3>
      {children}
    </div>
  );
}

function AnalyticsSplitGroup({
  title,
  leftTitle,
  rightTitle,
  left,
  right,
}: {
  title: string;
  leftTitle: string;
  rightTitle: string;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="sa-analytics-group">
      <h3 className="sa-analytics-group-title">{title}</h3>
      <div className="sa-analytics-split">
        <div className="sa-analytics-split-card">
          <h4 className="sa-analytics-split-title">{leftTitle}</h4>
          {left}
        </div>
        <div className="sa-analytics-split-card">
          <h4 className="sa-analytics-split-title">{rightTitle}</h4>
          {right}
        </div>
      </div>
    </div>
  );
}

export function Analytics({ summary: _summary, timeSeries = [], loading = false, onDrill }: AnalyticsProps) {
  const [data, setData] = useState<AnalyticsOverview>(EMPTY_ANALYTICS);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState(false);
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
  const networkTrend = data.timeSeries ?? timeSeries;
  const rankedRows = useMemo(
    () => [...dealershipRows].sort((a, b) => b.score - a.score),
    [dealershipRows],
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

  return (
    <div className="sa-analytics-root">
      <div className="sa-page-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 20 }}>
        <h1 className="sa-page-title" style={{ marginBottom: 0 }}>Аналитика</h1>
        <HoldingSelectPicker
          holdings={holdings}
          value={selectedHoldingId}
          onChange={setSelectedHoldingId}
          disabled={holdingsLoading || holdings.length === 0}
          loading={holdingsLoading}
        />
      </div>

      {analyticsError && !isLoading ? (
        <div className="sa-empty-state" style={{ marginBottom: 20 }}>
          <p>Не удалось загрузить аналитику. Попробуйте обновить страницу.</p>
        </div>
      ) : null}

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
        <h2 className="sa-section-title">Рекомендуемые действия</h2>
        <div className="sa-analytics-actions">
          {data.actions.length === 0 ? (
            <div className="sa-analytics-action-row">
              <div className="sa-meta">Пока нет рекомендаций для выбранной компании</div>
            </div>
          ) : (
            data.actions.map((act, i) => (
              <div key={i} className="sa-analytics-action-row">
                <div className="sa-analytics-action-body">
                  <div className="sa-analytics-action-target">Топ {i + 1}{act.target ? ` · ${act.target}` : ''}</div>
                  <div className="sa-analytics-action-text">{act.action}</div>
                  <div className="sa-analytics-action-details">
                    <span>Причина: {act.reason}</span>
                    <span>Ожидаемый эффект: {act.expectedEffect}</span>
                  </div>
                </div>
                {act.drillType ? (
                  <button
                    type="button"
                    className="sa-btn-outline sa-btn-sm sa-analytics-action-btn"
                    onClick={() => onDrill?.(act.drillType!, act.drillFilter)}
                  >
                    Перейти
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Рейтинг компаний</h2>
          <div className="sa-meta">Относительно среднего по сети: {data.avgScore}</div>
        </div>
        <div className="sa-companies-table-wrap">
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
                  <tr
                    key={row.id}
                    className="sa-row-clickable"
                    onClick={() => onDrill?.('holding', row.id)}
                  >
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
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Динамика сети: собственные vs франшиза</h2>
          <div className="sa-meta">12 недель по оценённым привязанным звонкам</div>
        </div>
        <div className="sa-card" style={{ marginBottom: 12 }}>
          <WeeklyTypeTrendChart data={data.weeklyTypeTrend ?? []} />
          <div className="sa-meta" style={{ marginTop: 12 }}>{typeComparisonInsight}</div>
        </div>
        {!!data.typeCategoryComparison?.length && (
          <div className="sa-companies-table-wrap" style={{ marginBottom: 12 }}>
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Категория</th>
                  <th className="sa-text-right">Собственные</th>
                  <th className="sa-text-right">Франшиза</th>
                </tr>
              </thead>
              <tbody>
                {data.typeCategoryComparison.map((row) => (
                  <tr key={row.category}>
                    <td>{row.category}</td>
                    <td className="sa-text-right"><span className={ratingClass(row.ownScore)}>{row.ownScore}</span></td>
                    <td className="sa-text-right"><span className={ratingClass(row.franchiseScore)}>{row.franchiseScore}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="sa-analytics-panels sa-analytics-panels-2">
          <AnalyticsPanel title="Топ-ошибки · собственные">
            <IssueList items={data.typeTopErrors?.own ?? []} />
          </AnalyticsPanel>
          <AnalyticsPanel title="Топ-ошибки · франшиза">
            <IssueList items={data.typeTopErrors?.franchise ?? []} />
          </AnalyticsPanel>
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Рейтинг точек</h2>
          <div className="sa-meta">Позиция, отклонение от среднего сети и динамика</div>
        </div>
        <div className="sa-companies-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
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
                <tr><td colSpan={9} className="sa-meta" style={{ padding: 24 }}>Нет привязанных точек для аналитики</td></tr>
              ) : (
                rankedRows.map((row, index) => (
                  <tr key={row.id} className="sa-row-clickable" onClick={() => onDrill?.('dealership', row.id)}>
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
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Лидеры и отстающие</h2>
          <div className="sa-meta">Ошибки и сложные вопросы из справочника</div>
        </div>
        <div className="sa-analytics-groups">
          <AnalyticsSplitGroup
            title="Ошибки"
            leftTitle="Лидеры"
            rightTitle="Отстающие"
            left={<IssueList items={data.leadersLaggards?.leadersErrors ?? []} />}
            right={<IssueList items={data.leadersLaggards?.laggardsErrors ?? []} />}
          />
          <AnalyticsSplitGroup
            title="Сложные вопросы"
            leftTitle="Лидеры"
            rightTitle="Отстающие"
            left={<IssueList items={data.leadersLaggards?.leadersQuestions ?? []} labelKey="question" />}
            right={<IssueList items={data.leadersLaggards?.laggardsQuestions ?? []} labelKey="question" />}
          />
        </div>
        <div className="sa-meta" style={{ marginTop: 12 }}>{topProblemInsight}</div>
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <h2 className="sa-section-title">Распределение по категориям</h2>
        <div className="sa-card">
          <ScriptChart data={data.scriptCompliance} />
        </div>
      </section>
    </div>
  );
}
