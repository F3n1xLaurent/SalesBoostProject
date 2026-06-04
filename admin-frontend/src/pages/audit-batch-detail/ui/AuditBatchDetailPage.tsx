import React, { useEffect, useMemo, useState } from 'react';
import type { CallBatchJobItem, CallBatchListItem } from '../../../shared/api/adminPanel';
import { fetchCallBatchById, fetchCallBatchJobs } from '../../../shared/api/adminPanel';

type Props = {
  batchId: string;
  initialBatch?: CallBatchListItem | null;
  onBack: () => void;
  onOpenAudit?: (auditId: string) => void;
  onOpenDealership?: (dealershipId: string) => void;
};

function toStatusBadgeClass(status: CallBatchListItem['status'], failedJobs: number): string {
  if (status === 'running') return 'sa-batch-state-in_progress';
  if (status === 'paused') return 'sa-batch-state-queued';
  if (status === 'cancelled') return 'sa-batch-state-cancelled';
  if (failedJobs > 0) return 'sa-batch-state-partial';
  return 'sa-batch-state-completed';
}

function statusLabel(status: CallBatchListItem['status'], failedJobs: number): string {
  if (status === 'running') return 'В работе';
  if (status === 'paused') return 'Пауза';
  if (status === 'cancelled') return 'Остановлено';
  if (failedJobs > 0) return 'Завершено с ошибками';
  return 'Завершено';
}

function modeLabel(mode: CallBatchListItem['mode']): string {
  if (mode === 'auto_daily') return 'Авто-ежедневный';
  if (mode === 'all_dealerships') return 'Сеть';
  if (mode === 'single_dealership') return 'Одна точка';
  return 'Ручной';
}

function jobStatusLabel(status: CallBatchJobItem['status']): string {
  if (status === 'queued') return 'В очереди';
  if (status === 'dialing') return 'Набор';
  if (status === 'in_progress') return 'В работе';
  if (status === 'retry_wait') return 'Повтор';
  if (status === 'completed') return 'Завершено';
  if (status === 'failed') return 'Ошибка';
  return 'Отменено';
}

function jobStatusClass(status: CallBatchJobItem['status']): string {
  if (status === 'queued') return 'sa-batch-state-queued';
  if (status === 'dialing' || status === 'in_progress') return 'sa-batch-state-in_progress';
  if (status === 'retry_wait') return 'sa-batch-state-partial';
  if (status === 'completed') return 'sa-batch-state-completed';
  if (status === 'failed') return 'sa-batch-state-failed';
  return 'sa-batch-state-cancelled';
}

