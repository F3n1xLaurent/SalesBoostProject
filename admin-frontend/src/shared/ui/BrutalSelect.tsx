import React, { useEffect, useRef, useState } from 'react';
import { FilterPickerMenu } from './filter-picker/FilterPickerMenu';

export type BrutalSelectOption = {
  value: string;
  label: string;
};

type Props = {
  value: string;
  options: BrutalSelectOption[];
  disabled?: boolean;
  placeholder?: string;
  invalid?: boolean;
  'aria-label'?: string;
  onChange: (value: string) => void;
};

export function BrutalSelect(props: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = props.options.find((option) => option.value === props.value) ?? null;

  useEffect(() => {
    if (!open) return undefined;

    function handleDocumentMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      const menu = rootRef.current?.querySelector('.train-brutal-select-menu');
      if (menu?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [open]);

  function selectValue(value: string) {
    props.onChange(value);
    setOpen(false);
  }

  return (
    <div
      ref={rootRef}
      className={[
        'train-brutal-select',
        open ? 'train-brutal-select--open' : '',
        props.invalid ? 'sa-field-invalid' : '',
      ].filter(Boolean).join(' ')}
    >
      <button
        type="button"
        className="train-brutal-select-trigger"
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={props.invalid || undefined}
        aria-label={props['aria-label']}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="train-brutal-select-value">{selected?.label ?? props.placeholder ?? 'Выберите'}</span>
        <span className="train-brutal-select-chevron" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      <FilterPickerMenu open={open} role="listbox" menuClassName="train-brutal-select-menu" zIndex={1500}>
        {props.options.map((option) => {
          const isSelected = option.value === props.value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={`sa-tag-filter-option${isSelected ? ' sa-tag-filter-option--selected' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                selectValue(option.value);
              }}
            >
              <span className="sa-tag-filter-option__label">{option.label}</span>
            </button>
          );
        })}
      </FilterPickerMenu>
    </div>
  );
}
