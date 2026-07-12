import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  STATUS_LABELS,
  type EmployeeDetailData,
} from '../../../shared/lib/admin-panel/mockData';
import { ratingClass, statusBadgeClass, scoreBarColor, answerRateClass } from '../../../shared/lib/admin-panel/utils';
import {
  excludeManagerFromAnalyticsPlan,
  fetchAuditDetail,
  fetchAnalyticsManagerDetail,
  fetchAnalyticsManagerPlans,
  type AuditDetailItem,
  type AnalyticsAISummary,
  type AnalyticsPlanParticipation,
} from '../../../shared/api/adminPanel';
import { SlideOver } from '../../../shared/ui/slide-over';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import { CallOutcomeBreakdown } from '../../../shared/ui/call-outcome-breakdown';
import { AuditHistoryBlock } from '../../../shared/ui/audit-history-block';

type Props = {
  employeeId: string;
  onBack: () => void;
  onOpenDealership?: (id: string) => void;
  onOpenCompanies?: () => void;
  sourceDealership?: { id: string; name: string } | null;
  actionButtons?: React.ReactNode;
  headerRight?: React.ReactNode;
  mockNotice?: string;
  detailOverride?: Partial<Pick<EmployeeDetailData, 'fullName' | 'dealershipName' | 'city'>>;
};

type ManagerOutcomeBreakdown = {
  completed: number;
  no_answer: number;
  busy: number;
  failed: number;
  disconnected: number;
};

type ManagerAnalyticsDetail = EmployeeDetailData & {
  accountId?: string | null;
  aiSummary?: AnalyticsAISummary;
  answerRate?: number | null;
  noAnswers?: number;
  noAnswerRate?: number;
  directCalls?: number;
  dealershipCalls?: number;
  dealershipRank?: { rank: number; total: number } | null;
  outcomeBreakdown?: ManagerOutcomeBreakdown;
  communicationBreakdown?: { label: string; percent: number; color: string }[];
  comparisonTimeSeries?: { date: string; managerScore: number; dealershipScore: number; networkScore: number }[];
  noAnswerHistory?: { id: string; date: string; planName: string | null; verdict: string }[];
  trainer?: {
    totalPoints: number;
    currentStreak: number;
    longestStreak: number;
    sessionsTotal: number;
    sessions30d: number;
    avgScore: number;
    weeklyScore: { date: string; avgScore: number; count: number }[];
    weakPatterns: { issue: string; percent: number }[];
    history: Array<{ id: string; date: string; type: string; scenarioName: string; score: number | null; finalPoints: number | null; status: string }>;
  };
};

/* ────────────────────── KPI Card ────────────────────── */

function CompactKpi({
  label,
  value,
  cls,
  valueSuffix,
}: {
  label: string;
  value: string | number;
  cls?: string;
  valueSuffix?: string;
}) {
  return (
    <div className="sa-trainer-stat">
      <div className="sa-trainer-stat-label">{label}</div>
      {valueSuffix ? (
        <div className="sa-kpi-value-row">
          <span className={`sa-trainer-stat-value ${cls ?? ''}`}>{value}</span>
          <span className="sa-kpi-value-suffix">{valueSuffix}</span>
        </div>
      ) : (
        <div className={`sa-trainer-stat-value ${cls ?? ''}`}>{value}</div>
      )}
    </div>
  );
}

function EmployeeMetricCard({
  label,
  value,
  description,
  valueClass,
  valueSuffix,
}: {
  label: string;
  value: React.ReactNode;
  description?: React.ReactNode;
  valueClass?: string;
  valueSuffix?: string;
}) {
  return (
    <div className="sa-card sa-kpi-card sa-kpi-card-air sa-brutal-card">
      <div className="sa-kpi-card-top">
        <div className="sa-kpi-card-heading">{label}</div>
      </div>
      <div className="sa-kpi-card-spacer" aria-hidden />
      <div className="sa-kpi-card-bottom">
        {valueSuffix ? (
          <div className="sa-kpi-value-row">
            <span className={`sa-kpi-value sa-kpi-value-large ${valueClass ?? ''}`}>{value}</span>
            <span className="sa-kpi-value-suffix">{valueSuffix}</span>
          </div>
        ) : (
          <div className={`sa-kpi-value sa-kpi-value-large ${valueClass ?? ''}`}>{value}</div>
        )}
        {description && <div className="sa-kpi-desc">{description}</div>}
      </div>
    </div>
  );
}

