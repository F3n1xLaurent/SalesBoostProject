import React, { useEffect, useMemo, useRef, useState } from 'react';
import { clamp, scoreToColor } from '../../lib/demo-report/utils';

export function ScoreRing(props: { value: number | null }) {
  const target = useMemo(() => {
    if (props.value == null || !Number.isFinite(props.value)) return null;
    return clamp(props.value, 0, 100);
  }, [props.value]);

  const [animated, setAnimated] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target == null) return;
    const from = animated;
    const to = target;
    const start = performance.now();
    const durationMs = 1600;

    const tick = (t: number) => {
      const p = clamp((t - start) / durationMs, 0, 1);
      const e = 1 - Math.pow(1 - p, 5);
      setAnimated(from + (to - from) * e);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const pct = target == null ? 0 : clamp(animated / 100, 0, 1);
  const color = scoreToColor(target);
  const size = 96;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const c = 2 * Math.PI * r;

  return (
    <div className="demo-ring" aria-label="AI рейтинг">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(0,0,0,0.10)" strokeWidth={stroke} />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <text
          x={cx}
          y={cy + 10}
          textAnchor="middle"
          fontSize="28"
          fontWeight="900"
          fill="rgba(0,0,0,0.92)"
          style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
        >
          {target == null ? '—' : Math.round(animated)}
        </text>
      </svg>
    </div>
  );
}
