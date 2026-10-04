import type { SupportMessage, SupportTicket } from './support';

export type PublicSupportReference = { id: string; accessToken: string };

async function publicSupportJson<T>(url: string, init: RequestInit = {}, accessToken?: string): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('X-Support-Token', accessToken);
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.error || 'Ошибка запроса') as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

export function getPublicSupportMeta(): Promise<{
  categories: string[];
  maxMessageLength: number;
  supportHours: { timezone: string; from: number; to: number; isOpen: boolean };
}> {
  return publicSupportJson('/api/public/support/meta');
}

export function createPublicSupportTicket(input: {
  category: string;
  name: string;
  email?: string;
  phone?: string;
  subject?: string;
  message: string;
  website?: string;
}): Promise<{ accessToken: string; ticket: SupportTicket; messages: SupportMessage[] }> {
  return publicSupportJson('/api/public/support/tickets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getPublicSupportTicket(reference: PublicSupportReference): Promise<{
  ticket: SupportTicket;
  messages: SupportMessage[];
  rating: { isSatisfied: boolean; comment: string | null; createdAt: string } | null;
}> {
  return publicSupportJson(
    `/api/public/support/tickets/${encodeURIComponent(reference.id)}`,
    {},
    reference.accessToken,
  );
}

export function sendPublicSupportMessage(reference: PublicSupportReference, message: string): Promise<{
  ticket: SupportTicket;
  message: SupportMessage;
}> {
  return publicSupportJson(
    `/api/public/support/tickets/${encodeURIComponent(reference.id)}/messages`,
    { method: 'POST', body: JSON.stringify({ message }) },
    reference.accessToken,
  );
}

export function markPublicSupportTicketRead(reference: PublicSupportReference): Promise<{ ok: true; readAt: string }> {
  return publicSupportJson(
    `/api/public/support/tickets/${encodeURIComponent(reference.id)}/read`,
    { method: 'POST' },
    reference.accessToken,
  );
}

export function ratePublicSupportTicket(
  reference: PublicSupportReference,
  input: { isSatisfied: boolean; comment?: string },
): Promise<{ isSatisfied: boolean; comment: string | null; updatedAt: string }> {
  return publicSupportJson(
    `/api/public/support/tickets/${encodeURIComponent(reference.id)}/rating`,
    { method: 'PUT', body: JSON.stringify(input) },
    reference.accessToken,
  );
}

export function uploadPublicSupportAttachment(
  reference: PublicSupportReference,
  messageId: string,
  file: File,
): Promise<SupportMessage['attachments'][number]> {
  return publicSupportJson(
    `/api/public/support/tickets/${encodeURIComponent(reference.id)}/messages/${encodeURIComponent(messageId)}/attachments?filename=${encodeURIComponent(file.name)}`,
    { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file },
    reference.accessToken,
  );
}

export async function downloadPublicSupportAttachment(
  reference: PublicSupportReference,
  attachmentId: string,
): Promise<Blob> {
  const response = await fetch(
    `/api/public/support/tickets/${encodeURIComponent(reference.id)}/attachments/${encodeURIComponent(attachmentId)}`,
    { headers: { 'X-Support-Token': reference.accessToken } },
  );
  if (!response.ok) throw new Error('Не удалось загрузить файл.');
  return response.blob();
}