function planFrequencyLabel(value: AnalyticsPlanParticipation['frequency']): string {
  if (value === 'manual') return 'Вручную';
  return value === 'weekly' ? 'Еженедельно' : 'Ежедневно';
}

function planTargetLabel(plan: AnalyticsPlanParticipation): string {
  return plan.targetMatch === 'dealership' ? 'Через расписание точки' : 'Лично в расписании';
}

function PlanParticipationList({
  plans,
  excludingPlanId,
  onOpenPlan,
  onExcludePlan,
}: {
  plans: AnalyticsPlanParticipation[];
  excludingPlanId: string | null;
  onOpenPlan: (id: string) => void;
  onExcludePlan: (plan: AnalyticsPlanParticipation) => void;
}) {
  if (plans.length === 0) {
    return <div className="sa-meta" style={{ padding: 18 }}>Нет активных расписаний</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {plans.map((plan) => (
        <div key={plan.id} className="sa-card" style={{ padding: 14, display: 'flex', gap: 14, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 220 }}>
            <div style={{ fontWeight: 700, color: 'var(--sa-text-primary)' }}>{plan.name}</div>
            <div className="sa-meta" style={{ marginTop: 4 }}>
              {planTargetLabel(plan)} · {planFrequencyLabel(plan.frequency)}
              {plan.frequency !== 'manual' ? ` · ${plan.callTimeFrom}-${plan.callTimeTo}` : ''}
              {plan.lastInitiatedAt ? ` · последний запуск ${new Date(plan.lastInitiatedAt).toLocaleDateString('ru-RU')}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="sa-btn-outline sa-btn-sm" onClick={() => onOpenPlan(plan.id)}>Настроить</button>
            <button
              className="sa-btn-outline sa-btn-sm"
              disabled={plan.targetMatch === 'dealership' || excludingPlanId === plan.id}
              title={plan.targetMatch === 'dealership' ? 'Менеджер участвует через расписание всей точки. Откройте настройки плана.' : undefined}
              onClick={() => onExcludePlan(plan)}
            >
              {excludingPlanId === plan.id ? 'Исключаем...' : 'Исключить'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────── Trend Chart ────────────────────── */

function TrendChart({
  points,
  title,
  variant = 'full',
}: {
  points: { date: string; avgScore: number; count: number }[];
  title?: string;
  variant?: 'full' | 'panel';
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (points.length === 0) return <div className="sa-chart-empty">Нет данных за период</div>;

  const W = variant === 'panel' ? 640 : 960;
  const H = variant === 'panel' ? 300 : 260;
  const pad = { top: 20, right: 24, bottom: 36, left: 44 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const step = points.length <= 1 ? 0 : cw / (points.length - 1);
  const xs = points.map((_, i) => pad.left + i * step);
  const ys = points.map((p) => pad.top + ch - (p.avgScore / 100) * ch);
  const pathD = points.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${ys[i]}`).join(' ');
  const stroke = 'var(--tb-ink)';
  const fillId = variant === 'panel' ? 'empTrendFillPanel' : 'empTrendFill';

  return (
    <div className={`sa-chart-wrap${variant === 'full' ? ' sa-chart-wrap-full' : ' sa-chart-wrap-panel'}`}>
      {title ? <h3 className="sa-chart-title">{title}</h3> : null}
      <div className="sa-chart-plot">
      <svg className="sa-trend-chart-svg" width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.14" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((v) => {
          const y = pad.top + ch - (v / 100) * ch;
          return (
            <g key={v}>
              <line x1={pad.left} y1={y} x2={pad.left + cw} y2={y} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
              <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">{v}</text>
            </g>
          );
        })}
        {points.map((p, i) => (
          <text key={p.date} x={xs[i]} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">{p.date.slice(5)}</text>
        ))}
        <path d={`${pathD} L ${xs[xs.length - 1]} ${pad.top + ch} L ${xs[0]} ${pad.top + ch} Z`} fill={`url(#${fillId})`} />
        <path d={pathD} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((_, i) => (
          <rect key={`h-${i}`} x={xs[i] - step / 2} y={pad.top} width={step || 40} height={ch} fill="transparent" onMouseEnter={() => setHoverIdx(i)} />
        ))}
        {hoverIdx !== null && <line x1={xs[hoverIdx]} y1={pad.top} x2={xs[hoverIdx]} y2={pad.top + ch} stroke="var(--sa-text-secondary)" strokeWidth="1" strokeDasharray="3" opacity="0.4" />}
        {points.map((p, i) => (
          <circle key={p.date} cx={xs[i]} cy={ys[i]} r={hoverIdx === i ? 5.5 : 4} fill={hoverIdx === i ? '#fff' : stroke} stroke={stroke} strokeWidth={hoverIdx === i ? 2.5 : 0} style={{ transition: 'r .15s, fill .15s', cursor: 'pointer' }} />
        ))}
      </svg>
      {hoverIdx !== null && (() => {
        const p = points[hoverIdx];
        const leftPct = (xs[hoverIdx] / W) * 100;
        const topPct = (ys[hoverIdx] / H) * 100;
        const placeBelow = topPct < 28;
        return (
          <div
            className={`sa-chart-hover-tooltip${placeBelow ? ' sa-chart-hover-tooltip-below' : ''}`}
            style={{ left: `${leftPct}%`, top: `${topPct}%` }}
          >
            <div className="sa-chart-hover-tooltip-row">Дата: {p.date}</div>
            <div className="sa-chart-hover-tooltip-row is-strong">Балл: {p.avgScore.toFixed(1)}</div>
            <div className="sa-chart-hover-tooltip-row">Проверок: {p.count}</div>
          </div>
        );
      })()}
      </div>
    </div>
  );
}

