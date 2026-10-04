import { describe, expect, it } from 'vitest';
import { calculateSupportActiveTimeMs } from '../support/automation';

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes));
}

describe('support SLA active time', () => {
  it('does not count waiting and hold intervals', () => {
    const activeMs = calculateSupportActiveTimeMs({
      createdAt: at(0),
      until: at(100),
      history: [
        { toStatus: 'new', createdAt: at(0) },
        { toStatus: 'open', createdAt: at(10) },
        { toStatus: 'waiting', createdAt: at(20) },
        { toStatus: 'reopened', createdAt: at(50) },
        { toStatus: 'on_hold', createdAt: at(70) },
        { toStatus: 'reopened', createdAt: at(90) },
      ],
    });
    expect(activeMs).toBe(50 * 60_000);
  });

  it('counts continuous time for a new ticket', () => {
    expect(calculateSupportActiveTimeMs({
      createdAt: at(0),
      until: at(45),
      history: [{ toStatus: 'new', createdAt: at(0) }],
    })).toBe(45 * 60_000);
  });

  it('ignores history events after the requested end time', () => {
    expect(calculateSupportActiveTimeMs({
      createdAt: at(0),
      until: at(30),
      history: [
        { toStatus: 'waiting', createdAt: at(20) },
        { toStatus: 'reopened', createdAt: at(60) },
      ],
    })).toBe(20 * 60_000);
  });
});
