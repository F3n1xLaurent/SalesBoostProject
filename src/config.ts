import fs from 'fs';
import path from 'path';
import { env } from './config/env';

export const config = {
  botToken: env.botToken,
  aiApiProvider: env.aiApiProvider,
  openaiApiKey: env.openaiApiKey,
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
  ttsProvider: env.ttsProvider,
  httpsProxy: env.httpsProxy,
  authTokenSecret: env.authTokenSecret,
};
