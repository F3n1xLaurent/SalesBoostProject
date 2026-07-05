import React, { useEffect, useMemo, useState } from 'react';
import type { AuditItem } from '../../../shared/api/adminPanel';
import { ratingClass } from '../../../shared/lib/admin-panel/utils';
import { SingleSelectFilterPicker } from '../../../shared/ui/filter-picker/SingleSelectFilterPicker';

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
  reportIssues: string[];
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

/* ────────────────────── Extended filters ────────────────────── */

type ScoreBand = 'high' | 'normal' | 'low';

const SCORE_BAND_OPTIONS: { id: ScoreBand; label: string }[] = [
  { id: 'high', label: 'Высокий (от 80)' },
  { id: 'normal', label: 'Нормальный (50–79)' },
  { id: 'low', label: 'Низкий (до 50)' },
];

function scoreBand(score: number): ScoreBand {
  if (score >= 80) return 'high';
  if (score >= 50) return 'normal';
  return 'low';
}

const AUDIT_TYPE_FILTER_OPTIONS = [
  { value: 'all' as const, label: 'Все типы' },
  { value: 'trainer' as const, label: 'Тренажёр' },
  { value: 'call' as const, label: 'Звонок' },
];

const AUDIT_STATUS_FILTER_OPTIONS = [
  { value: 'all' as const, label: 'Все статусы' },
  { value: 'completed' as const, label: 'Завершено' },
  { value: 'failed' as const, label: 'Провал' },
  { value: 'interrupted' as const, label: 'Прервано' },
];

const COMM_ISSUE_LABELS: Record<Exclude<CommunicationFlag, 'ok'>, string> = {
  fillers: 'Паразиты',
  aggression: 'Агрессия',
  profanity: 'Недопустимая лексика',
  'low-engagement': 'Низкая вовлечённость',
};

function reportIssuesFromItem(item: AuditItem): string[] {
  if (item.reportIssues?.length) return item.reportIssues;
  const flag = item.communicationFlag;
  if (!flag || flag === 'ok') return [];
  return [COMM_ISSUE_LABELS[flag]];
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
    reportIssues: reportIssuesFromItem(item),
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
  const allReportIssues = useMemo(
    () => [...new Set(rows.flatMap((row) => row.reportIssues))].sort((a, b) => a.localeCompare(b, 'ru')),
    [rows],
  );

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('dateTime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showFilters, setShowFilters] = useState(false);
  const [filterType, setFilterType] = useState<AuditType | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<AuditStatus | 'all'>('all');
  const [filterCity, setFilterCity] = useState<Set<string>>(new Set());
  const [filterDealership, setFilterDealership] = useState<Set<string>>(new Set());
  const [filterScoreBands, setFilterScoreBands] = useState<Set<ScoreBand>>(new Set());
  const [filterProblems, setFilterProblems] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [rows, search, filterType, filterStatus, filterCity, filterDealership, filterScoreBands, filterProblems, sortKey, sortDir]);

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
  const toggleScoreBand = (band: ScoreBand) => setFilterScoreBands((prev) => {
    const next = new Set(prev);
    next.has(band) ? next.delete(band) : next.add(band);
    return next;
  });
  const toggleProblem = (issue: string) => setFilterProblems((prev) => {
    const next = new Set(prev);
    next.has(issue) ? next.delete(issue) : next.add(issue);
    return next;
  });

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
    if (filterScoreBands.size > 0) list = list.filter((r) => filterScoreBands.has(scoreBand(r.totalScore)));
    if (filterProblems.size > 0) list = list.filter((r) => r.reportIssues.some((issue) => filterProblems.has(issue)));

    list.sort(comparator(sortKey, sortDir));
    return list;
  }, [rows, search, filterType, filterStatus, filterCity, filterDealership, filterScoreBands, filterProblems, sortKey, sortDir]);

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

      <div className="sa-toolbar">
        <div className="sa-toolbar-split sa-holdings-toolbar">
          <div className="sa-toolbar-filters">
            <div className="sa-search-wrap">
              <svg className="sa-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                className="sa-search-input"
                placeholder="Поиск по сотруднику / точке…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="sa-tag-filter-picker-wrap">
              <SingleSelectFilterPicker
                options={AUDIT_TYPE_FILTER_OPTIONS}
                value={filterType}
                onChange={setFilterType}
              />
            </div>

            <div className="sa-tag-filter-picker-wrap">
              <SingleSelectFilterPicker
                options={AUDIT_STATUS_FILTER_OPTIONS}
                value={filterStatus}
                onChange={setFilterStatus}
              />
            </div>

            <button
              type="button"
              className={`sa-btn-outline ${showFilters ? 'sa-chip-active' : ''}`}
              onClick={() => setShowFilters(!showFilters)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              Фильтры
            </button>
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="sa-filters-panel">
          <div className="sa-filter-group">
            <span className="sa-filter-label">Балл</span>
            <div className="sa-filter-options">
              {SCORE_BAND_OPTIONS.map((option) => (
                <label key={option.id} className="sa-filter-check">
                  <input type="checkbox" checked={filterScoreBands.has(option.id)} onChange={() => toggleScoreBand(option.id)} />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
          <div className="sa-filter-group">
            <span className="sa-filter-label">Проблемы</span>
            <div className="sa-filter-options">
              {allReportIssues.length === 0 ? (
                <span className="sa-meta">Нет зафиксированных проблем в текущей выборке</span>
              ) : (
                allReportIssues.map((issue) => (
                  <label key={issue} className="sa-filter-check">
                    <input type="checkbox" checked={filterProblems.has(issue)} onChange={() => toggleProblem(issue)} />
                    {issue}
                  </label>
                ))
              )}
            </div>
          </div>
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
                    <span className={ratingClass(r.totalScore)}>{r.totalScore}</span>
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
