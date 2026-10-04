import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { apiFetch } from '../../../entities/session';
import { fetchAuditDetail, type AuditDetailItem } from '../../../shared/api/adminPanel';
import { SlideOver } from '../../../shared/ui/slide-over';
import { BrutalModal } from '../../../shared/ui/brutal-modal/BrutalModal';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import './internal-analytics.css';

type DemoAnalytics = {
  summary: {
    totalCalls: number;
    completedCalls: number;
    answeredRate: number;
    avgDurationSec: number;
    avgAnswerTimeSec: number;
    avgScore: number;
    uniqueIps: number;
    repeatVisitors: number;
  };
  scoreDistribution: { good: number; medium: number; bad: number };
  outcomeBreakdown: Record<string, number>;
  criteria: Array<{ title: string; checks: number; completionPercent: number }>;
  topWeaknesses: Array<{ text: string; count: number }>;
  daily: Array<{ date: string; calls: number; answered: number; avgScore: number }>;
  recentCalls: Array<{
    id: number;
    callId: string;
    phone: string;
    ivrDetected: boolean;
    ivrPath: string[];
    ipAddress: string | null;
    startedAt: string;
    outcome: string;
    durationSec: number | null;
    totalScore: number | null;
    error: string | null;
  }>;
};

type ActivityAnalytics = {
  generatedAt: string;
  periodDays: 7 | 30 | 90;
  trackingStartedAt: string | null;
  summary: {
    dau: number;
    wau: number;
    mau: number;
    activeManagers: number;
    activeLeaders: number;
    activationRate: number;
    activationCohortSize: number;
    retentionD7: number | null;
    retentionCohortSize: number;
    fullCycleRate: number;
    fullCycleManagers: number;
    northStarRate: number;
    improvedManagers: number;
    avgQualityScore: number | null;
    qualityScoreDelta: number | null;
  };
  managers: {
    trainingsStarted: number;
    trainingsCompleted: number;
    trainingCompletionRate: number;
    avgTrainingsPerActiveManager: number;
    managersTrained: number;
    checksCompleted: number;
    managersChecked: number;
    scoreViews: number;
    errorViews: number;
    recommendationsViewed: number;
  };
  leaders: {
    activeLeaders: number;
    analyticsViews: number;
    managerViews: number;
    managersViewed: number;
    dealershipViews: number;
    dealershipsViewed: number;
    comparisons: number;
    reportsViewed: number;
    callsAnalyzed: number;
    recommendationsViewed: number;
  };
  funnel: Array<{ key: string; label: string; value: number; percent: number }>;
  featureUsage: Array<{ eventName: string; label: string; events: number; users: number }>;
  daily: Array<{ date: string; activeUsers: number; trainingsCompleted: number; checksCompleted: number }>;
};

type EconomicsAnalytics = {
  generatedAt: string;
  dateFrom: string;
  dateTo: string;
  summary: { totalRub: number; confirmedRub: number; estimatedRub: number; events: number; units: number; avgPerUnitRub: number; withoutRubAmount: number };
  providers: Array<{ provider: string; amountRub: number; events: number; confirmed: number; estimated: number; withoutRubAmount: number }>;
  providerCategories: Array<{ provider: string; category: string; amountRub: number; events: number }>;
  providerBalances: Array<{
    provider: string; available: boolean; balance: number | null; balanceRub: number | null;
    currency: string | null; unit: string | null; used: number | null; limit: number | null;
    capturedAt: string | null; resetAt: string | null; averageDaily: number | null;
    forecastDays: number | null; forecastUnits: number | null; basis: string;
  }>;
  technicalExpenses: Array<{ id: string; source: 'system' | 'custom'; provider: string | null; name: string; amountRub: number; previousMonthAmountRub: number; events: number | null }>;
  technicalExpensesTotalRub: number;
  technicalExpensesPreviousMonthTotalRub: number;
  exchangeRates: Array<{ currency: string; rate: number; rateDate: string; source: string }>;
  companies: Array<{ companyId: string | null; name: string; amountRub: number; events: number; units: number; avgPerUnitRub: number }>;
  dealerships: Array<{ dealershipId: string; name: string; companyId: string | null; companyName: string; amountRub: number; events: number; units: number; avgPerUnitRub: number }>;
  calls: Array<{
    callId: string; occurredAt: string; durationSec: number | null;
    companyId: string | null; companyName: string; dealershipId: string | null; dealershipName: string;
    employeeId: string | null; employeeName: string;
    analyticsRub: number; speechToTextRub: number; speechSynthesisRub: number;
    telephonyRub: number; otherRub: number; totalRub: number;
  }>;
  daily: Array<{ date: string; amountRub: number }>;
  recent: Array<{ id: string; provider: string; category: string; stage: string | null; entityType: string | null; entityId: string | null; companyName: string | null; model: string | null; amountOriginal: number; currency: string; amountRub: number | null; exchangeRateToRub: number | null; exchangeRateDate: string | null; exchangeRateSource: string | null; status: string; occurredAt: string }>;
};

type CompanyForecast = {
  monthDays: number;
  monthlyCalls: number;
  monthlyMinutes: number;
  scenarios: Array<{
    key: 'best' | 'median' | 'worst';
    rates: { telephonyPerMinute: number; aiPerCall: number };
    components: { telephony: number; ai: number; phoneNumbers: number };
    totalRub: number;
    averagePerCallRub: number;
  }>;
  warnings: string[];
  assumptions: string[];
  samples: { telephonyCalls: number; aiCalls: number; fallbackTelephony: boolean };
  methodology: { best: string; median: string; worst: string };
};

const outcomeLabels: Record<string, string> = {
  completed: 'Завершён', disconnected: 'Завершён', no_answer: 'Нет ответа', busy: 'Занято',
  failed: 'Ошибка', error: 'Ошибка', processing: 'Обработка', cancelled: 'Отменён',
};

type InternalAnalyticsTab = 'demo' | 'activity' | 'economics';

