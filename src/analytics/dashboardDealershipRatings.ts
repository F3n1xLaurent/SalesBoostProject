import { DASHBOARD_PASSING_SCORE } from './dashboardEmployeeRatings';

export type DashboardDealershipRating = {
  id: string;
  name: string;
  totalAudits: number;
  avgAiScore: number;
};

function compareByName(a: DashboardDealershipRating, b: DashboardDealershipRating): number {
  return a.name.localeCompare(b.name, 'ru');
}

/** Builds mutually exclusive dealership ratings using the dashboard pass score. */
export function splitDashboardDealershipRatings<T extends DashboardDealershipRating>(
  rows: T[],
  limit = 5,
): { topDealerships: T[]; lowDealerships: T[] } {
  const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()]
    .filter((row) => row.totalAudits > 0 && Number.isFinite(row.avgAiScore));

  return {
    topDealerships: uniqueRows
      .filter((row) => row.avgAiScore >= DASHBOARD_PASSING_SCORE)
      .sort((a, b) => b.avgAiScore - a.avgAiScore || b.totalAudits - a.totalAudits || compareByName(a, b))
      .slice(0, limit),
    lowDealerships: uniqueRows
      .filter((row) => row.avgAiScore < DASHBOARD_PASSING_SCORE)
      .sort((a, b) => a.avgAiScore - b.avgAiScore || b.totalAudits - a.totalAudits || compareByName(a, b))
      .slice(0, limit),
  };
}
