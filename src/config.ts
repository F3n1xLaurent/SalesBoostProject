import fs from 'fs';
import path from 'path';
import { env } from './config/env';

export const config = {
  botToken: env.botToken,
  aiApiProvider: env.aiApiProvider,
  openaiApiKey: env.openaiApiKey,
  proxyApiKey: env.proxyApiKey,
  openaiBaseUrl: env.openaiBaseUrl,
  openaiChatModel: env.openaiChatModel,
  openaiImportModel: env.openaiImportModel,
  openaiSttModel: env.openaiSttModel,
  openaiTtsModel: env.openaiTtsModel,
  anthropicApiKey: env.anthropicApiKey,
  analyticsAiModel: env.analyticsAiModel,
  // Support both IDs and usernames (with or without @)
  adminIdentifiers: env.adminIdentifiers,
  databaseUrl: env.databaseUrl,
  port: env.port,
  // Allow admin panel in browser on localhost without Telegram initData (dev only)
  allowDevAdmin: env.allowDevAdmin,
  // Default to HTTPS for localhost if certificates exist, otherwise HTTP
  miniAppUrl:
    env.miniAppUrl ||
    (() => {
      const certPath = path.join(__dirname, '../cert.pem');
      const keyPath = path.join(__dirname, '../key.pem');
      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return `https://localhost:${env.port}`;
      }
      return `http://localhost:${env.port}`;
    })(),
  elevenLabsApiKey: env.elevenLabsApiKey,
  elevenLabsVoiceId: env.elevenLabsVoiceId,
  elevenLabsAgentId: env.elevenLabsAgentId,
  elevenLabsProxyUrl: env.elevenLabsProxyUrl,
  ttsProvider: env.ttsProvider,
  httpsProxy: env.httpsProxy,
  authTokenSecret: env.authTokenSecret,
  voxAccountId: env.voxAccountId,
  voxApiKey: env.voxApiKey,
  voxServiceAccountCredentials: env.voxServiceAccountCredentials,
  callRecordingsDir: env.callRecordingsDir,
  amplitudeApiKey: env.amplitudeApiKey,
  amplitudeRegion: env.amplitudeRegion,
  sentryBackendDsn: env.sentryBackendDsn,
  sentryEnvironment: env.sentryEnvironment,
  sentryRelease: env.sentryRelease,
  sentryTracesSampleRate: env.sentryTracesSampleRate,
  bitrix24WebhookUrl: env.bitrix24WebhookUrl,
  bitrix24SupportClientId: env.bitrix24SupportClientId,
  bitrix24SupportClientSecret: env.bitrix24SupportClientSecret,
  bitrix24SupportTokenKey: env.bitrix24SupportTokenKey,
  bitrix24SupportLineId: env.bitrix24SupportLineId,
  bitrix24SupportDealCategoryId: env.bitrix24SupportDealCategoryId,
  bitrix24SupportConnectorId: env.bitrix24SupportConnectorId,
  bitrix24SupportFieldsJson: env.bitrix24SupportFieldsJson,
  supportTimezone: env.supportTimezone,
  supportWorkHoursFrom: env.supportWorkHoursFrom,
  supportWorkHoursTo: env.supportWorkHoursTo,
  supportSlaFirstResponseMinutes: env.supportSlaFirstResponseMinutes,
  supportSlaResolutionMinutes: env.supportSlaResolutionMinutes,
};
