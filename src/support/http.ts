import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { getPublicRequestIp } from '../integrations/landingLeadRoute';
import {
  MAX_SUPPORT_ATTACHMENT_BYTES,
  supportAttachmentExtension,
  supportAttachmentKey,
  supportAttachmentStorage,
} from '../storage/supportAttachmentStorage';
import {
  AUTHENTICATED_SUPPORT_CATEGORIES,
  PUBLIC_SUPPORT_CATEGORIES,
  SUPPORT_TICKET_STATUSES,
  isSupportTicketStatus,
  statusAfterCustomerMessage,
  type SupportTicketStatus,
} from './domain';
import { getBitrixSupportCategories } from './bitrix24';
import { verifySupportAttachmentLink } from './attachmentLinks';

const MAX_MESSAGE_LENGTH = 10_000;
const MAX_SUBJECT_LENGTH = 200;

type RateLimitEntry = { startedAt: number; count: number };
const publicTicketCreateLimits = new Map<string, RateLimitEntry>();
const publicTicketMessageLimits = new Map<string, RateLimitEntry>();

function consumePublicLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const existing = store.get(key);
  if (!existing || now - existing.startedAt >= windowMs) {
    store.set(key, { startedAt: now, count: 1 });
    if (store.size > 5_000) {
      for (const [entryKey, entry] of store) {
        if (now - entry.startedAt >= windowMs) store.delete(entryKey);
      }
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
  existing.count += 1;
  return {
    allowed: existing.count <= maxRequests,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.startedAt + windowMs - now) / 1_000)),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicAccessToken(req: Request): string {
  const value = String(req.get('x-support-token') || '').trim();
  return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
}

function supportIsOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.supportTimezone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value || '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || '-1');
  return !['Sat', 'Sun'].includes(weekday)
    && hour >= config.supportWorkHoursFrom
    && hour < config.supportWorkHoursTo;
}

function publicAutoReply(category: string, ticketNumber: string, now = new Date()): string {
  const accepted = category === 'registration'
    ? 'Мы получили ваш вопрос о регистрации.'
    : category === 'password_recovery'
      ? 'Мы получили ваш запрос на восстановление доступа.'
      : 'Мы получили ваше обращение.';
  if (supportIsOpen(now)) {
    return `${accepted} Номер обращения — ${ticketNumber}. Специалист поддержки ответит в этом чате.`;
  }
  return `${accepted} Номер обращения — ${ticketNumber}. Сейчас поддержка не работает, но обращение уже сохранено. Ответим в ближайшее рабочее время.`;
}

type TicketScope = {
  holdingId: string | null;
  dealershipId: string | null;
};

