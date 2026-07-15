import React, { useEffect, useMemo, useState } from 'react';
import { ratingClass } from '../../lib/admin-panel/utils';

export type AuditHistoryKind = 'call' | 'trainer';

export type AuditHistoryItem = {
  id: string;
  date: string;
  type: AuditHistoryKind | 'training' | string;
  score: number;
  verdict?: string;
  outcome?: string | null;
  employeeName?: string;
  dealershipName?: string;
};

export type AuditHistoryVariant = 'employee' | 'dealership' | 'holding';

type AuditHistoryFilter = 'all' | 'call' | 'trainer';

const FILTERS: { value: AuditHistoryFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'call', label: 'Звонки' },
  { value: 'trainer', label: 'Тренажёр' },
];

const PAGE_SIZE = 15;

function normalizeKind(type: string | undefined): AuditHistoryKind {
  return type === 'trainer' || type === 'training' ? 'trainer' : 'call';
}

function isOpenableAuditId(id: string, kind: AuditHistoryKind): boolean {
  if (kind === 'trainer') return /^trainer-.+/.test(id);
  return /^call-\d+$/.test(id);
}

function typeLabel(kind: AuditHistoryKind): string {
  return kind === 'trainer' ? 'Тренажёр' : 'Звонок';
}

function defaultVerdict(item: AuditHistoryItem, kind: AuditHistoryKind): string {
  if (item.verdict) return item.verdict;
  if (kind === 'call' && item.outcome === 'no_answer') return 'Недозвон';
  if (item.score < 50) return kind === 'trainer' ? 'Провал' : 'Нуждается в доработке';
  return kind === 'trainer' ? 'Пройдено' : 'Оценено';
}

export function AuditHistoryBlock({
  items,
  onOpenAudit,
  variant = 'employee',
  pageSize = PAGE_SIZE,
  emptyText = 'Нет проверок за период',
}: {
  items: AuditHistoryItem[];
  onOpenAudit: (id: string) => void;
  variant?: AuditHistoryVariant;
  pageSize?: number;
  emptyText?: string;
}) {
  const [filter, setFilter] = useState<AuditHistoryFilter>('all');
  const [page, setPage] = useState(1);

  const normalized = useMemo(
    () => items
      .map((item) => ({ ...item, kind: normalizeKind(item.type) }))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date)),
    [items],
  );

  const filtered = useMemo(() => {
    if (filter === 'all') return normalized;
    return normalized.filter((item) => item.kind === filter);
  }, [filter, normalized]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const startIndex = (page - 1) * pageSize;
  const visible = filtered.slice(startIndex, startIndex + pageSize);

  useEffect(() => {
    setPage(1);
  }, [filter, items]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  if (normalized.length === 0) {
    return <div className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>{emptyText}</div>;
  }

  const showEmployee = variant === 'dealership' || variant === 'holding';
  const showDealership = variant === 'holding';
  const showVerdict = variant === 'employee';
  const colSpan = 3 + (showDealership ? 1 : 0) + (showEmployee ? 1 : 0) + (showVerdict ? 1 : 0);

  return (
    <div className="sa-audit-history">
      <div className="sa-audit-history-filters">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`sa-btn-field sa-btn-sm ${filter === option.value ? 'is-active' : ''}`}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="sa-table-wrap sa-audit-history-table-wrap">
        <table className="sa-table sa-audit-history-table">
          <thead>
            <tr>
              <th className="sa-audit-col-date">Дата</th>
              {showDealership ? <th className="sa-audit-col-dealership">Точка</th> : null}
              <th className="sa-audit-col-type">Тип</th>
              {showEmployee ? <th className="sa-audit-col-employee">Сотрудник</th> : null}
              <th className="sa-text-right sa-audit-col-score">Балл</th>
              {showVerdict ? <th className="sa-audit-col-verdict">Вердикт</th> : null}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="sa-meta" style={{ padding: 18, textAlign: 'center' }}>
                  Нет проверок по выбранному фильтру
                </td>
              </tr>
            ) : visible.map((item) => {
              const canOpen = isOpenableAuditId(item.id, item.kind);
              return (
                <tr
                  key={item.id}
                  className={canOpen ? 'sa-row-clickable' : undefined}
                  onClick={() => canOpen && onOpenAudit(item.id)}
                  role={canOpen ? 'button' : undefined}
                  tabIndex={canOpen ? 0 : undefined}
                  onKeyDown={(event) => {
                    if (canOpen && event.key === 'Enter') onOpenAudit(item.id);
                  }}
                  title={canOpen
                    ? (item.kind === 'trainer' ? 'Открыть отчёт тренировки' : 'Открыть разбор звонка')
                    : 'Разбор недоступен'}
                >
                  <td>{new Date(item.date).toLocaleDateString('ru-RU')}</td>
                  {showDealership ? <td>{item.dealershipName || '—'}</td> : null}
                  <td>{typeLabel(item.kind)}</td>
                  {showEmployee ? <td>{item.employeeName || '—'}</td> : null}
                  <td className="sa-text-right">
                    <span className={ratingClass(item.score)}>{item.score}</span>
                  </td>
                  {showVerdict ? <td>{defaultVerdict(item, item.kind)}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={`sa-audit-history-pagination${filtered.length > pageSize ? '' : ' is-empty'}`}>
        {filtered.length > pageSize ? (
          <>
            <span className="sa-meta">
              Показаны {startIndex + 1}-{Math.min(startIndex + pageSize, filtered.length)} из {filtered.length}
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="sa-btn-field sa-btn-sm"
                disabled={page === 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Назад
              </button>
              <span className="sa-metric-chip">Стр. {page} из {totalPages}</span>
              <button
                type="button"
                className="sa-btn-field sa-btn-sm"
                disabled={page === totalPages}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                Вперёд
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function mapTrainerHistoryToAuditItems(
  history: Array<{ id: string; date: string; score: number | null; status: string }>,
): AuditHistoryItem[] {
  return history.map((item) => ({
    id: `trainer-${item.id}`,
    date: item.date,
    type: 'trainer' as const,
    score: Math.round(item.score ?? 0),
    verdict: item.status === 'completed'
      ? 'Пройдено'
      : item.status === 'failed'
        ? 'Провал'
        : item.status === 'abandoned'
          ? 'Прервано'
          : 'В процессе',
  }));
}
