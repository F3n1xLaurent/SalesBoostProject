import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  STATUS_LABELS,
  type DealershipDetail as Detail,
} from '../../../shared/lib/admin-panel/mockData';
import {
  excludeDealershipFromAnalyticsPlan,
  fetchAuditDetail,
  fetchAnalyticsDealershipDetail,
  fetchAnalyticsDealershipPlans,
  type AnalyticsAISummary,
  type AnalyticsPlanParticipation,
  type AuditDetailItem,
  type DealershipItem,
  type DealershipType,
} from '../../../shared/api/adminPanel';
import { DealershipModal, formatWorkingHours } from '../../../shared/ui/dealership-modal/DealershipModal';
import { DealershipPhoneNumbersModal } from '../../../shared/ui/dealership-phone-numbers/DealershipPhoneNumbersModal';
import { ratingClass, answerRateClass, answerTimeClass, statusBadgeClass } from '../../../shared/lib/admin-panel/utils';
import {
  ACTIVE_BATCH_STORAGE_KEY,
  fetchBatchWithSummary,
  type CallBatchSnapshot,
  type DealershipBatchSummary,
} from '../../../shared/lib/admin-panel/batchUtils';
import { AISummaryBlock } from '../../../shared/ui/ai-summary-block/AISummaryBlock';
import { ComparisonAISummary } from '../../../shared/ui/comparison-ai-summary/ComparisonAISummary';
import { SlideOver } from '../../../shared/ui/slide-over';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import { FixedOverlayPortal } from '../../../shared/ui/fixed-overlay-portal/FixedOverlayPortal';

/* ────────────────────── Props ────────────────────── */

type Props = {
  dealershipId: string;
  dealership?: DealershipItem | null;
  onBack: () => void;
  onOpenEmployee?: (id: string) => void;
  onOpenBatchDetail?: (batchId: string) => void;
  onDealershipSaved?: (dealership: DealershipItem) => void;
  mode?: 'default' | 'dealerDashboard';
};

type DealershipOutcomeBreakdown = {
  completed: number;
  no_answer: number;
  busy: number;
  failed: number;
  disconnected: number;
};

type DealershipAnalyticsDetail = Detail & {
  aiSummary?: AnalyticsAISummary;
  noAnswers?: number;
  outcomeBreakdown?: DealershipOutcomeBreakdown;
  communicationBreakdown?: { label: string; percent: number; color: string }[];
  scriptCompliance?: { block: string; rate: number; hint?: string }[];
};

/* ────────────────────── KPI Card ────────────────────── */

function KPI({ label, value, cls, suffix }: { label: string; value: string | number; cls?: string; suffix?: string }) {
  return (
    <div className="sa-card sa-kpi-card">
      <div className="sa-kpi-label">{label}</div>
      <div className={`sa-kpi-value sa-kpi-value-large ${cls ?? ''}`}>{value}{suffix ?? ''}</div>
    </div>
  );
}

function dealershipTypeLabel(type?: DealershipType | null): string {
  return type === 'franchised' ? 'Франчайзинговый' : 'Собственный';
}

function planFrequencyLabel(value: AnalyticsPlanParticipation['frequency']): string {
  if (value === 'manual') return 'Вручную';
  return value === 'weekly' ? 'Еженедельно' : 'Ежедневно';
}

function planTargetLabel(plan: AnalyticsPlanParticipation): string {
  if (plan.targetMatch === 'dealership') return 'Точка целиком';
  return plan.targetsCount === 1 ? '1 сотрудник точки' : `${plan.targetsCount} сотрудников точки`;
}

