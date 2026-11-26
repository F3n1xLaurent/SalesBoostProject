import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../voice/customerVoiceSelection', () => ({ resolveCustomerVoiceForProfile: vi.fn().mockResolvedValue(null) }));
import { prisma } from '../db';
import { resolveRealtimeTestPlanConfiguration } from '../voice/callSettingsManagement';

afterEach(() => vi.restoreAllMocks());

it.each(['dealerships', 'employees'])('uses the target branch schedule for %s, independently of the call plan timezone', async (targetType) => {
  const visitSchedule = { workingHoursFrom: '11:30', workingHoursTo: '20:00', timezoneOffsetMinutes: 240 };
  const phone = { id: 'phone', typeId: 'type', phone: '+70000000000', type: { name: 'Рабочий', ownership: 'company' } };
  const branch = { id: 'branch', name: 'Салон', city: 'Самара', address: 'Тестовый адрес', ...visitSchedule, phoneNumbers: [phone] };
  vi.spyOn(prisma.callPlan, 'findUnique').mockResolvedValue({ id: 'plan', name: 'План', holdingId: 'company',
    scriptId: 'script', targetType, targetPhoneScope: 'dealerships', targetIdsJson: '["branch"]', timezoneOffsetMinutes: 180 } as any);
  vi.spyOn(prisma.holding, 'findUnique').mockResolvedValue({ name: 'Компания', description: '' } as any);
  vi.spyOn(prisma.callScript, 'findFirst').mockResolvedValue({ id: 'script', name: 'Покупка автомобиля',
    holdingId: 'company', context: 'Нужен семейный автомобиль', profileIdsJson: '[]', dataConditionJson: '{"tags":[]}',
    questionsJson: '[]', objectionsJson: '[]', successCriteriaJson: '[]' } as any);
  vi.spyOn(prisma.dealership, 'findMany').mockResolvedValue([branch] as any);
  vi.spyOn(prisma.managerProfile, 'findMany').mockResolvedValue([{ id: 'employee', fullName: 'Тестовый менеджер',
    dealershipId: branch.id, dealership: branch, account: { id: 'account', phoneNumbers: [phone] } }] as any);
  const result = await resolveRealtimeTestPlanConfiguration({ authAccount: { memberships: [{ role: 'platform_superadmin' }] } } as any, 'plan');
  expect(result.visitSchedule).toEqual(visitSchedule);
  expect(result.targetLocation?.city).toBe(branch.city);
});
