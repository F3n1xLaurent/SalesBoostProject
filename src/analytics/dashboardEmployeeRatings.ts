export type DashboardEmployeeRating = {
  id: string;
  name: string;
  auditsCount: number;
  aiRating: number;
};

export const DASHBOARD_PASSING_SCORE = 50;

function compareByName(a: DashboardEmployeeRating, b: DashboardEmployeeRating): number {
  return a.name.localeCompare(b.name, 'ru');
}

/**
 * Builds mutually exclusive employee ratings. A passing employee cannot also
 * appear in the failed list, even when there are fewer rows than both limits.
 */
export function splitDashboardEmployeeRatings(
  rows: DashboardEmployeeRating[],
  limit = 10,
): { topEmployees: DashboardEmployeeRating[]; lowEmployees: DashboardEmployeeRating[] } {
  const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()]
    .filter((row) => Number.isFinite(row.aiRating));

  return {
    topEmployees: uniqueRows
      .filter((row) => row.aiRating >= DASHBOARD_PASSING_SCORE)
      .sort((a, b) => b.aiRating - a.aiRating || b.auditsCount - a.auditsCount || compareByName(a, b))
      .slice(0, limit),
    lowEmployees: uniqueRows
      .filter((row) => row.aiRating < DASHBOARD_PASSING_SCORE)
      .sort((a, b) => a.aiRating - b.aiRating || b.auditsCount - a.auditsCount || compareByName(a, b))
      .slice(0, limit),
  };
}
