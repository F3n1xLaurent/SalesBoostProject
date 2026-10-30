import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchRealtimeTestCall,
  startRealtimeTestCall,
  type CallPlanItem,
  type RealtimeTestCall,
} from '../../../shared/api/adminPanel';

const TERMINAL_STATUSES = new Set(['disconnected', 'failed', 'busy', 'no_answer', 'cancelled', 'yandex_disconnected', 'comet_disconnected', 'openai_disconnected']);

function metric(value: number | null): string {
  return value == null ? '—' : `${value} мс`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    starting: 'Запуск',
    dialing: 'Набор номера',
    progress: 'Набор номера',
    media_connecting: 'Подключение аудио',
    ready: 'Realtime готов',
    connected: 'Разговор идёт',
    disconnected: 'Завершён',
    failed: 'Ошибка звонка',
    busy: 'Занято',
    no_answer: 'Нет ответа',
    cancelled: 'Отменён',
    yandex_disconnected: 'Realtime отключён',
    comet_disconnected: 'Comet Realtime отключён',
    openai_disconnected: 'OpenAI Realtime отключён',
  };
  return labels[status] || status;
}

function flowEventLabel(type: RealtimeTestCall['conversationFlow']['events'][number]['type']): string {
  const labels = {
    barge_in_candidate: 'Кандидат на перебивание',
    barge_in_confirmed: 'Перебивание подтверждено',
    barge_in_ignored: 'Перебивание проигнорировано',
    backchannel_scheduled: 'Короткая реакция запланирована',
    backchannel_played: 'Короткая реакция проиграна',
    backchannel_cancelled: 'Короткая реакция отменена',
    endpoint_continuation_detected: 'Обнаружено продолжение ответа',
    endpoint_completion_grace_started: 'Ожидание завершения мысли',
    endpoint_semantic_assessed: 'Смысловая завершённость проверена',
    endpoint_turn_committed: 'Ответ менеджера признан завершённым',
    entity_mismatch_detected: 'Обнаружена другая марка/модель',
    manager_audio_discarded: 'Речь поверх AI отброшена до тишины',
    speculative_response_started: 'Фоновая подготовка ответа начата',
    speculative_response_cancelled: 'Фоновый ответ отменён: менеджер продолжил',
    handoff_started: 'Начата фоновая подготовка новой реплики',
    handoff_cutover: 'Аудио переключено на новую реплику',
  };
  return labels[type];
}

function turnMetricItems(turn: RealtimeTestCall['transcript'][number]): Array<[string, string]> {
  const values: Array<[string, number | null | undefined]> = turn.role === 'manager'
    ? [
      ['Длительность речи', turn.metrics.speechDurationMs],
      ['Речь → текст', turn.metrics.speechToTextMs],
      ['Ожидание конца речи VAD', turn.metrics.vadEndpointMs],
    ]
    : [
      ['Текст → запуск Yandex', turn.metrics.endpointWaitMs],
      ['Окно завершения мысли', turn.metrics.endpointStabilityMs],
      ['Yandex → первый текст', turn.metrics.llmFirstTextMs],
      ['Генерация текста', turn.metrics.llmTextGenerationMs],
      ['Текст → запрос TTS', turn.metrics.ttsRequestDelayMs],
      ['Ожидание сокета TTS', turn.metrics.ttsSocketWaitMs],
      ['TTS → первый звук', turn.metrics.ttsFirstAudioMs],
      ['Полная генерация TTS', turn.metrics.ttsGenerationMs],
      ['Длительность аудио', turn.metrics.audioDurationMs],
      ['Речь → первый звук', turn.metrics.speechToFirstAudioMs],
      ['Речь → отправка аудио', turn.metrics.speechToPlaybackMs],
      ['Речь → фактический старт Voximplant', turn.metrics.speechToVoxPlaybackMs],
    ];
  const result = values
    .filter((item): item is [string, number] => item[1] != null)
    .map(([label, value]) => [label, `${value} мс`] as [string, string]);
  if (turn.metrics.interrupted) result.push(['Статус', 'прервана']);
  if (turn.metrics.interruptionPlaybackMs != null) {
    result.push(['Проиграно до перебивания', metric(turn.metrics.interruptionPlaybackMs)]);
  }
  if (turn.metrics.heardTextOnInterruption) {
    result.push(['ИИ считает услышанным', `«${turn.metrics.heardTextOnInterruption}»`]);
  }
  if (turn.metrics.contextCorrected != null) {
    result.push(['Контекст после перебивания', turn.metrics.contextCorrected ? 'исправлен' : 'fallback']);
  }
  if (turn.metrics.deliveryStyle) {
    const deliveryLabels = {
      curious: 'заинтересованно',
      warm: 'тепло',
      gentle: 'мягко',
      engaged: 'вовлечённо',
      neutral: 'нейтрально',
    } as const;
    result.push(['Подача голоса', deliveryLabels[turn.metrics.deliveryStyle]]);
  }
  if (turn.metrics.silentResponseRetries) {
    result.push(['Повтор после пустого ответа', String(turn.metrics.silentResponseRetries)]);
  }
  return result;
}

