import React from 'react';

export type BrutalSegmentedOption<T extends string> = {
  value: T;
  label: string;
};

type Props<T extends string> = {
  value: T;
  options: BrutalSegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  compact?: boolean;
};

export function BrutalSegmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  compact = false,
}: Props<T>) {
  return (
    <div
      className={['sa-segmented', compact ? 'sa-segmented--compact' : '', className].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`sa-segmented__item${active ? ' is-active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
