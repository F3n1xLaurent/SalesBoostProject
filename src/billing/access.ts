import { prisma } from '../db';

export type BillingModule = 'calls' | 'trainer';
export type AccessPayment = { calls: boolean; trainer: boolean; status: string; startsAt: Date; endsAt: Date | null };

export function calculateBillingAccess(enabled: boolean, payments: AccessPayment[], at = new Date()) {
  const active = payments.filter((p) => p.status === 'active' && p.startsAt <= at && (!p.endsAt || p.endsAt >= at));
  return {
    calls: !enabled || active.some((p) => p.calls),
    trainer: !enabled || active.some((p) => p.trainer),
  };
}

export class BillingAccessError extends Error {
  readonly status = 403;
  constructor(module: BillingModule) {
    super(`Для компании не оплачен ${module === 'calls' ? 'обзвон точек' : 'тренажёр'} на текущую дату. Обратитесь к администратору.`);
  }
}

export async function assertCompanyModule(holdingId: string | null | undefined, module: BillingModule) {
  // Legacy/unassigned entities have no company billing settings.
  if (!holdingId) return;
  const holding = await prisma.holding.findUnique({
    where: { id: holdingId },
    select: { billingEnabled: true, billingPayments: { where: { status: 'active', [module]: true } } },
  });
  if (holding && !calculateBillingAccess(holding.billingEnabled, holding.billingPayments)[module]) {
    throw new BillingAccessError(module);
  }
}

export async function assertDealershipModule(dealershipId: string | null | undefined, module: BillingModule) {
  if (!dealershipId) return;
  const dealer = await prisma.dealership.findUnique({ where: { id: dealershipId }, select: { holdingId: true } });
  await assertCompanyModule(dealer?.holdingId, module);
}
