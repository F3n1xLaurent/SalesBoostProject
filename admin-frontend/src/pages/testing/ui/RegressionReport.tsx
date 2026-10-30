import React, { useId, useState, useEffect } from 'react';
import type { RealtimeRegressionCheck, RealtimeRegressionComparison, RealtimeRegressionRun, RealtimeRegressionSelection } from '../../../shared/api/adminPanel';
import { autoTestingClient, fetchCallPlanAutoTestAudio } from '../../../shared/api/autoTesting';
import { TRAINER_TEST_CHECKS } from '../../../../../src/testing/trainerTestCatalog';
import { checkGuidance } from '../model/checkGuidance';
import { checkStatusLabels as labels, countChecks, groupChecks, matchesCheckFilter, timingLabel, type CheckFilter } from '../model/regressionReport';
import { RunIdentity } from './RunIdentity';

function Counts({ items }: { items: RealtimeRegressionCheck[] }) {
  const counts = countChecks(items);
  return <span className="testing-result-counts">{(Object.keys(counts) as Array<keyof typeof counts>).filter((key) => counts[key]).map((key) =>
    <span key={key} className={`testing-result-badge testing-result-badge--${key}`}>{labels[key]}: {counts[key]}</span>)}</span>;
}

export function CheckRows({ items, onTest, disabled, run }: { items: RealtimeRegressionCheck[]; onTest?: (id: string) => void; disabled?: boolean; run?: RealtimeRegressionRun }) {
  const running = new Set(run?.status === 'running' ? run.cases.filter((item) => item.status === 'running').flatMap((item) => item.checks.map((check) => check.id)) : []);
  return <div className="testing-check-rows">{items.map((item) => <details key={item.id} className={`testing-check-row testing-check-row--${item.status}`}>
    <summary><span className="testing-check-row-title">{item.title}</span>
      <span className={`testing-result-badge testing-result-badge--${item.status}`}>{running.has(item.id) && item.status !== 'fail' && item.status !== 'pass' ? 'Проверяется…' : labels[item.status]}</span>
    </summary>
    <div className="testing-check-detail">
      <p className="sa-meta">ID пункта: <code>{item.id}</code>{run && <> · Проверка: <code>{run.id}</code></>}</p>
      {(checkGuidance[item.id] || TRAINER_TEST_CHECKS.find(([id]) => id === item.id)?.[1]) && <p className="sa-meta"><strong>Что проверяем:</strong> {checkGuidance[item.id] || TRAINER_TEST_CHECKS.find(([id]) => id === item.id)?.[1]}</p>}
      <strong className="testing-detail-label">Свидетельства и вывод</strong>
      {item.evidence.length ? <ul className="testing-evidence">{item.evidence.map((text, i) => <li key={i}>{text}</li>)}</ul>
        : <p className="sa-meta">{running.has(item.id) ? 'Сценарий выполняется. Итог появится после проверки свидетельств.' : 'Свидетельств пока нет: пункт ещё не проверен.'}</p>}
      {run && <p className="sa-meta">Сценарии: {run.cases.filter((scenario) => scenario.checks.some((check) => check.id === item.id)).map((scenario) => scenario.title).join(' · ') || 'Не запускались в этой серии'}</p>}
      {onTest && <button type="button" className="sa-btn" disabled={disabled} onClick={() => onTest(item.id)}>Перепроверить только этот пункт</button>}
    </div>
  </details>)}</div>;
}

function Recording({ runId, caseId, target }: { runId: string; caseId: string; target?: 'call_plan' | 'trainer' }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return <div className="testing-recording">{url ? <audio controls src={url} />
    : <button type="button" className="sa-btn" disabled={loading} onClick={() => {
      setLoading(true); setError('');
      const request = target === 'trainer' ? autoTestingClient('trainer').audio(runId, caseId) : fetchCallPlanAutoTestAudio(runId, caseId);
      void request.then((blob) => setUrl(URL.createObjectURL(blob))).catch((e) => setError(String(e))).finally(() => setLoading(false));
    }}>{loading ? 'Загружаем запись…' : 'Прослушать запись'}</button>}
    {error && <div className="sa-batch-live-error">{error}</div>}</div>;
}

