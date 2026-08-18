import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDealershipDirection,
  deleteDealershipDirection,
  fetchDealershipDirections,
  fetchHoldings,
  updateDealershipDirection,
  type DealershipDirectionItem,
  type HoldingItem,
} from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { BrutalSelect } from '../../../shared/ui/BrutalSelect';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { EditIcon } from '../../../shared/ui/icons/ActionIcons';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { UnsavedChangesModal } from '../../../shared/ui/unsaved-changes-modal';
import { DeleteConfirmModal } from '../../../shared/ui/delete-confirm-modal';
import { useToast } from '../../../shared/ui/toast/ToastProvider';

type DirectionFormState = {
  holdingId: string;
  name: string;
  code: string;
  isActive: boolean;
};

const EMPTY_FORM: DirectionFormState = {
  holdingId: '',
  name: '',
  code: '',
  isActive: true,
};

const DIRECTION_FORM_ID = 'direction-modal-form';

function normalizeForm(form: DirectionFormState): DirectionFormState {
  return {
    holdingId: form.holdingId,
    name: form.name.trim(),
    code: form.code.trim(),
    isActive: form.isActive,
  };
}

function DirectionModal(props: {
  open: boolean;
  mode: 'create' | 'edit';
  initial: DirectionFormState;
  holdings: HoldingItem[];
  itemName?: string;
  saving: boolean;
  error: string | null;
  deleteConfirm?: boolean;
  onDeleteConfirmChange?: (value: boolean) => void;
  onClose: () => void;
  onSubmit: (form: DirectionFormState) => void;
  onDelete?: () => void;
}) {
  const [form, setForm] = useState<DirectionFormState>(props.initial);
  const [attempted, setAttempted] = useState(false);
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const wasOpenRef = useRef(false);
  const isCreate = props.mode === 'create';
  const isDirty = useMemo(
    () => JSON.stringify(normalizeForm(form)) !== JSON.stringify(normalizeForm(props.initial)),
    [form, props.initial],
  );
  const holdingInvalid = attempted && !form.holdingId;
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
    if (!form.holdingId || !form.name.trim()) {
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

  const title = isCreate ? 'Создать направление' : 'Редактировать направление';
  const submitLabel = isCreate ? 'Создать' : 'Сохранить';
  const requiredFieldsFilled = Boolean(form.holdingId && form.name.trim());

  return (
    <>
      <BrutalModal
        open={props.open}
        onClose={requestClose}
        title={title}
        subtitle="Направление доступно только точкам выбранной компании."
        width="medium"
        footer={(
          <div className="sa-modal-footer-row">
            {!isCreate && (
              <button type="button" className="sa-btn-danger" onClick={() => props.onDeleteConfirmChange?.(true)} disabled={props.saving}>
                Удалить направление
              </button>
            )}
            <div className="sa-modal-footer-row__right">
              <button type="button" className="sa-btn-outline" onClick={requestClose} disabled={props.saving}>Отмена</button>
              <button
                type="submit"
                form={DIRECTION_FORM_ID}
                className="sa-btn-primary"
                disabled={props.saving || !requiredFieldsFilled || (!isCreate && !isDirty)}
              >
                {props.saving ? 'Сохраняем...' : submitLabel}
              </button>
            </div>
          </div>
        )}
      >
        <form id={DIRECTION_FORM_ID} onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <span>Компания</span>
            <BrutalSelect
              value={form.holdingId}
              options={props.holdings.map((holding) => ({ value: holding.id, label: holding.name }))}
              placeholder="Выберите компанию"
              disabled={!isCreate}
              invalid={holdingInvalid}
              aria-label="Компания"
              onChange={(value) => setForm((current) => ({ ...current, holdingId: value }))}
            />
          </div>

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
            <span>Код</span>
            <input className="sa-input" value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))} placeholder="Сгенерируется автоматически" />
          </label>

          <button
            type="button"
            className="sa-toggle-field"
            aria-pressed={form.isActive}
            onClick={() => setForm((current) => ({ ...current, isActive: !current.isActive }))}
          >
            <span className="sa-toggle-field__text">Направление активно</span>
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
        title="Удалить направление?"
        saving={props.saving}
        onCancel={() => props.onDeleteConfirmChange?.(false)}
        onConfirm={() => props.onDelete()}
      />
    </>
  );
}