function tabFromSearch(search: string): InternalAnalyticsTab {
  const value = new URLSearchParams(search).get('tab');
  return value === 'activity' || value === 'economics' ? value : 'demo';
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function currentMonthRange(): { dateFrom: string; dateTo: string } {
  const dateTo = moscowDateKey(new Date());
  return { dateFrom: `${dateTo.slice(0, 7)}-01`, dateTo };
}

function moscowDateKey(value: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

export function InternalAnalyticsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = useMemo(() => tabFromSearch(location.search), [location.search]);
  const [filters, setFilters] = useState({ q: '', minDuration: '', maxDuration: '', minScore: '', maxScore: '', dateFrom: '', dateTo: '' });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [data, setData] = useState<DemoAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activityPeriod, setActivityPeriod] = useState<7 | 30 | 90>(30);
  const [activityData, setActivityData] = useState<ActivityAnalytics | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [economicsDates, setEconomicsDates] = useState(currentMonthRange);
  const [economicsData, setEconomicsData] = useState<EconomicsAnalytics | null>(null);
  const [economicsLoading, setEconomicsLoading] = useState(false);
  const [economicsError, setEconomicsError] = useState<string | null>(null);
  const [economicsNotice, setEconomicsNotice] = useState<string | null>(null);
  const [reportDrawerOpen, setReportDrawerOpen] = useState(false);
  const [reportDrawerLoading, setReportDrawerLoading] = useState(false);
  const [reportDrawerError, setReportDrawerError] = useState<string | null>(null);
  const [reportDrawerDetail, setReportDrawerDetail] = useState<AuditDetailItem | null>(null);
  const reportCallId = useMemo(() => new URLSearchParams(location.search).get('callId')?.trim() ?? '', [location.search]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.has('tab')) return;
    params.set('tab', 'demo');
    navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  function selectTab(nextTab: InternalAnalyticsTab) {
    const params = new URLSearchParams(location.search);
    params.set('tab', nextTab);
    navigate({ pathname: location.pathname, search: `?${params.toString()}` });
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => setAppliedFilters(filters), 350);
    return () => window.clearTimeout(timeout);
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    for (const key of ['q', 'minDuration', 'maxDuration', 'minScore', 'maxScore'] as const) {
      if (appliedFilters[key]) params.set(key, appliedFilters[key]);
    }
    if (appliedFilters.dateFrom) params.set('dateFrom', new Date(appliedFilters.dateFrom).toISOString());
    if (appliedFilters.dateTo) params.set('dateTo', new Date(appliedFilters.dateTo).toISOString());
    apiFetch(`/api/admin/internal-analytics/demo${params.size ? `?${params}` : ''}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить аналитику.');
        if (!cancelled) setData(payload as DemoAnalytics);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Ошибка загрузки.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [appliedFilters]);

  useEffect(() => {
    if (tab !== 'activity') return;
    let cancelled = false;
    setActivityLoading(true);
    setActivityError(null);
    apiFetch(`/api/admin/internal-analytics/activity?period=${activityPeriod}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить активность.');
        if (!cancelled) setActivityData(payload as ActivityAnalytics);
      })
      .catch((reason) => {
        if (!cancelled) setActivityError(reason instanceof Error ? reason.message : 'Ошибка загрузки.');
      })
      .finally(() => {
        if (!cancelled) setActivityLoading(false);
      });
    return () => { cancelled = true; };
  }, [activityPeriod, tab]);

  const loadEconomics = React.useCallback(async () => {
    setEconomicsLoading(true);
    setEconomicsError(null);
    try {
      const params = new URLSearchParams(economicsDates);
      const response = await apiFetch(`/api/admin/internal-analytics/economics?${params}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить экономику.');
      setEconomicsData(payload as EconomicsAnalytics);
    } catch (reason) {
      setEconomicsError(reason instanceof Error ? reason.message : 'Ошибка загрузки.');
    } finally {
      setEconomicsLoading(false);
    }
  }, [economicsDates]);

  useEffect(() => {
    if (tab === 'economics') void loadEconomics();
  }, [tab, loadEconomics]);

  useEffect(() => {
    let cancelled = false;

    if (!reportCallId) {
      setReportDrawerOpen(false);
      setReportDrawerLoading(false);
      setReportDrawerError(null);
      setReportDrawerDetail(null);
      return () => { cancelled = true; };
    }

    setReportDrawerOpen(true);
    setReportDrawerLoading(true);
    setReportDrawerError(null);
    setReportDrawerDetail(null);

    fetchAuditDetail(`call-${reportCallId}`)
      .then((detail) => {
        if (cancelled) return;
        if (!detail) {
          setReportDrawerError('Отчёт не найден');
          return;
        }
        setReportDrawerDetail(detail);
      })
      .catch((reason) => {
        if (!cancelled) {
          setReportDrawerError(reason instanceof Error ? reason.message : 'Не удалось загрузить отчёт');
        }
      })
      .finally(() => {
        if (!cancelled) setReportDrawerLoading(false);
      });

    return () => { cancelled = true; };
  }, [reportCallId]);

  function openReportDrawer(callId: number) {
    const params = new URLSearchParams(location.search);
    params.set('callId', String(callId));
    navigate({ pathname: location.pathname, search: `?${params.toString()}` });
  }

  function closeReportDrawer() {
    setReportDrawerOpen(false);
    const params = new URLSearchParams(location.search);
    params.delete('callId');
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : '' },
      { replace: true },
    );
  }

  const maxDaily = useMemo(() => Math.max(1, ...(data?.daily.map((item) => item.calls) ?? [1])), [data]);

  return (
    <div className="internal-analytics-page">
      <header className="internal-analytics-page__header">
        <div>
          <h1 className="sa-page-title">Внутренняя аналитика</h1>
          <p className="sa-meta">Служебные показатели платформы. Доступны только суперадминистратору.</p>
        </div>
      </header>

      <div className="sa-dialog-tabs" role="tablist" aria-label="Раздел внутренней аналитики">
        <button type="button" role="tab" aria-selected={tab === 'demo'} className={`sa-dialog-tab ${tab === 'demo' ? 'sa-dialog-tab-active' : ''}`} onClick={() => selectTab('demo')}>Демо-стенд</button>
        <button type="button" role="tab" aria-selected={tab === 'activity'} className={`sa-dialog-tab ${tab === 'activity' ? 'sa-dialog-tab-active' : ''}`} onClick={() => selectTab('activity')}>Активность</button>
        <button type="button" role="tab" aria-selected={tab === 'economics'} className={`sa-dialog-tab ${tab === 'economics' ? 'sa-dialog-tab-active' : ''}`} onClick={() => selectTab('economics')}>Экономика</button>
      </div>

      {tab === 'economics' && (
        <EconomicsAnalyticsView
          data={economicsData}
          loading={economicsLoading}
          error={economicsError}
          notice={economicsNotice}
          dates={economicsDates}
          onDatesChange={setEconomicsDates}
          onReload={loadEconomics}
          onNotice={setEconomicsNotice}
        />
      )}

      {tab === 'activity' && (
        <>
          <div className="internal-activity-toolbar">
            <span>Период</span>
            <div className="internal-period-switch" role="group" aria-label="Период аналитики">
              {([7, 30, 90] as const).map((period) => (
                <button
                  type="button"
                  key={period}
                  className={activityPeriod === period ? 'is-active' : ''}
                  onClick={() => setActivityPeriod(period)}
                >
                  {period} дней
                </button>
              ))}
            </div>
          </div>
          {activityLoading && !activityData && <div className="internal-analytics-placeholder">Загружаем активность…</div>}
          {activityError && <div className="internal-analytics-placeholder internal-analytics-placeholder--error">{activityError}</div>}
          {activityData && (
            <ActivityAnalyticsView data={activityData} loading={activityLoading} />
          )}
        </>
      )}

      {tab === 'demo' && (
        <section className="internal-analytics-filters" aria-label="Фильтры demo-звонков">
          <label className="internal-filter internal-filter--search"><span>Поиск</span><input type="search" value={filters.q} placeholder="Телефон, IP или ID звонка" onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} /></label>
          <fieldset><legend>Длительность, сек.</legend><input type="number" min="0" placeholder="От" value={filters.minDuration} onChange={(event) => setFilters((current) => ({ ...current, minDuration: event.target.value }))} /><span>—</span><input type="number" min="0" placeholder="До" value={filters.maxDuration} onChange={(event) => setFilters((current) => ({ ...current, maxDuration: event.target.value }))} /></fieldset>
          <fieldset><legend>Балл</legend><input type="number" min="0" max="100" placeholder="От" value={filters.minScore} onChange={(event) => setFilters((current) => ({ ...current, minScore: event.target.value }))} /><span>—</span><input type="number" min="0" max="100" placeholder="До" value={filters.maxScore} onChange={(event) => setFilters((current) => ({ ...current, maxScore: event.target.value }))} /></fieldset>
          <label className="internal-filter"><span>Дата и время от</span><input type="datetime-local" value={filters.dateFrom} onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))} /></label>
          <label className="internal-filter"><span>Дата и время до</span><input type="datetime-local" value={filters.dateTo} onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))} /></label>
          <button type="button" className="internal-filters-reset" disabled={!Object.values(filters).some(Boolean)} onClick={() => setFilters({ q: '', minDuration: '', maxDuration: '', minScore: '', maxScore: '', dateFrom: '', dateTo: '' })}>Сбросить</button>
        </section>
      )}
      {tab === 'demo' && loading && !data && <div className="internal-analytics-placeholder">Загружаем аналитику…</div>}
      {tab === 'demo' && error && <div className="internal-analytics-placeholder internal-analytics-placeholder--error">{error}</div>}
      {tab === 'demo' && data && (
        <div className={`internal-demo-analytics ${loading ? 'internal-demo-analytics--loading' : ''}`}>
          <section className="internal-metric-grid">
            <Metric label="Всего запусков" value={data.summary.totalCalls} />
            <Metric label="Завершено" value={data.summary.completedCalls} />
            <Metric label="Дозвон" value={`${data.summary.answeredRate}%`} />
            <Metric label="Средний балл" value={data.summary.avgScore} suffix="/100" />
            <Metric label="Средняя длительность" value={formatDuration(data.summary.avgDurationSec)} />
            <Metric label="Среднее время ответа" value={`${data.summary.avgAnswerTimeSec} сек`} />
            <Metric label="Уникальные IP" value={data.summary.uniqueIps} />
            <Metric label="Повторные посетители" value={data.summary.repeatVisitors} />
          </section>

          <div className="internal-analytics-two-columns">
            <section className="internal-analytics-card">
              <h2>Динамика за 30 дней</h2>
              {data.daily.length ? <div className="internal-daily-chart">
                {data.daily.map((item) => <div className="internal-daily-chart__item" key={item.date} title={`${item.date}: ${item.calls} звонков`}>
                  <span>{item.calls}</span><i style={{ height: `${Math.max(5, item.calls / maxDaily * 100)}%` }} /><small>{item.date.slice(5)}</small>
                </div>)}
              </div> : <p className="sa-meta">Пока нет данных.</p>}
            </section>
            <section className="internal-analytics-card">
              <h2>Результаты</h2>
              <div className="internal-outcomes">
                {Object.entries(data.outcomeBreakdown).map(([key, count]) => <div key={key}><span>{outcomeLabels[key] || key}</span><strong>{count}</strong></div>)}
              </div>
              <div className="internal-score-row">
                <span className="good">Хорошо: {data.scoreDistribution.good}</span>
                <span className="medium">Средне: {data.scoreDistribution.medium}</span>
                <span className="bad">Плохо: {data.scoreDistribution.bad}</span>
              </div>
            </section>
          </div>

          <div className="internal-analytics-two-columns">
            <section className="internal-analytics-card">
              <h2>Выполнение условий сценария</h2>
              <div className="internal-progress-list">
                {data.criteria.length ? data.criteria.map((item) => <div key={item.title}>
                  <div><span>{item.title}</span><strong>{item.completionPercent}%</strong></div>
                  <i><b style={{ width: `${item.completionPercent}%` }} /></i>
                </div>) : <p className="sa-meta">Появится после первого проанализированного звонка.</p>}
              </div>
            </section>
            <section className="internal-analytics-card">
              <h2>Частые слабые стороны</h2>
              {data.topWeaknesses.length ? <ol className="internal-weaknesses">
                {data.topWeaknesses.map((item) => <li key={item.text}><span>{item.text}</span><strong>{item.count}</strong></li>)}
              </ol> : <p className="sa-meta">Пока недостаточно данных.</p>}
            </section>
          </div>

          <section className="internal-analytics-card internal-calls-card">
            <h2>Demo-звонки <small>{data.summary.totalCalls}</small></h2>
            <div className="internal-calls-table-wrap">
              <table className="internal-calls-table">
                <thead><tr><th>Дата и время (МСК)</th><th>IP-адрес</th><th>Телефон</th><th>Результат</th><th>Длительность</th><th>Балл</th></tr></thead>
                <tbody>{data.recentCalls.map((call) => <tr key={call.id} className="internal-call-row" title={call.error || undefined} onClick={() => openReportDrawer(call.id)}>
                  <td>{formatDate(call.startedAt)}</td><td className="mono">{call.ipAddress || '—'}</td><td>{call.phone}{call.ivrDetected && <span className="sa-ivr-badge" style={{ marginLeft: 6 }}>IVR{call.ivrPath.length > 0 ? ` (${call.ivrPath.join('-')})` : ''}</span>}</td>
                  <td><span className={`internal-outcome internal-outcome--${call.outcome}`}>{outcomeLabels[call.outcome] || call.outcome}</span></td>
                  <td>{formatDuration(call.durationSec)}</td><td>{call.totalScore == null ? '—' : `${Math.round(call.totalScore)}/100`}</td>
                </tr>)}{data.recentCalls.length === 0 && <tr><td colSpan={6} className="internal-calls-empty">По заданным фильтрам звонки не найдены.</td></tr>}</tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      <SlideOver
        open={reportDrawerOpen}
        title="Аналитика звонка"
        width="xl"
        onClose={closeReportDrawer}
      >
        {reportDrawerLoading ? (
          <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Загрузка отчёта...</div>
        ) : reportDrawerError ? (
          <div className="sa-card" style={{ padding: 20 }}>
            <div style={{ color: '#b91c1c', fontWeight: 700 }}>Не удалось открыть отчёт</div>
            <div className="sa-meta" style={{ marginTop: 8 }}>{reportDrawerError}</div>
          </div>
        ) : reportDrawerDetail ? (
          <AuditAnalyticsReport detail={reportDrawerDetail} />
        ) : (
          <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Выберите звонок.</div>
        )}
      </SlideOver>
    </div>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string | number; suffix?: string }) {
  return <article className="internal-metric"><span>{label}</span><strong>{value}<small>{suffix}</small></strong></article>;
}

function ActivityAnalyticsView({ data, loading }: { data: ActivityAnalytics; loading: boolean }) {
  const maxDaily = Math.max(1, ...data.daily.flatMap((item) => [item.activeUsers, item.trainingsCompleted, item.checksCompleted]));
  const delta = data.summary.qualityScoreDelta;
  const trackingDate = data.trackingStartedAt ? formatDate(data.trackingStartedAt) : null;

  return (
    <div className={`internal-activity-analytics ${loading ? 'internal-demo-analytics--loading' : ''}`}>
      <div className="internal-activity-note">
        <strong>Как считаем:</strong> активность — действия авторизованных менеджеров и руководителей; суперадминистраторы исключены.
        {trackingDate
          ? <> История просмотров накапливается с {trackingDate}. Тренировки, проверки и баллы учитываются из основной БД.</>
          : <> История просмотров начнёт накапливаться после первого действия пользователя.</>}
      </div>

      <section className="internal-metric-grid internal-metric-grid--activity">
        <Metric label="DAU · сегодня" value={data.summary.dau} />
        <Metric label="WAU · 7 дней" value={data.summary.wau} />
        <Metric label="MAU · 30 дней" value={data.summary.mau} />
        <Metric label="Активные менеджеры" value={data.summary.activeManagers} />
        <Metric label="Активные руководители" value={data.summary.activeLeaders} />
        <Metric label="Активация новых менеджеров" value={data.summary.activationCohortSize ? `${data.summary.activationRate}%` : '—'} suffix={data.summary.activationCohortSize ? `из ${data.summary.activationCohortSize}` : undefined} />
        <Metric label="Retention D7" value={data.summary.retentionD7 == null ? '—' : `${data.summary.retentionD7}%`} suffix={data.summary.retentionCohortSize ? `когорта ${data.summary.retentionCohortSize}` : undefined} />
        <Metric label="Полный цикл" value={`${data.summary.fullCycleRate}%`} suffix={`${data.summary.fullCycleManagers} менедж.`} />
        <Metric label="North Star" value={`${data.summary.northStarRate}%`} suffix={`${data.summary.improvedManagers} менедж.`} />
        <Metric label="Средний балл проверок" value={data.summary.avgQualityScore ?? '—'} suffix={data.summary.avgQualityScore == null ? undefined : '/100'} />
        <Metric
          label="Изменение к прошлому периоду"
          value={delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta}`}
          suffix={delta == null ? undefined : 'балла'}
        />
      </section>

      <section className="internal-analytics-card">
        <div className="internal-card-heading-row">
          <div><h2>Динамика активности</h2><p>Уникальные пользователи, завершённые тренировки и проверки по дням</p></div>
          <div className="internal-chart-legend"><span className="users">Активность</span><span className="trainings">Тренировки</span><span className="checks">Проверки</span></div>
        </div>
        <div className="internal-activity-chart">
          {data.daily.map((item) => (
            <div className="internal-activity-chart__item" key={item.date} title={`${item.date}: активных ${item.activeUsers}, тренировок ${item.trainingsCompleted}, проверок ${item.checksCompleted}`}>
              <div className="internal-activity-chart__bars">
                <i className="users" style={{ height: `${Math.max(item.activeUsers ? 4 : 0, item.activeUsers / maxDaily * 100)}%` }} />
                <i className="trainings" style={{ height: `${Math.max(item.trainingsCompleted ? 4 : 0, item.trainingsCompleted / maxDaily * 100)}%` }} />
                <i className="checks" style={{ height: `${Math.max(item.checksCompleted ? 4 : 0, item.checksCompleted / maxDaily * 100)}%` }} />
              </div>
              <small>{item.date.slice(5)}</small>
            </div>
          ))}
        </div>
      </section>

      <div className="internal-analytics-two-columns">
        <section className="internal-analytics-card">
          <h2>Менеджеры</h2>
          <div className="internal-stat-list">
            <StatRow label="Запущено тренировок" value={data.managers.trainingsStarted} />
            <StatRow label="Завершено тренировок" value={data.managers.trainingsCompleted} />
            <StatRow label="Training Completion" value={`${data.managers.trainingCompletionRate}%`} />
            <StatRow label="Менеджеров тренировались" value={data.managers.managersTrained} />
            <StatRow label="Тренировок на активного менеджера" value={data.managers.avgTrainingsPerActiveManager} />
            <StatRow label="Завершено проверок" value={data.managers.checksCompleted} />
            <StatRow label="Проверено менеджеров" value={data.managers.managersChecked} />
            <StatRow label="Просмотров оценок" value={data.managers.scoreViews} />
            <StatRow label="Просмотров ошибок" value={data.managers.errorViews} />
            <StatRow label="Просмотров рекомендаций" value={data.managers.recommendationsViewed} />
          </div>
        </section>
        <section className="internal-analytics-card">
          <h2>Руководители</h2>
          <div className="internal-stat-list">
            <StatRow label="Использовали продукт" value={data.leaders.activeLeaders} />
            <StatRow label="Открывали аналитику" value={data.leaders.analyticsViews} />
            <StatRow label="Уникальных сотрудников просмотрено" value={data.leaders.managersViewed} />
            <StatRow label="Всего просмотров сотрудников" value={data.leaders.managerViews} />
            <StatRow label="Уникальных точек просмотрено" value={data.leaders.dealershipsViewed} />
            <StatRow label="Всего просмотров точек" value={data.leaders.dealershipViews} />
            <StatRow label="Использовали сравнение" value={data.leaders.comparisons} />
            <StatRow label="Уникальных звонков проанализировано" value={data.leaders.callsAnalyzed} />
            <StatRow label="Всего просмотров отчётов" value={data.leaders.reportsViewed} />
            <StatRow label="Просматривали рекомендации" value={data.leaders.recommendationsViewed} />
          </div>
        </section>
      </div>

      <div className="internal-analytics-two-columns">
        <section className="internal-analytics-card">
          <div className="internal-card-heading-row"><div><h2>Ценность продукта</h2><p>Цепочка внутри выбранного периода</p></div></div>
          <div className="internal-progress-list internal-funnel-list">
            {data.funnel.map((item) => (
              <div key={item.key}>
                <div><span>{item.label}</span><strong>{item.value} · {item.percent}%</strong></div>
                <i><b style={{ width: `${item.percent}%` }} /></i>
              </div>
            ))}
          </div>
        </section>
        <section className="internal-analytics-card">
          <div className="internal-card-heading-row"><div><h2>Использование функций</h2><p>Только события, собранные после подключения трекинга</p></div></div>
          <div className="internal-feature-table-wrap">
            <table className="internal-feature-table">
              <thead><tr><th>Функция</th><th>Пользователи</th><th>Действия</th></tr></thead>
              <tbody>{data.featureUsage.map((item) => (
                <tr key={item.eventName}><td>{item.label}</td><td>{item.users}</td><td>{item.events}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="internal-activity-footnote">
        «Полный цикл» — менеджер завершил тренировку, затем прошёл оценённую проверку и получил рекомендации.
        North Star дополнительно требует повторную проверку с ростом балла. Звонки на общий номер точки без привязки к менеджеру в эти две метрики не входят.
      </div>
    </div>
  );
}

function rub(value: number): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(value);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: value < 100 ? 2 : 0 }).format(value);
}

function balanceValue(item: EconomicsAnalytics['providerBalances'][number]): string {
  if (item.balance == null) return 'Нет данных';
  if (item.unit === 'credits') return `${compactNumber(item.balance)} кредитов`;
  if (item.currency === 'RUB' || item.currency === 'RUR') return rub(item.balance);
  return `${compactNumber(item.balance)} ${item.currency || ''}`.trim();
}

const ECONOMICS_PAGE_SIZE = 10;

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / ECONOMICS_PAGE_SIZE));
}

