import { apiFetch } from '../../entities/session';
import type { RealtimeRegressionRun, RealtimeRegressionSelection, RealtimeRegressionHistory, RealtimeRegressionComparison } from './adminPanel';

export type AutoTestingTarget = 'call_plan' | 'report' | 'trainer';
export type AutoTestingConfiguration = {
  provider: string; model: string; endpointSilenceMs: number; longTurnSilenceMs: number;
  transcriptionModel: string; voiceSource: string; available: boolean; reason: string | null;
};
export type AutoTestingCatalog = { targets: Array<{
  id: AutoTestingTarget; title: string; description: string; available: boolean; configuration?: AutoTestingConfiguration;
}> };
const ROOT = '/api/admin/auto-testing';
export const CALL_PLAN_RUNS = `${ROOT}/call-plan/runs`;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос автотестирования.');
  return data;
}
export function fetchAutoTestingCatalog(signal?: AbortSignal): Promise<AutoTestingCatalog> {
  return json(`${ROOT}/catalog`, { signal });
}
export function startCallPlanAutoTest(planId: string, selection: RealtimeRegressionSelection = {}): Promise<RealtimeRegressionRun> {
  return json(CALL_PLAN_RUNS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId, ...selection }) });
}
export function fetchCallPlanAutoTest(id: string, signal?: AbortSignal): Promise<RealtimeRegressionRun> {
  return json(`${CALL_PLAN_RUNS}/${encodeURIComponent(id)}`, { signal });
}
export function fetchCallPlanAutoTestHistory(planId: string, offset = 0): Promise<RealtimeRegressionHistory> {
  return json(`${CALL_PLAN_RUNS}?${new URLSearchParams({ planId, offset: String(offset) })}`);
}
export function compareCallPlanAutoTests(before: string, after: string): Promise<RealtimeRegressionComparison> {
  return json(`${CALL_PLAN_RUNS}/${encodeURIComponent(before)}/compare?${new URLSearchParams({ against: after })}`);
}
export async function cancelCallPlanAutoTest(id: string): Promise<void> {
  await json(`${CALL_PLAN_RUNS}/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}
export async function fetchCallPlanAutoTestAudio(runId: string, caseId: string): Promise<Blob> {
  const response = await apiFetch(`${CALL_PLAN_RUNS}/${encodeURIComponent(runId)}/audio/${encodeURIComponent(caseId)}`);
  if (!response.ok) throw new Error('Не удалось загрузить запись теста.');
  return response.blob();
}

export type AutoTestingConnection = 'connecting' | 'live' | 'polling';
export type TrainerTestSource = { id: string; name: string; companyId: string | null; female: boolean };
export function fetchTrainerTestSources(holdingId?: string, signal?: AbortSignal): Promise<{ items: TrainerTestSource[] }> {
  return json(`${ROOT}/trainer/sources${holdingId ? `?${new URLSearchParams({ holdingId })}` : ''}`, { signal });
}
export function autoTestingClient(target: 'call_plan' | 'trainer' = 'call_plan') {
  const root = target === 'trainer' ? `${ROOT}/trainer/runs` : CALL_PLAN_RUNS;
  return {
    fetchRun: (id: string, signal?: AbortSignal) => json<RealtimeRegressionRun>(`${root}/${encodeURIComponent(id)}`, { signal }),
    history: (sourceId: string, offset = 0) => json<RealtimeRegressionHistory>(`${root}?${new URLSearchParams(target === 'trainer' ? { offset: String(offset) } : { planId: sourceId, offset: String(offset) })}`),
    compare: (before: string, after: string) => json<RealtimeRegressionComparison>(`${root}/${encodeURIComponent(before)}/compare?${new URLSearchParams({ against: after })}`),
    cancel: (id: string) => json(`${root}/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    start: (sourceId: string, selection: RealtimeRegressionSelection, femaleSourceId?: string) => json<RealtimeRegressionRun>(root, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [target === 'trainer' ? 'sourceId' : 'planId']: sourceId, ...selection, ...(target === 'trainer' && femaleSourceId ? { femaleSourceId } : {}) }) }),
    audio: async (id: string, caseId: string) => { const response = await apiFetch(`${root}/${encodeURIComponent(id)}/audio/${encodeURIComponent(caseId)}`); if (!response.ok) throw new Error('Не удалось загрузить запись теста.'); return response.blob(); },
  };
}
/** Snapshot on connect/reconnect; polling fallback when WebSockets are unavailable. */
export function watchCallPlanAutoTest(id: string, callbacks: {
  onUpdate: (run: RealtimeRegressionRun) => void;
  onConnection: (connection: AutoTestingConnection) => void;
  onError?: (error: Error) => void;
}, target: 'call_plan' | 'trainer' = 'call_plan'): () => void {
  const root = target === 'trainer' ? `${ROOT}/trainer/runs` : CALL_PLAN_RUNS;
  const controller = new AbortController();
  let stopped = false;
  let connected = false;
  let socket: WebSocket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let openingDeadline: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
  const accept = (run: RealtimeRegressionRun) => {
    if (stopped || run.id !== id || !['running', 'completed', 'failed', 'cancelled'].includes(run.status)
      || !Array.isArray(run.cases) || !Array.isArray(run.checklist)) return;
    callbacks.onUpdate(run);
    if (run.status !== 'running') stop();
  };
  async function poll() {
    if (stopped || connected || polling) return;
    polling = true;
    try {
      const run = target === 'trainer' ? await autoTestingClient(target).fetchRun(id, signal()) : await fetchCallPlanAutoTest(id, signal());
      if (!connected) accept(run);
    } catch (error) {
      if (!stopped) callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally { polling = false; }
  }
  async function connect() {
    if (stopped) return;
    callbacks.onConnection('connecting');
    try {
      const result = await json<{ ticket: string }>(`${root}/${encodeURIComponent(id)}/live-ticket`, { method: 'POST', signal: signal() });
      if (stopped) return;
      const url = new URL(`${root}/${encodeURIComponent(id)}/live`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', result.ticket);
      const ws = new WebSocket(url);
      socket = ws;
      openingDeadline = setTimeout(() => ws.close(), 5000);
      ws.onopen = () => { if (!stopped) { clearTimeout(openingDeadline); connected = true; callbacks.onConnection('live'); } };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'run.snapshot' && message.target === target && message.run?.id === id) accept(message.run);
        } catch { /* Ignore malformed/unknown events, keep the last valid snapshot. */ }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        clearTimeout(openingDeadline);
        connected = false;
        if (!stopped) { callbacks.onConnection('polling'); void poll(); reconnect = setTimeout(() => { void connect(); }, 2500); }
      };
    } catch (error) {
      if (stopped) return;
      callbacks.onConnection('polling');
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      void poll();
      reconnect = setTimeout(() => { void connect(); }, 5000);
    }
  }
  const interval = setInterval(() => { void poll(); }, 3000);
  function stop() {
    if (stopped) return;
    stopped = true; controller.abort(); clearInterval(interval);
    clearTimeout(reconnect); clearTimeout(openingDeadline);
    socket?.close();
  }
  void connect();
  return stop;
}
