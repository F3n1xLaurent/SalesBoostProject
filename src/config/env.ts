import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  BOT_TOKEN: z.string().optional(),
  AI_API_PROVIDER: z.string().optional(), // "openai" | "proxyapi"
  OPENAI_API_KEY: z.string().optional(),
  PROXYAPI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_CHAT_MODEL: z.string().optional(),
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
  OPENAI_IMPORT_MODEL: z.string().optional(),
  OPENAI_STT_MODEL: z.string().optional(),
  OPENAI_TTS_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANALYTICS_AI_MODEL: z.string().optional(),
  DATABASE_URL: z.string().min(1).default('file:./dev.db'),
  ADMIN_TELEGRAM_IDS: z.string().optional(),
  PORT: z.string().optional(),
  ALLOW_DEV_ADMIN: z.string().optional(),
  MINI_APP_URL: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_PROXY_URL: z.string().optional(),
  ELEVENLABS_TTS_TIMEOUT_MS: z.string().optional(),
  YANDEX_CLOUD_FOLDER_ID: z.string().optional(),
  YANDEX_CLOUD_API_KEY: z.string().optional(),
  YANDEX_REALTIME_MODEL: z.string().optional(),
  YANDEX_REALTIME_TTS_SPEED: z.string().optional(),
  YANDEX_REALTIME_BARGE_IN_ENABLED: z.string().optional(),
  YANDEX_REALTIME_SMART_BARGE_IN_ENABLED: z.string().optional(),
  YANDEX_REALTIME_BARGE_IN_SUSTAINED_MS: z.string().optional(),
  YANDEX_REALTIME_ENDPOINT_SILENCE_MS: z.string().optional(),
  YANDEX_REALTIME_INCOMPLETE_TURN_ENABLED: z.string().optional(),
  YANDEX_REALTIME_TURN_GRACE_MS: z.string().optional(),
  YANDEX_REALTIME_INCOMPLETE_TURN_GRACE_MS: z.string().optional(),
  YANDEX_REALTIME_SEMANTIC_TURN_ENABLED: z.string().optional(),
  YANDEX_REALTIME_SEMANTIC_MODEL: z.string().optional(),
  YANDEX_REALTIME_SEMANTIC_TURN_TIMEOUT_MS: z.string().optional(),
  YANDEX_REALTIME_BACKCHANNEL_ENABLED: z.string().optional(),
  YANDEX_REALTIME_LISTENING_BACKCHANNEL_ENABLED: z.string().optional(),
  YANDEX_REALTIME_BACKCHANNEL_MIN_SPEECH_MS: z.string().optional(),
  YANDEX_REALTIME_BACKCHANNEL_COOLDOWN_MS: z.string().optional(),
  YANDEX_REALTIME_BACKCHANNEL_MAX_PER_TURN: z.string().optional(),
  YANDEX_REALTIME_SEAMLESS_HANDOFF_ENABLED: z.string().optional(),
  YANDEX_REALTIME_HANDOFF_PAUSE_MS: z.string().optional(),
  COMETAPI_API_KEY: z.string().optional(),
  COMETAPI_REALTIME_MODEL: z.string().optional(),
  COMETAPI_REALTIME_URL: z.string().optional(),
  COMETAPI_REALTIME_REASONING_EFFORT: z.string().optional(),
  COMETAPI_REALTIME_ENDPOINT_SILENCE_MS: z.string().optional(),
  COMETAPI_TRANSCRIPTION_MODEL: z.string().optional(),
  OPENAI_REALTIME_API_KEY: z.string().optional(),
  OPENAI_REALTIME_MODEL: z.string().optional(),
  OPENAI_REALTIME_URL: z.string().optional(),
  OPENAI_REALTIME_REASONING_EFFORT: z.string().optional(),
  OPENAI_REALTIME_ENDPOINT_SILENCE_MS: z.string().optional(),
  OPENAI_REALTIME_LONG_TURN_ENDPOINT_SILENCE_MS: z.string().optional(),
  OPENAI_REALTIME_LONG_TURN_THRESHOLD_MS: z.string().optional(),
  OPENAI_REALTIME_TRANSCRIPTION_MODEL: z.string().optional(),
  TTS_PROVIDER: z.string().optional(), // "openai" | "elevenlabs" — default: elevenlabs if keys set, else openai
  HTTPS_PROXY: z.string().optional(), // Прокси для OpenAI (если API недоступен в регионе)
  AUTH_TOKEN_SECRET: z.string().optional(),
  VOX_ACCOUNT_ID: z.string().optional(),
  VOX_API_KEY: z.string().optional(),
  VOX_SERVICE_ACCOUNT_CREDENTIALS: z.string().optional(),
  CALL_RECORDINGS_DIR: z.string().optional(),
  AMPLITUDE_DEV_API_KEY: z.string().optional(),
  AMPLITUDE_API_KEY: z.string().optional(),
  AMPLITUDE_REGION: z.string().optional(),
  SENTRY_BACKEND_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.string().optional(),
  BITRIX24_WEBHOOK_URL: z.string().url().optional(),
  BITRIX24_SUPPORT_CLIENT_ID: z.string().optional(),
  BITRIX24_SUPPORT_CLIENT_SECRET: z.string().optional(),
  BITRIX24_SUPPORT_TOKEN_KEY: z.string().optional(),
  BITRIX24_SUPPORT_LINE_ID: z.string().optional(),
  BITRIX24_SUPPORT_DEAL_CATEGORY_ID: z.string().optional(),
  BITRIX24_SUPPORT_CONNECTOR_ID: z.string().optional(),
  BITRIX24_SUPPORT_FIELDS_JSON: z.string().optional(),
  SUPPORT_TIMEZONE: z.string().optional(),
  SUPPORT_WORK_HOURS_FROM: z.string().optional(),
  SUPPORT_WORK_HOURS_TO: z.string().optional(),
  SUPPORT_SLA_FIRST_RESPONSE_MINUTES: z.string().optional(),
  SUPPORT_SLA_RESOLUTION_MINUTES: z.string().optional(),
});