function safePage(page: number, total: number): number {
  return Math.min(Math.max(1, page), pageCount(total));
}

function pageSlice<T>(rows: T[], page: number): T[] {
  const current = safePage(page, rows.length);
  return rows.slice((current - 1) * ECONOMICS_PAGE_SIZE, current * ECONOMICS_PAGE_SIZE);
}

function pageItems(current: number, total: number): Array<number | 'ellipsis-start' | 'ellipsis-end'> {
  if (total <= 9) return Array.from({ length: total }, (_, index) => index + 1);
  const values: Array<number | 'ellipsis-start' | 'ellipsis-end'> = [1];
  const from = Math.max(2, current - 2);
  const to = Math.min(total - 1, current + 2);
  if (from > 2) values.push('ellipsis-start');
  for (let page = from; page <= to; page += 1) values.push(page);
  if (to < total - 1) values.push('ellipsis-end');
  values.push(total);
  return values;
}

function EconomicsPagination({ page, totalItems, onChange }: { page: number; totalItems: number; onChange: (page: number) => void }) {
  const pages = pageCount(totalItems);
  const current = safePage(page, totalItems);
  if (pages <= 1) return null;
  return <nav className="internal-table-pagination" aria-label="Страницы таблицы">
    <button type="button" disabled={current === 1} onClick={() => onChange(current - 1)} aria-label="Предыдущая страница">‹</button>
    {pageItems(current, pages).map((item) => typeof item === 'number'
      ? <button type="button" key={item} className={item === current ? 'is-active' : ''} aria-current={item === current ? 'page' : undefined} onClick={() => onChange(item)}>{item}</button>
      : <span key={item}>…</span>)}
    <button type="button" disabled={current === pages} onClick={() => onChange(current + 1)} aria-label="Следующая страница">›</button>
  </nav>;
}