function currentAccount(req: Request) {
  return req.authAccount ?? null;
}

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function serializeTicket(ticket: any, unreadCount = 0) {
  return {
    id: ticket.id,
    number: ticket.number,
    category: ticket.category,
    subcategory: ticket.subcategory,
    priority: ticket.priority,
    status: ticket.status,
    subject: ticket.subject,
    channel: ticket.channel,
    holdingId: ticket.holdingId,
    dealershipId: ticket.dealershipId,
    firstMessageAt: ticket.firstMessageAt,
    firstResponseAt: ticket.firstResponseAt,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
    lastMessageAt: ticket.lastMessageAt,
    reopenCount: ticket.reopenCount,
    slaFirstResponseMinutes: ticket.slaFirstResponseMinutes,
    slaResolutionMinutes: ticket.slaResolutionMinutes,
    slaFirstResponseBreached: Boolean(ticket.slaFirstResponseBreachedAt),
    slaResolutionBreached: Boolean(ticket.slaResolutionBreachedAt),
    unreadCount,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function serializeMessage(message: any) {
  return {
    id: message.id,
    authorType: message.authorType,
    body: message.body,
    source: message.source,
    deliveryStatus: message.deliveryStatus,
    sentAt: message.sentAt,
    editedAt: message.editedAt,
    attachments: (message.attachments || []).map((attachment: any) => ({
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  };
}

function makeTicketNumber(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  return `SUP-${date}-${suffix}`;
}

async function resolveTicketScope(req: Request): Promise<TicketScope | null> {
  const account = currentAccount(req);
  if (!account) return null;

  const body = (req.body || {}) as { holdingId?: unknown; dealershipId?: unknown };
  const requestedHoldingId = stringValue(body.holdingId, 100) || null;
  const requestedDealershipId = stringValue(body.dealershipId, 100) || null;
  const isSuperadmin = account.memberships.some((membership) => membership.role === 'platform_superadmin');

  if (requestedDealershipId) {
    const dealership = await prisma.dealership.findUnique({
      where: { id: requestedDealershipId },
      select: { id: true, holdingId: true, isDeleted: true },
    });
    if (!dealership || dealership.isDeleted) return null;

    const canUseDealership = isSuperadmin || account.memberships.some((membership) =>
      membership.dealershipId === dealership.id ||
      (dealership.holdingId && membership.role === 'holding_admin' && membership.holdingId === dealership.holdingId),
    );
    if (!canUseDealership) return null;
    if (requestedHoldingId && dealership.holdingId !== requestedHoldingId) return null;
    return { holdingId: dealership.holdingId, dealershipId: dealership.id };
  }

  if (requestedHoldingId) {
    const canUseHolding = isSuperadmin || account.memberships.some((membership) =>
      membership.holdingId === requestedHoldingId,
    );
    if (!canUseHolding) return null;
    return { holdingId: requestedHoldingId, dealershipId: null };
  }

  const membership = account.memberships.find((item) => item.role === 'manager')
    ?? account.memberships.find((item) => item.role === 'dealership_admin')
    ?? account.memberships.find((item) => item.role === 'holding_admin')
    ?? account.memberships[0];

  if (!membership) return { holdingId: null, dealershipId: null };
  if (membership.dealershipId) {
    const dealership = await prisma.dealership.findUnique({
      where: { id: membership.dealershipId },
      select: { holdingId: true },
    });
    return {
      holdingId: membership.holdingId ?? dealership?.holdingId ?? null,
      dealershipId: membership.dealershipId,
    };
  }
  return { holdingId: membership.holdingId, dealershipId: null };
}

async function findOwnedTicket(req: Request, ticketId: string) {
  const account = currentAccount(req);
  if (!account) return null;
  return prisma.supportTicket.findFirst({
    where: { id: ticketId, requesterAccountId: account.id },
  });
}

async function findPublicTicket(req: Request, ticketId: string) {
  const token = publicAccessToken(req);
  if (!token) return null;
  return prisma.supportTicket.findFirst({
    where: {
      id: ticketId,
      channel: 'login',
      publicAccessTokenHash: sha256(token),
    },
  });
}

export async function handleGetSupportMeta(_req: Request, res: Response): Promise<void> {
  const bitrixCategories = await getBitrixSupportCategories();
  res.json({
    categories: bitrixCategories.length ? bitrixCategories : AUTHENTICATED_SUPPORT_CATEGORIES,
    statuses: SUPPORT_TICKET_STATUSES,
    maxMessageLength: MAX_MESSAGE_LENGTH,
  });
}

export async function handleListSupportTickets(req: Request, res: Response): Promise<void> {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const requestedStatus = stringValue(req.query.status, 32);
  if (requestedStatus && !isSupportTicketStatus(requestedStatus)) {
    res.status(400).json({ error: 'Неизвестный статус обращения.' });
    return;
  }
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
  const where = {
    requesterAccountId: account.id,
    ...(requestedStatus ? { status: requestedStatus } : {}),
  };

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      include: {
        messages: {
          where: { authorType: { in: ['support', 'system'] }, visibility: 'public' },
          select: { sentAt: true },
        },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.supportTicket.count({ where }),
  ]);

  res.json({
    items: tickets.map((ticket) => serializeTicket(
      ticket,
      ticket.messages.filter((message) => !ticket.customerLastReadAt || message.sentAt > ticket.customerLastReadAt).length,
    )),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
}

export async function handleCreateSupportTicket(req: Request, res: Response): Promise<void> {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const category = stringValue(body.category, 64);
  const rawMessageBody = typeof body.message === 'string' ? body.message.trim() : '';
  const messageBody = rawMessageBody.slice(0, MAX_MESSAGE_LENGTH);
  const subject = stringValue(body.subject, MAX_SUBJECT_LENGTH) || null;
  const bitrixCategories = await getBitrixSupportCategories();
  const availableCategories: readonly string[] = bitrixCategories.length ? bitrixCategories : AUTHENTICATED_SUPPORT_CATEGORIES;
  if (!availableCategories.includes(category)) {
    res.status(400).json({ error: 'Выберите категорию обращения.' });
    return;
  }
  if (!messageBody) {
    res.status(400).json({ error: 'Опишите вопрос или проблему.' });
    return;
  }
  if (rawMessageBody.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `Сообщение не должно превышать ${MAX_MESSAGE_LENGTH} символов.` });
    return;
  }

  const scope = await resolveTicketScope(req);
  if (!scope) {
    res.status(403).json({ error: 'Выбранная компания или точка недоступна.' });
    return;
  }

  let created: any = null;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    try {
      created = await prisma.$transaction(async (tx) => {
        const now = new Date();
        const ticket = await tx.supportTicket.create({
          data: {
            number: makeTicketNumber(now),
            requesterAccountId: account.id,
            requesterName: account.displayName,
            requesterEmail: account.email,
            requesterVerified: true,
            holdingId: scope.holdingId,
            dealershipId: scope.dealershipId,
            category,
            subject,
            priority: 'P3',
            status: 'new',
            slaFirstResponseMinutes: config.supportSlaFirstResponseMinutes,
            slaResolutionMinutes: config.supportSlaResolutionMinutes,
            channel: 'product',
            firstMessageAt: now,
            lastMessageAt: now,
            customerLastReadAt: now,
          },
        });
        const message = await tx.supportMessage.create({
          data: {
            ticketId: ticket.id,
            authorAccountId: account.id,
            authorType: 'customer',
            source: 'product',
            visibility: 'public',
            body: messageBody,
            deliveryStatus: 'pending',
            sentAt: now,
          },
          include: { attachments: true },
        });
        await tx.supportMessage.create({
          data: {
            ticketId: ticket.id,
            authorType: 'system',
            source: 'system',
            visibility: 'public',
            body: publicAutoReply(category, ticket.number, now),
            deliveryStatus: 'sent',
            sentAt: now,
          },
        });
        await tx.supportTicketStatusHistory.create({
          data: { ticketId: ticket.id, toStatus: 'new', source: 'product' },
        });
        await tx.supportIntegrationOutbox.create({
          data: {
            ticketId: ticket.id,
            eventType: 'ticket.created',
            payloadJson: JSON.stringify({ ticketId: ticket.id, messageId: message.id }),
            deduplicationKey: `ticket.created:${ticket.id}`,
          },
        });
        return { ticket, message };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }

  if (!created) {
    res.status(503).json({ error: 'Не удалось присвоить номер обращению. Попробуйте ещё раз.' });
    return;
  }
  res.status(201).json({
    ticket: serializeTicket(created.ticket),
    message: serializeMessage(created.message),
  });
}

export async function handleGetSupportTicket(req: Request, res: Response): Promise<void> {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const ticket = await prisma.supportTicket.findFirst({
    where: { id: req.params.id, requesterAccountId: account.id },
    include: {
      messages: {
        where: { visibility: 'public' },
        include: { attachments: true },
        orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }],
      },
      rating: true,
    },
  });
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  res.json({
    ticket: serializeTicket(
      ticket,
      ticket.messages.filter((message) => (
        message.authorType !== 'customer'
        && (!ticket.customerLastReadAt || message.sentAt > ticket.customerLastReadAt)
      )).length,
    ),
    messages: ticket.messages.map(serializeMessage),
    rating: ticket.rating ? {
      isSatisfied: ticket.rating.isSatisfied,
      comment: ticket.rating.comment,
      createdAt: ticket.rating.createdAt,
    } : null,
  });
}

export async function handleCreateSupportMessage(req: Request, res: Response): Promise<void> {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const rawBody = typeof (req.body || {}).message === 'string' ? (req.body || {}).message.trim() : '';
  const body = rawBody.slice(0, MAX_MESSAGE_LENGTH);
  if (!body) {
    res.status(400).json({ error: 'Введите сообщение.' });
    return;
  }
  if (rawBody.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `Сообщение не должно превышать ${MAX_MESSAGE_LENGTH} символов.` });
    return;
  }
  const ticket = await findOwnedTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  if (ticket.status === 'duplicate' || ticket.status === 'spam') {
    res.status(409).json({ error: 'В это обращение больше нельзя отправлять сообщения. Создайте новое.' });
    return;
  }

  const currentStatus = ticket.status as SupportTicketStatus;
  const nextStatus = statusAfterCustomerMessage(currentStatus);
  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const message = await tx.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorAccountId: account.id,
        authorType: 'customer',
        source: 'product',
        visibility: 'public',
        body,
        deliveryStatus: 'pending',
        sentAt: now,
      },
      include: { attachments: true },
    });
    const updatedTicket = await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: nextStatus,
        lastMessageAt: now,
        waitingSince: null,
        waitingReminderSentAt: null,
        holdSince: null,
        resolvedAt: nextStatus === 'reopened' ? null : undefined,
        closedAt: nextStatus === 'reopened' ? null : undefined,
        reopenCount: nextStatus === 'reopened' && currentStatus !== 'reopened' ? { increment: 1 } : undefined,
        syncStatus: 'pending',
      },
    });
    if (nextStatus !== currentStatus) {
      await tx.supportTicketStatusHistory.create({
        data: {
          ticketId: ticket.id,
          changedByAccountId: account.id,
          fromStatus: currentStatus,
          toStatus: nextStatus,
          source: 'product',
          reason: 'Ответ клиента',
        },
      });
    }
    await tx.supportIntegrationOutbox.create({
      data: {
        ticketId: ticket.id,
        eventType: 'message.created',
        payloadJson: JSON.stringify({ ticketId: ticket.id, messageId: message.id }),
        deduplicationKey: `message.created:${message.id}`,
      },
    });
    return { message, ticket: updatedTicket };
  });

  res.status(201).json({ message: serializeMessage(result.message), ticket: serializeTicket(result.ticket) });
}

