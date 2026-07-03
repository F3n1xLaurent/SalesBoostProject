import React, { useEffect, useMemo, useState } from 'react';
import type { AuditItem } from '../../../shared/api/adminPanel';
import { ratingClass } from '../../../shared/lib/admin-panel/utils';

type AuditType = 'trainer' | 'call';
type AuditStatus = 'completed' | 'failed' | 'interrupted';
type CommunicationFlag = 'ok' | 'fillers' | 'aggression' | 'profanity' | 'low-engagement';

type AuditListRow = {
  id: string;
  type: AuditType;
  dateTime: string;
  employeeId: string;
  employeeName: string;
  dealershipId: string;
  dealershipName: string;
  city: string;
  totalScore: number;
  verdict: string;
  status: AuditStatus;
  duration: number;
  communicationFlag: CommunicationFlag;
};

const AUDIT_TYPE_LABELS: Record<AuditType, string> = {
  trainer: 'Тренажёр',
  call: 'Звонок',
};

const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  completed: 'Завершено',
  failed: 'Провал',
  interrupted: 'Прервано',
};

const AUDIT_STATUS_CLASS: Record<AuditStatus, string> = {
  completed: 'sa-audit-status-completed',
  failed: 'sa-audit-status-failed',
  interrupted: 'sa-audit-status-interrupted',
};

/* ────────────────────── Props ────────────────────── */

type Props = {
  audits: AuditItem[];
  loading?: boolean;
  onOpenDetail?: (auditId: string) => void;
};

/* ────────────────────── Sort config ────────────────────── */

type SortKey = 'dateTime' | 'totalScore' | 'status' | 'type' | 'employeeName' | 'dealershipName';
type SortDir = 'asc' | 'desc';

const STATUS_SORT_ORDER: Record<AuditStatus, number> = {
  failed: 0,
  interrupted: 1,
  completed: 2,
};

function comparator(key: SortKey, dir: SortDir) {
  return (a: AuditListRow, b: AuditListRow): number => {
    let cmp = 0;
    if (key === 'dateTime') {
      cmp = a.dateTime.localeCompare(b.dateTime);
    } else if (key === 'totalScore') {
      cmp = a.totalScore - b.totalScore;
    } else if (key === 'status') {
      cmp = STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status];
    } else if (key === 'type') {
      cmp = a.type.localeCompare(b.type);
    } else if (key === 'employeeName' || key === 'dealershipName') {
      cmp = a[key].localeCompare(b[key], 'ru');
    }
    return dir === 'asc' ? cmp : -cmp;
  };
}

/* ────────────────────── Quick-filter chips ────────────────────── */

type QuickFilter = 'fails' | 'low-score' | 'comm';

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: 'fails', label: 'Только провалы' },
  { id: 'low-score', label: 'Низкий балл (<50)' },
  { id: 'comm', label: 'Проблемы коммуникации' },
];

function matchesQuick(a: AuditListRow, f: QuickFilter): boolean {
  switch (f) {
    case 'fails': return a.status === 'failed' || a.status === 'interrupted';
    case 'low-score': return a.totalScore < 50;
    case 'comm': return a.communicationFlag !== 'ok';
  }
}

/* ────────────────────── Column defs ────────────────────── */

const COLUMNS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'dateTime', label: 'Дата' },
  { key: 'type', label: 'Тип' },
  { key: 'employeeName', label: 'Сотрудник' },
  { key: 'dealershipName', label: 'Точка' },
  { key: 'totalScore', label: 'Балл', align: 'right' },
  { key: 'status', label: 'Статус' },
];

const AUDITS_PAGE_SIZE = 10;

function auditItemToRow(item: AuditItem): AuditListRow {
  const score = Number.isFinite(item.aiScore) ? item.aiScore : 0;
  const type: AuditType = item.type === 'trainer' || item.type === 'training' ? 'trainer' : 'call';
  const status: AuditStatus = item.auditStatus
    ?? (item.status === 'Bad' ? 'failed' : 'completed');
  return {
    id: item.id,
    type,
    dateTime: item.date,
    employeeId: item.employeeId ?? '',
    employeeName: item.userName || 'Не назначен',
    dealershipId: item.dealershipId ?? '',
    dealershipName: item.dealershipName || item.dealer || 'Без точки',
    city: item.city || '—',
    totalScore: Math.round(score * 10) / 10,
    verdict: item.verdict || (status === 'failed' ? 'Нуждается в разборе' : status === 'interrupted' ? 'Звонок не завершён' : 'Оценено'),
    status,
    duration: item.durationSec ?? 0,
    communicationFlag: item.communicationFlag ?? 'ok',
  };
}

