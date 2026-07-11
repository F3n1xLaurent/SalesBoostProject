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
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { FixedOverlayPortal } from '../../../shared/ui/fixed-overlay-portal/FixedOverlayPortal';

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

function normalizeForm(form: DirectionFormState): DirectionFormState {
  return {
    holdingId: form.holdingId,
    name: form.name.trim(),
    code: form.code.trim(),
    isActive: form.isActive,
  };
}

function overlayCardStyle(width = 560): React.CSSProperties {
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
  const wasOpenRef = useRef(false);
  const isCreate = props.mode === 'create';
  const isDirty = useMemo(
    () => JSON.stringify(normalizeForm(form)) !== JSON.stringify(normalizeForm(props.initial)),
    [form, props.initial],
  );

  useEffect(() => {
    if (props.open && !wasOpenRef.current) setForm(props.initial);
    wasOpenRef.current = props.open;
  }, [props.open, props.initial]);

  if (!props.open) return null;

  const title = isCreate ? 'Создать направление' : 'Редактировать направление';
  const submitLabel = isCreate ? 'Создать' : 'Сохранить изменения';

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
      onClick={props.onClose}
    >
      <div style={overlayCardStyle()} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{title}</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>
              Направление доступно только точкам выбранной компании.
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
            props.onSubmit(form);
          }}
          style={{ display: 'grid', gap: 14 }}
        >
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Компания</span>
            <select
              className="sa-select"
              value={form.holdingId}
              disabled={!isCreate}
              onChange={(event) => setForm((current) => ({ ...current, holdingId: event.target.value }))}
              required
            >
              <option value="">Выберите компанию</option>
              {props.holdings.map((holding) => (
                <option key={holding.id} value={holding.id}>{holding.name}</option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название</span>
            <input className="sa-input" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
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

          <div className={`sa-holdings-form-footer${isCreate ? ' sa-holdings-form-footer--create' : ''}`}>
            {!isCreate && (
              <div className="sa-holdings-form-footer-left">
                {props.deleteConfirm ? (
                  <>
                    <span className="sa-holdings-form-delete-hint">
                      Удалить <strong>{props.itemName}</strong>?
                    </span>
                    <button type="button" className="sa-btn-danger" onClick={props.onDelete} disabled={props.saving}>
                      {props.saving ? 'Удаляем...' : 'Удалить'}
                    </button>
                    <button type="button" className="sa-btn-outline" onClick={() => props.onDeleteConfirmChange?.(false)} disabled={props.saving}>
                      Нет
                    </button>
                  </>
                ) : (
                  <button type="button" className="sa-btn-danger" onClick={() => props.onDeleteConfirmChange?.(true)}>
                    Удалить направление
                  </button>
                )}
              </div>
            )}
            <div className="sa-holdings-form-footer-right">
              <button type="button" className="sa-btn-outline" onClick={props.onClose}>Отмена</button>
              <button
                type="submit"
                className="sa-btn-primary"
                disabled={props.saving || !form.holdingId || !form.name.trim() || (!isCreate && !isDirty)}
              >
                {props.saving ? 'Сохраняем...' : submitLabel}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
    </FixedOverlayPortal>
  );
}

export function DealershipDirectionsPage() {
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [items, setItems] = useState<DealershipDirectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      setNotice('Направление создано.');
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
      setNotice('Направление обновлено.');
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
      setNotice('Направление удалено.');
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

      {notice && (
        <div className="sa-batch-live-note" style={{ marginBottom: 12 }}>{notice}</div>
      )}
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
              setNotice(null);
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
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                    </svg>
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
