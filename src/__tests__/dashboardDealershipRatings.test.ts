import { describe, expect, it } from 'vitest';
import { splitDashboardDealershipRatings } from '../analytics/dashboardDealershipRatings';

describe('dashboard dealership ratings', () => {
  it('does not show the only low-scoring dealership among the best', () => {
    const result = splitDashboardDealershipRatings([
      { id: 'gulliver', name: 'Гулливер', totalAudits: 6, avgAiScore: 1.5 },
    ]);

    expect(result.topDealerships).toEqual([]);
    expect(result.lowDealerships.map((row) => row.id)).toEqual(['gulliver']);
  });

  it('keeps passing and low-scoring dealerships mutually exclusive', () => {
    const result = splitDashboardDealershipRatings([
      { id: 'strong', name: 'Сильная', totalAudits: 4, avgAiScore: 85 },
      { id: 'passing', name: 'Норма', totalAudits: 3, avgAiScore: 50 },
      { id: 'low', name: 'Слабая', totalAudits: 5, avgAiScore: 49.9 },
    ]);

    expect(result.topDealerships.map((row) => row.id)).toEqual(['strong', 'passing']);
    expect(result.lowDealerships.map((row) => row.id)).toEqual(['low']);
  });
});