export function AuditBatchDetail({ batchId, initialBatch = null, onBack, onOpenAudit, onOpenDealership }: Props) {
  const [batch, setBatch] = useState<CallBatchListItem | null>(initialBatch);
  const [jobs, setJobs] = useState<CallBatchJobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setError(null);
        const [meta, items] = await Promise.all([
          fetchCallBatchById(batchId),
          fetchCallBatchJobs(batchId, 500),
        ]);
        if (cancelled) return;
        setBatch(meta);
        setJobs(items);
      } catch {
        if (!cancelled) setError('Не удалось загрузить детали batch');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    setLoading(true);
    load();
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  useEffect(() => {
    if (!batch || (batch.status !== 'running' && batch.status !== 'paused')) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const [meta, items] = await Promise.all([
          fetchCallBatchById(batchId),
          fetchCallBatchJobs(batchId, 500),
        ]);
        if (cancelled) return;
        setBatch(meta);
        setJobs(items);
      } catch {
        // silent background polling
      }
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [batch, batchId]);

  const title = useMemo(() => {
    if (!batch) return `Batch ${batchId.slice(-8)}`;
    if (batch.title?.trim()) return batch.title;
    if (batch.mode === 'all_dealerships') return 'Проверка сети';
    if (batch.mode === 'single_dealership') return 'Проверка точки';
    if (batch.mode === 'auto_daily') return 'Авто-проверка сети';
    return 'Ручная проверка';
  }, [batch, batchId]);

  function outcomeLabel(raw: string | null): string {
    if (!raw) return '—';
    const v = raw.toLowerCase();
    if (v === 'completed' || v === 'disconnected') return 'Диалог завершён';
    if (v === 'busy') return 'Занято';
    if (v === 'no_answer') return 'Нет ответа';
    if (v === 'failed') return 'Ошибка';
    if (v === 'queued') return 'В очереди';
    if (v === 'retry_wait') return 'Ожидает повтора';
    if (v === 'in_progress' || v === 'dialing') return 'В процессе';
    return raw;
  }

  function linkReasonLabel(reason?: string | null): string {
    if (!reason) return 'Разбор еще не сформирован';
    if (reason === 'no_call_review_yet') return 'Разбор еще не сформирован';
    if (reason === 'no_linked_call') return 'Связка звонка не найдена';
    return 'Связка временно недоступна';
  }

  const canUsePreviewMock = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const host = window.location.hostname;
    const local = host === 'localhost' || host === '127.0.0.1';
    const titleLower = (title || '').toLowerCase();
    const looksLikeTest =
      titleLower.includes('test') ||
      titleLower.includes('smoke') ||
      titleLower.includes('тест') ||
      titleLower.includes('прогон') ||
      titleLower.includes('simulated');
    return local || looksLikeTest;
  }, [title]);

  const previewMockJobs = useMemo<CallBatchJobItem[]>(() => {
    if (!batch || batch.totalJobs <= 0) return [];
    const demoDealerships = [
      'Точка Центральный',
      'Точка Север',
      'Точка Юг',
      'Точка Премиум',
      'Точка Восток',
    ];
    const demoOutcomes = ['completed', 'busy', 'no_answer', 'disconnected'] as const;
    const count = Math.min(Math.max(batch.totalJobs, 8), 24);
    const seedBase = batch.id.length;
    const rows: CallBatchJobItem[] = [];
    for (let i = 0; i < count; i += 1) {
      const seed = (i * 17 + seedBase * 13) % 100;
      const dName = demoDealerships[i % demoDealerships.length];
      const status: CallBatchJobItem['status'] =
        seed < 52 ? 'completed'
        : seed < 66 ? 'failed'
        : seed < 78 ? 'retry_wait'
        : seed < 90 ? 'queued'
        : 'in_progress';
      const attempt = status === 'queued' ? 0 : status === 'retry_wait' ? 2 : 1;
      const outcome = status === 'completed' ? demoOutcomes[0] : status === 'failed' ? demoOutcomes[(i % 3) + 1] : null;
      rows.push({
        id: `preview_${batch.id}_${i}`,
        dealershipId: `preview_d_${i % demoDealerships.length}`,
        dealershipName: dName,
        phone: `+7 900 ${String(100 + i).padStart(3, '0')}-${String(10 + (i % 89)).padStart(2, '0')}-${String(10 + ((i * 3) % 89)).padStart(2, '0')}`,
        status,
        attempt,
        maxAttempts: 3,
        startedAt: status === 'queued' ? null : new Date(Date.now() - i * 42000).toISOString(),
        endedAt: status === 'completed' || status === 'failed' ? new Date(Date.now() - i * 35000).toISOString() : null,
        lastOutcome: outcome,
        lastError: status === 'failed' ? 'Не удалось установить устойчивый контакт' : null,
      });
    }
    return rows;
  }, [batch]);

  const displayJobs = useMemo(() => {
    if (jobs.length > 0) return jobs;
    if (!canUsePreviewMock) return [];
    return previewMockJobs;
  }, [jobs, canUsePreviewMock, previewMockJobs]);

  const totals = useMemo(() => {
    const total = displayJobs.length;
    const completed = displayJobs.filter((j) => j.status === 'completed').length;
    const failed = displayJobs.filter((j) => j.status === 'failed').length;
    const active = displayJobs.filter((j) => j.status === 'in_progress' || j.status === 'dialing').length;
    const retry = displayJobs.filter((j) => j.status === 'retry_wait').length;
    const queued = displayJobs.filter((j) => j.status === 'queued').length;
    const cancelled = displayJobs.filter((j) => j.status === 'cancelled').length;
    const avgAttempts = total > 0
      ? Math.round((displayJobs.reduce((sum, j) => sum + Math.max(1, j.attempt), 0) / total) * 10) / 10
      : 0;
    const connectionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    const errorRate = total > 0 ? Math.round((failed / total) * 100) : 0;
    return { total, completed, failed, active, retry, queued, cancelled, avgAttempts, connectionRate, errorRate };
  }, [displayJobs]);

  const dealershipStats = useMemo(() => {
    const m = new Map<string, {
      key: string;
      dealershipName: string;
      total: number;
      completed: number;
      failed: number;
      retry: number;
      active: number;
      queued: number;
    }>();

    for (const job of displayJobs) {
      const key = job.dealershipId || job.dealershipName || 'unknown';
      const name = job.dealershipName || 'Точка';
      const row = m.get(key) || {
        key, dealershipName: name, total: 0, completed: 0, failed: 0, retry: 0, active: 0, queued: 0,
      };
      row.total += 1;
      if (job.status === 'completed') row.completed += 1;
      else if (job.status === 'failed') row.failed += 1;
      else if (job.status === 'retry_wait') row.retry += 1;
      else if (job.status === 'queued') row.queued += 1;
      else if (job.status === 'dialing' || job.status === 'in_progress') row.active += 1;
      m.set(key, row);
    }

    return Array.from(m.values())
      .map((row) => {
        const completionRate = row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0;
        const riskRate = row.total > 0 ? Math.round((row.failed / row.total) * 100) : 0;
        const communication: 'good' | 'mid' | 'risk' = completionRate >= 70 && riskRate <= 10
          ? 'good'
          : completionRate >= 40
          ? 'mid'
          : 'risk';
        const summary =
          communication === 'good'
            ? 'Скрипт выполняется стабильно, критичных сбоев не видно.'
            : communication === 'mid'
            ? 'Есть неоднородность: часть звонков требует повторного контроля.'
            : 'Высокий риск потери лида: нужны корректировки сценария и дообучение.';
        const linked = displayJobs.find(
          (j) => (j.dealershipId || j.dealershipName || 'unknown') === row.key && !!j.linkedAuditId,
        );
        const firstByDealership = displayJobs.find(
          (j) => (j.dealershipId || j.dealershipName || 'unknown') === row.key,
        );
        return {
          ...row,
          completionRate,
          riskRate,
          communication,
          summary,
          linkedAuditId: linked?.linkedAuditId ?? null,
          linkReason: linked?.linkReason ?? firstByDealership?.linkReason ?? 'no_call_review_yet',
        };
      })
      .sort((a, b) => a.completionRate - b.completionRate || b.failed - a.failed);
  }, [displayJobs]);

  const outcomeTop = useMemo(() => {
    const counter = new Map<string, number>();
    for (const j of displayJobs) {
      const outcome = j.lastOutcome || (j.status === 'completed' ? 'completed' : j.status);
      counter.set(outcome, (counter.get(outcome) || 0) + 1);
    }
    return Array.from(counter.entries())
      .map(([name, value]) => ({ name: outcomeLabel(name), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [displayJobs]);

  const aiSummary = useMemo(() => {
    if (!totals.total) return 'Недостаточно данных для итоговой аналитики.';
    const parts: string[] = [];
    if (totals.connectionRate >= 70) parts.push('Хорошая конверсия дозвона по batch.');
    else if (totals.connectionRate >= 40) parts.push('Средняя конверсия: есть резерв по качеству первого контакта.');
    else parts.push('Низкая конверсия дозвона: требуется корректировка скрипта и таймингов.');

    if (totals.errorRate >= 25) parts.push('Высокая доля ошибок, рекомендован разбор проблемных кейсов.');
    else if (totals.errorRate >= 10) parts.push('Умеренная доля ошибок, стоит точечно усилить контроль.');
    else parts.push('Ошибки в допустимом коридоре.');

    if (totals.retry > 0) parts.push('Есть повторы вызовов: полезно пересмотреть стратегию дозвона.');
    return parts.join(' ');
  }, [totals]);

  function compositionWidth(count: number): string {
    if (!totals.total || count <= 0) return '0%';
    return `${Math.max(2, (count / totals.total) * 100)}%`;
  }

  return (
    <>
      <button className="sa-btn-outline sa-btn-sm" onClick={onBack} style={{ marginBottom: 12 }}>
        ← Назад к списку batch
      </button>

      <div className="sa-batch-detail-head">
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 6 }}>{title}</h1>
          <div className="sa-page-subtitle" style={{ margin: 0 }}>
            {batch ? `${new Date(batch.createdAt).toLocaleString('ru-RU')} · ${modeLabel(batch.mode)}` : `ID: ${batchId}`}
          </div>
        </div>
        {batch && (
          <span className={`sa-batch-state ${toStatusBadgeClass(batch.status, batch.failedJobs)}`}>
            {statusLabel(batch.status, batch.failedJobs)}
          </span>
        )}
      </div>

      {error && <div className="sa-batch-live-error" style={{ marginBottom: 12 }}>{error}</div>}
      {loading ? (
        <div className="sa-meta" style={{ padding: 16 }}>Загрузка...</div>
      ) : (
        <>
          {jobs.length === 0 && displayJobs.length > 0 && (
            <div className="sa-batch-live-note" style={{ marginBottom: 12 }}>
              Для предпросмотра показаны демо-данные звонков: у этого тестового batch пока нет реальных jobs.
            </div>
          )}
          {batch && (
            <div className="sa-kpi-grid" style={{ marginBottom: 12 }}>
              <div className="sa-kpi-card"><div className="sa-kpi-label">Всего</div><div className="sa-kpi-value">{batch.totalJobs}</div></div>
              <div className="sa-kpi-card"><div className="sa-kpi-label">Выполнено</div><div className="sa-kpi-value">{batch.completedJobs}</div></div>
              <div className="sa-kpi-card"><div className="sa-kpi-label">В работе</div><div className="sa-kpi-value">{batch.inProgressJobs}</div></div>
              <div className="sa-kpi-card"><div className="sa-kpi-label">Ошибки</div><div className="sa-kpi-value">{batch.failedJobs}</div></div>
              <div className="sa-kpi-card"><div className="sa-kpi-label">Повторы</div><div className="sa-kpi-value">{batch.retryingJobs}</div></div>
            </div>
          )}

          <div className="sa-card" style={{ marginBottom: 16 }}>
            <h3 className="sa-card-heading">Сводка теста по звонкам</h3>
            <div className="sa-batch-composition-track">
              <span className="sa-batch-segment sa-batch-segment-completed" style={{ width: compositionWidth(totals.completed) }} />
              <span className="sa-batch-segment sa-batch-segment-active" style={{ width: compositionWidth(totals.active) }} />
              <span className="sa-batch-segment sa-batch-segment-retry" style={{ width: compositionWidth(totals.retry) }} />
              <span className="sa-batch-segment sa-batch-segment-failed" style={{ width: compositionWidth(totals.failed) }} />
              <span className="sa-batch-segment sa-batch-segment-queued" style={{ width: compositionWidth(totals.queued + totals.cancelled) }} />
            </div>
            <div className="sa-batch-composition-legend">
              <span><i className="sa-dot sa-dot-completed" /> Завершено: <strong>{totals.completed}</strong></span>
              <span><i className="sa-dot sa-dot-active" /> В работе: <strong>{totals.active}</strong></span>
              <span><i className="sa-dot sa-dot-retry" /> Повтор: <strong>{totals.retry}</strong></span>
              <span><i className="sa-dot sa-dot-failed" /> Ошибки: <strong>{totals.failed}</strong></span>
              <span><i className="sa-dot sa-dot-queued" /> Очередь/стоп: <strong>{totals.queued + totals.cancelled}</strong></span>
            </div>
            <div className="sa-batch-summary-inline">
              <span>Конверсия дозвона: <strong>{totals.connectionRate}%</strong></span>
              <span>Доля ошибок: <strong>{totals.errorRate}%</strong></span>
              <span>Среднее число попыток: <strong>{totals.avgAttempts}</strong></span>
            </div>
            <div className="sa-meta" style={{ marginTop: 8, fontSize: 13, color: 'var(--sa-text-primary)' }}>
              <strong>AI Summary:</strong> {aiSummary}
            </div>
            {outcomeTop.length > 0 && (
              <div className="sa-batch-summary-inline">
                {outcomeTop.map((o) => (
                  <span key={o.name} className="sa-metric-chip">{o.name}: <strong>{o.value}</strong></span>
                ))}
              </div>
            )}
          </div>

      <section className="sa-section" style={{ marginBottom: 16 }}>
            <h3 className="sa-section-title">Точки в batch</h3>
            <div className="sa-companies-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Точка</th>
                    <th className="sa-text-right">Звонков</th>
                    <th className="sa-text-right">Успешно</th>
                    <th className="sa-text-right">Ошибки</th>
                    <th className="sa-text-right">Повторы</th>
                    <th className="sa-text-right">Конверсия</th>
                    <th>Коммуникация</th>
                    <th>Сводка</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {dealershipStats.length === 0 ? (
                    <tr><td colSpan={9} className="sa-empty-state">Нет данных по точкам</td></tr>
                  ) : dealershipStats.map((d) => (
                  <tr key={d.key}>
                      <td>{d.dealershipName}</td>
                      <td className="sa-text-right">{d.total}</td>
                      <td className="sa-text-right">{d.completed}</td>
                      <td className="sa-text-right">{d.failed}</td>
                      <td className="sa-text-right">{d.retry}</td>
                      <td className="sa-text-right"><span className={d.completionRate >= 70 ? 'sa-score-green' : d.completionRate >= 40 ? 'sa-score-orange' : 'sa-score-red'}>{d.completionRate}%</span></td>
                      <td>
                        <span className={`sa-status-badge ${d.communication === 'good' ? 'sa-status-good' : d.communication === 'mid' ? 'sa-status-medium' : 'sa-status-bad'}`}>
                          {d.communication === 'good' ? 'Сильная' : d.communication === 'mid' ? 'Средняя' : 'Риск'}
                        </span>
                      </td>
                      <td>{d.summary}</td>
                      <td>
                        {onOpenDealership && d.key ? (
                          <button
                            className="sa-btn-text sa-btn-sm"
                            onClick={() => onOpenDealership?.(d.key)}
                          >
                            Открыть точку →
                          </button>
                        ) : d.linkedAuditId ? (
                          <button className="sa-btn-text sa-btn-sm" onClick={() => onOpenAudit?.(d.linkedAuditId!)}>
                            Открыть диалог →
                          </button>
                        ) : (
                          <span className="sa-meta">{linkReasonLabel(d.linkReason)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="sa-companies-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Точка</th>
                  <th>Телефон</th>
                  <th>Статус</th>
                  <th className="sa-text-right">Попытка</th>
                  <th>Итог</th>
                  <th>Ошибка</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {displayJobs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="sa-empty-state">Нет jobs для выбранного batch</td>
                  </tr>
                ) : (
                  displayJobs.map((job) => (
                    <tr key={job.id}>
                      <td>{job.startedAt ? new Date(job.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td>{job.dealershipName || 'Точка'}</td>
                      <td>{job.phone}</td>
                      <td><span className={`sa-batch-state ${jobStatusClass(job.status)}`}>{jobStatusLabel(job.status)}</span></td>
                      <td className="sa-text-right">{job.attempt}/{job.maxAttempts}</td>
                      <td>{outcomeLabel(job.lastOutcome)}</td>
                      <td>{job.lastError || '—'}</td>
                      <td>
                        {job.linkedAuditId ? (
                          <button className="sa-btn-text sa-btn-sm" onClick={() => onOpenAudit?.(job.linkedAuditId!)}>
                            Диалог
                          </button>
                        ) : (
                          <span className="sa-meta">{linkReasonLabel(job.linkReason)}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
