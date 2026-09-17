import type { Prisma } from '@prisma/client';

type UserListScope = {
  isPlatformSuperadmin: boolean;
  holdingIds: string[];
  dealershipIds: string[];
};

/**
 * Limits the users list to accounts attached to the active organization scope.
 *
 * The role itself must not be part of this filter: changing a membership from
 * manager to an administrator role should not make the account disappear from
 * the same holding/dealership. Authorization for editing remains a separate
 * concern and is enforced by the mutation handlers.
 */
export function buildUserListScopeWhere(scope: UserListScope): Prisma.AccountWhereInput {
  if (scope.isPlatformSuperadmin) return {};

  const scopedAccounts: Prisma.AccountWhereInput[] = [];

  if (scope.holdingIds.length > 0) {
    scopedAccounts.push(
      {
        memberships: {
          some: {
            holdingId: { in: scope.holdingIds },
          },
        },
      },
      {
        memberships: {
          some: {
            dealership: {
              holdingId: { in: scope.holdingIds },
            },
          },
        },
      },
      {
        managerProfiles: {
          some: {
            dealership: {
              holdingId: { in: scope.holdingIds },
            },
          },
        },
      },
    );
  }

  if (scope.dealershipIds.length > 0) {
    scopedAccounts.push(
      {
        memberships: {
          some: {
            dealershipId: { in: scope.dealershipIds },
          },
        },
      },
      {
        managerProfiles: {
          some: {
            dealershipId: { in: scope.dealershipIds },
          },
        },
      },
    );
  }

  return { OR: scopedAccounts };
}
