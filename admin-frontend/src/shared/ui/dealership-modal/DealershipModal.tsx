import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDealership,
  fetchCities,
  fetchHoldings,
  updateDealership,
  type DealershipDirection,
  type DealershipType,
  type DealershipItem,
  type HoldingItem,
} from '../../api/adminPanel';
import { useToast } from '../toast/ToastProvider';

type DealershipFormState = {
  name: string;
  type: DealershipType;
  directions: DealershipDirection[];
  city: string;
  address: string;
  workingHoursFrom: string;
  workingHoursTo: string;
  holdingId: string;
  isActive: boolean;
};

type Props = {
  mode: 'create' | 'edit';
  open: boolean;
  dealership?: DealershipItem | null;
  onClose: () => void;
  onSaved: (dealership: DealershipItem) => void;
};

const EMPTY_FORM: DealershipFormState = {
  name: '',
  type: 'own',
  directions: [],
  city: '',
  address: '',
  workingHoursFrom: '09:00',
  workingHoursTo: '21:00',
  holdingId: '',
  isActive: true,
};

function fillForm(dealership?: DealershipItem | null): DealershipFormState {
  if (!dealership) return EMPTY_FORM;
  return {
    name: dealership.name,
    type: dealership.type || 'own',
    directions: dealership.directions || [],
    city: dealership.city || '',
    address: dealership.address || '',
    workingHoursFrom: dealership.workingHoursFrom || '09:00',
    workingHoursTo: dealership.workingHoursTo || '21:00',
    holdingId: dealership.holdingId || '',
    isActive: dealership.isActive,
  };
}

function overlayCardStyle(width = 640): React.CSSProperties {
  return {
    width: `min(100%, ${width}px)`,
    maxHeight: '88vh',
    overflowY: 'auto',
    background: '#fff',
    borderRadius: 24,
    boxShadow: '0 28px 80px rgba(15,23,42,0.28)',
    padding: 22,
  };
}

function normalizePayload(form: DealershipFormState) {
  return {
    name: form.name.trim(),
    type: form.type,
    directions: form.directions,
    city: form.city.trim() || null,
    address: form.address.trim() || null,
    workingHoursFrom: form.workingHoursFrom,
    workingHoursTo: form.workingHoursTo,
    holdingId: form.holdingId || null,
    isActive: form.isActive,
  };
}

export function formatWorkingHours(dealership?: Pick<DealershipItem, 'workingHoursFrom' | 'workingHoursTo'> | null): string {
  const from = dealership?.workingHoursFrom || EMPTY_FORM.workingHoursFrom;
  const to = dealership?.workingHoursTo || EMPTY_FORM.workingHoursTo;
  return `${from} - ${to}`;
}

const DIRECTION_OPTIONS: { value: DealershipDirection; label: string }[] = [
  { value: 'new_cars', label: 'Новые автомобили' },
  { value: 'used_cars', label: 'Автомобили с пробегом' },
];

const CITY_PAGE_SIZE = 100;

function CitySelect(props: {
  value: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState(props.value);
  const [debouncedSearch, setDebouncedSearch] = useState(props.value);
  const [options, setOptions] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!open) setSearchValue(props.value);
  }, [open, props.value]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchValue.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchValue]);

  useEffect(() => {
    if (!open) return;
    void loadCities(0, false);
  }, [debouncedSearch, open]);

  async function loadCities(offset: number, append: boolean) {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const result = await fetchCities({
        search: debouncedSearch,
        limit: CITY_PAGE_SIZE,
        offset,
      });
      if (requestIdRef.current !== requestId) return;
      setOptions((current) => append ? [...current, ...result.items] : result.items);
      setHasMore(result.hasMore);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setOptions([]);
      setHasMore(false);
      props.onError(error instanceof Error ? error.message : 'Не удалось загрузить города.');
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 24;
    if (nearBottom && hasMore && !loading) {
      void loadCities(options.length, true);
    }
  }

  function selectCity(city: string) {
    props.onChange(city);
    setSearchValue(city);
    setOpen(false);
  }

  return (
    <div
      className="sa-city-select"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        className="sa-input"
        value={searchValue}
        placeholder="Начните вводить город"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          const nextValue = event.target.value;
          setSearchValue(nextValue);
          setOpen(true);
          if (nextValue !== props.value) props.onChange('');
        }}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && (
        <div className="sa-city-select__menu" onScroll={handleScroll}>
          {options.map((city) => (
            <button
              key={city}
              type="button"
              className="sa-city-select__option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectCity(city)}
            >
              {city}
            </button>
          ))}
          {loading && <div className="sa-city-select__status">Загрузка городов...</div>}
          {!loading && options.length === 0 && (
            <div className="sa-city-select__status">Города не найдены</div>
          )}
        </div>
      )}
    </div>
  );
}

