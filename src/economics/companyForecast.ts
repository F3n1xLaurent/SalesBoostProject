import { prisma } from '../db';

const MONTH_DAYS = 30;

export type CompanyForecastInput = {
  locations: number;
  employeesPerLocation: number;
  callsPerEmployeePerDay: number;
  averageCallDurationSeconds: number;
};

type Benchmarks = {
  telephonyPerMinute: number[];
  aiPerCall: number[];
  sources: {
    telephonyCalls: number;
    aiCalls: number;
    fallbackTelephony: boolean;
  };
};

function finite(value: unknown, min: number, max: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} должно быть от ${min} до ${max}`);
  }
  return parsed;
}

export function normalizeCompanyForecastInput(value: Partial<CompanyForecastInput>): CompanyForecastInput {
  return {
    locations: Math.round(finite(value.locations, 1, 10_000, 'Количество точек')),
    employeesPerLocation: Math.round(finite(value.employeesPerLocation, 1, 10_000, 'Количество сотрудников')),
    callsPerEmployeePerDay: finite(value.callsPerEmployeePerDay, 0, 1_000, 'Количество звонков'),
    averageCallDurationSeconds: finite(value.averageCallDurationSeconds, 1, 14_400, 'Длительность звонка'),
  };
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function scenarioRate(values: number[], scenario: 'best' | 'median' | 'worst'): number {
  if (scenario === 'best') return percentile(values, 0.1);
  if (scenario === 'median') return percentile(values, 0.5);
  return percentile(values, 1);
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateCompanyForecast(inputValue: Partial<CompanyForecastInput>, benchmarks: Benchmarks) {
  const input = normalizeCompanyForecastInput(inputValue);
  const monthlyCalls = input.locations * input.employeesPerLocation * input.callsPerEmployeePerDay * MONTH_DAYS;
  const monthlyMinutes = monthlyCalls * input.averageCallDurationSeconds / 60;
  const scenarios = (['best', 'median', 'worst'] as const).map((key) => {
    const rates = {
      telephonyPerMinute: scenarioRate(benchmarks.telephonyPerMinute, key),
      aiPerCall: scenarioRate(benchmarks.aiPerCall, key),
    };
    const components = {
      telephony: money(monthlyMinutes * rates.telephonyPerMinute),
      ai: money(monthlyCalls * rates.aiPerCall),
      phoneNumbers: 0,
    };
    return {
      key,
      rates: {
        telephonyPerMinute: money(rates.telephonyPerMinute),
        aiPerCall: money(rates.aiPerCall),
      },
      components,
      totalRub: money(components.telephony + components.ai + components.phoneNumbers),
      averagePerCallRub: monthlyCalls ? money((components.telephony + components.ai + components.phoneNumbers) / monthlyCalls) : 0,
    };
  });
  const warnings: string[] = [];
  if (!benchmarks.telephonyPerMinute.length) warnings.push('Недостаточно данных для расчёта телефонии Voximplant.');
  else if (benchmarks.sources.fallbackTelephony) warnings.push('Ставка телефонии рассчитана агрегированно: детализация затрат по звонкам пока не накоплена.');
  if (!benchmarks.aiPerCall.length) warnings.push('Недостаточно привязанных к звонкам расходов ProxyAPI; AI-составляющая временно равна нулю.');
  return {
    input, monthDays: MONTH_DAYS, monthlyCalls: Math.round(monthlyCalls), monthlyMinutes: money(monthlyMinutes),
    scenarios, warnings, samples: benchmarks.sources,
    assumptions: ['Один общий телефонный номер используется для всех компаний; его аренда не включается в переменную себестоимость подключения компании.'],
    methodology: { best: '10-й перцентиль', median: 'медиана', worst: 'максимум' },
  };
}

export async function getCompanyEconomicsForecast(input: Partial<CompanyForecastInput>) {
  const since90 = new Date(Date.now() - 90 * 86_400_000);
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const [voxAllocations, proxyEvents, recentCalls, voxUsage] = await Promise.all([
    prisma.costEvent.findMany({
      where: { provider: 'voximplant', includedInTotals: false, entityType: 'voice_call', entityId: { not: null }, amountRub: { not: null }, occurredAt: { gte: since90 } },
      select: { entityId: true, amountRub: true },
    }),
    prisma.costEvent.findMany({
      where: { provider: 'proxyapi', entityType: 'voice_call', entityId: { not: null }, amountRub: { not: null }, occurredAt: { gte: since90 } },
      select: { entityId: true, amountRub: true },
    }),
    prisma.voiceCallSession.findMany({
      where: { startedAt: { gte: since90 }, OR: [{ talkDurationSec: { gt: 0 } }, { durationSec: { gt: 0 } }] },
      select: { callId: true, talkDurationSec: true, durationSec: true, startedAt: true },
    }),
    prisma.costEvent.aggregate({
      where: { provider: 'voximplant', includedInTotals: true, category: 'usage', amountRub: { not: null }, occurredAt: { gte: since30 } },
      _sum: { amountRub: true },
    }),
  ]);
  const durations = new Map(recentCalls.map((call) => [call.callId, call.talkDurationSec || call.durationSec || 0]));
  const voxByCall = new Map<string, number>();
  for (const event of voxAllocations) if (event.entityId) voxByCall.set(event.entityId, (voxByCall.get(event.entityId) || 0) + (event.amountRub || 0));
  let telephonyPerMinute = [...voxByCall]
    .map(([callId, amount]) => ({ amount, seconds: durations.get(callId) || 0 }))
    // Very short attempts are dominated by call setup costs and must not be
    // extrapolated as a per-minute rate for an average conversation.
    .filter((item) => item.amount > 0 && item.seconds >= 30)
    .map((item) => item.amount / (item.seconds / 60));
  let fallbackTelephony = false;
  if (!telephonyPerMinute.length) {
    const minutes = recentCalls
      .filter((call) => call.startedAt >= since30)
      .reduce((sum, call) => sum + (call.talkDurationSec || call.durationSec || 0) / 60, 0);
    const amount = voxUsage._sum.amountRub || 0;
    if (minutes > 0 && amount > 0) {
      telephonyPerMinute = [amount / minutes];
      fallbackTelephony = true;
    }
  }
  const aiByCall = new Map<string, number>();
  for (const event of proxyEvents) if (event.entityId) aiByCall.set(event.entityId, (aiByCall.get(event.entityId) || 0) + (event.amountRub || 0));
  const benchmarks: Benchmarks = {
    telephonyPerMinute,
    aiPerCall: [...aiByCall.values()].filter((value) => value >= 0),
    sources: {
      telephonyCalls: telephonyPerMinute.length,
      aiCalls: aiByCall.size,
      fallbackTelephony,
    },
  };
  return calculateCompanyForecast(input, benchmarks);
}
