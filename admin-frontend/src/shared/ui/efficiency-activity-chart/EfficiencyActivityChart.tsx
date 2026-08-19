import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HoldingActivityPoint } from '../../api/adminPanel';
import { BrutalSegmented } from '../brutal-segmented';
import { SingleSelectFilterPicker } from '../filter-picker/SingleSelectFilterPicker';
import { CalendarIcon } from '../icons/ActionIcons';

export type EfficiencyActivitySeries = {
  month: HoldingActivityPoint[];
  all: HoldingActivityPoint[];
};

type EfficiencyActivityPeriod = 'month' | 'all';
type EfficiencyActivityMetric = 'calls' | 'rating';

const PERIOD_OPTIONS = [
  { value: 'month' as const, label: '30 дней' },
  { value: 'all' as const, label: 'Всё время' },
];

const METRIC_OPTIONS = [
  { value: 'calls' as const, label: 'Звонки' },
  { value: 'rating' as const, label: 'Рейтинг' },
];

function PeriodPicker({
  value,
  onChange,
}: {
  value: EfficiencyActivityPeriod;
  onChange: (value: EfficiencyActivityPeriod) => void;
}) {
  return (
    <div className="sa-holding-activity-period-picker">
      <span className="sa-holding-activity-period-picker__icon" aria-hidden="true">
        <CalendarIcon />
      </span>
      <SingleSelectFilterPicker
        options={PERIOD_OPTIONS}
        value={value}
        onChange={onChange}
        fitSelected
        leadingPad={26}
      />
    </div>
  );
}

function ChartLegend({ metric }: { metric: EfficiencyActivityMetric }) {
  const totalColor = '#161613';
  const missedColor = '#E05252';
  const scoreColor = '#2D9B5E';

  if (metric === 'calls') {
    return (
      <div className="sa-chart-legend sa-holding-activity-legend">
        <span><i style={{ background: totalColor }} /> Звонки всего</span>
        <span><i style={{ background: missedColor }} /> Пропущены</span>
      </div>
    );
  }

  return (
    <div className="sa-chart-legend sa-holding-activity-legend">
      <span><i className="is-line" style={{ color: scoreColor }} /> Рейтинг качества</span>
      <span className="sa-holding-activity-legend-meta">AI-рейтинг, 0–100</span>
    </div>
  );
}

