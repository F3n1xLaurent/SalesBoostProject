import OpenAI from 'openai';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { config } from '../config';
import { proxyApiLogHeaders, recordProxyApiResponse } from '../economics/proxyApiCosts';

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

  if (config.aiApiProvider === 'proxyapi') {
    const customFetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      for (const [key, value] of Object.entries(proxyApiLogHeaders())) headers.set(key, value);
      let requestModel: string | null = null;
      let requestUsage: Record<string, number> | null = null;
      const body = init?.body;
      if (typeof body === 'string' && body.startsWith('{')) {
        try {
          const parsed = JSON.parse(body);
          requestModel = String(parsed.model || '') || null;
          if (url.includes('/audio/speech') && typeof parsed.input === 'string') {
            requestUsage = { input_characters: Array.from(parsed.input).length };
          }
        } catch { /* multipart/binary */ }
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const formModel = body.get('model');
        requestModel = typeof formModel === 'string' ? formModel : null;
      }
      const response = await undiciFetch(input as any, { ...init, headers } as any) as unknown as Response;
      await recordProxyApiResponse({ url, requestModel, requestUsage, response }).catch((error) => {
        console.warn('[economics] failed to save ProxyAPI usage:', error instanceof Error ? error.message : error);
      });
      return response;
    };
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
