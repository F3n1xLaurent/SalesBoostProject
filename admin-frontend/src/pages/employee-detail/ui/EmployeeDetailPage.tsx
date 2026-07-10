import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { apiFetch } from '../../../entities/session';
import {
  STATUS_LABELS,
  COMM_LABELS,
  COMM_BADGE_CLASS,
  type EmployeeDetailData,
} from '../../../shared/lib/admin-panel/mockData';
import { ratingClass, deltaDisplay, statusBadgeClass } from '../../../shared/lib/admin-panel/utils';
import {
  excludeManagerFromAnalyticsPlan,
  fetchAnalyticsManagerDetail,
  fetchAnalyticsManagerPlans,
  type AnalyticsAISummary,
  type AnalyticsPlanParticipation,
} from '../../../shared/api/adminPanel';
import { CallInsightCard, type CallInsightDetail } from '../../../widgets/call-insight-card';
import { AISummaryBlock } from '../../../shared/ui/ai-summary-block/AISummaryBlock';

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
  aiSummary?: AnalyticsAISummary;
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

function KPI({ label, value, cls }: { label: string; value: string | number; cls?: string }) {
  return (
    <div className="sa-card sa-kpi-card">
      <div className="sa-kpi-label">{label}</div>
      <div className={`sa-kpi-value sa-kpi-value-large ${cls ?? ''}`}>{value}</div>
    </div>
  );
}