export async function handleMarkSupportTicketRead(req: Request, res: Response): Promise<void> {
  const ticket = await findOwnedTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  const readAt = new Date();
  await recordCustomerRead(ticket.id, readAt);
  res.json({ ok: true, readAt });
}

export async function handleCloseSupportTicket(req: Request, res: Response): Promise<void> {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const ticket = await findOwnedTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  if (ticket.status === 'closed') {
    res.json({ ticket: serializeTicket(ticket) });
    return;
  }
  if (ticket.status !== 'resolved') {
    res.status(409).json({ error: 'Закрыть можно только решённое обращение.' });
    return;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const saved = await tx.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'closed', closedAt: now, syncStatus: 'pending' },
    });
    await tx.supportTicketStatusHistory.create({
      data: {
        ticketId: ticket.id,
        changedByAccountId: account.id,
        fromStatus: ticket.status,
        toStatus: 'closed',
        source: 'product',
        reason: 'Закрыто клиентом',
      },
    });
    await tx.supportIntegrationOutbox.create({
      data: {
        ticketId: ticket.id,
        eventType: 'ticket.closed',
        payloadJson: JSON.stringify({ ticketId: ticket.id }),
        deduplicationKey: `ticket.closed:${ticket.id}:${now.toISOString()}`,
      },
    });
    return saved;
  });
  res.json({ ticket: serializeTicket(updated) });
}

