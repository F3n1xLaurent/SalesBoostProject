import { describe, expect, it } from 'vitest';
import { splitDealershipScopeFromMemberships } from '../auth/userManagement';

describe('manager profile dealership scope', () => {
  it('uses only the selected dealership when a membership contains both company and dealership', () => {
    expect(splitDealershipScopeFromMemberships([
      { holdingId: 'holding-1', dealershipId: 'dealership-1' },
    ])).toEqual({
      directDealershipIds: ['dealership-1'],
      holdingIds: [],
    });
  });

  it('expands a company only when no dealership is selected for that membership', () => {
    expect(splitDealershipScopeFromMemberships([
      { holdingId: 'holding-1', dealershipId: null },
    ])).toEqual({
      directDealershipIds: [],
      holdingIds: ['holding-1'],
    });
  });

  it('keeps direct and company-wide memberships independent', () => {
    expect(splitDealershipScopeFromMemberships([
      { holdingId: 'holding-1', dealershipId: 'dealership-1' },
      { holdingId: 'holding-2', dealershipId: null },
    ])).toEqual({
      directDealershipIds: ['dealership-1'],
      holdingIds: ['holding-2'],
    });
  });
});