export function YandexRealtimeTestPage(props: { plans: CallPlanItem[]; loading: boolean }) {
  const [provider, setProvider] = useState<'yandex' | 'comet' | 'openai'>('yandex');
  const [cometModel, setCometModel] = useState('gpt-realtime-2');
  const [planId, setPlanId] = useState('');
  const [phone, setPhone] = useState('+79507503215');
  const [call, setCall] = useState<RealtimeTestCall | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = useMemo(() => props.plans.filter((item) => item.id && item.name), [props.plans]);
  const selectedPlanAvailable = plans.some((item) => item.id === planId);

  useEffect(() => {
    if (!plans.some((item) => item.id === planId)) setPlanId(plans[0]?.id || '');
  }, [planId, plans]);

  useEffect(() => {
    if (!call?.callId || TERMINAL_STATUSES.has(call.status)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      fetchRealtimeTestCall(call.callId)
        .then((next) => {
          if (!cancelled) setCall(next);
        })
        .catch((pollError) => {
          if (!cancelled) setError(pollError instanceof Error ? pollError.message : 'Не удалось обновить состояние звонка.');
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [call?.callId, call?.status]);

  async function startCall() {
    if (props.loading || !selectedPlanAvailable || !phone.trim()) return;
    setStarting(true);
    setError(null);
    setCall(null);
    try {
      setCall(await startRealtimeTestCall({
        planId,
        to: phone,
        provider,
        ...(provider === 'comet' || provider === 'openai' ? { model: cometModel } : {}),
      }));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Не удалось запустить тестовый звонок.');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="sa-batch-live-warning">
        {provider === 'comet'
          ? 'Гипотеза 2: Voximplant → CometAPI GPT Realtime → ElevenLabs Streaming TTS.'
          : provider === 'openai'
            ? 'Гипотеза 2: Voximplant → OpenAI GPT Realtime напрямую → ElevenLabs Streaming TTS.'
          : 'Гипотеза 1: Voximplant → Yandex Realtime → ElevenLabs Streaming TTS.'}
        {' '}Звонок не попадёт в историю плана, и оценка после него не запускается.
      </div>

      <div className="sa-companies-table-wrap" style={{ padding: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, alignItems: 'end' }}>
          <label>
            <span className="sa-meta" style={{ display: 'block', marginBottom: 6 }}>Архитектура</span>
            <select
              className="sa-input"
              value={provider}
              onChange={(event) => {
                const nextProvider = event.target.value as 'yandex' | 'comet' | 'openai';
                setProvider(nextProvider);
                if (nextProvider === 'comet' && cometModel !== 'gpt-realtime-2') setCometModel('gpt-realtime-2');
              }}
              disabled={starting}
            >
              <option value="yandex">Гипотеза 1 · Yandex + ElevenLabs</option>
              <option value="comet">Гипотеза 2 · Comet + ElevenLabs</option>
              <option value="openai">Гипотеза 2 · OpenAI напрямую + ElevenLabs</option>
            </select>
          </label>
          <label>
            <span className="sa-meta" style={{ display: 'block', marginBottom: 6 }}>План прозвона</span>
            <select className="sa-input" value={planId} onChange={(event) => setPlanId(event.target.value)} disabled={props.loading || starting}>
              {plans.length === 0 && <option value="">Нет доступных планов</option>}
              {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
            </select>
          </label>
          {(provider === 'comet' || provider === 'openai') && (
            <label>
              <span className="sa-meta" style={{ display: 'block', marginBottom: 6 }}>Realtime-модель</span>
              <select className="sa-input" value={cometModel} onChange={(event) => setCometModel(event.target.value)} disabled={starting}>
                <option value="gpt-realtime-2">GPT Realtime 2</option>
                <option value="gpt-realtime-2.1-mini" disabled={provider === 'comet'}>GPT Realtime 2.1 Mini{provider === 'comet' ? ' · маршрут CometAPI недоступен' : ''}</option>
                <option value="gpt-realtime-2.1" disabled={provider === 'comet'}>GPT Realtime 2.1{provider === 'comet' ? ' · маршрут CometAPI недоступен' : ''}</option>
              </select>
            </label>
          )}
          <label>
            <span className="sa-meta" style={{ display: 'block', marginBottom: 6 }}>Номер для теста</span>
            <input className="sa-input" value={phone} onChange={(event) => setPhone(event.target.value)} disabled={starting} inputMode="tel" />
          </label>
          <button type="button" className="sa-btn-brutal-3d" onClick={() => void startCall()} disabled={props.loading || starting || !selectedPlanAvailable || !phone.trim()}>
            {starting ? 'Запускаем…' : 'Позвонить'}
          </button>
        </div>
      </div>

      {error && <div className="sa-batch-live-error">{error}</div>}

      {call && (
        <>
          <div className="sa-companies-table-wrap" style={{ padding: 20 }}>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div>
                <div className="sa-cell-name">{statusLabel(call.status)}</div>
                <div className="sa-meta" style={{ marginTop: 4 }}>{call.planName} · {call.phone}</div>
                <div className="sa-meta" style={{ marginTop: 4 }}>
                  Модель: {call.provider === 'comet'
                    ? `${call.model || 'GPT Realtime'} через CometAPI`
                    : call.provider === 'openai'
                      ? `${call.model || 'GPT Realtime'} напрямую через OpenAI`
                      : 'Yandex Realtime'}
                  {' · '}голос: {call.voice.modelId} / {call.voice.voiceId} · speed {call.voice.speed}
                  {call.voice.source === 'agent' ? ' · настройки ElevenLabs Agent' : ' · резервные настройки ElevenLabs'}
                </div>
                <div className="sa-meta" style={{ marginTop: 4 }}>
                  {call.provider === 'comet' || call.provider === 'openai' ? (
                    <>
                      Конец реплики: локальный PCM endpoint · пауза {call.conversationFlow.endpointSilenceMs} мс · содержательные перебивания включены, короткие подтверждения не обрывают речь
                      {' · '}линия: {call.connectionState === 'live_conversation'
                        ? 'живой менеджер'
                        : call.connectionState === 'waiting_operator'
                          ? 'IVR / ожидание переключения'
                          : 'ожидание ответа'}
                      {call.ivrDetected ? ` · IVR: да${call.ivrPath?.length ? ` (${call.ivrPath.join(' → ')})` : ''}` : ''}
                    </>
                  ) : (
                    <>
                      Перебивание: {call.conversationFlow.bargeInEnabled ? 'вкл.' : 'выкл.'}
                      {call.conversationFlow.bargeInEnabled
                        ? ` · Smart barge-in: ${call.conversationFlow.smartBargeInEnabled ? 'вкл.' : 'выкл.'}`
                        : ''}
                      {' · '}backchannel ожидания: {call.conversationFlow.backchannelEnabled ? 'вкл.' : 'выкл.'}
                      {' · '}во время речи: {call.conversationFlow.listeningBackchannelEnabled ? 'вкл.' : 'выкл.'}
                      {' · '}склейка пауз: {call.conversationFlow.incompleteTurnEnabled ? 'вкл.' : 'выкл.'}
                      {call.conversationFlow.incompleteTurnEnabled
                        ? ` (${call.conversationFlow.turnGraceMs}/${call.conversationFlow.incompleteTurnGraceMs} мс)`
                        : ''}
                      {' · '}semantic endpoint: {call.conversationFlow.semanticTurnEnabled
                        ? `вкл. (${call.conversationFlow.semanticTurnTimeoutMs} мс)`
                        : 'выкл.'}
                      {' · '}плавная смена реплики: {call.conversationFlow.seamlessHandoffEnabled ? `${call.conversationFlow.handoffPauseMs} мс` : 'выкл.'}
                      {' · '}пауза VAD: {call.conversationFlow.endpointSilenceMs} мс
                    </>
                  )}
                </div>
              </div>
              <code className="sa-meta">{call.callId}</code>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 10, marginTop: 18 }}>
              {[
                ['Ответ на звонок', metric(call.metrics.answerMs)],
                [call.provider === 'comet' ? 'Подключение CometAPI' : call.provider === 'openai' ? 'Подключение OpenAI' : 'Подключение Yandex', metric(call.metrics.yandexConnectMs)],
                ...(call.provider === 'comet' || call.provider === 'openai'
                  ? [[call.provider === 'openai' ? 'Подготовка OpenAI' : 'Подготовка CometAPI', metric(call.metrics.providerWarmupMs)] as [string, string]]
                  : []),
                ['Речь → первый текст', metric(call.metrics.speechToFirstTextMs)],
                ['Речь → первое аудио', metric(call.metrics.speechToFirstAudioMs)],
                ['Текст → первое аудио', metric(call.metrics.textToFirstAudioMs)],
              ].map(([label, value]) => (
                <div key={label} style={{ border: '1px solid var(--sa-border, #ddd)', padding: 12 }}>
                  <div className="sa-meta">{label}</div>
                  <div className="sa-cell-name" style={{ marginTop: 4 }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="sa-companies-table-wrap" style={{ padding: 20 }}>
            <div className="sa-cell-name" style={{ marginBottom: 12 }}>Транскрипт в реальном времени</div>
            {call.transcript.length === 0 ? (
              <div className="sa-meta">Реплик пока нет.</div>
            ) : call.transcript.map((turn, index) => (
              <div key={`${turn.at}-${index}`} style={{ padding: '10px 0', borderBottom: '1px solid var(--sa-divider, #eee)' }}>
                <div><strong>{turn.role === 'manager' ? 'Менеджер' : 'AI-клиент'}:</strong> {turn.text}</div>
                {turnMetricItems(turn).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
                    {turnMetricItems(turn).map(([label, value]) => (
                      <span
                        key={label}
                        className="sa-meta"
                        style={{ border: '1px solid var(--sa-border, #ddd)', borderRadius: 6, padding: '3px 7px' }}
                      >
                        {label}: <strong>{value}</strong>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {call.conversationFlow.events.length > 0 && (
            <div className="sa-companies-table-wrap" style={{ padding: 20 }}>
              <div className="sa-cell-name" style={{ marginBottom: 12 }}>Диагностика естественного диалога</div>
              {call.conversationFlow.events.map((item, index) => (
                <div key={`${item.at}-${index}`} className="sa-meta" style={{ marginBottom: 6 }}>
                  <strong>{flowEventLabel(item.type)}</strong>: {item.reason}
                  {item.speechDurationMs != null ? ` · речь ${item.speechDurationMs} мс` : ''}
                  {item.latencyMs != null ? ` · реакция ${item.latencyMs} мс` : ''}
                </div>
              ))}
            </div>
          )}

          {(call.tools.length > 0 || call.errors.length > 0) && (
            <div className="sa-companies-table-wrap" style={{ padding: 20 }}>
              <div className="sa-cell-name" style={{ marginBottom: 12 }}>Функции и ошибки</div>
              {call.tools.map((item, index) => (
                <div key={`${item.at}-${index}`} className="sa-meta" style={{ marginBottom: 6 }}>
                  function: {item.name} {JSON.stringify(item.arguments)}
                </div>
              ))}
              {call.errors.map((item, index) => <div key={index} className="sa-batch-live-error" style={{ marginTop: 8 }}>{item}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