export async function handleRateSupportTicket(req: Request, res: Response): Promise<void> {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const ticket = await findOwnedTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    res.status(409).json({ error: 'Оценить можно только решённое обращение.' });
    return;
  }
  const isSatisfied = (req.body || {}).isSatisfied;
  if (typeof isSatisfied !== 'boolean') {
    res.status(400).json({ error: 'Укажите оценку обращения.' });
    return;
  }
  const comment = stringValue((req.body || {}).comment, 2000) || null;
  const rating = await prisma.$transaction(async (tx) => {
    const saved = await tx.supportTicketRating.upsert({
      where: { ticketId: ticket.id },
      create: { ticketId: ticket.id, authorAccountId: account.id, isSatisfied, comment },
      update: { isSatisfied, comment },
    });
    await tx.supportIntegrationOutbox.upsert({
      where: { deduplicationKey: `ticket.rating:${ticket.id}` },
      create: {
        ticketId: ticket.id,
        eventType: 'ticket.rating_changed',
        payloadJson: JSON.stringify({ ticketId: ticket.id, isSatisfied, comment }),
        deduplicationKey: `ticket.rating:${ticket.id}`,
      },
      update: {
        payloadJson: JSON.stringify({ ticketId: ticket.id, isSatisfied, comment }),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        processedAt: null,
        lastError: null,
      },
    });
    return saved;
  });
  res.json({ isSatisfied: rating.isSatisfied, comment: rating.comment, updatedAt: rating.updatedAt });
}