export function DealershipModal({ mode, open, dealership, onClose, onSaved }: Props) {
  const [form, setForm] = useState<DealershipFormState>(EMPTY_FORM);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [saving, setSaving] = useState(false);
  const wasOpenRef = useRef(false);
  const initialForm = useMemo(() => fillForm(dealership), [dealership]);
  const { showToast } = useToast();

  const title = mode === 'create' ? 'Создать автосалон' : 'Редактировать автосалон';
  const submitLabel = mode === 'create' ? 'Создать автосалон' : 'Сохранить изменения';
  const isDirty = useMemo(
    () => JSON.stringify(normalizePayload(form)) !== JSON.stringify(normalizePayload(initialForm)),
    [form, initialForm],
  );
  const canSubmit = useMemo(() => {
    return form.name.trim().length > 0 && form.workingHoursFrom <= form.workingHoursTo && (mode === 'create' || isDirty);
  }, [form.name, form.workingHoursFrom, form.workingHoursTo, isDirty, mode]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setForm(initialForm);
      fetchHoldings()
        .then(setHoldings)
        .catch(() => setHoldings([]));
    }
    wasOpenRef.current = open;
  }, [open, initialForm]);

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) {
      showToast({ type: 'error', title: 'Не удалось сохранить автосалон', description: 'Название автосалона обязательно.' });
      return;
    }
    if (form.workingHoursTo < form.workingHoursFrom) {
      showToast({ type: 'error', title: 'Не удалось сохранить автосалон', description: 'Время окончания работы не может быть меньше времени начала.' });
      return;
    }
    setSaving(true);
    try {
      const payload = normalizePayload(form);
      const saved = mode === 'create'
        ? await createDealership(payload)
        : await updateDealership(dealership?.id || '', payload);
      onSaved(saved);
      onClose();
      showToast({
        type: 'success',
        title: mode === 'create' ? 'Автосалон создан' : 'Автосалон сохранён',
        description: saved.name,
      });
    } catch (saveError) {
      showToast({
        type: 'error',
        title: 'Не удалось сохранить автосалон',
        description: saveError instanceof Error ? saveError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSaving(false);
    }
  }

  function toggleDirection(direction: DealershipDirection) {
    setForm((current) => ({
      ...current,
      directions: current.directions.includes(direction)
        ? current.directions.filter((item) => item !== direction)
        : [...current.directions, direction],
    }));
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.48)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        zIndex: 120,
      }}
      onClick={onClose}
    >
      <div style={overlayCardStyle()} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{title}</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>
              Основные параметры автосалона и график работы.
            </div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название</span>
            <input className="sa-input" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
          </label>

          <div style={{ display: 'grid', gap: 6 }}>
            <span>Тип автосалона</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              {[
                { value: 'own' as DealershipType, label: 'Собственный' },
                { value: 'franchised' as DealershipType, label: 'Франчайзинговый' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={form.type === option.value ? 'sa-btn-primary' : 'sa-btn-outline'}
                  onClick={() => setForm((current) => ({ ...current, type: option.value }))}
                  style={{
                    justifyContent: 'center',
                    textAlign: 'center',
                    width: '100%',
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <span>Направления</span>
            <div style={{ display: 'grid', gap: 8 }}>
              {DIRECTION_OPTIONS.map((option) => (
                <label key={option.value} className="sa-filter-check">
                  <input
                    type="checkbox"
                    checked={form.directions.includes(option.value)}
                    onChange={() => toggleDirection(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Город</span>
            <CitySelect
              value={form.city}
              onChange={(city) => setForm((current) => ({ ...current, city }))}
              onError={(message) => showToast({ type: 'error', title: 'Не удалось загрузить города', description: message })}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Адрес</span>
            <input className="sa-input" value={form.address} onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))} />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Время работы с</span>
              <input
                className="sa-input"
                type="time"
                value={form.workingHoursFrom}
                onChange={(event) => setForm((current) => ({ ...current, workingHoursFrom: event.target.value }))}
                required
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Время работы до</span>
              <input
                className="sa-input"
                type="time"
                value={form.workingHoursTo}
                min={form.workingHoursFrom}
                onChange={(event) => setForm((current) => ({ ...current, workingHoursTo: event.target.value }))}
                required
              />
            </label>
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Холдинг</span>
            <select className="sa-select" value={form.holdingId} onChange={(event) => setForm((current) => ({ ...current, holdingId: event.target.value }))}>
              <option value="">Без холдинга</option>
              {holdings.map((holding) => (
                <option key={holding.id} value={holding.id}>{holding.name}</option>
              ))}
            </select>
          </label>

          {mode === 'edit' && (
            <button
              type="button"
              className="sa-toggle-field"
              aria-pressed={form.isActive}
              onClick={() => setForm((current) => ({ ...current, isActive: !current.isActive }))}
            >
              <span className="sa-toggle-field__text">Автосалон включен</span>
              <span className="sa-toggle-field__control" aria-hidden="true">
                <span className="sa-toggle-field__thumb" />
              </span>
            </button>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="sa-btn-outline" onClick={onClose}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={saving || !canSubmit}>
              {saving ? 'Сохраняем...' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
