import { prisma } from '../db';
import { config } from '../config';
import { fetchElevenLabs } from '../voice/elevenLabsHttp';
import { getCallHistory } from '../voice/voximplantRecordingService';
import { resolveExchangeRate } from './exchangeRates';

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function toRub(amount: number, currency: string, occurredAt: Date): Promise<{
  amountRub: number | null;
  rate: number | null;
  rateDate: Date | null;
  source: string | null;
}> {
  const resolved = await resolveExchangeRate(currency, occurredAt);
  if (!resolved) return { amountRub: null, rate: null, rateDate: null, source: null };
  return {
    amountRub: Math.round(amount * resolved.rate * 1_000_000) / 1_000_000,
    rate: resolved.rate,
    rateDate: resolved.rateDate,
    source: resolved.source,
  };
}

function sumNamedCosts(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + sumNamedCosts(item), 0);
  if (!value || typeof value !== 'object') return 0;
  let result = 0;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'cost') result += finite(nested) ?? 0;
    else if (nested && typeof nested === 'object') result += sumNamedCosts(nested);
  }
  return result;
}

type VoximplantTransaction = {
  transaction_id?: unknown;
  transaction_type?: unknown;
  transaction_description?: unknown;
  amount?: unknown;
  currency?: unknown;
  performed_at?: unknown;
  [key: string]: unknown;
};

const VOX_TRANSACTION_CATEGORIES: Record<string, string> = {
  resource_charge: 'usage',
  phone_number_charge: 'phone_number',
  toll_free_phone_number_charge: 'phone_number',
  phone_number_installation: 'phone_number_setup',
  toll_free_phone_number_installation: 'phone_number_setup',
  subscription_charge: 'subscription',
  subscription_installation_charge: 'subscription_setup',
  sip_registration_charge: 'sip_registration',
  tax_charge: 'tax',
  monthly_fee_charge: 'monthly_fee',
};

function parseVoxDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseVoximplantExpense(value: VoximplantTransaction): {
  externalId: string;
  category: string;
  type: string;
  amount: number;
  currency: string;
  occurredAt: Date;
} | null {
  const transactionId = String(value.transaction_id ?? '').trim();
  const type = String(value.transaction_type ?? '').trim();
  const rawAmount = Number(value.amount);
  const occurredAt = parseVoxDate(value.performed_at);
  if (!transactionId || !type || !Number.isFinite(rawAmount) || rawAmount >= 0 || !occurredAt) return null;
  const currencyValue = String(value.currency || process.env.VOX_COST_CURRENCY || 'RUB').toUpperCase();
  return {
    externalId: `transaction:${transactionId}`,
    category: VOX_TRANSACTION_CATEGORIES[type] || 'account',
    type,
    amount: Math.abs(rawAmount),
    currency: currencyValue === 'RUR' ? 'RUB' : currencyValue,
    occurredAt,
  };
}

