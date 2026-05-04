import React, { useEffect, useMemo, useState } from 'react';
import type { CallInsightDetail } from './types';
import { buildIndicators, clamp, formatDurationSec, getCallQualityTag, scoreToColor, type UiIndicator } from './utils';
import { ScoreRing } from './ScoreRing';

const BAR_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const BAR_DURATION_MS = 1200;

function AnimatedMetricBar(props: {
  item: UiIndicator;
  index: number;
  resetKey: number;
}) {
  const { item, index, resetKey } = props;
  const target = item.value;
  const fullPct = target == null ? 0 : (clamp(target, 0, 10) / 10) * 100;
  const color = (target ?? 0) >= 8 ? '#22c55e' : (target ?? 0) >= 5 ? '#f59e0b' : '#ef4444';
  const [widthPct, setWidthPct] = useState(0);

  useEffect(() => {
    setWidthPct(0);
    if (target == null) return undefined;
    const delay = 90 + index * 130;
    const t = window.setTimeout(() => setWidthPct(fullPct), delay);
    return () => window.clearTimeout(t);
  }, [resetKey, target, fullPct, index]);

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] text-default-600 gap-3">
        <span className="font-semibold text-default-700">{item.label}</span>
        <span>{target == null ? '—' : `${target.toFixed(1)}/10`}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden demo-metric-bar__track" style={{ background: 'rgba(0,0,0,0.10)' }}>
        <div
          className="h-full rounded-full demo-metric-bar__fill"
          style={{
            width: `${widthPct}%`,
            background: color,
            transition: `width ${BAR_DURATION_MS}ms ${BAR_EASE}`,
          }}
        />
      </div>
    </div>
  );
}

export function ReportHeader(props: {
  detail: CallInsightDetail;
  onExportPdf(): void;
}) {
  const { detail } = props;
  const qualityTag = useMemo(() => getCallQualityTag(detail), [detail]);
  const indicators = useMemo(() => buildIndicators(detail), [detail]);

  return (
    <div className="rounded-2xl admin-card-inner px-4 py-4 demo-first-block">
      <div className="demo-first-block__head">
        <div className="demo-first-block__left">
          <div className="demo-first-block__toprow">
            <div className="demo-first-block__ring-row">
              <ScoreRing value={detail.totalScore} />
              <div className="demo-first-block__ring-meta">
                <div className="demo-first-block__title">AI рейтинг</div>
                <div className="demo-first-block__subtitle" style={{ color: scoreToColor(detail.totalScore) }}>
                  {qualityTag.text}
                </div>
              </div>
            </div>

            <button
              type="button"
              className="demo-share-icon"
              onClick={props.onExportPdf}
              aria-label="Скачать отчёт PDF"
              title="Скачать полный отчёт в PDF (все блоки раскрыты)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                <path
                  d="M12 3a1 1 0 0 1 1 1v8.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1Z"
                  fill="currentColor"
                />
                <path
                  d="M5 20a2 2 0 0 1-2-2v-3a1 1 0 1 1 2 0v3h14v-3a1 1 0 1 1 2 0v3a2 2 0 0 1-2 2H5Z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 min-w-0 space-y-4">
        <div className="demo-first-block__tech">
          <div className="demo-first-block__tech-row">
            <div className="demo-first-block__tech-k">Номер клиента</div>
            <div className="demo-first-block__tech-v">{detail.to || '—'}</div>
          </div>
          <div className="demo-first-block__tech-row">
            <div className="demo-first-block__tech-k">Статус звонка</div>
            <div className="demo-first-block__tech-v">
              {detail.outcome === 'completed' | detail.outcome === 'disconnected' ? 'Завершён' : detail.outcome === 'failed' ? 'Неуспешно' : detail.outcome ?? '—'}
            </div>
          </div>
          <div className="demo-first-block__tech-row">
            <div className="demo-first-block__tech-k">Длительность</div>
            <div className="demo-first-block__tech-v">{formatDurationSec(detail)}</div>
          </div>
        </div>

        <div className="space-y-2">
          {indicators.map((it, idx) => (
            <AnimatedMetricBar key={it.key} item={it} index={idx} resetKey={detail.id} />
          ))}
        </div>
      </div>
    </div>
  );
}

