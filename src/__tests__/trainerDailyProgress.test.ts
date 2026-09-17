import { describe, expect, it } from 'vitest';
import { countTodayCompletedTrainings } from '../../admin-frontend/src/pages/train/model/trainerDailyProgress';

const now = new Date('2026-09-17T12:00:00.000Z');

function session(
  status: string,
  completedAt: string | null,
  startedAt = '2026-09-17T08:00:00.000Z',
) {
  return { status, completedAt, startedAt };
}

describe('countTodayCompletedTrainings', () => {
  it('counts completed and failed trainings regardless of their type', () => {
    expect(countTodayCompletedTrainings([
      session('completed', '2026-09-17T08:30:00.000Z'),
      session('failed', '2026-09-17T09:30:00.000Z'),
      session('completed', '2026-09-17T10:30:00.000Z'),
    ], now)).toBe(3);
  });

  it('does not count cancelled or in-progress trainings', () => {
    expect(countTodayCompletedTrainings([
      session('cancelled', '2026-09-17T08:30:00.000Z'),
      session('in_progress', null),
    ], now)).toBe(0);
  });

  it('uses the Moscow calendar day around midnight', () => {
    expect(countTodayCompletedTrainings([
      session('completed', '2026-09-16T20:59:59.000Z'),
      session('completed', '2026-09-16T21:00:00.000Z'),
    ], new Date('2026-09-16T22:00:00.000Z'))).toBe(1);
  });
});
