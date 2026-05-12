import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDealership,
  fetchHoldings,
  updateDealership,
  type DealershipItem,
  type HoldingItem,
} from '../../api/adminPanel';

type DealershipFormState = {
  name: string;
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

export function DealershipModal({ mode, open, dealership, onClose, onSaved }: Props) {
  const [form, setForm] = useState<DealershipFormState>(EMPTY_FORM);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenRef = useRef(false);
  const initialForm = useMemo(() => fillForm(dealership), [dealership]);

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
      setError(null);
      fetchHoldings()
        .then(setHoldings)
        .catch(() => setHoldings([]));
    }
    wasOpenRef.current = open;
  }, [open, initialForm]);

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError('Название автосалона обязательно.');
      return;
    }
    if (form.workingHoursTo < form.workingHoursFrom) {
      setError('Время окончания работы не может быть меньше времени начала.');
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
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить автосалон.');
    } finally {
      setSaving(false);
    }
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

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Город</span>
            <input className="sa-input" value={form.city} onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))} />
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

          <label className="sa-filter-check">
            <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))} />
            <span>Автосалон включен</span>
          </label>

          {error && (
            <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
              {error}
            </div>
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
