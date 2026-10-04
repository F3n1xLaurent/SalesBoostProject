import type { PrismaClient, SupportTicketStatusHistory } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const AUTOMATION_INTERVAL_MS = MINUTE_MS;
const WAITING_REMINDER_AFTER_MS = 24 * HOUR_MS;
const WAITING_CLOSE_AFTER_MS = 72 * HOUR_MS;
const RESOLVED_CLOSE_AFTER_MS = 24 * HOUR_MS;
const ACTIVE_SLA_STATUSES = new Set(['new', 'open', 'reopened']);

let schedulerStarted = false;
let automationRunning = false;

export function calculateSupportActiveTimeMs(params: {
  createdAt: Date;
  history: Array<Pick<SupportTicketStatusHistory, 'toStatus' | 'createdAt'>>;
  until: Date;
  activeStatuses?: ReadonlySet<string>;
}): number {
  const activeStatuses = params.activeStatuses ?? ACTIVE_SLA_STATUSES;
  const endMs = Math.max(params.createdAt.getTime(), params.until.getTime());
  let cursorMs = params.createdAt.getTime();
  let status = 'new';
  let activeMs = 0;
  const history = [...params.history].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const event of history) {
    const eventMs = Math.max(cursorMs, Math.min(endMs, event.createdAt.getTime()));
    if (activeStatuses.has(status)) activeMs += eventMs - cursorMs;
    status = event.toStatus;
    cursorMs = eventMs;
    if (cursorMs >= endMs) break;
  }
  if (cursorMs < endMs && activeStatuses.has(status)) activeMs += endMs - cursorMs;
  return Math.max(0, activeMs);
}

async function closeTicket(
  client: PrismaClient,
  ticket: { id: string; status: string; anchor: Date },
  now: Date,
  reason: string,
): Promise<boolean> {
  return client.$transaction(async (tx) => {
    const updated = await tx.supportTicket.updateMany({
      where: { id: ticket.id, status: ticket.status },
      data: { status: 'closed', closedAt: now, lastMessageAt: now, syncStatus: 'pending' },
    });
    if (!updated.count) return false;
    await tx.supportTicketStatusHistory.create({
      data: {
        ticketId: ticket.id,
        fromStatus: ticket.status,
        toStatus: 'closed',
        source: 'automation',
        reason,
      },
    });
    const message = await tx.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorType: 'system',
        source: 'system',
        visibility: 'public',
        body: ticket.status === 'waiting'
          ? 'Обращение закрыто автоматически, поскольку мы не получили ваш ответ. Если вопрос ещё актуален, напишите в этом чате — обращение переоткроется.'
          : 'Решённое обращение закрыто автоматически. Если вопрос возник снова, напишите в этом чате — обращение переоткроется.',
        deliveryStatus: 'sent',
        sentAt: now,
      },
    });
    await tx.supportIntegrationOutbox.create({
      data: {
        ticketId: ticket.id,
        eventType: 'ticket.auto_closed',
        payloadJson: JSON.stringify({ ticketId: ticket.id, fromStatus: ticket.status, reason, messageId: message.id }),
        deduplicationKey: `ticket.auto_closed:${ticket.id}:${ticket.anchor.toISOString()}`,
      },
    });
    return true;
  });
}

async function sendWaitingReminder(
  client: PrismaClient,
  ticket: { id: string; number: string; waitingSince: Date },
  now: Date,
): Promise<boolean> {
  return client.$transaction(async (tx) => {
    const updated = await tx.supportTicket.updateMany({
      where: { id: ticket.id, status: 'waiting', waitingReminderSentAt: null },
      data: { waitingReminderSentAt: now, lastMessageAt: now, syncStatus: 'pending' },
    });
    if (!updated.count) return false;
    const message = await tx.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorType: 'system',
        source: 'system',
        visibility: 'public',
        body: `Мы ждём вашего ответа по обращению ${ticket.number}. Если вопрос ещё актуален, напишите в этом чате.`,
        deliveryStatus: 'sent',
        sentAt: now,
      },
    });
    await tx.supportIntegrationOutbox.create({
      data: {
        ticketId: ticket.id,
        eventType: 'ticket.waiting_reminder',
        payloadJson: JSON.stringify({ ticketId: ticket.id, messageId: message.id }),
        deduplicationKey: `ticket.waiting_reminder:${ticket.id}:${ticket.waitingSince.toISOString()}`,
      },
    });
    return true;
  });
}

