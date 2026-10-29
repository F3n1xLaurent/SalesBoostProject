import React, { useEffect, useState } from 'react';
import { cancelRealtimeRegression, compareRealtimeRegressions, fetchRealtimeRegression, fetchRealtimeRegressionHistory, fetchRegressionAudio, startRealtimeRegression,
  type RealtimeRegressionCheck, type RealtimeRegressionRun, type RealtimeRegressionHistory, type RealtimeRegressionSummary,
  type RealtimeRegressionComparison, type RealtimeRegressionSelection } from '../../../shared/api/adminPanel';

const labels = { pass: 'Пройдено', fail: 'Ошибка', review: 'Нужно проверить', not_run: 'Не проверено' };
const dateLabel = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const timingLabel = (value: number | null) => value == null ? '—' : `${value} мс`;
const runLabel = (item: { createdAt: string; model: string }) => `${dateLabel(item.createdAt)} · ${item.model}`;
function Checks({ items, onTest, disabled }: { items: RealtimeRegressionCheck[]; onTest?: (id: string) => void; disabled?: boolean }) {
  return <div style={{ display: 'grid', gap: 8 }}>{items.map((item, index) => <div key={`${item.id}-${index}`} style={{ borderBottom: '1px solid var(--sa-border, #ddd)', padding: '8px 0' }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
      <span><strong style={{ color: item.status === 'fail' ? '#b42318' : item.status === 'pass' ? '#18794e' : 'inherit' }}>{labels[item.status]}</strong> · {item.title}</span>
      {onTest && <button type="button" className="sa-btn" disabled={disabled} onClick={() => onTest(item.id)}>Проверить пункт</button>}
    </div>
    {item.evidence.map((text, i) => <div key={i} className="sa-meta" style={{ marginTop: 4 }}>{text}</div>)}
  </div>)}</div>;
}

function Recording({ runId, caseId }: { runId: string; caseId: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return <div style={{ marginTop: 8 }}>{url ? <audio controls src={url} style={{ width: '100%', maxWidth: 600 }} />
    : <button type="button" className="sa-btn" onClick={() => void fetchRegressionAudio(runId, caseId).then((blob) => setUrl(URL.createObjectURL(blob))).catch((e) => setError(String(e)))}>Прослушать запись</button>}
    {error && <div className="sa-batch-live-error">{error}</div>}</div>;
}

export function RealtimeRegressionPanel({ planId, model, disabled }: { planId: string; model: string; disabled: boolean }) {
  const [run, setRun] = useState<RealtimeRegressionRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<RealtimeRegressionHistory | null>(null);
  const [baselineId, setBaselineId] = useState('');
  const [comparison, setComparison] = useState<RealtimeRegressionComparison | null>(null);
  const [mode, setMode] = useState<'all' | 'checks' | 'scenarios'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const active = busy || run?.status === 'running' || Boolean(history?.items.some((x) => x.status === 'running'));
  const cannotStart = disabled || !planId || active;
  useEffect(() => {
    let disposed = false;
    setRun(null); setHistory(null); setComparison(null); setBaselineId(''); setError(''); setSelected([]);
    if (planId) void fetchRealtimeRegressionHistory(planId).then(async (data) => {
      if (disposed) return;
      setHistory(data);
      if (data.items[0]) {
        const latest = await fetchRealtimeRegression(data.items[0].id);
        if (disposed) return;
        setRun(latest); setBaselineId(latest.parentRunId || data.items[1]?.id || '');
      }
    }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [planId]);
  useEffect(() => {
    if (run?.status !== 'running') return;
    let disposed = false;
    const timer = window.setInterval(() => void fetchRealtimeRegression(run.id).then((data) => {
      if (disposed) return;
      setRun(data);
      if (data.status !== 'running') void fetchRealtimeRegressionHistory(planId).then((next) => { if (!disposed) setHistory(next); }).catch((e) => { if (!disposed) setError(String(e)); });
    }).catch((e) => { if (!disposed) setError(String(e)); }), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
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
      setRun(await fetchRealtimeRegression(item.id));
      setBaselineId(item.parentRunId || history?.items.find((x) => x.id !== item.id && x.createdAt < item.createdAt)?.id || '');
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
      const next = await startRealtimeRegression(planId, model, { referenceRunId: source, ...scope });
      setBaselineId(source || ''); setRun(next); setComparison(null);
      await refreshHistory();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `hypothesis2-${run?.id}.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <div className="sa-companies-table-wrap" style={{ padding: 20 }}>
    <div className="sa-cell-name">Автопроверка гипотезы 2</div>
    <p className="sa-meta">Полная серия или точечная проверка выбранных пунктов. Используются реальные OpenAI и ElevenLabs, расходуется баланс API. Каждый запуск сохраняется отдельно вместе с записью, транскриптом и результатами.</p>
    <label className="sa-meta">Что проверить{' '}
      <select className="sa-input" value={mode} disabled={active} onChange={(event) => { setMode(event.target.value as typeof mode); setSelected([]); }}>
        <option value="all">Все 17 пунктов · 10 сценариев</option>
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
    {run && <p className="sa-meta">Следующий запуск использует профиль и предмет из открытого отчёта, если сохранён их снимок. Модель — выбранная выше; настройки голоса — текущие. У старых отчётов точное совпадение конфигурации проверить нельзя.</p>}
    <details open style={{ marginTop: 18 }}>
      <summary>История тестов{history ? ` · ${history.total}` : ''}</summary>
      <button type="button" className="sa-btn" style={{ marginTop: 8 }} onClick={() => void refreshHistory()}>Обновить историю</button>
      <div style={{ overflowX: 'auto', marginTop: 10 }}><table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
        <thead><tr><th>Запуск, МСК</th><th>Сценарии</th><th>Результаты</th><th>Пауза, медиана</th><th /></tr></thead>
        <tbody>{history?.items.map((item) => <tr key={item.id} style={{ background: item.id === run?.id ? 'var(--sa-bg-secondary, #f5f5f5)' : undefined }}>
          <td style={{ padding: 8 }}>{runLabel(item)}<div className="sa-meta">{item.status === 'running' ? 'Выполняется' : item.status === 'completed' ? 'Завершён' : item.status === 'cancelled' ? 'Остановлен' : 'Ошибка'}</div></td>
          <td>{item.casesCompleted}/{item.casesTotal}</td>
          <td className="sa-meta">Пройдено {item.counts.pass} · ошибок {item.counts.fail} · проверить {item.counts.review} · не запускали {item.counts.not_run}</td>
          <td>{timingLabel(item.timing.medianMs)}</td>
          <td><button type="button" className="sa-btn" disabled={busy || run?.status === 'running'} onClick={() => void open(item)}>Открыть</button></td>
        </tr>)}</tbody>
      </table></div>
      {history?.items.length === 0 && <p className="sa-meta">В этом плане ещё нет сохранённых тестов.</p>}
      {history && history.items.length < history.total && <button type="button" className="sa-btn" onClick={() => void loadMore()}>Показать ещё</button>}
    </details>
    {error && <div className="sa-batch-live-error" style={{ marginTop: 10 }}>{error}</div>}
    {run && <div style={{ marginTop: 18 }}>
      <div className="sa-cell-name">{run.status === 'running' ? 'Выполняется' : run.status === 'completed' ? 'Серия завершена' : run.status === 'cancelled' ? 'Остановлен' : 'Ошибка'} · {run.planName} · {run.model}</div>
      <div className="sa-meta" style={{ marginTop: 6 }}>{run.progress}</div>
      {run.error && <div className="sa-batch-live-error">{run.error}</div>}
      <p className="sa-meta">Тайминги относятся к эмуляции воспроизведения. Телефонную сеть и реальные буферы Voximplant проверяет контрольный звонок. Ударения и естественность голоса оценивайте по записи; женская легенда проверяет текст, голос остаётся из выбранного плана.</p>
      <label className="sa-meta">Сравнить с{' '}
        <select className="sa-input" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
          <option value="">Без сравнения</option>
          {history?.items.filter((x) => x.id !== run.id && x.status !== 'running').map((item) => <option key={item.id} value={item.id}>{runLabel(item)}</option>)}
        </select>
      </label>
      {comparison && <div style={{ marginTop: 14 }}>
        {comparison.warnings.map((warning) => <p className="sa-meta" key={warning}>{warning}</p>)}
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
          <thead><tr><th>Проверка</th><th>Было</th><th>Стало</th><th>Изменение</th><th>Пауза</th></tr></thead>
          <tbody>{comparison.rows.map((row) => <tr key={row.id}>
            <td style={{ padding: 8 }}>{row.title}
              <details className="sa-meta"><summary>Свидетельства</summary>
                <p>Было: {row.before?.evidence.join(' · ') || 'Нет данных'}</p>
                <p>Стало: {row.after?.evidence.join(' · ') || 'Нет данных'}</p>
                <p>Сценарии: {row.coverageBefore.join(', ') || '—'} → {row.coverageAfter.join(', ') || '—'}</p>
              </details>
            </td>
            <td>{row.before ? labels[row.before.status] : 'Не проверено'}</td>
            <td>{row.after ? labels[row.after.status] : 'Не проверено'}</td>
            <td>{{ unchanged: 'Без изменений', fixed: 'Исправлено', regressed: 'Ухудшилось', changed: 'Статус изменился', not_rerun: 'Не перезапускали', new: 'Новая проверка' }[row.change]}{!row.comparable && row.change !== 'not_rerun' ? ' · условия отличаются или не подтверждены' : ''}</td>
            <td className="sa-meta">{timingLabel(row.timingBefore.medianMs)} → {timingLabel(row.timingAfter.medianMs)}{row.medianDeltaMs != null ? ` (${row.medianDeltaMs > 0 ? '+' : ''}${row.medianDeltaMs} мс)` : ''}</td>
          </tr>)}</tbody>
        </table></div>
      </div>}
      <Checks items={run.checklist} onTest={(id) => void start({ checkIds: [id] })} disabled={cannotStart} />
      <div style={{ marginTop: 18 }}>{run.cases.map((item) => <details key={item.id} style={{ padding: '10px 0' }}>
        <summary>{item.title} · {item.status === 'pending' ? 'ожидает' : item.status === 'running' ? 'выполняется' : item.status === 'failed' ? 'ошибка' : 'завершён'}</summary>
        <button type="button" className="sa-btn" disabled={cannotStart} onClick={() => void start({ scenarioIds: [item.id] })}>Повторить сценарий</button>
        {item.error && <div className="sa-batch-live-error">{item.error}</div>}
        <Checks items={item.checks} />
        {item.audioFile && <Recording runId={run.id} caseId={item.id} />}
        {item.session?.transcript.map((turn, index) => <p key={index} className="sa-meta"><strong>{turn.role === 'manager' ? 'Менеджер' : 'AI-клиент'}:</strong> {turn.text}{turn.metrics.interrupted ? ' [прервано]' : ''}</p>)}
      </details>)}</div>
    </div>}
  </div>;
}