export async function handleGetPublicSupportMeta(_req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    categories: PUBLIC_SUPPORT_CATEGORIES,
    maxMessageLength: MAX_MESSAGE_LENGTH,
    supportHours: {
      timezone: config.supportTimezone,
      from: config.supportWorkHoursFrom,
      to: config.supportWorkHoursTo,
      isOpen: supportIsOpen(),
    },
  });
}

export async function handleCreatePublicSupportTicket(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const limit = consumePublicLimit(publicTicketCreateLimits, getPublicRequestIp(req), 5, 10 * 60_000);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    res.status(429).json({ error: 'Слишком много обращений. Попробуйте позже.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  if (stringValue(body.website, 200)) {
    res.status(201).json({ ok: true });
    return;
  }
  const category = stringValue(body.category, 64);
  const requesterName = stringValue(body.name, 160);
  const requesterEmail = stringValue(body.email, 254).toLowerCase();
  const requesterPhone = stringValue(body.phone, 40);
  const subject = stringValue(body.subject, MAX_SUBJECT_LENGTH) || null;
  const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
  const messageBody = rawMessage.slice(0, MAX_MESSAGE_LENGTH);
  const emailValid = !requesterEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail);
  const phoneValid = !requesterPhone || requesterPhone.replace(/\D/g, '').length >= 7;

  if (!PUBLIC_SUPPORT_CATEGORIES.includes(category as any)) {
    res.status(400).json({ error: 'Выберите категорию обращения.' });
    return;
  }
  if (!requesterName) {
    res.status(400).json({ error: 'Укажите имя.' });
    return;
  }
  if ((!requesterEmail && !requesterPhone) || !emailValid || !phoneValid) {
    res.status(400).json({ error: 'Укажите корректный email или номер телефона.' });
    return;
  }
  if (!messageBody) {
    res.status(400).json({ error: 'Опишите ваш вопрос.' });
    return;
  }
  if (rawMessage.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `Сообщение не должно превышать ${MAX_MESSAGE_LENGTH} символов.` });
    return;
  }

  const token = randomBytes(32).toString('hex');
  let created: any = null;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    try {
      created = await prisma.$transaction(async (tx) => {
        const now = new Date();
        const ticket = await tx.supportTicket.create({
          data: {
            number: makeTicketNumber(now),
            requesterName,
            requesterEmail: requesterEmail || null,
            requesterPhone: requesterPhone || null,
            requesterVerified: false,
            publicAccessTokenHash: sha256(token),
            channel: 'login',
            category,
            subject,
            priority: 'P3',
            status: 'new',
            slaFirstResponseMinutes: config.supportSlaFirstResponseMinutes,
            slaResolutionMinutes: config.supportSlaResolutionMinutes,
            firstMessageAt: now,
            lastMessageAt: now,
            customerLastReadAt: now,
          },
        });
        const message = await tx.supportMessage.create({
          data: {
            ticketId: ticket.id,
            authorType: 'customer',
            source: 'product',
            visibility: 'public',
            body: messageBody,
            deliveryStatus: 'pending',
            sentAt: now,
          },
          include: { attachments: true },
        });
        const autoReply = await tx.supportMessage.create({
          data: {
            ticketId: ticket.id,
            authorType: 'system',
            source: 'system',
            visibility: 'public',
            body: publicAutoReply(category, ticket.number, now),
            deliveryStatus: 'sent',
            sentAt: now,
          },
          include: { attachments: true },
        });
        await tx.supportTicketStatusHistory.create({
          data: { ticketId: ticket.id, toStatus: 'new', source: 'product' },
        });
        await tx.supportIntegrationOutbox.create({
          data: {
            ticketId: ticket.id,
            eventType: 'ticket.created',
            payloadJson: JSON.stringify({ ticketId: ticket.id, messageId: message.id }),
            deduplicationKey: `ticket.created:${ticket.id}`,
          },
        });
        return { ticket, messages: [message, autoReply] };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }

  if (!created) {
    res.status(503).json({ error: 'Не удалось создать обращение. Попробуйте ещё раз.' });
    return;
  }
  res.status(201).json({
    accessToken: token,
    ticket: serializeTicket(created.ticket),
    messages: created.messages.map(serializeMessage),
  });
}

export async function handleGetPublicSupportTicket(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const ticket = await prisma.supportTicket.findFirst({
    where: {
      id: req.params.id,
      channel: 'login',
      publicAccessTokenHash: sha256(publicAccessToken(req) || 'invalid'),
    },
    include: {
      messages: {
        where: { visibility: 'public' },
        include: { attachments: true },
        orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }],
      },
      rating: true,
    },
  });
  if (!ticket || !publicAccessToken(req)) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  res.json({
    ticket: serializeTicket(
      ticket,
      ticket.messages.filter((message) => (
        message.authorType !== 'customer'
        && (!ticket.customerLastReadAt || message.sentAt > ticket.customerLastReadAt)
      )).length,
    ),
    messages: ticket.messages.map(serializeMessage),
    rating: ticket.rating ? {
      isSatisfied: ticket.rating.isSatisfied,
      comment: ticket.rating.comment,
      createdAt: ticket.rating.createdAt,
    } : null,
  });
}

