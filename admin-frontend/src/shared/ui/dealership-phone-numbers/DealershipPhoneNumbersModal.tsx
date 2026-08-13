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
import { SingleSelectFilterPicker } from '../filter-picker/SingleSelectFilterPicker';
import { formatPhoneInput, formatPhoneInputLive } from '../phone-number-utils';
import { BrutalModal } from '../brutal-modal';
import { DeleteConfirmModal } from '../delete-confirm-modal';
import { EditIcon } from '../icons/ActionIcons';
import { LetsIcon } from '../icons/LetsIcon';
import { UnsavedChangesModal } from '../unsaved-changes-modal';

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

const PHONE_FORM_ID = 'phone-number-form';

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
  onDelete?: () => void;
  onClose: () => void;
  onSubmit: (form: PhoneFormState) => void;
}) {
  const [form, setForm] = useState<PhoneFormState>(props.initial);
  const [attempted, setAttempted] = useState(false);
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const wasOpenRef = useRef(false);
  const isDirty = useMemo(
    () => JSON.stringify(normalizePhoneForm(form)) !== JSON.stringify(normalizePhoneForm(props.initial)),
    [form, props.initial],
  );
  const typeInvalid = attempted && !form.typeId;
  const phoneInvalid = attempted && !form.phone.trim();
  const requiredFieldsFilled = Boolean(form.typeId && form.phone.trim());
  const typeOptions = useMemo(
    () => props.types.map((type) => ({ value: type.id, label: type.name })),
    [props.types],
  );

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      setForm(props.initial);
      setAttempted(false);
      setUnsavedOpen(false);
    }
    wasOpenRef.current = props.open;
  }, [props.open, props.initial]);

  function requestClose() {
    if (props.requireChanges && isDirty) {
      setUnsavedOpen(true);
      return;
    }
    props.onClose();
  }

  function submitCurrent() {
    setAttempted(true);
    if (!form.typeId || !form.phone.trim()) return;
    if (props.requireChanges && !isDirty) return;
    props.onSubmit({ ...form, phone: formatPhoneInput(form.phone) });
  }

  return (
    <>
      <BrutalModal
        open={props.open}
        onClose={requestClose}
        title={props.title}
        subtitle="Выберите тип номера и укажите телефон."
        width="medium"
        nested
        footer={(
          <div className="sa-modal-footer-row">
            {props.onDelete ? (
              <button type="button" className="sa-btn-danger" onClick={props.onDelete} disabled={props.saving}>
                Удалить номер
              </button>
            ) : null}
            <div className="sa-modal-footer-row__right">
              <button type="button" className="sa-btn-outline" onClick={requestClose} disabled={props.saving}>Отмена</button>
              <button
                type="submit"
                form={PHONE_FORM_ID}
                className="sa-btn-primary"
                disabled={props.saving || !requiredFieldsFilled || (!!props.requireChanges && !isDirty)}
              >
                {props.saving ? 'Сохраняем...' : props.submitLabel}
              </button>
            </div>
          </div>
        )}
      >
        <form
          id={PHONE_FORM_ID}
          onSubmit={(event) => {
            event.preventDefault();
            submitCurrent();
          }}
          style={{ display: 'grid', gap: 14 }}
        >
          {props.contextLabel && (
            <div className="sa-meta" style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tb-cream)' }}>
              {props.contextLabel}
            </div>
          )}

          <div style={{ display: 'grid', gap: 6 }}>
            <span>Тип номера</span>
            <div className={`sa-tag-filter-picker-wrap${typeInvalid ? ' sa-field-invalid' : ''}`} style={{ width: '100%' }}>
              <SingleSelectFilterPicker
                value={form.typeId}
                options={typeOptions}
                placeholder="Выберите тип"
                zIndex={1500}
                onChange={(value) => setForm((current) => ({ ...current, typeId: value }))}
              />
            </div>
            {typeInvalid && (
              <div className="sa-meta" style={{ color: 'var(--tb-status-red)' }}>Выберите тип номера</div>
            )}
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Номер телефона</span>
            <input
              className={`sa-input${phoneInvalid ? ' sa-field-invalid' : ''}`}
              value={form.phone}
              onChange={(event) => setForm((current) => ({ ...current, phone: formatPhoneInputLive(event.target.value) }))}
              onBlur={() => setForm((current) => ({ ...current, phone: formatPhoneInput(current.phone) }))}
              placeholder="+7 999 999 99 99"
              aria-invalid={phoneInvalid || undefined}
            />
          </label>

          <button
            type="button"
            className="sa-toggle-field"
            aria-pressed={form.isActive}
            onClick={() => setForm((current) => ({ ...current, isActive: !current.isActive }))}
          >
            <span className="sa-toggle-field__text">Номер активен</span>
            <span className="sa-toggle-field__control" aria-hidden="true">
              <span className="sa-toggle-field__thumb" />
            </span>
          </button>

          {props.error && (
            <div style={{ padding: 12, borderRadius: 14, background: 'var(--tb-status-red-bg)', color: 'var(--tb-status-red)', fontSize: 14 }}>
              {props.error}
            </div>
          )}
        </form>
      </BrutalModal>

      <UnsavedChangesModal
        open={unsavedOpen}
        saving={props.saving}
        onCancel={() => setUnsavedOpen(false)}
        onDiscard={() => {
          setUnsavedOpen(false);
          props.onClose();
        }}
        onSave={() => {
          setUnsavedOpen(false);
          submitCurrent();
        }}
      />
    </>
  );
}

