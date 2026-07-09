import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../entities/session';
import {
  STATUS_LABELS,
  type DealershipRow,
  type DealershipStatus,
} from '../../../shared/lib/admin-panel/mockData';
import type { DealershipDirection, DealershipItem, DealershipType, HoldingItem } from '../../../shared/api/adminPanel';
import { fetchAnalyticsDealerships, fetchDealershipDirections, fetchHoldings, type AnalyticsDealershipRow, type DealershipDirectionItem } from '../../../shared/api/adminPanel';
import { DealershipModal, formatWorkingHours } from '../../../shared/ui/dealership-modal/DealershipModal';
import { ratingClass, answerRateClass, answerTimeClass, deltaDisplay, statusBadgeClass } from '../../../shared/lib/admin-panel/utils';
import {
  ACTIVE_BATCH_STORAGE_KEY,
  fetchBatchWithSummary,
  type CallBatchSnapshot,
  type DealershipBatchSummary,
} from '../../../shared/lib/admin-panel/batchUtils';
import { ComparisonAISummary } from '../../../shared/ui/comparison-ai-summary/ComparisonAISummary';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { SingleSelectFilterPicker } from '../../../shared/ui/filter-picker/SingleSelectFilterPicker';

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

type SortKey = 'name' | 'dealer' | 'city' | 'type' | 'workingHours' | 'aiRating' | 'auditsCount' | 'deltaRating';
type SortDir = 'asc' | 'desc';

const COLUMN_DEFS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'name', label: 'Точка' },
  { key: 'dealer', label: 'Дилер' },
  { key: 'city', label: 'Город' },
  { key: 'type', label: 'Тип' },
  { key: 'aiRating', label: 'Балл', align: 'right' },
  { key: 'deltaRating', label: 'Тренд', align: 'right' },
  { key: 'auditsCount', label: 'Звонки', align: 'right' },
  { key: 'workingHours', label: 'Часы работы' },
];