export async function handleCreatePublicSupportMessage(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const token = publicAccessToken(req);
  const limitKey = `${getPublicRequestIp(req)}:${token.slice(0, 12) || 'missing'}`;
  const limit = consumePublicLimit(publicTicketMessageLimits, limitKey, 30, 10 * 60_000);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    res.status(429).json({ error: 'Слишком много сообщений. Попробуйте позже.' });
    return;
  }
  const ticket = await findPublicTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  if (ticket.status === 'duplicate' || ticket.status === 'spam') {
    res.status(409).json({ error: 'В это обращение больше нельзя отправлять сообщения.' });
    return;
  }
  const rawBody = typeof (req.body || {}).message === 'string' ? (req.body || {}).message.trim() : '';
  if (!rawBody) {
    res.status(400).json({ error: 'Введите сообщение.' });
    return;
  }
  if (rawBody.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `Сообщение не должно превышать ${MAX_MESSAGE_LENGTH} символов.` });
    return;
  }
  const currentStatus = ticket.status as SupportTicketStatus;
  const nextStatus = statusAfterCustomerMessage(currentStatus);
  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const message = await tx.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorType: 'customer',
        source: 'product',
        visibility: 'public',
        body: rawBody,
        deliveryStatus: 'pending',
        sentAt: now,
      },
      include: { attachments: true },
    });
    const updatedTicket = await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: nextStatus,
        lastMessageAt: now,
        waitingSince: null,
        waitingReminderSentAt: null,
        holdSince: null,
        resolvedAt: nextStatus === 'reopened' ? null : undefined,
        closedAt: nextStatus === 'reopened' ? null : undefined,
        reopenCount: nextStatus === 'reopened' && currentStatus !== 'reopened' ? { increment: 1 } : undefined,
        syncStatus: 'pending',
      },
    });
    if (nextStatus !== currentStatus) {
      await tx.supportTicketStatusHistory.create({
        data: { ticketId: ticket.id, fromStatus: currentStatus, toStatus: nextStatus, source: 'product', reason: 'Ответ клиента' },
      });
    }
    await tx.supportIntegrationOutbox.create({
      data: {
        ticketId: ticket.id,
        eventType: 'message.created',
        payloadJson: JSON.stringify({ ticketId: ticket.id, messageId: message.id }),
        deduplicationKey: `message.created:${message.id}`,
      },
    });
    return { ticket: updatedTicket, message };
  });
  res.status(201).json({ ticket: serializeTicket(result.ticket), message: serializeMessage(result.message) });
}

