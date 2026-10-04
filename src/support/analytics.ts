import type { SupportTicketStatusHistory } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { calculateSupportActiveTimeMs } from './automation';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const OPEN_STATUSES = new Set(['new', 'open', 'waiting', 'on_hold', 'reopened']);

type TicketHistory = Array<Pick<SupportTicketStatusHistory, 'toStatus' | 'createdAt'>>;

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator * 100) : null;
}

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function dateKey(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.supportTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function isOutsideSupportHours(value: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.supportTimezone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  return weekday === 'Sat'
    || weekday === 'Sun'
    || hour < config.supportWorkHoursFrom
    || hour >= config.supportWorkHoursTo;
}

function activeMinutes(createdAt: Date, history: TicketHistory, until: Date): number {
  return calculateSupportActiveTimeMs({ createdAt, history, until }) / MINUTE_MS;
}

function displayRequester(ticket: {
  requesterName: string | null;
  requesterEmail: string | null;
  requesterPhone: string | null;
  requester?: { displayName: string | null; email: string } | null;
}): string {
  return ticket.requester?.displayName
    || ticket.requesterName
    || ticket.requester?.email
    || ticket.requesterEmail
    || ticket.requesterPhone
    || 'Гость';
}

export async function getSupportAnalytics(dateFrom: Date, dateTo: Date) {
  const [tickets, activeAccounts] = await Promise.all([
    prisma.supportTicket.findMany({
      where: { createdAt: { gte: dateFrom, lte: dateTo } },
      include: {
        requester: { select: { displayName: true, email: true } },
        assignee: { select: { id: true, displayName: true, email: true } },
        rating: { select: { isSatisfied: true } },
        statusHistory: {
          select: { toStatus: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.account.count({ where: { status: 'active' } }),
  ]);

  const firstResponseMinutes: number[] = [];
  const resolutionMinutes: number[] = [];
  let firstResponseEligible = 0;
  let firstResponseWithinSla = 0;
  let resolutionEligible = 0;
  let resolutionWithinSla = 0;
  let resolvedCount = 0;
  let fsrCount = 0;

  const byStatus = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byPriority = new Map<string, number>();
  const byChannel = new Map<string, number>();
  const daily = new Map<string, { date: string; created: number; resolved: number; closed: number }>();
  const agentMap = new Map<string, {
    accountId: string;
    name: string;
    tickets: number;
    resolved: number;
    activeNow: number;
    firstResponseMinutes: number[];
    resolutionMinutes: number[];
  }>();

  for (let cursor = new Date(dateFrom); cursor <= dateTo; cursor = new Date(cursor.getTime() + DAY_MS)) {
    const key = dateKey(cursor);
    if (!daily.has(key)) daily.set(key, { date: key, created: 0, resolved: 0, closed: 0 });
  }

  for (const ticket of tickets) {
    byStatus.set(ticket.status, (byStatus.get(ticket.status) ?? 0) + 1);
    byCategory.set(ticket.category, (byCategory.get(ticket.category) ?? 0) + 1);
    byPriority.set(ticket.priority, (byPriority.get(ticket.priority) ?? 0) + 1);
    byChannel.set(ticket.channel, (byChannel.get(ticket.channel) ?? 0) + 1);
    const createdKey = dateKey(ticket.createdAt);
    const createdDay = daily.get(createdKey) ?? { date: createdKey, created: 0, resolved: 0, closed: 0 };
    createdDay.created += 1;
    daily.set(createdKey, createdDay);

    let responseMinutes: number | null = null;
    if (ticket.firstResponseAt) {
      responseMinutes = activeMinutes(ticket.createdAt, ticket.statusHistory, ticket.firstResponseAt);
      firstResponseMinutes.push(responseMinutes);
    }
    if (ticket.firstResponseAt || ticket.slaFirstResponseBreachedAt) {
      firstResponseEligible += 1;
      const target = ticket.slaFirstResponseMinutes ?? config.supportSlaFirstResponseMinutes;
      if (responseMinutes != null && responseMinutes <= target) firstResponseWithinSla += 1;
    }

    const resolvedAt = ticket.resolvedAt ?? ticket.closedAt;
    let ticketResolutionMinutes: number | null = null;
    if (resolvedAt) {
      resolvedCount += 1;
      ticketResolutionMinutes = activeMinutes(ticket.createdAt, ticket.statusHistory, resolvedAt);
      resolutionMinutes.push(ticketResolutionMinutes);
      const resolutionKey = dateKey(resolvedAt);
      const resolutionDay = daily.get(resolutionKey);
      if (resolutionDay) {
        if (ticket.resolvedAt) resolutionDay.resolved += 1;
        if (ticket.closedAt) resolutionDay.closed += 1;
      }
      if (ticketResolutionMinutes <= 24 * 60 && ticket.reopenCount === 0 && !ticket.isEscalated) fsrCount += 1;
    }
    if (resolvedAt || ticket.slaResolutionBreachedAt) {
      resolutionEligible += 1;
      const target = ticket.slaResolutionMinutes ?? config.supportSlaResolutionMinutes;
      if (ticketResolutionMinutes != null && ticketResolutionMinutes <= target) resolutionWithinSla += 1;
    }

    if (ticket.assignee) {
      const current = agentMap.get(ticket.assignee.id) ?? {
        accountId: ticket.assignee.id,
        name: ticket.assignee.displayName || ticket.assignee.email,
        tickets: 0,
        resolved: 0,
        activeNow: 0,
        firstResponseMinutes: [],
        resolutionMinutes: [],
      };
      current.tickets += 1;
      if (resolvedAt) current.resolved += 1;
      if (OPEN_STATUSES.has(ticket.status)) current.activeNow += 1;
      if (responseMinutes != null) current.firstResponseMinutes.push(responseMinutes);
      if (ticketResolutionMinutes != null) current.resolutionMinutes.push(ticketResolutionMinutes);
      agentMap.set(ticket.assignee.id, current);
    }
  }

  const requesterKeys = new Set(tickets.map((ticket) => ticket.requesterAccountId
    ? `account:${ticket.requesterAccountId}`
    : `guest:${ticket.requesterEmail || ticket.requesterPhone || ticket.publicAccessTokenHash || ticket.id}`));
  const authenticatedRequesters = new Set(tickets.flatMap((ticket) => ticket.requesterAccountId ? [ticket.requesterAccountId] : []));
  const ratedTickets = tickets.filter((ticket) => ticket.rating);
  const satisfiedTickets = ratedTickets.filter((ticket) => ticket.rating?.isSatisfied).length;

  const toBreakdown = (source: Map<string, number>) => [...source.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));

  return {
    generatedAt: new Date().toISOString(),
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
    workSchedule: {
      timezone: config.supportTimezone,
      fromHour: config.supportWorkHoursFrom,
      toHour: config.supportWorkHoursTo,
    },
    summary: {
      totalTickets: tickets.length,
      uniqueRequesters: requesterKeys.size,
      activeAccounts,
      contactRatePer100: activeAccounts ? round(authenticatedRequesters.size / activeAccounts * 100) : null,
      openTickets: tickets.filter((ticket) => OPEN_STATUSES.has(ticket.status)).length,
      resolvedTickets: resolvedCount,
      avgFirstResponseMinutes: average(firstResponseMinutes),
      avgResolutionMinutes: average(resolutionMinutes),
      firstResponseSlaCompliance: percent(firstResponseWithinSla, firstResponseEligible),
      resolutionSlaCompliance: percent(resolutionWithinSla, resolutionEligible),
      fsr24Rate: percent(fsrCount, resolvedCount),
      csatRate: percent(satisfiedTickets, ratedTickets.length),
      ratedTickets: ratedTickets.length,
      reopenRate: percent(tickets.filter((ticket) => ticket.reopenCount > 0).length, tickets.length),
      escalatedRate: percent(tickets.filter((ticket) => ticket.isEscalated).length, tickets.length),
      outsideHoursRate: percent(tickets.filter((ticket) => isOutsideSupportHours(ticket.createdAt)).length, tickets.length),
    },
    byStatus: toBreakdown(byStatus),
    byCategory: toBreakdown(byCategory),
    byPriority: toBreakdown(byPriority),
    byChannel: toBreakdown(byChannel),
    daily: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)),
    agents: [...agentMap.values()].map((agent) => ({
      accountId: agent.accountId,
      name: agent.name,
      tickets: agent.tickets,
      resolved: agent.resolved,
      activeNow: agent.activeNow,
      avgFirstResponseMinutes: average(agent.firstResponseMinutes),
      avgResolutionMinutes: average(agent.resolutionMinutes),
    })).sort((left, right) => right.tickets - left.tickets),
    recent: tickets.slice(0, 50).map((ticket) => ({
      id: ticket.id,
      number: ticket.number,
      requester: displayRequester(ticket),
      subject: ticket.subject,
      category: ticket.category,
      subcategory: ticket.subcategory,
      priority: ticket.priority,
      status: ticket.status,
      channel: ticket.channel,
      assignee: ticket.assignee?.displayName || ticket.assignee?.email || null,
      firstResponseMinutes: ticket.firstResponseAt
        ? round(activeMinutes(ticket.createdAt, ticket.statusHistory, ticket.firstResponseAt))
        : null,
      resolutionMinutes: (ticket.resolvedAt ?? ticket.closedAt)
        ? round(activeMinutes(ticket.createdAt, ticket.statusHistory, ticket.resolvedAt ?? ticket.closedAt!))
        : null,
      createdAt: ticket.createdAt.toISOString(),
    })),
  };
}
