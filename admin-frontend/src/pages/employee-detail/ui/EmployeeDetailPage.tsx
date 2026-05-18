import React, { useMemo, useState } from 'react';
import {
  getMockEmployeeDetail,
  STATUS_LABELS,
  COMM_LABELS,
  COMM_BADGE_CLASS,
  type EmployeeDetailData,
} from '../../../shared/lib/admin-panel/mockData';
import { ratingClass, deltaDisplay, statusBadgeClass, exportPageToPdf } from '../../../shared/lib/admin-panel/utils';

type Props = {
  employeeId: string;
  onBack: () => void;
  onOpenDealership?: (id: string) => void;
  onOpenCompanies?: () => void;
  sourceDealership?: { id: string; name: string } | null;
  actionButtons?: React.ReactNode;
  mockNotice?: string;
  detailOverride?: Partial<Pick<EmployeeDetailData, 'fullName' | 'dealershipName' | 'city'>>;
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

/* ────────────────────── Profile strip (compact horizontal card) ────────────────────── */

function ProfileStrip({ detail }: { detail: EmployeeDetailData }) {
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

function TrainerInsights({ detail }: { detail: EmployeeDetailData }) {
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

/* ────────────────────── Audit history ────────────────────── */

function AuditHistory({ audits }: { audits: EmployeeDetailData['audits'] }) {
  if (audits.length === 0) return <div className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Нет проверок за период</div>;
  return (
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
          {audits.slice(0, 20).map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.date).toLocaleDateString('ru-RU')}</td>
              <td>{a.type === 'training' ? 'Тренажёр' : 'Звонок'}</td>
              <td className="sa-text-right"><span className={ratingClass(a.score)}>{a.score}</span></td>
              <td>{a.verdict}</td>
              <td><button className="sa-btn-text sa-btn-sm" title="Скоро">Открыть разбор</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ════════════════════ Main component ════════════════════ */

export function EmployeeDetail({ employeeId, onBack, onOpenDealership, onOpenCompanies, sourceDealership, actionButtons, mockNotice, detailOverride }: Props) {
  const detail = useMemo(() => {
    const base = getMockEmployeeDetail(employeeId);
    return base ? { ...base, ...detailOverride } : null;
  }, [detailOverride, employeeId]);

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
            <button className="sa-btn-text" onClick={() => onOpenCompanies?.()}>Автосалоны</button>
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
        </div>
        <div className="sa-detail-header-right">
          {actionButtons}
          <span className={statusBadgeClass(detail.status)}>{STATUS_LABELS[detail.status]}</span>
          <button className="sa-btn-outline" onClick={() => exportPageToPdf(`Сотрудник_${detail.fullName}`)}>Экспорт PDF</button>
        </div>
      </div>

      {/* KPI row — full width, no cramped side-by-side with profile */}
      <div className="sa-kpi-grid sa-kpi-grid-emp">
        <KPI label="AI-рейтинг" value={detail.aiRating} cls={ratingClass(detail.aiRating)} />
        <KPI label="Динамика" value={delta.text} cls={delta.cls} />
        <KPI label="Проверки" value={detail.auditsCount} />
        <KPI label="Провалы" value={detail.failsCount} cls={detail.failsCount >= 2 ? 'sa-score-red' : detail.failsCount >= 1 ? 'sa-score-orange' : ''} />
        <KPI label="Коммуникация" value={COMM_LABELS[detail.communicationFlag]} cls={commCls} />
      </div>

      {/* Profile strip — compact horizontal summary */}
      <ProfileStrip detail={detail} />

      {/* Charts — line chart + horizontal bar breakdown */}
      <div className="sa-dashboard-grid" style={{ marginTop: 20, marginBottom: 28 }}>
        <div className="sa-card sa-grid-card sa-chart-equal">
          <TrendChart points={detail.timeSeries} />
        </div>
        <div className="sa-card sa-grid-card sa-chart-equal">
          <BlockBreakdown data={detail.blockBreakdown} />
        </div>
      </div>

      {/* Trainer insights */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <h2 className="sa-section-title">Аналитика по ошибкам</h2>
        <TrainerInsights detail={detail} />
      </section>

      {/* Audit history */}
      <section className="sa-section" style={{ marginBottom: 28 }}>
        <h2 className="sa-section-title">История проверок</h2>
        <AuditHistory audits={detail.audits} />
      </section>
    </div>
  );
}
