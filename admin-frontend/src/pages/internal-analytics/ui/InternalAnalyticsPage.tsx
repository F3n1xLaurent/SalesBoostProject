import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../entities/session';
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

const outcomeLabels: Record<string, string> = {
  completed: 'Завершён', disconnected: 'Завершён', no_answer: 'Нет ответа', busy: 'Занято',
  failed: 'Ошибка', error: 'Ошибка', processing: 'Обработка', cancelled: 'Отменён',
};

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function InternalAnalyticsPage() {
  const [tab, setTab] = useState<'demo' | 'activity'>('demo');
  const [filters, setFilters] = useState({ q: '', minDuration: '', maxDuration: '', minScore: '', maxScore: '', dateFrom: '', dateTo: '' });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [data, setData] = useState<DemoAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activityPeriod, setActivityPeriod] = useState<7 | 30 | 90>(30);
  const [activityData, setActivityData] = useState<ActivityAnalytics | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

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
        <button type="button" role="tab" aria-selected={tab === 'demo'} className={`sa-dialog-tab ${tab === 'demo' ? 'sa-dialog-tab-active' : ''}`} onClick={() => setTab('demo')}>Демо-стенд</button>
        <button type="button" role="tab" aria-selected={tab === 'activity'} className={`sa-dialog-tab ${tab === 'activity' ? 'sa-dialog-tab-active' : ''}`} onClick={() => setTab('activity')}>Активность</button>
      </div>

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
                <tbody>{data.recentCalls.map((call) => <tr key={call.id} title={call.error || undefined}>
                  <td>{formatDate(call.startedAt)}</td><td className="mono">{call.ipAddress || '—'}</td><td>{call.phone}{call.ivrDetected && <span className="sa-ivr-badge" style={{ marginLeft: 6 }}>IVR{call.ivrPath.length > 0 ? ` (${call.ivrPath.join('-')})` : ''}</span>}</td>
                  <td><span className={`internal-outcome internal-outcome--${call.outcome}`}>{outcomeLabels[call.outcome] || call.outcome}</span></td>
                  <td>{formatDuration(call.durationSec)}</td><td>{call.totalScore == null ? '—' : `${Math.round(call.totalScore)}/100`}</td>
                </tr>)}{data.recentCalls.length === 0 && <tr><td colSpan={6} className="internal-calls-empty">По заданным фильтрам звонки не найдены.</td></tr>}</tbody>
              </table>
            </div>
          </section>
        </div>
      )}
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

function StatRow({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
