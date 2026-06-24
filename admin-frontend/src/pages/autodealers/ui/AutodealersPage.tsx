import React, { useEffect, useState, useMemo } from 'react';
import { fetchAnalyticsManagers, type AnalyticsManagerRow } from '../../../shared/api/adminPanel';
import {
  STATUS_LABELS,
  STATUS_ORDER,
  COMM_LABELS,
  COMM_BADGE_CLASS,
  type EmployeeFullRow,
  type DealershipStatus,
  type CommunicationFlag,
} from '../../../shared/lib/admin-panel/mockData';
import { ratingClass, deltaDisplay, statusBadgeClass } from '../../../shared/lib/admin-panel/utils';
import { ComparisonAISummary } from '../../../shared/ui/comparison-ai-summary/ComparisonAISummary';

/* ────────────────────── Props ────────────────────── */

type Props = {
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

type ManagerRow = EmployeeFullRow & {
  dataState?: 'full' | 'partial' | 'none';
  directCalls?: number;
  dealershipCalls?: number;
};

function comparator(key: SortKey, dir: SortDir) {
  return (a: ManagerRow, b: ManagerRow): number => {
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

function matchesQuickFilter(e: ManagerRow, f: QuickFilter): boolean {
  switch (f) {
    case 'training': return e.status === 'critical' || e.status === 'risk';
    case 'fails': return e.failsCount >= 1;
    case 'best': return e.aiRating >= 80 && e.status === 'norm';
    case 'comm': return e.communicationFlag !== 'ok';
  }
}

function ManagerComparisonModal({
  rows,
  onClose,
  onOpenEmployee,
}: {
  rows: ManagerRow[];
  onClose: () => void;
  onOpenEmployee: (row: ManagerRow) => void;
}) {
  if (rows.length < 2) return null;
  const metricDefs = [
    { key: 'aiRating' as const, label: 'AI-рейтинг', higherBetter: true },
    { key: 'deltaRating' as const, label: 'Динамика', higherBetter: true },
    { key: 'auditsCount' as const, label: 'Проверки', higherBetter: true },
    { key: 'failsCount' as const, label: 'Провалы', higherBetter: false },
    { key: 'directCalls' as const, label: 'Прямые звонки', higherBetter: true },
    { key: 'dealershipCalls' as const, label: 'Звонки точки', higherBetter: true },
  ];
  const leader = [...rows].sort((a, b) => b.aiRating - a.aiRating)[0];
  const lagger = [...rows].sort((a, b) => a.aiRating - b.aiRating)[0];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(15,23,42,.42)', display: 'grid', placeItems: 'center', padding: 20 }} onClick={onClose}>
      <div className="sa-card" style={{ width: 'min(1040px, 100%)', maxHeight: '86vh', overflow: 'auto' }} onClick={(event) => event.stopPropagation()}>
        <div className="sa-section-header-row" style={{ marginBottom: 16 }}>
          <div>
            <h2 className="sa-section-title" style={{ marginBottom: 4 }}>Сравнение сотрудников</h2>
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
                    <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenEmployee(row)}>{row.fullName}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metricDefs.map((metric) => {
                const values = rows.map((row) => Number(row[metric.key] ?? (metric.higherBetter ? 0 : Number.POSITIVE_INFINITY)));
                const best = metric.higherBetter ? Math.max(...values) : Math.min(...values);
                const worst = metric.higherBetter ? Math.min(...values) : Math.max(...values);
                return (
                  <tr key={metric.key}>
                    <td>{metric.label}</td>
                    {rows.map((row) => {
                      const raw = row[metric.key];
                      const value = raw === null || raw === undefined ? null : Number(raw);
                      const isBest = value !== null && value === best;
                      const isWorst = value !== null && value === worst && best !== worst;
                      return (
                        <td key={row.id} className="sa-text-right">
                          <span className={isBest ? 'sa-score-green' : isWorst ? 'sa-score-red' : ''}>
                            {value === null ? '—' : metric.key === 'deltaRating' && value > 0 ? `+${value}` : value}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr>
                <td>Коммуникация</td>
                {rows.map((row) => (
                  <td key={row.id} className="sa-text-right">
                    <span className={`sa-comm-badge ${COMM_BADGE_CLASS[row.communicationFlag]}`}>{COMM_LABELS[row.communicationFlag]}</span>
                  </td>
                ))}
              </tr>
              <tr>
                <td>Статус</td>
                {rows.map((row) => (
                  <td key={row.id} className="sa-text-right"><span className={statusBadgeClass(row.status)}>{STATUS_LABELS[row.status]}</span></td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 16 }}>
          <ComparisonAISummary level="managers-directory" items={rows.map((row) => ({ ...row }))} />
        </div>
        <div className="sa-card" style={{ marginTop: 16 }}>
          <h3 className="sa-card-heading">Вывод</h3>
          <p className="sa-meta" style={{ lineHeight: 1.6 }}>
            Лидер по рейтингу — <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenEmployee(leader)}>{leader.fullName}</button>.
            {' '}Самый слабый показатель — <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenEmployee(lagger)}>{lagger.fullName}</button>.
            {' '}Для разбора смотрите провалы, коммуникацию и наличие прямых звонков менеджера.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────── Component ────────────────────── */

export function Autodealers({ loading = false, onSelectEmployee }: Props) {
  const [realRows, setRealRows] = useState<ManagerRow[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [noticeRow, setNoticeRow] = useState<ManagerRow | null>(null);
  const rows = realRows;
  const allCities = useMemo(() => [...new Set(rows.map((item) => item.city))], [rows]);
  const allDealerships = useMemo(() => [...new Set(rows.map((item) => item.dealershipName))], [rows]);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('aiRating');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [quickFilter, setQuickFilter] = useState<QuickFilter | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [cityFilter, setCityFilter] = useState<string[]>([]);
  const [dealershipFilter, setDealershipFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<DealershipStatus[]>([]);
  const [selectedComparisonIds, setSelectedComparisonIds] = useState<string[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    fetchAnalyticsManagers()
      .then((items) => {
        if (cancelled) return;
        setRealRows(items.map(managerAnalyticsToRow));
      })
      .catch((error) => {
        if (!cancelled) {
          setRealRows([]);
          setAnalyticsError(error instanceof Error ? error.message : 'Не удалось загрузить сотрудников');
        }
      })
      .finally(() => {
        if (!cancelled) setAnalyticsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'fullName' || key === 'dealershipName' ? 'asc' : 'desc'); }
  };

  const toggleQuick = (f: QuickFilter) => setQuickFilter((prev) => (prev === f ? null : f));

  const filtered = useMemo(() => {
    let list: ManagerRow[] = rows;
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
  const selectedComparisonRows = useMemo(
    () => filtered.filter((row) => selectedComparisonIds.includes(row.id)),
    [filtered, selectedComparisonIds],
  );

  const toggleCity = (c: string) => setCityFilter((p) => p.includes(c) ? p.filter((x) => x !== c) : [...p, c]);
  const toggleDealer = (d: string) => setDealershipFilter((p) => p.includes(d) ? p.filter((x) => x !== d) : [...p, d]);
  const toggleStatus = (s: DealershipStatus) => setStatusFilter((p) => p.includes(s) ? p.filter((x) => x !== s) : [...p, s]);
  const toggleComparisonRow = (id: string) => {
    const row = rows.find((item) => item.id === id);
    if (row && row.dataState !== 'full') return;
    setSelectedComparisonIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <span className="sa-sort-icon sa-sort-icon-inactive">⇅</span>;
    return <span className="sa-sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };
  const handleOpenEmployee = (row: ManagerRow) => {
    if (row.dataState === 'none' || row.dataState === 'partial') {
      setNoticeRow(row);
      return;
    }
    onSelectEmployee?.(row.id);
  };
  const isLoading = loading || analyticsLoading;

  return (
    <>
      <h1 className="sa-page-title">Сотрудники</h1>
      <p className="sa-page-subtitle">Контроль качества менеджеров и выявление зон для обучения</p>
      {analyticsError && (
        <div className="sa-batch-live-error" style={{ marginBottom: 12 }}>
          {analyticsError}
        </div>
      )}

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
              <th style={{ width: 44 }} />
              {COLUMN_DEFS.map((col) => (
                <th key={col.key} className={`sa-th-sortable ${col.align === 'right' ? 'sa-text-right' : ''}`} onClick={() => handleSort(col.key)}>
                  {col.label} <SortIcon col={col.key} />
                </th>
              ))}
              <th>Коммуникация</th>
              <th>ТОП-ошибка</th>
              <th>Данные</th>
              <th className="sa-th-sortable" onClick={() => handleSort('status')}>Статус <SortIcon col="status" /></th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={12} className="sa-meta" style={{ padding: 32 }}>Загрузка…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={12} className="sa-meta" style={{ padding: 32 }}>
                {analyticsError ? 'Не удалось загрузить реальную аналитику сотрудников' : 'Нет сотрудников по выбранным фильтрам'}
                <br /><span style={{ fontSize: 12, opacity: 0.7 }}>{analyticsError ? 'Проверьте backend API и обновите страницу' : 'Сбросьте фильтры или измените период'}</span>
              </td></tr>
            ) : (
              filtered.map((e) => {
                const delta = deltaDisplay(e.deltaRating);
                return (
                  <tr key={e.id} className="sa-row-clickable" onClick={() => handleOpenEmployee(e)} role="button" tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && handleOpenEmployee(e)}>
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedComparisonIds.includes(e.id)}
                        disabled={e.dataState !== 'full' || (!selectedComparisonIds.includes(e.id) && selectedComparisonIds.length >= 6)}
                        onChange={() => toggleComparisonRow(e.id)}
                        aria-label={`Выбрать ${e.fullName}`}
                      />
                    </td>
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
                    <td><span className="sa-metric-chip">{dataStateLabel(e.dataState)}</span></td>
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
        {isLoading ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
        ) : filtered.length === 0 ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>
            {analyticsError ? 'Не удалось загрузить реальную аналитику сотрудников' : 'Нет сотрудников по выбранным фильтрам'}
          </div>
        ) : (
          filtered.map((e) => {
            const delta = deltaDisplay(e.deltaRating);
            return (
              <div key={e.id} className="sa-mobile-row" onClick={() => handleOpenEmployee(e)} role="button" tabIndex={0}>
                <div onClick={(event) => event.stopPropagation()} style={{ marginBottom: 8 }}>
                  <label className="sa-filter-check" style={{ width: 'fit-content' }}>
                    <input
                      type="checkbox"
                      checked={selectedComparisonIds.includes(e.id)}
                      disabled={e.dataState !== 'full' || (!selectedComparisonIds.includes(e.id) && selectedComparisonIds.length >= 6)}
                      onChange={() => toggleComparisonRow(e.id)}
                    />
                    Сравнить
                  </label>
                </div>
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
                  <span className="sa-metric-chip">{dataStateLabel(e.dataState)}</span>
                  <span className={statusBadgeClass(e.status)}>{STATUS_LABELS[e.status]}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
      {noticeRow && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.42)', zIndex: 90, display: 'grid', placeItems: 'center', padding: 20 }} onClick={() => setNoticeRow(null)}>
          <div className="sa-card" style={{ width: 'min(520px, 100%)' }} onClick={(event) => event.stopPropagation()}>
            <div className="sa-section-header-row" style={{ marginBottom: 12 }}>
              <div>
                <h2 className="sa-section-title" style={{ marginBottom: 4 }}>{noticeRow.fullName}</h2>
                <div className="sa-meta">{noticeRow.dealershipName}</div>
              </div>
              <button className="sa-btn-outline" onClick={() => setNoticeRow(null)}>Закрыть</button>
            </div>
            <p className="sa-meta" style={{ lineHeight: 1.6 }}>
              {noticeRow.dataState === 'partial'
                ? `Есть только данные по общим звонкам точки (${noticeRow.dealershipCalls ?? 0}), но прямых звонков менеджера пока нет.`
                : 'По менеджеру пока нет ни прямых звонков, ни достаточных данных для оценки.'}
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
              <button className="sa-btn-primary" disabled>Позвонить напрямую</button>
              <button className="sa-btn-outline" disabled>Добавить в расписание</button>
            </div>
          </div>
        </div>
      )}
      {selectedComparisonRows.length > 0 && (
        <div style={{ position: 'fixed', left: 24, right: 24, bottom: 24, zIndex: 60, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="sa-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', pointerEvents: 'auto', boxShadow: '0 16px 40px rgba(15,23,42,.18)' }}>
            <strong>Выбрано: {selectedComparisonRows.length}</strong>
            <button type="button" className="sa-btn-outline" disabled={selectedComparisonRows.length < 2} onClick={() => setComparisonOpen(true)}>Сравнить</button>
            <button type="button" className="sa-btn-text" onClick={() => setSelectedComparisonIds([])}>Сбросить</button>
          </div>
        </div>
      )}
      {comparisonOpen && (
        <ManagerComparisonModal rows={selectedComparisonRows} onClose={() => setComparisonOpen(false)} onOpenEmployee={handleOpenEmployee} />
      )}
    </>
  );
}

function managerAnalyticsToRow(item: AnalyticsManagerRow): ManagerRow {
  return {
    id: item.id,
    fullName: item.fullName,
    dealershipId: item.dealershipId,
    dealershipName: item.dealershipName,
    city: item.city,
    aiRating: item.aiRating,
    deltaRating: item.deltaRating,
    auditsCount: item.auditsCount,
    failsCount: item.failsCount,
    communicationFlag: item.communicationFlag,
    topMistakeLabel: item.topMistakeLabel,
    status: item.status,
    dataState: item.dataState,
    directCalls: item.directCalls,
    dealershipCalls: item.dealershipCalls,
  };
}

function dataStateLabel(state?: ManagerRow['dataState']): string {
  if (state === 'full') return 'Полные';
  if (state === 'partial') return 'Частичные';
  if (state === 'none') return 'Нет данных';
  return 'Нет данных';
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
