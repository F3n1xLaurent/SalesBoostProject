import React, { useState, useMemo } from 'react';
import type { MockDealer } from '../../../shared/api/adminPanel';
import {
  MOCK_EMPLOYEES,
  STATUS_LABELS,
  STATUS_ORDER,
  COMM_LABELS,
  COMM_BADGE_CLASS,
  getAllCities,
  getAllDealershipNamesForEmployees,
  type EmployeeFullRow,
  type DealershipStatus,
  type CommunicationFlag,
} from '../../../shared/lib/admin-panel/mockData';
import { ratingClass, deltaDisplay, statusBadgeClass } from '../../../shared/lib/admin-panel/utils';

/* ────────────────────── Props ────────────────────── */

type Props = {
  dealers: MockDealer[];
  loading?: boolean;
  onSelectEmployee?: (id: string) => void;
};

/* ────────────────────── Sort config ────────────────────── */

type SortKey = 'fullName' | 'dealershipName' | 'aiRating' | 'deltaRating' | 'auditsCount' | 'failsCount' | 'status';
type SortDir = 'asc' | 'desc';

const COLUMN_DEFS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'fullName', label: 'Сотрудник' },
  { key: 'dealershipName', label: 'Точка' },
  { key: 'aiRating', label: 'AI-рейтинг', align: 'right' },
  { key: 'deltaRating', label: 'Динамика', align: 'right' },
  { key: 'auditsCount', label: 'Проверки', align: 'right' },
  { key: 'failsCount', label: 'Провалы', align: 'right' },
];

function comparator(key: SortKey, dir: SortDir) {
  return (a: EmployeeFullRow, b: EmployeeFullRow): number => {
    let cmp = 0;
    if (key === 'fullName' || key === 'dealershipName') {
      cmp = a[key].localeCompare(b[key], 'ru');
    } else if (key === 'status') {
      cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    } else {
      const av = a[key] ?? -Infinity;
      const bv = b[key] ?? -Infinity;
      cmp = (av as number) - (bv as number);
    }
    return dir === 'asc' ? cmp : -cmp;
  };
}

/* ────────────────────── Quick-filter chips ────────────────────── */

type QuickFilter = 'training' | 'fails' | 'best' | 'comm';

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: 'training', label: 'Нужно обучение' },
  { id: 'fails', label: 'Провалы' },
  { id: 'best', label: 'Лучшие' },
  { id: 'comm', label: 'Проблемы коммуникации' },
];

function matchesQuickFilter(e: EmployeeFullRow, f: QuickFilter): boolean {
  switch (f) {
    case 'training': return e.status === 'critical' || e.status === 'risk';
    case 'fails': return e.failsCount >= 1;
    case 'best': return e.aiRating >= 80 && e.status === 'norm';
    case 'comm': return e.communicationFlag !== 'ok';
  }
}

/* ────────────────────── Component ────────────────────── */