const providerLabels: Record<string, string> = { proxyapi: 'ProxyAPI', elevenlabs: 'ElevenLabs', voximplant: 'Voximplant' };
const costCategoryLabels: Record<string, string> = {
  usage: 'Звонки и ресурсы', phone_number: 'Абонплата за номера', phone_number_setup: 'Подключение номеров',
  subscription: 'Подписки', subscription_setup: 'Подключение подписок', sip_registration: 'SIP-регистрация',
  tax: 'Налоги', monthly_fee: 'Ежемесячная плата', account: 'Прочие расходы',
  llm: 'Языковые модели', stt: 'Распознавание речи', tts: 'Синтез речи', agent: 'AI-агент', telephony: 'Телефония',
};

const forecastScenarioLabels = {
  best: {
    title: 'Наилучший',
    caption: 'Экономичный сценарий',
    help: 'Показывает себестоимость при ставках, близких к самым дешёвым звонкам из нашей истории. Подходит для оценки минимально ожидаемых расходов.',
  },
  median: {
    title: 'Средний',
    caption: 'Наиболее типичный сценарий',
    help: 'Показывает наиболее типичную себестоимость: половина прошлых звонков стоила дешевле, а половина — дороже.',
  },
  worst: {
    title: 'Наихудший',
    caption: 'Максимальный расход',
    help: 'Показывает себестоимость по самому дорогому наблюдаемому тарифу. Нужен, чтобы оценить запас бюджета на неблагоприятный сценарий.',
  },
} as const;

