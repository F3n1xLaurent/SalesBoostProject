import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { apiFetch } from '../../../entities/session';

type Event = { seq: number; event: string; turn: number; ms: number; at?: string; text?: string; latency_ms?: number | null; [key: string]: unknown };
type Message = { id: string; role: string; text: string; turn: number; ms: number; status: string; source: string; replyReference?: unknown };
type Run = { id: string; diagnosticId: string; model: string; ttsModel: string; status: string; finalized?: boolean; createdAt: number;
  events?: Event[]; transcript?: Message[]; limitations?: string[]; summary?: unknown; configuration?: unknown; callState?: unknown; eventCount: number };
type Page = { run: Run; events: Event[]; nextCursor: number; hasMore: boolean };
const terminal = new Set(['failed', 'disconnected', 'busy', 'no_answer', 'interrupted', 'unknown']);
const validId = /^(?:pc-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const canonical = (id: string) => id.replace(/^pc-/u, '').toLowerCase();
const labels: Record<string, string> = {
  user_transcript: 'Собеседник', assistant_response: 'Ответ агента', assistant_partial: 'Агент — генерация',
  reply_reference: 'Предыдущий вопрос и пауза', response_requested: 'Запрос к модели и контекст', context_before_request: 'Контекст перед запросом',
  provider_item_deleted: 'Удаление из контекста', provider_response_cancel: 'Отмена ответа',
  smart_turn_decision: 'Решение Smart Turn', turn_committed: 'Реплика передана модели', provider_audio_commit: 'Аудиобуфер отправлен',
  speech_start: 'Начало речи', speech_end: 'Конец речи', stt_partial: 'Промежуточная расшифровка', stt_ms: 'Задержка STT',
  llm_first_text_ms: 'Первый текст LLM', tts_first_audio_ms: 'Первое аудио TTS', speech_to_playback_ms: 'Конец речи → воспроизведение',
  pipeline_error: 'Ошибка пайплайна', provider_error: 'Ошибка провайдера', audio_window: 'Состояние аудиопотока',
  playback_callback: 'Подтверждение Voximplant', session_ended: 'Звонок завершён', pipeline_configuration: 'Промпт и настройки',
  response_first_text_ms: 'LLM: запрос → первый текст этого ответа', response_total_ms: 'LLM: полная генерация этого ответа',
  response_tts_first_audio_ms: 'TTS: первый текст → аудио этого ответа', closing_existing_response_selected: 'Завершаем уже озвучиваемую реплику',
  interrupted_context_repaired: 'Контекст прерванной озвучки исправлен', response_phone_confirmed: 'Ответ воспроизведён',
  tts_ready: 'Рабочее соединение TTS подготовлено', tts_ready_connection_reused: 'Использовано подготовленное соединение TTS',
  closing_decision: 'Проверка условий завершения', closing_denied: 'Завершение пока запрещено', memory_fact: 'Факт с цитатой',
};
async function request<T>(path: string): Promise<T> {
  const response = await apiFetch('/api/admin/realtime-test/pipecat' + path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить журнал.');
  return body;
}
function Data({ value, label = 'Все поля события' }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(e) => setOpen(e.currentTarget.open)}><summary>{label}</summary>{open &&
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 400, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(value, null, 2)}</pre>}</details>;
}
export function PipecatDiagnosticsPanel({ initialId }: { initialId?: string }) {
  const location = useLocation(); const navigate = useNavigate();
  const [run, setRun] = useState<Run | null>(null); const [events, setEvents] = useState<Event[]>([]);
  const [history, setHistory] = useState<Run[]>([]); const [lookup, setLookup] = useState('');
  const [search, setSearch] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const selected = useRef(''); const cursor = useRef(0);
  async function load(id: string, remember = true) {
    id = id.trim(); if (!validId.test(id)) { setError('Введите ID pc-… или UUID звонка.'); return; }
    id = canonical(id); selected.current = id; setError('');
    try {
      const next = await request<Run>(`/calls/${id}`);
      if (selected.current !== id) return;
      setRun(next); setEvents(next.events || []); cursor.current = Math.max(0, ...(next.events || []).map((event) => event.seq));
      setLookup(next.diagnosticId || `pc-${id}`); setSearch('');
      if (remember) {
        localStorage.setItem('salesboost:pipecat:lastDiagnosticId', `pc-${id}`);
        const params = new URLSearchParams(location.search); params.set('pipecatRun', `pc-${id}`);
        navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Журнал не найден.'); }
  }
  useEffect(() => { if (initialId && canonical(initialId) !== selected.current) void load(initialId); }, [initialId]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('pipecatRun') || localStorage.getItem('salesboost:pipecat:lastDiagnosticId');
    if (id && validId.test(id) && canonical(id) !== selected.current) void load(id, false);
  }, [location.search]);
  useEffect(() => {
    let cancelled = false;
    request<{ runs: Run[] }>('/history').then((body) => { if (!cancelled) setHistory(body.runs); }).catch(() => {});
    return () => { cancelled = true; };
  }, [run?.id, run?.status]);
  useEffect(() => {
    if (!run || (terminal.has(run.status) && run.finalized !== false)) return;
    let cancelled = false; let pending = false;
    const timer = window.setInterval(async () => {
      if (pending) return; pending = true;
      try {
        const page = await request<Page>(`/calls/${run.id}/diagnostics?after=${cursor.current}`);
        if (cancelled || selected.current !== run.id) return;
        cursor.current = page.nextCursor;
        setRun((old) => ({ ...old, ...page.run, finalized: page.hasMore ? false : page.run.finalized }));
        setEvents((old) => { const seen = new Set(old.map((event) => event.seq)); return [...old, ...page.events.filter((event) => !seen.has(event.seq))]; });
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Ошибка журнала.'); }
      finally { pending = false; }
    }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [run?.id, run?.status, run?.finalized]);
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('Скопировано'); } catch { setError('Не удалось скопировать автоматически — ID можно выделить вручную.'); }
  }
  async function download() {
    if (!run) return;
    try {
      const data = await request<unknown>(`/calls/${run.id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `${run.diagnosticId || run.id}.json`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка экспорта.'); }
  }
  const filtered = search.trim() ? events.filter((event) => JSON.stringify(event).toLowerCase().includes(search.toLowerCase()) || (labels[event.event] || '').toLowerCase().includes(search.toLowerCase())) : events;
  return <section style={{ marginTop: 20 }}>
    <h3>Журнал и история звонков</h3>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
      <label>ID журнала<input className="sa-input" placeholder="pc-… или UUID звонка" value={lookup} onChange={(e) => setLookup(e.target.value)} /></label>
      <button className="sa-btn" type="button" onClick={() => void load(lookup)}>Открыть журнал</button>
      <label>Последние звонки<select className="sa-input" value={run?.id || ''} onChange={(e) => { if (e.target.value) void load(e.target.value); }}>
        <option value="">Выберите журнал</option>{history.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt * 1000).toLocaleString('ru-RU')} · {item.model} · {item.status} · {item.diagnosticId}</option>)}
      </select></label>
    </div>
    {error && <p role="alert">{error}</p>}
    {run && <>
      <p><strong>ID для анализа: <code>{run.diagnosticId || `pc-${run.id}`}</code></strong></p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="sa-btn" type="button" onClick={() => void copy(run.diagnosticId || `pc-${run.id}`)}>Скопировать ID</button>
        <button className="sa-btn" type="button" onClick={() => void copy(`${window.location.origin}/testing?pipecatRun=${encodeURIComponent(run.diagnosticId || run.id)}`)}>Скопировать ссылку</button>
        <button className="sa-btn" type="button" onClick={() => void download()}>Скачать полный JSON</button><span role="status">{notice}</span>
      </div>
      <p>{run.model} + {run.ttsModel} · {run.status} · {run.eventCount} событий. Пришлите ID для разбора пауз, контекста и задержек.</p>
      {run.limitations?.map((note) => <p className="sa-batch-live-warning" key={note}>{note}</p>)}
      <h3>Диалог</h3>
      {!run.transcript?.length && <p className="sa-meta">Распознанных реплик пока нет.</p>}
      {run.transcript?.filter((message) => message.source !== 'playout_words').map((message) => <div key={message.id} style={{ padding: '10px 0', borderBottom: '1px solid #ddd' }}>
        <span className="sa-meta">{(message.ms / 1000).toFixed(2)} с · реплика {message.turn} · {message.role === 'user' ? 'Собеседник' : 'Агент'} · {message.status}</span>
        <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{message.text}</p>
        {message.replyReference && <Data value={message.replyReference} label="Предыдущий вопрос и пауза перед ответом" />}
      </div>)}
      <Data value={run.summary} label="Задержки, ошибки и удаления контекста" />
      {run.callState && <Data value={run.callState} label="Память и состояние разговора" />}
      {run.configuration && <Data value={run.configuration} label="Настройки и исходный промпт" />}
      <h3>Полный журнал</h3>
      <label>Поиск по событию, тексту или response ID<input className="sa-input" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <p className="sa-meta">Показано {filtered.length} из {events.length} загруженных событий. Время — от начала звонка. Все поля, UTC-время и контекст доступны в деталях события и JSON.</p>
      <div style={{ maxHeight: 520, overflow: 'auto' }}><table className="sa-table"><thead><tr><th>№ / время</th><th>Реплика</th><th>Событие</th><th>Текст / задержка / данные</th></tr></thead><tbody>
        {filtered.map((event) => <tr key={event.seq}><td>#{event.seq}<br />{(event.ms / 1000).toFixed(2)} с</td><td>{event.turn}</td><td>{labels[event.event] || event.event}<div className="sa-meta">{event.event}</div></td>
          <td>{event.latency_ms == null ? event.text || '' : `${event.latency_ms} мс`}<Data value={event} /></td></tr>)}
      </tbody></table></div>
    </>}
  </section>;
}
