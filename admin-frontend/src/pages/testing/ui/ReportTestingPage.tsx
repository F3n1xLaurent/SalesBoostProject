import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { autoTestingClient } from '../../../shared/api/autoTesting';
import type { RealtimeRegressionRun } from '../../../shared/api/adminPanel';
import { REPORT_BUILTIN_SUITE_ID } from '../../../../../src/testing/reportTestCatalog';
import { autoTestRunSearch, validAutoTestRunId } from '../model/autoTestRunId';
import { RealtimeRegressionPanel } from './RealtimeRegressionPanel';

const client = autoTestingClient('report');
export function ReportTestingPage({ available }: { available: boolean }) {
  const location = useLocation(), navigate = useNavigate();
  const requestedId = new URLSearchParams(location.search).get('runId') || '';
  const [input, setInput] = useState(requestedId), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [opened, setOpened] = useState<RealtimeRegressionRun | null>(null);
  useEffect(() => {
    setInput(requestedId); setError('');
    if (!requestedId) { setOpened(null); return; }
    if (opened?.id === requestedId) return;
    if (!validAutoTestRunId(requestedId)) { setError('Некорректный ID проверки.'); return; }
    const controller = new AbortController(); setOpened(null);
    void client.fetchRun(requestedId, controller.signal).then((run) => { if (!controller.signal.aborted) setOpened(run); }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [requestedId, retry]);
  function selectRun(run: RealtimeRegressionRun) { setOpened(run); navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, run.id, 'report') }); }
  return <>
    <section className="testing-live-overview" aria-label="Встроенный набор отчётов">
      <strong>29 пунктов чеклиста · звонки и тренажёр</strong>
      <p className="sa-meta">12 встроенных сценариев: сильный ответ, спорное распознавание, незакреплённый визит, несколько условий, подмена данных и сложные суммы/названия. Выбирать предыдущие звонки или тренировки не нужно.</p>
      <p className="sa-meta">Используются обычные оценщик и генераторы отчётов. Входной диалог, ожидаемые факты, оценки, «Как лучше» и находки сохраняются для разбора. Звонки не совершаются, статистика сотрудников не меняется.</p>
      <p className="sa-meta">Проверка текстовая: точность ASR по аудио, реальные роли говорящих и подсказка (i) требуют ручной проверки. «Нужно проверить» не означает «пройдено».</p>
    </section>
    <form className="testing-run-lookup" onSubmit={(e) => { e.preventDefault(); if (input.trim()) { setRetry((value) => value + 1); navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, input.trim(), 'report') }); } }}>
      <label htmlFor="report-test-id" className="sa-meta">Открыть автотест отчёта по ID</label>
      <div><input id="report-test-id" className="sa-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ID сохранённого запуска" />
        <button type="submit" className="sa-btn" disabled={!input.trim()}>Открыть</button>{requestedId && <button type="button" className="sa-btn" onClick={() => navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, null, 'report') })}>К последним проверкам</button>}</div>
    </form>
    {error && <p role="alert" className="sa-batch-live-error">{error}</p>}
    {!available && <p className="sa-meta">Для запуска нужен API генерации. Архивные отчёты доступны без нового запуска.</p>}
    {requestedId && opened?.id !== requestedId && !error && <p role="status">Загружаем проверку…</p>}
    {(!requestedId || opened?.id === requestedId) && <RealtimeRegressionPanel key={requestedId || 'latest-report'} target="report" planId={REPORT_BUILTIN_SUITE_ID} model="" disabled={!available} initialRun={requestedId ? opened ?? undefined : undefined} onSelectRun={selectRun} />}
  </>;
}
