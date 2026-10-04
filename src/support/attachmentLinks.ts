import { createHmac, timingSafeEqual } from 'crypto';

const MAX_LINK_LIFETIME_MS = 48 * 60 * 60 * 1000;

function signaturePayload(attachmentId: string, expiresAt: number): string {
  return `support-attachment:${attachmentId}:${expiresAt}`;
}

export function signSupportAttachmentLink(attachmentId: string, expiresAt: number, secret: string): string {
  if (!attachmentId || !Number.isSafeInteger(expiresAt) || !secret) throw new Error('INVALID_ATTACHMENT_LINK_INPUT');
  return createHmac('sha256', secret).update(signaturePayload(attachmentId, expiresAt)).digest('base64url');
}

export function verifySupportAttachmentLink(params: {
  attachmentId: string;
  expiresAt: number;
  signature: string;
  secret: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  if (
    !params.attachmentId
    || !Number.isSafeInteger(params.expiresAt)
    || params.expiresAt <= now
    || params.expiresAt > now + MAX_LINK_LIFETIME_MS
    || !/^[A-Za-z0-9_-]{43}$/.test(params.signature)
    || !params.secret
  ) return false;
  const expected = signSupportAttachmentLink(params.attachmentId, params.expiresAt, params.secret);
  const actualBuffer = Buffer.from(params.signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
