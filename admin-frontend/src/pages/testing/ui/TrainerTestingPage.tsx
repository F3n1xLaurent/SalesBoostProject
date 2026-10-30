import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { autoTestingClient } from '../../../shared/api/autoTesting';
import { TRAINER_BUILTIN_SUITE_ID } from '../../../../../src/testing/trainerBuiltinFixtures';
import type { RealtimeRegressionRun } from '../../../shared/api/adminPanel';
import { autoTestRunSearch, validAutoTestRunId } from '../model/autoTestRunId';
import { RealtimeRegressionPanel } from './RealtimeRegressionPanel';

const client = autoTestingClient('trainer');
export function TrainerTestingPage({ available }: { available: boolean }) {
  const location = useLocation(), navigate = useNavigate();
  const requestedId = new URLSearchParams(location.search).get('runId') || '';
  const [input, setInput] = useState(requestedId);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<RealtimeRegressionRun | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setInput(requestedId); setError('');
    if (!requestedId) { setOpened(null); return; }
    if (opened?.id === requestedId) return;
    if (!validAutoTestRunId(requestedId)) { setError('Некорректный ID проверки.'); return; }
    const controller = new AbortController(); setOpened(null);
    void client.fetchRun(requestedId, controller.signal).then((run) => { if (!controller.signal.aborted) setOpened(run); }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [requestedId, retry]);
  function selectRun(run: RealtimeRegressionRun) { setOpened(run); navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, run.id, 'trainer') }); }
  const effectiveSource = requestedId && opened?.id === requestedId ? opened.planId : TRAINER_BUILTIN_SUITE_ID;
  const legacy = Boolean(requestedId && opened?.id === requestedId && opened.planId !== TRAINER_BUILTIN_SUITE_ID);
  return <>
    <section className="testing-live-overview" aria-label="Встроенный набор тренировок">
      <strong>Готовый тестовый набор</strong>
      <p className="sa-meta">Сценарий покупки автомобиля, легенды и профили «Скептик», «Сомневающаяся» и «Болтун» заданы в коде. Женский профиль подключается автоматически. Создавать или выбирать предыдущие тренировки не нужно.</p>
      <p className="sa-meta">Тестовые данные одинаковы для всех компаний. Голоса автоматически берутся из настроенного каталога; при отсутствии подходящего используются стандартные мужской и женский голоса тренажёра. Обрабатывает сообщения тот же механизм, что в обычной тренировке.</p>
    </section>
    <form className="testing-run-lookup" onSubmit={(e) => { e.preventDefault(); if (input.trim()) { setRetry((value) => value + 1); navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, input.trim(), 'trainer') }); } }}>
      <label htmlFor="trainer-test-id" className="sa-meta">Открыть автотест тренировки по ID</label><div><input id="trainer-test-id" className="sa-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ID сохранённого запуска" />
        <button type="submit" className="sa-btn" disabled={!input.trim()}>Открыть</button>{requestedId && <button type="button" className="sa-btn" onClick={() => navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, null, 'trainer') })}>К последним проверкам</button>}</div>
    </form>
    {error && <p role="alert" className="sa-batch-live-error">{error}</p>}
    {legacy && <p className="sa-meta">Архивная проверка по тренировке-образцу доступна для просмотра и сравнения. Чтобы запустить новый встроенный набор, нажмите «К последним проверкам».</p>}
    {!available && <p className="sa-meta">Для запуска нужны настроенные API генерации, STT и TTS. Сохранённые отчёты доступны для просмотра.</p>}
    {requestedId && opened?.id !== requestedId && !error && <p role="status">Загружаем проверку…</p>}
    {(!requestedId || opened?.id === requestedId) && <RealtimeRegressionPanel key={`${requestedId || 'latest'}:${effectiveSource}`} target="trainer" planId={effectiveSource} model="" disabled={!available || legacy} initialRun={requestedId ? opened ?? undefined : undefined} onSelectRun={selectRun} />}
  </>;
}
