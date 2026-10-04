import { prisma } from '../db';

function round(value: number, digits = 2): number {
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}

function moscowDateKey(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

function moscowMonth(value = new Date()): { from: Date; to: Date } {
  const [year, month] = moscowDateKey(value).split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    from: new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00+03:00`),
    to: new Date(new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+03:00`).getTime() - 1),
  };
}

export async function getEconomicsAnalytics(dateFrom: Date, dateTo: Date) {
  const month = moscowMonth();
  const previousMonth = moscowMonth(new Date(month.from.getTime() - 1));
  const forecastSince = new Date(Date.now() - 30 * 86_400_000);
  const [events, monthlyEvents, previousMonthlyEvents, forecastEvents, storedRates, balanceSnapshots, customTechnicalExpenses] = await Promise.all([
    prisma.costEvent.findMany({ where: { occurredAt: { gte: dateFrom, lte: dateTo } }, orderBy: { occurredAt: 'desc' } }),
    prisma.costEvent.findMany({ where: { occurredAt: { gte: month.from, lte: month.to } }, orderBy: { occurredAt: 'desc' } }),
    prisma.costEvent.findMany({ where: { occurredAt: { gte: previousMonth.from, lte: previousMonth.to } }, orderBy: { occurredAt: 'desc' } }),
    prisma.costEvent.findMany({ where: { occurredAt: { gte: forecastSince } }, orderBy: { occurredAt: 'asc' } }),
    prisma.exchangeRate.findMany({ where: { quoteCurrency: 'RUB' }, orderBy: { rateDate: 'desc' }, take: 100 }),
    prisma.providerBalanceSnapshot.findMany({ where: { capturedAt: { gte: forecastSince } }, orderBy: { capturedAt: 'asc' } }),
    prisma.monthlyTechnicalExpense.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  const latestRates = new Map<string, typeof storedRates[number]>();
  const accountingEvents = events.filter((event) => event.includedInTotals);
  const monthlyAccountingEvents = monthlyEvents.filter((event) => event.includedInTotals);
  const previousMonthlyAccountingEvents = previousMonthlyEvents.filter((event) => event.includedInTotals);
  const accountingForecastEvents = forecastEvents.filter((event) => event.includedInTotals);
  for (const rate of storedRates) if (!latestRates.has(rate.baseCurrency)) latestRates.set(rate.baseCurrency, rate);
  const voiceIds = [...new Set(events.filter((event) => event.entityType === 'voice_call' && event.entityId).map((event) => event.entityId as string))];
  const trainerIds = [...new Set(events.filter((event) => event.entityType === 'trainer_session' && event.entityId).map((event) => event.entityId as string))];
  const [voiceSessions, trainerSessions] = await Promise.all([
    voiceIds.length ? prisma.voiceCallSession.findMany({
      where: { callId: { in: voiceIds } },
      select: {
        callId: true, startedAt: true, durationSec: true, talkDurationSec: true,
        dealership: { select: { id: true, name: true, holdingId: true } },
        manager: { select: { id: true, fullName: true } },
      },
    }) : [],
    trainerIds.length ? prisma.trainerSession.findMany({ where: { id: { in: trainerIds } }, select: { id: true, companyId: true, branch: { select: { id: true, name: true, holdingId: true } } } }) : [],
  ]);
  const entityCompanies = new Map<string, string>();
  const entityDealerships = new Map<string, { id: string; name: string; companyId: string | null }>();
  for (const session of voiceSessions) if (session.dealership?.holdingId) entityCompanies.set(`voice_call:${session.callId}`, session.dealership.holdingId);
  for (const session of voiceSessions) if (session.dealership) entityDealerships.set(`voice_call:${session.callId}`, { id: session.dealership.id, name: session.dealership.name, companyId: session.dealership.holdingId });
  for (const session of trainerSessions) {
    const companyId = session.companyId || session.branch?.holdingId;
    if (companyId) entityCompanies.set(`trainer_session:${session.id}`, companyId);
    if (session.branch) entityDealerships.set(`trainer_session:${session.id}`, { id: session.branch.id, name: session.branch.name, companyId: companyId || null });
  }
  const companyFor = (event: typeof events[number]) => event.companyId || (event.entityType && event.entityId ? entityCompanies.get(`${event.entityType}:${event.entityId}`) : null) || null;
  const dealershipFor = (event: typeof events[number]) => event.entityType && event.entityId ? entityDealerships.get(`${event.entityType}:${event.entityId}`) || null : null;
  const companyIds = [...new Set(events.map(companyFor).filter((id): id is string => Boolean(id)))];
  const companies = companyIds.length
    ? await prisma.holding.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
    : [];
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));
  const amount = (rows: typeof events) => round(rows.reduce((sum, row) => sum + (row.amountRub ?? 0), 0));
  const known = accountingEvents.filter((event) => event.amountRub != null);
  const entities = new Set(events.filter((event) => event.entityType && event.entityId).map((event) => `${event.entityType}:${event.entityId}`));
  const providers = ['proxyapi', 'elevenlabs', 'voximplant'].map((provider) => {
    const rows = monthlyAccountingEvents.filter((event) => event.provider === provider);
    return {
      provider,
      amountRub: amount(rows),
      events: rows.length,
      confirmed: rows.filter((event) => event.status === 'confirmed').length,
      estimated: rows.filter((event) => event.status === 'estimated').length,
      withoutRubAmount: rows.filter((event) => event.amountRub == null).length,
    };
  });
  const categoryMap = new Map<string, { provider: string; category: string; amountRub: number; events: number }>();
  for (const event of monthlyAccountingEvents) {
    const key = `${event.provider}:${event.category}`;
    const row = categoryMap.get(key) || { provider: event.provider, category: event.category, amountRub: 0, events: 0 };
    row.amountRub += event.amountRub ?? 0;
    row.events += 1;
    categoryMap.set(key, row);
  }
  const now = new Date();
  const providerBalances = ['proxyapi', 'elevenlabs', 'voximplant'].map((provider) => {
    const snapshots = balanceSnapshots.filter((snapshot) => snapshot.provider === provider);
    const latest = snapshots.at(-1) || null;
    if (!latest) return {
      provider, available: false, balance: null, balanceRub: null, currency: null, unit: null,
      used: null, limit: null, capturedAt: null, resetAt: null,
      averageDaily: null, forecastDays: null, forecastUnits: null, basis: 'insufficient_data',
    };
    const providerEvents = accountingForecastEvents.filter((event) => event.provider === provider && event.amountRub != null);
    const entities = new Set(forecastEvents
      .filter((event) => event.provider === provider)
      .filter((event) => event.entityType && event.entityId)
      .map((event) => `${event.entityType}:${event.entityId}`));
    let averageDaily: number | null = null;
    let averagePerUnit: number | null = null;
    let basis = 'insufficient_data';
    if (latest.unit === 'money' && latest.balanceRub != null && providerEvents.length) {
      const total = providerEvents.reduce((sum, event) => sum + (event.amountRub ?? 0), 0);
      const firstAt = providerEvents[0].occurredAt.getTime();
      const coveredDays = Math.max(1, Math.min(30, (now.getTime() - firstAt) / 86_400_000));
      if (total > 0) {
        averageDaily = total / coveredDays;
        averagePerUnit = entities.size ? total / entities.size : null;
        basis = 'cost_events_30d';
      }
    } else if (latest.unit === 'credits' && latest.used != null && latest.used > 0) {
      const periodStart = latest.resetAt
        ? new Date(latest.resetAt.getTime() - 30 * 86_400_000)
        : snapshots[0].capturedAt;
      const elapsedDays = Math.max(1, (latest.capturedAt.getTime() - periodStart.getTime()) / 86_400_000);
      averageDaily = latest.used / elapsedDays;
      const periodEntities = new Set(forecastEvents
        .filter((event) => event.provider === provider && event.occurredAt >= periodStart && event.entityType && event.entityId)
        .map((event) => `${event.entityType}:${event.entityId}`));
      const firstTrackedEvent = forecastEvents.find((event) => event.provider === provider && event.entityType && event.entityId)?.occurredAt;
      const fullPeriodTracked = firstTrackedEvent && firstTrackedEvent.getTime() <= periodStart.getTime() + 86_400_000;
      averagePerUnit = fullPeriodTracked && periodEntities.size ? latest.used / periodEntities.size : null;
      basis = 'billing_period';
    }
    if ((averageDaily == null || averagePerUnit == null) && snapshots.length >= 2) {
      let spent = 0;
      for (let index = 1; index < snapshots.length; index += 1) {
        spent += Math.max(0, snapshots[index - 1].balance - snapshots[index].balance);
      }
      const spanDays = (latest.capturedAt.getTime() - snapshots[0].capturedAt.getTime()) / 86_400_000;
      if (spent > 0 && spanDays >= 1) {
        if (averageDaily == null) averageDaily = spent / spanDays;
        const snapshotEntities = new Set(forecastEvents
          .filter((event) => event.provider === provider && event.occurredAt >= snapshots[0].capturedAt && event.entityType && event.entityId)
          .map((event) => `${event.entityType}:${event.entityId}`));
        if (averagePerUnit == null && snapshotEntities.size) averagePerUnit = spent / snapshotEntities.size;
        if (basis === 'insufficient_data') basis = 'balance_history';
      }
    }
    const forecastBalance = latest.unit === 'money' ? latest.balanceRub : latest.balance;
    return {
      provider, available: true, balance: round(latest.balance, 4),
      balanceRub: latest.balanceRub == null ? null : round(latest.balanceRub, 2),
      currency: latest.currency, unit: latest.unit,
      used: latest.used == null ? null : round(latest.used, 2),
      limit: latest.limit == null ? null : round(latest.limit, 2),
      capturedAt: latest.capturedAt.toISOString(), resetAt: latest.resetAt?.toISOString() ?? null,
      averageDaily: averageDaily == null ? null : round(averageDaily, 2),
      forecastDays: forecastBalance != null && averageDaily ? round(forecastBalance / averageDaily, 1) : null,
      forecastUnits: forecastBalance != null && averagePerUnit ? Math.floor(forecastBalance / averagePerUnit) : null,
      basis,
    };
  });
  const perCompany = new Map<string, { companyId: string | null; name: string; amountRub: number; events: number; units: Set<string> }>();
  const addCompanyEvent = (event: typeof events[number], amountRub = event.amountRub ?? 0) => {
    const companyId = companyFor(event);
    const key = companyId || 'unassigned';
    const row = perCompany.get(key) || { companyId, name: companyId ? companyNames.get(companyId) || 'Неизвестная компания' : 'Без компании', amountRub: 0, events: 0, units: new Set<string>() };
    row.amountRub += amountRub;
    row.events += 1;
    if (event.entityType && event.entityId) row.units.add(`${event.entityType}:${event.entityId}`);
    perCompany.set(key, row);
  };
  for (const event of accountingEvents.filter((event) => event.provider !== 'voximplant')) addCompanyEvent(event);
  const voxTotal = accountingEvents
    .filter((event) => event.provider === 'voximplant')
    .reduce((sum, event) => sum + (event.amountRub ?? 0), 0);
  const voxAllocations = events.filter((event) => event.provider === 'voximplant' && !event.includedInTotals && event.entityId);
  const voxWeight = voxAllocations.reduce((sum, event) => sum + (event.amountRub ?? 0), 0);
  if (voxAllocations.length && voxTotal > 0) {
    for (const event of voxAllocations) {
      const weight = voxWeight > 0 ? (event.amountRub ?? 0) / voxWeight : 1 / voxAllocations.length;
      addCompanyEvent(event, voxTotal * weight);
    }
  } else if (voxTotal > 0) {
    const sample = accountingEvents.find((event) => event.provider === 'voximplant');
    if (sample) addCompanyEvent(sample, voxTotal);
  }
  const perDealership = new Map<string, { dealershipId: string; name: string; companyId: string | null; companyName: string; amountRub: number; events: number; units: Set<string> }>();
  const addDealershipEvent = (event: typeof events[number], amountRub = event.amountRub ?? 0) => {
    const dealership = dealershipFor(event);
    if (!dealership) return;
    const row = perDealership.get(dealership.id) || {
      dealershipId: dealership.id, name: dealership.name, companyId: dealership.companyId,
      companyName: dealership.companyId ? companyNames.get(dealership.companyId) || 'Неизвестная компания' : 'Без компании',
      amountRub: 0, events: 0, units: new Set<string>(),
    };
    row.amountRub += amountRub;
    row.events += 1;
    if (event.entityType && event.entityId) row.units.add(`${event.entityType}:${event.entityId}`);
    perDealership.set(dealership.id, row);
  };
  for (const event of accountingEvents.filter((event) => event.provider !== 'voximplant')) addDealershipEvent(event);
  const dealershipVoxAllocations = voxAllocations.filter((event) => dealershipFor(event));
  const dealershipVoxWeight = dealershipVoxAllocations.reduce((sum, event) => sum + (event.amountRub ?? 0), 0);
  if (dealershipVoxAllocations.length && voxTotal > 0) {
    for (const event of dealershipVoxAllocations) {
      const weight = dealershipVoxWeight > 0 ? (event.amountRub ?? 0) / dealershipVoxWeight : 1 / dealershipVoxAllocations.length;
      addDealershipEvent(event, voxTotal * weight);
    }
  }
  const byDay = new Map<string, number>();
  for (const event of known) {
    const key = moscowDateKey(event.occurredAt);
    byDay.set(key, (byDay.get(key) || 0) + (event.amountRub ?? 0));
  }
  const daily: Array<{ date: string; amountRub: number }> = [];
  for (let cursor = new Date(dateFrom); cursor <= dateTo; cursor = new Date(cursor.getTime() + 86_400_000)) {
    const date = moscowDateKey(cursor);
    daily.push({ date, amountRub: round(byDay.get(date) || 0) });
  }
  const eventsByVoiceCall = new Map<string, typeof events>();
  for (const event of events) {
    if (event.entityType !== 'voice_call' || !event.entityId) continue;
    if (event.provider === 'voximplant' ? event.includedInTotals : !event.includedInTotals) continue;
    const rows = eventsByVoiceCall.get(event.entityId) || [];
    rows.push(event);
    eventsByVoiceCall.set(event.entityId, rows);
  }
  const calls = voiceSessions.map((session) => {
    const callEvents = eventsByVoiceCall.get(session.callId) || [];
    const costs = { analyticsRub: 0, speechToTextRub: 0, speechSynthesisRub: 0, telephonyRub: 0, otherRub: 0 };
    for (const event of callEvents) {
      const value = event.amountRub ?? 0;
      if (event.provider === 'voximplant' || event.category === 'telephony') costs.telephonyRub += value;
      else if (event.category === 'llm') costs.analyticsRub += value;
      else if (event.category === 'stt') costs.speechToTextRub += value;
      else if (event.category === 'tts') costs.speechSynthesisRub += value;
      else costs.otherRub += value;
    }
    const companyId = session.dealership?.holdingId ?? null;
    return {
      callId: session.callId,
      occurredAt: session.startedAt.toISOString(),
      durationSec: session.talkDurationSec ?? session.durationSec,
      companyId,
      companyName: companyId ? companyNames.get(companyId) || 'Неизвестная компания' : 'Без компании',
      dealershipId: session.dealership?.id ?? null,
      dealershipName: session.dealership?.name ?? 'Без точки',
      employeeId: session.manager?.id ?? null,
      employeeName: session.manager?.fullName ?? 'Без сотрудника',
      analyticsRub: round(costs.analyticsRub),
      speechToTextRub: round(costs.speechToTextRub),
      speechSynthesisRub: round(costs.speechSynthesisRub),
      telephonyRub: round(costs.telephonyRub),
      otherRub: round(costs.otherRub),
      totalRub: round(Object.values(costs).reduce((sum, value) => sum + value, 0)),
    };
  }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const buildTechnicalMap = (rows: typeof monthlyAccountingEvents) => {
    const result = new Map<string, { provider: string; category: string; amountRub: number; events: number }>([
      ['proxyapi', { provider: 'proxyapi', category: 'all', amountRub: 0, events: 0 }],
      ['elevenlabs', { provider: 'elevenlabs', category: 'all', amountRub: 0, events: 0 }],
    ]);
    for (const event of rows) {
      const key = event.provider === 'voximplant' ? `${event.provider}:${event.category}` : event.provider;
      const row = result.get(key) || { provider: event.provider, category: event.category, amountRub: 0, events: 0 };
      row.amountRub += event.amountRub ?? 0;
      row.events += 1;
      result.set(key, row);
    }
    return result;
  };
  const technicalMap = buildTechnicalMap(monthlyAccountingEvents);
  const previousTechnicalMap = buildTechnicalMap(previousMonthlyAccountingEvents);
  const hasVoximplant = [...technicalMap.values(), ...previousTechnicalMap.values()].some((row) => row.provider === 'voximplant');
  if (!hasVoximplant) technicalMap.set('voximplant', { provider: 'voximplant', category: 'all', amountRub: 0, events: 0 });
  const technicalKeys = new Set([...technicalMap.keys(), ...previousTechnicalMap.keys()]);
  const technicalSystemExpenses = [...technicalKeys].map((key) => {
    const row = technicalMap.get(key) || previousTechnicalMap.get(key)!;
    const current = technicalMap.get(key);
    const previous = previousTechnicalMap.get(key);
    return {
    id: `system:${row.provider}:${row.category}`,
    source: 'system' as const,
    provider: row.provider,
    name: row.provider === 'voximplant'
      ? ({ all: 'Voximplant', usage: 'Звонки Voximplant', phone_number: 'Абонплата за номера', phone_number_setup: 'Подключение номеров', subscription: 'Подписки Voximplant', subscription_setup: 'Подключение подписок', sip_registration: 'SIP-регистрация', tax: 'Налоги Voximplant', monthly_fee: 'Ежемесячная плата Voximplant' }[row.category] || `Voximplant: ${row.category}`)
      : row.provider === 'elevenlabs' ? 'ElevenLabs' : row.provider === 'proxyapi' ? 'ProxyAPI' : `${row.provider}: ${row.category}`,
    amountRub: round(current?.amountRub ?? 0),
    previousMonthAmountRub: round(previous?.amountRub ?? 0),
    events: current?.events ?? 0,
  }; });
  const technicalCustomExpenses = customTechnicalExpenses.map((row) => ({
    id: row.id, source: 'custom' as const, provider: null, name: row.name,
    amountRub: round(row.amountRub),
    previousMonthAmountRub: row.createdAt <= previousMonth.to ? round(row.amountRub) : 0,
    events: null,
  }));
  return {
    generatedAt: new Date().toISOString(),
    dateFrom: moscowDateKey(dateFrom), dateTo: moscowDateKey(dateTo),
    summary: {
      totalRub: amount(known), confirmedRub: amount(known.filter((event) => event.status === 'confirmed')),
      estimatedRub: amount(known.filter((event) => event.status === 'estimated')),
      events: accountingEvents.length, units: entities.size, avgPerUnitRub: entities.size ? round(amount(known) / entities.size) : 0,
      withoutRubAmount: accountingEvents.length - known.length,
    },
    providers,
    providerCategories: [...categoryMap.values()]
      .map((row) => ({ ...row, amountRub: round(row.amountRub) }))
      .sort((a, b) => b.amountRub - a.amountRub),
    providerBalances,
    technicalExpenses: [...technicalSystemExpenses, ...technicalCustomExpenses],
    technicalExpensesTotalRub: round([...technicalSystemExpenses, ...technicalCustomExpenses].reduce((sum, row) => sum + row.amountRub, 0)),
    technicalExpensesPreviousMonthTotalRub: round([...technicalSystemExpenses, ...technicalCustomExpenses].reduce((sum, row) => sum + row.previousMonthAmountRub, 0)),
    exchangeRates: [...latestRates.values()].map((rate) => ({
      currency: rate.baseCurrency, rate: round(rate.rate, 4), rateDate: rate.rateDate.toISOString(), source: rate.source,
    })),
    companies: [...perCompany.values()].map((row) => ({ ...row, amountRub: round(row.amountRub), units: row.units.size, avgPerUnitRub: row.units.size ? round(row.amountRub / row.units.size) : 0 })).sort((a, b) => b.amountRub - a.amountRub),
    dealerships: [...perDealership.values()].map((row) => ({ ...row, amountRub: round(row.amountRub), units: row.units.size, avgPerUnitRub: row.units.size ? round(row.amountRub / row.units.size) : 0 })).sort((a, b) => b.amountRub - a.amountRub),
    calls,
    daily,
    recent: monthlyAccountingEvents.map((event) => ({
      id: event.id, provider: event.provider, category: event.category, stage: event.stage,
      entityType: event.entityType, entityId: event.entityId, companyName: companyFor(event) ? companyNames.get(companyFor(event) as string) || 'Неизвестная компания' : null,
      model: event.model, amountOriginal: event.amountOriginal, currency: event.currency, amountRub: event.amountRub,
      exchangeRateToRub: event.exchangeRateToRub, exchangeRateDate: event.exchangeRateDate?.toISOString() ?? null,
      exchangeRateSource: event.exchangeRateSource,
      status: event.status, occurredAt: event.occurredAt.toISOString(),
    })),
  };
}