const raw = EnvSchema.parse(process.env);

const botToken = raw.TELEGRAM_BOT_TOKEN || raw.BOT_TOKEN;
if (!botToken) {
  throw new Error('TELEGRAM_BOT_TOKEN or BOT_TOKEN is required');
}

const aiApiProvider = raw.AI_API_PROVIDER?.toLowerCase() === 'proxyapi' ? 'proxyapi' : 'openai';
const openaiApiKey = aiApiProvider === 'proxyapi'
  ? (raw.PROXYAPI_API_KEY || raw.OPENAI_API_KEY)
  : raw.OPENAI_API_KEY;

if (!openaiApiKey) {
  throw new Error(aiApiProvider === 'proxyapi' ? 'PROXYAPI_API_KEY or OPENAI_API_KEY is required' : 'OPENAI_API_KEY is required');
}

const openaiBaseUrl = raw.OPENAI_BASE_URL?.trim()
  || (aiApiProvider === 'proxyapi' ? 'https://openai.api.proxyapi.ru/v1' : undefined);

function ratio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || !value.trim()) return fallback;
  return !['false', '0', 'off', 'no'].includes(value.trim().toLowerCase());
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

export const env = {
  botToken,
  aiApiProvider,
  openaiApiKey,
  proxyApiKey: raw.PROXYAPI_API_KEY?.trim() || (aiApiProvider === 'proxyapi' ? openaiApiKey : undefined),
  openaiBaseUrl,
  openaiChatModel: raw.OPENAI_CHAT_MODEL?.trim() || (aiApiProvider === 'proxyapi' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'),
  openaiReasoningEffort: raw.OPENAI_REASONING_EFFORT,
  openaiImportModel: raw.OPENAI_IMPORT_MODEL?.trim() || raw.OPENAI_CHAT_MODEL?.trim() || (aiApiProvider === 'proxyapi' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'),
  openaiSttModel: raw.OPENAI_STT_MODEL?.trim() || (aiApiProvider === 'proxyapi' ? 'openai/gpt-4o-mini-transcribe' : 'gpt-4o-mini-transcribe'),
  openaiTtsModel: raw.OPENAI_TTS_MODEL?.trim() || (aiApiProvider === 'proxyapi' ? 'openai/tts-1' : 'tts-1'),
  anthropicApiKey: raw.ANTHROPIC_API_KEY?.trim() || undefined,
  analyticsAiModel: raw.ANALYTICS_AI_MODEL?.trim() || 'claude-sonnet-4-20250514',
  adminIdentifiers: raw.ADMIN_TELEGRAM_IDS
    ? raw.ADMIN_TELEGRAM_IDS.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean)
    : [],
  databaseUrl: raw.DATABASE_URL,
  port: parseInt(raw.PORT || '3000', 10),
  allowDevAdmin: raw.ALLOW_DEV_ADMIN === 'true' || raw.ALLOW_DEV_ADMIN === '1',
  miniAppUrl: raw.MINI_APP_URL,
  elevenLabsApiKey: raw.ELEVENLABS_API_KEY,
  elevenLabsVoiceId: raw.ELEVENLABS_VOICE_ID,
  elevenLabsAgentId: raw.ELEVENLABS_AGENT_ID?.trim() || undefined,
  elevenLabsProxyUrl: raw.ELEVENLABS_PROXY_URL?.trim() || undefined,
  elevenLabsTtsTimeoutMs: Math.max(
    10_000,
    Math.min(120_000, Number.parseInt(raw.ELEVENLABS_TTS_TIMEOUT_MS || '45000', 10) || 45_000),
  ),
  yandexCloudFolderId: raw.YANDEX_CLOUD_FOLDER_ID?.trim() || undefined,
  yandexCloudApiKey: raw.YANDEX_CLOUD_API_KEY?.trim() || undefined,
  yandexRealtimeModel: raw.YANDEX_REALTIME_MODEL?.trim() || 'speech-realtime-max-tts-live/latest',
  yandexRealtimeTtsSpeed: Math.max(0.7, Math.min(1.2, Number(raw.YANDEX_REALTIME_TTS_SPEED || '1.13') || 1.13)),
  yandexRealtimeBargeInEnabled: flag(raw.YANDEX_REALTIME_BARGE_IN_ENABLED, false),
  yandexRealtimeSmartBargeInEnabled: flag(raw.YANDEX_REALTIME_SMART_BARGE_IN_ENABLED, true),
  yandexRealtimeBargeInSustainedMs: boundedInteger(raw.YANDEX_REALTIME_BARGE_IN_SUSTAINED_MS, 1300, 350, 2500),
  yandexRealtimeEndpointSilenceMs: boundedInteger(raw.YANDEX_REALTIME_ENDPOINT_SILENCE_MS, 450, 250, 1500),
  yandexRealtimeIncompleteTurnEnabled: flag(raw.YANDEX_REALTIME_INCOMPLETE_TURN_ENABLED, true),
  yandexRealtimeTurnGraceMs: boundedInteger(raw.YANDEX_REALTIME_TURN_GRACE_MS, 1000, 100, 2500),
  yandexRealtimeIncompleteTurnGraceMs: boundedInteger(raw.YANDEX_REALTIME_INCOMPLETE_TURN_GRACE_MS, 1700, 500, 5000),
  yandexRealtimeSemanticTurnEnabled: flag(raw.YANDEX_REALTIME_SEMANTIC_TURN_ENABLED, true),
  yandexRealtimeSemanticModel: raw.YANDEX_REALTIME_SEMANTIC_MODEL?.trim()
    || (aiApiProvider === 'proxyapi' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'),
  yandexRealtimeSemanticTurnTimeoutMs: boundedInteger(raw.YANDEX_REALTIME_SEMANTIC_TURN_TIMEOUT_MS, 1200, 250, 2500),
  yandexRealtimeBackchannelEnabled: flag(raw.YANDEX_REALTIME_BACKCHANNEL_ENABLED, true),
  yandexRealtimeListeningBackchannelEnabled: flag(raw.YANDEX_REALTIME_LISTENING_BACKCHANNEL_ENABLED, false),
  yandexRealtimeBackchannelMinSpeechMs: boundedInteger(raw.YANDEX_REALTIME_BACKCHANNEL_MIN_SPEECH_MS, 2200, 1000, 15000),
  yandexRealtimeBackchannelCooldownMs: boundedInteger(raw.YANDEX_REALTIME_BACKCHANNEL_COOLDOWN_MS, 8000, 2000, 30000),
  yandexRealtimeBackchannelMaxPerTurn: boundedInteger(raw.YANDEX_REALTIME_BACKCHANNEL_MAX_PER_TURN, 1, 0, 5),
  yandexRealtimeSeamlessHandoffEnabled: flag(raw.YANDEX_REALTIME_SEAMLESS_HANDOFF_ENABLED, false),
  yandexRealtimeHandoffPauseMs: boundedInteger(raw.YANDEX_REALTIME_HANDOFF_PAUSE_MS, 200, 0, 1000),
  cometApiKey: raw.COMETAPI_API_KEY?.trim() || undefined,
  cometRealtimeModel: raw.COMETAPI_REALTIME_MODEL?.trim() || 'gpt-realtime-2',
  cometRealtimeUrl: raw.COMETAPI_REALTIME_URL?.trim() || 'wss://api.cometapi.com/v1/realtime',
  cometRealtimeReasoningEffort: raw.COMETAPI_REALTIME_REASONING_EFFORT?.trim() || 'low',
  cometRealtimeEndpointSilenceMs: boundedInteger(raw.COMETAPI_REALTIME_ENDPOINT_SILENCE_MS, 250, 200, 2000),
  cometRealtimeTranscriptionModel: raw.COMETAPI_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-transcribe',
  openaiRealtimeApiKey: raw.OPENAI_REALTIME_API_KEY?.trim()
    || (aiApiProvider === 'openai' ? raw.OPENAI_API_KEY?.trim() : undefined),
  openaiRealtimeModel: raw.OPENAI_REALTIME_MODEL?.trim() || 'gpt-realtime-2',
  openaiRealtimeUrl: raw.OPENAI_REALTIME_URL?.trim() || 'wss://api.openai.com/v1/realtime',
  openaiRealtimeReasoningEffort: raw.OPENAI_REALTIME_REASONING_EFFORT?.trim() || 'low',
  openaiRealtimeEndpointSilenceMs: boundedInteger(raw.OPENAI_REALTIME_ENDPOINT_SILENCE_MS, 200, 200, 2000),
  openaiRealtimeLongTurnEndpointSilenceMs: boundedInteger(
    raw.OPENAI_REALTIME_LONG_TURN_ENDPOINT_SILENCE_MS,
    650,
    300,
    2500,
  ),
  openaiRealtimeLongTurnThresholdMs: boundedInteger(raw.OPENAI_REALTIME_LONG_TURN_THRESHOLD_MS, 1400, 500, 10000),
  openaiRealtimeTranscriptionModel: raw.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || 'gpt-transcribe',
  ttsProvider: raw.TTS_PROVIDER?.toLowerCase() === 'openai' ? 'openai' : 'elevenlabs',
  httpsProxy: raw.HTTPS_PROXY?.trim() || undefined,
  authTokenSecret: raw.AUTH_TOKEN_SECRET?.trim() || undefined,
  voxAccountId: raw.VOX_ACCOUNT_ID?.trim() || undefined,
  voxApiKey: raw.VOX_API_KEY?.trim() || undefined,
  voxServiceAccountCredentials: raw.VOX_SERVICE_ACCOUNT_CREDENTIALS?.trim() || undefined,
  callRecordingsDir: raw.CALL_RECORDINGS_DIR?.trim() || undefined,
  amplitudeApiKey: (raw.SENTRY_ENVIRONMENT?.trim() === 'production' || (!raw.SENTRY_ENVIRONMENT && process.env.NODE_ENV === 'production') ? raw.AMPLITUDE_API_KEY : raw.AMPLITUDE_DEV_API_KEY)?.trim() || undefined,
  amplitudeRegion: raw.AMPLITUDE_REGION?.trim().toUpperCase() === 'EU' ? 'EU' : 'US',
  sentryBackendDsn: raw.SENTRY_BACKEND_DSN?.trim() || undefined,
  sentryEnvironment: raw.SENTRY_ENVIRONMENT?.trim() || (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
  sentryRelease: raw.SENTRY_RELEASE?.trim() || undefined,
  sentryTracesSampleRate: ratio(raw.SENTRY_TRACES_SAMPLE_RATE, process.env.NODE_ENV === 'production' ? 0.1 : 0),
  bitrix24WebhookUrl: raw.BITRIX24_WEBHOOK_URL?.trim() || undefined,
  bitrix24SupportClientId: raw.BITRIX24_SUPPORT_CLIENT_ID?.trim() || undefined,
  bitrix24SupportClientSecret: raw.BITRIX24_SUPPORT_CLIENT_SECRET?.trim() || undefined,
  bitrix24SupportTokenKey: raw.BITRIX24_SUPPORT_TOKEN_KEY?.trim() || undefined,
  bitrix24SupportLineId: raw.BITRIX24_SUPPORT_LINE_ID?.trim() || undefined,
  bitrix24SupportDealCategoryId: raw.BITRIX24_SUPPORT_DEAL_CATEGORY_ID?.trim() || undefined,
  bitrix24SupportConnectorId: raw.BITRIX24_SUPPORT_CONNECTOR_ID?.trim() || 'salsa_support',
  bitrix24SupportFieldsJson: raw.BITRIX24_SUPPORT_FIELDS_JSON?.trim() || undefined,
  supportTimezone: raw.SUPPORT_TIMEZONE?.trim() || 'Europe/Moscow',
  supportWorkHoursFrom: Math.max(0, Math.min(23, Number.parseInt(raw.SUPPORT_WORK_HOURS_FROM || '9', 10) || 9)),
  supportWorkHoursTo: Math.max(1, Math.min(24, Number.parseInt(raw.SUPPORT_WORK_HOURS_TO || '18', 10) || 18)),
  supportSlaFirstResponseMinutes: Math.max(1, Number.parseInt(raw.SUPPORT_SLA_FIRST_RESPONSE_MINUTES || '60', 10) || 60),
  supportSlaResolutionMinutes: Math.max(1, Number.parseInt(raw.SUPPORT_SLA_RESOLUTION_MINUTES || '1440', 10) || 1440),
} as const;
