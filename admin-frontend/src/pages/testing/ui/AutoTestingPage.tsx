import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { CallPlanItem, RealtimeRegressionRun } from '../../../shared/api/adminPanel';
import { fetchAutoTestingCatalog, fetchCallPlanAutoTest, type AutoTestingCatalog, type AutoTestingTarget } from '../../../shared/api/autoTesting';
import { RealtimeRegressionPanel } from './RealtimeRegressionPanel';
import { TrainerTestingPage } from './TrainerTestingPage';
import { autoTestRunSearch, validAutoTestRunId } from '../model/autoTestRunId';

export function AutoTestingPage({ plans, loading, holdingId }: { plans: CallPlanItem[]; loading: boolean; holdingId?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryTarget = new URLSearchParams(location.search).get('target');
  const requestedId = queryTarget === 'trainer' ? '' : new URLSearchParams(location.search).get('runId') || '';
  const [lookupId, setLookupId] = useState(requestedId);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [lookup, setLookup] = useState<{ id: string; run?: RealtimeRegressionRun; error?: string } | null>(null);
  const [catalog, setCatalog] = useState<AutoTestingCatalog | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<AutoTestingTarget>(queryTarget === 'trainer' || queryTarget === 'report' ? queryTarget : 'call_plan');
  useEffect(() => { setTarget(queryTarget === 'trainer' || queryTarget === 'report' ? queryTarget : 'call_plan'); }, [queryTarget]);
  const [planId, setPlanId] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetchAutoTestingCatalog(controller.signal).then(setCatalog).catch((error) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, []);
  useEffect(() => { if (!plans.some((item) => item.id === planId)) setPlanId(plans[0]?.id || ''); }, [plans, planId]);
  useEffect(() => {
    setLookupId(requestedId);
    if (!requestedId || lookup?.run?.id === requestedId) return;
    if (!validAutoTestRunId(requestedId)) { setLookup({ id: requestedId, error: 'Некорректный ID проверки.' }); return; }
    const controller = new AbortController();
    setLookup({ id: requestedId });
    void fetchCallPlanAutoTest(requestedId, controller.signal).then((run) => {
      if (!controller.signal.aborted) setLookup({ id: requestedId, run });
    }).catch((error) => {
      if (!controller.signal.aborted) setLookup({ id: requestedId, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [requestedId, lookupAttempt]);
  const openedRun = requestedId && lookup?.id === requestedId ? lookup.run : undefined;
  const lookupError = requestedId && lookup?.id === requestedId ? lookup.error : undefined;
  const effectivePlanId = openedRun?.planId ?? planId;
  const selected = catalog?.targets.find((item) => item.id === target);
  const validPlan = plans.some((item) => item.id === effectivePlanId);
  function selectRun(run: RealtimeRegressionRun) {
    setLookup({ id: run.id, run }); setLookupId(run.id);
    navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, run.id), hash: location.hash });
  }
  return <div className="testing-auto-page">
    <header className="testing-auto-intro">
      <h2>Автотестирование</h2>
      <p className="sa-meta">Проверки до запуска на реальных пользователях: отдельные пункты, полные серии и сравнение результатов между изменениями.</p>
    </header>
    {error && <div role="alert" className="sa-batch-live-error">{error}</div>}
    {!catalog && !error && <p className="sa-meta" role="status">Загружаем доступные направления…</p>}
    <div className="testing-targets" aria-label="Направление автотестирования">
      {catalog?.targets.map((item) => <button key={item.id} type="button" aria-pressed={target === item.id}
        className={`testing-target ${target === item.id ? 'is-selected' : ''}`} onClick={() => { setTarget(item.id); const params = new URLSearchParams(location.search); params.delete('runId'); if (item.id === 'call_plan') params.delete('target'); else params.set('target', item.id); navigate({ pathname: location.pathname, search: `?${params}` }); }}>
        <span className="testing-target-top"><strong>{item.title}</strong><span className="sa-meta">{item.id !== 'report' ? item.available ? 'Доступно' : 'Нужна настройка' : 'Скоро'}</span></span>
        <span className="sa-meta">{item.description}</span>
      </button>)}
    </div>
    {target === 'call_plan' ? <>
      <form className="testing-run-lookup" onSubmit={(event) => {
        event.preventDefault();
        const id = lookupId.trim();
        if (!id) return;
        setLookupAttempt((old) => old + 1);
        navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, id), hash: location.hash });
      }}>
        <label htmlFor="autotest-run-id" className="sa-meta">Открыть сохранённую проверку по ID</label>
        <div><input id="autotest-run-id" className="sa-input" value={lookupId} onChange={(event) => setLookupId(event.target.value)} placeholder="ID запуска из отчёта или истории" autoComplete="off" spellCheck={false} />
          <button className="sa-btn" type="submit" disabled={!lookupId.trim()}>Открыть</button>
          {requestedId && <button className="sa-btn" type="button" onClick={() => { setLookupId(''); navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, null), hash: location.hash }); }}>К последним проверкам</button>}
        </div>
        <p className="sa-meta">Пришлите этот ID для разбора: он связывает результаты, диалоги, тайминги и ошибки одного запуска.</p>
        {requestedId && !openedRun && !lookupError && <p className="sa-meta" role="status">Загружаем проверку {requestedId}…</p>}
        {lookupError && <p role="alert" className="sa-batch-live-error">{lookupError}</p>}
      </form>
      <section className="testing-auto-configuration sa-companies-table-wrap">
        <label htmlFor="autotest-plan" className="sa-meta">План прозвона
          <select id="autotest-plan" className="sa-input" value={openedRun ? effectivePlanId : validPlan ? planId : ''} disabled={loading || !plans.length}
            onChange={(event) => {
              setPlanId(event.target.value);
              if (requestedId) navigate({ pathname: location.pathname, search: autoTestRunSearch(location.search, null), hash: location.hash });
            }}>
            {openedRun && !validPlan && <option value={openedRun.planId}>{openedRun.planName} · сохранённый запуск</option>}
            {!plans.length && !openedRun && <option value="">{loading ? 'Загружаем планы…' : 'В выбранной компании нет планов'}</option>}
            {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
          </select>
        </label>
        {selected?.configuration && <div className="testing-configuration-meta">
          <strong>Текущая основная телефония</strong>
          <span>{selected.configuration.provider === 'openai_realtime' ? 'OpenAI напрямую → ElevenLabs → Voximplant' : selected.configuration.provider}</span>
          <span>Модель: {selected.configuration.model} · Пауза VAD: {selected.configuration.endpointSilenceMs} мс</span>
          <span className="sa-meta">Модель, голос и настройки берутся с сервера и из выбранного плана, не из настроек вкладки «Гипотезы».</span>
        </div>}
        {selected?.configuration?.reason && <div className="sa-batch-live-error">{selected.configuration.reason}</div>}
      </section>
      {openedRun && !validPlan && !loading && <p className="sa-meta">План этого запуска не выбран в текущем фильтре компании или больше недоступен. Отчёт можно просмотреть; для нового теста выберите доступный план.</p>}
      {(!requestedId || openedRun) && <RealtimeRegressionPanel key={`${openedRun?.id || 'latest'}:${effectivePlanId}`} planId={openedRun ? openedRun.planId : validPlan ? planId : ''} model={selected?.configuration?.model || ''}
        initialRun={openedRun} onSelectRun={selectRun} disabled={loading || !validPlan || !selected?.available} />}
    </> : target === 'trainer' ? <TrainerTestingPage available={Boolean(selected?.available)} /> : <section className="testing-placeholder sa-companies-table-wrap">
      <h3>{selected?.title || 'Новое направление'}</h3>
      <p>{selected?.description}</p>
      <p className="sa-meta">Место для отдельного набора сценариев, истории запусков и результатов подготовлено. Сами проверки ещё не реализованы, запуск недоступен.</p>
      <button className="sa-btn" type="button" disabled>Скоро</button>
    </section>}
  </div>;
}