function voxDate(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

export async function syncVoximplantTransactions(days = 90): Promise<{ imported: number; skipped: number }> {
  if (!config.voxAccountId || !config.voxApiKey) return { imported: 0, skipped: 0 };
  const latest = await prisma.costEvent.findFirst({
    where: { provider: 'voximplant', stage: 'account_transaction' },
    orderBy: { occurredAt: 'desc' }, select: { occurredAt: true },
  });
  const now = new Date();
  const earliest = new Date(now.getTime() - Math.max(1, days) * 86_400_000);
  const from = latest
    ? new Date(Math.max(earliest.getTime(), latest.occurredAt.getTime() - 2 * 86_400_000))
    : earliest;
  const rows: VoximplantTransaction[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset <= 10_000; offset += pageSize) {
    const form = new URLSearchParams({
      account_id: config.voxAccountId, api_key: config.voxApiKey,
      from_date: voxDate(from), to_date: voxDate(now), timezone: 'Etc/GMT',
      count: String(pageSize), offset: String(offset), desc_order: 'false',
      with_extended_info: 'true', with_total_count: 'true', output: 'json',
    });
    const response = await fetch('https://api.voximplant.com/platform_api/GetTransactionHistory', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GetTransactionHistory HTTP ${response.status}`);
    const body = await response.json() as any;
    if (body?.error) throw new Error(`GetTransactionHistory error: ${body.error?.msg || body.error}`);
    const page = Array.isArray(body?.result) ? body.result as VoximplantTransaction[] : [];
    rows.push(...page);
    if (page.length < pageSize || rows.length >= Number(body?.total_count || 0)) break;
  }
  let imported = 0;
  let skipped = 0;
  const conversionCache = new Map<string, Awaited<ReturnType<typeof toRub>>>();
  for (const row of rows) {
    const expense = parseVoximplantExpense(row);
    if (!expense) { skipped += 1; continue; }
    const conversionKey = `${expense.currency}:${expense.occurredAt.toISOString().slice(0, 10)}:${expense.amount}`;
    let converted = conversionCache.get(conversionKey);
    if (!converted) {
      converted = await toRub(expense.amount, expense.currency, expense.occurredAt);
      conversionCache.set(conversionKey, converted);
    }
    await prisma.costEvent.upsert({
      where: { provider_externalId: { provider: 'voximplant', externalId: expense.externalId } },
      create: {
        provider: 'voximplant', category: expense.category, stage: 'account_transaction',
        externalId: expense.externalId, model: expense.type,
        amountOriginal: expense.amount, currency: expense.currency,
        amountRub: converted.amountRub, exchangeRateToRub: converted.rate,
        exchangeRateDate: converted.rateDate, exchangeRateSource: converted.source,
        includedInTotals: true, status: 'confirmed', rawJson: JSON.stringify(row), occurredAt: expense.occurredAt,
      },
      update: {
        category: expense.category, model: expense.type,
        amountOriginal: expense.amount, currency: expense.currency,
        amountRub: converted.amountRub, exchangeRateToRub: converted.rate,
        exchangeRateDate: converted.rateDate, exchangeRateSource: converted.source,
        includedInTotals: true, status: 'confirmed', rawJson: JSON.stringify(row), syncedAt: new Date(),
      },
    });
    imported += 1;
  }
  return { imported, skipped };
}

export async function syncVoximplantCost(callId: string): Promise<boolean> {
  const session = await prisma.voiceCallSession.findUnique({
    where: { callId },
    include: { dealership: { select: { holdingId: true } } },
  });
  if (!session?.voxSessionId) return false;
  const history = await getCallHistory(session.voxSessionId);
  const result = history.result?.[0] as Record<string, unknown> | undefined;
  if (!result) return false;
  const amount = sumNamedCosts({ calls: result.calls, other_resource_usage: result.other_resource_usage });
  const currency = String(result.currency || process.env.VOX_COST_CURRENCY || 'RUB').toUpperCase();
  const converted = await toRub(amount, currency, session.startedAt);
  await prisma.costEvent.upsert({
    where: { provider_externalId: { provider: 'voximplant', externalId: session.voxSessionId } },
    create: {
      provider: 'voximplant', category: 'telephony', stage: 'call', entityType: 'voice_call', entityId: callId,
      companyId: session.dealership?.holdingId ?? null, externalId: session.voxSessionId,
      quantity: session.durationSec ?? session.talkDurationSec, quantityUnit: 'seconds',
      amountOriginal: amount, currency, amountRub: converted.amountRub, exchangeRateToRub: converted.rate,
      exchangeRateDate: converted.rateDate, exchangeRateSource: converted.source,
      includedInTotals: false, status: 'confirmed', rawJson: JSON.stringify(result), occurredAt: session.startedAt,
    },
    update: {
      amountOriginal: amount, currency, amountRub: converted.amountRub, exchangeRateToRub: converted.rate,
      exchangeRateDate: converted.rateDate, exchangeRateSource: converted.source,
      includedInTotals: false, status: 'confirmed', rawJson: JSON.stringify(result), syncedAt: new Date(),
      companyId: session.dealership?.holdingId ?? null,
    },
  });
  return true;
}

export async function syncElevenLabsCost(sessionId: string): Promise<boolean> {
  if (!config.elevenLabsApiKey) return false;
  const session = await prisma.trainerSession.findUnique({ where: { id: sessionId }, include: { branch: { select: { holdingId: true } } } });
  if (!session?.elevenLabsConversationId) return false;
  const response = await fetchElevenLabs(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(session.elevenLabsConversationId)}`, {
    headers: { 'xi-api-key': config.elevenLabsApiKey },
    signal: AbortSignal.timeout(15_000),
    redirect: 'manual',
  });
  if (!response.ok) {
    const location = response.headers.get('location');
    const body = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(
      `ElevenLabs conversation cost HTTP ${response.status}`
      + `${location ? ` redirect=${location}` : ''}`
      + `${body ? `: ${body}` : ''}`,
    );
  }
  const body = await response.json() as any;
  if (body.status === 'processing') return false;
  const amount = finite(body.metadata?.cost_fiat);
  if (amount == null) return false;
  const currency = String(process.env.ELEVENLABS_COST_CURRENCY || 'USD').toUpperCase();
  const converted = await toRub(amount, currency, session.startedAt);
  await prisma.costEvent.upsert({
    where: { provider_externalId: { provider: 'elevenlabs', externalId: session.elevenLabsConversationId } },
    create: {
      provider: 'elevenlabs', category: 'agent', stage: 'dialog', entityType: 'trainer_session', entityId: session.id,
      companyId: session.companyId || session.branch?.holdingId, externalId: session.elevenLabsConversationId,
      quantity: finite(body.metadata?.call_duration_secs) ?? session.durationSec, quantityUnit: 'seconds',
      amountOriginal: amount, currency, amountRub: converted.amountRub, exchangeRateToRub: converted.rate,
      exchangeRateDate: converted.rateDate, exchangeRateSource: converted.source,
      status: 'confirmed', rawJson: JSON.stringify({ status: body.status, metadata: body.metadata }), occurredAt: session.startedAt,
    },
    update: {
      amountOriginal: amount, currency, amountRub: converted.amountRub, exchangeRateToRub: converted.rate,
      exchangeRateDate: converted.rateDate, exchangeRateSource: converted.source,
      status: 'confirmed', rawJson: JSON.stringify({ status: body.status, metadata: body.metadata }), syncedAt: new Date(),
      companyId: session.companyId || session.branch?.holdingId,
    },
  });
  return true;
}

export async function syncRecentProviderCosts(days: number): Promise<{ vox: number; voxTransactions: number; elevenLabs: number; errors: number }> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [calls, trainings, existing] = await Promise.all([
    prisma.voiceCallSession.findMany({ where: { startedAt: { gte: since }, voxSessionId: { not: null } }, select: { callId: true } }),
    prisma.trainerSession.findMany({ where: { startedAt: { gte: since }, elevenLabsConversationId: { not: null } }, select: { id: true } }),
    prisma.costEvent.findMany({ where: { provider: { in: ['voximplant', 'elevenlabs'] }, occurredAt: { gte: since }, status: 'confirmed' }, select: { provider: true, entityId: true } }),
  ]);
  const synced = new Set(existing.map((event) => `${event.provider}:${event.entityId}`));
  const pendingCalls = calls.filter((call) => !synced.has(`voximplant:${call.callId}`));
  const pendingTrainings = trainings.filter((training) => !synced.has(`elevenlabs:${training.id}`));
  let vox = 0;
  let elevenLabs = 0;
  let voxTransactions = 0;
  let errors = 0;
  const runLimited = async <T>(items: T[], task: (item: T) => Promise<void>) => {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await task(item);
      }
    }));
  };
  await runLimited(pendingCalls, async (call) => {
    try { if (await syncVoximplantCost(call.callId)) vox += 1; } catch { errors += 1; }
  });
  await runLimited(pendingTrainings, async (training) => {
    try { if (await syncElevenLabsCost(training.id)) elevenLabs += 1; } catch { errors += 1; }
  });
  try {
    const result = await syncVoximplantTransactions(Math.max(days, 90));
    voxTransactions = result.imported;
  } catch (error) {
    errors += 1;
    console.warn('[economics] Voximplant transaction sync failed:', error instanceof Error ? error.message : error);
  }
  return { vox, voxTransactions, elevenLabs, errors };
}

