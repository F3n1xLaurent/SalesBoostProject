import { describe, expect, it } from 'vitest';
import { splitDashboardEmployeeRatings } from '../analytics/dashboardEmployeeRatings';

describe('dashboard employee ratings', () => {
  it('keeps effective and failed employees mutually exclusive', () => {
    const result = splitDashboardEmployeeRatings([
      { id: 'strong', name: 'Анна', auditsCount: 4, aiRating: 86 },
      { id: 'passing', name: 'Борис', auditsCount: 3, aiRating: 50 },
      { id: 'failed', name: 'Виктор', auditsCount: 2, aiRating: 49.9 },
      { id: 'zero', name: 'Галина', auditsCount: 1, aiRating: 0 },
    ]);

    expect(result.topEmployees.map((row) => row.id)).toEqual(['strong', 'passing']);
    expect(result.lowEmployees.map((row) => row.id)).toEqual(['zero', 'failed']);
    expect(result.topEmployees.some((top) => result.lowEmployees.some((low) => low.id === top.id))).toBe(false);
  });

  it('does not duplicate employees when both lists have capacity', () => {
    const result = splitDashboardEmployeeRatings([
      { id: 'one', name: 'Один', auditsCount: 2, aiRating: 72 },
      { id: 'two', name: 'Два', auditsCount: 2, aiRating: 30 },
    ], 10);

    expect(result.topEmployees.map((row) => row.id)).toEqual(['one']);
    expect(result.lowEmployees.map((row) => row.id)).toEqual(['two']);
  });

  it('respects the limit independently for both groups', () => {
    const result = splitDashboardEmployeeRatings([
      { id: 'top-1', name: 'Топ 1', auditsCount: 1, aiRating: 90 },
      { id: 'top-2', name: 'Топ 2', auditsCount: 1, aiRating: 80 },
      { id: 'low-1', name: 'Низ 1', auditsCount: 1, aiRating: 10 },
      { id: 'low-2', name: 'Низ 2', auditsCount: 1, aiRating: 20 },
    ], 1);

    expect(result.topEmployees.map((row) => row.id)).toEqual(['top-1']);
    expect(result.lowEmployees.map((row) => row.id)).toEqual(['low-1']);
  });
});
