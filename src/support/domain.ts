export const SUPPORT_TICKET_STATUSES = [
  'new',
  'open',
  'waiting',
  'on_hold',
  'resolved',
  'closed',
  'reopened',
  'duplicate',
  'spam',
] as const;

export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const SUPPORT_TICKET_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number];

export const AUTHENTICATED_SUPPORT_CATEGORIES = [
  'access_and_roles',
  'billing_and_plans',
  'product_usage',
  'integrations_and_api',
  'ai_score_review',
  'product_feedback',
  'data_import',
  'technical_issue',
  'other',
] as const;

export const PUBLIC_SUPPORT_CATEGORIES = [
  'registration',
  'password_recovery',
  'other',
] as const;

const ALLOWED_TRANSITIONS: Record<SupportTicketStatus, ReadonlySet<SupportTicketStatus>> = {
  new: new Set(['open', 'duplicate', 'spam']),
  open: new Set(['waiting', 'on_hold', 'resolved', 'duplicate', 'spam']),
  waiting: new Set(['reopened', 'resolved', 'closed', 'duplicate', 'spam']),
  on_hold: new Set(['reopened', 'resolved', 'duplicate', 'spam']),
  resolved: new Set(['reopened', 'closed']),
  closed: new Set(['reopened']),
  reopened: new Set(['open', 'waiting', 'on_hold', 'resolved', 'duplicate', 'spam']),
  duplicate: new Set(),
  spam: new Set(),
};

export function isSupportTicketStatus(value: string): value is SupportTicketStatus {
  return SUPPORT_TICKET_STATUSES.includes(value as SupportTicketStatus);
}

export function canTransitionSupportTicket(
  from: SupportTicketStatus,
  to: SupportTicketStatus,
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].has(to);
}

export type StatusTransitionContext = {
  hasPublicSupportReply?: boolean;
  hasPublicMessageForWaiting?: boolean;
};

export function validateSupportTicketTransition(
  from: SupportTicketStatus,
  to: SupportTicketStatus,
  context: StatusTransitionContext = {},
): string | null {
  if (!canTransitionSupportTicket(from, to)) {
    return `Переход из статуса ${from} в ${to} недоступен.`;
  }

  if (to === 'resolved' && !context.hasPublicSupportReply) {
    return 'Перед переводом в «Решено» нужен публичный ответ клиенту.';
  }

  if (to === 'waiting' && !context.hasPublicMessageForWaiting) {
    return 'Переход в «Ожидающий» должен сопровождаться сообщением клиенту.';
  }

  return null;
}

export function statusAfterCustomerMessage(status: SupportTicketStatus): SupportTicketStatus {
  if (status === 'waiting' || status === 'on_hold' || status === 'resolved' || status === 'closed') {
    return 'reopened';
  }
  return status;
}

export function shouldRequestCustomerRating(status: SupportTicketStatus): boolean {
  return status === 'resolved';
}