function ForecastInfo({ text }: { text: string }) {
  return <span className="internal-forecast-info" tabIndex={0} aria-label={text}>
    i
    <span role="tooltip">{text}</span>
  </span>;
}

function CompanyForecastModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [locations, setLocations] = useState('1');
  const [employees, setEmployees] = useState('10');
  const [calls, setCalls] = useState('15');
  const [duration, setDuration] = useState('3');
  const [durationUnit, setDurationUnit] = useState<'minutes' | 'seconds'>('minutes');
  const [result, setResult] = useState<CompanyForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function calculate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/admin/internal-analytics/economics/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locations: Number(locations),
          employeesPerLocation: Number(employees),
          callsPerEmployeePerDay: Number(calls),
          averageCallDurationSeconds: Number(duration) * (durationUnit === 'minutes' ? 60 : 1),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось рассчитать прогноз.');
      setResult(payload as CompanyForecast);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось рассчитать прогноз.');
    } finally {
      setLoading(false);
    }
  }

  return <BrutalModal
    open={open}
    onClose={onClose}
    title="Прогностика"
    subtitle="Прогноз месячной себестоимости подключения компании"
    width="wide"
    modalClassName="internal-forecast-modal"
  >
    <form className="internal-forecast-form" onSubmit={(event) => void calculate(event)}>
      <div className="internal-forecast-fields">
        <label><span>Количество точек</span><input type="text" inputMode="numeric" value={locations} onChange={(event) => setLocations(event.target.value)} /></label>
        <label><span>Сотрудников в точке</span><input type="text" inputMode="numeric" value={employees} onChange={(event) => setEmployees(event.target.value)} /></label>
        <label><span>Звонков в сутки на сотрудника</span><input type="text" inputMode="decimal" value={calls} onChange={(event) => setCalls(event.target.value.replace(',', '.'))} /></label>
        <label className="internal-forecast-duration"><span>Средняя длительность звонка</span><div><input type="text" inputMode="decimal" value={duration} onChange={(event) => setDuration(event.target.value.replace(',', '.'))} /><select value={durationUnit} onChange={(event) => setDurationUnit(event.target.value as 'minutes' | 'seconds')}><option value="minutes">минут</option><option value="seconds">секунд</option></select></div></label>
      </div>
      <button className="internal-forecast-submit" type="submit" disabled={loading}>{loading ? 'Рассчитываем…' : 'Рассчитать'}</button>
    </form>
    {error && <div className="internal-forecast-error">{error}</div>}
    {result && <div className="internal-forecast-result">
      <div className="internal-forecast-volume">
        <div><span>Звонков за 30 дней</span><strong>{compactNumber(result.monthlyCalls)}</strong></div>
        <div><span>Разговорных минут</span><strong>{compactNumber(result.monthlyMinutes)}</strong></div>
      </div>
      {result.warnings.length > 0 && <div className="internal-forecast-warnings">{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
      <div className="internal-forecast-scenarios">
        {result.scenarios.map((scenario) => <article key={scenario.key} className={`internal-forecast-scenario internal-forecast-scenario--${scenario.key}`}>
          <header><div><div className="internal-forecast-title"><h3>{forecastScenarioLabels[scenario.key].title}</h3><ForecastInfo text={forecastScenarioLabels[scenario.key].help} /></div><span>{forecastScenarioLabels[scenario.key].caption}</span></div><strong>{rub(scenario.totalRub)}</strong></header>
          <dl>
            <div><dt>Телефония</dt><dd>{rub(scenario.components.telephony)}</dd></div>
            <div><dt>AI-обработка</dt><dd>{rub(scenario.components.ai)}</dd></div>
            <div><dt>Дополнительные номера</dt><dd>{rub(scenario.components.phoneNumbers)}</dd></div>
            <div className="internal-forecast-per-call"><dt>В среднем на звонок</dt><dd>{rub(scenario.averagePerCallRub)}</dd></div>
          </dl>
          <small>Ставки: {rub(scenario.rates.telephonyPerMinute)}/мин · {rub(scenario.rates.aiPerCall)}/звонок</small>
        </article>)}
      </div>
      <div className="internal-forecast-assumptions">{result.assumptions.map((assumption) => <p key={assumption}>{assumption}</p>)}</div>
      <p className="internal-forecast-method">Сценарии построены по фактическим расходам: наилучший — 10-й перцентиль, средний — медиана, наихудший — максимальное наблюдаемое значение. Расчётный месяц — 30 дней.</p>
    </div>}
  </BrutalModal>;
}

function EconomicsAnalyticsView({
  data, loading, error, notice, dates, onDatesChange, onReload, onNotice,
}: {
  data: EconomicsAnalytics | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  dates: { dateFrom: string; dateTo: string };
  onDatesChange: (dates: { dateFrom: string; dateTo: string }) => void;
  onReload: () => Promise<void>;
  onNotice: (notice: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshingBalances, setRefreshingBalances] = useState(false);
  const [technicalExpenseName, setTechnicalExpenseName] = useState('');
  const [technicalExpenseAmount, setTechnicalExpenseAmount] = useState('');
  const [savingTechnicalExpense, setSavingTechnicalExpense] = useState(false);
  const [forecastOpen, setForecastOpen] = useState(false);
  const [companyFilter, setCompanyFilter] = useState('all');
  const [dealershipFilter, setDealershipFilter] = useState('all');
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [companyPage, setCompanyPage] = useState(1);
  const [dealershipPage, setDealershipPage] = useState(1);
  const [callPage, setCallPage] = useState(1);
  const [providerFilter, setProviderFilter] = useState('all');
  const [recentPage, setRecentPage] = useState(1);
  const companyOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const item of data?.calls || []) if (item.companyId) values.set(item.companyId, item.companyName);
    return [...values].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [data?.calls]);
  const dealershipOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const item of data?.calls || []) {
      if (companyFilter !== 'all' && item.companyId === companyFilter && item.dealershipId) values.set(item.dealershipId, item.dealershipName);
    }
    return [...values].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [data?.calls, companyFilter]);
  const employeeOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const item of data?.calls || []) {
      if (companyFilter === 'all' || item.companyId !== companyFilter) continue;
      if (dealershipFilter !== 'all' && item.dealershipId !== dealershipFilter) continue;
      if (item.employeeId) values.set(item.employeeId, item.employeeName);
    }
    return [...values].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [data?.calls, companyFilter, dealershipFilter]);
  const filteredCalls = useMemo(() => (data?.calls || []).filter((item) => {
    if (companyFilter !== 'all' && item.companyId !== companyFilter) return false;
    if (dealershipFilter !== 'all' && item.dealershipId !== dealershipFilter) return false;
    if (employeeFilter !== 'all' && item.employeeId !== employeeFilter) return false;
    return true;
  }), [data?.calls, companyFilter, dealershipFilter, employeeFilter]);
  const filteredDaily = useMemo(() => {
    const amounts = new Map((data?.daily || []).map((item) => [item.date, 0]));
    for (const call of filteredCalls) {
      const key = moscowDateKey(call.occurredAt);
      amounts.set(key, (amounts.get(key) || 0) + call.totalRub);
    }
    return [...amounts].map(([date, amountRub]) => ({ date, amountRub })).sort((a, b) => a.date.localeCompare(b.date));
  }, [data?.daily, filteredCalls]);
  const maxDaily = Math.max(1, ...filteredDaily.map((item) => item.amountRub));
  const filteredCallsTotal = filteredCalls.reduce((sum, item) => sum + item.totalRub, 0);
  const callAverages = useMemo(() => {
    const count = filteredCalls.length;
    const withDuration = filteredCalls.filter((item) => item.durationSec != null && item.durationSec > 0);
    const average = (key: 'telephonyRub' | 'analyticsRub' | 'speechToTextRub' | 'speechSynthesisRub') => count
      ? filteredCalls.reduce((sum, item) => sum + item[key], 0) / count
      : 0;
    return {
      durationSec: withDuration.length ? Math.round(withDuration.reduce((sum, item) => sum + (item.durationSec || 0), 0) / withDuration.length) : null,
      telephonyRub: average('telephonyRub'),
      analyticsRub: average('analyticsRub'),
      speechToTextRub: average('speechToTextRub'),
      speechSynthesisRub: average('speechSynthesisRub'),
    };
  }, [filteredCalls]);
  const filteredCompanies = useMemo(() => {
    const rows = new Map<string, { companyId: string | null; name: string; calls: number; amountRub: number }>();
    for (const call of filteredCalls) {
      const key = call.companyId || 'unassigned';
      const row = rows.get(key) || { companyId: call.companyId, name: call.companyName, calls: 0, amountRub: 0 };
      row.calls += 1;
      row.amountRub += call.totalRub;
      rows.set(key, row);
    }
    return [...rows.values()].map((row) => ({ ...row, avgPerCallRub: row.calls ? row.amountRub / row.calls : 0 })).sort((a, b) => b.amountRub - a.amountRub);
  }, [filteredCalls]);
  const filteredDealerships = useMemo(() => {
    const rows = new Map<string, { dealershipId: string | null; name: string; companyName: string; calls: number; amountRub: number }>();
    for (const call of filteredCalls) {
      const key = call.dealershipId || 'unassigned';
      const row = rows.get(key) || { dealershipId: call.dealershipId, name: call.dealershipName, companyName: call.companyName, calls: 0, amountRub: 0 };
      row.calls += 1;
      row.amountRub += call.totalRub;
      rows.set(key, row);
    }
    return [...rows.values()].map((row) => ({ ...row, avgPerCallRub: row.calls ? row.amountRub / row.calls : 0 })).sort((a, b) => b.amountRub - a.amountRub);
  }, [filteredCalls]);
  const providerOptions = useMemo(() => [...new Set((data?.recent || []).map((item) => item.provider))], [data?.recent]);
  const filteredRecent = useMemo(() => (data?.recent || []).filter((item) => providerFilter === 'all' || item.provider === providerFilter), [data?.recent, providerFilter]);

  useEffect(() => {
    setCompanyPage(1);
    setDealershipPage(1);
    setCallPage(1);
    setRecentPage(1);
  }, [dates.dateFrom, dates.dateTo]);

  async function syncProviders() {
    setSyncing(true);
    onNotice(null);
    try {
      const response = await apiFetch('/api/admin/internal-analytics/economics/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Синхронизация не выполнена.');
      onNotice(`Синхронизировано: звонков Voximplant — ${payload.vox}, транзакций Voximplant — ${payload.voxTransactions ?? 0}, ElevenLabs — ${payload.elevenLabs}, тарифов ProxyAPI — ${payload.tariffs?.models ?? 0}. Ошибок: ${(payload.errors ?? 0) + (payload.tariffs?.errors ?? 0)}.`);
      await onReload();
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : 'Ошибка синхронизации.');
    } finally {
      setSyncing(false);
    }
  }

  async function refreshBalances() {
    setRefreshingBalances(true);
    onNotice(null);
    try {
      const response = await apiFetch('/api/admin/internal-analytics/economics/balances/refresh', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось обновить балансы.');
      onNotice(`Балансы обновлены: ${payload.synced?.length ?? 0}. Пропущено: ${payload.skipped?.length ?? 0}. Ошибок: ${payload.errors?.length ?? 0}.`);
      await onReload();
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : 'Ошибка обновления балансов.');
    } finally {
      setRefreshingBalances(false);
    }
  }

  async function addTechnicalExpense(event: React.FormEvent) {
    event.preventDefault();
    setSavingTechnicalExpense(true);
    onNotice(null);
    try {
      const response = await apiFetch('/api/admin/internal-analytics/economics/technical-expenses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: technicalExpenseName, amountRub: Number(technicalExpenseAmount.replace(',', '.')) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось добавить расход.');
      setTechnicalExpenseName('');
      setTechnicalExpenseAmount('');
      await onReload();
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : 'Ошибка добавления расхода.');
    } finally {
      setSavingTechnicalExpense(false);
    }
  }

  async function removeTechnicalExpense(id: string) {
    onNotice(null);
    try {
      const response = await apiFetch(`/api/admin/internal-analytics/economics/technical-expenses/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось удалить расход.');
      await onReload();
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : 'Ошибка удаления расхода.');
    }
  }

  async function importProxyLogs(file: File) {
    onNotice(null);
    try {
      const ndjson = await file.text();
      const response = await apiFetch('/api/admin/internal-analytics/economics/proxyapi-import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ndjson }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Импорт не выполнен.');
      onNotice(`ProxyAPI: импортировано ${payload.imported}, пропущено ${payload.skipped}.`);
      await onReload();
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : 'Ошибка импорта.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className={`internal-economics ${loading ? 'internal-demo-analytics--loading' : ''}`}>
      <div className="internal-economics-toolbar">
        <button type="button" className="internal-economics-action internal-economics-action--primary" onClick={() => setForecastOpen(true)}>Прогностика</button>
        <button type="button" className="internal-economics-action" onClick={() => inputRef.current?.click()}>Импорт ProxyAPI</button>
        <button type="button" className="internal-economics-action" disabled={syncing} onClick={() => void syncProviders()}>{syncing ? 'Синхронизация…' : 'Синхронизировать'}</button>
        <button type="button" className="internal-economics-action" disabled={refreshingBalances} onClick={() => void refreshBalances()}>{refreshingBalances ? 'Обновляем…' : 'Обновить баланс'}</button>
        <input ref={inputRef} hidden type="file" accept=".ndjson,.jsonl,application/x-ndjson,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProxyLogs(file); }} />
      </div>
      {notice && <div className="internal-activity-note">{notice}</div>}
      {error && <div className="internal-analytics-placeholder internal-analytics-placeholder--error">{error}</div>}
      {!data && loading && <div className="internal-analytics-placeholder">Загружаем экономику…</div>}
      {data && <>
        <section className="internal-balance-grid" aria-label="Балансы сервисов">
          {data.providerBalances.map((item) => {
            const percentLeft = item.limit && item.balance != null ? Math.max(0, Math.min(100, item.balance / item.limit * 100)) : null;
            const provider = data.providers.find((row) => row.provider === item.provider);
            return <article className="internal-balance-card" key={item.provider}>
              <div className="internal-balance-card__heading">
                <span>{providerLabels[item.provider] || item.provider}</span>
                <small>{item.capturedAt ? `Обновлено ${formatDate(item.capturedAt)}` : 'Ожидает синхронизации'}</small>
              </div>
              <strong>{balanceValue(item)}</strong>
              {percentLeft != null && <div className="internal-balance-progress" title={`Осталось ${Math.round(percentLeft)}%`}><i style={{ width: `${percentLeft}%` }} /></div>}
              {item.limit != null && item.used != null && <p>Использовано {compactNumber(item.used)} из {compactNumber(item.limit)}</p>}
              {item.available && item.forecastDays != null
                ? <div className="internal-balance-forecast"><b>Хватит примерно на {compactNumber(item.forecastDays)} дн.</b>{item.forecastUnits != null && <span>≈ {compactNumber(item.forecastUnits)} звонков/тренировок</span>}</div>
                : <div className="internal-balance-forecast internal-balance-forecast--muted">Прогноз появится после накопления расходов</div>}
              <div className="internal-balance-operations"><span>Операций в этом месяце</span><strong>{provider?.events ?? 0}</strong><small>{provider ? `${provider.confirmed} подтверждено · ${rub(provider.amountRub)}` : 'Списаний пока нет'}</small></div>
              {item.resetAt && <small className="internal-balance-reset">Лимит обновится {new Date(item.resetAt).toLocaleDateString('ru-RU')}</small>}
            </article>;
          })}
        </section>
        <div className="internal-section-title"><div><h2>Ежемесячные технические расходы</h2><p>Автоматические списания сервисов и постоянные расходы, которые повторяются каждый месяц</p></div><strong>{rub(data.technicalExpensesTotalRub)}</strong></div>
        <section className="internal-analytics-card internal-technical-expenses">
          <div className="internal-card-heading-row"><div><h2>Технические ежемесячные расходы</h2><p>Системные расходы рассчитываются автоматически, свои сохраняются для следующих месяцев</p></div></div>
          <form className="internal-technical-expense-form" onSubmit={(event) => void addTechnicalExpense(event)}>
            <label><span>Название расхода</span><input required maxLength={120} placeholder="Например, аренда сервера" value={technicalExpenseName} onChange={(event) => setTechnicalExpenseName(event.target.value)} /></label>
            <label><span>Сумма в месяц, ₽</span><input required inputMode="decimal" placeholder="0" value={technicalExpenseAmount} onChange={(event) => setTechnicalExpenseAmount(event.target.value.replace(',', '.'))} /></label>
            <button type="submit" disabled={savingTechnicalExpense}>{savingTechnicalExpense ? 'Добавляем…' : 'Добавить расход'}</button>
          </form>
          <div className="internal-feature-table-wrap internal-technical-expense-table-wrap">
            <table className="internal-feature-table internal-economics-table internal-technical-expense-table">
              <thead><tr><th>Расход</th><th>Источник</th><th>Операций</th><th>В прошлом месяце</th><th>В этом месяце</th><th aria-label="Действия" /></tr></thead>
              <tbody>
                {data.technicalExpenses.map((item) => <tr key={item.id}>
                  <td><strong className="internal-table-primary">{item.name}</strong></td>
                  <td><span className={`internal-technical-expense-source internal-technical-expense-source--${item.source}`}>{item.source === 'custom' ? 'Свой расход' : providerLabels[item.provider || ''] || 'Сервис'}</span></td>
                  <td className="internal-table-number">{item.events ?? '—'}</td>
                  <td className="internal-table-number internal-table-previous">{rub(item.previousMonthAmountRub)}</td>
                  <td className="internal-table-number internal-table-amount">{rub(item.amountRub)}</td>
                  <td className="internal-technical-expense-action">{item.source === 'custom' && <button type="button" onClick={() => void removeTechnicalExpense(item.id)} aria-label={`Удалить ${item.name}`} title="Удалить расход">×</button>}</td>
                </tr>)}
                {data.technicalExpenses.length === 0 && <tr><td colSpan={6} className="internal-table-empty">В текущем месяце технических расходов пока нет.</td></tr>}
              </tbody>
              {data.technicalExpenses.length > 0 && <tfoot><tr><td colSpan={3}>Итого</td><td className="internal-table-number internal-table-previous">{rub(data.technicalExpensesPreviousMonthTotalRub)}</td><td className="internal-table-number internal-table-amount">{rub(data.technicalExpensesTotalRub)}</td><td /></tr></tfoot>}
            </table>
          </div>
        </section>
        <section className="internal-company-economics">
          <div className="internal-company-economics__header">
            <div><h2>Экономика по компаниям</h2><p>Прямые затраты по звонкам за выбранный период</p></div>
            <div className="internal-company-economics__filters">
              <label><span>Дата от</span><input required type="date" value={dates.dateFrom} max={dates.dateTo} onChange={(event) => { if (event.target.value) onDatesChange({ dateFrom: event.target.value, dateTo: dates.dateTo }); }} /></label>
              <label><span>Дата до</span><input required type="date" value={dates.dateTo} min={dates.dateFrom} onChange={(event) => { if (event.target.value) onDatesChange({ dateFrom: dates.dateFrom, dateTo: event.target.value }); }} /></label>
              <label><span>Компания</span><select value={companyFilter} onChange={(event) => { setCompanyFilter(event.target.value); setDealershipFilter('all'); setEmployeeFilter('all'); setCompanyPage(1); setDealershipPage(1); setCallPage(1); }}><option value="all">Все компании</option>{companyOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label><span>Точка</span><select value={dealershipFilter} disabled={companyFilter === 'all'} onChange={(event) => { setDealershipFilter(event.target.value); setEmployeeFilter('all'); setCompanyPage(1); setDealershipPage(1); setCallPage(1); }}><option value="all">Все точки</option>{dealershipOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label><span>Сотрудник</span><select value={employeeFilter} disabled={companyFilter === 'all'} onChange={(event) => { setEmployeeFilter(event.target.value); setCompanyPage(1); setDealershipPage(1); setCallPage(1); }}><option value="all">Все сотрудники</option>{employeeOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            </div>
          </div>
          <section className="internal-metric-grid internal-company-economics__metrics">
            <Metric label="Средняя длительность звонка" value={formatDuration(callAverages.durationSec)} />
            <Metric label="Средняя стоимость звонка" value={rub(callAverages.telephonyRub)} suffix="телефония" />
            <Metric label="Средняя стоимость AI-аналитики" value={rub(callAverages.analyticsRub)} />
            <Metric label="Средняя стоимость распознавания" value={rub(callAverages.speechToTextRub)} />
            <Metric label="Средняя стоимость синтеза речи" value={rub(callAverages.speechSynthesisRub)} />
          </section>
          <section className="internal-analytics-card internal-company-cost-chart">
            <div className="internal-card-heading-row"><div><h2>Расходы по дням</h2><p>{dates.dateFrom} — {dates.dateTo}</p></div><strong>{rub(filteredCallsTotal)}</strong></div>
            <div className="internal-cost-chart">{filteredDaily.map((item) => <div key={item.date} title={`${item.date}: ${rub(item.amountRub)}`}><span>{item.amountRub ? Math.round(item.amountRub) : ''}</span><i style={{ height: `${Math.max(item.amountRub ? 4 : 0, item.amountRub / maxDaily * 100)}%` }} /><small>{item.date.slice(5)}</small></div>)}</div>
          </section>
          <section className="internal-analytics-card internal-economics-table-card">
            <div className="internal-table-heading"><div><h2>По компаниям</h2><p>{filteredCompanies.length} компаний в выборке</p></div></div>
            <div className="internal-feature-table-wrap"><table className="internal-feature-table internal-economics-table"><thead><tr><th>Компания</th><th>Звонков</th><th>Средняя стоимость звонка</th><th>Всего</th></tr></thead><tbody>{pageSlice(filteredCompanies, companyPage).map((item) => <tr key={item.companyId || 'none'}><td><strong className="internal-table-primary">{item.name}</strong></td><td className="internal-table-number">{item.calls}</td><td className="internal-table-number">{rub(item.avgPerCallRub)}</td><td className="internal-table-number internal-table-amount">{rub(item.amountRub)}</td></tr>)}{filteredCompanies.length === 0 && <tr><td colSpan={4} className="internal-table-empty">Нет звонков по выбранным фильтрам</td></tr>}</tbody></table></div>
            <EconomicsPagination page={companyPage} totalItems={filteredCompanies.length} onChange={setCompanyPage} />
          </section>
          <section className="internal-analytics-card internal-economics-table-card">
            <div className="internal-table-heading"><div><h2>По точкам</h2><p>{filteredDealerships.length} точек в выборке</p></div></div>
            <div className="internal-feature-table-wrap"><table className="internal-feature-table internal-economics-table"><thead><tr><th>Точка</th><th>Компания</th><th>Звонков</th><th>Средняя стоимость звонка</th><th>Всего</th></tr></thead><tbody>{pageSlice(filteredDealerships, dealershipPage).map((item) => <tr key={item.dealershipId || 'none'}><td><strong className="internal-table-primary">{item.name}</strong></td><td><span className="internal-table-secondary">{item.companyName}</span></td><td className="internal-table-number">{item.calls}</td><td className="internal-table-number">{rub(item.avgPerCallRub)}</td><td className="internal-table-number internal-table-amount">{rub(item.amountRub)}</td></tr>)}{filteredDealerships.length === 0 && <tr><td colSpan={5} className="internal-table-empty">Нет звонков по выбранным фильтрам</td></tr>}</tbody></table></div>
            <EconomicsPagination page={dealershipPage} totalItems={filteredDealerships.length} onChange={setDealershipPage} />
          </section>
          <section className="internal-analytics-card internal-economics-table-card">
            <div className="internal-table-heading"><div><h2>По звонкам</h2><p>{filteredCalls.length} звонков в выборке</p></div></div>
            <div className="internal-feature-table-wrap"><table className="internal-feature-table internal-economics-table internal-economics-table--calls"><thead><tr><th>Звонок</th><th>Точка / сотрудник</th><th>Длительность</th><th>AI-аналитика</th><th>Распознавание</th><th>Синтез речи</th><th>Телефония</th><th>Прочее</th><th>Итого</th></tr></thead><tbody>{pageSlice(filteredCalls, callPage).map((item) => <tr key={item.callId}><td><a className="internal-call-cost-link" href={`/audits?callId=${encodeURIComponent(item.callId)}`}>{item.callId}</a><small className="internal-table-cell-note">{formatDate(item.occurredAt)}</small></td><td><strong className="internal-table-primary">{item.dealershipName}</strong><small className="internal-table-cell-note">{item.employeeName} · {item.companyName}</small></td><td className="internal-table-number">{formatDuration(item.durationSec)}</td><td className="internal-table-number">{rub(item.analyticsRub)}</td><td className="internal-table-number">{rub(item.speechToTextRub)}</td><td className="internal-table-number">{rub(item.speechSynthesisRub)}</td><td className="internal-table-number">{rub(item.telephonyRub)}</td><td className="internal-table-number">{rub(item.otherRub)}</td><td className="internal-table-number internal-table-amount">{rub(item.totalRub)}</td></tr>)}{filteredCalls.length === 0 && <tr><td colSpan={9} className="internal-table-empty">Нет звонков по выбранным фильтрам</td></tr>}</tbody></table></div>
            <EconomicsPagination page={callPage} totalItems={filteredCalls.length} onChange={setCallPage} />
          </section>
        </section>
        <section className="internal-analytics-card internal-economics-table-card">
          <div className="internal-table-heading">
            <div><h2>Последние списания</h2><p>{filteredRecent.length} операций в выборке</p></div>
            <label><span>Провайдер</span><select value={providerFilter} onChange={(event) => { setProviderFilter(event.target.value); setRecentPage(1); }}><option value="all">Все провайдеры</option>{providerOptions.map((provider) => <option key={provider} value={provider}>{providerLabels[provider] || provider}</option>)}</select></label>
          </div>
          <div className="internal-feature-table-wrap"><table className="internal-feature-table internal-economics-table internal-economics-table--charges"><thead><tr><th>Дата</th><th>Провайдер</th><th>Этап</th><th>Объект</th><th>Компания</th><th>Статус</th><th>Сумма</th></tr></thead><tbody>{pageSlice(filteredRecent, recentPage).map((item) => <tr key={item.id}><td className="internal-table-date">{formatDate(item.occurredAt)}</td><td><span className={`internal-provider-pill internal-provider-pill--${item.provider}`}>{providerLabels[item.provider] || item.provider}</span></td><td>{item.stage === 'account_transaction' ? costCategoryLabels[item.category] || item.category : item.stage || costCategoryLabels[item.category] || item.category}</td><td className="mono">{item.entityId || '—'}</td><td><span className="internal-table-secondary">{item.companyName || '—'}</span></td><td><span className={`internal-status-pill internal-status-pill--${item.status}`}>{item.status === 'confirmed' ? 'Подтверждено' : 'Расчётно'}</span></td><td className="internal-table-number internal-table-amount" title={item.exchangeRateToRub ? `Курс ${item.exchangeRateToRub} на ${item.exchangeRateDate ? new Date(item.exchangeRateDate).toLocaleDateString('ru-RU') : 'дату операции'}` : undefined}>{item.amountRub == null ? `${item.amountOriginal} ${item.currency}` : rub(item.amountRub)}</td></tr>)}{filteredRecent.length === 0 && <tr><td colSpan={7} className="internal-table-empty">Нет списаний выбранного провайдера</td></tr>}</tbody></table></div>
          <EconomicsPagination page={recentPage} totalItems={filteredRecent.length} onChange={setRecentPage} />
        </section>
      </>}
      <CompanyForecastModal open={forecastOpen} onClose={() => setForecastOpen(false)} />
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
