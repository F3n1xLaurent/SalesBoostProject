import type { Prisma } from '@prisma/client';

type EmployeePhoneUniquenessClient = Pick<Prisma.TransactionClient, 'managerProfile' | 'phoneNumber'>;

export class EmployeePhoneConflictError extends Error {
  constructor(public readonly ownerName: string) {
    super(`Номер телефона уже принадлежит сотруднику ${ownerName}`);
    this.name = 'EmployeePhoneConflictError';
  }
}

export function normalizeEmployeePhoneKey(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits;
}

export async function assertEmployeePhoneUniqueWithinDealerships(
  db: EmployeePhoneUniquenessClient,
  params: {
    accountId: string;
    phone: string;
    excludePhoneNumberId?: string;
  },
): Promise<void> {
  const normalizedPhone = normalizeEmployeePhoneKey(params.phone);
  if (!normalizedPhone) return;

  const targetProfiles = await db.managerProfile.findMany({
    where: { accountId: params.accountId },
    select: { dealershipId: true },
  });
  const dealershipIds = [...new Set(targetProfiles.map((profile) => profile.dealershipId))];
  if (dealershipIds.length === 0) return;

  const scopedProfiles = await db.managerProfile.findMany({
    where: {
      dealershipId: { in: dealershipIds },
    },
    select: {
      accountId: true,
      fullName: true,
      dealershipId: true,
      phone: true,
    },
    orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
  });
  const legacyProfileDuplicate = scopedProfiles.find((profile) =>
    profile.accountId !== params.accountId
      && normalizeEmployeePhoneKey(profile.phone) === normalizedPhone);
  if (legacyProfileDuplicate) {
    throw new EmployeePhoneConflictError(legacyProfileDuplicate.fullName.trim() || 'Без имени');
  }

  const scopedAccountIds = [...new Set(scopedProfiles
    .map((profile) => profile.accountId)
    .filter((accountId): accountId is string => Boolean(accountId)))];
  if (scopedAccountIds.length === 0) return;

  const phoneNumbers = await db.phoneNumber.findMany({
    where: {
      accountId: { in: scopedAccountIds },
      ...(params.excludePhoneNumberId ? { id: { not: params.excludePhoneNumberId } } : {}),
    },
    select: { accountId: true, phone: true },
    orderBy: { createdAt: 'asc' },
  });
  const duplicate = phoneNumbers.find((phoneNumber) =>
    normalizeEmployeePhoneKey(phoneNumber.phone) === normalizedPhone);
  if (!duplicate?.accountId) return;

  const owner = scopedProfiles.find((profile) => profile.accountId === duplicate.accountId);
  throw new EmployeePhoneConflictError(owner?.fullName.trim() || 'Без имени');
}
