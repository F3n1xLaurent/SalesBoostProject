import { config } from '../config';
import { resolveCallPlanTelephonyProvider } from '../voice/callPlanTelephony';

/** Stable target IDs are shared by catalog, history and live-event envelopes. */
export type AutoTestingTarget = 'call_plan' | 'report' | 'trainer';
export function callPlanAutoTestConfiguration() {
  const provider = resolveCallPlanTelephonyProvider();
  return {
    provider, model: config.openaiRealtimeModel,
    endpointSilenceMs: config.openaiRealtimeEndpointSilenceMs,
    longTurnSilenceMs: config.openaiRealtimeLongTurnEndpointSilenceMs,
    longTurnThresholdMs: config.openaiRealtimeLongTurnThresholdMs,
    reasoningEffort: config.openaiRealtimeReasoningEffort,
    transcriptionModel: config.openaiRealtimeTranscriptionModel,
    voiceSource: 'call_plan',
    available: provider === 'openai_realtime' && Boolean(config.openaiRealtimeApiKey && config.elevenLabsApiKey),
    reason: provider !== 'openai_realtime' ? 'Основная телефония переключена на ElevenLabs Agent. Этот стенд проверяет цепочку OpenAI Realtime + ElevenLabs.'
      : !config.openaiRealtimeApiKey || !config.elevenLabsApiKey ? 'На сервере не настроены ключи OpenAI Realtime и ElevenLabs.' : null,
  };
}
export function autoTestingCatalog() {
  const configuration = callPlanAutoTestConfiguration();
  return { targets: [
    { id: 'call_plan' as const, title: 'Звонки по плану', available: configuration.available,
      description: 'Диалог, сценарий, функции и голос основной телефонии — без набора номера.', configuration },
    { id: 'report' as const, title: 'Отчёты', available: Boolean(config.openaiApiKey || config.proxyApiKey),
      description: '29 пунктов чеклиста: отчёты звонков и тренажёра на встроенных диалогах, без звонка и изменения статистики сотрудников.' },
    { id: 'trainer' as const, title: 'Тренировки', available: Boolean(config.openaiApiKey || config.proxyApiKey),
      description: '20 критериев на встроенных сценариях и профилях. Предыдущие тренировки и ручной выбор женского профиля не нужны.' },
  ] };
}
