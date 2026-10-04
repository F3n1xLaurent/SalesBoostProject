import { describe, expect, it } from 'vitest';
import { signSupportAttachmentLink, verifySupportAttachmentLink } from '../support/attachmentLinks';

describe('support attachment external links', () => {
  const secret = 'test-only-support-attachment-signing-secret';
  const attachmentId = 'b2464f07-9ee9-4f20-b81d-a98b4d52f093';
  const now = 1_800_000_000_000;
  const expiresAt = now + 60_000;

  it('accepts a valid unexpired signature', () => {
    const signature = signSupportAttachmentLink(attachmentId, expiresAt, secret);
    expect(verifySupportAttachmentLink({ attachmentId, expiresAt, signature, secret, now })).toBe(true);
  });

  it('rejects expired and modified links', () => {
    const signature = signSupportAttachmentLink(attachmentId, expiresAt, secret);
    expect(verifySupportAttachmentLink({ attachmentId, expiresAt, signature, secret, now: expiresAt })).toBe(false);
    expect(verifySupportAttachmentLink({ attachmentId: `${attachmentId}x`, expiresAt, signature, secret, now })).toBe(false);
  });
});
