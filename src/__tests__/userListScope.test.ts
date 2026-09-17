import { describe, expect, it } from 'vitest';
import { buildUserListScopeWhere } from '../auth/userListScope';

describe('users list organization scope', () => {
  it('does not restrict a platform superadmin', () => {
    expect(buildUserListScopeWhere({
      isPlatformSuperadmin: true,
      holdingIds: [],
      dealershipIds: [],
    })).toEqual({});
  });

  it('keeps every account membership in the holding visible after a role change', () => {
    const where = buildUserListScopeWhere({
      isPlatformSuperadmin: false,
      holdingIds: ['holding-1'],
      dealershipIds: [],
    });

    expect(where).toEqual({
      OR: [
        {
          memberships: {
            some: { holdingId: { in: ['holding-1'] } },
          },
        },
        {
          memberships: {
            some: { dealership: { holdingId: { in: ['holding-1'] } } },
          },
        },
        {
          managerProfiles: {
            some: { dealership: { holdingId: { in: ['holding-1'] } } },
          },
        },
      ],
    });
    expect(JSON.stringify(where)).not.toContain('"role"');
  });

  it('keeps every account membership in the dealership visible after a role change', () => {
    const where = buildUserListScopeWhere({
      isPlatformSuperadmin: false,
      holdingIds: [],
      dealershipIds: ['dealership-1'],
    });

    expect(where).toEqual({
      OR: [
        {
          memberships: {
            some: { dealershipId: { in: ['dealership-1'] } },
          },
        },
        {
          managerProfiles: {
            some: { dealershipId: { in: ['dealership-1'] } },
          },
        },
      ],
    });
    expect(JSON.stringify(where)).not.toContain('"role"');
  });
});
