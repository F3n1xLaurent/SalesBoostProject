import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../entities/session';
import {
  STATUS_LABELS,
  STATUS_ORDER,
  type DealershipRow,
  type DealershipStatus,
} from '../../../shared/lib/admin-panel/mockData';
import type { DealershipDirection, DealershipItem, DealershipType } from '../../../shared/api/adminPanel';
import { DealershipModal, formatWorkingHours } from '../../../shared/ui/dealership-modal/DealershipModal';
import { ratingClass, answerRateClass, answerTimeClass, deltaDisplay, statusBadgeClass } from '../../../shared/lib/admin-panel/utils';
import {
  ACTIVE_BATCH_STORAGE_KEY,
  fetchBatchWithSummary,
  type CallBatchSnapshot,
  type DealershipBatchSummary,
} from '../../../shared/lib/admin-panel/batchUtils';

const API_BASE = '';

/* ────────────────────── Props ────────────────────── */

type CompaniesProps = {
  dealerships: DealershipItem[];
  loading?: boolean;
  onSelectDealership?: (id: string) => void;
  onOpenBatchInAudits?: (batchId: string) => void;
  onDealershipSaved?: (dealership: DealershipItem) => void;
};

/* ────────────────────── Sort config ────────────────────── */

type SortKey = 'name' | 'workingHours' | 'aiRating' | 'answerRate' | 'avgAnswerTimeSec' | 'auditsCount' | 'employeesCount' | 'deltaRating' | 'status';
type SortDir = 'asc' | 'desc';

const COLUMN_DEFS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'name', label: 'Автосалон' },
  { key: 'workingHours', label: 'Время работы' },
  { key: 'aiRating', label: 'AI-рейтинг', align: 'right' },
  { key: 'answerRate', label: 'Дозвон, %', align: 'right' },
  { key: 'avgAnswerTimeSec', label: 'Время ответа', align: 'right' },
  { key: 'auditsCount', label: 'Проверки', align: 'right' },
  { key: 'employeesCount', label: 'Сотрудники', align: 'right' },
  { key: 'deltaRating', label: 'Динамика', align: 'right' },
  { key: 'status', label: 'Статус' },
];

