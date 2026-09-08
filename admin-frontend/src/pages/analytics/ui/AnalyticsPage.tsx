import React, { useEffect, useMemo, useState } from 'react';
import type { PlatformSummary } from '../../../shared/model/adminPanel';
import { fetchAnalyticsOverview, fetchHoldings, type AnalyticsOverview, type HoldingItem } from '../../../shared/api/adminPanel';
import { deltaDisplay, ratingClass, scoreBarColor } from '../../../shared/lib/admin-panel/utils';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { BrutalCard } from '../../../shared/ui/brutal-card';

type AnalyticsProps = {
  summary: PlatformSummary | null;
  loading?: boolean;
  onDrill?: (type: 'employees' | 'dealership' | 'audits' | 'holding', filter?: string) => void;
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
  weeklyTypeTrend: [],
  scriptCompliance: [],
};

type ComparableDealership = NonNullable<AnalyticsOverview['dealershipRows']>[number];

function formatSignedHundredths(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}`;
}


function scoreColorClass(score: number): 'sa-score-green' | 'sa-score-orange' | 'sa-score-red' {
  if (score >= 80) return 'sa-score-green';
  if (score >= 50) return 'sa-score-orange';
  return 'sa-score-red';
}

function trendColorClass(value: number | null): 'sa-score-green' | 'sa-score-red' | '' {
  if (value === null || value === 0) return '';
  return value > 0 ? 'sa-score-green' : 'sa-score-red';
}

function BestWorstCards({ rows, onOpen }: { rows: ComparableDealership[]; onOpen?: (id: string) => void }) {
  const active = rows.filter((row) => row.calls > 0);
  const best = [...active].sort((a, b) => b.score - a.score).slice(0, 3);
  const worst = [...active].sort((a, b) => a.score - b.score).slice(0, 3);
  const renderTable = (items: ComparableDealership[]) => items.length === 0
    ? <div className="sa-table-empty">Нет данных</div>
    : (
      <div className="sa-table-wrap sa-table-in-card" style={{ justifyContent: 'flex-start' }}>
        <table className="sa-table sa-table-colored">
          <thead>
            <tr>
              <th>#</th>
              <th>Точка</th>
              <th>AI-рейтинг</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row, index) => (
              <tr
                key={row.id}
                className="sa-row-clickable"
                role="button"
                tabIndex={0}
                onClick={() => onOpen?.(row.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen?.(row.id);
                  }
                }}
              >
                <td>{index + 1}</td>
                <td>{row.name}</td>
                <td><span className={scoreColorClass(row.score)}>{row.score}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="sa-dashboard-grid" style={{ marginBottom: 28 }}>
      <BrutalCard title="Лучшие точки" className="sa-grid-card">
        {renderTable(best)}
      </BrutalCard>
      <BrutalCard title="Худшие точки" className="sa-grid-card">
        {renderTable(worst)}
      </BrutalCard>
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

function CategoryBreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ block: string; rate: number }>;
}) {
  if (!rows.length) return <div className="sa-chart-empty">Нет данных</div>;
  return (
    <BrutalCard title={title} className="sa-grid-card">
      <div className="sa-hbar-list sa-hbar-list-thin">
        {[...rows].sort((a, b) => a.rate - b.rate).map((item) => (
          <div key={item.block} className="sa-hbar-row">
            <span className="sa-hbar-label">{item.block}</span>
            <div className="sa-hbar-track">
              <div className="sa-hbar-fill" style={{ width: `${item.rate}%`, background: scoreBarColor(item.rate) }} />
            </div>
            <span className={`sa-hbar-score ${ratingClass(item.rate)}`}>{item.rate}%</span>
          </div>
        ))}
      </div>
    </BrutalCard>
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
          const tw = 176, th = 68;
          const tx = Math.min(Math.max(xs[hoverIdx] - tw / 2, 4), W - tw - 4);
          const ty = Math.max(4, y(Math.max(point.ownScore, point.franchiseScore)) - th - 12);
          return (
            <g>
              <line x1={xs[hoverIdx]} y1={pad.top} x2={xs[hoverIdx]} y2={pad.top + ch} stroke="var(--sa-text-secondary)" strokeWidth="1" strokeDasharray="3" opacity="0.35" />
              <rect x={tx} y={ty} width={tw} height={th} rx="8" fill="#1F2937" opacity="0.92" />
              <text x={tx + 10} y={ty + 16} fontSize="10" fill="#D1D5DB">Неделя: {point.week}</text>
              <text x={tx + 10} y={ty + 34} fontSize="10" fill="#F9FAFB">Собственные: {point.ownScore} ({point.ownCount})</text>
              <text x={tx + 10} y={ty + 52} fontSize="10" fill="#F9FAFB">Франшиза: {point.franchiseScore} ({point.franchiseCount})</text>
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

export function Analytics({ summary: _summary, loading = false, onDrill }: AnalyticsProps) {
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

  return (
    <div className="sa-analytics-root">
      <div className="sa-page-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 className="sa-page-title" style={{ marginBottom: 0 }}>Аналитика</h1>
          <div className="sa-meta">За 30 дней</div>
        </div>
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
        <div className="sa-card" style={{ marginBottom: 12, position: 'relative' }}>
          <WeeklyTypeTrendChart data={data.weeklyTypeTrend ?? []} />
          <div className="sa-meta" style={{ marginTop: 12 }}>{typeComparisonInsight}</div>
        </div>

        <BestWorstCards rows={dealershipRows} onOpen={(id) => onDrill?.('dealership', id)} />
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Собственные vs франшиза</h2>
        </div>
        {!!data.typeCategoryComparison?.length && (
          <div className="sa-dashboard-grid" style={{ marginBottom: 12, alignItems: 'start' }}>
            <CategoryBreakdownCard
              title="Собственные"
              rows={data.typeCategoryComparison.map((row) => ({ block: row.category, rate: row.ownScore }))}
            />
            <CategoryBreakdownCard
              title="Франшиза"
              rows={data.typeCategoryComparison.map((row) => ({ block: row.category, rate: row.franchiseScore }))}
            />
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
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Сравнение по типам номеров</h2>
        </div>
        <div className="sa-companies-table-wrap">
          <table className="sa-table">
            <thead><tr><th>Источник</th><th>Владение</th><th className="sa-text-right">AI-рейтинг</th><th className="sa-text-right">Откл. от сети</th><th className="sa-text-right">Динамика 30d</th><th className="sa-text-right">Звонков</th><th className="sa-text-right">Недозвоны</th></tr></thead>
            <tbody>
              {(data.phoneNumberTypeComparison ?? []).length === 0 ? <tr><td colSpan={7} className="sa-meta" style={{ padding: 24 }}>Недостаточно звонков с определённым типом номера</td></tr> : (data.phoneNumberTypeComparison ?? []).map((row, index, all) => (
                <tr key={row.id}>
                  {(() => {
                    const trend = deltaDisplay(row.trend);
                    return (
                      <>
                  <td><div className="sa-cell-name">{row.name}</div><div className="sa-cell-city">{index === 0 ? 'Лидер' : index === all.length - 1 && all.length > 1 ? 'Отстающий' : '—'}</div></td>
                  <td>{row.ownership === 'dealership' ? 'Для точек' : row.ownership === 'user' ? 'Для пользователей' : '—'}</td>
                  <td className="sa-text-right"><span className={ratingClass(row.score)}>{row.score}</span></td>
                  <td className="sa-text-right">{formatSignedHundredths(row.delta)}</td>
                  <td className="sa-text-right"><span className={trend.cls}>{trend.text}</span></td>
                  <td className="sa-text-right">{row.calls}</td>
                  <td className="sa-text-right">{row.noAnswers ?? 0}</td>
                      </>
                    );
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Рейтинг точек</h2>
        </div>
        <div className="sa-companies-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th className="sa-text-right">#</th>
                <th>Точка</th>
                <th>Компания</th>
                <th>Тип</th>
                <th className="sa-text-right">AI-рейтинг</th>
                <th className="sa-text-right">Откл. от сети</th>
                <th className="sa-text-right">Динамика 30d</th>
                <th className="sa-text-right">Звонков</th>
                <th className="sa-text-right">Недозвоны</th>
              </tr>
            </thead>
            <tbody>
              {dealershipRows.length === 0 ? (
                <tr><td colSpan={9} className="sa-meta" style={{ padding: 24 }}>Нет привязанных точек для аналитики</td></tr>
              ) : (
                rankedRows.map((row, index) => {
                  const trend = deltaDisplay(row.delta);
                  return (
                    <tr key={row.id} className="sa-row-clickable" onClick={() => onDrill?.('dealership', row.id)}>
                      <td className="sa-text-right">{index + 1}</td>
                      <td style={{ fontWeight: 600 }}>{row.name}</td>
                      <td>{row.dealer}</td>
                      <td>{row.type === 'franchised' ? 'Франшиза' : 'Собственная'}</td>
                      <td className="sa-text-right"><span className={ratingClass(row.score)}>{row.score}</span></td>
                      <td className="sa-text-right">{formatSignedHundredths(row.score - data.avgScore)}</td>
                      <td className="sa-text-right"><span className={trend.cls}>{trend.text}</span></td>
                      <td className="sa-text-right">{row.calls}</td>
                      <td className="sa-text-right">{row.noAnswers ?? 0}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Лидеры и отстающие</h2>
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
      </section>

    </div>
  );
}