function PlanParticipationList({
  plans,
  excludingPlanId,
  onOpenPlan,
  onExcludePlan,
  readOnly = false,
}: {
  plans: AnalyticsPlanParticipation[];
  excludingPlanId: string | null;
  onOpenPlan: (id: string) => void;
  onExcludePlan: (plan: AnalyticsPlanParticipation) => void;
  readOnly?: boolean;
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
          {!readOnly && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="sa-btn-outline sa-btn-sm" onClick={() => onOpenPlan(plan.id)}>Настроить</button>
              <button
                className="sa-btn-outline sa-btn-sm"
                disabled={excludingPlanId === plan.id}
                onClick={() => onExcludePlan(plan)}
              >
                {excludingPlanId === plan.id ? 'Исключаем...' : 'Исключить'}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function buildFallbackDetail(dealership: DealershipItem): DealershipAnalyticsDetail {
  return {
    id: dealership.id,
    name: dealership.name,
    city: dealership.city || '—',
    aiRating: 0,
    answerRate: null,
    avgAnswerTimeSec: null,
    avgCallDurationSec: null,
    auditsCount: 0,
    employeesCount: dealership.managersCount,
    deltaRating: null,
    status: 'no-data',
    employees: [],
    audits: [],
    timeSeries: [],
    hourlyAnswerRate: Array.from({ length: 24 }, () => 0),
    topIssues: [],
    topQuestions: [],
    recommendedTrainings: [],
    noAnswers: 0,
    outcomeBreakdown: { completed: 0, no_answer: 0, busy: 0, failed: 0, disconnected: 0 },
    communicationBreakdown: [],
    scriptCompliance: [],
  };
}

/* ────────────────────── Performance Trend (line chart) ────────────────────── */

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
      <h3 className="sa-chart-title">Динамика эффективности</h3>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          <linearGradient id="dtFill" x1="0" y1="0" x2="0" y2="1">
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
          <text key={p.date} x={xs[i]} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">
            {p.date.slice(5)}
          </text>
        ))}
        <path d={`${pathD} L ${xs[xs.length - 1]} ${pad.top + ch} L ${xs[0]} ${pad.top + ch} Z`} fill="url(#dtFill)" />
        <path d={pathD} fill="none" stroke="#6366F1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((_, i) => (
          <rect key={`hit-${i}`} x={xs[i] - step / 2} y={pad.top} width={step || 40} height={ch} fill="transparent" onMouseEnter={() => setHoverIdx(i)} />
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

/* ────────────────────── Heatmap ────────────────────── */

const CLOSED_HOURS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 21, 22, 23]);

