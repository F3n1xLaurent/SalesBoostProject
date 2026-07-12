import React, { useEffect, useMemo, useState } from 'react';
import { fetchAnalyticsComparisonSummary, type AnalyticsAISummary } from '../../api/adminPanel';
import { AISummaryBlock } from '../ai-summary-block/AISummaryBlock';

type Props = {
  level: string;
  items: Array<Record<string, unknown>>;
};

export function ComparisonAISummary({ level, items }: Props) {
  const [summary, setSummary] = useState<AnalyticsAISummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stableItems = useMemo(() => JSON.stringify(items.slice(0, 6)), [items]);

  useEffect(() => {
    let cancelled = false;
    const parsedItems = JSON.parse(stableItems) as Array<Record<string, unknown>>;
    if (parsedItems.length < 2) return;
    setLoading(true);
    setError(null);
    fetchAnalyticsComparisonSummary({ level, items: parsedItems })
      .then((item) => {
        if (!cancelled) setSummary(item);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось сформировать AI-анализ сравнения.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [level, stableItems]);

  return (
    <AISummaryBlock
      title="AI-анализ различий"
      summary={summary ?? undefined}
      loading={loading}
      error={error}
      variant="outlined"
    />
  );
}