/* ════════════════════ Component ════════════════════ */

export function Audits({
  audits,
  loading = false,
  onOpenDetail,
}: Props) {
  const rows = useMemo(() => audits.map(auditItemToRow), [audits]);
  const allCities = useMemo(() => [...new Set(rows.map((row) => row.city).filter((city) => city && city !== '—'))].sort((a, b) => a.localeCompare(b, 'ru')), [rows]);
  const allDealerships = useMemo(() => [...new Set(rows.map((row) => row.dealershipName).filter((name) => name && name !== 'Без точки'))].sort((a, b) => a.localeCompare(b, 'ru')), [rows]);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('dateTime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [quickFilter, setQuickFilter] = useState<QuickFilter | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filterType, setFilterType] = useState<AuditType | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<AuditStatus | 'all'>('all');
  const [filterCity, setFilterCity] = useState<Set<string>>(new Set());
  const [filterDealership, setFilterDealership] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [rows, search, filterType, filterStatus, filterCity, filterDealership, quickFilter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'dateTime' ? 'desc' : 'desc'); }
  };

  const sortIcon = (key: SortKey) =>
    sortKey === key
      ? <span className="sa-sort-icon">{sortDir === 'asc' ? '▲' : '▼'}</span>
      : <span className="sa-sort-icon sa-sort-icon-inactive">▲</span>;

  const toggleCity = (c: string) => setFilterCity((p) => { const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n; });
  const toggleDealership = (d: string) => setFilterDealership((p) => { const n = new Set(p); n.has(d) ? n.delete(d) : n.add(d); return n; });

  const filtered = useMemo(() => {
    let list = [...rows];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) =>
        r.employeeName.toLowerCase().includes(q) ||
        r.dealershipName.toLowerCase().includes(q) ||
        r.city.toLowerCase().includes(q)
      );
    }

    if (filterType !== 'all') list = list.filter((r) => r.type === filterType);
    if (filterStatus !== 'all') list = list.filter((r) => r.status === filterStatus);
    if (filterCity.size > 0) list = list.filter((r) => filterCity.has(r.city));
    if (filterDealership.size > 0) list = list.filter((r) => filterDealership.has(r.dealershipName));
    if (quickFilter) list = list.filter((r) => matchesQuick(r, quickFilter));

    list.sort(comparator(sortKey, sortDir));
    return list;
  }, [rows, search, filterType, filterStatus, filterCity, filterDealership, quickFilter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / AUDITS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStartIndex = (currentPage - 1) * AUDITS_PAGE_SIZE;
  const visibleRows = filtered.slice(pageStartIndex, pageStartIndex + AUDITS_PAGE_SIZE);
  const pageStart = filtered.length === 0 ? 0 : pageStartIndex + 1;
  const pageEnd = Math.min(filtered.length, pageStartIndex + visibleRows.length);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  function formatDateTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDuration(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return (
    <>
      <h1 className="sa-page-title">Проверки</h1>
      <p className="sa-page-subtitle">
        Реальные проверки по звонкам: плановые звонки и будущие звонки тренажёра
      </p>

      <div className="sa-toolbar">
        <div className="sa-toolbar-row">
          <div className="sa-search-wrap">
            <span className="sa-search-icon">🔍</span>
            <input
              className="sa-search-input"
              placeholder="Поиск по сотруднику / точке…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select className="sa-select" value={filterType} onChange={(e) => setFilterType(e.target.value as AuditType | 'all')}>
            <option value="all">Все типы</option>
            <option value="trainer">Тренажёр</option>
            <option value="call">Звонок</option>
          </select>

          <select className="sa-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as AuditStatus | 'all')}>
            <option value="all">Все статусы</option>
            <option value="completed">Завершено</option>
            <option value="failed">Провал</option>
            <option value="interrupted">Прервано</option>
          </select>

          <button
            className={`sa-btn-outline ${showFilters ? 'sa-chip-active' : ''}`}
            onClick={() => setShowFilters(!showFilters)}
          >
            Фильтры {showFilters ? '▲' : '▼'}
          </button>
        </div>

        {/* ── Quick chips ── */}
        <div className="sa-toolbar-chips">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.id}
              className={`sa-chip ${quickFilter === f.id ? 'sa-chip-active' : ''}`}
              onClick={() => setQuickFilter(quickFilter === f.id ? null : f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {showFilters && (
        <div className="sa-filters-panel">
          <div className="sa-filter-group">
            <span className="sa-filter-label">Город</span>
            <div className="sa-filter-options">
              {allCities.map((c) => (
                <label key={c} className="sa-filter-check">
                  <input type="checkbox" checked={filterCity.has(c)} onChange={() => toggleCity(c)} />
                  {c}
                </label>
              ))}
            </div>
          </div>
          <div className="sa-filter-group">
            <span className="sa-filter-label">Точка</span>
            <div className="sa-filter-options">
              {allDealerships.map((d) => (
                <label key={d} className="sa-filter-check">
                  <input type="checkbox" checked={filterDealership.has(d)} onChange={() => toggleDealership(d)} />
                  {d}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="sa-companies-table-wrap sa-desktop-only">
        <table className="sa-table sa-table-sortable">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={`sa-th-sortable ${col.align === 'right' ? 'sa-text-right' : ''}`}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label} {sortIcon(col.key)}
                </th>
              ))}
              <th>Вердикт</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="sa-meta" style={{ padding: 24 }}>Загрузка…</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="sa-empty-state">
                  Нет проверок по выбранным фильтрам<br />
                  <span className="sa-meta">Сбросьте фильтры или измените период</span>
                </td>
              </tr>
            ) : (
              visibleRows.map((r) => (
                <tr
                  key={r.id}
                  className="sa-row-clickable"
                  onClick={() => onOpenDetail?.(r.id)}
                >
                  <td>
                    <div style={{ fontSize: 13 }}>{formatDateTime(r.dateTime)}</div>
                    <div className="sa-meta" style={{ marginTop: 1 }}>{formatDuration(r.duration)}</div>
                  </td>
                  <td>
                    <span className={`sa-audit-type-badge sa-audit-type-${r.type}`}>
                      {AUDIT_TYPE_LABELS[r.type]}
                    </span>
                  </td>
                  <td>
                    <div className="sa-cell-name">{r.employeeName}</div>
                  </td>
                  <td>
                    <div className="sa-cell-name">{r.dealershipName}</div>
                    <div className="sa-cell-city">{r.city}</div>
                  </td>
                  <td className="sa-text-right">
                    <span className={ratingClass(r.totalScore)} style={{ fontSize: 15 }}>{r.totalScore}</span>
                  </td>
                  <td>
                    <span className={`sa-status-badge ${AUDIT_STATUS_CLASS[r.status]}`}>
                      {AUDIT_STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td>
                    <span className="sa-audit-verdict">{r.verdict.length > 40 ? r.verdict.slice(0, 38) + '…' : r.verdict}</span>
                  </td>
                  <td className="sa-row-chevron-cell">→</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="sa-mobile-only">
        {visibleRows.map((r) => (
          <div key={r.id} className="sa-mobile-row" onClick={() => onOpenDetail?.(r.id)}>
            <div className="sa-mobile-row-header">
              <div>
                <div className="sa-cell-name">{r.employeeName}</div>
                <div className="sa-cell-city">{r.dealershipName} · {r.city}</div>
              </div>
              <span className={`sa-mobile-rating ${ratingClass(r.totalScore)}`}>{r.totalScore}</span>
            </div>
            <div className="sa-mobile-chips">
              <span className="sa-metric-chip">{formatDateTime(r.dateTime)}</span>
              <span className={`sa-metric-chip sa-audit-type-badge sa-audit-type-${r.type}`}>{AUDIT_TYPE_LABELS[r.type]}</span>
              <span className={`sa-metric-chip sa-status-badge ${AUDIT_STATUS_CLASS[r.status]}`}>{AUDIT_STATUS_LABELS[r.status]}</span>
            </div>
          </div>
        ))}
      </div>

      {!loading && filtered.length > AUDITS_PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
          <div className="sa-meta">
            Показаны {pageStart}-{pageEnd} из {filtered.length}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="sa-btn-outline sa-btn-sm" disabled={currentPage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              Назад
            </button>
            <span className="sa-metric-chip">Стр. {currentPage} из {totalPages}</span>
            <button type="button" className="sa-btn-outline sa-btn-sm" disabled={currentPage === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
              Вперёд
            </button>
          </div>
        </div>
      )}
    </>
  );
}
