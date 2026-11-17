import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../../entities/session';
import type { CallPlanItem } from '../../../shared/api/adminPanel';
import { PipecatDiagnosticsPanel } from './PipecatDiagnosticsPanel';

type Run = { id: string; status: string; model: string; ttsModel: string };
const terminal = new Set(['failed', 'disconnected', 'busy', 'no_answer', 'interrupted', 'unknown']);

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/admin/realtime-test/pipecat${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Ошибка сервиса Pipecat.');
  return payload;
}

export function PipecatHypothesisPanel({ plans, loading }: { plans: CallPlanItem[]; loading: boolean }) {
  const [provider, setProvider] = useState('openai');
  const isRealtime = provider === 'openai' || provider === 'openai_mini';
  const [dialogueMode, setDialogueMode] = useState('legacy');
  const [backchannel, setBackchannel] = useState(true);
  const [controllerAvailable, setControllerAvailable] = useState(false);
  const [semanticAvailable, setSemanticAvailable] = useState(false);
  const usesController = dialogueMode === 'controller' || dialogueMode === 'semantic';
  const [ttsModel, setTtsModel] = useState('eleven_v4_turbo');
  const [reasoningEffort, setReasoningEffort] = useState('low');
  const [trimIdleAudio, setTrimIdleAudio] = useState(false);
  const [planId, setPlanId] = useState('');
  const [phone, setPhone] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preflight, setPreflight] = useState<Record<string, unknown> | null>(null);
  const [availability, setAvailability] = useState('Проверка сервиса…');
  useEffect(() => {
    let cancelled = false;
    request<{ ok: boolean; dialogueModes?: string[] }>('/health').then((health) => { if (!cancelled) { setAvailability('Отдельный сервис подключён'); setControllerAvailable(health.dialogueModes?.includes('controller') ?? false); setSemanticAvailable(health.dialogueModes?.includes('semantic') ?? false); } })
      .catch((e) => { if (!cancelled) setAvailability(e.message); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (!plans.some((p) => p.id === planId)) setPlanId(plans[0]?.id || ''); }, [plans, planId]);
  useEffect(() => { setPreflight(null); }, [provider, ttsModel, planId, reasoningEffort, trimIdleAudio, dialogueMode, backchannel]);
  useEffect(() => { if (!isRealtime) setDialogueMode('legacy'); }, [isRealtime]);
  useEffect(() => {
    if (!run || terminal.has(run.status)) return;
    let cancelled = false;
    const timer = window.setInterval(() => request<{ status: string }>(`/calls/${run.id}/summary`).then((value) => { if (!cancelled) setRun((old) => old ? { ...old, status: value.status } : old); })
      .catch((e) => { if (!cancelled) setError(e.message); }), 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [run?.id, run?.status]);
  const active = !!run && !terminal.has(run.status);
  const disabled = busy || active || loading || !plans.some((p) => p.id === planId);
  async function execute(call: boolean) {
    setBusy(true); setError('');
    try {
      const options = { provider, ttsModel, planId, dialogueMode, backchannel: usesController && backchannel, ...(isRealtime ? { reasoningEffort, trimIdleAudio } : {}) };
      if (call) setRun(await request<Run>('/calls', { ...options, to: phone.trim() }));
      else setPreflight(await request('/preflight', options));
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка прототипа.'); }
    finally { setBusy(false); }
  }
  return <div className="sa-companies-table-wrap" style={{ padding: 20, marginBottom: 20 }}>
    <h2>Гипотеза 3 · Pipecat + ElevenLabs v3 / v4</h2>
    <p>Voximplant ↔ Pipecat (Silero VAD, Smart Turn) ↔ модель диалога → ElevenLabs → Voximplant.</p>
    <p className="sa-meta">{availability}. Эксперимент не создаёт рабочий звонок в плане и не запускает оценку.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
      <label>План<select className="sa-input" value={planId} disabled={busy || active || loading} onChange={(e) => setPlanId(e.target.value)}>
        {!plans.length && <option value="">Нет доступных планов</option>}
        {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label>Модель<select className="sa-input" value={provider} disabled={busy || active} onChange={(e) => setProvider(e.target.value)}>
        <option value="openai">OpenAI Realtime 2.1</option><option value="openai_mini">OpenAI Realtime 2.1 Mini</option><option value="gemini_proxyapi">Gemini 3.8 Flash · ProxyAPI</option><option value="gemini">Gemini 3.8 Flash · Google напрямую</option>
      </select></label>
      <label>Голосовой движок<select className="sa-input" value={ttsModel} disabled={busy || active} onChange={(e) => setTtsModel(e.target.value)}>
        <option value="eleven_v3">ElevenLabs v3</option><option value="eleven_v4">ElevenLabs v4</option><option value="eleven_v4_turbo">ElevenLabs v4 Turbo</option>
      </select></label>
      {isRealtime && <label>Диалог<select className="sa-input" value={dialogueMode} disabled={busy || active} onChange={(e) => setDialogueMode(e.target.value)}>
        <option value="legacy">Текущий Realtime</option><option value="controller" disabled={!controllerAvailable}>Контроллер + готовые реплики · эксперимент</option>
        <option value="semantic" disabled={!semanticAvailable}>Смысловой контроллер · эксперимент</option>
      </select></label>}
      {usesController && <label><input type="checkbox" checked={backchannel} disabled={busy || active} onChange={(e) => setBackchannel(e.target.checked)} /> Короткие реакции · backchannel</label>}
      {isRealtime && <label>Режим ответа<select className="sa-input" value={reasoningEffort} disabled={busy || active} onChange={(e) => setReasoningEffort(e.target.value)}>
        <option value="minimal">Minimal · эксперимент</option><option value="low">Базовый · low</option>
      </select></label>}
      {isRealtime && <label><input type="checkbox" checked={trimIdleAudio} disabled={busy || active} onChange={(e) => setTrimIdleAudio(e.target.checked)} /> Убирать накопленную тишину · эксперимент</label>}
      <label>Тестовый номер<input className="sa-input" type="tel" placeholder="+79991234567" value={phone} disabled={busy || active} onChange={(e) => setPhone(e.target.value)} /></label>
      <button type="button" className="sa-btn" disabled={disabled} onClick={() => void execute(false)}>Проверить API и голос</button>
      <button type="button" className="sa-btn sa-btn-primary" disabled={disabled || !/^\+[1-9]\d{9,14}$/u.test(phone.trim())} onClick={() => void execute(true)}>{busy ? 'Проверка / запуск…' : 'Позвонить через Pipecat'}</button>
    </div>
    {(provider === 'gemini' || provider === 'gemini_proxyapi') && <p className="sa-meta">Gemini Flash обрабатывает завершённую реплику: отдельно измеряются распознавание и генерация ответа той же моделью. {provider === 'gemini_proxyapi' ? 'Используется ключ ProxyAPI сервера, ключ Google не нужен.' : 'Используется отдельный ключ Google.'}</p>}
    {isRealtime && <p className="sa-meta">Minimal уменьшает бюджет рассуждений модели. Сравнивайте с low на одинаковых репликах: понимание сложных вопросов и работа с инструментами тоже требуют проверки. VAD и правила перебиваний одинаковые.</p>}
    <p className="sa-meta">Проверка API синтезирует короткую фразу выбранным голосом без телефонного звонка. Каждый звонок повторяет проверку. Для сравнения вариантов используйте один план, голос и одинаковые фразы.</p>
    <details><summary>Сценарии проверки</summary><ol>
      <li>Скажите «угу» и «ага» во время ответа: агент должен продолжить.</li>
      <li>Скажите «стоп, цена другая» и затем длинную фразу: звук должен остановиться, старое аудио не должно вернуться.</li>
      <li>Сделайте паузу внутри незаконченной фразы: проверьте Smart Turn и задержку ответа.</li>
      <li>Договоритесь о завершении: последняя фраза должна прозвучать полностью до отбоя.</li>
    </ol></details>
    {usesController && <p className="sa-meta">Каждый запуск готовит отдельные формулировки вопросов и озвучку выбранным голосом до набора номера. Повторяющиеся фразы используют кеш. Раннее согласование визита сохраняется, затем разговор продолжается по обязательным темам.</p>}
    {dialogueMode === 'semantic' && <p className="sa-meta">Единый разбор смысла каждой реплики: ответы по темам, вопросы к покупателю и согласование встречи. Несколько намерений обрабатываются вместе. Скорость и понимание сравниваем с обычным контроллером.</p>}
    {error && <p role="alert">{error}</p>}
    {preflight && <p role="status">Проверка завершена: {String(preflight.model)} + {String(preflight.ttsModel)}; первое аудио TTS: {String(preflight.ttsFirstAudioMs ?? '—')} мс. Телефонное воспроизведение проверяется звонком.</p>}
    {run && <p>Текущий запуск {run.id} · {run.status}</p>}
    <PipecatDiagnosticsPanel initialId={run?.id} />
  </div>;
}