export async function importProxyApiLogs(ndjson: string): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  for (const line of ndjson.split(/\r?\n/).filter((item) => item.trim())) {
    let item: any;
    try { item = JSON.parse(line); } catch { skipped += 1; continue; }
    const externalId = String(item.id || item.request_id || '').trim();
    const amount = finite(item.amount);
    if (!externalId || amount == null) { skipped += 1; continue; }
    const custom = item.meta?.custom || item.custom || {};
    const customValue = (name: string): string | null => {
      const target = name.toLowerCase().replace(/^x-log-/, '').replace(/_/g, '-');
      const match = Object.entries(custom).find(([key]) => key.toLowerCase().replace(/^x-log-/, '').replace(/_/g, '-') === target);
      return match && match[1] != null ? String(match[1]) : null;
    };
    const existing = await prisma.costEvent.findUnique({ where: { provider_externalId: { provider: 'proxyapi', externalId } } });
    const entityType = existing?.entityType || customValue('entity-type');
    const entityId = existing?.entityId || customValue('entity-id');
    const companyId = existing?.companyId || customValue('company-id');
    const occurredAt = item.created_at && !Number.isNaN(new Date(item.created_at).getTime()) ? new Date(item.created_at) : existing?.occurredAt || new Date();
    await prisma.costEvent.upsert({
      where: { provider_externalId: { provider: 'proxyapi', externalId } },
      create: {
        provider: 'proxyapi', category: String(item.endpoint || '').includes('transcriptions') ? 'stt' : 'llm',
        stage: customValue('stage'), entityType, entityId, companyId, externalId,
        model: item.model || item.snapshot || null, amountOriginal: amount, currency: 'RUB', amountRub: amount,
        exchangeRateToRub: 1, status: 'confirmed', rawJson: JSON.stringify(item), occurredAt,
      },
      update: {
        amountOriginal: amount, currency: 'RUB', amountRub: amount, exchangeRateToRub: 1,
        status: 'confirmed', rawJson: JSON.stringify(item), syncedAt: new Date(), entityType, entityId, companyId,
      },
    });
    imported += 1;
  }
  return { imported, skipped };
}