function comparator(key: SortKey, dir: SortDir) {
  return (a: DealershipRow, b: DealershipRow): number => {
    let cmp = 0;
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, 'ru');
    } else if (key === 'dealer') {
      cmp = (a as CompanyRow).dealer.localeCompare((b as CompanyRow).dealer, 'ru');
    } else if (key === 'city') {
      cmp = a.city.localeCompare(b.city, 'ru');
    } else if (key === 'type') {
      cmp = (a as CompanyRow).type.localeCompare((b as CompanyRow).type, 'ru');
    } else if (key === 'workingHours') {
      cmp = (a as CompanyRow).workingHours.localeCompare((b as CompanyRow).workingHours, 'ru');
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

const PERIOD_FILTER_OPTIONS = [
  { value: '7d' as const, label: '7 дней' },
  { value: '30d' as const, label: '30 дней' },
];

type CompanyRow = DealershipRow & { dealer: string; workingHours: string; type: DealershipType; directions: DealershipDirection[]; isActive: boolean };

function dealershipTypeLabel(type: DealershipType): string {
  return type === 'franchised' ? 'Франчайзинговый' : 'Собственный';
}

function DealershipComparisonModal({
  rows,
  onClose,
  onOpenDealership,
}: {
  rows: CompanyRow[];
  onClose: () => void;
  onOpenDealership?: (id: string) => void;
}) {
  if (rows.length < 2) return null;
  const metricDefs = [
    { key: 'aiRating' as const, label: 'AI-рейтинг', higherBetter: true },
    { key: 'answerRate' as const, label: 'Дозвон, %', higherBetter: true },
    { key: 'avgAnswerTimeSec' as const, label: 'Время ответа, сек', higherBetter: false },
    { key: 'auditsCount' as const, label: 'Проверки', higherBetter: true },
    { key: 'employeesCount' as const, label: 'Сотрудники', higherBetter: true },
    { key: 'deltaRating' as const, label: 'Динамика', higherBetter: true },
  ];
  const leader = [...rows].sort((a, b) => b.aiRating - a.aiRating)[0];
  const lagger = [...rows].sort((a, b) => a.aiRating - b.aiRating)[0];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(15,23,42,.42)', display: 'grid', placeItems: 'center', padding: 20 }} onClick={onClose}>
      <div className="sa-card" style={{ width: 'min(1040px, 100%)', maxHeight: '86vh', overflow: 'auto' }} onClick={(event) => event.stopPropagation()}>
        <div className="sa-section-header-row" style={{ marginBottom: 16 }}>
          <div>
            <h2 className="sa-section-title" style={{ marginBottom: 4 }}>Сравнение точек</h2>
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
                    <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenDealership?.(row.id)}>{row.name}</button>
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
                      const value = raw === null ? null : Number(raw);
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
                <td>Статус</td>
                {rows.map((row) => (
                  <td key={row.id} className="sa-text-right"><span className={statusBadgeClass(row.status)}>{STATUS_LABELS[row.status]}</span></td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 16 }}>
          <ComparisonAISummary level="dealerships-directory" items={rows.map((row) => ({ ...row }))} />
        </div>
        <div className="sa-card" style={{ marginTop: 16 }}>
          <h3 className="sa-card-heading">Вывод</h3>
          <p className="sa-meta" style={{ lineHeight: 1.6 }}>
            Лидер по рейтингу — <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenDealership?.(leader.id)}>{leader.name}</button>.
            {' '}Самая слабая точка — <button type="button" className="sa-btn-text sa-btn-sm" onClick={() => onOpenDealership?.(lagger.id)}>{lagger.name}</button>.
            {' '}Разницу стоит смотреть через звонки, недозвоны и динамику за выбранный период.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────── Component ────────────────────── */

export function Companies({ dealerships, loading = false, onSelectDealership, onOpenBatchInAudits, onDealershipSaved }: CompaniesProps) {
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [analyticsRows, setAnalyticsRows] = useState<AnalyticsDealershipRow[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const selectedHolding = useMemo(
    () => holdings.find((holding) => holding.id === selectedHoldingId) ?? null,
    [holdings, selectedHoldingId],
  );
  const visibleDealerships = useMemo(
    () => selectedHoldingId ? dealerships.filter((item) => item.holdingId === selectedHoldingId) : [],
    [dealerships, selectedHoldingId],
  );
  const rows = useMemo<CompanyRow[]>(
    () => {
      const analyticsById = new Map(analyticsRows.map((item) => [item.id, item]));
      return visibleDealerships.map((item) => {
        const analytics = analyticsById.get(item.id);
        return {
          id: item.id,
          name: item.name,
          city: item.city || '—',
          dealer: analytics?.dealer ?? item.holdingName ?? 'Без дилера',
          type: item.type || 'own',
          directions: item.directions || [],
          workingHours: formatWorkingHours(item),
          isActive: item.isActive,
          aiRating: analytics?.aiRating ?? 0,
          answerRate: analytics?.answerRate ?? null,
          avgAnswerTimeSec: analytics?.avgAnswerTimeSec ?? null,
          auditsCount: analytics?.auditsCount ?? 0,
          employeesCount: analytics?.employeesCount ?? item.managersCount,
          deltaRating: analytics?.deltaRating ?? null,
          status: analytics?.status ?? 'no-data',
        };
      });
    },
    [analyticsRows, visibleDealerships],
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
  const [directionOptions, setDirectionOptions] = useState<DealershipDirectionItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<DealershipStatus[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [startingBatch, setStartingBatch] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeBatch, setActiveBatch] = useState<CallBatchSnapshot | null>(null);
  const [dealershipSummary, setDealershipSummary] = useState<Record<string, DealershipBatchSummary>>({});
  const [createDealershipOpen, setCreateDealershipOpen] = useState(false);
  const [selectedComparisonIds, setSelectedComparisonIds] = useState<string[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);

  const hasActiveManual = !!activeBatch && (activeBatch.status === 'running' || activeBatch.status === 'paused');
  const directionLabelByValue = useMemo(() => {
    const map = new Map<string, string>();
    for (const direction of directionOptions) {
      map.set(direction.id, direction.name);
      if (direction.code) map.set(direction.code, direction.name);
    }
    return map;
  }, [directionOptions]);
  const availableDirectionFilters = useMemo(() => {
    const used = new Set(rows.flatMap((row) => row.directions));
    const filters = directionOptions.map((direction) => {
      const value = used.has(direction.id)
        ? direction.id
        : direction.code && used.has(direction.code)
          ? direction.code
          : direction.code || direction.id;
      return { value, label: direction.name };
    });
    const knownValues = new Set(
      directionOptions.flatMap((direction) => [direction.id, direction.code].filter(Boolean) as string[]),
    );
    for (const value of used) {
      if (!knownValues.has(value)) {
        filters.push({ value, label: directionLabelByValue.get(value) || value });
      }
    }
    return filters.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [directionLabelByValue, directionOptions, rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setHoldingsLoading(true);
    setHoldingsError(null);
    fetchHoldings()
      .then((items) => {
        if (!cancelled) setHoldings(items);
      })
      .catch((error) => {
        if (!cancelled) {
          setHoldings([]);
          setHoldingsError(error instanceof Error ? error.message : 'Не удалось загрузить компании');
        }
      })
      .finally(() => {
        if (!cancelled) setHoldingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const selectedComparisonRows = useMemo(
    () => filtered.filter((row) => selectedComparisonIds.includes(row.id)),
    [filtered, selectedComparisonIds],
  );

  const toggleComparisonRow = (id: string) => {
    setSelectedComparisonIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
  };

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
    let cancelled = false;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    fetchAnalyticsDealerships()
      .then((items) => {
        if (!cancelled) setAnalyticsRows(items);
      })
      .catch((error) => {
        if (!cancelled) {
          setAnalyticsRows([]);
          setAnalyticsError(error instanceof Error ? error.message : 'Не удалось загрузить аналитику точек');
        }
      })
      .finally(() => {
        if (!cancelled) setAnalyticsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    let cancelled = false;
    if (!selectedHoldingId) {
      setDirectionOptions([]);
      setDirectionFilter([]);
      return () => { cancelled = true; };
    }
    fetchDealershipDirections({ holdingId: selectedHoldingId, active: true })
      .then((items) => { if (!cancelled) setDirectionOptions(items); })
      .catch(() => { if (!cancelled) setDirectionOptions([]); });
    return () => { cancelled = true; };
  }, [selectedHoldingId]);

  useEffect(() => {
    setDirectionFilter([]);
  }, [selectedHoldingId]);

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
        throw new Error('Нет точек для запуска проверки');
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
      if (targets.length === 0) throw new Error('Нет точек для тестового прогона');
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
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 className="sa-page-title">Точки</h1>
          <p className="sa-page-subtitle">Управление точками компании и их эффективностью</p>
        </div>
        <HoldingSelectPicker
          holdings={holdings}
          value={selectedHoldingId}
          onChange={(holdingId) => {
            setSelectedHoldingId(holdingId);
            setSelectedComparisonIds([]);
          }}
          disabled={holdingsLoading || holdings.length === 0}
          loading={holdingsLoading}
        />
      </div>
      {analyticsLoading && !loading && (
        <div className="sa-batch-live-note" style={{ marginBottom: 12 }}>
          Загружаем аналитику точек...
        </div>
      )}
      {analyticsError && (
        <div className="sa-batch-live-error" style={{ marginBottom: 12 }}>
          {analyticsError}
        </div>
      )}
      {holdingsError && (
        <div className="sa-batch-live-error" style={{ marginBottom: 12 }}>
          {holdingsError}
        </div>
      )}

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
          <div className="sa-tag-filter-picker-wrap">
            <SingleSelectFilterPicker
              options={PERIOD_FILTER_OPTIONS}
              value={period}
              onChange={(value) => setPeriod(value as Period)}
            />
          </div>
          <button className="sa-btn-outline" onClick={() => setShowFilters((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            Фильтры
          </button>
          <button className="sa-btn-primary" disabled={!selectedHoldingId} onClick={() => setCreateDealershipOpen(true)}>
            Создать точку
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
            <span className="sa-filter-label">Тип точки:</span>
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
              {availableDirectionFilters.map((direction) => (
                <label key={direction.value} className="sa-filter-check">
                  <input type="checkbox" checked={directionFilter.includes(direction.value)} onChange={() => toggleDirectionFilter(direction.value)} />
                  {direction.label}
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
              <th style={{ width: 44 }} />
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
              {loading || holdingsLoading ? (
                <tr><td colSpan={9} className="sa-meta" style={{ padding: 32 }}>Загрузка…</td></tr>
              ) : holdings.length === 0 ? (
                <tr><td colSpan={9} className="sa-meta" style={{ padding: 32 }}>Перед тем, как создавать точки, пожалуйста, добавьте компанию.</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="sa-meta" style={{ padding: 32 }}>Нет точек по заданным фильтрам</td></tr>
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
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedComparisonIds.includes(r.id)}
                        disabled={!selectedComparisonIds.includes(r.id) && selectedComparisonIds.length >= 6}
                        onChange={() => toggleComparisonRow(r.id)}
                        aria-label={`Выбрать ${r.name}`}
                      />
                    </td>
                    <td>
                      <div className="sa-cell-name">{r.name}</div>
                      <div className="sa-cell-city">{r.isActive ? 'Активен' : 'Не активен'}</div>
                      {dealershipSummary[r.id] && (
                        <div className="sa-inline-batch-status">
                          {dealershipSummary[r.id].completed}/{dealershipSummary[r.id].total} · {dealershipSummary[r.id].status === 'in_progress' ? 'в работе' : dealershipSummary[r.id].status === 'completed' ? 'готово' : dealershipSummary[r.id].status === 'failed' ? 'ошибка' : dealershipSummary[r.id].status === 'partial' ? 'частично' : dealershipSummary[r.id].status === 'cancelled' ? 'отменено' : 'в очереди'}
                        </div>
                      )}
                    </td>
                    <td>{r.dealer}</td>
                    <td>{r.city}</td>
                    <td>{dealershipTypeLabel(r.type)}</td>
                    <td className="sa-text-right"><span className={ratingClass(r.aiRating)}>{r.aiRating}</span></td>
                    <td className="sa-text-right"><span className={delta.cls}>{delta.text}</span></td>
                    <td className="sa-text-right">{r.auditsCount}</td>
                    <td>{r.workingHours}</td>
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
        {loading || holdingsLoading ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка…</div>
        ) : holdings.length === 0 ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Перед тем, как создавать точки, пожалуйста, добавьте компанию.</div>
        ) : filtered.length === 0 ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Нет точек по заданным фильтрам</div>
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
                <div onClick={(event) => event.stopPropagation()} style={{ marginBottom: 8 }}>
                  <label className="sa-filter-check" style={{ width: 'fit-content' }}>
                    <input
                      type="checkbox"
                      checked={selectedComparisonIds.includes(r.id)}
                      disabled={!selectedComparisonIds.includes(r.id) && selectedComparisonIds.length >= 6}
                      onChange={() => toggleComparisonRow(r.id)}
                    />
                    Сравнить
                  </label>
                </div>
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
        fixedHoldingId={selectedHoldingId}
        fixedHoldingName={selectedHolding?.name || null}
        onClose={() => setCreateDealershipOpen(false)}
        onSaved={(saved) => onDealershipSaved?.(saved)}
      />
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
        <DealershipComparisonModal
          rows={selectedComparisonRows}
          onClose={() => setComparisonOpen(false)}
          onOpenDealership={onSelectDealership}
        />
      )}
    </>
  );
}
