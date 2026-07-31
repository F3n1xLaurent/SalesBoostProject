import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createPhoneNumberType,
  deletePhoneNumberType,
  fetchPhoneNumberTypes,
  fetchHoldings,
  updatePhoneNumberType,
  type HoldingItem,
  type PhoneNumberOwnership,
  type PhoneNumberTypeItem,
} from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { BrutalSelect } from '../../../shared/ui/BrutalSelect';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { EditIcon } from '../../../shared/ui/icons/ActionIcons';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { DeleteConfirmModal } from '../../../shared/ui/delete-confirm-modal';
import { UnsavedChangesModal } from '../../../shared/ui/unsaved-changes-modal';
import { useToast } from '../../../shared/ui/toast/ToastProvider';

type TypeFormState = {
  name: string;
  ownership: PhoneNumberOwnership;
  isActive: boolean;
};

const EMPTY_FORM: TypeFormState = {
  name: '',
  ownership: 'dealership',
  isActive: true,
};

const TYPE_FORM_ID = 'phone-type-modal-form';

const OWNERSHIP_LABELS: Record<PhoneNumberOwnership, string> = {
  dealership: 'Для точек',
  user: 'Для сотрудников',
};

const OWNERSHIP_OPTIONS = [
  { value: 'dealership', label: OWNERSHIP_LABELS.dealership },
  { value: 'user', label: OWNERSHIP_LABELS.user },
];

function normalizeTypeForm(form: TypeFormState): TypeFormState {
  return {
    name: form.name.trim(),
    ownership: form.ownership,
    isActive: form.isActive,
  };
}

