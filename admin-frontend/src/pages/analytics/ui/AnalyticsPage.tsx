import React, { useMemo, useState } from 'react';
import type { PlatformSummary } from '../../../shared/model/adminPanel';
import type { TimeSeriesPoint } from '../../../shared/api/adminPanel';
import { ratingClass, exportPageToPdf } from '../../../shared/lib/admin-panel/utils';
import {
  computeAnalyticsSummary,
  type KeyInsight,
  type ActionItem,
  type SectionInsight,
  type Priority,
} from '../../../shared/lib/admin-panel/analyticsEngine';

type AnalyticsProps = {
  summary: PlatformSummary | null;
  timeSeries?: TimeSeriesPoint[];
  loading?: boolean;
  onDrill?: (type: 'employees' | 'dealership' | 'audits', filter?: string) => void;
};

/* ────────────────────── Small reusable sub-components ────────────────────── */

const IMPACT_ICON: Record<KeyInsight['impact'], { icon: string; cls: string }> = {
  high: { icon: '🔴', cls: 'sa-impact-high' },
  medium: { icon: '🟡', cls: 'sa-impact-medium' },
  low: { icon: '🟢', cls: 'sa-impact-low' },
};

const PRIORITY_CLS: Record<Priority, string> = {
  P0: 'sa-priority-p0',
  P1: 'sa-priority-p1',
  P2: 'sa-priority-p2',
};

function InsightMini({ insight }: { insight: SectionInsight }) {
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

/* ────────────────────── Dealership comparison bars ────────────────────── */

function DealershipBars({ data }: { data: { name: string; score: number; delta: number }[] }) {
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
          key={d.name}
          className={`sa-hbar-row ${hoverIdx === i ? 'sa-hbar-row-hover' : ''}`}
          onMouseEnter={() => setHoverIdx(i)}
          onMouseLeave={() => setHoverIdx(null)}
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

/* ════════════════════ Main component ════════════════════ */

export function Analytics({ summary, timeSeries = [], loading = false, onDrill }: AnalyticsProps) {
  const data = useMemo(() => computeAnalyticsSummary(), []);

  return (
    <>
      <h1 className="sa-page-title">Аналитика</h1>
      <p className="sa-page-subtitle">Анализ данных за выбранный период</p>

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
            <p className="sa-meta" style={{ marginTop: 0 }}>Автоматический анализ на основе {data.totalAudits} проверок</p>
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

        {/* ── B) Key insights ── */}
        <div className="sa-key-insights">
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

      {/* ── Dealership comparison ── */}
      <section className="sa-section" style={{ marginTop: 28, marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Динамика по точкам</h2>
          <InsightMini insight={data.trendInsight} />
        </div>
        <div className="sa-card">
          <DealershipBars data={data.dealershipComparison} />
        </div>
      </section>

      {/* ── Top errors ── */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <div className="sa-section-header-row">
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Частые ошибки — Топ 10</h2>
          <InsightMini insight={data.errorsInsight} />
        </div>
        <div className="sa-card">
          {loading ? (
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
    </>
  );
}
