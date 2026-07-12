import React from 'react';

export type CallOutcomeBreakdownData = {
  completed: number;
  no_answer: number;
  busy: number;
  failed: number;
  disconnected: number;
};

const OUTCOME_ROWS = [
  { key: 'completed' as const, label: 'Завершённые' },
  { key: 'no_answer' as const, label: 'Недозвоны' },
  { key: 'busy' as const, label: 'Занято' },
  { key: 'failed' as const, label: 'Ошибки' },
  { key: 'disconnected' as const, label: 'Сброшены' },
];

export function CallOutcomeBreakdown({ data }: { data?: CallOutcomeBreakdownData | null }) {
  const total = data ? Object.values(data).reduce((sum, value) => sum + value, 0) : 0;
  if (!data || total === 0) return <div className="sa-chart-empty">Нет звонков для разбора</div>;

  return (
    <div className="sa-hbar-list sa-hbar-list-thin sa-hbar-list-mono">
      {OUTCOME_ROWS.map((row) => {
        const count = data[row.key] ?? 0;
        const pct = Math.round((count / total) * 100);
        return (
          <div key={row.key} className="sa-hbar-row">
            <span className="sa-hbar-label">{row.label}</span>
            <div className="sa-hbar-track">
              <div className="sa-hbar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="sa-hbar-score">{count}</span>
          </div>
        );
      })}
    </div>
  );
}
