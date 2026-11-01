import React, { useEffect, useMemo, useState } from 'react';
import { type RealtimeRegressionRun, type RealtimeRegressionHistory, type RealtimeRegressionSummary,
  type RealtimeRegressionComparison, type RealtimeRegressionSelection } from '../../../shared/api/adminPanel';
import { autoTestingClient, watchCallPlanAutoTest,
  type AutoTestingConnection } from '../../../shared/api/autoTesting';
import { timingLabel } from '../model/regressionReport';
import { RegressionReport } from './RegressionReport';
import { RunIdentity } from './RunIdentity';

const dateLabel = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const runLabel = (item: { createdAt: string; model: string }) => `${dateLabel(item.createdAt)} · ${item.model}`;

export function RealtimeRegressionPanel({ planId, model, disabled, initialRun, onSelectRun, target = 'call_plan', femaleSourceId }: {
  planId: string; model: string; disabled: boolean; initialRun?: RealtimeRegressionRun; onSelectRun?: (run: RealtimeRegressionRun) => void;
  target?: 'call_plan' | 'trainer' | 'report'; femaleSourceId?: string;
}) {
  const { fetchRun: fetchRealtimeRegression, history: fetchRealtimeRegressionHistory, compare: compareRealtimeRegressions, cancel: cancelRealtimeRegression, start: startTest } = useMemo(() => autoTestingClient(target), [target]);
  const [run, setRun] = useState<RealtimeRegressionRun | null>(initialRun ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<RealtimeRegressionHistory | null>(null);
  const [baselineId, setBaselineId] = useState('');
  const [comparison, setComparison] = useState<RealtimeRegressionComparison | null>(null);
  const [mode, setMode] = useState<'all' | 'checks' | 'scenarios'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [connection, setConnection] = useState<AutoTestingConnection>('connecting');
  const [historyLoading, setHistoryLoading] = useState(Boolean(planId));
  const active = busy || run?.status === 'running' || Boolean(history?.items.some((x) => x.status === 'running'));
  const cannotStart = disabled || !planId || active || historyLoading;
  useEffect(() => {
    let disposed = false;
    setRun(initialRun ?? null); setHistory(null); setComparison(null); setBaselineId(''); setError(''); setSelected([]);
    setHistoryLoading(Boolean(planId));
    if (planId) void fetchRealtimeRegressionHistory(planId).then(async (data) => {
      if (disposed) return;
      setHistory(data);
      const latestItem = target !== 'call_plan' ? data.items.find((item) => item.planId === planId) : data.items[0];
      if (initialRun || latestItem) {
        const latest = initialRun ?? await fetchRealtimeRegression(latestItem!.id);
        if (disposed) return;
        if (!initialRun) setRun(latest);
        setBaselineId(latest.parentRunId || data.items.find((item) => item.id !== latest.id && item.createdAt < latest.createdAt)?.id || '');
      }
    }).catch((e) => { if (!disposed) setError(String(e)); }).finally(() => { if (!disposed) setHistoryLoading(false); });
    return () => { disposed = true; };
  }, [planId, initialRun]);
  useEffect(() => {
    if (run?.status !== 'running') return;
    let disposed = false;
    const watchedPlanId = run.planId;
    const stop = watchCallPlanAutoTest(run.id, {
      onUpdate: (data) => {
        if (disposed || data.planId !== watchedPlanId) return;
        setRun(data); setError('');
        if (data.status !== 'running') void fetchRealtimeRegressionHistory(planId).then((next) => { if (!disposed) setHistory(next); }).catch((e) => { if (!disposed) setError(String(e)); });
      },
      onConnection: (value) => { if (!disposed) setConnection(value); },
      onError: (error) => { if (!disposed) setError(`Обновления временно недоступны: ${error.message}. Переподключаемся автоматически.`); },
    }, target);
    return () => { disposed = true; stop(); };
  }, [run?.id, run?.status, planId]);
  useEffect(() => {
    let disposed = false; setComparison(null);
    if (baselineId && run && baselineId !== run.id && run.status !== 'running') {
      void compareRealtimeRegressions(baselineId, run.id).then((data) => { if (!disposed) setComparison(data); }).catch((e) => { if (!disposed) setError(String(e)); });
    }
    return () => { disposed = true; };
  }, [baselineId, run?.id, run?.status]);
  async function open(item: RealtimeRegressionSummary) {
    setError('');
    try {
      const selectedRun = await fetchRealtimeRegression(item.id);
      setRun(selectedRun);
      setBaselineId(item.parentRunId || history?.items.find((x) => x.id !== item.id && x.createdAt < item.createdAt)?.id || '');
      onSelectRun?.(selectedRun);
    } catch (e) { setError(String(e)); }
  }
  async function refreshHistory() {
    try { setHistory(await fetchRealtimeRegressionHistory(planId)); }
    catch (e) { setError(String(e)); }
  }
  async function loadMore() {
    if (!history) return;
    try {
      const next = await fetchRealtimeRegressionHistory(planId, history.items.length);
      setHistory({ ...next, items: [...history.items, ...next.items.filter((x) => !history.items.some((old) => old.id === x.id))] });
    } catch (e) { setError(String(e)); }
  }
  async function start(selection?: RealtimeRegressionSelection) {
    setBusy(true); setError('');
    try {
      const scope = selection ?? (mode === 'checks' ? { checkIds: selected } : mode === 'scenarios' ? { scenarioIds: selected } : {});
      const source = run?.planId === planId ? run.id : undefined;
      const next = await startTest(planId, { referenceRunId: source, ...scope }, femaleSourceId);
      setBaselineId(source || ''); setRun(next); setComparison(null);
      await refreshHistory();
      onSelectRun?.(next);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${target}-autotest-${run?.id}.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <div className="sa-companies-table-wrap testing-regression-panel" style={{ padding: 20 }}>
    <div className="sa-cell-name">{target === 'report' ? 'Автопроверка отчётов аналитики' : target === 'trainer' ? 'Автопроверка тренировок' : 'Автопроверка звонка по плану прозвона'}</div>
    <p className="sa-meta">{target === 'report' ? 'Встроенные диалоги проходят через реальные генераторы отчётов звонка и тренажёра. Запросы оценщика и генерации расходуют баланс API, телефония и TTS не используются. Входы и результаты сохраняются для сравнения.' : <>{target === 'trainer' ? 'Встроенные тестовые сценарии и профили: реальные STT, генерация ответа и TTS; без баллов и обычных отчётов сотрудников.' : 'Номер не набирается. Проверяем основную цепочку диалога на голосовых сценариях.'} Реальные OpenAI и ElevenLabs расходуют баланс API. Запуски, записи и результаты сохраняются для сравнения.</>}</p>
    <label className="sa-meta">Что проверить{' '}
      <select className="sa-input" value={mode} disabled={active} onChange={(event) => { setMode(event.target.value as typeof mode); setSelected([]); }}>
        <option value="all">Все {history?.checks.length ?? (target === 'report' ? 29 : target === 'trainer' ? 20 : 17)} пунктов · {history?.scenarios.length ?? (target === 'report' ? 12 : target === 'trainer' ? 7 : 10)} сценариев</option>
        <option value="checks">Выбранные пункты чеклиста</option>
        <option value="scenarios">Отдельные сценарии</option>
      </select>
    </label>
    {mode !== 'all' && <div style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
      {(mode === 'checks' ? history?.checks : history?.scenarios)?.map((item) => <label key={item.id} style={{ display: 'flex', gap: 8 }}>
        <input type="checkbox" checked={selected.includes(item.id)} disabled={active} onChange={(event) => setSelected((old) => event.target.checked ? [...old, item.id] : old.filter((x) => x !== item.id))} />
        {item.title}{'scenarioIds' in item ? ` · сценариев: ${item.scenarioIds.length}` : ''}
      </label>)}
    </div>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <button type="button" className="sa-btn-brutal-3d" disabled={cannotStart || (mode !== 'all' && !selected.length)} onClick={() => void start()}>{busy ? 'Подготовка…' : mode === 'all' ? 'Запустить всю серию' : 'Проверить выбранное'}</button>
      {run && <button type="button" className="sa-btn" disabled={cannotStart} onClick={() => void start({ scenarioIds: run.cases.map((x) => x.id) })}>Повторить этот тест</button>}
      {run?.status === 'running' && <button type="button" className="sa-btn" onClick={() => void cancelRealtimeRegression(run.id).catch((e) => setError(String(e)))}>Остановить</button>}
      {run && <button type="button" className="sa-btn" onClick={download}>Скачать отчёт</button>}
    </div>
    {run && <p className="sa-meta">{target === 'report' ? 'Новый запуск — текущий код генераторов и новая оценка встроенных диалогов. Предыдущий результат не перезаписывается. Остановка — после текущего запроса генерации.' : target === 'trainer' ? 'Следующий запуск проверит встроенный набор текущим кодом тренажёра. История тренировок сотрудников не используется и не изменяется.' : `Следующий запуск проверит текущую конфигурацию плана и серверную модель ${model}. Различия условий будут отмечены при сравнении. Старые тесты гипотезы остаются в истории.`}</p>}
    {run && <section className="testing-live-overview" aria-label="Ход автотестирования">
      <div className="testing-live-heading"><strong>{run.status === 'running' ? 'Проверка выполняется' : run.status === 'completed' ? 'Серия завершена' : run.status === 'cancelled' ? 'Остановлено' : 'Ошибка выполнения'}</strong>
        {run.status === 'running' && <span className={`testing-live-connection testing-live-connection--${connection}`} role="status">{connection === 'live' ? '● WebSocket · в реальном времени' : connection === 'polling' ? '● Резервное обновление · переподключаемся' : 'Подключаем живые обновления…'}</span>}
      </div>
      <div className="testing-live-progress" role="progressbar" aria-label="Завершённые сценарии" aria-valuemin={0} aria-valuemax={run.cases.length}
        aria-valuenow={run.cases.filter((item) => ['completed', 'failed'].includes(item.status)).length}>
        <span style={{ width: `${run.cases.length ? run.cases.filter((item) => ['completed', 'failed'].includes(item.status)).length / run.cases.length * 100 : 0}%` }} />
      </div>
      <div className="testing-live-counts">
        <span>Сценарии: {run.cases.filter((item) => ['completed', 'failed'].includes(item.status)).length}/{run.cases.length}</span>
      </div>
      <p className="sa-meta" aria-live="polite">{run.progress}</p>
      {run.target !== 'call_plan' && run.target !== 'trainer' && run.target !== 'report' && <p className="sa-meta">Архивный запуск гипотезы. Новые запуски выполняются в контуре основной телефонии.</p>}
    </section>}
    {error && <div className="sa-batch-live-error" style={{ marginTop: 10 }}>{error}</div>}
    {run && <RegressionReport key={run.id} run={run} disabled={cannotStart} comparison={comparison} baselineId={baselineId}
      baselines={history?.items.filter((x) => x.id !== run.id && x.status !== 'running').map((item) => ({ id: item.id, label: runLabel(item) })) ?? []}
      onBaselineChange={setBaselineId} onTest={(selection) => void start(selection)} />}
    <details className="testing-report-history" style={{ marginTop: 18 }}>
      <summary>История тестов{history ? ` · ${history.total}` : ''}</summary>
      {historyLoading && <p className="sa-meta" role="status">Загружаем историю запусков…</p>}
      <button type="button" className="sa-btn" style={{ marginTop: 8 }} onClick={() => void refreshHistory()}>Обновить историю</button>
      <div style={{ overflowX: 'auto', marginTop: 10 }}><table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
        <thead><tr><th>Запуск, МСК</th><th>Сценарии</th><th>Результаты</th><th>{target === 'report' ? 'Генерация отчёта, медиана' : target === 'trainer' ? 'Ответ, медиана' : 'Пауза, медиана'}</th><th /></tr></thead>
        <tbody>{history?.items.map((item) => <tr key={item.id} style={{ background: item.id === run?.id ? 'var(--sa-bg-secondary, #f5f5f5)' : undefined }}>
          <td style={{ padding: 8 }}>{runLabel(item)}<div className="sa-meta">{item.status === 'running' ? 'Выполняется' : item.status === 'completed' ? 'Завершён' : item.status === 'cancelled' ? 'Остановлен' : 'Ошибка'} · {item.target === 'report' ? 'Отчёты' : item.target === 'trainer' ? 'Тренажёр' : item.target === 'call_plan' ? 'Основная телефония' : 'Архив гипотезы'}</div><RunIdentity id={item.id} target={target} compact /></td>
          <td>{item.casesCompleted}/{item.casesTotal}</td>
          <td className="sa-meta">Пройдено {item.counts.pass} · ошибок {item.counts.fail} · проверить {item.counts.review} · не запускали {item.counts.not_run}</td>
          <td>{timingLabel(item.timing.medianMs)}</td>
          <td><button type="button" className="sa-btn" disabled={busy || run?.status === 'running'} onClick={() => void open(item)}>Открыть</button></td>
        </tr>)}</tbody>
      </table></div>
      {history?.items.length === 0 && <p className="sa-meta">В этом разделе ещё нет сохранённых тестов.</p>}
      {history && history.items.length < history.total && <button type="button" className="sa-btn" onClick={() => void loadMore()}>Показать ещё</button>}
    </details>
  </div>;
}