function TypeModal(props: {
  open: boolean;
  mode: 'create' | 'edit';
  initial: TypeFormState;
  holdingName?: string | null;
  title: string;
  submitLabel: string;
  saving: boolean;
  error: string | null;
  deleteConfirm?: boolean;
  onDeleteConfirmChange?: (open: boolean) => void;
  onDelete?: () => void;
  onClose: () => void;
  onSubmit: (form: TypeFormState) => void;
}) {
  const [form, setForm] = useState<TypeFormState>(props.initial);
  const [attempted, setAttempted] = useState(false);
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const wasOpenRef = useRef(false);
  const isCreate = props.mode === 'create';
  const isDirty = useMemo(
    () => JSON.stringify(normalizeTypeForm(form)) !== JSON.stringify(normalizeTypeForm(props.initial)),
    [form, props.initial],
  );
  const nameInvalid = attempted && !form.name.trim();

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      setForm(props.initial);
      setAttempted(false);
      setUnsavedOpen(false);
    }
    wasOpenRef.current = props.open;
  }, [props.open, props.initial]);

  function requestClose() {
    if (!isCreate && isDirty) {
      setUnsavedOpen(true);
      return;
    }
    props.onClose();
  }

  function persist(): boolean {
    if (!form.name.trim()) {
      setAttempted(true);
      return false;
    }
    if (!isCreate && !isDirty) return false;
    props.onSubmit(form);
    return true;
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    persist();
  }

  if (!props.open) return null;

  return (
    <>
      <BrutalModal
        open={props.open}
        onClose={requestClose}
        title={props.title}
        subtitle="Тип задаёт назначение номера и доступен при добавлении телефонов."
        width="medium"
        footer={(
          <div className="sa-modal-footer-row">
            {!isCreate && (
              <button
                type="button"
                className="sa-btn-danger"
                onClick={() => props.onDeleteConfirmChange?.(true)}
                disabled={props.saving}
              >
                Удалить тип
              </button>
            )}
            <div className="sa-modal-footer-row__right">
              <button type="button" className="sa-btn-outline" onClick={requestClose} disabled={props.saving}>Отмена</button>
              <button
                type="submit"
                form={TYPE_FORM_ID}
                className="sa-btn-primary"
                disabled={props.saving || (!isCreate && !isDirty)}
              >
                {props.saving ? 'Сохраняем...' : props.submitLabel}
              </button>
            </div>
          </div>
        )}
      >
        <form id={TYPE_FORM_ID} onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
          {props.holdingName && (
            <div className="sa-meta" style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tb-cream)' }}>
              Компания: {props.holdingName}
            </div>
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

          <div style={{ display: 'grid', gap: 6 }}>
            <span>Принадлежность</span>
            <BrutalSelect
              value={form.ownership}
              options={OWNERSHIP_OPTIONS}
              aria-label="Принадлежность"
              onChange={(value) => setForm((current) => ({ ...current, ownership: value as PhoneNumberOwnership }))}
            />
          </div>

          <button
            type="button"
            className="sa-toggle-field"
            aria-pressed={form.isActive}
            onClick={() => setForm((current) => ({ ...current, isActive: !current.isActive }))}
          >
            <span className="sa-toggle-field__text">Тип активен</span>
            <span className="sa-toggle-field__control" aria-hidden="true">
              <span className="sa-toggle-field__thumb" />
            </span>
          </button>

          {props.error && (
            <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
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
        onSave={() => { persist(); }}
      />

      <DeleteConfirmModal
        open={!!props.deleteConfirm}
        title="Удалить тип номера?"
        saving={props.saving}
        onCancel={() => props.onDeleteConfirmChange?.(false)}
        onConfirm={() => props.onDelete?.()}
      />
    </>
  );
}

export function TypesNumbersPage() {
  const { showToast } = useToast();
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [items, setItems] = useState<PhoneNumberTypeItem[]>([]);
  const [activeOwnership, setActiveOwnership] = useState<PhoneNumberOwnership>('dealership');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editType, setEditType] = useState<PhoneNumberTypeItem | null>(null);
  const [editDeleteConfirm, setEditDeleteConfirm] = useState(false);
  const selectedHolding = useMemo(
    () => holdings.find((holding) => holding.id === selectedHoldingId) ?? null,
    [holdings, selectedHoldingId],
  );

  const filtered = useMemo(
    () => items.filter((item) => item.ownership === activeOwnership),
    [items, activeOwnership],
  );

  async function loadHoldings() {
    setHoldingsLoading(true);
    setError(null);
    try {
      setHoldings(await fetchHoldings());
    } catch (loadError) {
      setHoldings([]);
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить компании.');
    } finally {
      setHoldingsLoading(false);
    }
  }

  async function loadData(holdingId: string) {
    if (!holdingId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchPhoneNumberTypes({ holdingId }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить типы номеров.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadHoldings();
  }, []);

  useEffect(() => {
    void loadData(selectedHoldingId);
  }, [selectedHoldingId]);

  async function handleCreate(form: TypeFormState) {
    if (!selectedHoldingId) {
      showToast({
        type: 'error',
        title: 'Не удалось создать тип',
        description: 'Перед тем, как создавать типы номеров, пожалуйста, добавьте компанию.',
      });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createPhoneNumberType({
        holdingId: selectedHoldingId,
        name: form.name.trim(),
        ownership: form.ownership,
        isActive: form.isActive,
      });
      setCreateOpen(false);
      showToast({ type: 'success', title: 'Тип номера создан', description: created.name });
      await loadData(selectedHoldingId);
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : 'Не удалось создать тип номера.';
      setError(message);
      showToast({ type: 'error', title: 'Не удалось создать тип', description: message });
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(form: TypeFormState) {
    if (!editType) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updatePhoneNumberType(editType.id, {
        name: form.name.trim(),
        ownership: form.ownership,
        isActive: form.isActive,
      });
      setEditType(null);
      setEditDeleteConfirm(false);
      showToast({ type: 'success', title: 'Тип номера сохранён', description: updated.name });
      await loadData(selectedHoldingId);
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : 'Не удалось обновить тип номера.';
      setError(message);
      showToast({ type: 'error', title: 'Не удалось сохранить тип', description: message });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!editType) return;
    setSaving(true);
    setError(null);
    try {
      const name = editType.name;
      await deletePhoneNumberType(editType.id);
      setEditType(null);
      setEditDeleteConfirm(false);
      showToast({ type: 'success', title: 'Тип номера удалён', description: name });
      await loadData(selectedHoldingId);
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Не удалось удалить тип номера.';
      setError(message);
      setEditDeleteConfirm(false);
      showToast({ type: 'error', title: 'Не удалось удалить тип', description: message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 className="sa-page-title">Типы номеров</h1>

      {error && !createOpen && !editType && (
        <div className="sa-batch-live-error" style={{ marginBottom: 12 }}>{error}</div>
      )}

      <div className="sa-toolbar sa-toolbar-split sa-holdings-toolbar">
        <div className="sa-toolbar-filters">
          <HoldingSelectPicker
            holdings={holdings}
            value={selectedHoldingId}
            onChange={(holdingId) => {
              setSelectedHoldingId(holdingId);
              setError(null);
            }}
            disabled={holdingsLoading || holdings.length === 0}
            loading={holdingsLoading}
          />
        </div>
        <div className="sa-toolbar-actions">
          <button type="button" className="sa-btn-brutal-3d" disabled={!selectedHoldingId} onClick={() => { setError(null); setCreateOpen(true); }}>
            <LetsIcon name="add-light" size={16} bold />
            Создать тип
          </button>
        </div>
      </div>

      <div className="sa-dialog-tabs" style={{ marginBottom: 16 }}>
        {(['dealership', 'user'] as PhoneNumberOwnership[]).map((ownership) => (
          <button
            key={ownership}
            type="button"
            className={`sa-dialog-tab ${activeOwnership === ownership ? 'sa-dialog-tab-active' : ''}`}
            onClick={() => setActiveOwnership(ownership)}
          >
            {OWNERSHIP_LABELS[ownership]}
          </button>
        ))}
      </div>

      <div className="sa-companies-table-wrap sa-holdings-table-wrap">
        <table className="sa-table sa-holdings-table sa-types-numbers-table">
          <colgroup>
            <col className="sa-col-name" />
            <col className="sa-col-type" />
            <col className="sa-col-status" />
            <col className="sa-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>Название</th>
              <th>Принадлежность</th>
              <th>Статус</th>
              <th className="sa-text-right sa-holdings-actions-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {loading || holdingsLoading ? (
              <tr><td colSpan={4} className="sa-meta" style={{ padding: 32 }}>Загрузка...</td></tr>
            ) : holdings.length === 0 ? (
              <tr><td colSpan={4} className="sa-meta" style={{ padding: 32 }}>Перед тем, как создавать типы номеров, пожалуйста, добавьте компанию.</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={4} className="sa-meta" style={{ padding: 32 }}>Типов пока нет</td></tr>
            ) : filtered.map((item) => (
              <tr key={item.id}>
                <td>
                  <div className="sa-cell-name">{item.name}</div>
                </td>
                <td>{OWNERSHIP_LABELS[item.ownership]}</td>
                <td>
                  <span className={`sa-status-badge ${item.isActive ? 'sa-status-norm' : 'sa-status-no-data'}`}>
                    {item.isActive ? 'Активен' : 'Неактивен'}
                  </span>
                </td>
                <td className="sa-holdings-actions-cell">
                  <button
                    type="button"
                    className="sa-btn-icon sa-btn-brutal-3d-icon"
                    onClick={() => { setError(null); setEditDeleteConfirm(false); setEditType(item); }}
                    aria-label={`Редактировать ${item.name}`}
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

      <TypeModal
        open={createOpen}
        mode="create"
        initial={{ ...EMPTY_FORM, ownership: activeOwnership }}
        holdingName={selectedHolding?.name || null}
        title="Создать тип номера"
        submitLabel="Создать"
        saving={saving}
        error={createOpen ? error : null}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
      />

      <TypeModal
        open={!!editType}
        mode="edit"
        initial={editType ? { name: editType.name, ownership: editType.ownership, isActive: editType.isActive } : EMPTY_FORM}
        holdingName={selectedHolding?.name || null}
        title="Редактировать тип номера"
        submitLabel="Сохранить"
        saving={saving}
        error={editType ? error : null}
        deleteConfirm={editDeleteConfirm}
        onDeleteConfirmChange={setEditDeleteConfirm}
        onDelete={() => { void handleDeleteConfirm(); }}
        onClose={() => {
          setEditType(null);
          setEditDeleteConfirm(false);
        }}
        onSubmit={handleEdit}
      />
    </div>
  );
}
