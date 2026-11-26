import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../voice/callPlanTelephony', () => ({
  prepareCallPlanTelephony: vi.fn(),
  markCallPlanLaunchFailed: vi.fn(),
  resolveCallPlanTelephonyProvider: () => 'pipecat',
}));
vi.mock('../billing/access', () => ({ assertCompanyModule: vi.fn(), BillingAccessError: class extends Error {} }));

import { prisma } from '../db';
import { prepareCallPlanTelephony } from '../voice/callPlanTelephony';
import { handleInitiateCallPlan, startCallPlanScheduler } from '../voice/callSettingsManagement';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const plan = { id: 'plan', holdingId: 'company', scriptId: 'script', targetType: 'dealerships',
  targetPhoneScope: 'dealerships', targetIdsJson: '["branch"]', frequency: 'daily' } as any;
const target = { id: 'branch', name: 'Branch', phoneNumbers: [{ id: 'phone', typeId: 'type', phone: '+70000000000' }] };
const script = { id: 'script', holdingId: 'company', profileIdsJson: '[]', dataConditionJson: '{"tags":["С пробегом"]}' } as any;

it('returns a clear manual-launch error before queuing or preparing any call when selection is empty', async () => {
  vi.spyOn(prisma.callPlan, 'findUnique').mockResolvedValue(plan);
  vi.spyOn(prisma.dealership, 'findMany').mockResolvedValue([target] as any);
  vi.spyOn(prisma.holding, 'findUnique').mockResolvedValue({ name: 'Company', description: '' } as any);
  vi.spyOn(prisma.callScript, 'findFirst').mockResolvedValue(script);
  vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([]);
  const create = vi.spyOn(prisma.callPlanCall, 'create');
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

  await handleInitiateCallPlan({ params: { id: 'plan' }, authAccount: { memberships: [{ role: 'platform_superadmin' }] } } as any, res as any);

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Не найден активный объект со всеми тегами') });
  expect(create).not.toHaveBeenCalled();
  expect(prepareCallPlanTelephony).not.toHaveBeenCalled();
});

it('fails an old queued job with missing selection before telephony preparation', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(prisma.callPlan, 'findMany').mockResolvedValue([]);
  vi.spyOn(prisma.callPlan, 'findUnique').mockResolvedValue(plan);
  vi.spyOn(prisma.dealership, 'findMany').mockResolvedValue([target] as any);
  vi.spyOn(prisma.callScript, 'findFirst').mockResolvedValue(script);
  vi.spyOn(prisma.callPlanCall, 'findMany').mockResolvedValue([{ id: 'queued', callId: 'scheduled:old', planId: 'plan',
    plan, scriptId: 'script', importedItemId: null, phoneNumberId: 'phone', targetKind: 'dealership',
    dealershipId: 'branch', phone: '+70000000000' }] as any);
  vi.spyOn(prisma.callPlanCall, 'updateMany').mockResolvedValue({ count: 1 });
  const update = vi.spyOn(prisma.callPlanCall, 'update').mockResolvedValue({} as any);

  startCallPlanScheduler();
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ where: { id: 'queued' }, data: {
    status: 'failed', outcome: 'failed', endedAt: expect.any(Date), failureReason: expect.stringContaining('не выбран объект'),
  } }));

  expect(prepareCallPlanTelephony).not.toHaveBeenCalled();
});
