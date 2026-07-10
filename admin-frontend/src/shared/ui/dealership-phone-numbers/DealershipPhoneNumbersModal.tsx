import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDealershipPhoneNumber,
  createUserPhoneNumber,
  deleteDealershipPhoneNumber,
  deleteUserPhoneNumber,
  fetchDealershipPhoneNumbers,
  fetchHoldings,
  fetchPhoneNumberTypes,
  fetchUserPhoneNumbers,
  updateDealershipPhoneNumber,
  updateUserPhoneNumber,
  type HoldingItem,
  type PhoneNumberItem,
  type PhoneNumberTypeItem,
} from '../../api/adminPanel';
import { useGlobalHoldingFilter } from '../../lib/global-holding-filter/useGlobalHoldingFilter';
import { formatPhoneInput, formatPhoneInputLive } from '../phone-number-utils';
import { FixedOverlayPortal } from '../fixed-overlay-portal/FixedOverlayPortal';

type PhoneFormState = {
  typeId: string;
  phone: string;
  isActive: boolean;
};

const EMPTY_FORM: PhoneFormState = {
  typeId: '',
  phone: '',
  isActive: true,
};

function overlayCardStyle(width = 760): React.CSSProperties {
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

function PhoneNumberFormModal(props: {
  open: boolean;
  title: string;
  submitLabel: string;
  initial: PhoneFormState;
  types: PhoneNumberTypeItem[];
  saving: boolean;
  error: string | null;
  contextLabel?: string | null;
  requireChanges?: boolean;
  onClose: () => void;
  onSubmit: (form: PhoneFormState) => void;
}) {
  const [form, setForm] = useState<PhoneFormState>(props.initial);
  const wasOpenRef = useRef(false);
  const isDirty = useMemo(
    () => JSON.stringify(normalizePhoneForm(form)) !== JSON.stringify(normalizePhoneForm(props.initial)),
    [form, props.initial],
  );

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      setForm(props.initial);
    }
    wasOpenRef.current = props.open;
  }, [props.open, props.initial]);

  if (!props.open) return null;

  return (
    <FixedOverlayPortal>
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.48)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        zIndex: 130,
      }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle(560)} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={props.title}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{props.title}</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>
              Выберите тип номера и укажите телефон.
            </div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit({ ...form, phone: formatPhoneInput(form.phone) });
          }}
          style={{ display: 'grid', gap: 14 }}
        >
          {props.contextLabel && (
            <div className="sa-meta" style={{ padding: '10px 12px', borderRadius: 8, background: '#F8FAFC' }}>
              {props.contextLabel}
            </div>
          )}

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Тип номера</span>
            <select className="sa-select" value={form.typeId} onChange={(event) => setForm((current) => ({ ...current, typeId: event.target.value }))} required>
              <option value="">Выберите тип</option>
              {props.types.map((type) => (
                <option key={type.id} value={type.id}>{type.name}</option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Номер телефона</span>
            <input
              className="sa-input"
              value={form.phone}
              onChange={(event) => setForm((current) => ({ ...current, phone: formatPhoneInputLive(event.target.value) }))}
              onBlur={() => setForm((current) => ({ ...current, phone: formatPhoneInput(current.phone) }))}
              placeholder="+7 999 999 99 99"
              required
            />
          </label>

          <label className="sa-filter-check">
            <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))} />
            <span>Номер активен</span>
          </label>

          {props.error && (
            <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
              {props.error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="sa-btn-outline" onClick={props.onClose}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={props.saving || !form.typeId || !form.phone.trim() || (!!props.requireChanges && !isDirty)}>
              {props.saving ? 'Сохраняем...' : props.submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
    </FixedOverlayPortal>
  );
}

function normalizePhoneForm(form: PhoneFormState): PhoneFormState {
  return {
    typeId: form.typeId,
    phone: formatPhoneInput(form.phone),
    isActive: form.isActive,
  };
}

export function DealershipPhoneNumbersModal({ dealershipId, open, onClose }: {
  dealershipId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<PhoneNumberItem[]>([]);
  const [types, setTypes] = useState<PhoneNumberTypeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<PhoneNumberItem | null>(null);

  const defaultForm = useMemo<PhoneFormState>(() => ({
    ...EMPTY_FORM,
    typeId: types[0]?.id || '',
  }), [types]);

  async function loadData() {
    if (!dealershipId) return;
    setLoading(true);
    setError(null);
    try {
      const [numbers, loadedTypes] = await Promise.all([
        fetchDealershipPhoneNumbers(dealershipId),
        fetchPhoneNumberTypes({ ownership: 'dealership', active: true }),
      ]);
      setItems(numbers);
      setTypes(loadedTypes);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить номера телефонов.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) loadData();
  }, [open, dealershipId]);

  if (!open) return null;

  async function handleCreate(form: PhoneFormState) {
    setSaving(true);
    setError(null);
    try {
      await createDealershipPhoneNumber(dealershipId, form);
      setAddOpen(false);
      await loadData();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Не удалось добавить номер телефона.');
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(form: PhoneFormState) {
    if (!editItem) return;
    setSaving(true);
    setError(null);
    try {
      await updateDealershipPhoneNumber(editItem.id, form);
      setEditItem(null);
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Не удалось обновить номер телефона.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: PhoneNumberItem) {
    setSaving(true);
    setError(null);
    try {
      await deleteDealershipPhoneNumber(item.id);
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить номер телефона.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <FixedOverlayPortal>
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
      <div style={overlayCardStyle()} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Номера телефонов">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>Номера телефонов</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>
              Номера, привязанные к этой точке.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="sa-btn-primary" onClick={() => { setError(null); setAddOpen(true); }} disabled={types.length === 0}>
              Добавить
            </button>
            <button type="button" className="sa-btn-outline sa-btn-icon" onClick={onClose} aria-label="Закрыть">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>

        {types.length === 0 && !loading && (
          <div style={{ padding: 12, borderRadius: 14, background: '#fffbeb', color: '#92400e', fontSize: 14, marginBottom: 12 }}>
            Сначала создайте активный тип номера с принадлежностью “Для точек”.
          </div>
        )}
        {error && !addOpen && !editItem && (
          <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Тип</th>
                <th>Номер</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="sa-meta" style={{ padding: 28 }}>Загрузка...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={4} className="sa-meta" style={{ padding: 28 }}>Номеров пока нет</td></tr>
              ) : items.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 700 }}>{item.typeName}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatPhoneInput(item.phone)}</td>
                  <td><span className={item.isActive ? 'sa-emp-status' : 'sa-emp-status sa-emp-warn'}>{item.isActive ? 'Активен' : 'Неактивен'}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => { setError(null); setEditItem(item); }}>
                        Редактировать
                      </button>
                      <button type="button" className="sa-btn-danger sa-btn-sm" onClick={() => handleDelete(item)} disabled={saving}>
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <PhoneNumberFormModal
          open={addOpen}
          title="Добавить номер"
          submitLabel="Добавить"
          initial={defaultForm}
          types={types}
          saving={saving}
          error={addOpen ? error : null}
          onClose={() => setAddOpen(false)}
          onSubmit={handleCreate}
        />

        <PhoneNumberFormModal
          open={!!editItem}
          title="Редактировать номер"
          submitLabel="Сохранить изменения"
          initial={editItem ? { typeId: editItem.typeId, phone: formatPhoneInput(editItem.phone), isActive: editItem.isActive } : defaultForm}
          types={types}
          saving={saving}
          error={editItem ? error : null}
          requireChanges
          onClose={() => setEditItem(null)}
          onSubmit={handleEdit}
        />
      </div>
    </div>
    </FixedOverlayPortal>
  );
}

export function UserPhoneNumbersModal({ accountId, open, onClose }: {
  accountId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [selectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [items, setItems] = useState<PhoneNumberItem[]>([]);
  const [types, setTypes] = useState<PhoneNumberTypeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<PhoneNumberItem | null>(null);

  const defaultForm = useMemo<PhoneFormState>(() => ({
    ...EMPTY_FORM,
    typeId: types[0]?.id || '',
  }), [types]);

  async function loadHoldings() {
    setHoldingsLoading(true);
    setError(null);
    try {
      setHoldings(await fetchHoldings({ status: 'active' }));
    } catch (loadError) {
      setHoldings([]);
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить компании.');
    } finally {
      setHoldingsLoading(false);
    }
  }

  async function loadData() {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const [numbers, loadedTypes] = await Promise.all([
        fetchUserPhoneNumbers(accountId),
        selectedHoldingId
          ? fetchPhoneNumberTypes({ holdingId: selectedHoldingId, ownership: 'user', active: true })
          : Promise.resolve([]),
      ]);
      setItems(numbers);
      setTypes(loadedTypes);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить номера телефонов.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void loadHoldings();
  }, [open]);

  useEffect(() => {
    if (open) void loadData();
  }, [open, accountId, selectedHoldingId]);

  if (!open) return null;

  async function handleCreate(form: PhoneFormState) {
    setSaving(true);
    setError(null);
    try {
      await createUserPhoneNumber(accountId, form);
      setAddOpen(false);
      await loadData();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Не удалось добавить номер телефона.');
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(form: PhoneFormState) {
    if (!editItem) return;
    setSaving(true);
    setError(null);
    try {
      await updateUserPhoneNumber(editItem.id, form);
      setEditItem(null);
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Не удалось обновить номер телефона.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: PhoneNumberItem) {
    setSaving(true);
    setError(null);
    try {
      await deleteUserPhoneNumber(item.id);
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить номер телефона.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <FixedOverlayPortal>
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
      <div style={overlayCardStyle()} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Номера телефонов">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>Номера телефонов</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>
              Номера, привязанные к этому пользователю.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="sa-btn-primary" onClick={() => { setError(null); setAddOpen(true); }} disabled={!selectedHoldingId || types.length === 0}>
              Добавить
            </button>
            <button type="button" className="sa-btn-outline sa-btn-icon" onClick={onClose} aria-label="Закрыть">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>

        {holdings.length === 0 && !holdingsLoading && (
          <div style={{ padding: 12, borderRadius: 14, background: '#fffbeb', color: '#92400e', fontSize: 14, marginBottom: 12 }}>
            Перед добавлением номера пользователя добавьте компанию.
          </div>
        )}
        {selectedHoldingId && types.length === 0 && !loading && (
          <div style={{ padding: 12, borderRadius: 14, background: '#fffbeb', color: '#92400e', fontSize: 14, marginBottom: 12 }}>
            Сначала создайте активный тип номера с принадлежностью “Для пользователей” в выбранной компании.
          </div>
        )}
        {error && !addOpen && !editItem && (
          <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Тип</th>
                <th>Номер</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="sa-meta" style={{ padding: 28 }}>Загрузка...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={4} className="sa-meta" style={{ padding: 28 }}>Номеров пока нет</td></tr>
              ) : items.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 700 }}>{item.typeName}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatPhoneInput(item.phone)}</td>
                  <td><span className={item.isActive ? 'sa-emp-status' : 'sa-emp-status sa-emp-warn'}>{item.isActive ? 'Активен' : 'Неактивен'}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => { setError(null); setEditItem(item); }}>
                        Редактировать
                      </button>
                      <button type="button" className="sa-btn-danger sa-btn-sm" onClick={() => handleDelete(item)} disabled={saving}>
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <PhoneNumberFormModal
          open={addOpen}
          title="Добавить номер"
          submitLabel="Добавить"
          initial={defaultForm}
          types={types}
          saving={saving}
          error={addOpen ? error : null}
          onClose={() => setAddOpen(false)}
          onSubmit={handleCreate}
        />

        <PhoneNumberFormModal
          open={!!editItem}
          title="Редактировать номер"
          submitLabel="Сохранить изменения"
          initial={editItem ? { typeId: editItem.typeId, phone: formatPhoneInput(editItem.phone), isActive: editItem.isActive } : defaultForm}
          types={types}
          saving={saving}
          error={editItem ? error : null}
          requireChanges
          onClose={() => setEditItem(null)}
          onSubmit={handleEdit}
        />
      </div>
    </div>
    </FixedOverlayPortal>
  );
}