export function Autodealers({ loading = false, onSelectEmployee }: Props) {
  const rows = MOCK_EMPLOYEES;
  const allCities = useMemo(() => getAllCities(), []);
  const allDealerships = useMemo(() => getAllDealershipNamesForEmployees(), []);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('aiRating');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [quickFilter, setQuickFilter] = useState<QuickFilter | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [cityFilter, setCityFilter] = useState<string[]>([]);
  const [dealershipFilter, setDealershipFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<DealershipStatus[]>([]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'fullName' || key === 'dealershipName' ? 'asc' : 'desc'); }
  };

  const toggleQuick = (f: QuickFilter) => setQuickFilter((prev) => (prev === f ? null : f));

  const filtered = useMemo(() => {
    let list: EmployeeFullRow[] = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((e) =>
        e.fullName.toLowerCase().includes(q) ||
        e.dealershipName.toLowerCase().includes(q) ||
        e.city.toLowerCase().includes(q)
      );
    }
    if (quickFilter) list = list.filter((e) => matchesQuickFilter(e, quickFilter));
    if (cityFilter.length > 0) list = list.filter((e) => cityFilter.includes(e.city));
    if (dealershipFilter.length > 0) list = list.filter((e) => dealershipFilter.includes(e.dealershipName));
    if (statusFilter.length > 0) list = list.filter((e) => statusFilter.includes(e.status));
    return [...list].sort(comparator(sortKey, sortDir));
  }, [rows, search, quickFilter, cityFilter, dealershipFilter, statusFilter, sortKey, sortDir]);

  const toggleCity = (c: string) => setCityFilter((p) => p.includes(c) ? p.filter((x) => x !== c) : [...p, c]);
  const toggleDealer = (d: string) => setDealershipFilter((p) => p.includes(d) ? p.filter((x) => x !== d) : [...p, d]);
  const toggleStatus = (s: DealershipStatus) => setStatusFilter((p) => p.includes(s) ? p.filter((x) => x !== s) : [...p, s]);

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <span className="sa-sort-icon sa-sort-icon-inactive">⇅</span>;
    return <span className="sa-sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  return (
    <>
      <h1 className="sa-page-title">Сотрудники</h1>
      <p className="sa-page-subtitle">Контроль качества менеджеров и выявление зон для обучения</p>

      {/* ─── Toolbar ─── */}
      <div className="sa-toolbar">
        <div className="sa-toolbar-row">
          <div className="sa-search-wrap">
            <svg className="sa-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input className="sa-search-input" placeholder="Поиск по имени / точке / городу…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="sa-select" defaultValue="30d">
            <option value="7d">7 дней</option>
            <option value="30d">30 дней</option>
            {/* <option value="custom">Произвольно</option> */}
          </select>
          <button className="sa-btn-outline" onClick={() => setShowFilters((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            Фильтры
          </button>
        </div>
        <div className="sa-toolbar-chips">
          {QUICK_FILTERS.map((f) => (
            <button key={f.id} className={`sa-chip ${quickFilter === f.id ? 'sa-chip-active' : ''}`} onClick={() => toggleQuick(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Filters panel ─── */}
      {showFilters && (
        <div className="sa-filters-panel">
          <div className="sa-filter-group">
            <span className="sa-filter-label">Город:</span>
            <div className="sa-filter-options">
              {allCities.map((c) => (
                <label key={c} className="sa-filter-check"><input type="checkbox" checked={cityFilter.includes(c)} onChange={() => toggleCity(c)} />{c}</label>
              ))}
            </div>
          </div>
          <div className="sa-filter-group">
            <span className="sa-filter-label">Точка:</span>
            <div className="sa-filter-options">
              {allDealerships.map((d) => (
                <label key={d} className="sa-filter-check"><input type="checkbox" checked={dealershipFilter.includes(d)} onChange={() => toggleDealer(d)} />{d}</label>
              ))}
            </div>
          </div>
          <div className="sa-filter-group">
            <span className="sa-filter-label">Статус:</span>
            <div className="sa-filter-options">
              {(['critical', 'risk', 'norm', 'no-data'] as DealershipStatus[]).map((s) => (
                <label key={s} className="sa-filter-check"><input type="checkbox" checked={statusFilter.includes(s)} onChange={() => toggleStatus(s)} />{STATUS_LABELS[s]}</label>
              ))}
            </div>
          </div>
          <button className="sa-btn-text" onClick={() => { setCityFilter([]); setDealershipFilter([]); setStatusFilter([]); }}>Сбросить фильтры</button>
        </div>
      )}

      {/* ─── Desktop table ─── */}
      <div className="sa-companies-table-wrap sa-desktop-only">
        <table className="sa-table sa-table-sortable">
          <thead>
            <tr>
              {COLUMN_DEFS.map((col) => (
                <th key={col.key} className={`sa-th-sortable ${col.align === 'right' ? 'sa-text-right' : ''}`} onClick={() => handleSort(col.key)}>
                  {col.label} <SortIcon col={col.key} />
                </th>
              ))}
              <th>Коммуникация</th>
              <th>ТОП-ошибка</th>
              <th className="sa-th-sortable" onClick={() => handleSort('status')}>Статус <SortIcon col="status" /></th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>Загрузка…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>
                Нет сотрудников по выбранным фильтрам
                <br /><span style={{ fontSize: 12, opacity: 0.7 }}>Сбросьте фильтры или измените период</span>
              </td></tr>
            ) : (
              filtered.map((e) => {
                const delta = deltaDisplay(e.deltaRating);
                return (
                  <tr key={e.id} className="sa-row-clickable" onClick={() => onSelectEmployee?.(e.id)} role="button" tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && onSelectEmployee?.(e.id)}>
                    <td>
                      <div className="sa-emp-name-cell">
                        <span className="sa-avatar-placeholder">{e.fullName.charAt(0)}</span>
                        <div>
                          <div className="sa-cell-name">{e.fullName}</div>
                          <div className="sa-cell-city">Менеджер</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="sa-cell-name">{e.dealershipName}</div>
                      <div className="sa-cell-city">{e.city}</div>
                    </td>
                    <td className="sa-text-right"><span className={ratingClass(e.aiRating)}>{e.aiRating}</span></td>
                    <td className="sa-text-right"><span className={delta.cls}>{delta.text}</span></td>
                    <td className="sa-text-right">{e.auditsCount}</td>
                    <td className="sa-text-right">
                      <span className={e.failsCount >= 2 ? 'sa-score-red' : e.failsCount >= 1 ? 'sa-score-orange' : ''} title={e.failsCount > 0 ? 'Досрочно завершённые проверки' : undefined}>
                        {e.failsCount}
                      </span>
                    </td>
                    <td>
                      <span className={`sa-comm-badge ${COMM_BADGE_CLASS[e.communicationFlag]}`} title={commTooltip(e.communicationFlag)}>
                        {COMM_LABELS[e.communicationFlag]}
                      </span>
                    </td>
                    <td><span className="sa-top-mistake" title={e.topMistakeLabel}>{e.topMistakeLabel}</span></td>
                    <td><span className={statusBadgeClass(e.status)}>{STATUS_LABELS[e.status]}</span></td>
                    <td className="sa-row-chevron-cell">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ─── Mobile stacked rows ─── */}
      <div className="sa-mobile-only">
        {loading ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
        ) : filtered.length === 0 ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Нет сотрудников по выбранным фильтрам</div>
        ) : (
          filtered.map((e) => {
            const delta = deltaDisplay(e.deltaRating);
            return (
              <div key={e.id} className="sa-mobile-row" onClick={() => onSelectEmployee?.(e.id)} role="button" tabIndex={0}>
                <div className="sa-mobile-row-header">
                  <div>
                    <div className="sa-cell-name">{e.fullName}</div>
                    <div className="sa-cell-city">{e.dealershipName} · {e.city}</div>
                  </div>
                  <span className={`sa-mobile-rating ${ratingClass(e.aiRating)}`}>{e.aiRating}</span>
                </div>
                <div className="sa-mobile-chips">
                  <span className="sa-metric-chip"><span className={delta.cls}>{delta.text}</span></span>
                  <span className="sa-metric-chip">Проверки: {e.auditsCount}</span>
                  <span className="sa-metric-chip">Провалы: <span className={e.failsCount >= 2 ? 'sa-score-red' : ''}>{e.failsCount}</span></span>
                  <span className={`sa-comm-badge ${COMM_BADGE_CLASS[e.communicationFlag]}`}>{COMM_LABELS[e.communicationFlag]}</span>
                  <span className={statusBadgeClass(e.status)}>{STATUS_LABELS[e.status]}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

/* ────────── Tooltip helper ────────── */

function commTooltip(flag: CommunicationFlag): string {
  switch (flag) {
    case 'ok': return 'Коммуникация в норме';
    case 'fillers': return 'Обнаружены слова-паразиты в речи';
    case 'aggression': return 'Выявлены признаки агрессии в диалоге';
    case 'profanity': return 'Обнаружена ненормативная лексика';
    case 'low-engagement': return 'Низкая вовлечённость в диалог';
  }
}
