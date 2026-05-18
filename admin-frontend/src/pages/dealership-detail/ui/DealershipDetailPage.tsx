import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../entities/session';
import {
  getMockDealershipDetail,
  getMockDealershipDetailByName,
  STATUS_LABELS,
  type DealershipDetail as Detail,
} from '../../../shared/lib/admin-panel/mockData';
import type { DealershipItem, DealershipType } from '../../../shared/api/adminPanel';
import { DealershipModal, formatWorkingHours } from '../../../shared/ui/dealership-modal/DealershipModal';
import { DealershipPhoneNumbersModal } from '../../../shared/ui/dealership-phone-numbers/DealershipPhoneNumbersModal';
import { ratingClass, answerRateClass, answerTimeClass, statusBadgeClass, exportPageToPdf } from '../../../shared/lib/admin-panel/utils';
import {
  ACTIVE_BATCH_STORAGE_KEY,
  fetchBatchWithSummary,
  type CallBatchSnapshot,
  type DealershipBatchSummary,
} from '../../../shared/lib/admin-panel/batchUtils';

/* ────────────────────── Props ────────────────────── */

type Props = {
  dealershipId: string;
  dealership?: DealershipItem | null;
  onBack: () => void;
  onOpenEmployee?: (id: string) => void;
  onOpenBatchDetail?: (batchId: string) => void;
  onDealershipSaved?: (dealership: DealershipItem) => void;
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

function buildFallbackDetail(dealership: DealershipItem): Detail {
  return {
    id: dealership.id,
    name: dealership.name,
    city: dealership.city || '—',
    aiRating: 0,
    answerRate: null,
    avgAnswerTimeSec: null,
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
                  {closed ? <div>Салон закрыт</div> : <><div>Дозвон: {pct.toFixed(0)}%</div></>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────── Employees table ────────────────────── */

function EmployeesTable({ employees, onOpenEmployee }: { employees: Detail['employees']; onOpenEmployee?: (id: string) => void }) {
  if (employees.length === 0) return <div className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Нет данных о сотрудниках</div>;
  return (
    <>
      <div className="sa-table-wrap">
        <table className="sa-table sa-table-sortable">
          <thead>
            <tr>
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
    </>
  );
}

/* ────────────────────── Top Issues ────────────────────── */

function TopIssues({ detail }: { detail: Detail }) {
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

function AuditHistory({ audits }: { audits: Detail['audits'] }) {
  if (audits.length === 0) return <div className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Нет проверок за период</div>;
  return (
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
          {audits.slice(0, 20).map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.date).toLocaleDateString('ru-RU')}</td>
              <td>{a.type === 'training' ? 'Тренажёр' : 'Звонок'}</td>
              <td>{a.employeeName}</td>
              <td className="sa-text-right"><span className={ratingClass(a.score)}>{a.score}</span></td>
              <td><button className="sa-btn-text sa-btn-sm" title="Скоро">Открыть разбор</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────────── Main Component ────────────────────── */

export function DealershipDetail({ dealershipId, dealership, onBack, onOpenEmployee, onOpenBatchDetail, onDealershipSaved }: Props) {
  const detail = useMemo(
    () => getMockDealershipDetail(dealershipId) || (dealership?.name ? getMockDealershipDetailByName(dealership.name) : null) || (dealership ? buildFallbackDetail(dealership) : null),
    [dealershipId, dealership],
  );
  const [checkLoading, setCheckLoading] = useState(false);
  const [checkStatus, setCheckStatus] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeBatch, setActiveBatch] = useState<CallBatchSnapshot | null>(null);
  const [batchSummary, setBatchSummary] = useState<DealershipBatchSummary | null>(null);
  const [editDealershipOpen, setEditDealershipOpen] = useState(false);
  const [phoneNumbersOpen, setPhoneNumbersOpen] = useState(false);
  const hasActiveManual = !!activeBatch && (activeBatch.status === 'running' || activeBatch.status === 'paused');

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

  if (!detail) {
    return (
      <div>
        <button className="sa-btn-text" onClick={onBack}>← Автосалоны</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Автосалон не найден</div>
      </div>
    );
  }

  const deltaSign = detail.deltaRating !== null ? (detail.deltaRating > 0 ? '+' : '') : '';
  const deltaText = detail.deltaRating !== null ? `${deltaSign}${detail.deltaRating}` : '—';
  const deltaCls = detail.deltaRating !== null
    ? detail.deltaRating > 0 ? 'sa-score-green' : detail.deltaRating < -5 ? 'sa-score-red' : 'sa-score-orange'
    : '';

  async function handleDealershipCheck() {
    setCheckLoading(true);
    setCheckStatus(null);
    try {
      const numsRes = await apiFetch('/api/admin/test-numbers');
      const numsData = await numsRes.json().catch(() => ({}));
      const numbers = Array.isArray(numsData?.numbers) ? numsData.numbers.map((x: unknown) => String(x)).filter((x: string) => x.trim()) : [];
      if (!numbers.length) {
        throw new Error('Нет тестовых номеров. Добавьте VOX_TEST_TO или VOX_TEST_NUMBERS');
      }
      const res = await apiFetch('/api/admin/call-batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'single_dealership',
          title: `Проверка салона ${detail.name}`,
          maxConcurrency: 1,
          startIntervalMs: 250,
          maxAttempts: 3,
          jobs: [{
            dealershipId: detail.id,
            dealershipName: detail.name,
            phone: numbers[0],
          }],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Не удалось запустить проверку');
      const batchId = String(data.batchId || '');
      if (!batchId) throw new Error('Сервер не вернул batchId');
      setCheckStatus('Проверка запущена');
      setActiveBatchId(batchId);
      try { localStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, batchId); } catch {}
    } catch (e: unknown) {
      let message = e instanceof Error ? e.message : 'Ошибка запуска проверки';
      if (message.includes('Уже есть активная ручная проверка')) {
        message = 'Уже есть активная ручная проверка. Управляйте ею в трее проверок в правом нижнем углу.';
      }
      setCheckStatus(message);
    } finally {
      setCheckLoading(false);
    }
  }

  return (
    <div className="sa-detail-root">
      {/* Breadcrumb */}
      <div className="sa-breadcrumb">
        <button className="sa-btn-text" onClick={onBack}>Автосалоны</button>
        <span className="sa-breadcrumb-sep">→</span>
        <span>{detail.name}</span>
      </div>

      {/* Header */}
      <div className="sa-detail-header">
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 4 }}>{detail.name}</h1>
          <p className="sa-page-subtitle" style={{ marginBottom: 0 }}>
            {dealership?.city || detail.city} · {dealershipTypeLabel(dealership?.type)} · {formatWorkingHours(dealership)}
          </p>
        </div>
        <div className="sa-detail-header-right">
          <span className={statusBadgeClass(detail.status)}>{STATUS_LABELS[detail.status]}</span>
          <button className="sa-btn-outline" onClick={() => setPhoneNumbersOpen(true)}>Номера телефонов</button>
          <button className="sa-btn-outline" onClick={() => setEditDealershipOpen(true)}>Редактировать</button>
          <button
            className="sa-btn-danger"
            onClick={handleDealershipCheck}
            disabled={checkLoading || hasActiveManual}
            title={hasActiveManual ? 'Уже есть активная ручная проверка — управляйте ею в трее проверок.' : undefined}
          >
            <span className="sa-btn-danger-dot" />
            {checkLoading ? 'Запуск...' : 'Проверить автосалон'}
          </button>
          <button className="sa-btn-outline" onClick={() => exportPageToPdf(`Автосалон_${detail.name}`)}>Экспорт PDF</button>
        </div>
      </div>
      {checkStatus && <div className="sa-batch-live-note" style={{ marginTop: -8, marginBottom: 8 }}>{checkStatus}</div>}
      {activeBatch && batchSummary && !checkStatus && (
        <div className="sa-meta" style={{ marginTop: -8, marginBottom: 12 }}>
          Сейчас идёт проверка этого автосалона ({batchSummary.completed}/{batchSummary.total}). Детали и управление — в трее проверок справа внизу.
        </div>
      )}

      {/* KPI */}
      <div className="sa-kpi-grid" style={{ marginBottom: 32 }}>
        <KPI label="AI-рейтинг" value={detail.aiRating} cls={ratingClass(detail.aiRating)} />
        <KPI label="Динамика" value={deltaText} cls={deltaCls} />
        <KPI label="Проверки" value={detail.auditsCount} />
        <KPI label="Сотрудники" value={detail.employeesCount} />
        <KPI label="Тип автосалона" value={dealershipTypeLabel(dealership?.type)} />
        <KPI label="Время работы" value={formatWorkingHours(dealership)} />
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
      </div>

      {/* Charts row */}
      <div className="sa-dashboard-grid" style={{ marginBottom: 32 }}>
        <div className="sa-card sa-grid-card sa-chart-equal">
          <TrendChart points={detail.timeSeries} />
        </div>
        <div className="sa-card sa-grid-card sa-chart-equal">
          <Heatmap hourly={detail.hourlyAnswerRate} />
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

      {/* Audit history */}
      <section className="sa-section" style={{ marginBottom: 32 }}>
        <h2 className="sa-section-title">История проверок</h2>
        <AuditHistory audits={detail.audits} />
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
    </div>
  );
}
