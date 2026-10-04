import { prisma } from '../db';

const CBR_DAILY_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const DAY_MS = 86_400_000;
const SOURCE = 'cbr';
let schedulerStarted = false;

export type ResolvedExchangeRate = {
  rate: number;
  rateDate: Date;
  source: string;
};

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  return currency === 'RUR' ? 'RUB' : currency;
}

function moscowDateKey(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
}

function dateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

function cbrDate(value: Date): string {
  const [year, month, day] = moscowDateKey(value).split('-');
  return `${day}/${month}/${year}`;
}

function parseCbrDate(value: string): Date | null {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00.000Z`) : null;
}

function parseNumber(value: string): number | null {
  const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseCbrDailyRates(xml: string, currencies: string[]): {
  effectiveDate: Date;
  rates: Array<{ currency: string; rate: number }>;
} {
  const wanted = new Set(currencies.map(normalizeCurrency).filter((currency) => currency !== 'RUB'));
  const effectiveDate = parseCbrDate(xml.match(/<ValCurs[^>]*\bDate="([^"]+)"/i)?.[1] || '');
  if (!effectiveDate) throw new Error('CBR response does not contain a valid rate date');
  const rates: Array<{ currency: string; rate: number }> = [];
  for (const block of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/gi)) {
    const body = block[1];
    const currency = normalizeCurrency(body.match(/<CharCode>([^<]+)<\/CharCode>/i)?.[1] || '');
    if (!wanted.has(currency)) continue;
    const nominal = parseNumber(body.match(/<Nominal>([^<]+)<\/Nominal>/i)?.[1] || '');
    const value = parseNumber(body.match(/<Value>([^<]+)<\/Value>/i)?.[1] || '');
    if (nominal && value) rates.push({ currency, rate: value / nominal });
  }
  return { effectiveDate, rates };
}

export async function fetchCbrRatesForDate(date: Date, currencies: string[]): Promise<number> {
  const wanted = new Set(currencies.map(normalizeCurrency).filter((currency) => currency !== 'RUB'));
  if (!wanted.size) return 0;
  const url = new URL(CBR_DAILY_URL);
  url.searchParams.set('date_req', cbrDate(date));
  const response = await fetch(url, {
    headers: { Accept: 'application/xml,text/xml', 'User-Agent': 'SalesBoost economics/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`CBR rates HTTP ${response.status}`);
  const xml = await response.text();
  const parsed = parseCbrDailyRates(xml, [...wanted]);

  let saved = 0;
  for (const { currency, rate } of parsed.rates) {
    await prisma.exchangeRate.upsert({
      where: {
        baseCurrency_quoteCurrency_rateDate_source: {
          baseCurrency: currency, quoteCurrency: 'RUB', rateDate: parsed.effectiveDate, source: SOURCE,
        },
      },
      create: { baseCurrency: currency, quoteCurrency: 'RUB', rate, rateDate: parsed.effectiveDate, source: SOURCE },
      update: { rate, fetchedAt: new Date() },
    });
    saved += 1;
  }
  return saved;
}

async function findStoredRate(currency: string, date: Date): Promise<ResolvedExchangeRate | null> {
  const day = dateFromKey(moscowDateKey(date));
  // Accounting rule: exact date, otherwise the latest rate effective before the transaction.
  const previous = await prisma.exchangeRate.findFirst({
    where: { baseCurrency: currency, quoteCurrency: 'RUB', rateDate: { lte: day } },
    orderBy: { rateDate: 'desc' },
  });
  if (previous) return { rate: previous.rate, rateDate: previous.rateDate, source: previous.source };
  // If history begins later than the transaction, use the first known subsequent rate.
  const next = await prisma.exchangeRate.findFirst({
    where: { baseCurrency: currency, quoteCurrency: 'RUB', rateDate: { gt: day } },
    orderBy: { rateDate: 'asc' },
  });
  return next ? { rate: next.rate, rateDate: next.rateDate, source: next.source } : null;
}

export async function resolveExchangeRate(currencyValue: string, occurredAt: Date): Promise<ResolvedExchangeRate | null> {
  const currency = normalizeCurrency(currencyValue);
  if (currency === 'RUB') {
    return { rate: 1, rateDate: dateFromKey(moscowDateKey(occurredAt)), source: 'identity' };
  }
  // Fetching the requested date first also fills weekends with the rate effective on that date.
  try {
    await fetchCbrRatesForDate(occurredAt, [currency]);
  } catch (error) {
    console.warn(`[economics] failed to fetch ${currency}/RUB from CBR:`, error instanceof Error ? error.message : error);
  }
  return findStoredRate(currency, occurredAt);
}

export async function backfillCostEventExchangeRates(): Promise<{ updated: number; unresolved: number }> {
  const events = await prisma.costEvent.findMany({
    where: {
      exchangeRateDate: null,
      NOT: { currency: { in: ['RUB', 'RUR'] } },
    },
    select: { id: true, currency: true, amountOriginal: true, occurredAt: true },
  });
  const cache = new Map<string, ResolvedExchangeRate | null>();
  let updated = 0;
  let unresolved = 0;
  for (const event of events) {
    const key = `${normalizeCurrency(event.currency)}:${moscowDateKey(event.occurredAt)}`;
    let resolved = cache.get(key);
    if (resolved === undefined) {
      resolved = await resolveExchangeRate(event.currency, event.occurredAt);
      cache.set(key, resolved);
    }
    if (!resolved) {
      unresolved += 1;
      continue;
    }
    await prisma.costEvent.update({
      where: { id: event.id },
      data: {
        amountRub: Math.round(event.amountOriginal * resolved.rate * 1_000_000) / 1_000_000,
        exchangeRateToRub: resolved.rate,
        exchangeRateDate: resolved.rateDate,
        exchangeRateSource: resolved.source,
      },
    });
    updated += 1;
  }
  return { updated, unresolved };
}

export async function refreshDailyExchangeRates(): Promise<void> {
  const currencies = await prisma.costEvent.findMany({
    where: { NOT: { currency: { in: ['RUB', 'RUR'] } } },
    distinct: ['currency'],
    select: { currency: true },
  });
  const requested = [...new Set(['USD', ...currencies.map((row) => normalizeCurrency(row.currency))])];
  await fetchCbrRatesForDate(new Date(), requested);
  const result = await backfillCostEventExchangeRates();
  console.info(`[economics] CBR rates refreshed; cost events updated=${result.updated} unresolved=${result.unresolved}`);
}

export function startExchangeRateScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  void refreshDailyExchangeRates().catch((error) => {
    console.warn('[economics] initial CBR rate refresh failed:', error instanceof Error ? error.message : error);
  });
  const timer = setInterval(() => {
    void refreshDailyExchangeRates().catch((error) => {
      console.warn('[economics] scheduled CBR rate refresh failed:', error instanceof Error ? error.message : error);
    });
  }, DAY_MS);
  timer.unref?.();
}