const phases = { preparing_audio: 'Подготовка аудио', connecting: 'Подключение', dialogue: 'Диалог', assessing: 'Оценка результатов', completed: 'Готово', failed: 'Ошибка' };
export function ScenarioResults({ run, disabled, onTest }: { run: RealtimeRegressionRun; disabled: boolean; onTest: (selection: RealtimeRegressionSelection) => void }) {
  return <div className="testing-scenario-list">{run.cases.map((item) => <details key={item.id} className="testing-scenario">
    <summary><span className="testing-scenario-title">{item.title}<small>{item.status === 'running' && item.phase ? phases[item.phase] : item.status === 'pending' ? 'Ожидает запуска' : item.status === 'running' ? 'Выполняется' : item.status === 'failed' ? 'Ошибка выполнения' : item.status === 'completed' ? 'Завершён' : item.status}
      {item.step && item.status === 'running' ? ` · шаг ${item.step.current}/${item.step.total}` : ''}</small></span><Counts items={item.checks} /></summary>
    <div className="testing-scenario-content">
      <p className="sa-meta">ID сценария: <code>{item.id}</code></p>
      <button type="button" className="sa-btn" disabled={disabled} onClick={() => onTest({ scenarioIds: [item.id] })}>Повторить сценарий</button>
      {item.error && <div className="sa-batch-live-error">{item.error}</div>}
      {item.audioFile && <Recording runId={run.id} caseId={item.id} target={run.target === 'trainer' ? 'trainer' : 'call_plan'} />}
      <details className="testing-nested-detail"><summary>Проверки сценария · {item.checks.length}</summary><CheckRows items={item.checks} /></details>
      <details className="testing-nested-detail"><summary>Диалог · {item.session?.transcript.length ?? 0} реплик</summary>
        {item.session?.transcript.length ? <div className="testing-transcript">{item.session.transcript.map((turn, index) => <div key={index} className={`testing-transcript-turn testing-transcript-turn--${turn.role}`}>
          <strong>{turn.role === 'manager' ? 'Менеджер' : 'AI-клиент'}</strong><p>{turn.text}{turn.metrics?.interrupted ? ' [прервано]' : ''}</p>
          {run.target === 'trainer' && <small>{Object.entries(turn.metrics ?? {}).filter(([key, value]) => ['sttMs', 'textMs', 'ttsMs', 'totalMs'].includes(key) && typeof value === 'number').map(([key, value]) => `${({ sttMs: 'STT', textMs: 'Текст', ttsMs: 'TTS', totalMs: 'Всего' } as Record<string, string>)[key]}: ${value} мс`).join(' · ')}</small>}
        </div>)}</div> : <p className="sa-meta">Реплик пока нет.</p>}
      </details>
      {Boolean(item.session?.tools.length) && <details className="testing-nested-detail"><summary>Вызовы функций · {item.session?.tools.length}</summary>
        {item.session?.tools.map((tool, index) => <pre key={index} className="testing-tool-event">{JSON.stringify(tool, null, 2)}</pre>)}
      </details>}
    </div>
  </details>)}</div>;
}

