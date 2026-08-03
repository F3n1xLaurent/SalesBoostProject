import React, { useMemo, useRef, useState } from 'react';
import { FilterPickerField } from './FilterPickerField';
import { FilterPickerMenu } from './FilterPickerMenu';

export type FilterPickerOption<T extends string = string> = {
  value: T;
  label: string;
};

const FILTER_PICKER_FONT = '13px Inter, system-ui, sans-serif';
const FILTER_PICKER_PAD_RIGHT = 34;
const FILTER_PICKER_PAD_LEFT = 12;
const FILTER_PICKER_COMPACT_PAD_X = FILTER_PICKER_PAD_LEFT + FILTER_PICKER_PAD_RIGHT;

let measureContext: CanvasRenderingContext2D | null = null;

function measurePickerLabelWidth(label: string): number {
  if (!label) return 0;
  if (typeof document === 'undefined') return label.length * 7.5;
  if (!measureContext) {
    const canvas = document.createElement('canvas');
    measureContext = canvas.getContext('2d');
  }
  if (!measureContext) return label.length * 7.5;
  measureContext.font = FILTER_PICKER_FONT;
  return measureContext.measureText(label).width;
}

function filterPickerWidth(
  labels: string[],
  {
    min = 120,
    max = 480,
    padLeft = FILTER_PICKER_PAD_LEFT,
    padRight = FILTER_PICKER_PAD_RIGHT,
  }: {
    min?: number;
    max?: number;
    padLeft?: number;
    padRight?: number;
  } = {},
): number {
  if (!labels.length) return min;
  const textWidth = Math.max(...labels.map(measurePickerLabelWidth));
  const width = Math.ceil(textWidth + padLeft + padRight + 2);
  return Math.min(Math.max(width, min), max);
}

type Props<T extends string> = {
  options: FilterPickerOption<T>[];
  value: T;
  placeholder?: string;
  disabled?: boolean;
  zIndex?: number;
  compact?: boolean;
  fitSelected?: boolean;
  /** Extra left padding beyond the default 12px (e.g. calendar icon slot). */
  leadingPad?: number;
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

  const pickerWidth = useMemo(() => {
    const labels = props.fitSelected && selectedOption
      ? [selectedOption.label]
      : props.options.map((option) => option.label);
    const padLeft = FILTER_PICKER_PAD_LEFT + (props.leadingPad ?? 0);
    const padRight = props.compact ? 26 : FILTER_PICKER_PAD_RIGHT;
    const min = props.fitSelected ? 96 : props.compact ? 108 : 120;
    return filterPickerWidth(labels, { min, max: 480, padLeft, padRight });
  }, [props.compact, props.fitSelected, props.leadingPad, props.options, selectedOption]);

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
      className={`sa-tag-filter-picker${open ? ' sa-tag-filter-picker--open' : ''}${props.compact ? ' sa-tag-filter-picker--compact' : ''}`}
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
            const menu = pickerRef.current?.querySelector('.sa-tag-filter-menu');
            if (menu?.contains(next)) return;
            window.setTimeout(closePicker, 160);
          }}
          placeholder={props.placeholder ?? selectedOption?.label ?? 'Выберите значение'}
          disabled={props.disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
        />
      </FilterPickerField>
      <FilterPickerMenu open={open} role="listbox" zIndex={props.zIndex}>
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
