import { prisma } from '../db';

/** The hypothesis screen and production Realtime must select the same voice
 * BEFORE building the prompt, including its grammatical-gender hint. */
export async function resolveCustomerVoiceForProfile(profile: { voiceId: string | null } | null, streaming = false) {
  const selected = profile?.voiceId ? await prisma.callCustomerVoice.findFirst({
    where: { id: profile.voiceId, isDeleted: false, isEnabled: true },
    select: { id: true, name: true, elevenLabsCode: true },
  }) : null;
  if (!streaming || selected?.elevenLabsCode?.trim()) return selected;
  return await prisma.callCustomerVoice.findFirst({
    where: { isDeleted: false, isEnabled: true, elevenLabsCode: { not: null } },
    select: { id: true, name: true, elevenLabsCode: true },
    orderBy: { createdAt: 'asc' },
  }) ?? selected;
}
