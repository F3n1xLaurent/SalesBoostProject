import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../entities/session';
import { fetchCallBatchById, type CallBatchListItem } from '../../../shared/api/adminPanel';

type Props = {
  onOpenBatchDetail: (batchId: string) => void;
  items: CallBatchListItem[];
};

function batchModeLabel(item: CallBatchListItem): string {
  if (item.mode === 'auto_daily') return 'Авто-ежедневный';
  if (item.mode === 'single_dealership') return 'Одна точка';
  if (item.mode === 'all_dealerships') return 'Сеть';
  return 'Ручной';
}

function batchStatusLabel(item: CallBatchListItem): string {
  if (item.status === 'running') return 'В работе';
  if (item.status === 'paused') return 'Пауза';
  if (item.status === 'completed') return item.failedJobs > 0 ? 'Завершено с ошибками' : 'Завершено';
  return 'Остановлено';
}

function segmentWidth(count: number, total: number): string {
  if (total <= 0 || count <= 0) return '0%';
  return `${Math.max(3, (count / total) * 100)}%`;
}

export function CallBatchTray({ onOpenBatchDetail, items }: Props) {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batch, setBatch] = useState<CallBatchListItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [hiddenBatchId, setHiddenBatchId] = useState<string | null>(null);

  // Если нет выбранного batchId, пробуем найти активный ручной batch по списку
  const manualActive = useMemo(
    () =>
      items.find(
        (b) =>
          (b.mode === 'manual' || b.mode === 'single_dealership' || b.mode === 'all_dealerships') &&
          (b.status === 'running' || b.status === 'paused') &&
          b.id !== hiddenBatchId,
      ) || null,
    [items, hiddenBatchId],
  );

  useEffect(() => {
    if (!batchId && manualActive) {
      setBatchId(manualActive.id);
    }
  }, [manualActive, batchId]);

  // Подхватываем batchId из localStorage (для совместимости со старыми сессиями)
  useEffect(() => {
    let stopped = false;
    const read = () => {
      try {
        const stored = localStorage.getItem('sa_active_call_batch_id_v1');
        const id = stored && stored.trim() ? stored.trim() : null;
        if (!stopped) {
          setBatchId((prev) => (prev === id ? prev : id));
        }
      } catch {
        // ignore
      }
    };
    read();
    const timer = window.setInterval(read, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  // Подгружаем метаданные batch и периодически опрашиваем
  useEffect(() => {
    if (!batchId) {
      setBatch(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const meta = await fetchCallBatchById(batchId);
        if (!cancelled) {
          setBatch(meta);
        }
      } catch {
        if (!cancelled) setError('Не удалось обновить статус проверки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [batchId]);

  const hasActive = !!batchId && !!batch;

  const title = useMemo(() => {
    if (!batch) return 'Проверка точек';
    if (batch.title?.trim()) return batch.title;
    if (batch.mode === 'all_dealerships') return 'Проверка сети';
    if (batch.mode === 'single_dealership') return 'Проверка точки';
    if (batch.mode === 'auto_daily') return 'Авто-проверка сети';
    return 'Ручная проверка';
  }, [batch]);

  async function setBatchMode(action: 'pause' | 'resume' | 'cancel') {
    if (!batchId) return;
    try {
      const res = await apiFetch(`/api/admin/call-batches/${batchId}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || `Не удалось выполнить ${action}`);
        return;
      }
      const meta = await fetchCallBatchById(batchId);
      setBatch(meta);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ошибка обновления статуса');
    }
  }

  const handleDismiss = () => {
    const id = batch?.id || batchId;
    if (id) {
      setHiddenBatchId(id);
      try {
        localStorage.removeItem('sa_active_call_batch_id_v1');
      } catch {
        // ignore
      }
    }
    setBatchId(null);
    setBatch(null);
    setError(null);
  };

  if (!hasActive) return null;

  const total = batch?.totalJobs ?? 0;

  return (
    <div className="sa-batch-tray-root">
      {expanded ? (
        <div className="sa-batch-tray-card">
          <div className="sa-batch-tray-head">
            <div>
              <div className="sa-batch-tray-title">{title}</div>
              {batch && (
                <div className="sa-batch-tray-sub">
                  {new Date(batch.createdAt).toLocaleString('ru-RU')} · {batchModeLabel(batch)}
                </div>
              )}
            </div>
            <div className="sa-batch-tray-head-right">
              {batch && (
                <span className={`sa-batch-state sa-batch-state-${
                  batch.status === 'running'
                    ? 'in_progress'
                    : batch.status === 'completed'
                    ? (batch.failedJobs > 0 ? 'partial' : 'completed')
                    : batch.status === 'paused'
                    ? 'queued'
                    : 'cancelled'
                }`}>
                  {batchStatusLabel(batch)}
                </span>
              )}
              <button className="sa-batch-tray-toggle-btn" onClick={() => setExpanded(false)}>
                ⌄
              </button>
              <button className="sa-btn-text sa-btn-sm" onClick={handleDismiss}>
                Закрыть
              </button>
            </div>
          </div>

          {error && <div className="sa-batch-live-error" style={{ marginTop: 4 }}>{error}</div>}

          {batch && (
            <>
              <div className="sa-batch-kpi-row" style={{ marginTop: 6 }}>
                <span>Всего: <strong>{batch.totalJobs}</strong></span>
                <span>В очереди: <strong>{batch.queuedJobs}</strong></span>
                <span>В работе: <strong>{batch.inProgressJobs}</strong></span>
                <span>Повторы: <strong>{batch.retryingJobs}</strong></span>
                <span>Готово: <strong>{batch.completedJobs}</strong></span>
                <span>Ошибки: <strong>{batch.failedJobs}</strong></span>
              </div>
              <div className="sa-batch-table-progress-track sa-batch-table-progress-track-segmented" style={{ marginTop: 4 }}>
                <span
                  className="sa-batch-segment sa-batch-segment-completed"
                  style={{ width: segmentWidth(batch.completedJobs, total) }}
                />
                <span
                  className="sa-batch-segment sa-batch-segment-active"
                  style={{ width: segmentWidth(batch.inProgressJobs, total) }}
                />
                <span
                  className="sa-batch-segment sa-batch-segment-retry"
                  style={{ width: segmentWidth(batch.retryingJobs, total) }}
                />
                <span
                  className="sa-batch-segment sa-batch-segment-failed"
                  style={{ width: segmentWidth(batch.failedJobs, total) }}
                />
                <span
                  className="sa-batch-segment sa-batch-segment-queued"
                  style={{ width: segmentWidth(batch.queuedJobs, total) }}
                />
              </div>
              <div className="sa-batch-live-actions" style={{ marginTop: 8 }}>
                <button
                  className="sa-btn-outline sa-btn-sm"
                  title="Остановит запуск новых звонков, активные разговоры не прервутся"
                  onClick={() => setBatchMode('pause')}
                  disabled={batch.status !== 'running'}
                >
                  Пауза новых
                </button>
                <button
                  className="sa-btn-outline sa-btn-sm"
                  title="Возобновит запуск новых звонков из очереди"
                  onClick={() => setBatchMode('resume')}
                  disabled={batch.status !== 'paused'}
                >
                  Продолжить запуск
                </button>
                <button
                  className="sa-btn-outline sa-btn-sm"
                  title="Отменит только очередь и повторы, активные звонки не прервутся"
                  onClick={() => setBatchMode('cancel')}
                  disabled={batch.status === 'completed' || batch.status === 'cancelled'}
                >
                  Завершить очередь
                </button>
                <button
                  className="sa-btn-text sa-btn-sm"
                  onClick={() => batch && onOpenBatchDetail(batch.id)}
                >
                  Открыть тест →
                </button>
              </div>
            </>
          )}
          {loading && !batch && (
            <div className="sa-meta" style={{ marginTop: 8 }}>Загрузка статуса проверки…</div>
          )}
        </div>
      ) : (
        <button
          className="sa-batch-tray-pill"
          onClick={() => setExpanded(true)}
          title={title}
        >
          <span className="sa-batch-tray-dot" />
          Проверки
          {batch && <span className="sa-batch-tray-pill-count">{batchStatusLabel(batch)}</span>}
        </button>
      )}
    </div>
  );
}