const changeLabels = { unchanged: 'Без изменений', fixed: 'Исправлено', regressed: 'Ухудшилось', changed: 'Статус изменился', not_rerun: 'Не перезапускали', new: 'Новая проверка' };
export function ComparisonResults({ comparison }: { comparison: RealtimeRegressionComparison }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const rows = comparison.rows.filter((row) => showUnchanged || row.change !== 'unchanged');
  const fixed = comparison.rows.filter((row) => row.comparable && row.change === 'fixed').length;
  const regressed = comparison.rows.filter((row) => row.comparable && row.change === 'regressed').length;
  return <div className="testing-comparison">
    {comparison.warnings.map((warning) => <p className="testing-report-notice" key={warning}>{warning}</p>)}
    <div className="testing-comparison-heading"><span className="sa-meta">Исправлено: {fixed} · ухудшилось: {regressed}</span>
      <label className="testing-checkbox"><input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />Показать без изменений</label></div>
    {rows.length ? <div className="testing-comparison-table"><table>
      <thead><tr><th>Проверка</th><th>Было → стало</th><th>Изменение</th><th>Пауза</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td><details><summary>{row.title}</summary>
          <p>Было: {row.before?.evidence.join(' · ') || 'Нет данных'}</p><p>Стало: {row.after?.evidence.join(' · ') || 'Нет данных'}</p>
          <p>Сценарии: {row.coverageBefore.join(', ') || '—'} → {row.coverageAfter.join(', ') || '—'}</p>
        </details></td>
        <td>{row.before ? labels[row.before.status] : 'Не проверено'} → {row.after ? labels[row.after.status] : 'Не проверено'}</td>
        <td>{!row.comparable && ['fixed', 'regressed'].includes(row.change) ? 'Статус изменился' : changeLabels[row.change]}{!row.comparable && row.change !== 'not_rerun' && <small>Условия отличаются или не подтверждены</small>}</td>
        <td>{timingLabel(row.timingBefore.medianMs)} → {timingLabel(row.timingAfter.medianMs)}{row.medianDeltaMs != null && <small>{row.medianDeltaMs > 0 ? '+' : ''}{row.medianDeltaMs} мс</small>}</td>
      </tr>)}</tbody>
    </table></div> : <p className="testing-report-empty">Изменений статуса нет. Можно показать все пункты для подробного сравнения.</p>}
  </div>;
}

