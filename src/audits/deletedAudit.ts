import type { PrismaClient } from '@prisma/client';

// A durable audit trail also prevents delayed telephony webhooks recreating a deleted call.
export const deletedAuditMarkerId = (callId: string) => `audit-deleted:voice:${callId}`;

export async function wasVoiceAuditDeleted(db: PrismaClient, callId: string): Promise<boolean> {
  return Boolean(await db.productAnalyticsEvent.findUnique({
    where: { id: deletedAuditMarkerId(callId) }, select: { id: true },
  }));
}