export function DealershipDirectionsPage() {
  const { showToast } = useToast();
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [items, setItems] = useState<DealershipDirectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<DealershipDirectionItem | null>(null);
  const [editDeleteConfirm, setEditDeleteConfirm] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !loading);

  const filtered = useMemo(
    () => selectedHoldingId ? items.filter((item) => item.holdingId === selectedHoldingId) : [],
    [selectedHoldingId, items],
  );

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [nextHoldings, nextDirections] = await Promise.all([
        fetchHoldings(),
        fetchDealershipDirections(),
      ]);
      setHoldings(nextHoldings);
      setItems(nextDirections);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить направления точек.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  async function handleCreate(form: DirectionFormState) {
    setSaving(true);
    setError(null);
    try {
      await createDealershipDirection({
        holdingId: form.holdingId,
        name: form.name.trim(),
        code: form.code.trim() || null,
        isActive: form.isActive,
      });
      setCreateOpen(false);
      showToast({ type: 'success', title: 'Направление создано' });
      await loadData();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Не удалось создать направление точки.');
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(form: DirectionFormState) {
    if (!editItem) return;
    setSaving(true);
    setError(null);
    try {
      await updateDealershipDirection(editItem.id, {
        name: form.name.trim(),
        code: form.code.trim() || null,
        isActive: form.isActive,
      });
      setEditItem(null);
      setEditDeleteConfirm(false);
      showToast({ type: 'success', title: 'Направление обновлено' });
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Не удалось обновить направление точки.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!editItem) return;
    setSaving(true);
    setError(null);
    try {
      await deleteDealershipDirection(editItem.id);
      setEditItem(null);
      setEditDeleteConfirm(false);
      showToast({ type: 'success', title: 'Направление удалено' });
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить направление точки.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(item: DealershipDirectionItem) {
    const nextActive = !item.isActive;
    setTogglingId(item.id);
    setError(null);
    setItems((current) => current.map((row) => (
      row.id === item.id ? { ...row, isActive: nextActive } : row
    )));
    if (editItem?.id === item.id) {
      setEditItem((current) => (current ? { ...current, isActive: nextActive } : current));
    }
    try {
      await updateDealershipDirection(item.id, { isActive: nextActive });
    } catch (toggleError) {
      setItems((current) => current.map((row) => (
        row.id === item.id ? { ...row, isActive: item.isActive } : row
      )));
      if (editItem?.id === item.id) {
        setEditItem((current) => (current ? { ...current, isActive: item.isActive } : current));
      }
      setError(toggleError instanceof Error ? toggleError.message : 'Не удалось изменить статус направления.');
    } finally {
      setTogglingId(null);
    }
  }

  function openCreate() {
    setError(null);
    setCreateOpen(true);
  }

  function openEdit(item: DealershipDirectionItem) {
    setError(null);
    setEditDeleteConfirm(false);
    setEditItem(item);
  }

  function closeEdit() {
    setEditItem(null);
    setEditDeleteConfirm(false);
  }

  const createInitial = useMemo<DirectionFormState>(() => ({
    ...EMPTY_FORM,
    holdingId: selectedHoldingId,
  }), [selectedHoldingId]);

  const editInitial = useMemo<DirectionFormState>(() => (
    editItem ? {
      holdingId: editItem.holdingId,
      name: editItem.name,
      code: editItem.code || '',
      isActive: editItem.isActive,
    } : EMPTY_FORM
  ), [editItem]);

  return (
    <div>
      <h1 className="sa-page-title">Направления точек</h1>

      {error && !createOpen && (
        <div className="sa-batch-live-error" style={{ marginBottom: 12 }}>{error}</div>
      )}

      <div className="sa-toolbar sa-toolbar-split sa-holdings-toolbar">
        <div className="sa-toolbar-filters">
          <HoldingSelectPicker
            holdings={holdings}
            value={selectedHoldingId}
            onChange={(holdingId) => {
              setSelectedHoldingId(holdingId);
            }}
            disabled={loading || holdings.length === 0}
            loading={loading}
          />
        </div>
        <div className="sa-toolbar-actions">
          <button type="button" className="sa-btn-brutal-3d" disabled={!selectedHoldingId} onClick={openCreate}>
            <LetsIcon name="add-light" size={16} bold />
            Создать направление
          </button>
        </div>
      </div>

      <div className="sa-companies-table-wrap sa-holdings-table-wrap">
        <table className="sa-table sa-holdings-table">
          <colgroup>
            <col className="sa-col-name" />
            <col className="sa-col-status" />
            <col className="sa-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>Название</th>
              <th>Статус</th>
              <th className="sa-text-right sa-holdings-actions-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={3} className="sa-meta" style={{ padding: 32 }}>Загрузка...</td></tr>
            ) : holdings.length === 0 ? (
              <tr><td colSpan={3} className="sa-meta" style={{ padding: 32 }}>Перед тем, как создавать направления точек, пожалуйста, добавьте компанию.</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={3} className="sa-meta" style={{ padding: 32 }}>Направлений пока нет</td></tr>
            ) : filtered.map((item) => (
              <tr key={item.id}>
                <td>
                  <div className="sa-cell-name">{item.name}</div>
                </td>
                <td>
                  <button
                    type="button"
                    className="sa-table-status-toggle"
                    aria-pressed={item.isActive}
                    aria-label={`${item.isActive ? 'Выключить' : 'Включить'} направление «${item.name}»`}
                    disabled={togglingId === item.id}
                    onClick={() => void handleToggleActive(item)}
                  >
                    <span className="sa-toggle-field__control" aria-hidden="true">
                      <span className="sa-toggle-field__thumb" />
                    </span>
                    <span className={`sa-status-badge ${item.isActive ? 'sa-status-norm' : 'sa-status-no-data'}`}>
                      {item.isActive ? 'Активно' : 'Неактивно'}
                    </span>
                  </button>
                </td>
                <td className="sa-holdings-actions-cell">
                  <button
                    type="button"
                    className="sa-btn-icon sa-btn-brutal-3d-icon"
                    onClick={() => openEdit(item)}
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

      <DirectionModal
        open={createOpen}
        mode="create"
        initial={createInitial}
        holdings={holdings}
        saving={saving}
        error={createOpen ? error : null}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
      />

      <DirectionModal
        open={!!editItem}
        mode="edit"
        initial={editInitial}
        holdings={holdings}
        itemName={editItem?.name}
        saving={saving}
        error={editItem ? error : null}
        deleteConfirm={editDeleteConfirm}
        onDeleteConfirmChange={setEditDeleteConfirm}
        onClose={closeEdit}
        onSubmit={handleEdit}
        onDelete={() => void handleDeleteConfirm()}
      />
    </div>
  );
}
