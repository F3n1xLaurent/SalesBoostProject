import React from 'react';
import { BrutalModal } from '../brutal-modal';
import { ComparisonAISummary } from '../comparison-ai-summary/ComparisonAISummary';

export type MetricComparisonColumn = {
  id: string;
  label: string;
  onOpen?: () => void;
};

export type MetricComparisonMetric = {
  key: string;
  label: string;
  /** Default true */
  higherBetter?: boolean;
  values: Array<number | null>;
  format?: (value: number | null) => React.ReactNode;
};

export type MetricComparisonExtraRow = {
  key: string;
  label: string;
  cells: React.ReactNode[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  columns: MetricComparisonColumn[];
  metrics: MetricComparisonMetric[];
  extraRows?: MetricComparisonExtraRow[];
  aiLevel: string;
  aiItems: Array<Record<string, unknown>>;
};

function defaultFormat(value: number | null): React.ReactNode {
  return value === null ? '—' : value;
}

export function MetricComparisonModal({
  open,
  onClose,
  title,
  columns,
  metrics,
  extraRows = [],
  aiLevel,
  aiItems,
}: Props) {
  if (!open || columns.length < 2) return null;

  return (
    <BrutalModal
      open={open}
      onClose={onClose}
      title={title}
      width="wide"
    >
      <div className="sa-comparison-modal">
        <div className="sa-comparison-table-panel">
          <div className="sa-comparison-table-scroll">
            <table
              className="sa-table sa-comparison-table"
              style={{ ['--sa-comparison-cols' as string]: String(columns.length) }}
            >
              <thead>
                <tr>
                  <th>Метрика</th>
                  {columns.map((column) => (
                    <th key={column.id} className="sa-text-right">
                      {column.onOpen ? (
                        <button type="button" className="sa-btn-text sa-btn-sm" onClick={column.onOpen}>
                          {column.label}
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((metric) => {
                  const higherBetter = metric.higherBetter !== false;
                  const numeric = metric.values.map((value) => (value === null || Number.isNaN(value) ? null : value));
                  const present = numeric.filter((value): value is number => value !== null);
                  const best = present.length === 0
                    ? null
                    : higherBetter
                      ? Math.max(...present)
                      : Math.min(...present);
                  const worst = present.length === 0
                    ? null
                    : higherBetter
                      ? Math.min(...present)
                      : Math.max(...present);
                  const format = metric.format ?? defaultFormat;

                  return (
                    <tr key={metric.key}>
                      <td>{metric.label}</td>
                      {columns.map((column, index) => {
                        const value = numeric[index] ?? null;
                        const isBest = value !== null && best !== null && value === best;
                        const isWorst = value !== null && worst !== null && value === worst && best !== worst;
                        return (
                          <td key={column.id} className="sa-text-right">
                            <span className={isBest ? 'sa-score-green' : isWorst ? 'sa-score-red' : ''}>
                              {format(value)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {extraRows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    {row.cells.map((cell, index) => (
                      <td key={`${row.key}-${columns[index]?.id ?? index}`} className="sa-text-right">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="sa-comparison-ai-wrap">
          <ComparisonAISummary level={aiLevel} items={aiItems} />
        </div>
      </div>
    </BrutalModal>
  );
}