async function markSlaBreach(
  client: PrismaClient,
  ticketId: string,
  metric: 'first_response' | 'resolution',
  now: Date,
  elapsedMinutes: number,
  targetMinutes: number,
): Promise<boolean> {
  return client.$transaction(async (tx) => {
    const where = metric === 'first_response'
      ? { id: ticketId, slaFirstResponseBreachedAt: null }
      : { id: ticketId, slaResolutionBreachedAt: null };
    const data = metric === 'first_response'
      ? { slaFirstResponseBreachedAt: now }
      : { slaResolutionBreachedAt: now };
    const updated = await tx.supportTicket.updateMany({ where, data });
    if (!updated.count) return false;
    await tx.supportIntegrationOutbox.create({
      data: {
        ticketId,
        eventType: 'ticket.sla_breached',
        payloadJson: JSON.stringify({ ticketId, metric, elapsedMinutes, targetMinutes }),
        deduplicationKey: `ticket.sla_breached:${ticketId}:${metric}`,
      },
    });
    return true;
  });
}

export async function runSupportAutomation(now = new Date(), client: PrismaClient = prisma): Promise<{
  reminders: number;
  closed: number;
  slaBreaches: number;
}> {
  const waitingCloseBefore = new Date(now.getTime() - WAITING_CLOSE_AFTER_MS);
  const waitingReminderBefore = new Date(now.getTime() - WAITING_REMINDER_AFTER_MS);
  const resolvedCloseBefore = new Date(now.getTime() - RESOLVED_CLOSE_AFTER_MS);
  let reminders = 0;
  let closed = 0;
  let slaBreaches = 0;

  const [waitingToClose, resolvedToClose] = await Promise.all([
    client.supportTicket.findMany({
      where: { status: 'waiting', waitingSince: { lte: waitingCloseBefore } },
      select: { id: true, status: true, waitingSince: true },
      take: 200,
    }),
    client.supportTicket.findMany({
      where: { status: 'resolved', resolvedAt: { lte: resolvedCloseBefore } },
      select: { id: true, status: true, resolvedAt: true },
      take: 200,
    }),
  ]);

  for (const ticket of waitingToClose) {
    if (ticket.waitingSince && await closeTicket(client, { id: ticket.id, status: ticket.status, anchor: ticket.waitingSince }, now, 'Нет ответа клиента в течение 72 часов')) closed += 1;
  }
  for (const ticket of resolvedToClose) {
    if (ticket.resolvedAt && await closeTicket(client, { id: ticket.id, status: ticket.status, anchor: ticket.resolvedAt }, now, 'Решённое обращение закрыто автоматически через 24 часа')) closed += 1;
  }

  const waitingForReminder = await client.supportTicket.findMany({
    where: {
      status: 'waiting',
      waitingReminderSentAt: null,
      waitingSince: { lte: waitingReminderBefore, gt: waitingCloseBefore },
    },
    select: { id: true, number: true, waitingSince: true },
    take: 200,
  });
  for (const ticket of waitingForReminder) {
    if (ticket.waitingSince && await sendWaitingReminder(client, { ...ticket, waitingSince: ticket.waitingSince }, now)) reminders += 1;
  }

  const slaTickets = await client.supportTicket.findMany({
    where: {
      status: { in: ['new', 'open', 'waiting', 'on_hold', 'reopened'] },
      OR: [
        { firstResponseAt: null, slaFirstResponseBreachedAt: null },
        { resolvedAt: null, slaResolutionBreachedAt: null },
      ],
    },
    include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
    take: 500,
  });

  for (const ticket of slaTickets) {
    if (!ticket.firstResponseAt && !ticket.slaFirstResponseBreachedAt) {
      const target = ticket.slaFirstResponseMinutes ?? config.supportSlaFirstResponseMinutes;
      const elapsed = calculateSupportActiveTimeMs({ createdAt: ticket.createdAt, history: ticket.statusHistory, until: now });
      if (elapsed >= target * MINUTE_MS) {
        if (await markSlaBreach(client, ticket.id, 'first_response', now, Math.floor(elapsed / MINUTE_MS), target)) slaBreaches += 1;
      }
    }
    if (!ticket.resolvedAt && !ticket.slaResolutionBreachedAt) {
      const target = ticket.slaResolutionMinutes ?? config.supportSlaResolutionMinutes;
      const elapsed = calculateSupportActiveTimeMs({ createdAt: ticket.createdAt, history: ticket.statusHistory, until: now });
      if (elapsed >= target * MINUTE_MS) {
        if (await markSlaBreach(client, ticket.id, 'resolution', now, Math.floor(elapsed / MINUTE_MS), target)) slaBreaches += 1;
      }
    }
  }

  return { reminders, closed, slaBreaches };
}

export function startSupportAutomationScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = async () => {
    if (automationRunning) return;
    automationRunning = true;
    try {
      const result = await runSupportAutomation();
      if (result.reminders || result.closed || result.slaBreaches) {
        console.info('[support/automation] completed', result);
      }
    } catch (error) {
      console.error('[support/automation] failed:', error instanceof Error ? error.message : error);
    } finally {
      automationRunning = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), AUTOMATION_INTERVAL_MS);
  timer.unref?.();
  console.info('[support/automation] started');
}