type Props = {
  run: RealtimeRegressionRun; disabled: boolean; comparison: RealtimeRegressionComparison | null;
  baselineId: string; baselines: Array<{ id: string; label: string }>; onBaselineChange: (id: string) => void;
  onTest: (selection: RealtimeRegressionSelection) => void;
};
export function RegressionReport({ run, disabled, comparison, baselineId, baselines, onBaselineChange, onTest }: Props) {
  const prefix = useId();
  const [view, setView] = useState<'checks' | 'scenarios' | 'comparison'>('checks');
  const [filter, setFilter] = useState<CheckFilter>('all');
  const groups = groupChecks(run.checklist);
  // Only one problem group is expanded initially. Live snapshots don't reset the user's choice.
  const [expanded, setExpanded] = useState<string[]>(() => {
    const first = groups.find((group) => group.items.some((item) => item.status === 'fail'))
      ?? groups.find((group) => group.items.some((item) => item.status === 'review'));
    return first ? [first.id] : [];
  });
  const counts = countChecks(run.checklist);
  const attention = counts.fail + counts.review;
  const visibleGroups = groups.map((group) => ({ ...group, visible: group.items.filter((item) => matchesCheckFilter(item, filter)) })).filter((group) => group.visible.length);
  const allExpanded = visibleGroups.length > 0 && visibleGroups.every((group) => expanded.includes(group.id));
  const selectFilter = (next: CheckFilter) => {
    setFilter(next); setView('checks');
    if (next !== 'all') setExpanded(groups.filter((group) => group.items.some((item) => matchesCheckFilter(item, next))).map((group) => group.id));
  };
  return <section className="testing-report" aria-label="Отчёт автопроверки">
    <div className="testing-report-header"><div><h3>Результаты проверки</h3><p className="sa-meta">{run.planName} · {run.model}</p></div>
      <span className="testing-report-caption">{attention ? `Требуют внимания: ${attention}` : run.status === 'running' ? 'Результаты обновляются' : run.status === 'failed' ? 'Ошибка выполнения' : run.status === 'cancelled' ? 'Проверка остановлена' : counts.not_run || !run.checklist.length ? 'Есть непроверенные пункты' : 'Нет замечаний по проверенным пунктам'}</span></div>
    <RunIdentity key={run.id} id={run.id} target={run.target === 'trainer' ? 'trainer' : 'call_plan'} />
    {run.error && <div className="sa-batch-live-error">{run.error}</div>}
    <div className="testing-report-metrics" aria-label="Фильтр результатов">{([
      ['pass', 'Пройдено', counts.pass], ['fail', 'Ошибки', counts.fail], ['review', 'Нужна проверка', counts.review], ['not_run', 'Не проверено', counts.not_run],
    ] as const).map(([key, label, count]) => <button key={key} type="button" className={`testing-report-metric testing-report-metric--${key}`} aria-pressed={view === 'checks' && filter === key} onClick={() => selectFilter(filter === key ? 'all' : key)}>
      <strong>{count}</strong><span>{label}</span></button>)}</div>
    <nav className="testing-report-nav" aria-label="Разделы отчёта">{([
      ['checks', `Проверки · ${run.checklist.length}`], ['scenarios', `Сценарии · ${run.cases.length}`], ['comparison', 'Сравнение с прошлым тестом'],
    ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</nav>
    <div hidden={view !== 'checks'}>
      <div className="testing-report-toolbar"><div className="testing-report-filters" aria-label="Быстрые фильтры">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => selectFilter('all')}>Все пункты</button>
        <button type="button" aria-pressed={filter === 'attention'} onClick={() => selectFilter('attention')}>Требуют внимания · {attention}</button>
        {!['all', 'attention'].includes(filter) && <span className="sa-meta">Фильтр: {labels[filter as keyof typeof labels]}</span>}
      </div><button type="button" className="testing-text-button" disabled={!visibleGroups.length} onClick={() => setExpanded(allExpanded ? [] : visibleGroups.map((group) => group.id))}>{allExpanded ? 'Свернуть группы' : 'Раскрыть группы'}</button></div>
      <div className="testing-report-groups">{visibleGroups.map((group) => <section key={group.id} className="testing-report-group">
        <button type="button" className="testing-group-heading" aria-expanded={expanded.includes(group.id)} aria-controls={`${prefix}-${group.id}`} onClick={() => setExpanded((old) => old.includes(group.id) ? old.filter((id) => id !== group.id) : [...old, group.id])}>
          <span className="testing-group-chevron" aria-hidden="true">›</span><span className="testing-group-title"><strong>{group.title}</strong><small>{group.description}</small></span><Counts items={group.visible} />
        </button>
        <div id={`${prefix}-${group.id}`} hidden={!expanded.includes(group.id)}><CheckRows items={group.visible} run={run} onTest={(id) => onTest({ checkIds: [id] })} disabled={disabled} /></div>
      </section>)}</div>
      {!visibleGroups.length && <p className="testing-report-empty">{filter === 'attention' ? 'Нет ошибок и пунктов, требующих ручной проверки.' : 'По этому фильтру пунктов нет.'}</p>}
    </div>
    <div hidden={view !== 'scenarios'}><p className="sa-meta">Раскройте сценарий, чтобы послушать запись, посмотреть диалог и вызовы функций.</p><ScenarioResults run={run} disabled={disabled} onTest={onTest} /></div>
    <div hidden={view !== 'comparison'}>
      <label className="testing-baseline">Сравнить с запуском<select className="sa-input" value={baselineId} onChange={(e) => onBaselineChange(e.target.value)}>
        <option value="">Без сравнения</option>{baselineId && !baselines.some((item) => item.id === baselineId) && <option value={baselineId}>Архивный запуск · {baselineId}</option>}{baselines.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      {comparison ? <ComparisonResults key={`${comparison.beforeId}-${comparison.afterId}`} comparison={comparison} /> : <p className="testing-report-empty">{run.status === 'running' ? 'Сравнение появится после завершения проверки.' : baselineId ? 'Загружаем сравнение…' : 'Выберите предыдущий запуск для сравнения результатов.'}</p>}
    </div>
    <details className="testing-report-limitations"><summary>Что учитывает автопроверка и что нужно проверить звонком</summary>
      <p className="sa-meta">{run.target === 'trainer' ? 'Это реальные функции тренажёра с изолированным сохранением. Профили и сценарии встроены, женский профиль выбирается автоматически. Фиксируются фактические TTS-голоса, STT, текст и TTS-тайминги. Воспроизведение в браузере и качество сети не проверяются; пол голоса, ударения и интонация требуют прослушивания.' : 'Тайминги относятся к эмуляции воспроизведения. Телефонную сеть и реальные буферы Voximplant проверяет контрольный звонок. Ударения и естественность голоса оценивайте по записи; женская легенда проверяет текст, голос остаётся из выбранного плана.'}</p>
    </details>
  </section>;
}
