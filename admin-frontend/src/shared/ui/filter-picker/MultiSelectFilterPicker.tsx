import React, { useRef, useState } from 'react';
import { FilterPickerField } from './FilterPickerField';
import { FilterPickerMenu } from './FilterPickerMenu';
import type { FilterPickerOption } from './SingleSelectFilterPicker';

type Props<T extends string> = {
  options: FilterPickerOption<T>[];
  values: T[];
  placeholder: string;
  disabled?: boolean;
  zIndex?: number;
  onChange: (values: T[]) => void;
};

export function MultiSelectFilterPicker<T extends string>(props: Props<T>) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedSet = new Set(props.values);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = props.options.filter(
    (option) => !normalizedQuery || option.label.toLowerCase().includes(normalizedQuery),
  );
  const selectedCount = props.values.length;

  function openPicker() {
    if (props.disabled) return;
    setOpen(true);
  }

  function closePicker() {
    setOpen(false);
    setQuery('');
  }

  function toggleValue(value: T) {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    props.onChange([...next]);
  }

  const displayValue = open
    ? query
    : selectedCount > 0
      ? `${props.placeholder} · ${selectedCount}`
      : props.placeholder;

  return (
    <div
      ref={pickerRef}
      className={`sa-tag-filter-picker${open ? ' sa-tag-filter-picker--open' : ''}${selectedCount > 0 ? ' has-value' : ''}`}
      style={{ width: '100%', minWidth: 0 }}
    >
      <FilterPickerField open={open} onActivate={openPicker}>
        <input
          className="sa-input"
          value={displayValue}
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
          placeholder={props.placeholder}
          disabled={props.disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          readOnly={!open}
        />
      </FilterPickerField>
      <FilterPickerMenu open={open} anchorRef={pickerRef} role="listbox" zIndex={props.zIndex}>
        {filteredOptions.length ? filteredOptions.map((option) => {
          const selected = selectedSet.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              className={`sa-tag-filter-option${selected ? ' sa-tag-filter-option--selected' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                toggleValue(option.value);
              }}
            >
              <input type="checkbox" checked={selected} readOnly tabIndex={-1} aria-hidden />
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
