import { createHash } from 'node:crypto';
import { prisma } from '../db';
import { config } from '../config';

const PROVIDER = 'proxyapi';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
let schedulerStarted = false;

export type TariffRate = {
  price: number;
  unit: 'million_tokens' | 'million_characters' | 'minute' | 'second' | 'request';
};

export type ProxyApiRates = Record<string, TariffRate>;

type Usage = Record<string, any>;

function textFromHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|\u00a0/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberFromPrice(value: string): number | null {
  const match = value.replace(/[\u00a0\u202f]/g, ' ').match(/(\d[\d\s]*?(?:[,.]\d+)?)\s*₽/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rateUnit(value: string): TariffRate['unit'] | null {
  const normalized = value.toLowerCase();
  if (/1м|миллион/.test(normalized) && /символ/.test(normalized)) return 'million_characters';
  if (/1м|миллион/.test(normalized) && /токен/.test(normalized)) return 'million_tokens';
  if (/минут/.test(normalized)) return 'minute';
  if (/секунд/.test(normalized)) return 'second';
  if (/запрос/.test(normalized)) return 'request';
  return null;
}

function rateKey(labelValue: string): string | null {
  const label = labelValue.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (label.includes('расш') && label.includes('кэш') && label.includes('чтение')) return 'extended_cache_read_input_tokens';
  if (label.includes('кэш') && label.includes('запись') && /272k|расш/.test(label)) return 'extended_cache_write_input_tokens';
  if (label.includes('кэш') && label.includes('чтение')) return 'cache_read_input_tokens';
  if (label.includes('кэш') && label.includes('запись')) return 'cache_write_input_tokens';
  if (label.includes('аудио') && (label.includes('ввод') || label.includes('входящ'))) return 'input_audio';
  if (label.includes('аудио') && (label.includes('вывод') || label.includes('исходящ'))) return 'audio_output';
  if (label.includes('ввод') && /272k|расш/.test(label)) return 'extended_input_tokens';
  if (label.includes('вывод') && /272k|расш/.test(label)) return 'extended_output_tokens';
  if (label === 'ввод' || label.startsWith('ввод ')) return 'input_tokens';
  if (label === 'вывод' || label.startsWith('вывод ')) return 'output_tokens';
  if (label.includes('рассужден')) return 'reasoning_tokens';
  if (label.includes('распознаван') || label.includes('транскриб')) return 'input_audio';
  if (label.includes('синтез') || label.includes('символ')) return 'input_characters';
  if (label.includes('поиск')) return 'web_search';
  return null;
}

export function parseProxyApiTariffPage(html: string, expectedModel?: string): {
  model: string;
  currency: 'RUB';
  rates: ProxyApiRates;
} {
  let model = expectedModel || '';
  for (const script of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(script[1]);
      const graph = Array.isArray(value?.['@graph']) ? value['@graph'] : [value];
      const product = graph.find((item: any) => item?.['@type'] === 'Product');
      if (typeof product?.sku === 'string') model = product.sku;
    } catch { /* Ignore unrelated structured data. */ }
  }
  if (!model || (expectedModel && model !== expectedModel)) throw new Error(`ProxyAPI tariff model mismatch: expected ${expectedModel || 'model'}, got ${model || 'none'}`);

  const rates: ProxyApiRates = {};
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => textFromHtml(cell[1]));
    if (cells.length < 3) continue;
    const price = numberFromPrice(cells[1]); // Normal tariff; the next cell is batch pricing.
    const unit = rateUnit(cells.at(-1) || '');
    let key = rateKey(cells[0]);
    if (key === 'input_tokens' && unit === 'million_characters') key = 'input_characters';
    if (key === 'input_tokens' && (unit === 'minute' || unit === 'second')) key = 'input_audio';
    if (key && price != null && unit) rates[key] = { price, unit };
  }

  // JSON-LD is a stable fallback when the rendered table changes its markup.
  for (const script of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(script[1]);
      const graph = Array.isArray(value?.['@graph']) ? value['@graph'] : [value];
      const product = graph.find((item: any) => item?.['@type'] === 'Product');
      for (const offer of Array.isArray(product?.offers) ? product.offers : []) {
        if (offer?.priceCurrency !== 'RUB') continue;
        const price = Number(offer.price);
        const description = String(offer.description || '');
        const unit = rateUnit(description);
        let key = rateKey(description.split(',')[0]);
        if (key === 'input_tokens' && unit === 'million_characters') key = 'input_characters';
        if (key === 'input_tokens' && (unit === 'minute' || unit === 'second')) key = 'input_audio';
        if (key && unit && Number.isFinite(price) && !rates[key]) rates[key] = { price, unit };
      }
    } catch { /* Ignore unrelated structured data. */ }
  }
  if (!rates.input_tokens && !rates.input_audio && !rates.input_characters) {
    throw new Error(`ProxyAPI tariff page for ${model} contains no supported rates`);
  }
  return { model, currency: 'RUB', rates };
}

