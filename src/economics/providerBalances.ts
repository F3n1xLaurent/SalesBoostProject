import { prisma } from '../db';
import { config } from '../config';
import { resolveExchangeRate } from './exchangeRates';
import { fetchElevenLabs } from '../voice/elevenLabsHttp';

const HOUR_MS = 60 * 60 * 1000;
let schedulerStarted = false;

type BalanceInput = {
  provider: 'proxyapi' | 'elevenlabs' | 'voximplant';
  balance: number;
  used?: number | null;
  limit?: number | null;
  unit: 'money' | 'credits';
  currency?: string | null;
  resetAt?: Date | null;
  raw: Record<string, unknown>;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hourStart(value: Date): Date {
  return new Date(Math.floor(value.getTime() / HOUR_MS) * HOUR_MS);
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  return currency === 'RUR' ? 'RUB' : currency;
}

export function parseProxyApiBalance(value: any): BalanceInput {
  const balance = finite(value?.balance);
  if (balance == null) throw new Error('ProxyAPI balance response has no balance');
  return {
    provider: 'proxyapi', balance, unit: 'money', currency: 'RUB',
    used: finite(value?.budget?.used), limit: finite(value?.budget?.limit),
    raw: { balance, ...(value?.budget ? { budget: value.budget } : {}) },
  };
}

export function parseElevenLabsBalance(value: any): BalanceInput {
  const used = finite(value?.character_count);
  const limit = finite(value?.character_limit);
  if (used == null || limit == null) throw new Error('ElevenLabs subscription response has no credit usage');
  const resetUnix = finite(value?.next_character_count_reset_unix);
  return {
    provider: 'elevenlabs', balance: Math.max(0, limit - used), used, limit,
    unit: 'credits', resetAt: resetUnix ? new Date(resetUnix * 1000) : null,
    raw: {
      tier: value?.tier ?? null, status: value?.status ?? null,
      character_count: used, character_limit: limit,
      next_character_count_reset_unix: resetUnix,
    },
  };
}

export function parseVoximplantBalance(value: any): BalanceInput {
  const result = value?.result || value;
  const balance = finite(result?.balance);
  if (balance == null) throw new Error('Voximplant account response has no balance');
  const currency = normalizeCurrency(String(result?.currency || process.env.VOX_COST_CURRENCY || 'RUB'));
  return {
    provider: 'voximplant', balance, unit: 'money', currency,
    limit: finite(result?.credit_limit),
    raw: { balance, currency, credit_limit: finite(result?.credit_limit) },
  };
}

async function fetchProxyApiBalance(): Promise<BalanceInput | null> {
  if (!config.proxyApiKey) return null;
  const response = await fetch('https://api.proxyapi.ru/proxyapi/balance', {
    headers: { Authorization: `Bearer ${config.proxyApiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ProxyAPI balance HTTP ${response.status}`);
  return parseProxyApiBalance(await response.json());
}

async function fetchElevenLabsBalance(): Promise<BalanceInput | null> {
  if (!config.elevenLabsApiKey) return null;
  const response = await fetchElevenLabs('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': config.elevenLabsApiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'manual',
  });
  if (!response.ok) {
    const location = response.headers.get('location');
    const body = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(
      `ElevenLabs subscription HTTP ${response.status}`
      + `${location ? ` redirect=${location}` : ''}`
      + `${body ? `: ${body}` : ''}`,
    );
  }
  return parseElevenLabsBalance(await response.json());
}

async function fetchVoximplantBalance(): Promise<BalanceInput | null> {
  if (!config.voxAccountId || !config.voxApiKey) return null;
  const form = new URLSearchParams({
    account_id: config.voxAccountId, api_key: config.voxApiKey, output: 'json',
  });
  const response = await fetch('https://api.voximplant.com/platform_api/GetAccountInfo', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Voximplant account HTTP ${response.status}`);
  const body = await response.json() as any;
  if (body?.error) throw new Error(`Voximplant account error: ${body.error?.msg || body.error}`);
  return parseVoximplantBalance(body);
}

async function storeBalance(input: BalanceInput, capturedAt = new Date()): Promise<void> {
  let balanceRub: number | null = null;
  let exchangeRateToRub: number | null = null;
  let exchangeRateDate: Date | null = null;
  let exchangeRateSource: string | null = null;
  if (input.unit === 'money' && input.currency) {
    const resolved = await resolveExchangeRate(input.currency, capturedAt);
    if (resolved) {
      balanceRub = Math.round(input.balance * resolved.rate * 1_000_000) / 1_000_000;
      exchangeRateToRub = resolved.rate;
      exchangeRateDate = resolved.rateDate;
      exchangeRateSource = resolved.source;
    }
  }
  const data = {
    balance: input.balance, used: input.used ?? null, limit: input.limit ?? null,
    unit: input.unit, currency: input.currency ?? null, balanceRub,
    exchangeRateToRub, exchangeRateDate, exchangeRateSource,
    resetAt: input.resetAt ?? null, capturedAt, rawJson: JSON.stringify(input.raw),
  };
  await prisma.providerBalanceSnapshot.upsert({
    where: { provider_capturedHour: { provider: input.provider, capturedHour: hourStart(capturedAt) } },
    create: { provider: input.provider, capturedHour: hourStart(capturedAt), ...data },
    update: data,
  });
}

export async function refreshProviderBalances(): Promise<{
  synced: string[];
  skipped: string[];
  errors: Array<{ provider: string; message: string }>;
}> {
  const tasks = [
    ['proxyapi', fetchProxyApiBalance],
    ['elevenlabs', fetchElevenLabsBalance],
    ['voximplant', fetchVoximplantBalance],
  ] as const;
  const synced: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ provider: string; message: string }> = [];
  await Promise.all(tasks.map(async ([provider, fetchBalance]) => {
    try {
      const balance = await fetchBalance();
      if (!balance) { skipped.push(provider); return; }
      await storeBalance(balance);
      synced.push(provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ provider, message });
      console.warn(`[economics] ${provider} balance refresh failed:`, message);
    }
  }));
  console.info(`[economics] balances refreshed providers=${synced.length} skipped=${skipped.length} errors=${errors.length}`);
  return { synced, skipped, errors };
}

export function startProviderBalanceScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  void refreshProviderBalances().catch((error) => {
    console.warn('[economics] initial balance refresh failed:', error instanceof Error ? error.message : error);
  });
  const timer = setInterval(() => {
    void refreshProviderBalances().catch((error) => {
      console.warn('[economics] scheduled balance refresh failed:', error instanceof Error ? error.message : error);
    });
  }, HOUR_MS);
  timer.unref?.();
}