function ComparisonTrendChart({ points }: { points?: { date: string; managerScore: number; dealershipScore: number; networkScore: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!points || points.length === 0) return <div className="sa-chart-empty">Нет данных за период</div>;

  const W = 960, H = 260;
  const pad = { top: 20, right: 24, bottom: 36, left: 44 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const step = points.length <= 1 ? 0 : cw / (points.length - 1);
  const xs = points.map((_, i) => pad.left + i * step);
  const y = (score: number) => pad.top + ch - (Math.max(0, Math.min(score, 100)) / 100) * ch;
  const path = (key: 'managerScore' | 'dealershipScore' | 'networkScore') => points
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${y(point[key])}`)
    .join(' ');
  const series = [
    { key: 'managerScore' as const, label: 'Менеджер', color: 'var(--tb-ink)' },
    { key: 'dealershipScore' as const, label: 'Салон', color: 'var(--tb-status-green)' },
    { key: 'networkScore' as const, label: 'Сеть', color: 'var(--tb-status-orange)' },
  ];

  return (
    <div className="sa-chart-wrap sa-chart-wrap-full">
      <h3 className="sa-chart-title">Менеджер vs салон vs сеть</h3>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        {series.map((item) => (
          <span key={item.key} className="sa-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: item.color, display: 'inline-block' }} />
            {item.label}
          </span>
        ))}
      </div>
      <div className="sa-chart-plot">
      <svg className="sa-trend-chart-svg" width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setHoverIdx(null)}>
        {[0, 25, 50, 75, 100].map((value) => {
          const gy = y(value);
          return (
            <g key={value}>
              <line x1={pad.left} y1={gy} x2={pad.left + cw} y2={gy} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
              <text x={pad.left - 8} y={gy + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">{value}</text>
            </g>
          );
        })}
        {points.map((point, i) => (
          <text key={point.date} x={xs[i]} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">{point.date.slice(5)}</text>
        ))}
        {series.map((item) => (
          <path key={item.key} d={path(item.key)} fill="none" stroke={item.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {points.map((_, i) => (
          <rect key={`hit-${i}`} x={xs[i] - step / 2} y={pad.top} width={step || 40} height={ch} fill="transparent" onMouseEnter={() => setHoverIdx(i)} />
        ))}
        {hoverIdx !== null && (() => {
          const point = points[hoverIdx];
          const tw = 180, th = 78;
          const tx = Math.min(Math.max(xs[hoverIdx] - tw / 2, 4), W - tw - 4);
          const ty = Math.max(4, y(point.managerScore) - th - 14);
          return (
            <g>
              <line x1={xs[hoverIdx]} y1={pad.top} x2={xs[hoverIdx]} y2={pad.top + ch} stroke="var(--sa-text-secondary)" strokeWidth="1" strokeDasharray="3" opacity="0.35" />
              <rect x={tx} y={ty} width={tw} height={th} rx="8" fill="#1F2937" opacity="0.92" />
              <text x={tx + 12} y={ty + 18} fontSize="11" fill="#D1D5DB">Дата: {point.date}</text>
              <text x={tx + 12} y={ty + 36} fontSize="11" fill="#F9FAFB">Менеджер: {point.managerScore}</text>
              <text x={tx + 12} y={ty + 52} fontSize="11" fill="#D1D5DB">Салон: {point.dealershipScore}</text>
              <text x={tx + 12} y={ty + 68} fontSize="11" fill="#D1D5DB">Сеть: {point.networkScore}</text>
            </g>
          );
        })()}
      </svg>
      </div>
    </div>
  );
}

/* ────────────────────── Block Breakdown — horizontal bars (fully readable labels) ────────────────────── */

function BlockBreakdown({ data }: { data: { block: string; score: number; hint: string }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!data || data.length === 0) return <div className="sa-chart-empty">Нет данных</div>;

  return (
    <div className="sa-chart-wrap">
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
              <div className="sa-hbar-fill" style={{ width: `${d.score}%`, background: scoreBarColor(d.score) }} />
            </div>
            <span className={`sa-hbar-score ${ratingClass(d.score)}`}>{d.score}</span>
            {hoverIdx === i && (
              <div className="sa-hbar-tooltip">{d.hint}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CommunicationBreakdown({ data }: { data?: { label: string; percent: number; color: string }[] }) {
  const visible = (data ?? []).filter((item) => item.percent > 0);
  if (visible.length === 0) return <div className="sa-chart-empty">Нет оценки коммуникации</div>;
  return (
    <div className="sa-comm-grid">
      {visible.map((item) => (
        <div key={item.label} className="sa-comm-stat">
          <div className="sa-comm-stat-bar" style={{ background: item.color, width: `${Math.max(item.percent, 4)}%` }} />
          <div className="sa-comm-stat-info">
            <span className="sa-comm-stat-label">{item.label}</span>
            <span className="sa-comm-stat-pct" style={{ color: item.color }}>{item.percent}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DataCoverage({ detail }: { detail: ManagerAnalyticsDetail }) {
  const direct = detail.directCalls ?? detail.auditsCount;
  const dealership = detail.dealershipCalls ?? direct;
  const pct = dealership > 0 ? Math.round((direct / dealership) * 100) : 0;
  return (
    <div className="sa-hbar-list">
      <div className="sa-hbar-row">
        <span className="sa-hbar-label">Прямые звонки менеджера</span>
        <div className="sa-hbar-track">
          <div className="sa-hbar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: '#6366F1' }} />
        </div>
        <span className="sa-hbar-score">{direct}</span>
      </div>
      <div className="sa-hbar-row">
        <span className="sa-hbar-label">Все звонки точки</span>
        <div className="sa-hbar-track">
          <div className="sa-hbar-fill" style={{ width: '100%', background: '#CBD5E1' }} />
        </div>
        <span className="sa-hbar-score">{dealership}</span>
      </div>
      <div className="sa-meta" style={{ marginTop: 8 }}>
        Персональная выборка менеджера: {pct}% от звонков точки.
      </div>
    </div>
  );
}

/* ────────────────────── Trainer insights ────────────────────── */

function TrainerInsights({ detail }: { detail: ManagerAnalyticsDetail }) {
  return (
    <div className="sa-detail-insights">
      <div className="sa-card">
        <h3 className="sa-card-heading">ТОП-5 типовых ошибок</h3>
        <ul className="sa-issue-list">
          {detail.topIssues.map((item, i) => (
            <li key={i} className="sa-issue-item">
              <span className="sa-issue-index">{i + 1}</span>
              <span className="sa-issue-name" title={item.issue}>{item.issue}</span>
              <span className="sa-issue-pct">{item.percent}%</span>
              <div className="sa-issue-bar"><div className="sa-issue-bar-fill" style={{ width: `${item.percent}%` }} /></div>
            </li>
          ))}
        </ul>
      </div>
      <div className="sa-card">
        <h3 className="sa-card-heading">ТОП-5 сложных вопросов</h3>
        <ul className="sa-issue-list">
          {detail.topQuestions.map((q, i) => (
            <li key={i} className="sa-issue-item sa-question-item">
              <span className="sa-issue-index">{i + 1}</span>
              <span className="sa-issue-name">{q}</span>
              <span className="sa-issue-pct sa-issue-pct-ghost" aria-hidden>00%</span>
              <div className="sa-question-rule" aria-hidden />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TrainerRecommendations({
  items,
  onOpenProblem,
}: {
  items: ManagerAnalyticsDetail['recommendedTrainings'];
  onOpenProblem?: (issue: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="sa-card sa-recommendations-empty">
        <div className="sa-recommendations-empty-title">Пока нет рекомендаций</div>
        <div className="sa-training-item-desc">Когда появятся повторяющиеся ошибки, здесь будут конкретные шаги по улучшению.</div>
      </div>
    );
  }
  return (
    <div className="sa-recommendations-grid">
      {items.map((t, i) => (
        <article key={i} className="sa-recommendation-card">
          <div className="sa-recommendation-card-index" aria-hidden>{i + 1}</div>
          <div className="sa-recommendation-card-body">
            <h3 className="sa-recommendation-card-title">{t.title}</h3>
            <p className="sa-recommendation-card-desc">{t.description}</p>
          </div>
          {onOpenProblem && (
            <button type="button" className="sa-btn-text sa-recommendation-card-action" onClick={() => onOpenProblem(t.title)}>
              Открыть проверки →
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

function TrainerStats({
  detail,
  onOpenTraining,
}: {
  detail: ManagerAnalyticsDetail;
  onOpenTraining: (sessionId: string) => void;
}) {
  const trainer = detail.trainer;
  if (!trainer) {
    return <div className="sa-card"><div className="sa-meta" style={{ padding: 18 }}>Данных тренажёра пока нет.</div></div>;
  }
  const recentHistory = trainer.history.slice(0, 5);

  return (
    <div className="sa-card" style={{ padding: 18 }}>
      <div className="sa-trainer-stats-grid">
        <CompactKpi label="Средний балл" value={trainer.avgScore} cls={ratingClass(trainer.avgScore)} />
        <CompactKpi label="Очки" value={trainer.totalPoints} />
        <CompactKpi label="Стрик" value={trainer.currentStreak} valueSuffix="День" />
        <CompactKpi label="Сессии 30 дней" value={trainer.sessions30d} />
      </div>
      <div className="sa-dashboard-grid sa-trainer-panels" style={{ marginBottom: 18 }}>
        <div className="sa-card sa-grid-card sa-chart-equal" style={{ boxShadow: 'none', border: '1px solid var(--sa-divider)' }}>
          <TrendChart points={trainer.weeklyScore} title="Динамика" variant="panel" />
        </div>
        <div className="sa-card sa-grid-card sa-chart-equal" style={{ boxShadow: 'none', border: '1px solid var(--sa-divider)' }}>
          <h3 className="sa-card-heading">Слабые места</h3>
          {trainer.weakPatterns.length === 0 ? (
            <div className="sa-chart-empty">Повторяющихся паттернов нет</div>
          ) : (
            <ul className="sa-issue-list">
              {trainer.weakPatterns.map((item, index) => (
                <li key={index} className="sa-issue-item">
                  <span className="sa-issue-name" title={item.issue}>{item.issue}</span>
                  <span className="sa-issue-pct">{item.percent}%</span>
                  <div className="sa-issue-bar"><div className="sa-issue-bar-fill" style={{ width: `${item.percent}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h3 className="sa-card-heading">Последние тренировки</h3>
      {recentHistory.length === 0 ? (
        <div className="sa-meta" style={{ padding: 18 }}>Менеджер ещё не проходил тренировки.</div>
      ) : (
        <div className="sa-table-wrap" style={{ boxShadow: 'none', border: '1px solid var(--sa-divider)' }}>
          <table className="sa-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Сценарий</th>
                <th>Режим</th>
                <th className="sa-text-right">Балл</th>
                <th className="sa-text-right">Очки</th>
              </tr>
            </thead>
            <tbody>
              {recentHistory.map((item) => (
                <tr
                  key={item.id}
                  className="sa-row-clickable"
                  onClick={() => onOpenTraining(item.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpenTraining(item.id);
                  }}
                  title="Открыть отчёт тренировки"
                >
                  <td>{new Date(item.date).toLocaleDateString('ru-RU')}</td>
                  <td>{item.scenarioName}</td>
                  <td>{item.type === 'plan' ? 'План' : 'Свободная'}</td>
                  <td className="sa-text-right"><span className={ratingClass(item.score ?? 0)}>{item.score ?? '—'}</span></td>
                  <td className="sa-text-right">{item.finalPoints ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ════════════════════ Main component ════════════════════ */

export function EmployeeDetail({ employeeId, onBack, onOpenDealership, onOpenCompanies, sourceDealership, actionButtons, headerRight, mockNotice, detailOverride }: Props) {
  const navigate = useNavigate();
  const [realDetail, setRealDetail] = useState<ManagerAnalyticsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [planParticipation, setPlanParticipation] = useState<AnalyticsPlanParticipation[]>([]);
  const [planActionStatus, setPlanActionStatus] = useState<string | null>(null);
  const [excludingPlanId, setExcludingPlanId] = useState<string | null>(null);
  const [analyticsDrawerOpen, setAnalyticsDrawerOpen] = useState(false);
  const [analyticsDrawerLoading, setAnalyticsDrawerLoading] = useState(false);
  const [analyticsDrawerError, setAnalyticsDrawerError] = useState<string | null>(null);
  const [analyticsDrawerDetail, setAnalyticsDrawerDetail] = useState<AuditDetailItem | null>(null);
  const detail = useMemo(() => {
    if (!realDetail) return null;
    return {
      ...realDetail,
      // Shell override only fills gaps; API location wins once loaded
      fullName: detailOverride?.fullName || realDetail.fullName,
      dealershipName: realDetail.dealershipName || detailOverride?.dealershipName || '',
      city: realDetail.city || detailOverride?.city || '',
    };
  }, [detailOverride, realDetail]);

  const shellName = detailOverride?.fullName || realDetail?.fullName || null;
  const shellDealership = realDetail?.dealershipName || detailOverride?.dealershipName || null;
  const shellCity = realDetail?.city || detailOverride?.city || null;

  useEffect(() => {
    let cancelled = false;
    setRealDetail(null);
    setPlanParticipation([]);
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([
      fetchAnalyticsManagerDetail(employeeId),
      fetchAnalyticsManagerPlans(employeeId),
    ])
      .then(([item, plans]) => {
        if (!cancelled) {
          setRealDetail(item as ManagerAnalyticsDetail | null);
          setPlanParticipation(plans);
          setDetailLoading(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRealDetail(null);
          setPlanParticipation([]);
          setDetailError(error instanceof Error ? error.message : 'Не удалось загрузить данные сотрудника');
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  async function reloadPlanParticipation() {
    const plans = await fetchAnalyticsManagerPlans(employeeId);
    setPlanParticipation(plans);
  }

  async function handleExcludePlan(plan: AnalyticsPlanParticipation) {
    const confirmed = window.confirm(`Исключить сотрудника «${detail?.fullName ?? shellName ?? ''}» из расписания «${plan.name}»?`);
    if (!confirmed) return;
    setPlanActionStatus(null);
    setExcludingPlanId(plan.id);
    try {
      await excludeManagerFromAnalyticsPlan(employeeId, plan.id);
      await reloadPlanParticipation();
      setPlanActionStatus('Сотрудник исключён из расписания');
    } catch (error) {
      setPlanActionStatus(error instanceof Error ? error.message : 'Не удалось исключить сотрудника из расписания');
    } finally {
      setExcludingPlanId(null);
    }
  }

  function closeAnalyticsDrawer() {
    setAnalyticsDrawerOpen(false);
    setAnalyticsDrawerLoading(false);
    setAnalyticsDrawerError(null);
    setAnalyticsDrawerDetail(null);
  }

  async function handleOpenAuditDetail(auditId: string) {
    setAnalyticsDrawerOpen(true);
    setAnalyticsDrawerLoading(true);
    setAnalyticsDrawerError(null);
    setAnalyticsDrawerDetail(null);
    try {
      const detail = await fetchAuditDetail(auditId);
      setAnalyticsDrawerDetail(detail);
    } catch (error) {
      setAnalyticsDrawerError(error instanceof Error ? error.message : 'Не удалось загрузить аналитику');
    } finally {
      setAnalyticsDrawerLoading(false);
    }
  }

  if (detailError && !detail) {
    return (
      <div>
        <button className="sa-btn-text" onClick={onBack}>← Сотрудники</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>{detailError}</div>
      </div>
    );
  }

  if (!detail && !shellName && detailLoading) {
    return null;
  }

  if (!detail && !shellName) {
    return (
      <div>
        <button className="sa-btn-text" onClick={onBack}>← Сотрудники</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Сотрудник не найден</div>
      </div>
    );
  }

  const displayName = detail?.fullName || shellName || 'Сотрудник';
  const displayDealership = detail?.dealershipName || shellDealership || '';
  const displayCity = detail?.city || shellCity || '';
  const locationParts = [displayDealership, displayCity]
    .map((part) => part.trim())
    .filter((part) => part && part !== '—')
    .filter((part, index, all) => all.findIndex((item) => item.toLowerCase() === part.toLowerCase()) === index);
  const deltaText = detail?.deltaRating == null
    ? '—'
    : `${detail.deltaRating > 0 ? '+' : ''}${detail.deltaRating}`;
  const answerRate = typeof detail?.answerRate === 'number' ? detail.answerRate : null;
  const failRate = detail && detail.auditsCount > 0
    ? Math.round((detail.failsCount / detail.auditsCount) * 100)
    : null;
  const rankValue = detail?.dealershipRank?.rank ?? '—';
  const rankSuffix = detail?.dealershipRank ? `из ${detail.dealershipRank.total}` : undefined;

  return (
    <div className="sa-detail-root sa-page-enter">
      {/* Breadcrumb */}
      <div className="sa-breadcrumb">
        {sourceDealership ? (
          <>
            <button className="sa-btn-text" onClick={() => onOpenCompanies?.()}>Точки</button>
            <span className="sa-breadcrumb-sep">→</span>
            <button className="sa-btn-text" onClick={() => onOpenDealership?.(sourceDealership.id)}>{sourceDealership.name}</button>
            <span className="sa-breadcrumb-sep">→</span>
            <span>{displayName}</span>
          </>
        ) : (
          <>
            <button className="sa-btn-text" onClick={onBack}>Сотрудники</button>
            <span className="sa-breadcrumb-sep">→</span>
            <span>{displayName}</span>
          </>
        )}
      </div>

      {/* Header */}
      <div className="sa-detail-header">
        <div>
          <div className="sa-holding-title-row" style={{ marginBottom: 4 }}>
            <h1 className="sa-page-title">{displayName}</h1>
            {detail && (
              <span className={statusBadgeClass(detail.status)}>{STATUS_LABELS[detail.status]}</span>
            )}
          </div>
          {locationParts.length > 0 && (
            <p className="sa-page-subtitle" style={{ marginBottom: 0 }}>
              {detail?.dealershipId && displayDealership && locationParts[0] === displayDealership ? (
                <>
                  <button
                    className="sa-btn-text"
                    style={{ padding: 0, fontSize: 'inherit', lineHeight: 'inherit' }}
                    onClick={() => onOpenDealership?.(detail.dealershipId)}
                  >
                    {displayDealership}
                  </button>
                  {locationParts.length > 1 ? ` · ${locationParts.slice(1).join(' · ')}` : ''}
                </>
              ) : (
                locationParts.join(' · ')
              )}
            </p>
          )}
          {mockNotice && (
            <div style={{ marginTop: 10, color: '#92400e', fontSize: 13 }}>
              {mockNotice}
            </div>
          )}
        </div>
        <div className="sa-detail-header-right">
          {headerRight}
          {actionButtons}
        </div>
      </div>

      {!detail ? (
        <div aria-hidden style={{ minHeight: 280 }} />
      ) : (
        <>
      <section className="sa-section sa-section-metrics" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Ключевые метрики</h2>
        <div className="sa-kpi-grid">
          <EmployeeMetricCard
            label="AI рейтинг"
            value={detail.aiRating}
            valueSuffix="из 100"
            valueClass={ratingClass(detail.aiRating)}
            description={(
              <>
                Динамика за 30 дней{' '}
                <span className={`sa-kpi-delta${detail.deltaRating !== null ? (detail.deltaRating > 0 ? ' is-up' : detail.deltaRating < 0 ? ' is-down' : '') : ''}`}>
                  {deltaText}
                </span>
              </>
            )}
          />
          <EmployeeMetricCard
            label="Проверки"
            value={detail.auditsCount}
            description="За выбранный период"
          />
          <EmployeeMetricCard
            label="Провалы"
            value={failRate !== null ? `${failRate}%` : '—'}
            valueClass={failRate !== null ? (failRate >= 20 ? 'sa-score-red' : failRate >= 10 ? 'sa-score-orange' : 'sa-score-green') : undefined}
            description={detail.auditsCount > 0 ? `${detail.failsCount} из ${detail.auditsCount} проверок` : 'Оценка ниже 50'}
          />
          <EmployeeMetricCard
            label="Дозвон"
            value={answerRate !== null ? `${answerRate}%` : '—'}
            valueClass={answerRate !== null ? answerRateClass(answerRate) : undefined}
            description="Процент принятых звонков"
          />
          <EmployeeMetricCard
            label="Место в салоне"
            value={rankValue}
            valueSuffix={rankSuffix}
            description={detail.dealershipRank ? 'Среди сотрудников точки' : 'Недостаточно данных'}
          />
        </div>
      </section>

      {/* Schedules */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <div className="sa-section-header-row" style={{ marginBottom: 12 }}>
          <h2 className="sa-section-title" style={{ marginBottom: 0 }}>Участвует в расписаниях</h2>
          <button type="button" className="sa-btn-text" onClick={() => navigate('/call-settings/plans')}>
            Настроить расписания →
          </button>
        </div>
        {planActionStatus && <div className="sa-meta" style={{ marginBottom: 10 }}>{planActionStatus}</div>}
        <PlanParticipationList
          plans={planParticipation}
          excludingPlanId={excludingPlanId}
          onOpenPlan={(id) => navigate(`/call-settings/plans/${encodeURIComponent(id)}/edit`)}
          onExcludePlan={handleExcludePlan}
        />
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Динамика эффективности</h2>
        <div className="sa-card sa-grid-card">
          {detail.comparisonTimeSeries?.length ? (
            <ComparisonTrendChart points={detail.comparisonTimeSeries} />
          ) : (
            <TrendChart points={detail.timeSeries} />
          )}
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Исходы и категории</h2>
        <div className="sa-dashboard-grid">
          <div className="sa-card sa-grid-card">
            <h3 className="sa-card-heading">Исходы звонков</h3>
            <CallOutcomeBreakdown data={detail.outcomeBreakdown} />
          </div>
          <div className="sa-card sa-grid-card">
            <h3 className="sa-card-heading">Распределение по категориям</h3>
            <BlockBreakdown data={detail.blockBreakdown} />
          </div>
        </div>
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Тренажёр</h2>
        <TrainerStats
          detail={detail}
          onOpenTraining={(sessionId) => handleOpenAuditDetail(`trainer-${sessionId}`)}
        />
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Аналитика по ошибкам</h2>
        <TrainerInsights detail={detail} />
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Рекомендации</h2>
        <TrainerRecommendations
          items={detail.recommendedTrainings}
          onOpenProblem={(issue) => {
            const params = new URLSearchParams();
            params.set('problem', issue);
            if (detail.dealershipId) params.set('dealership', detail.dealershipId);
            navigate(`/audits?${params.toString()}`);
          }}
        />
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">История проверок</h2>
        <AuditHistoryBlock
          variant="employee"
          items={detail.audits}
          onOpenAudit={handleOpenAuditDetail}
        />
      </section>
        </>
      )}
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
            <div style={{ color: '#b91c1c', fontWeight: 700 }}>Не удалось открыть аналитику</div>
            <div className="sa-meta" style={{ marginTop: 8 }}>{analyticsDrawerError}</div>
          </div>
        ) : analyticsDrawerDetail ? (
          <AuditAnalyticsReport
            detail={analyticsDrawerDetail}
            onOpenEmployee={(id) => navigate(`/users/${encodeURIComponent(id)}`)}
          />
        ) : (
          <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Выберите звонок.</div>
        )}
      </SlideOver>
    </div>
  );
}