const scheduledProviderSyncs = new Set<string>();

function scheduleProviderSync(key: string, task: () => Promise<boolean>): void {
  if (scheduledProviderSyncs.has(key)) return;
  scheduledProviderSyncs.add(key);
  const delays = [15_000, 60_000, 180_000];
  void (async () => {
    try {
      for (const delay of delays) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
        try {
          if (await task()) return;
        } catch (error) {
          console.warn(`[economics] provider sync failed key=${key}:`, error instanceof Error ? error.message : error);
        }
      }
    } finally {
      scheduledProviderSyncs.delete(key);
    }
  })();
}

export function scheduleVoximplantCostSync(callId: string): void {
  scheduleProviderSync(`vox:${callId}`, () => syncVoximplantCost(callId));
}

export function scheduleElevenLabsCostSync(sessionId: string): void {
  scheduleProviderSync(`eleven:${sessionId}`, () => syncElevenLabsCost(sessionId));
}

let voxTransactionSchedulerStarted = false;

export function startVoximplantTransactionScheduler(): void {
  if (voxTransactionSchedulerStarted || !config.voxAccountId || !config.voxApiKey) return;
  voxTransactionSchedulerStarted = true;
  void syncVoximplantTransactions().then((result) => {
    console.info(`[economics] Voximplant transactions synced=${result.imported} skipped=${result.skipped}`);
  }).catch((error) => {
    console.warn('[economics] initial Voximplant transaction sync failed:', error instanceof Error ? error.message : error);
  });
  const timer = setInterval(() => {
    void syncVoximplantTransactions(3).catch((error) => {
      console.warn('[economics] scheduled Voximplant transaction sync failed:', error instanceof Error ? error.message : error);
    });
  }, 60 * 60 * 1000);
  timer.unref?.();
}