function niceAxisMax(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

type DealershipSeriesItem = {
  id: string;
  name: string;
  series: EfficiencyActivitySeries;
};

type Props = {
  series: EfficiencyActivitySeries;
  dealershipSeries?: DealershipSeriesItem[];
  dealershipRows?: Array<{ id: string; name: string }>;
  showDealershipFilter?: boolean;
};

export function EfficiencyActivityChart({
  series,
  dealershipSeries = [],
  dealershipRows = [],
  showDealershipFilter = true,
}: Props) {
  const [metric, setMetric] = useState<EfficiencyActivityMetric>('calls');
  const [period, setPeriod] = useState<EfficiencyActivityPeriod>('month');
  const [dealershipId, setDealershipId] = useState('all');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  const plotRef = useRef<HTMLDivElement>(null);
  const plotWidthRef = useRef(0);
  const scrollableRef = useRef(false);

  const resolvedDealershipSeries = useMemo(() => {
    if (dealershipSeries.length) return dealershipSeries;
    return dealershipRows.map((row) => ({
      id: row.id,
      name: row.name,
      series,
    }));
  }, [dealershipRows, dealershipSeries, series]);

  const dealershipOptions = useMemo(
    () => [
      { value: 'all', label: 'По компании' },
      ...resolvedDealershipSeries.map((dealership) => ({ value: dealership.id, label: dealership.name })),
    ],
    [resolvedDealershipSeries],
  );

  const activeSeries = useMemo(() => {
    if (!showDealershipFilter || dealershipId === 'all') return series;
    return resolvedDealershipSeries.find((dealership) => dealership.id === dealershipId)?.series ?? series;
  }, [dealershipId, resolvedDealershipSeries, series, showDealershipFilter]);

  const points = period === 'month' ? activeSeries.month ?? [] : activeSeries.all ?? [];

  useLayoutEffect(() => {
    const node = plotRef.current;
    if (!node) return;

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextWidth = node.clientWidth;
        if (Math.abs(nextWidth - plotWidthRef.current) < 2) return;
        plotWidthRef.current = nextWidth;
        setPlotWidth(nextWidth);
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    setHoverIdx(null);
    scrollableRef.current = false;
  }, [period, dealershipId, metric]);

  const hasCallsInPeriod = points.some((point) => point.totalCalls > 0 || point.missedCalls > 0);
  const hasScoresInPeriod = points.some((point) => typeof point.avgScore === 'number' && Number.isFinite(point.avgScore));
  const hasMetricData = metric === 'calls' ? hasCallsInPeriod : hasScoresInPeriod;

  const H = 320;
  const pad = { top: 24, right: 20, bottom: 42, left: 48 };
  const groupCount = Math.max(points.length, 1);
  const minGroupStep = period === 'month'
    ? 34
    : groupCount > 24
      ? 40
      : groupCount > 12
        ? 48
        : 56;
  const minChartWidth = groupCount * minGroupStep;
  const fillChartWidth = plotWidth > 0 ? Math.max(plotWidth - pad.left - pad.right, 0) : minChartWidth;
  const cw = Math.max(fillChartWidth, minChartWidth);
  const W = pad.left + cw + pad.right;

  if (plotWidth > 0) {
    if (minChartWidth > fillChartWidth + 2) {
      scrollableRef.current = true;
    } else if (minChartWidth <= fillChartWidth - 18) {
      scrollableRef.current = false;
    }
  }

  const scrollable = scrollableRef.current && plotWidth > 0;
  const ch = H - pad.top - pad.bottom;
  const groupStep = cw / groupCount;
  const barWidth = Math.min(18, Math.max(8, groupStep * 0.28));
  const barGap = 4;

  const totalColor = '#161613';
  const missedColor = '#E05252';
  const scoreColor = '#2D9B5E';

  const maxCount = Math.max(...points.map((point) => point.totalCalls), 1);
  const niceMaxCount = niceAxisMax(maxCount);
  const yCount = (value: number) => pad.top + ch - (value / niceMaxCount) * ch;
  const yScore = (value: number) => pad.top + ch - (Math.max(0, Math.min(100, value)) / 100) * ch;
  const countTicks = [0, Math.round(niceMaxCount / 2), niceMaxCount];
  const scoreTicks = [0, 25, 50, 75, 100];

  const linePoints = points
    .map((point, index) => ({ index, score: point.avgScore }))
    .filter((point): point is { index: number; score: number } => typeof point.score === 'number' && Number.isFinite(point.score));
  const scoreXs = linePoints.map((point) => pad.left + point.index * groupStep + groupStep / 2);
  const scorePathD = linePoints
    .map((point, idx) => {
      const x = scoreXs[idx];
      const y = yScore(point.score);
      return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  const showDealershipPicker = showDealershipFilter && dealershipOptions.length > 1;

  const toolbar = (
    <div className="sa-holding-activity-chart-head">
      <div className="sa-holding-activity-toolbar">
        <BrutalSegmented
          ariaLabel="Показатель динамики"
          className="sa-holding-activity-metric"
          value={metric}
          options={METRIC_OPTIONS}
          onChange={setMetric}
        />
        <ChartLegend metric={metric} />
      </div>
      <div className="sa-holding-activity-controls">
        {showDealershipPicker && (
          <div className="sa-tag-filter-picker-wrap sa-holding-activity-dealership">
            <SingleSelectFilterPicker
              options={dealershipOptions}
              value={dealershipId}
              onChange={setDealershipId}
            />
          </div>
        )}
        <div className="sa-tag-filter-picker-wrap sa-holding-activity-period-picker-wrap">
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      </div>
    </div>
  );

  const plot = !hasMetricData ? (
    <div className="sa-chart-empty sa-holding-activity-empty">
      {metric === 'calls' ? 'Нет звонков за выбранный период' : 'Нет оценённых звонков за выбранный период'}
    </div>
  ) : (
    <>
      <div className="sa-holding-activity-scroll">
        <svg
          width={scrollable ? W : '100%'}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMinYMid meet"
          className="sa-holding-activity-svg"
          style={{ display: 'block', minWidth: scrollable ? W : undefined, height: H }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {metric === 'calls' ? (
            <>
              {countTicks.map((tick) => {
                const y = yCount(tick);
                return (
                  <g key={`count-${tick}`}>
                    <line x1={pad.left} y1={y} x2={pad.left + cw} y2={y} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
                    <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">
                      {tick}{tick === niceMaxCount ? ' шт' : ''}
                    </text>
                  </g>
                );
              })}
              <line x1={pad.left} y1={pad.top + ch} x2={pad.left + cw} y2={pad.top + ch} stroke="var(--sa-divider)" strokeWidth="1" />
              {points.map((point, index) => {
                const groupX = pad.left + index * groupStep;
                const centerX = groupX + groupStep / 2;
                const totalHeight = (point.totalCalls / niceMaxCount) * ch;
                const missedHeight = (point.missedCalls / niceMaxCount) * ch;
                const totalX = centerX - barGap / 2 - barWidth;
                const missedX = centerX + barGap / 2;
                const baseY = pad.top + ch;
                return (
                  <g key={point.key}>
                    <rect
                      x={groupX}
                      y={pad.top}
                      width={groupStep}
                      height={ch}
                      fill="transparent"
                      onMouseEnter={() => setHoverIdx(index)}
                    />
                    <rect
                      x={totalX}
                      y={baseY - totalHeight}
                      width={barWidth}
                      height={totalHeight}
                      rx={3}
                      fill={totalColor}
                      opacity={hoverIdx === index ? 1 : 0.88}
                    />
                    <rect
                      x={missedX}
                      y={baseY - missedHeight}
                      width={barWidth}
                      height={missedHeight}
                      rx={3}
                      fill={missedColor}
                      opacity={hoverIdx === index ? 1 : 0.88}
                    />
                    <text
                      x={centerX}
                      y={H - 12}
                      textAnchor="middle"
                      fontSize={period === 'month' ? 9 : groupCount > 18 ? 8 : 10}
                      fill="var(--sa-text-secondary)"
                    >
                      {point.label}
                    </text>
                  </g>
                );
              })}
            </>
          ) : (
            <>
              {scoreTicks.map((tick) => {
                const y = yScore(tick);
                return (
                  <g key={`score-${tick}`}>
                    <line x1={pad.left} y1={y} x2={pad.left + cw} y2={y} stroke="rgba(45, 155, 94, 0.14)" strokeWidth="1" strokeDasharray="4" />
                    <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill={scoreColor}>
                      {tick}
                    </text>
                  </g>
                );
              })}
              <line x1={pad.left} y1={pad.top + ch} x2={pad.left + cw} y2={pad.top + ch} stroke="var(--sa-divider)" strokeWidth="1" />
              {points.map((point, index) => {
                const groupX = pad.left + index * groupStep;
                const centerX = groupX + groupStep / 2;
                return (
                  <g key={point.key}>
                    <rect
                      x={groupX}
                      y={pad.top}
                      width={groupStep}
                      height={ch}
                      fill="transparent"
                      onMouseEnter={() => setHoverIdx(index)}
                    />
                    <text
                      x={centerX}
                      y={H - 12}
                      textAnchor="middle"
                      fontSize={period === 'month' ? 9 : groupCount > 18 ? 8 : 10}
                      fill="var(--sa-text-secondary)"
                    >
                      {point.label}
                    </text>
                  </g>
                );
              })}
              {linePoints.length === 1 && (() => {
                const point = linePoints[0];
                const groupX = pad.left + point.index * groupStep;
                const y = yScore(point.score);
                const inset = Math.min(8, groupStep * 0.18);
                return (
                  <line
                    x1={groupX + inset}
                    y1={y}
                    x2={groupX + groupStep - inset}
                    y2={y}
                    stroke={scoreColor}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                );
              })()}
              {linePoints.length >= 2 && scorePathD && scoreXs.length >= 2 && (
                <>
                  <path
                    d={`${scorePathD} L ${scoreXs[scoreXs.length - 1]} ${pad.top + ch} L ${scoreXs[0]} ${pad.top + ch} Z`}
                    fill="rgba(45, 155, 94, 0.1)"
                  />
                  <path
                    d={scorePathD}
                    fill="none"
                    stroke={scoreColor}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </>
              )}
              {linePoints.map((point, idx) => {
                const x = scoreXs[idx];
                const y = yScore(point.score);
                return (
                  <circle
                    key={`score-${point.index}`}
                    cx={x}
                    cy={y}
                    r={hoverIdx === point.index ? 5.5 : 4}
                    fill={hoverIdx === point.index ? '#fff' : scoreColor}
                    stroke={scoreColor}
                    strokeWidth={hoverIdx === point.index ? 2.5 : 0}
                  />
                );
              })}
            </>
          )}

          {hoverIdx !== null && (
            <line
              x1={pad.left + hoverIdx * groupStep + groupStep / 2}
              y1={pad.top}
              x2={pad.left + hoverIdx * groupStep + groupStep / 2}
              y2={pad.top + ch}
              stroke="var(--sa-text-secondary)"
              strokeWidth="1"
              strokeDasharray="3"
              opacity="0.35"
            />
          )}
        </svg>
      </div>
      {hoverIdx !== null && hoverIdx < points.length && (() => {
        const point = points[hoverIdx];
        const centerX = pad.left + hoverIdx * groupStep + groupStep / 2;
        const leftPct = (centerX / W) * 100;
        return (
          <div
            className="sa-chart-hover-tooltip sa-chart-hover-tooltip-below"
            style={{ left: `${leftPct}%`, top: '18%' }}
          >
            <div className="sa-chart-hover-tooltip-row is-strong">{point.label}</div>
            {metric === 'calls' ? (
              <>
                <div className="sa-chart-hover-tooltip-row">Звонки всего: {point.totalCalls} шт</div>
                <div className="sa-chart-hover-tooltip-row">Пропущены: {point.missedCalls} шт</div>
              </>
            ) : (
              <div className="sa-chart-hover-tooltip-row is-score">
                Рейтинг качества: {point.avgScore !== null ? `${point.avgScore.toFixed(1)} баллов` : 'нет оценок'}
              </div>
            )}
          </div>
        );
      })()}
    </>
  );

  return (
    <div className="sa-holding-activity-chart">
      {toolbar}
      <div className="sa-holding-activity-plot" ref={plotRef}>
        {plot}
      </div>
    </div>
  );
}
