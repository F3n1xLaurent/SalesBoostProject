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
  OPENAI_IMPORT_MODEL: z.string().optional(),
  OPENAI_STT_MODEL: z.string().optional(),
  OPENAI_TTS_MODEL: z.string().optional(),
  DATABASE_URL: z.string().min(1).default('file:./dev.db'),
  ADMIN_TELEGRAM_IDS: z.string().optional(),
  PORT: z.string().optional(),
  ALLOW_DEV_ADMIN: z.string().optional(),
  MINI_APP_URL: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  TTS_PROVIDER: z.string().optional(), // "openai" | "elevenlabs" — default: elevenlabs if keys set, else openai
  HTTPS_PROXY: z.string().optional(), // Прокси для OpenAI (если API недоступен в регионе)
  AUTH_TOKEN_SECRET: z.string().optional(),
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

export const env = {
  botToken,
  aiApiProvider,
  openaiApiKey,
  openaiBaseUrl,
  openaiChatModel: raw.OPENAI_CHAT_MODEL?.trim() || (aiApiProvider === 'proxyapi' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'),
  openaiImportModel: raw.OPENAI_IMPORT_MODEL?.trim() || raw.OPENAI_CHAT_MODEL?.trim() || (aiApiProvider === 'proxyapi' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'),
  openaiSttModel: raw.OPENAI_STT_MODEL?.trim() || (aiApiProvider === 'proxyapi' ? 'openai/gpt-4o-mini-transcribe' : 'gpt-4o-mini-transcribe'),
  openaiTtsModel: raw.OPENAI_TTS_MODEL?.trim() || (aiApiProvider === 'proxyapi' ? 'openai/tts-1' : 'tts-1'),
  adminIdentifiers: raw.ADMIN_TELEGRAM_IDS
    ? raw.ADMIN_TELEGRAM_IDS.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean)
    : [],
  databaseUrl: raw.DATABASE_URL,
  port: parseInt(raw.PORT || '3000', 10),
  allowDevAdmin: raw.ALLOW_DEV_ADMIN === 'true' || raw.ALLOW_DEV_ADMIN === '1',
  miniAppUrl: raw.MINI_APP_URL,
  elevenLabsApiKey: raw.ELEVENLABS_API_KEY,
  elevenLabsVoiceId: raw.ELEVENLABS_VOICE_ID,
  ttsProvider: raw.TTS_PROVIDER?.toLowerCase() === 'openai' ? 'openai' : 'elevenlabs',
  httpsProxy: raw.HTTPS_PROXY?.trim() || undefined,
  authTokenSecret: raw.AUTH_TOKEN_SECRET?.trim() || undefined,
} as const;