function normalizePhoneForm(form: PhoneFormState): PhoneFormState {
  return {
    typeId: form.typeId,
    phone: formatPhoneInput(form.phone),
    isActive: form.isActive,
  };
}

function PhoneNumbersTable(props: {
  loading: boolean;
  items: PhoneNumberItem[];
  onEdit: (item: PhoneNumberItem) => void;
}) {
  return (
    <div className="sa-table-wrap sa-table-wrap-plain">
      <table className="sa-table sa-phone-numbers-table">
        <thead>
          <tr>
            <th>Тип</th>
            <th>Номер</th>
            <th className="sa-text-right">Всего звонков</th>
            <th className="sa-text-right">Успешных</th>
            <th className="sa-text-right">Недозвон</th>
            <th>Статус</th>
            <th className="sa-text-right sa-phone-numbers-actions-col">Действия</th>
          </tr>
        </thead>
        <tbody>
          {props.loading ? (
            <tr><td colSpan={7} className="sa-meta" style={{ padding: 28 }}>Загрузка...</td></tr>
          ) : props.items.length === 0 ? (
            <tr><td colSpan={7} className="sa-meta" style={{ padding: 28 }}>Номеров пока нет</td></tr>
          ) : props.items.map((item) => (
            <tr key={item.id}>
              <td style={{ fontWeight: 700 }}>{item.typeName}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatPhoneInput(item.phone)}</td>
              <td className="sa-text-right">{item.totalCalls ?? 0}</td>
              <td className="sa-text-right"><span className="sa-score-green">{item.successfulCalls ?? 0}</span></td>
              <td className="sa-text-right"><span className={(item.missedCalls ?? 0) > 0 ? 'sa-score-red' : ''}>{item.missedCalls ?? 0}</span></td>
              <td>
                <span className={`sa-status-badge ${item.isActive ? 'sa-status-norm' : 'sa-status-no-data'}`}>
                  {item.isActive ? 'Активен' : 'Неактивен'}
                </span>
              </td>
              <td className="sa-phone-numbers-actions-cell">
                <button
                  type="button"
                  className="sa-btn-icon sa-btn-brutal-3d-icon"
                  onClick={() => props.onEdit(item)}
                  aria-label={`Редактировать ${item.phone}`}
                  title="Редактировать"
                >
                  <EditIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

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
      setDeleteConfirmOpen(false);
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Не удалось обновить номер телефона.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editItem) return;
    setSaving(true);
    setError(null);
    try {
      await deleteDealershipPhoneNumber(editItem.id);
      setDeleteConfirmOpen(false);
      setEditItem(null);
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить номер телефона.');
      setDeleteConfirmOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <BrutalModal
        open={open}
        onClose={onClose}
        title="Номера телефонов"
        subtitle="Номера, привязанные к этой точке."
        width="wide"
        headerActions={(
          <button type="button" className="sa-btn-brutal-3d" onClick={() => { setError(null); setAddOpen(true); }} disabled={types.length === 0}>
            <LetsIcon name="add-light" size={16} bold />
            Добавить
          </button>
        )}
      >
        {types.length === 0 && !loading && (
          <div style={{ padding: 12, borderRadius: 14, background: 'var(--tb-status-orange-bg)', color: '#92400e', fontSize: 14, marginBottom: 12 }}>
            Сначала создайте активный тип номера с принадлежностью “Для точек”.
          </div>
        )}
        {error && !addOpen && !editItem && (
          <div style={{ padding: 12, borderRadius: 14, background: 'var(--tb-status-red-bg)', color: 'var(--tb-status-red)', fontSize: 14, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <PhoneNumbersTable
          loading={loading}
          items={items}
          onEdit={(item) => { setError(null); setDeleteConfirmOpen(false); setEditItem(item); }}
        />

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
          submitLabel="Сохранить"
          initial={editItem ? { typeId: editItem.typeId, phone: formatPhoneInput(editItem.phone), isActive: editItem.isActive } : defaultForm}
          types={types}
          saving={saving}
          error={editItem ? error : null}
          requireChanges
          onDelete={() => setDeleteConfirmOpen(true)}
          onClose={() => {
            setEditItem(null);
            setDeleteConfirmOpen(false);
          }}
          onSubmit={handleEdit}
        />
      </BrutalModal>

      <DeleteConfirmModal
        open={deleteConfirmOpen && !!editItem}
        title="Удалить номер?"
        saving={saving}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => { void handleDelete(); }}
      />
    </>
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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

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
      setDeleteConfirmOpen(false);
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Не удалось обновить номер телефона.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editItem) return;
    setSaving(true);
    setError(null);
    try {
      await deleteUserPhoneNumber(editItem.id);
      setDeleteConfirmOpen(false);
      setEditItem(null);
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить номер телефона.');
      setDeleteConfirmOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <BrutalModal
        open={open}
        onClose={onClose}
        title="Номера телефонов"
        subtitle="Номера, привязанные к этому сотруднику."
        width="wide"
        headerActions={(
          <button
            type="button"
            className="sa-btn-brutal-3d"
            onClick={() => { setError(null); setAddOpen(true); }}
            disabled={!selectedHoldingId || types.length === 0}
          >
            <LetsIcon name="add-light" size={16} bold />
            Добавить
          </button>
        )}
      >
        {holdings.length === 0 && !holdingsLoading && (
          <div style={{ padding: 12, borderRadius: 14, background: 'var(--tb-status-orange-bg)', color: '#92400e', fontSize: 14, marginBottom: 12 }}>
            Перед добавлением номера сотрудника добавьте компанию.
          </div>
        )}
        {selectedHoldingId && types.length === 0 && !loading && (
          <div style={{ padding: 12, borderRadius: 14, background: 'var(--tb-status-orange-bg)', color: '#92400e', fontSize: 14, marginBottom: 12 }}>
            Сначала создайте активный тип номера с принадлежностью “Для сотрудников” в выбранной компании.
          </div>
        )}
        {error && !addOpen && !editItem && (
          <div style={{ padding: 12, borderRadius: 14, background: 'var(--tb-status-red-bg)', color: 'var(--tb-status-red)', fontSize: 14, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <PhoneNumbersTable
          loading={loading}
          items={items}
          onEdit={(item) => { setError(null); setDeleteConfirmOpen(false); setEditItem(item); }}
        />

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
          submitLabel="Сохранить"
          initial={editItem ? { typeId: editItem.typeId, phone: formatPhoneInput(editItem.phone), isActive: editItem.isActive } : defaultForm}
          types={types}
          saving={saving}
          error={editItem ? error : null}
          requireChanges
          onDelete={() => setDeleteConfirmOpen(true)}
          onClose={() => {
            setEditItem(null);
            setDeleteConfirmOpen(false);
          }}
          onSubmit={handleEdit}
        />
      </BrutalModal>

      <DeleteConfirmModal
        open={deleteConfirmOpen && !!editItem}
        title="Удалить номер?"
        saving={saving}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => { void handleDelete(); }}
      />
    </>
  );
}