export async function fetchAndStoreProxyApiTariff(modelValue: string): Promise<string> {
  const model = modelValue.trim();
  if (!model.includes('/')) throw new Error(`ProxyAPI model must include vendor: ${model}`);
  const sourceUrl = `https://proxyapi.ru/models/${model.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(sourceUrl, {
    headers: { Accept: 'text/html', 'User-Agent': 'SalesBoost economics/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`ProxyAPI tariff HTTP ${response.status} for ${model}`);
  const parsed = parseProxyApiTariffPage(await response.text(), model);
  const ratesJson = JSON.stringify(Object.fromEntries(Object.entries(parsed.rates).sort(([a], [b]) => a.localeCompare(b))));
  const rawHash = createHash('sha256').update(`${parsed.currency}:${ratesJson}`).digest('hex');
  const existing = await prisma.providerTariff.findUnique({
    where: { provider_model_rawHash: { provider: PROVIDER, model, rawHash } },
  });
  if (existing) {
    await prisma.providerTariff.update({ where: { id: existing.id }, data: { lastSeenAt: new Date(), sourceUrl } });
    return existing.id;
  }
  const created = await prisma.providerTariff.create({
    data: { provider: PROVIDER, model, currency: parsed.currency, ratesJson, rawHash, sourceUrl },
  });
  return created.id;
}

function units(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function charge(rate: TariffRate | undefined, quantity: number): number {
  if (!rate || !quantity) return 0;
  if (rate.unit === 'million_tokens' || rate.unit === 'million_characters') return quantity * rate.price / 1_000_000;
  if (rate.unit === 'minute') return quantity * rate.price / 60;
  return quantity * rate.price;
}

export async function calculateProxyApiAmount(model: string, usage: Usage, occurredAt: Date): Promise<{
  amountRub: number;
  tariffId: string;
  tariffEffectiveAt: Date;
} | null> {
  const canonicalModel = model.includes('/') ? model : `openai/${model}`;
  const tariff = await prisma.providerTariff.findFirst({
    where: { provider: PROVIDER, model: canonicalModel, effectiveAt: { lte: occurredAt } },
    orderBy: { effectiveAt: 'desc' },
  }) || await prisma.providerTariff.findFirst({
    where: { provider: PROVIDER, model: canonicalModel, effectiveAt: { gt: occurredAt } },
    orderBy: { effectiveAt: 'asc' },
  });
  if (!tariff) return null;
  const rates = JSON.parse(tariff.ratesJson) as ProxyApiRates;
  const input = units(usage.prompt_tokens ?? usage.input_tokens);
  const output = units(usage.completion_tokens ?? usage.output_tokens);
  const cached = Math.min(input, units(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens));
  const cacheWrite = Math.min(input - cached, units(usage.prompt_tokens_details?.cache_write_tokens ?? usage.input_tokens_details?.cache_write_tokens));
  const reasoning = Math.min(output, units(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens));
  const audioInputTokens = Math.min(input - cached - cacheWrite, units(usage.prompt_tokens_details?.audio_tokens ?? usage.input_tokens_details?.audio_tokens));
  const audioOutputTokens = Math.min(output - reasoning, units(usage.completion_tokens_details?.audio_tokens ?? usage.output_tokens_details?.audio_tokens));
  const regularInput = Math.max(0, input - cached - cacheWrite - (rates.audio_input ? audioInputTokens : 0));
  const regularOutput = Math.max(0, output - (rates.reasoning_tokens ? reasoning : 0) - (rates.audio_output ? audioOutputTokens : 0));
  const seconds = units(usage.seconds ?? usage.input_seconds);
  const characters = units(usage.characters ?? usage.input_characters);
  const amount =
    charge(rates.input_tokens, regularInput)
    + charge(rates.cache_read_input_tokens || rates.input_tokens, cached)
    + charge(rates.cache_write_input_tokens || rates.input_tokens, cacheWrite)
    + charge(rates.output_tokens, regularOutput)
    + charge(rates.reasoning_tokens || rates.output_tokens, reasoning)
    + charge(rates.audio_input, audioInputTokens)
    + charge(rates.audio_output, audioOutputTokens)
    + charge(rates.input_audio, seconds)
    + charge(rates.input_characters, characters)
    + charge(rates.web_search, units(usage.web_search_requests));
  return { amountRub: Math.round(amount * 1_000_000) / 1_000_000, tariffId: tariff.id, tariffEffectiveAt: tariff.effectiveAt };
}

export async function backfillProxyApiEstimatedCosts(): Promise<number> {
  const events = await prisma.costEvent.findMany({
    where: { provider: PROVIDER, status: 'estimated', tariffId: null, model: { not: null } },
  });
  let updated = 0;
  for (const event of events) {
    let usage: Usage | null = null;
    try { usage = event.rawJson ? JSON.parse(event.rawJson).usage : null; } catch { /* keep unresolved */ }
    if (!usage || !event.model) continue;
    const calculated = await calculateProxyApiAmount(event.model, usage, event.occurredAt);
    if (!calculated) continue;
    await prisma.costEvent.update({
      where: { id: event.id },
      data: {
        amountOriginal: calculated.amountRub, amountRub: calculated.amountRub,
        tariffId: calculated.tariffId, tariffEffectiveAt: calculated.tariffEffectiveAt,
      },
    });
    updated += 1;
  }
  return updated;
}

export async function refreshProxyApiTariffs(): Promise<{ models: number; errors: number; recalculated: number }> {
  const configured = [config.openaiChatModel, config.openaiImportModel, config.openaiSttModel, config.openaiTtsModel];
  const used = await prisma.costEvent.findMany({
    where: { provider: PROVIDER, model: { not: null } }, distinct: ['model'], select: { model: true },
  });
  const models = [...new Set([...configured, ...used.map((row) => row.model || '')]
    .filter(Boolean)
    .map((model) => model.includes('/') ? model : `openai/${model}`))];
  let errors = 0;
  for (const model of models) {
    try { await fetchAndStoreProxyApiTariff(model); } catch (error) {
      errors += 1;
      console.warn(`[economics] ProxyAPI tariff refresh failed model=${model}:`, error instanceof Error ? error.message : error);
    }
  }
  const recalculated = await backfillProxyApiEstimatedCosts();
  console.info(`[economics] ProxyAPI tariffs refreshed models=${models.length - errors} errors=${errors} recalculated=${recalculated}`);
  return { models: models.length - errors, errors, recalculated };
}

export function startProxyApiTariffScheduler(): void {
  if (schedulerStarted || config.aiApiProvider !== 'proxyapi') return;
  schedulerStarted = true;
  void refreshProxyApiTariffs().catch((error) => {
    console.warn('[economics] initial ProxyAPI tariff refresh failed:', error instanceof Error ? error.message : error);
  });
  const timer = setInterval(() => {
    void refreshProxyApiTariffs().catch((error) => {
      console.warn('[economics] scheduled ProxyAPI tariff refresh failed:', error instanceof Error ? error.message : error);
    });
  }, REFRESH_INTERVAL_MS);
  timer.unref?.();
}
