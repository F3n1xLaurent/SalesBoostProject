import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDealership,
  deleteDealership,
  fetchCities,
  fetchDealershipDirections,
  fetchHoldings,
  updateDealership,
  type DealershipDirection,
  type DealershipDirectionItem,
  type DealershipType,
  type DealershipItem,
  type HoldingItem,
} from '../../api/adminPanel';
import { useToast } from '../toast/ToastProvider';
import { BrutalModal } from '../brutal-modal';
import { BrutalSegmented } from '../brutal-segmented';
import { UnsavedChangesModal } from '../unsaved-changes-modal';
import { DeleteConfirmModal } from '../delete-confirm-modal';

function normalizeTimeValue(value: string): string {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec((value || '').trim());
  if (!match) return '09:00';
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(Number.isFinite(hours) ? hours : 9).padStart(2, '0')}:${String(Number.isFinite(minutes) ? minutes : 0).padStart(2, '0')}`;
}

function TimeInput(props: {
  id: string;
  value: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(normalizeTimeValue(props.value));

  useEffect(() => {
    setDraft(normalizeTimeValue(props.value));
  }, [props.value]);

  function commit(raw: string) {
    const next = normalizeTimeValue(raw);
    setDraft(next);
    props.onChange(next);
  }

  function openPicker() {
    const picker = pickerRef.current;
    if (!picker) return;
    picker.value = normalizeTimeValue(draft);
    if (typeof picker.showPicker === 'function') {
      try {
        picker.showPicker();
        return;
      } catch {
        // fall through to focus
      }
    }
    picker.focus();
    picker.click();
  }

  return (
    <div className={`sa-time-input${props.invalid ? ' sa-field-invalid' : ''}`}>
      <input
        id={props.id}
        className="sa-input sa-time-input__field"
        inputMode="numeric"
        autoComplete="off"
        placeholder="09:00"
        value={draft}
        onChange={(event) => {
          const next = event.target.value.replace(/[^\d:]/g, '').slice(0, 5);
          setDraft(next);
          if (/^\d{2}:\d{2}$/.test(next)) props.onChange(normalizeTimeValue(next));
        }}
        onBlur={() => commit(draft)}
      />
      <input
        ref={pickerRef}
        type="time"
        step={60}
        className="sa-time-input__native"
        tabIndex={-1}
        value={normalizeTimeValue(draft)}
        onChange={(event) => commit(event.target.value.slice(0, 5))}
        aria-hidden="true"
      />
      <button
        type="button"
        className="sa-time-input__trigger"
        onClick={openPicker}
        aria-label="Выбрать время"
        title="Выбрать время"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
    </div>
  );
}

type DealershipFormState = {
  name: string;
  description: string;
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
  fixedHoldingId?: string | null;
  fixedHoldingName?: string | null;
  onClose: () => void;
  onSaved: (dealership: DealershipItem) => void;
  onDeleted?: (dealershipId: string) => void;
};

const EMPTY_FORM: DealershipFormState = {
  name: '',
  description: '',
  type: 'own',
  directions: [],
  city: '',
  address: '',
  workingHoursFrom: '09:00',
  workingHoursTo: '21:00',
  holdingId: '',
  isActive: true,
};

const FORM_ID = 'dealership-modal-form';

function fillForm(dealership?: DealershipItem | null): DealershipFormState {
  if (!dealership) return EMPTY_FORM;
  return {
    name: dealership.name,
    description: dealership.description || '',
    type: dealership.type || 'own',
    directions: dealership.directions || [],
    city: dealership.city || '',
    address: dealership.address || '',
    workingHoursFrom: (dealership.workingHoursFrom || '09:00').slice(0, 5),
    workingHoursTo: (dealership.workingHoursTo || '21:00').slice(0, 5),
    holdingId: dealership.holdingId || '',
    isActive: dealership.isActive,
  };
}

function normalizePayload(form: DealershipFormState) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
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

const CITY_PAGE_SIZE = 100;

function CitySelect(props: {
  value: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
  invalid?: boolean;
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
      className={`sa-city-select${props.invalid ? ' sa-field-invalid' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        className={`sa-input${props.invalid ? ' sa-field-invalid' : ''}`}
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
        aria-invalid={props.invalid || undefined}
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

export function DealershipModal({ mode, open, dealership, fixedHoldingId, fixedHoldingName, onClose, onSaved, onDeleted }: Props) {
  const [form, setForm] = useState<DealershipFormState>(EMPTY_FORM);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [directions, setDirections] = useState<DealershipDirectionItem[]>([]);
  const [directionsLoading, setDirectionsLoading] = useState(false);
  const [directionsError, setDirectionsError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const wasOpenRef = useRef(false);
  const initialForm = useMemo(() => fillForm(dealership), [dealership]);
  const { showToast } = useToast();

  const title = mode === 'create' ? 'Создать точку' : 'Редактировать точку';
  const submitLabel = mode === 'create' ? 'Создать точку' : 'Сохранить';
  const lockedHoldingId = mode === 'create' ? fixedHoldingId || '' : '';
  const isDirty = useMemo(
    () => JSON.stringify(normalizePayload(form)) !== JSON.stringify(normalizePayload(initialForm)),
    [form, initialForm],
  );

  const nameInvalid = attempted && !form.name.trim();
  const cityInvalid = attempted && !form.city.trim();
  const holdingInvalid = attempted && mode === 'create' && !lockedHoldingId && !form.holdingId;
  const directionsInvalid = attempted && mode === 'create' && form.directions.length === 0;
  const hoursInvalid = attempted && form.workingHoursTo < form.workingHoursFrom;
  const requiredFieldsFilled = Boolean(
    form.name.trim()
    && form.city.trim()
    && form.workingHoursFrom
    && form.workingHoursTo
    && form.workingHoursTo >= form.workingHoursFrom
    && (mode === 'edit' || (
      form.holdingId
      && form.directions.length > 0
      && directions.length > 0
      && !directionsLoading
      && !directionsError
    )),
  );

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setForm(lockedHoldingId ? { ...initialForm, holdingId: lockedHoldingId } : initialForm);
      setAttempted(false);
      setUnsavedOpen(false);
      setDeleteConfirmOpen(false);
      if (!lockedHoldingId) {
        fetchHoldings()
          .then(setHoldings)
          .catch(() => setHoldings([]));
      }
    }
    wasOpenRef.current = open;
  }, [lockedHoldingId, open, initialForm]);

  useEffect(() => {
    if (!open || !lockedHoldingId) return;
    setForm((current) => current.holdingId === lockedHoldingId ? current : { ...current, holdingId: lockedHoldingId });
  }, [lockedHoldingId, open]);

  useEffect(() => {
    if (!open || !form.holdingId) {
      setDirections([]);
      setDirectionsLoading(false);
      setDirectionsError('');
      if (open) setForm((current) => current.directions.length ? { ...current, directions: [] } : current);
      return;
    }
    let cancelled = false;
    setDirectionsLoading(true);
    setDirectionsError('');
    fetchDealershipDirections({ holdingId: form.holdingId, active: true })
      .then((items) => {
        if (cancelled) return;
        setDirections(items);
        const allowed = new Set(items.flatMap((item) => [item.id, item.code].filter(Boolean) as string[]));
        setForm((current) => ({
          ...current,
          directions: current.directions.filter((direction) => allowed.has(direction)),
        }));
      })
      .catch(() => {
        if (!cancelled) {
          setDirections([]);
          setDirectionsError('Не удалось загрузить направления. Попробуйте ещё раз.');
        }
      })
      .finally(() => {
        if (!cancelled) setDirectionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [form.holdingId, open]);

  function requestClose() {
    if (mode === 'edit' && isDirty) {
      setUnsavedOpen(true);
      return;
    }
    onClose();
  }

  async function persist(): Promise<boolean> {
    if (!form.name.trim()) {
      setAttempted(true);
      showToast({ type: 'error', title: 'Не удалось сохранить точку', description: 'Название точки обязательно.' });
      return false;
    }
    if (!form.city.trim()) {
      setAttempted(true);
      showToast({ type: 'error', title: 'Не удалось сохранить точку', description: 'Город обязателен.' });
      return false;
    }
    if (form.workingHoursTo < form.workingHoursFrom) {
      setAttempted(true);
      showToast({ type: 'error', title: 'Не удалось сохранить точку', description: 'Время окончания работы не может быть меньше времени начала.' });
      return false;
    }
    if (mode === 'create' && !form.holdingId) {
      setAttempted(true);
      showToast({ type: 'error', title: 'Не удалось создать точку', description: 'Перед созданием точки выберите компанию.' });
      return false;
    }
    if (mode === 'create' && directionsLoading) {
      showToast({ type: 'error', title: 'Не удалось создать точку', description: 'Дождитесь загрузки направлений.' });
      return false;
    }
    if (mode === 'create' && directionsError) {
      showToast({ type: 'error', title: 'Не удалось создать точку', description: directionsError });
      return false;
    }
    if (mode === 'create' && form.holdingId && directions.length === 0) {
      setAttempted(true);
      showToast({
        type: 'error',
        title: 'Невозможно создать точку',
        description: 'У выбранной компании нет активных направлений. Необходимо сначала их добавить.',
      });
      return false;
    }
    if (mode === 'create' && form.directions.length === 0) {
      setAttempted(true);
      showToast({ type: 'error', title: 'Не удалось создать точку', description: 'Выберите хотя бы одно направление.' });
      return false;
    }
    setSaving(true);
    try {
      const payload = normalizePayload(form);
      const saved = mode === 'create'
        ? await createDealership(payload)
        : await updateDealership(dealership?.id || '', payload);
      onSaved(saved);
      setUnsavedOpen(false);
      onClose();
      showToast({
        type: 'success',
        title: mode === 'create' ? 'Точка создана' : 'Точка сохранена',
        description: saved.name,
      });
      return true;
    } catch (saveError) {
      showToast({
        type: 'error',
        title: 'Не удалось сохранить точку',
        description: saveError instanceof Error ? saveError.message : 'Попробуйте повторить действие.',
      });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!dealership?.id) return;
    setSaving(true);
    try {
      await deleteDealership(dealership.id);
      setDeleteConfirmOpen(false);
      setUnsavedOpen(false);
      onDeleted?.(dealership.id);
      onClose();
      showToast({
        type: 'success',
        title: 'Точка удалена',
        description: dealership.name,
      });
    } catch (deleteError) {
      showToast({
        type: 'error',
        title: 'Не удалось удалить точку',
        description: deleteError instanceof Error ? deleteError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (mode === 'edit' && !isDirty) return;
    await persist();
  }

  function toggleDirection(direction: DealershipDirection) {
    setForm((current) => ({
      ...current,
      directions: current.directions.includes(direction)
        ? current.directions.filter((item) => item !== direction)
        : [...current.directions, direction],
    }));
  }

  if (!open) return null;

  return (
    <>
      <BrutalModal
        open={open}
        onClose={requestClose}
        title={title}
        subtitle="Основные параметры точки и график работы."
        width="medium"
        footer={(
          <div className="sa-modal-footer-row">
            {mode === 'edit' ? (
              <button type="button" className="sa-btn-danger" onClick={() => setDeleteConfirmOpen(true)} disabled={saving}>
                Удалить точку
              </button>
            ) : null}
            <div className="sa-modal-footer-row__right">
              <button type="button" className="sa-btn-outline" onClick={requestClose} disabled={saving}>Отмена</button>
              <button
                type="submit"
                form={FORM_ID}
                className="sa-btn-primary"
                disabled={saving || !requiredFieldsFilled || (mode === 'edit' && !isDirty)}
              >
                {saving ? 'Сохраняем...' : submitLabel}
              </button>
            </div>
          </div>
        )}
      >
        <form id={FORM_ID} onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
          {lockedHoldingId ? (
            <div className="sa-meta" style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tb-cream)' }}>
              Компания: {fixedHoldingName || 'выбранная компания'}
            </div>
          ) : (
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Компания</span>
              <select
                className={`sa-select${holdingInvalid ? ' sa-field-invalid' : ''}`}
                value={form.holdingId}
                onChange={(event) => setForm((current) => ({ ...current, holdingId: event.target.value }))}
                aria-invalid={holdingInvalid || undefined}
              >
                <option value="">Без компании</option>
                {holdings.map((holding) => (
                  <option key={holding.id} value={holding.id}>{holding.name}</option>
                ))}
              </select>
            </label>
          )}

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название</span>
            <input
              className={`sa-input${nameInvalid ? ' sa-field-invalid' : ''}`}
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              aria-invalid={nameInvalid || undefined}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Описание</span>
            <textarea
              className="sa-input"
              rows={4}
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              placeholder="Заполните информацию о точке, расскажите чем занимается, какое направление"
            />
          </label>

          <div style={{ display: 'grid', gap: 6 }}>
            <span>Тип точки</span>
            <BrutalSegmented
              ariaLabel="Тип точки"
              value={form.type}
              options={[
                { value: 'own' as DealershipType, label: 'Собственный' },
                { value: 'franchised' as DealershipType, label: 'Франчайзинговый' },
              ]}
              onChange={(type) => setForm((current) => ({ ...current, type }))}
            />
          </div>

          <div
            className={directionsInvalid ? 'sa-field-invalid' : undefined}
            style={{ display: 'grid', gap: 8, padding: directionsInvalid ? 8 : 0, border: '1px solid transparent', borderRadius: 8 }}
          >
            <span>Направления{mode === 'create' ? ' *' : ''}</span>
            <div style={{ display: 'grid', gap: 8 }}>
              {!form.holdingId && (
                <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13 }}>
                  Сначала выберите компанию.
                </div>
              )}
              {form.holdingId && directionsLoading && (
                <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13 }}>
                  Загрузка направлений...
                </div>
              )}
              {form.holdingId && !directionsLoading && directionsError && (
                <div style={{ color: 'var(--tb-brutal-red)', fontSize: 13 }}>{directionsError}</div>
              )}
              {form.holdingId && !directionsLoading && !directionsError && directions.length === 0 && (
                <div style={{ color: 'var(--tb-brutal-red)', fontSize: 13 }}>
                  У выбранной компании нет активных направлений. Необходимо сначала их добавить.
                </div>
              )}
              {directions.map((option) => {
                const value = option.code || option.id;
                return (
                  <label key={option.id} className="sa-filter-check">
                    <input
                      type="checkbox"
                      checked={form.directions.includes(value)}
                      onChange={() => toggleDirection(value)}
                    />
                    <span>{option.name}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Город</span>
            <CitySelect
              value={form.city}
              onChange={(city) => setForm((current) => ({ ...current, city }))}
              onError={(message) => showToast({ type: 'error', title: 'Не удалось загрузить города', description: message })}
              invalid={cityInvalid}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Адрес</span>
            <input className="sa-input" value={form.address} onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))} />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }} htmlFor="dealership-hours-from">
              <span>Время работы с</span>
              <TimeInput
                id="dealership-hours-from"
                value={form.workingHoursFrom}
                invalid={hoursInvalid}
                onChange={(workingHoursFrom) => setForm((current) => ({ ...current, workingHoursFrom }))}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }} htmlFor="dealership-hours-to">
              <span>Время работы до</span>
              <TimeInput
                id="dealership-hours-to"
                value={form.workingHoursTo}
                invalid={hoursInvalid}
                onChange={(workingHoursTo) => setForm((current) => ({ ...current, workingHoursTo }))}
              />
            </label>
          </div>

          {mode === 'edit' && (
            <button
              type="button"
              className="sa-toggle-field"
              aria-pressed={form.isActive}
              onClick={() => setForm((current) => ({ ...current, isActive: !current.isActive }))}
            >
              <span className="sa-toggle-field__text">Точка включена</span>
              <span className="sa-toggle-field__control" aria-hidden="true">
                <span className="sa-toggle-field__thumb" />
              </span>
            </button>
          )}
        </form>
      </BrutalModal>

      <UnsavedChangesModal
        open={unsavedOpen}
        saving={saving}
        onCancel={() => setUnsavedOpen(false)}
        onDiscard={() => {
          setUnsavedOpen(false);
          onClose();
        }}
        onSave={() => { void persist(); }}
      />

      <DeleteConfirmModal
        open={deleteConfirmOpen && mode === 'edit'}
        title="Удалить точку?"
        saving={saving}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => { void handleDeleteConfirm(); }}
      />
    </>
  );
}
