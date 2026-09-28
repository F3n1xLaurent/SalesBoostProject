import OpenAI from 'openai';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { config } from '../config';

function createOpenAIClient(): OpenAI {
  const baseOptions = {
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
  };

  if (config.httpsProxy && config.aiApiProvider !== 'proxyapi') {
    const proxyAgent = new ProxyAgent(config.httpsProxy);
    const customFetch = (input: any, init?: any) =>
      undiciFetch(input as any, { ...init, dispatcher: proxyAgent } as any);
    return new OpenAI({ ...baseOptions, fetch: customFetch as any });
  }

  return new OpenAI(baseOptions);
}

export const openai = createOpenAIClient();

/** New reasoning/GPT-5 models only accept the default temperature and reject custom values. */
export function compatibleChatTemperature(model: string, temperature: number): { temperature?: number } {
  const modelName = model.trim().toLowerCase().split('/').pop() || '';
  const requiresDefaultTemperature = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/.test(modelName);
  return requiresDefaultTemperature ? {} : { temperature };
}