function comparator(key: SortKey, dir: SortDir) {
  return (a: DealershipRow, b: DealershipRow): number => {
    let cmp = 0;
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, 'ru');
    } else if (key === 'workingHours') {
      cmp = (a as CompanyRow).workingHours.localeCompare((b as CompanyRow).workingHours, 'ru');
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

/* ────────────────────── Period helper ────────────────────── */

type Period = '7d' | '30d' | 'custom';
type CompanyRow = DealershipRow & { workingHours: string; type: DealershipType; directions: DealershipDirection[]; isActive: boolean };

function dealershipTypeLabel(type: DealershipType): string {
  return type === 'franchised' ? 'Франчайзинговый' : 'Собственный';
}

function dealershipDirectionLabel(direction: DealershipDirection): string {
  return direction === 'used_cars' ? 'Автомобили с пробегом' : 'Новые автомобили';
}

/* ────────────────────── Component ────────────────────── */

export function Companies({ dealerships, loading = false, onSelectDealership, onOpenBatchInAudits, onDealershipSaved }: CompaniesProps) {
  const rows = useMemo<CompanyRow[]>(
    () =>
      dealerships.map((item) => ({
        id: item.id,
        name: item.name,
        city: item.city || '—',
        type: item.type || 'own',
        directions: item.directions || [],
        workingHours: formatWorkingHours(item),
        isActive: item.isActive,
        aiRating: 0,
        answerRate: null,
        avgAnswerTimeSec: null,
        auditsCount: 0,
        employeesCount: item.managersCount,
        deltaRating: null,
        status: 'no-data',
      })),
    [dealerships],
  );
  const allCities = useMemo(
    () => [...new Set(rows.map((item) => item.city).filter(Boolean))],
    [rows],
  );

  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState<Period>('30d');
  const [sortKey, setSortKey] = useState<SortKey>('aiRating');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [onlyProblematic, setOnlyProblematic] = useState(false);
  const [onlyNoData, setOnlyNoData] = useState(false);
  const [cityFilter, setCityFilter] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<DealershipType[]>([]);
  const [directionFilter, setDirectionFilter] = useState<DealershipDirection[]>([]);
  const [statusFilter, setStatusFilter] = useState<DealershipStatus[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [startingBatch, setStartingBatch] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeBatch, setActiveBatch] = useState<CallBatchSnapshot | null>(null);
  const [dealershipSummary, setDealershipSummary] = useState<Record<string, DealershipBatchSummary>>({});
  const [createDealershipOpen, setCreateDealershipOpen] = useState(false);

  const hasActiveManual = !!activeBatch && (activeBatch.status === 'running' || activeBatch.status === 'paused');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let list = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q));
    }
    if (onlyProblematic) {
      list = list.filter((r) => r.status === 'critical' || r.status === 'risk');
    }
    if (onlyNoData) {
      list = list.filter((r) => r.status === 'no-data');
    }
    if (cityFilter.length > 0) {
      list = list.filter((r) => cityFilter.includes(r.city));
    }
    if (typeFilter.length > 0) {
      list = list.filter((r) => typeFilter.includes(r.type));
    }
    if (directionFilter.length > 0) {
      list = list.filter((r) => directionFilter.some((direction) => r.directions.includes(direction)));
    }
    if (statusFilter.length > 0) {
      list = list.filter((r) => statusFilter.includes(r.status));
    }
    return [...list].sort(comparator(sortKey, sortDir));
  }, [rows, search, onlyProblematic, onlyNoData, cityFilter, typeFilter, directionFilter, statusFilter, sortKey, sortDir]);

  const toggleCityFilter = (city: string) => {
    setCityFilter((prev) => (prev.includes(city) ? prev.filter((c) => c !== city) : [...prev, city]));
  };

  const toggleTypeFilter = (type: DealershipType) => {
    setTypeFilter((prev) => (prev.includes(type) ? prev.filter((x) => x !== type) : [...prev, type]));
  };

  const toggleDirectionFilter = (direction: DealershipDirection) => {
    setDirectionFilter((prev) => (prev.includes(direction) ? prev.filter((x) => x !== direction) : [...prev, direction]));
  };

  const toggleStatusFilter = (s: DealershipStatus) => {
    setStatusFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <span className="sa-sort-icon sa-sort-icon-inactive">⇅</span>;
    return <span className="sa-sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  async function fetchTestNumbers(): Promise<string[]> {
    const res = await apiFetch(`${API_BASE}/api/admin/test-numbers`);
    if (!res.ok) throw new Error('Не удалось получить тестовые номера');
    const data = await res.json().catch(() => ({}));
    const nums = Array.isArray(data?.numbers) ? data.numbers.map((x: unknown) => String(x)) : [];
    return nums.filter((n: string) => n.trim().length > 0);
  }

  async function refreshBatch(batchId: string): Promise<void> {
    const data = await fetchBatchWithSummary(batchId);
    if (!data || !data.batch) {
      setActiveBatchId(null);
      setActiveBatch(null);
      setDealershipSummary({});
      return;
    }
    setActiveBatch(data.batch);
    const raw = Array.isArray(data.dealershipSummary) ? (data.dealershipSummary as DealershipBatchSummary[]) : [];
    const mapped: Record<string, DealershipBatchSummary> = {};
    for (const item of raw) {
      if (item.dealershipId) mapped[item.dealershipId] = item;
    }
    setDealershipSummary(mapped);
  }

  const handleDismissBatchPanel = () => {
    setActiveBatchId(null);
    setActiveBatch(null);
    setDealershipSummary({});
    setBatchError(null);
    setBatchNotice(null);
    try {
      localStorage.removeItem(ACTIVE_BATCH_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    try {
      const remembered = localStorage.getItem(ACTIVE_BATCH_STORAGE_KEY);
      if (remembered && remembered.trim()) {
        setActiveBatchId(remembered.trim());
      }
    } catch {
      // ignore localStorage errors
    }
  }, []);

  useEffect(() => {
    if (!activeBatchId) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      await refreshBatch(activeBatchId);
      if (stopped) return;
      const isFinal = activeBatch?.status === 'completed' || activeBatch?.status === 'cancelled';
      if (!isFinal) {
        window.setTimeout(poll, 1500);
      }
    };
    poll();
    return () => { stopped = true; };
  }, [activeBatchId, activeBatch?.status]);

  async function handleStartAllChecks() {
    setBatchError(null);
    setBatchNotice(null);
    setStartingBatch(true);
    try {
      const targets = filtered.length > 0 ? filtered : rows;
      if (targets.length === 0) {
        throw new Error('Нет автосалонов для запуска проверки');
      }
      const numbers = await fetchTestNumbers();
      if (numbers.length === 0) {
        throw new Error('Добавьте VOX_TEST_TO или VOX_TEST_NUMBERS в .env');
      }
      const jobs = targets.map((d, idx) => ({
        dealershipId: d.id,
        dealershipName: d.name,
        phone: numbers[idx % numbers.length],
      }));
      const res = await apiFetch(`${API_BASE}/api/admin/call-batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'all_dealerships',
          title: `Проверка сети (${jobs.length})`,
          maxConcurrency: 10,
          startIntervalMs: 350,
          maxAttempts: 3,
          jobs,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Не удалось запустить батч');
      const batchId = String(data.batchId || '');
      if (!batchId) throw new Error('Сервер не вернул batchId');
      setActiveBatchId(batchId);
      try { localStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, batchId); } catch {}
      setBatchNotice(`Проверка запущена: ${jobs.length} задач`);
      await refreshBatch(batchId);
    } catch (e: unknown) {
      let message = e instanceof Error ? e.message : 'Ошибка запуска проверки';
      if (message.includes('Уже есть активная ручная проверка')) {
        setBatchNotice('Уже есть активная ручная проверка. Управляйте ею в трее проверок в правом нижнем углу.');
      } else {
        setBatchError(message);
      }
    } finally {
      setStartingBatch(false);
    }
  }

  async function handleStartLocalTest() {
    setBatchError(null);
    setBatchNotice(null);
    setStartingBatch(true);
    try {
      const targets = (filtered.length > 0 ? filtered : rows).slice(0, 12);
      if (targets.length === 0) throw new Error('Нет автосалонов для тестового прогона');
      const jobs = targets.map((d) => ({
        dealershipId: d.id,
        dealershipName: d.name,
        phone: '',
      }));
      const res = await apiFetch(`${API_BASE}/api/admin/call-batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'manual',
          title: `Тестовый прогон (${jobs.length})`,
          maxConcurrency: 6,
          startIntervalMs: 250,
          maxAttempts: 2,
          testMode: true,
          jobs,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Не удалось запустить тестовый прогон');
      const batchId = String(data.batchId || '');
      if (!batchId) throw new Error('Сервер не вернул batchId');
      setActiveBatchId(batchId);
      try { localStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, batchId); } catch {}
      setBatchNotice(`Тестовый прогон запущен: ${jobs.length} задач (без реальных звонков)`);
      await refreshBatch(batchId);
    } catch (e: unknown) {
      let message = e instanceof Error ? e.message : 'Ошибка тестового прогона';
      if (message.includes('Уже есть активная ручная проверка')) {
        setBatchNotice('Уже есть активная ручная проверка. Управляйте ею в трее проверок в правом нижнем углу.');
      } else {
        setBatchError(message);
      }
    } finally {
      setStartingBatch(false);
    }
  }

  async function setBatchMode(action: 'pause' | 'resume' | 'cancel') {
    if (!activeBatchId) return;
    setBatchError(null);
    const res = await apiFetch(`${API_BASE}/api/admin/call-batches/${activeBatchId}/${action}`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setBatchError(data?.error || `Не удалось выполнить ${action}`);
      return;
    }
    await refreshBatch(activeBatchId);
  }

  return (
    <>
      <h1 className="sa-page-title">Автосалоны</h1>
      <p className="sa-page-subtitle">Управление точками холдинга и их эффективностью</p>

      {/* ─── Toolbar ─── */}
      <div className="sa-toolbar">
        <div className="sa-toolbar-row">
          <div className="sa-search-wrap">
            <svg className="sa-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              className="sa-search-input"
              placeholder="Поиск по названию или городу…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="sa-select" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
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
          <button className="sa-btn-primary" onClick={() => setCreateDealershipOpen(true)}>
            Создать автосалон
          </button>
          <button
            className="sa-btn-danger"
            onClick={handleStartAllChecks}
            disabled={startingBatch || hasActiveManual}
            title={hasActiveManual ? 'Уже есть активная ручная проверка — управляйте ею в трее проверок.' : undefined}
          >
            <span className="sa-btn-danger-dot" />
            {startingBatch ? 'Запуск...' : 'Проверить все автосалоны'}
          </button>
          <button
            className="sa-btn-outline"
            onClick={handleStartLocalTest}
            disabled={startingBatch || hasActiveManual}
            title={hasActiveManual ? 'Уже есть активная ручная проверка — управляйте ею в трее проверок.' : undefined}
          >
            Тестовый прогон (без звонков)
          </button>
        </div>
        <div className="sa-toolbar-chips">
          <button
            className={`sa-chip ${onlyProblematic ? 'sa-chip-active' : ''}`}
            onClick={() => { setOnlyProblematic((v) => !v); setOnlyNoData(false); }}
          >
            Только проблемные
          </button>
          <button
            className={`sa-chip ${onlyNoData ? 'sa-chip-active' : ''}`}
            onClick={() => { setOnlyNoData((v) => !v); setOnlyProblematic(false); }}
          >
            Без данных
          </button>
        </div>
      </div>

      {batchNotice && (
        <div className="sa-batch-live-note" style={{ marginBottom: 8 }}>
          {batchNotice}
        </div>
      )}
      {batchError && (
        <div className="sa-batch-live-error" style={{ marginBottom: 8 }}>
          {batchError}
        </div>
      )}

      {/* ─── Filters panel (collapsible) ─── */}
      {showFilters && (
        <div className="sa-filters-panel">
          <div className="sa-filter-group">
            <span className="sa-filter-label">Город:</span>
            <div className="sa-filter-options">
              {allCities.map((city) => (
                <label key={city} className="sa-filter-check">
                  <input type="checkbox" checked={cityFilter.includes(city)} onChange={() => toggleCityFilter(city)} />
                  {city}
                </label>
              ))}
            </div>
          </div>
          <div className="sa-filter-group">
            <span className="sa-filter-label">Статус:</span>
            <div className="sa-filter-options">
              {(['critical', 'risk', 'norm', 'no-data'] as DealershipStatus[]).map((s) => (
                <label key={s} className="sa-filter-check">
                  <input type="checkbox" checked={statusFilter.includes(s)} onChange={() => toggleStatusFilter(s)} />
                  {STATUS_LABELS[s]}
                </label>
              ))}
            </div>
          </div>
          <div className="sa-filter-group">
            <span className="sa-filter-label">Тип автосалона:</span>
            <div className="sa-filter-options">
              {(['own', 'franchised'] as DealershipType[]).map((type) => (
                <label key={type} className="sa-filter-check">
                  <input type="checkbox" checked={typeFilter.includes(type)} onChange={() => toggleTypeFilter(type)} />
                  {dealershipTypeLabel(type)}
                </label>
              ))}
            </div>
          </div>
          <div className="sa-filter-group">
            <span className="sa-filter-label">Направления:</span>
            <div className="sa-filter-options">
              {(['new_cars', 'used_cars'] as DealershipDirection[]).map((direction) => (
                <label key={direction} className="sa-filter-check">
                  <input type="checkbox" checked={directionFilter.includes(direction)} onChange={() => toggleDirectionFilter(direction)} />
                  {dealershipDirectionLabel(direction)}
                </label>
              ))}
            </div>
          </div>
          <button className="sa-filter-reset" onClick={() => { setCityFilter([]); setTypeFilter([]); setDirectionFilter([]); setStatusFilter([]); }}>Сбросить фильтры</button>
        </div>
      )}

      {/* ─── Desktop table ─── */}
      <div className="sa-companies-table-wrap sa-desktop-only">
        <table className="sa-table sa-table-sortable">
          <thead>
            <tr>
              {COLUMN_DEFS.map((col) => (
                <th
                  key={col.key}
                  className={`sa-th-sortable ${col.align === 'right' ? 'sa-text-right' : ''}`}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label} <SortIcon col={col.key} />
                </th>
              ))}
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>Загрузка…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={10} className="sa-meta" style={{ padding: 32 }}>Нет автосалонов по заданным фильтрам</td></tr>
            ) : (
              filtered.map((r) => {
                const delta = deltaDisplay(r.deltaRating);
                return (
                  <tr
                    key={r.id}
                    className="sa-row-clickable"
                    onClick={() => onSelectDealership?.(r.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && onSelectDealership?.(r.id)}
                  >
                    <td>
                      <div className="sa-cell-name">{r.name}</div>
                      <div className="sa-cell-city">{r.city} · {dealershipTypeLabel(r.type)} · {r.isActive ? 'Активен' : 'Не активен'}</div>
                      {dealershipSummary[r.id] && (
                        <div className="sa-inline-batch-status">
                          {dealershipSummary[r.id].completed}/{dealershipSummary[r.id].total} · {dealershipSummary[r.id].status === 'in_progress' ? 'в работе' : dealershipSummary[r.id].status === 'completed' ? 'готово' : dealershipSummary[r.id].status === 'failed' ? 'ошибка' : dealershipSummary[r.id].status === 'partial' ? 'частично' : dealershipSummary[r.id].status === 'cancelled' ? 'отменено' : 'в очереди'}
                        </div>
                      )}
                    </td>
                    <td>{r.workingHours}</td>
                    <td className="sa-text-right"><span className={ratingClass(r.aiRating)}>{r.aiRating}</span></td>
                    <td className="sa-text-right">
                      {r.answerRate !== null
                        ? <span className={answerRateClass(r.answerRate)}>{r.answerRate}%</span>
                        : <span className="sa-muted" title="Метрика появится после подключения телефонии">—</span>
                      }
                    </td>
                    <td className="sa-text-right">
                      {r.avgAnswerTimeSec !== null
                        ? <span className={answerTimeClass(r.avgAnswerTimeSec)}>{r.avgAnswerTimeSec}с</span>
                        : <span className="sa-muted" title="Нет данных за период">—</span>
                      }
                    </td>
                    <td className="sa-text-right">{r.auditsCount}</td>
                    <td className="sa-text-right">{r.employeesCount}</td>
                    <td className="sa-text-right"><span className={delta.cls}>{delta.text}</span></td>
                    <td><span className={statusBadgeClass(r.status)}>{STATUS_LABELS[r.status]}</span></td>
                    <td className="sa-row-chevron-cell">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
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
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Нет автосалонов по заданным фильтрам</div>
        ) : (
          filtered.map((r) => {
            const delta = deltaDisplay(r.deltaRating);
            return (
              <div
                key={r.id}
                className="sa-mobile-row"
                onClick={() => onSelectDealership?.(r.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && onSelectDealership?.(r.id)}
              >
                <div className="sa-mobile-row-header">
                  <div>
                    <div className="sa-cell-name">{r.name}</div>
                    <div className="sa-cell-city">{r.city} · {dealershipTypeLabel(r.type)} · {r.isActive ? 'Активен' : 'Не активен'}</div>
                  </div>
                  <span className={`sa-mobile-rating ${ratingClass(r.aiRating)}`}>{r.aiRating}</span>
                </div>
                <div className="sa-mobile-chips">
                  <span className="sa-metric-chip">
                    Время: {r.workingHours}
                  </span>
                  <span className="sa-metric-chip">
                    Дозвон: {r.answerRate !== null ? <span className={answerRateClass(r.answerRate)}>{r.answerRate}%</span> : '—'}
                  </span>
                  <span className="sa-metric-chip">
                    Ответ: {r.avgAnswerTimeSec !== null ? <span className={answerTimeClass(r.avgAnswerTimeSec)}>{r.avgAnswerTimeSec}с</span> : '—'}
                  </span>
                  <span className="sa-metric-chip">Проверки: {r.auditsCount}</span>
                  <span className="sa-metric-chip">Сотрудники: {r.employeesCount}</span>
                  <span className="sa-metric-chip"><span className={delta.cls}>{delta.text}</span></span>
                  <span className={statusBadgeClass(r.status)}>{STATUS_LABELS[r.status]}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <DealershipModal
        mode="create"
        open={createDealershipOpen}
        onClose={() => setCreateDealershipOpen(false)}
        onSaved={(saved) => onDealershipSaved?.(saved)}
      />
    </>
  );
}