function planFrequencyLabel(value: AnalyticsPlanParticipation['frequency']): string {
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
              {planTargetLabel(plan)} · {planFrequencyLabel(plan.frequency)} · {plan.callTimeFrom}-{plan.callTimeTo}
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

function TrendChart({ points }: { points: { date: string; avgScore: number; count: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (points.length === 0) return <div className="sa-chart-empty">Нет данных за период</div>;

  const W = 560, H = 240;
  const pad = { top: 20, right: 20, bottom: 36, left: 44 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const step = points.length <= 1 ? 0 : cw / (points.length - 1);
  const xs = points.map((_, i) => pad.left + i * step);
  const ys = points.map((p) => pad.top + ch - (p.avgScore / 100) * ch);
  const pathD = points.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${ys[i]}`).join(' ');

  return (
    <div className="sa-chart-wrap">
      <h3 className="sa-chart-title">Динамика AI-рейтинга</h3>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          <linearGradient id="empTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366F1" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#6366F1" stopOpacity="0.02" />
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
        <path d={`${pathD} L ${xs[xs.length - 1]} ${pad.top + ch} L ${xs[0]} ${pad.top + ch} Z`} fill="url(#empTrendFill)" />
        <path d={pathD} fill="none" stroke="#6366F1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((_, i) => (
          <rect key={`h-${i}`} x={xs[i] - step / 2} y={pad.top} width={step || 40} height={ch} fill="transparent" onMouseEnter={() => setHoverIdx(i)} />
        ))}
        {hoverIdx !== null && <line x1={xs[hoverIdx]} y1={pad.top} x2={xs[hoverIdx]} y2={pad.top + ch} stroke="var(--sa-text-secondary)" strokeWidth="1" strokeDasharray="3" opacity="0.4" />}
        {points.map((p, i) => (
          <circle key={p.date} cx={xs[i]} cy={ys[i]} r={hoverIdx === i ? 6 : 4} fill={hoverIdx === i ? '#fff' : '#6366F1'} stroke={hoverIdx === i ? '#6366F1' : 'none'} strokeWidth={hoverIdx === i ? 2.5 : 0} style={{ transition: 'r .15s, fill .15s', cursor: 'pointer' }} />
        ))}
        {hoverIdx !== null && (() => {
          const p = points[hoverIdx];
          const tw = 150, th = 62;
          const tx = Math.min(Math.max(xs[hoverIdx] - tw / 2, 4), W - tw - 4);
          const ty = ys[hoverIdx] - th - 14;
          return (
            <g>
              <rect x={tx} y={ty} width={tw} height={th} rx="8" fill="#1F2937" opacity="0.92" />
              <text x={tx + 12} y={ty + 18} fontSize="11" fill="#D1D5DB">Дата: {p.date}</text>
              <text x={tx + 12} y={ty + 34} fontSize="11" fill="#F9FAFB" fontWeight="600">Балл: {p.avgScore}</text>
              <text x={tx + 12} y={ty + 50} fontSize="11" fill="#D1D5DB">Проверок: {p.count}</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

function ComparisonTrendChart({ points }: { points?: { date: string; managerScore: number; dealershipScore: number; networkScore: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!points || points.length === 0) return <div className="sa-chart-empty">Нет данных за период</div>;

  const W = 560, H = 240;
  const pad = { top: 20, right: 20, bottom: 36, left: 44 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const step = points.length <= 1 ? 0 : cw / (points.length - 1);
  const xs = points.map((_, i) => pad.left + i * step);
  const y = (score: number) => pad.top + ch - (Math.max(0, Math.min(score, 100)) / 100) * ch;
  const path = (key: 'managerScore' | 'dealershipScore' | 'networkScore') => points
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${y(point[key])}`)
    .join(' ');
  const series = [
    { key: 'managerScore' as const, label: 'Менеджер', color: '#6366F1' },
    { key: 'dealershipScore' as const, label: 'Салон', color: '#10B981' },
    { key: 'networkScore' as const, label: 'Сеть', color: '#F59E0B' },
  ];

  return (
    <div className="sa-chart-wrap">
      <h3 className="sa-chart-title">Менеджер vs салон vs сеть</h3>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        {series.map((item) => (
          <span key={item.key} className="sa-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: item.color, display: 'inline-block' }} />
            {item.label}
          </span>
        ))}
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
  );
}

/* ────────────────────── Block Breakdown — horizontal bars (fully readable labels) ────────────────────── */

function BlockBreakdown({ data }: { data: { block: string; score: number; hint: string }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!data || data.length === 0) return <div className="sa-chart-empty">Нет данных</div>;

  function barColor(s: number) {
    if (s >= 80) return '#34D399';
    if (s >= 50) return '#FBBF24';
    return '#F87171';
  }

  return (
    <div className="sa-chart-wrap">
      <h3 className="sa-chart-title">Разбор по блокам</h3>
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
              <div className="sa-hbar-fill" style={{ width: `${d.score}%`, background: barColor(d.score) }} />
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

function OutcomeBreakdown({ data }: { data?: ManagerOutcomeBreakdown }) {
  const rows = [
    { key: 'completed' as const, label: 'Завершённые', color: '#34D399' },
    { key: 'no_answer' as const, label: 'Недозвоны', color: '#F87171' },
    { key: 'busy' as const, label: 'Занято', color: '#FBBF24' },
    { key: 'failed' as const, label: 'Ошибки', color: '#FB7185' },
    { key: 'disconnected' as const, label: 'Сброшены', color: '#94A3B8' },
  ];
  const total = data ? Object.values(data).reduce((sum, value) => sum + value, 0) : 0;
  if (!data || total === 0) return <div className="sa-chart-empty">Нет звонков для разбора</div>;
  return (
    <div className="sa-hbar-list">
      {rows.map((row) => {
        const count = data[row.key] ?? 0;
        const pct = Math.round((count / total) * 100);
        return (
          <div key={row.key} className="sa-hbar-row">
            <span className="sa-hbar-label">{row.label}</span>
            <div className="sa-hbar-track">
              <div className="sa-hbar-fill" style={{ width: `${pct}%`, background: row.color }} />
            </div>
            <span className="sa-hbar-score">{count}</span>
          </div>
        );
      })}
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

/* ────────────────────── Profile strip (compact horizontal card) ────────────────────── */

function ProfileStrip({ detail }: { detail: ManagerAnalyticsDetail }) {
  return (
    <div className="sa-card sa-profile-strip">
      <div className="sa-profile-strip-cols">
        <div className="sa-profile-strip-section">
          <div className="sa-profile-strip-label">Сильные стороны</div>
          <div className="sa-profile-tags">{detail.strengths.map((s) => <span key={s} className="sa-tag sa-tag-green">{s}</span>)}</div>
        </div>
        <div className="sa-profile-strip-divider" />
        <div className="sa-profile-strip-section">
          <div className="sa-profile-strip-label">Зоны роста</div>
          <div className="sa-profile-tags">{detail.growthAreas.map((g) => <span key={g} className="sa-tag sa-tag-orange">{g}</span>)}</div>
        </div>
        <div className="sa-profile-strip-divider" />
        <div className="sa-profile-strip-section">
          <div className="sa-profile-strip-label">Фокус обучения</div>
          <div className="sa-profile-strip-value">{detail.trainingFocus}</div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────── Trainer insights ────────────────────── */

function TrainerInsights({ detail }: { detail: ManagerAnalyticsDetail }) {
  return (
    <div className="sa-detail-insights">
      <div className="sa-card" style={{ flex: 1 }}>
        <h3 className="sa-card-heading">ТОП-5 типовых ошибок</h3>
        <ul className="sa-issue-list">
          {detail.topIssues.map((item, i) => (
            <li key={i} className="sa-issue-item">
              <span className="sa-issue-name">{item.issue}</span>
              <span className="sa-issue-pct">{item.percent}%</span>
              <div className="sa-issue-bar"><div className="sa-issue-bar-fill" style={{ width: `${item.percent}%` }} /></div>
            </li>
          ))}
        </ul>
      </div>
      <div className="sa-card" style={{ flex: 1 }}>
        <h3 className="sa-card-heading">ТОП-5 сложных вопросов</h3>
        <ol className="sa-question-list">
          {detail.topQuestions.map((q, i) => <li key={i}>{q}</li>)}
        </ol>
      </div>
      <div className="sa-card" style={{ flex: 1 }}>
        <h3 className="sa-card-heading">Рекомендованные тренировки</h3>
        <div className="sa-training-list">
          {detail.recommendedTrainings.map((t, i) => (
            <div key={i} className="sa-training-item">
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{t.title}</div>
                <div className="sa-meta">{t.description}</div>
              </div>
              <button className="sa-btn-outline sa-btn-sm" disabled title="Функция назначения будет подключена позже">Назначить</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TrainerStats({ detail }: { detail: ManagerAnalyticsDetail }) {
  const trainer = detail.trainer;
  if (!trainer) {
    return <div className="sa-card"><div className="sa-meta" style={{ padding: 18 }}>Данных тренажёра пока нет.</div></div>;
  }
  return (
    <div className="sa-card" style={{ padding: 18 }}>
      <div className="sa-kpi-grid" style={{ marginBottom: 18 }}>
        <KPI label="Очки" value={trainer.totalPoints} />
        <KPI label="Стрик" value={`${trainer.currentStreak} дн.`} />
        <KPI label="Сессии 30 дней" value={trainer.sessions30d} />
        <KPI label="Средний балл" value={trainer.avgScore} cls={ratingClass(trainer.avgScore)} />
      </div>
      <div className="sa-dashboard-grid" style={{ marginBottom: 18 }}>
        <div className="sa-card sa-grid-card sa-chart-equal" style={{ boxShadow: 'none', border: '1px solid var(--sa-divider)' }}>
          <TrendChart points={trainer.weeklyScore} />
        </div>
        <div className="sa-card sa-grid-card sa-chart-equal" style={{ boxShadow: 'none', border: '1px solid var(--sa-divider)' }}>
          <h3 className="sa-card-heading">Слабые места тренажёра</h3>
          {trainer.weakPatterns.length === 0 ? (
            <div className="sa-chart-empty">Повторяющихся паттернов нет</div>
          ) : (
            <ul className="sa-issue-list">
              {trainer.weakPatterns.map((item, index) => (
                <li key={index} className="sa-issue-item">
                  <span className="sa-issue-name">{item.issue}</span>
                  <span className="sa-issue-pct">{item.percent}%</span>
                  <div className="sa-issue-bar"><div className="sa-issue-bar-fill" style={{ width: `${item.percent}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h3 className="sa-card-heading">История тренировок</h3>
      {trainer.history.length === 0 ? (
        <div className="sa-meta" style={{ padding: 18 }}>Менеджер ещё не проходил тренировки.</div>
      ) : (
        <div className="sa-table-wrap">
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
              {trainer.history.map((item) => (
                <tr key={item.id}>
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

/* ────────────────────── Audit history ────────────────────── */

function getCallIdFromAuditId(auditId: string): number | null {
  const match = String(auditId || '').match(/^call-(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

type AuditHistoryFilter = 'all' | 'completed' | 'no_answer' | 'interrupted';

const AUDIT_HISTORY_FILTERS: { value: AuditHistoryFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'completed', label: 'Оцененные' },
  { value: 'no_answer', label: 'Недозвоны' },
  { value: 'interrupted', label: 'Прочие незавершенные' },
];

function AuditHistory({ audits, onOpenCall }: { audits: EmployeeDetailData['audits']; onOpenCall: (id: number) => void }) {
  const [filter, setFilter] = useState<AuditHistoryFilter>('all');
  const filteredAudits = useMemo(() => {
    if (filter === 'all') return audits;
    if (filter === 'completed') {
      return audits.filter((audit) => audit.outcome === 'completed' || (!audit.outcome && audit.verdict !== 'Недозвон'));
    }
    if (filter === 'no_answer') {
      return audits.filter((audit) => audit.outcome === 'no_answer' || audit.verdict === 'Недозвон');
    }
    return audits.filter((audit) => ['busy', 'failed', 'disconnected'].includes(String(audit.outcome || '')));
  }, [audits, filter]);

  if (audits.length === 0) return <div className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Нет проверок за период</div>;
  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {AUDIT_HISTORY_FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`sa-btn-outline sa-btn-sm ${filter === option.value ? 'sa-chip-active' : ''}`}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="sa-table-wrap">
        <table className="sa-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Тип</th>
              <th className="sa-text-right">Балл</th>
              <th>Вердикт</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filteredAudits.length === 0 ? (
              <tr>
                <td colSpan={5} className="sa-meta" style={{ padding: 18, textAlign: 'center' }}>Нет проверок по выбранному фильтру</td>
              </tr>
            ) : filteredAudits.slice(0, 20).map((a) => {
              const callId = a.type === 'call' ? getCallIdFromAuditId(a.id) : null;
              return (
                <tr key={a.id}>
                  <td>{new Date(a.date).toLocaleDateString('ru-RU')}</td>
                  <td>{a.type === 'training' ? 'Тренажёр' : 'Звонок'}</td>
                  <td className="sa-text-right"><span className={ratingClass(a.score)}>{a.score}</span></td>
                  <td>{a.verdict}</td>
                  <td>
                    <button
                      className="sa-btn-text sa-btn-sm"
                      disabled={!callId}
                      title={callId ? 'Открыть разбор звонка' : 'Разбор тренировки открывается в разделе проверок'}
                      onClick={() => callId && onOpenCall(callId)}
                    >
                      Открыть разбор
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
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
  const [selectedCallDetail, setSelectedCallDetail] = useState<CallInsightDetail | null>(null);
  const [selectedCallLoading, setSelectedCallLoading] = useState(false);
  const [selectedCallError, setSelectedCallError] = useState<string | null>(null);
  const detail = useMemo(() => {
    const base = realDetail;
    return base ? { ...base, ...detailOverride } : null;
  }, [detailOverride, realDetail]);

  useEffect(() => {
    let cancelled = false;
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
    const confirmed = window.confirm(`Исключить сотрудника «${detail?.fullName ?? ''}» из расписания «${plan.name}»?`);
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

  async function handleOpenCallDetail(callId: number) {
    setSelectedCallDetail(null);
    setSelectedCallError(null);
    setSelectedCallLoading(true);
    try {
      const res = await apiFetch(`/api/admin/call-history/${callId}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.error || 'Не удалось загрузить разбор звонка');
      setSelectedCallDetail(data as CallInsightDetail);
    } catch (error) {
      setSelectedCallError(error instanceof Error ? error.message : 'Не удалось загрузить разбор звонка');
    } finally {
      setSelectedCallLoading(false);
    }
  }

  if (detailLoading) {
    return (
      <div>
        <button className="sa-btn-text" onClick={onBack}>← Сотрудники</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Загружаем данные сотрудника...</div>
      </div>
    );
  }

  if (detailError) {
    return (
      <div>
        <button className="sa-btn-text" onClick={onBack}>← Сотрудники</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>{detailError}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div>
        <button className="sa-btn-text" onClick={onBack}>← Сотрудники</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Сотрудник не найден</div>
      </div>
    );
  }

  const delta = deltaDisplay(detail.deltaRating);
  const commCls = detail.communicationFlag === 'ok' ? 'sa-score-green' : 'sa-score-orange';

  return (
    <div className="sa-detail-root">
      {/* Breadcrumb */}
      <div className="sa-breadcrumb">
        {sourceDealership ? (
          <>
            <button className="sa-btn-text" onClick={() => onOpenCompanies?.()}>Точки</button>
            <span className="sa-breadcrumb-sep">→</span>
            <button className="sa-btn-text" onClick={() => onOpenDealership?.(sourceDealership.id)}>{sourceDealership.name}</button>
            <span className="sa-breadcrumb-sep">→</span>
            <span>{detail.fullName}</span>
          </>
        ) : (
          <>
            <button className="sa-btn-text" onClick={onBack}>Сотрудники</button>
            <span className="sa-breadcrumb-sep">→</span>
            <span>{detail.fullName}</span>
          </>
        )}
      </div>

      {/* Header */}
      <div className="sa-detail-header">
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 4 }}>{detail.fullName}</h1>
          <p className="sa-page-subtitle" style={{ marginBottom: 0 }}>
            <button
              className="sa-btn-text"
              style={{ padding: 0, fontSize: 'inherit', lineHeight: 'inherit' }}
              onClick={() => onOpenDealership?.(detail.dealershipId)}
            >
              {detail.dealershipName}
            </button>
            {' · '}
            {detail.city}
          </p>
          {mockNotice && (
            <div style={{ marginTop: 10, color: '#92400e', fontSize: 13 }}>
              {mockNotice}
            </div>
          )}
          {actionButtons && (
            <div style={{ marginTop: 14 }}>
              {actionButtons}
            </div>
          )}
        </div>
        <div className="sa-detail-header-right">
          {headerRight}
          <span className={statusBadgeClass(detail.status)}>{STATUS_LABELS[detail.status]}</span>
        </div>
      </div>

      <section className="sa-section" style={{ marginBottom: 20 }}>
        <AISummaryBlock
          title="AI-сводка по менеджеру"
          summary={detail.aiSummary}
          loading={detailLoading}
          error={detailError}
        />
      </section>

      {/* KPI row — full width, no cramped side-by-side with profile */}
      <div className="sa-kpi-grid sa-kpi-grid-emp">
        <KPI label="AI-рейтинг" value={detail.aiRating} cls={ratingClass(detail.aiRating)} />
        <KPI label="Динамика" value={delta.text} cls={delta.cls} />
        <KPI label="Проверки" value={detail.auditsCount} />
        <KPI label="Провалы" value={detail.failsCount} cls={detail.failsCount >= 2 ? 'sa-score-red' : detail.failsCount >= 1 ? 'sa-score-orange' : ''} />
        <KPI label="Недозвоны" value={detail.noAnswers ?? detail.outcomeBreakdown?.no_answer ?? 0} cls={(detail.noAnswers ?? 0) > 0 ? 'sa-score-orange' : 'sa-score-green'} />
        <KPI label="% недозвонов" value={`${detail.noAnswerRate ?? 0}%`} cls={(detail.noAnswerRate ?? 0) > 0 ? 'sa-score-orange' : 'sa-score-green'} />
        <KPI label="Место в салоне" value={detail.dealershipRank ? `${detail.dealershipRank.rank} из ${detail.dealershipRank.total}` : '—'} />
        <KPI label="Коммуникация" value={COMM_LABELS[detail.communicationFlag]} cls={commCls} />
      </div>

      {/* Profile strip — compact horizontal summary */}
      <ProfileStrip detail={detail} />

      {/* Schedules */}
      <section className="sa-section" style={{ marginTop: 20, marginBottom: 28 }}>
        <h2 className="sa-section-title">Участвует в расписаниях</h2>
        {planActionStatus && <div className="sa-meta" style={{ marginBottom: 10 }}>{planActionStatus}</div>}
        <PlanParticipationList
          plans={planParticipation}
          excludingPlanId={excludingPlanId}
          onOpenPlan={(id) => navigate(`/call-settings/plans/${encodeURIComponent(id)}/edit`)}
          onExcludePlan={handleExcludePlan}
        />
      </section>

      {/* Charts — line chart + horizontal bar breakdown */}
      <div className="sa-dashboard-grid" style={{ marginTop: 20, marginBottom: 28 }}>
        <div className="sa-card sa-grid-card sa-chart-equal">
          {detail.comparisonTimeSeries?.length ? (
            <ComparisonTrendChart points={detail.comparisonTimeSeries} />
          ) : (
            <TrendChart points={detail.timeSeries} />
          )}
        </div>
        <div className="sa-card sa-grid-card sa-chart-equal">
          <BlockBreakdown data={detail.blockBreakdown} />
        </div>
      </div>

      <div className="sa-dashboard-grid" style={{ marginBottom: 28 }}>
        <div className="sa-card sa-grid-card">
          <h3 className="sa-card-heading">Исходы звонков</h3>
          <OutcomeBreakdown data={detail.outcomeBreakdown} />
        </div>
        <div className="sa-card sa-grid-card">
          <h3 className="sa-card-heading">Качество коммуникации</h3>
          <CommunicationBreakdown data={detail.communicationBreakdown} />
        </div>
      </div>

      <section className="sa-section" style={{ marginBottom: 28 }}>
        <h2 className="sa-section-title">Тренажёр</h2>
        <TrainerStats detail={detail} />
      </section>

      {/* Trainer insights */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <h2 className="sa-section-title">Аналитика по ошибкам</h2>
        <TrainerInsights detail={detail} />
      </section>

      {/* Audit history */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <h2 className="sa-section-title">История проверок</h2>
        {(selectedCallLoading || selectedCallError || selectedCallDetail) && (
          <div className="sa-card" style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <h3 className="sa-card-heading" style={{ margin: 0 }}>Разбор звонка</h3>
              <button className="sa-btn-text sa-btn-sm" onClick={() => { setSelectedCallDetail(null); setSelectedCallError(null); }}>Закрыть</button>
            </div>
            {selectedCallLoading ? (
              <div className="sa-meta">Загружаем разбор...</div>
            ) : selectedCallError ? (
              <div className="sa-meta">{selectedCallError}</div>
            ) : selectedCallDetail ? (
              <CallInsightCard detail={selectedCallDetail} />
            ) : null}
          </div>
        )}
        <AuditHistory audits={detail.audits} onOpenCall={handleOpenCallDetail} />
      </section>
    </div>
  );
}