export async function handleMarkPublicSupportTicketRead(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const ticket = await findPublicTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  const readAt = new Date();
  await recordCustomerRead(ticket.id, readAt);
  res.json({ ok: true, readAt });
}

async function recordCustomerRead(ticketId: string, readAt: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.supportTicket.update({ where: { id: ticketId }, data: { customerLastReadAt: readAt } });
    const unreadBitrixMessages = await tx.supportMessage.count({
      where: {
        ticketId,
        source: 'bitrix24',
        authorType: 'support',
        deliveryStatus: 'received',
        bitrixMessageId: { not: null },
        sentAt: { lte: readAt },
      },
    });
    if (!unreadBitrixMessages) return;
    await tx.supportIntegrationOutbox.create({
      data: {
        ticketId,
        eventType: 'messages.read',
        payloadJson: JSON.stringify({ ticketId, readAt: readAt.toISOString() }),
        deduplicationKey: `messages.read:${ticketId}:${readAt.getTime()}`,
      },
    });
  });
}

function attachmentName(value: unknown): string {
  const normalized = stringValue(value, 240).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized || 'attachment';
}

async function saveAttachment(params: {
  ticketId: string;
  messageId: string;
  originalName: string;
  mimeType: string;
  data: Buffer;
}) {
  const extension = supportAttachmentExtension(params.mimeType);
  if (!extension) throw new Error('UNSUPPORTED_TYPE');
  if (!params.data.length) throw new Error('EMPTY_FILE');
  if (params.data.length > MAX_SUPPORT_ATTACHMENT_BYTES) throw new Error('FILE_TOO_LARGE');
  const attachmentId = randomUUID();
  const storageKey = supportAttachmentKey(params.ticketId, attachmentId, params.mimeType);
  await supportAttachmentStorage.save(storageKey, params.data);
  try {
    return await prisma.$transaction(async (tx) => {
      const attachment = await tx.supportMessageAttachment.create({
        data: {
          id: attachmentId,
          messageId: params.messageId,
          originalName: params.originalName,
          mimeType: params.mimeType,
          sizeBytes: params.data.length,
          storageKey,
        },
      });
      await tx.supportTicket.update({
        where: { id: params.ticketId },
        data: { syncStatus: 'pending' },
      });
      await tx.supportIntegrationOutbox.create({
        data: {
          ticketId: params.ticketId,
          eventType: 'attachment.created',
          payloadJson: JSON.stringify({ ticketId: params.ticketId, messageId: params.messageId, attachmentId }),
          deduplicationKey: `attachment.created:${attachmentId}`,
        },
      });
      return attachment;
    });
  } catch (error) {
    await supportAttachmentStorage.remove(storageKey).catch(() => undefined);
    throw error;
  }
}

