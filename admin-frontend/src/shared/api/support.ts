import { apiFetch, apiJson } from '../../entities/session';

export type SupportTicketStatus =
  | 'new'
  | 'open'
  | 'waiting'
  | 'on_hold'
  | 'resolved'
  | 'closed'
  | 'reopened'
  | 'duplicate'
  | 'spam';

export type SupportTicket = {
  id: string;
  number: string;
  category: string;
  subcategory: string | null;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  status: SupportTicketStatus;
  subject: string | null;
  channel: 'product' | 'login' | 'bitrix24';
  holdingId: string | null;
  dealershipId: string | null;
  firstMessageAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  lastMessageAt: string;
  reopenCount: number;
  slaFirstResponseMinutes: number | null;
  slaResolutionMinutes: number | null;
  slaFirstResponseBreached: boolean;
  slaResolutionBreached: boolean;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SupportMessage = {
  id: string;
  authorType: 'customer' | 'support' | 'system';
  body: string;
  source: 'product' | 'bitrix24' | 'system';
  deliveryStatus: 'pending' | 'sent' | 'failed' | 'received';
  sentAt: string;
  editedAt: string | null;
  attachments: Array<{
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
  }>;
};

export type SupportMeta = {
  categories: string[];
  statuses: SupportTicketStatus[];
  maxMessageLength: number;
};

export function getSupportMeta(): Promise<SupportMeta> {
  return apiJson('/api/support/meta');
}

export function listSupportTickets(params: {
  page?: number;
  limit?: number;
  status?: SupportTicketStatus;
} = {}): Promise<{ items: SupportTicket[]; page: number; limit: number; total: number; pages: number }> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  const suffix = query.size ? `?${query.toString()}` : '';
  return apiJson(`/api/support/tickets${suffix}`);
}

export function createSupportTicket(input: {
  category: string;
  subject?: string;
  message: string;
  holdingId?: string;
  dealershipId?: string;
}): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
  return apiJson('/api/support/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function getSupportTicket(id: string): Promise<{
  ticket: SupportTicket;
  messages: SupportMessage[];
  rating: { isSatisfied: boolean; comment: string | null; createdAt: string } | null;
}> {
  return apiJson(`/api/support/tickets/${encodeURIComponent(id)}`);
}

export function sendSupportMessage(id: string, message: string): Promise<{
  ticket: SupportTicket;
  message: SupportMessage;
}> {
  return apiJson(`/api/support/tickets/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export async function uploadSupportAttachment(ticketId: string, messageId: string, file: File) {
  const response = await apiFetch(
    `/api/support/tickets/${encodeURIComponent(ticketId)}/messages/${encodeURIComponent(messageId)}/attachments?filename=${encodeURIComponent(file.name)}`,
    { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file },
  );
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error || 'Не удалось загрузить файл.');
  return data as SupportMessage['attachments'][number];
}

export async function downloadSupportAttachment(attachmentId: string): Promise<Blob> {
  const response = await apiFetch(`/api/support/attachments/${encodeURIComponent(attachmentId)}`);
  if (!response.ok) throw new Error('Не удалось загрузить файл.');
  return response.blob();
}

export function markSupportTicketRead(id: string): Promise<{ ok: true; readAt: string }> {
  return apiJson(`/api/support/tickets/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

export function closeSupportTicket(id: string): Promise<{ ticket: SupportTicket }> {
  return apiJson(`/api/support/tickets/${encodeURIComponent(id)}/close`, { method: 'POST' });
}

export function rateSupportTicket(
  id: string,
  input: { isSatisfied: boolean; comment?: string },
): Promise<{ isSatisfied: boolean; comment: string | null; updatedAt: string }> {
  return apiJson(`/api/support/tickets/${encodeURIComponent(id)}/rating`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
