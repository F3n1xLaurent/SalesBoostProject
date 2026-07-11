import React from 'react';

type Props = {
  open: boolean;
  children: React.ReactNode;
  onActivate?: () => void;
};

export function FilterPickerField(props: Props) {
  return (
    <div
      className={`sa-tag-filter-picker-field${props.open ? ' sa-tag-filter-picker-field--open' : ''}`}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest('.sa-tag-filter-picker-chevron')) {
          event.preventDefault();
          props.onActivate?.();
        }
      }}
    >
      {props.children}
      <span className="sa-tag-filter-picker-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </div>
  );
}