function Heatmap({ hourly }: { hourly: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!hourly || hourly.length === 0) return <div className="sa-chart-empty">Нет данных</div>;
  const working = hourly.filter((_, h) => !CLOSED_HOURS.has(h));
  const mx = Math.max(...working, 1);
  return (
    <div className="sa-chart-wrap sa-heatmap-fill">
      <h3 className="sa-chart-title">Дозвон по часам</h3>
      <div className="sa-heatmap-grid-12" onMouseLeave={() => setHover(null)}>
        {hourly.slice(0, 24).map((pct, h) => {
          const closed = CLOSED_HOURS.has(h);
          const bg = closed ? 'rgba(17,24,39,0.05)' : `rgba(34,197,94,${0.15 + (pct / mx) * 0.85})`;
          return (
            <div key={h} className={`sa-heatmap-cell ${hover === h ? 'sa-heatmap-cell-hover' : ''} ${closed ? 'sa-heatmap-closed' : ''}`} style={{ backgroundColor: bg }} onMouseEnter={() => setHover(h)}>
              <span className="sa-heatmap-label">{h}</span>
              {hover === h && (
                <div className="sa-heatmap-tooltip">
                  <div>Час: {h}:00</div>
                  {closed ? <div>Точка закрыта</div> : <><div>Дозвон: {pct.toFixed(0)}%</div></>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OutcomeBreakdown({ data }: { data?: DealershipOutcomeBreakdown }) {
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

function ScriptCompliance({ data }: { data?: { block: string; rate: number; hint?: string }[] }) {
  if (!data || data.length === 0) return <div className="sa-chart-empty">Нет рассчитанных блоков скрипта</div>;
  return (
    <div className="sa-hbar-list">
      {[...data].sort((a, b) => a.rate - b.rate).map((item) => (
        <div key={item.block} className="sa-hbar-row" title={item.hint}>
          <span className="sa-hbar-label">{item.block}</span>
          <div className="sa-hbar-track">
            <div
              className="sa-hbar-fill"
              style={{ width: `${item.rate}%`, background: item.rate >= 80 ? '#34D399' : item.rate >= 60 ? '#FBBF24' : '#F87171' }}
            />
          </div>
          <span className={`sa-hbar-score ${ratingClass(item.rate)}`}>{item.rate}%</span>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────── Employees table ────────────────────── */

function EmployeeComparisonModal({
  rows,
  onClose,
  onOpenEmployee,
}: {
  rows: Detail['employees'];
  onClose: () => void;
  onOpenEmployee?: (id: string) => void;
}) {
  if (rows.length < 2) return null;
  const bestScore = Math.max(...rows.map((row) => row.aiRating));
  const worstScore = Math.min(...rows.map((row) => row.aiRating));
  const bestAudits = Math.max(...rows.map((row) => row.auditsCount));
  const worstAudits = Math.min(...rows.map((row) => row.auditsCount));
  const leader = [...rows].sort((a, b) => b.aiRating - a.aiRating)[0];
  const lagger = [...rows].sort((a, b) => a.aiRating - b.aiRating)[0];

  return (
    <FixedOverlayPortal>
    <div style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(15,23,42,.42)', display: 'grid', placeItems: 'center', padding: 20 }} onClick={onClose}>
      <div className="sa-card" style={{ width: 'min(980px, 100%)', maxHeight: '86vh', overflow: 'auto' }} onClick={(event) => event.stopPropagation()}>
        <div className="sa-section-header-row" style={{ marginBottom: 16 }}>
          <div>
            <h2 className="sa-section-title" style={{ marginBottom: 4 }}>Сравнение менеджеров салона</h2>
            <div className="sa-meta">Выбрано: {rows.length}</div>
          </div>
          <button type="button" className="sa-btn-outline" onClick={onClose}>Закрыть</button>
        </div>
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Метрика</th>
                {rows.map((row) => (
                  <th key={row.id} className="sa-text-right">
                    <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenEmployee?.(row.id)}>{row.name}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>AI-рейтинг</td>
                {rows.map((row) => (
                  <td key={row.id} className="sa-text-right">
                    <span className={row.aiRating === bestScore ? 'sa-score-green' : row.aiRating === worstScore && bestScore !== worstScore ? 'sa-score-red' : ''}>{row.aiRating}</span>
                  </td>
                ))}
              </tr>
              <tr>
                <td>Проверки</td>
                {rows.map((row) => (
                  <td key={row.id} className="sa-text-right">
                    <span className={row.auditsCount === bestAudits ? 'sa-score-green' : row.auditsCount === worstAudits && bestAudits !== worstAudits ? 'sa-score-red' : ''}>{row.auditsCount}</span>
                  </td>
                ))}
              </tr>
              <tr>
                <td>Типовая ошибка</td>
                {rows.map((row) => (
                  <td key={row.id} className="sa-text-right">{row.typicalError}</td>
                ))}
              </tr>
              <tr>
                <td>Статус</td>
                {rows.map((row) => (
                  <td key={row.id} className="sa-text-right">{row.status}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 16 }}>
          <ComparisonAISummary level="dealership-managers" items={rows.map((row) => ({ ...row, fullName: row.name }))} />
        </div>
        <div className="sa-card" style={{ marginTop: 16 }}>
          <h3 className="sa-card-heading">Анализ различий</h3>
          <p className="sa-meta" style={{ lineHeight: 1.6 }}>
            Лидер по рейтингу — <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenEmployee?.(leader.id)}>{leader.name}</button>.
            {' '}Самый слабый показатель — <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenEmployee?.(lagger.id)}>{lagger.name}</button>.
            {' '}Разницу стоит разбирать через типовые ошибки и историю звонков каждого менеджера.
          </p>
        </div>
      </div>
    </div>
    </FixedOverlayPortal>
  );
}

function EmployeesTable({ employees, onOpenEmployee }: { employees: Detail['employees']; onOpenEmployee?: (id: string) => void }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const selectedRows = employees.filter((employee) => selectedIds.includes(employee.id));

  function toggleEmployee(id: string) {
    const employee = employees.find((item) => item.id === id);
    if (employee && employee.auditsCount === 0) return;
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
  }

  if (employees.length === 0) return <div className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Нет данных о сотрудниках</div>;
  return (
    <>
      <div className="sa-table-wrap">
        <table className="sa-table sa-table-sortable">
          <thead>
            <tr>
              <th style={{ width: 44 }} />
              <th>Сотрудник</th>
              <th className="sa-text-right">AI-рейтинг</th>
              <th className="sa-text-right">Проверки</th>
              <th>Типовая ошибка</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr
                key={e.id}
                className="sa-row-clickable"
                onClick={() => onOpenEmployee?.(e.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => ev.key === 'Enter' && onOpenEmployee?.(e.id)}
              >
                <td onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(e.id)}
                    disabled={e.auditsCount === 0 || (!selectedIds.includes(e.id) && selectedIds.length >= 6)}
                    onChange={() => toggleEmployee(e.id)}
                    aria-label={`Выбрать ${e.name}`}
                  />
                </td>
                <td style={{ fontWeight: 600 }}>{e.name}</td>
                <td className="sa-text-right"><span className={ratingClass(e.aiRating)}>{e.aiRating}</span></td>
                <td className="sa-text-right">{e.auditsCount}</td>
                <td>{e.typicalError}</td>
                <td>
                  <span className={`sa-emp-status ${e.status === 'Нуждается в обучении' ? 'sa-emp-warn' : e.status === 'Стажёр' ? 'sa-emp-trainee' : ''}`}>
                    {e.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedRows.length > 0 && (
        <div style={{ position: 'fixed', left: 24, right: 24, bottom: 24, zIndex: 60, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="sa-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', pointerEvents: 'auto', boxShadow: '0 16px 40px rgba(15,23,42,.18)' }}>
            <strong>Выбрано: {selectedRows.length}</strong>
            <button type="button" className="sa-btn-outline" disabled={selectedRows.length < 2} onClick={() => setComparisonOpen(true)}>Сравнить</button>
            <button type="button" className="sa-btn-text" onClick={() => setSelectedIds([])}>Сбросить</button>
          </div>
        </div>
      )}
      {comparisonOpen && (
        <EmployeeComparisonModal rows={selectedRows} onClose={() => setComparisonOpen(false)} onOpenEmployee={onOpenEmployee} />
      )}
    </>
  );
}

/* ────────────────────── Top Issues ────────────────────── */

function TopIssues({ detail }: { detail: DealershipAnalyticsDetail }) {
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
          {detail.topQuestions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
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
              <button className="sa-btn-outline sa-btn-sm" disabled title="Скоро">Назначить</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────── Audit History ────────────────────── */

function isCallAuditId(auditId: string): boolean {
  const match = String(auditId || '').match(/^call-(\d+)$/);
  return !!match;
}

function AuditHistory({ audits, onOpenCall }: { audits: Detail['audits']; onOpenCall: (id: string) => void }) {
  const pageSize = 10;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(audits.length / pageSize));
  const startIndex = (page - 1) * pageSize;
  const visibleAudits = audits.slice(startIndex, startIndex + pageSize);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  if (audits.length === 0) return <div className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Нет проверок за период</div>;
  return (
    <div>
      <div className="sa-table-wrap">
        <table className="sa-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Тип</th>
              <th>Сотрудник</th>
              <th className="sa-text-right">Балл</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibleAudits.map((a) => {
              const canOpenCall = a.type === 'call' && isCallAuditId(a.id);
              return (
                <tr key={a.id}>
                  <td>{new Date(a.date).toLocaleDateString('ru-RU')}</td>
                  <td>{a.type === 'training' ? 'Тренажёр' : 'Звонок'}</td>
                  <td>{a.employeeName}</td>
                  <td className="sa-text-right"><span className={ratingClass(a.score)}>{a.score}</span></td>
                  <td>
                    <button
                      className="sa-btn-text sa-btn-sm"
                      disabled={!canOpenCall}
                      title={canOpenCall ? 'Открыть разбор звонка' : 'Разбор тренировки открывается в разделе проверок'}
                      onClick={() => canOpenCall && onOpenCall(a.id)}
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
      {audits.length > pageSize && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <span className="sa-meta">
            Показаны {startIndex + 1}-{Math.min(startIndex + pageSize, audits.length)} из {audits.length}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="sa-btn-outline sa-btn-sm" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              Назад
            </button>
            <span className="sa-metric-chip">Стр. {page} из {totalPages}</span>
            <button type="button" className="sa-btn-outline sa-btn-sm" disabled={page === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
              Вперёд
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────────────── Main Component ────────────────────── */

export function DealershipDetail({ dealershipId, dealership, onBack, onOpenEmployee, onOpenBatchDetail, onDealershipSaved, mode = 'default' }: Props) {
  const navigate = useNavigate();
  const isDealerDashboard = mode === 'dealerDashboard';
  const [realDetail, setRealDetail] = useState<DealershipAnalyticsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [planParticipation, setPlanParticipation] = useState<AnalyticsPlanParticipation[]>([]);
  const [planActionStatus, setPlanActionStatus] = useState<string | null>(null);
  const [excludingPlanId, setExcludingPlanId] = useState<string | null>(null);
  const detail = useMemo(
    () => realDetail || (dealership ? buildFallbackDetail(dealership) : null),
    [dealershipId, dealership, realDetail],
  );
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeBatch, setActiveBatch] = useState<CallBatchSnapshot | null>(null);
  const [batchSummary, setBatchSummary] = useState<DealershipBatchSummary | null>(null);
  const [editDealershipOpen, setEditDealershipOpen] = useState(false);
  const [phoneNumbersOpen, setPhoneNumbersOpen] = useState(false);
  const [analyticsDrawerOpen, setAnalyticsDrawerOpen] = useState(false);
  const [analyticsDrawerDetail, setAnalyticsDrawerDetail] = useState<AuditDetailItem | null>(null);
  const [analyticsDrawerLoading, setAnalyticsDrawerLoading] = useState(false);
  const [analyticsDrawerError, setAnalyticsDrawerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([
      fetchAnalyticsDealershipDetail(dealershipId),
      fetchAnalyticsDealershipPlans(dealershipId),
    ])
      .then(([item, plans]) => {
        if (!cancelled) {
          setRealDetail(item as DealershipAnalyticsDetail | null);
          setPlanParticipation(plans);
          setDetailLoading(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRealDetail(null);
          setPlanParticipation([]);
          setDetailError(error instanceof Error ? error.message : 'Не удалось загрузить данные точки');
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dealershipId]);

  async function reloadPlanParticipation() {
    const plans = await fetchAnalyticsDealershipPlans(dealershipId);
    setPlanParticipation(plans);
  }

  async function handleExcludePlan(plan: AnalyticsPlanParticipation) {
    const confirmed = window.confirm(`Исключить точку «${detail?.name ?? ''}» из расписания «${plan.name}»?`);
    if (!confirmed) return;
    setPlanActionStatus(null);
    setExcludingPlanId(plan.id);
    try {
      await excludeDealershipFromAnalyticsPlan(dealershipId, plan.id);
      await reloadPlanParticipation();
      setPlanActionStatus('Точка исключена из расписания');
    } catch (error) {
      setPlanActionStatus(error instanceof Error ? error.message : 'Не удалось исключить точку из расписания');
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

  async function handleOpenCallDetail(auditId: string) {
    setAnalyticsDrawerOpen(true);
    setAnalyticsDrawerDetail(null);
    setAnalyticsDrawerError(null);
    setAnalyticsDrawerLoading(true);
    try {
      const detail = await fetchAuditDetail(auditId);
      if (!detail) throw new Error('Аналитика звонка не найдена или ещё не готова.');
      setAnalyticsDrawerDetail(detail);
    } catch (error) {
      setAnalyticsDrawerError(error instanceof Error ? error.message : 'Не удалось загрузить аналитику звонка.');
    } finally {
      setAnalyticsDrawerLoading(false);
    }
  }

  useEffect(() => {
    try {
      const remembered = localStorage.getItem(ACTIVE_BATCH_STORAGE_KEY);
      if (remembered && remembered.trim()) {
        setActiveBatchId(remembered.trim());
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!activeBatchId || !detail) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      const data = await fetchBatchWithSummary(activeBatchId);
      if (!data || !data.batch) {
        if (!cancelled) {
          setActiveBatchId(null);
          setActiveBatch(null);
          setBatchSummary(null);
        }
        return;
      }
      if (cancelled) return;
      setActiveBatch(data.batch);
      const entry = (data.dealershipSummary || []).find(
        (d) => d.dealershipId === detail.id || (!d.dealershipId && d.dealershipName === detail.name),
      ) || null;
      setBatchSummary(entry);
      const isFinal = data.batch.status === 'completed' || data.batch.status === 'cancelled';
      if (!isFinal) {
        window.setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [activeBatchId, detail?.id, detail?.name]);

  if (detailLoading) {
    return (
      <div>
        {!isDealerDashboard && <button className="sa-btn-text" onClick={onBack}>← Точки</button>}
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Загружаем данные точки...</div>
      </div>
    );
  }

  if (detailError) {
    return (
      <div>
        {!isDealerDashboard && <button className="sa-btn-text" onClick={onBack}>← Точки</button>}
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>{detailError}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div>
        {!isDealerDashboard && <button className="sa-btn-text" onClick={onBack}>← Точки</button>}
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Точка не найдена</div>
      </div>
    );
  }

  const deltaSign = detail.deltaRating !== null ? (detail.deltaRating > 0 ? '+' : '') : '';
  const deltaText = detail.deltaRating !== null ? `${deltaSign}${detail.deltaRating}` : '—';
  const deltaCls = detail.deltaRating !== null
    ? detail.deltaRating > 0 ? 'sa-score-green' : detail.deltaRating < -5 ? 'sa-score-red' : 'sa-score-orange'
    : '';
  const dealershipNoAnswers = detail.noAnswers ?? detail.outcomeBreakdown?.no_answer ?? 0;
  const dealershipCalls = detail.auditsCount || Object.values(detail.outcomeBreakdown ?? {}).reduce((sum, value) => sum + value, 0);

  return (
    <div className="sa-detail-root">
      {/* Breadcrumb */}
      {!isDealerDashboard && (
        <div className="sa-breadcrumb">
          <button className="sa-btn-text" onClick={onBack}>Точки</button>
          <span className="sa-breadcrumb-sep">→</span>
          <span>{detail.name}</span>
        </div>
      )}

      {/* Header */}
      <div className="sa-detail-header">
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 4 }}>{detail.name}</h1>
          <p className="sa-page-subtitle" style={{ marginBottom: 0 }}>
            {dealership?.city || detail.city} · {dealershipTypeLabel(dealership?.type)} · {formatWorkingHours(dealership)}
          </p>
        </div>
        <div className="sa-detail-header-right">
          {!isDealerDashboard && <span className={statusBadgeClass(detail.status)}>{STATUS_LABELS[detail.status]}</span>}
          {!isDealerDashboard && <button className="sa-btn-outline" onClick={() => setPhoneNumbersOpen(true)}>Номера телефонов</button>}
          {!isDealerDashboard && <button className="sa-btn-outline" onClick={() => setEditDealershipOpen(true)}>Редактировать</button>}
        </div>
      </div>
      {activeBatch && batchSummary && (
        <div className="sa-meta" style={{ marginTop: -8, marginBottom: 12 }}>
          Сейчас идёт проверка этой точки ({batchSummary.completed}/{batchSummary.total}). Детали и управление — в трее проверок справа внизу.
        </div>
      )}
      {dealershipNoAnswers > 0 && (
        <div className="sa-batch-live-error" style={{ marginTop: -4, marginBottom: 16 }}>
          Недозвоны: {dealershipNoAnswers} из {dealershipCalls} звонков. Проверьте рабочие часы, доступность номеров и расписания прозвона.
        </div>
      )}

      <section className="sa-section" style={{ marginBottom: 24 }}>
        <AISummaryBlock
          title="AI-сводка по салону"
          summary={detail.aiSummary}
          loading={detailLoading}
          error={detailError}
        />
      </section>

      {/* KPI */}
      <div className="sa-kpi-grid" style={{ marginBottom: 32 }}>
        <KPI label="AI-рейтинг" value={detail.aiRating} cls={ratingClass(detail.aiRating)} />
        <KPI label="Динамика" value={deltaText} cls={deltaCls} />
        <KPI label="Проверки" value={detail.auditsCount} />
        <KPI label="Недозвоны" value={dealershipNoAnswers} cls={dealershipNoAnswers > 0 ? 'sa-score-orange' : 'sa-score-green'} />
        <KPI label="Сотрудники" value={detail.employeesCount} />
        <KPI
          label="Дозвон"
          value={detail.answerRate !== null ? `${detail.answerRate}%` : '—'}
          cls={detail.answerRate !== null ? answerRateClass(detail.answerRate) : ''}
        />
        <KPI
          label="Время ответа"
          value={detail.avgAnswerTimeSec !== null ? detail.avgAnswerTimeSec : '—'}
          cls={detail.avgAnswerTimeSec !== null ? answerTimeClass(detail.avgAnswerTimeSec) : ''}
          suffix={detail.avgAnswerTimeSec !== null ? 'с' : ''}
        />
        <KPI
          label="Время звонка"
          value={detail.avgCallDurationSec != null ? detail.avgCallDurationSec : '—'}
          suffix={detail.avgCallDurationSec != null ? 'с' : ''}
        />
      </div>

      {/* Schedules */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Участвует в расписаниях</h2>
        {planActionStatus && <div className="sa-meta" style={{ marginBottom: 10 }}>{planActionStatus}</div>}
        <PlanParticipationList
          plans={planParticipation}
          excludingPlanId={excludingPlanId}
          onOpenPlan={(id) => navigate(`/call-settings/plans/${encodeURIComponent(id)}/edit`)}
          onExcludePlan={handleExcludePlan}
          readOnly={isDealerDashboard}
        />
      </section>

      {/* Charts row */}
      <div className="sa-dashboard-grid" style={{ marginBottom: 32 }}>
        <div className="sa-card sa-grid-card sa-chart-equal">
          <TrendChart points={detail.timeSeries} />
        </div>
        <div className="sa-card sa-grid-card sa-chart-equal">
          <Heatmap hourly={detail.hourlyAnswerRate} />
        </div>
      </div>

      <div className="sa-dashboard-grid" style={{ marginBottom: 32 }}>
        <div className="sa-card sa-grid-card">
          <h3 className="sa-card-heading">Исходы звонков</h3>
          <OutcomeBreakdown data={detail.outcomeBreakdown} />
        </div>
        <div className="sa-card sa-grid-card">
          <h3 className="sa-card-heading">Качество коммуникации</h3>
          <CommunicationBreakdown data={detail.communicationBreakdown} />
        </div>
      </div>

      {/* Employees */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Сотрудники</h2>
        <EmployeesTable employees={detail.employees} onOpenEmployee={onOpenEmployee} />
      </section>

      {/* Insights */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Аналитика по ошибкам</h2>
        <TopIssues detail={detail} />
      </section>

      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">Соблюдение скрипта</h2>
        <div className="sa-card">
          <ScriptCompliance data={detail.scriptCompliance} />
        </div>
      </section>

      {/* Audit history */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">История проверок</h2>
        <AuditHistory audits={detail.audits} onOpenCall={handleOpenCallDetail} />
      </section>

      <DealershipModal
        mode="edit"
        open={editDealershipOpen}
        dealership={dealership}
        onClose={() => setEditDealershipOpen(false)}
        onSaved={(saved) => onDealershipSaved?.(saved)}
      />
      <DealershipPhoneNumbersModal
        dealershipId={dealershipId}
        open={phoneNumbersOpen}
        onClose={() => setPhoneNumbersOpen(false)}
      />
      <SlideOver open={analyticsDrawerOpen} title="Аналитика звонка" width="xl" onClose={closeAnalyticsDrawer}>
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
            onOpenEmployee={(employeeId) => onOpenEmployee?.(employeeId)}
          />
        ) : (
          <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Выберите звонок.</div>
        )}
      </SlideOver>
    </div>
  );
}
