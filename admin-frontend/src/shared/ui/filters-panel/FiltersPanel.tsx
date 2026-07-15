import React from 'react';

type FiltersPanelProps = {
  children: React.ReactNode;
  onReset?: () => void;
  resetLabel?: string;
  title?: string;
};

export function FiltersPanel({
  children,
  onReset,
  resetLabel = 'Сбросить фильтры',
  title = 'Фильтры',
}: FiltersPanelProps) {
  return (
    <div className="sa-filters-panel">
      <div className="sa-filters-panel__header">
        <h3 className="sa-filters-panel__title">{title}</h3>
        {onReset ? (
          <button type="button" className="sa-filter-reset" onClick={onReset}>
            {resetLabel}
          </button>
        ) : null}
      </div>
      <div className="sa-filters-panel__groups">{children}</div>
    </div>
  );
}

type FilterGroupProps = {
  label: string;
  children: React.ReactNode;
  className?: string;
  optionsClassName?: string;
};

export function FilterGroup({ label, children, className, optionsClassName }: FilterGroupProps) {
  return (
    <div className={['sa-filter-group', className].filter(Boolean).join(' ')}>
      <span className="sa-filter-label">{label}</span>
      <div className={['sa-filter-options', optionsClassName].filter(Boolean).join(' ')}>{children}</div>
    </div>
  );
}

type FiltersToggleButtonProps = {
  active: boolean;
  count?: number;
  onClick: () => void;
  className?: string;
};

function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

export function FiltersToggleButton({
  active,
  count = 0,
  onClick,
  className = 'sa-btn-field',
}: FiltersToggleButtonProps) {
  const hasCount = count > 0;
  return (
    <button
      type="button"
      className={[className, active ? 'is-active' : '', hasCount ? 'has-filter-count' : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-pressed={active}
    >
      <FilterIcon />
      Фильтры
      {hasCount ? <span className="sa-filter-count">{count}</span> : null}
    </button>
  );
}
