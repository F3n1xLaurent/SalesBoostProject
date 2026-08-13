import { prisma } from '../db';

export type PhoneCallStats = {
  totalCalls: number;
  successfulCalls: number;
  missedCalls: number;
};

export function normalizeCallPhone(value: string): string {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

export async function getPhoneCallStats(phones: string[]): Promise<Map<string, PhoneCallStats>> {
  const normalizedPhones = [...new Set(phones.map(normalizeCallPhone).filter(Boolean))];
  const result = new Map<string, PhoneCallStats>(
    normalizedPhones.map((phone) => [phone, { totalCalls: 0, successfulCalls: 0, missedCalls: 0 }]),
  );
  if (normalizedPhones.length === 0) return result;

  const sessions = await prisma.voiceCallSession.findMany({
    where: { to: { in: normalizedPhones } },
    select: { to: true, outcome: true },
  });
  for (const session of sessions) {
    const phone = normalizeCallPhone(session.to);
    const stats = result.get(phone);
    if (!stats) continue;
    stats.totalCalls += 1;
    if (session.outcome === 'completed' || session.outcome === 'disconnected') stats.successfulCalls += 1;
    if (session.outcome === 'no_answer' || session.outcome === 'busy' || session.outcome === 'failed') stats.missedCalls += 1;
  }
  return result;
}
