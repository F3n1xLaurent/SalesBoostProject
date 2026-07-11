import React, { useMemo, useRef, useState } from 'react';
import { FilterPickerField } from './FilterPickerField';
import { FilterPickerMenu } from './FilterPickerMenu';

export type FilterPickerOption<T extends string = string> = {
  value: T;
  label: string;
};

function filterPickerWidth(labels: string[], min = 120, max = 480): number {
  const longest = labels.reduce((maxLabel, label) => (label.length > maxLabel.length ? label : maxLabel), '');
  const width = Math.ceil(longest.length * 8 + 56);
  return Math.min(Math.max(width, min), max);
}

type Props<T extends string> = {
  options: FilterPickerOption<T>[];
  value: T;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: T) => void;
};

export function SingleSelectFilterPicker<T extends string>(props: Props<T>) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedOption = props.options.find((option) => option.value === props.value) ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = props.options.filter(
    (option) => !normalizedQuery || option.label.toLowerCase().includes(normalizedQuery),
  );

  const pickerWidth = useMemo(
    () => filterPickerWidth(props.options.map((option) => option.label)),
    [props.options],
  );

  function openPicker() {
    if (props.disabled) return;
    setOpen(true);
  }

  function closePicker() {
    setOpen(false);
    setQuery('');
  }

  function selectValue(value: T) {
    props.onChange(value);
    closePicker();
  }

  const inputValue = open ? (query || selectedOption?.label || '') : (selectedOption?.label ?? '');

  return (
    <div
      ref={pickerRef}
      className={`sa-tag-filter-picker${open ? ' sa-tag-filter-picker--open' : ''}`}
      style={{ width: pickerWidth }}
    >
      <FilterPickerField open={open} onActivate={openPicker}>
        <input
          className="sa-input"
          value={inputValue}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={openPicker}
          onClick={openPicker}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            const menu = document.querySelector('.sa-tag-filter-menu--portal');
            if (menu?.contains(next)) return;
            window.setTimeout(closePicker, 160);
          }}
          placeholder={props.placeholder ?? selectedOption?.label ?? 'Выберите значение'}
          disabled={props.disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
        />
      </FilterPickerField>
      <FilterPickerMenu open={open} anchorRef={pickerRef} role="listbox">
        {filteredOptions.length ? filteredOptions.map((option) => {
          const selected = props.value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              className={`sa-tag-filter-option${selected ? ' sa-tag-filter-option--selected' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                selectValue(option.value);
              }}
            >
              <span className="sa-tag-filter-option__label" title={option.label}>{option.label}</span>
            </button>
          );
        }) : (
          <div className="sa-meta" style={{ padding: 10 }}>Ничего не найдено</div>
        )}
      </FilterPickerMenu>
    </div>
  );
}
