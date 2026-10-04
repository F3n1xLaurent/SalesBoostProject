import { prisma } from '../db';
import { currentCostContext } from './costContext';
import { calculateProxyApiAmount } from './proxyApiTariffs';

type Usage = Record<string, unknown> & {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
  output_tokens_details?: { audio_tokens?: number };
  seconds?: number;
};

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function categoryFromUrl(url: string): string {
  if (url.includes('/audio/transcriptions')) return 'stt';
  if (url.includes('/audio/speech')) return 'tts';
  return 'llm';
}

export function proxyApiLogHeaders(): Record<string, string> {
  const context = currentCostContext();
  if (!context) return {};
  return {
    'X-Log-Entity-Type': context.entityType.slice(0, 256),
    'X-Log-Entity-ID': context.entityId.slice(0, 256),
    ...(context.companyId ? { 'X-Log-Company-ID': context.companyId.slice(0, 256) } : {}),
    ...(context.stage ? { 'X-Log-Stage': context.stage.slice(0, 256) } : {}),
  };
}

export async function recordProxyApiResponse(params: {
  url: string;
  requestModel?: string | null;
  requestUsage?: Usage | null;
  response: Response;
}): Promise<void> {
  if (!params.response.ok) return;
  const contentType = params.response.headers.get('content-type') || '';
  let body: any = null;
  if (contentType.includes('application/json')) {
    try {
      body = await params.response.clone().json();
    } catch { /* A request-side quantity can still be enough for TTS. */ }
  }
  const usage = (body?.usage || params.requestUsage) as Usage | undefined;
  if (!usage || typeof usage !== 'object') return;
  const responseModel = String(body.model || '').trim();
  const model = params.requestModel?.includes('/') ? params.requestModel : (responseModel || params.requestModel || 'unknown');
  const externalId = String(params.response.headers.get('x-request-id') || body.id || '').trim();
  if (!externalId) return;
  const context = currentCostContext();
  const inputUnits = Math.round(num(usage.prompt_tokens ?? usage.input_tokens));
  const outputUnits = Math.round(num(usage.completion_tokens ?? usage.output_tokens));
  const characters = Math.round(num((usage as any).characters ?? (usage as any).input_characters));
  const occurredAt = new Date();
  const calculated = await calculateProxyApiAmount(model, usage, occurredAt);
  const amountRub = calculated?.amountRub ?? null;
  await prisma.costEvent.upsert({
    where: { provider_externalId: { provider: 'proxyapi', externalId } },
    create: {
      provider: 'proxyapi',
      category: categoryFromUrl(params.url),
      stage: context?.stage ?? null,
      entityType: context?.entityType ?? null,
      entityId: context?.entityId ?? null,
      companyId: context?.companyId ?? null,
      externalId,
      model,
      inputUnits: inputUnits || null,
      outputUnits: outputUnits || null,
      quantity: num(usage.total_tokens) || inputUnits + outputUnits || num(usage.seconds) || characters || null,
      quantityUnit: num(usage.total_tokens) || inputUnits + outputUnits ? 'tokens' : num(usage.seconds) ? 'seconds' : characters ? 'characters' : null,
      amountOriginal: amountRub ?? 0,
      currency: 'RUB',
      amountRub,
      tariffId: calculated?.tariffId ?? null,
      tariffEffectiveAt: calculated?.tariffEffectiveAt ?? null,
      status: 'estimated',
      rawJson: JSON.stringify({ usage }),
      occurredAt,
    },
    update: {
      model,
      inputUnits: inputUnits || null,
      outputUnits: outputUnits || null,
      amountOriginal: amountRub ?? 0,
      amountRub,
      tariffId: calculated?.tariffId ?? null,
      tariffEffectiveAt: calculated?.tariffEffectiveAt ?? null,
      rawJson: JSON.stringify({ usage }),
      syncedAt: new Date(),
    },
  });
}
