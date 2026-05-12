import React, { useMemo, useState } from 'react';
import {
  getMockAuditDetail,
  getAuditNavigationIds,
  AUDIT_TYPE_LABELS,
  AUDIT_STATUS_LABELS,
  AUDIT_STATUS_CLASS,
  type AuditDetailData,
  type ChecklistItem,
  type TranscriptLine,
  type AuditEvent,
} from '../../../shared/lib/admin-panel/mockData';
import { ratingClass, statusBadgeClass, exportPageToPdf } from '../../../shared/lib/admin-panel/utils';

type Props = {
  auditId: string;
  onBack: () => void;
  onNavigate: (id: string) => void;
  onOpenEmployee?: (id: string) => void;
};

/* ────────────────────── KPI Card ────────────────────── */

function KPI({ label, value, cls }: { label: string; value: string | number; cls?: string }) {
  return (
    <div className="sa-card sa-kpi-card">
      <div className="sa-kpi-label">{label}</div>
      <div className={`sa-kpi-value ${cls ?? ''}`}>{value}</div>
    </div>
  );
}

/* ────────────────────── Horizontal bar chart (block breakdown) ────────────────────── */

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
      <h3 className="sa-chart-title">Оценка по блокам</h3>
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
            {hoverIdx === i && <div className="sa-hbar-tooltip">{d.hint}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────── Checklist ────────────────────── */

const RESULT_ICON: Record<ChecklistItem['result'], string> = { pass: '✅', warn: '⚠️', fail: '❌' };
const RESULT_CLS: Record<ChecklistItem['result'], string> = { pass: 'sa-check-pass', warn: 'sa-check-warn', fail: 'sa-check-fail' };

function Checklist({ items }: { items: ChecklistItem[] }) {
  return (
    <div className="sa-card">
      <h3 className="sa-card-heading">Чек-лист</h3>
      <div className="sa-checklist">
        {items.map((item, i) => (
          <div key={i} className={`sa-checklist-item ${RESULT_CLS[item.result]}`}>
            <span className="sa-checklist-icon">{RESULT_ICON[item.result]}</span>
            <div className="sa-checklist-content">
              <div className="sa-checklist-label">{item.label}</div>
              <div className="sa-checklist-quote">«{item.quote}»</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────── Transcript + Events tabs ────────────────────── */

function DialogSection({ transcript, events }: { transcript: TranscriptLine[]; events: AuditEvent[] }) {
  const [tab, setTab] = useState<'transcript' | 'events'>('transcript');

  return (
    <div className="sa-card">
      <div className="sa-dialog-tabs">
        <button
          className={`sa-dialog-tab ${tab === 'transcript' ? 'sa-dialog-tab-active' : ''}`}
          onClick={() => setTab('transcript')}
        >
          Транскрипт
        </button>
        <button
          className={`sa-dialog-tab ${tab === 'events' ? 'sa-dialog-tab-active' : ''}`}
          onClick={() => setTab('events')}
        >
          События
        </button>
      </div>

      {tab === 'transcript' && (
        <div className="sa-transcript">
          {transcript.map((line, i) => (
            <div key={i} className={`sa-transcript-line ${line.speaker === 'client' ? 'sa-transcript-client' : 'sa-transcript-manager'} ${line.critical ? 'sa-transcript-critical' : ''}`}>
              <div className="sa-transcript-meta">
                <span className="sa-transcript-time">{line.time}</span>
                <span className="sa-transcript-speaker">{line.speaker === 'client' ? 'Клиент' : 'Менеджер'}</span>
              </div>
              <div className="sa-transcript-text">{line.text}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'events' && (
        <div className="sa-events-list">
          {events.map((ev, i) => (
            <div key={i} className={`sa-event-item sa-event-${ev.type}`}>
              <span className="sa-event-time">{ev.time}</span>
              <span className="sa-event-dot" />
              <span className="sa-event-label">{ev.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ────────────────────── Errors / Questions / Trainings ────────────────────── */

function ErrorsBlock({ detail }: { detail: AuditDetailData }) {
  return (
    <div className="sa-detail-insights">
      <div className="sa-card" style={{ flex: 1 }}>
        <h3 className="sa-card-heading">ТОП-ошибки</h3>
        <ul className="sa-issue-list">
          {detail.errors.map((item, i) => (
            <li key={i} className="sa-issue-item">
              <span className="sa-issue-name">{item.issue}</span>
              <span className="sa-issue-pct">{item.percent}%</span>
              <div className="sa-issue-bar"><div className="sa-issue-bar-fill" style={{ width: `${item.percent}%` }} /></div>
            </li>
          ))}
        </ul>
      </div>
      <div className="sa-card" style={{ flex: 1 }}>
        <h3 className="sa-card-heading">Сложные вопросы</h3>
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

/* ════════════════════ Main component ════════════════════ */

export function AuditDetail({ auditId, onBack, onNavigate, onOpenEmployee }: Props) {
  const detail = useMemo(() => getMockAuditDetail(auditId), [auditId]);
  const nav = useMemo(() => getAuditNavigationIds(auditId), [auditId]);

  if (!detail) {
    return (
      <div>
        <button className="sa-btn-text" onClick={onBack}>← Проверки</button>
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Проверка не найдена</div>
      </div>
    );
  }

  const dateStr = new Date(detail.dateTime).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = new Date(detail.dateTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="sa-detail-root">
      {/* ── Breadcrumb ── */}
      <div className="sa-breadcrumb">
        <button className="sa-btn-text" onClick={onBack}>Проверки</button>
        <span className="sa-breadcrumb-sep">→</span>
        <span>Разбор #{detail.id.replace('audit-', '')}</span>
      </div>

      {/* ── A) Header ── */}
      <div className="sa-detail-header">
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 4 }}>
            {AUDIT_TYPE_LABELS[detail.type]}: {detail.employeeName}
          </h1>
          <p className="sa-page-subtitle" style={{ marginBottom: 0 }}>
            {dateStr}, {timeStr} · {detail.dealershipName} · {detail.city}
          </p>
        </div>
        <div className="sa-detail-header-right">
          <span className={`sa-status-badge ${AUDIT_STATUS_CLASS[detail.status]}`}>
            {AUDIT_STATUS_LABELS[detail.status]}
          </span>
          <button className="sa-btn-outline" onClick={() => exportPageToPdf(`Проверка_${detail.id}`)}>Экспорт PDF</button>
        </div>
      </div>

      {/* ── B) Executive Summary ── */}
      <div className="sa-card sa-audit-summary">
        <div className="sa-audit-summary-score-wrap">
          <div className={`sa-audit-summary-score ${ratingClass(detail.totalScore)}`}>{detail.totalScore}</div>
          <div className="sa-audit-summary-score-label">Общий балл</div>
        </div>
        <div className="sa-audit-summary-body">
          <div className="sa-audit-summary-verdict">{detail.verdict}</div>
          <div className="sa-audit-summary-meta">
            {detail.type === 'trainer' && detail.scenarioName && (
              <span className="sa-metric-chip">Сценарий: {detail.scenarioName}</span>
            )}
            {detail.type === 'trainer' && detail.assignedBy && (
              <span className="sa-metric-chip">Назначил: {detail.assignedBy}</span>
            )}
            {detail.type === 'call' && detail.answerTimeSec !== null && (
              <span className="sa-metric-chip">Время ответа: {detail.answerTimeSec} сек</span>
            )}
            {detail.type === 'call' && detail.attempts !== null && (
              <span className="sa-metric-chip">Попытки: {detail.attempts}</span>
            )}
            {detail.type === 'call' && detail.callback !== null && (
              <span className="sa-metric-chip">Callback: {detail.callback ? 'Да' : 'Нет'}</span>
            )}
          </div>
          {detail.status === 'failed' && detail.failReason && (
            <div className="sa-audit-fail-reason">
              <strong>Причина провала:</strong> {detail.failReason}
            </div>
          )}
          <div className="sa-audit-summary-links">
            <button className="sa-btn-text" onClick={() => onOpenEmployee?.(detail.employeeId)}>
              Профиль сотрудника →
            </button>
          </div>
        </div>
      </div>

      {/* ── C) KPI Cards ── */}
      <div className="sa-kpi-grid sa-kpi-grid-audit">
        <KPI label="Общий балл" value={detail.totalScore} cls={ratingClass(detail.totalScore)} />
        {detail.blocksBreakdown.slice(0, 4).map((b) => (
          <KPI key={b.block} label={b.block} value={b.score} cls={ratingClass(b.score)} />
        ))}
        {detail.type === 'call' && detail.answerTimeSec !== null && (
          <KPI label="Время ответа" value={`${detail.answerTimeSec} сек`} cls={detail.answerTimeSec <= 15 ? 'sa-score-green' : detail.answerTimeSec <= 30 ? 'sa-score-orange' : 'sa-score-red'} />
        )}
      </div>

      {/* ── D) Block breakdown chart ── */}
      <div className="sa-card" style={{ marginBottom: 24 }}>
        <BlockBreakdown data={detail.blocksBreakdown} />
      </div>

      {/* ── E) Checklist ── */}
      <div style={{ marginBottom: 24 }}>
        <Checklist items={detail.checklist} />
      </div>

      {/* ── F) Dialog tabs (transcript + events) ── */}
      <div style={{ marginBottom: 24 }}>
        <DialogSection transcript={detail.transcript} events={detail.events} />
      </div>

      {/* ── G) Errors & recommendations ── */}
      <section className="sa-section" style={{ marginBottom: 24 }}>
        <h2 className="sa-section-title">Ошибки и рекомендации</h2>
        <ErrorsBlock detail={detail} />
      </section>

      {/* ── H) Navigation ── */}
      <div className="sa-audit-nav">
        {nav.prevId ? (
          <button className="sa-btn-outline" onClick={() => onNavigate(nav.prevId!)}>
            ← Предыдущая проверка
          </button>
        ) : <span />}
        {nav.nextId ? (
          <button className="sa-btn-outline" onClick={() => onNavigate(nav.nextId!)}>
            Следующая проверка →
          </button>
        ) : <span />}
      </div>
    </div>
  );
}
