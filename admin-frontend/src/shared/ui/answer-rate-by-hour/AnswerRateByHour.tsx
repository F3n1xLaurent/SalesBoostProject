import React, { useState } from 'react';

/** Matches --tb-status-green (#2D9B5E) */
const TB_STATUS_GREEN_RGB = '45, 155, 94';

type Props = {
  hourly: number[];
  embedded?: boolean;
};

export function AnswerRateByHour({ hourly, embedded = false }: Props) {
  const [hoverHour, setHoverHour] = useState<number | null>(null);

  if (!hourly || hourly.length === 0) {
    return (
      <div className="sa-chart-wrap">
        {!embedded && <h3 className="sa-chart-title">Дозвон по часам</h3>}
        <div className="sa-heatmap-empty">Нет данных за выбранный период</div>
      </div>
    );
  }

  const maxVal = Math.max(...hourly, 1);

  return (
    <div className="sa-chart-wrap sa-heatmap-fill">
      {!embedded && <h3 className="sa-chart-title">Дозвон по часам</h3>}
      <div className="sa-heatmap-grid-12" onMouseLeave={() => setHoverHour(null)}>
        {hourly.slice(0, 24).map((pct, hour) => {
          const hasData = pct > 0;
          const opacity = hasData ? 0.15 + (pct / maxVal) * 0.85 : 0;
          const bg = hasData ? `rgba(${TB_STATUS_GREEN_RGB}, ${opacity})` : 'rgba(22, 22, 19, 0.05)';
          const fillStrength = !hasData ? 'none' : opacity >= 0.42 ? 'strong' : 'light';
          return (
            <div
              key={hour}
              className={`sa-heatmap-cell sa-heatmap-cell-${fillStrength} ${hoverHour === hour ? 'sa-heatmap-cell-hover' : ''} ${!hasData ? 'sa-heatmap-closed' : ''}`}
              style={{ backgroundColor: bg }}
              onMouseEnter={() => setHoverHour(hour)}
            >
              <span className="sa-heatmap-label">{hour}</span>
              {hoverHour === hour && (
                <div className="sa-heatmap-tooltip">
                  <div>Час: {hour}:00</div>
                  <div>{hasData ? `Дозвон: ${pct.toFixed(0)}%` : 'Нет звонков'}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
