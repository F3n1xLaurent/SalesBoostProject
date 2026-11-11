import type { Request } from 'express';
import { recordProductEvent, type RecordProductEventInput, type ProductRole } from './productAnalytics';
export function recordRequestEvent(req: Request, input: RecordProductEventInput): void {
  const account = req.authAccount;
  if (!account)
    return;
  const requested: Record<string, string> = { super: 'platform_superadmin', company: 'holding_admin', dealer: 'dealership_admin', staff: 'manager' };
  const active = requested[String(req.get('x-admin-role') ?? '')];
  const membership = account.memberships.find(item => item.role === 'platform_superadmin') ?? account.memberships.find(item => item.role === active) ?? account.memberships[0];
  void recordProductEvent({ accountId: account.id, role: membership?.role as ProductRole, companyId: membership?.holdingId, branchId: membership?.dealershipId, ...input }).catch(error => console.warn('[analytics] request event failed', error instanceof Error ? error.message : error));
}
