import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { config } from '../config';

const elevenLabsProxyAgent = config.elevenLabsProxyUrl
  ? new ProxyAgent(config.elevenLabsProxyUrl)
  : null;

type ElevenLabsFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

/**
 * Sends an ElevenLabs HTTP request through ELEVENLABS_PROXY_URL when configured.
 * Keeping this in one place prevents individual API integrations from silently
 * bypassing the proxy in production.
 */
export async function fetchElevenLabs(
  input: string | URL,
  init: ElevenLabsFetchInit = {},
): Promise<Response> {
  return await undiciFetch(input, {
    ...init,
    ...(elevenLabsProxyAgent ? { dispatcher: elevenLabsProxyAgent } : {}),
  }) as unknown as Response;
}

export function isElevenLabsProxyEnabled(): boolean {
  return Boolean(elevenLabsProxyAgent);
}
