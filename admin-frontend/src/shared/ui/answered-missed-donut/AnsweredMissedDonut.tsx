import React, { useState } from 'react';

type Props = {
  rate: number;
  totalCalls: number;
  embedded?: boolean;
};

export function AnsweredMissedDonut({ rate, totalCalls, embedded = false }: Props) {
  const [hover, setHover] = useState<'answered' | 'missed' | null>(null);
  const answered = Math.round((rate / 100) * totalCalls);
  const missed = totalCalls - answered;

  return (
    <div className="sa-donut-section">
      {!embedded && <h3 className="sa-chart-title">Принятые и пропущенные</h3>}
      <div className="sa-donut-wrap-v2">
        <div
          className="sa-donut-v2"
          onMouseEnter={() => setHover('answered')}
          onMouseLeave={() => setHover(null)}
        >
          <svg viewBox="0 0 120 120" className="sa-donut-svg">
            <circle cx="60" cy="60" r="52" fill="none" stroke="var(--tb-status-red-bg)" strokeWidth="14" />
            <circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke={hover === 'missed' ? 'var(--tb-status-red)' : 'var(--tb-status-green)'}
              strokeWidth="14"
              strokeDasharray={`${(rate / 100) * 326.73} 326.73`}
              strokeLinecap="round"
              transform="rotate(-90 60 60)"
              style={{ transition: 'stroke 0.2s ease' }}
            />
          </svg>
          <div className="sa-donut-center">
            <span className="sa-donut-center-num">{rate.toFixed(0)}%</span>
            <span className="sa-donut-center-label">Дозвон</span>
          </div>
          {hover && (
            <div className="sa-donut-tooltip">
              <div>Принятые: {answered}</div>
              <div>Пропущенные: {missed}</div>
              <div>Всего: {totalCalls}</div>
            </div>
          )}
        </div>
        <div className="sa-donut-legend-v2">
          <div className="sa-donut-legend-item">
            <span className="sa-dot sa-dot-answered" />
            Принятые {rate.toFixed(0)}%
          </div>
          <div className="sa-donut-legend-item">
            <span className="sa-dot sa-dot-missed-v2" />
            Пропущенные {(100 - rate).toFixed(0)}%
          </div>
        </div>
      </div>
    </div>
  );
}