function attachmentPayload(attachment: { id: string; originalName: string; mimeType: string; sizeBytes: number }) {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

function attachmentError(res: Response, error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  if (message === 'UNSUPPORTED_TYPE') {
    res.status(415).json({ error: 'Этот тип файла не поддерживается.' });
    return true;
  }
  if (message === 'EMPTY_FILE') {
    res.status(400).json({ error: 'Файл пуст.' });
    return true;
  }
  if (message === 'FILE_TOO_LARGE' || message.includes('too large')) {
    res.status(413).json({ error: 'Размер файла не должен превышать 10 МБ.' });
    return true;
  }
  return false;
}

export async function handleUploadSupportAttachment(req: Request, res: Response): Promise<void> {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const message = await prisma.supportMessage.findFirst({
    where: {
      id: req.params.messageId,
      ticketId: req.params.id,
      authorAccountId: account.id,
      authorType: 'customer',
      ticket: { requesterAccountId: account.id },
    },
  });
  if (!message) {
    res.status(404).json({ error: 'Сообщение не найдено.' });
    return;
  }
  try {
    const attachment = await saveAttachment({
      ticketId: req.params.id,
      messageId: message.id,
      originalName: attachmentName(req.query.filename),
      mimeType: String(req.get('content-type') || '').toLowerCase().split(';')[0],
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    res.status(201).json(attachmentPayload(attachment));
  } catch (error) {
    if (attachmentError(res, error)) return;
    throw error;
  }
}

export async function handleUploadPublicSupportAttachment(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const ticket = await findPublicTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  const message = await prisma.supportMessage.findFirst({
    where: { id: req.params.messageId, ticketId: ticket.id, authorType: 'customer' },
  });
  if (!message) {
    res.status(404).json({ error: 'Сообщение не найдено.' });
    return;
  }
  try {
    const attachment = await saveAttachment({
      ticketId: ticket.id,
      messageId: message.id,
      originalName: attachmentName(req.query.filename),
      mimeType: String(req.get('content-type') || '').toLowerCase().split(';')[0],
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    res.status(201).json(attachmentPayload(attachment));
  } catch (error) {
    if (attachmentError(res, error)) return;
    throw error;
  }
}

async function sendAttachmentFile(res: Response, attachment: {
  originalName: string;
  mimeType: string;
  storageKey: string;
}): Promise<void> {
  const inline = attachment.mimeType.startsWith('image/');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
  );
  res.sendFile(supportAttachmentStorage.resolvePath(attachment.storageKey), (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: 'Файл не найден.' });
  });
}

export async function handleDownloadSupportAttachment(req: Request, res: Response): Promise<void> {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  const attachment = await prisma.supportMessageAttachment.findFirst({
    where: { id: req.params.attachmentId, message: { ticket: { requesterAccountId: account.id } } },
  });
  if (!attachment) {
    res.status(404).json({ error: 'Файл не найден.' });
    return;
  }
  await sendAttachmentFile(res, attachment);
}

export async function handleDownloadPublicSupportAttachment(req: Request, res: Response): Promise<void> {
  const ticket = await findPublicTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Файл не найден.' });
    return;
  }
  const attachment = await prisma.supportMessageAttachment.findFirst({
    where: { id: req.params.attachmentId, message: { ticketId: ticket.id } },
  });
  if (!attachment) {
    res.status(404).json({ error: 'Файл не найден.' });
    return;
  }
  await sendAttachmentFile(res, attachment);
}

export async function handleDownloadBitrixSupportAttachment(req: Request, res: Response): Promise<void> {
  const expiresAt = Number(req.query.expires);
  const signature = typeof req.query.signature === 'string' ? req.query.signature : '';
  const secret = config.bitrix24SupportTokenKey || '';
  if (!verifySupportAttachmentLink({
    attachmentId: req.params.attachmentId,
    expiresAt,
    signature,
    secret,
  })) {
    res.status(403).json({ error: 'Ссылка на файл недействительна или устарела.' });
    return;
  }
  const attachment = await prisma.supportMessageAttachment.findUnique({
    where: { id: req.params.attachmentId },
  });
  if (!attachment) {
    res.status(404).json({ error: 'Файл не найден.' });
    return;
  }
  await sendAttachmentFile(res, attachment);
}

export async function handleRatePublicSupportTicket(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const ticket = await findPublicTicket(req, req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Обращение не найдено.' });
    return;
  }
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    res.status(409).json({ error: 'Оценить можно только решённое обращение.' });
    return;
  }
  const isSatisfied = (req.body || {}).isSatisfied;
  if (typeof isSatisfied !== 'boolean') {
    res.status(400).json({ error: 'Укажите оценку обращения.' });
    return;
  }
  const comment = stringValue((req.body || {}).comment, 2000) || null;
  const rating = await prisma.$transaction(async (tx) => {
    const saved = await tx.supportTicketRating.upsert({
      where: { ticketId: ticket.id },
      create: { ticketId: ticket.id, isSatisfied, comment },
      update: { isSatisfied, comment },
    });
    await tx.supportIntegrationOutbox.upsert({
      where: { deduplicationKey: `ticket.rating:${ticket.id}` },
      create: {
        ticketId: ticket.id,
        eventType: 'ticket.rating_changed',
        payloadJson: JSON.stringify({ ticketId: ticket.id, isSatisfied, comment }),
        deduplicationKey: `ticket.rating:${ticket.id}`,
      },
      update: {
        payloadJson: JSON.stringify({ ticketId: ticket.id, isSatisfied, comment }),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        processedAt: null,
        lastError: null,
      },
    });
    return saved;
  });
  res.json({ isSatisfied: rating.isSatisfied, comment: rating.comment, updatedAt: rating.updatedAt });
}
