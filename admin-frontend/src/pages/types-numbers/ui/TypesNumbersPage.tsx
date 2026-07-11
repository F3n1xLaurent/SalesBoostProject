import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createPhoneNumberType,
  fetchPhoneNumberTypes,
  fetchHoldings,
  updatePhoneNumberType,
  type HoldingItem,
  type PhoneNumberOwnership,
  type PhoneNumberTypeItem,
} from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { FixedOverlayPortal } from '../../../shared/ui/fixed-overlay-portal/FixedOverlayPortal';

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

const OWNERSHIP_LABELS: Record<PhoneNumberOwnership, string> = {
  dealership: 'Для точек',
  user: 'Для пользователей',
};

function overlayCardStyle(width = 520): React.CSSProperties {
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

function TypeModal(props: {
  open: boolean;
  initial: TypeFormState;
  holdingName?: string | null;
  title: string;
  submitLabel: string;
  saving: boolean;
  error: string | null;
  requireChanges?: boolean;
  onClose: () => void;
  onSubmit: (form: TypeFormState) => void;
}) {
  const [form, setForm] = useState<TypeFormState>(props.initial);
  const wasOpenRef = useRef(false);
  const isDirty = useMemo(
    () => JSON.stringify(normalizeTypeForm(form)) !== JSON.stringify(normalizeTypeForm(props.initial)),
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
        zIndex: 120,
      }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle()} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={props.title}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{props.title}</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>
              Тип задаёт назначение номера и доступен при добавлении телефонов.
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
          {props.holdingName && (
            <div className="sa-meta" style={{ padding: '10px 12px', borderRadius: 8, background: '#F8FAFC' }}>
              Компания: {props.holdingName}
            </div>
          )}

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название</span>
            <input className="sa-input" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Принадлежность</span>
            <select className="sa-select" value={form.ownership} onChange={(event) => setForm((current) => ({ ...current, ownership: event.target.value as PhoneNumberOwnership }))}>
              <option value="dealership">Для точек</option>
              <option value="user">Для пользователей</option>
            </select>
          </label>

          <label className="sa-filter-check">
            <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))} />
            <span>Тип активен</span>
          </label>

          {props.error && (
            <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
              {props.error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="sa-btn-outline" onClick={props.onClose}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={props.saving || !form.name.trim() || (!!props.requireChanges && !isDirty)}>
              {props.saving ? 'Сохраняем...' : props.submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
    </FixedOverlayPortal>
  );
}

function normalizeTypeForm(form: TypeFormState): TypeFormState {
  return {
    name: form.name.trim(),
    ownership: form.ownership,
    isActive: form.isActive,
  };
}

export function TypesNumbersPage() {
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [items, setItems] = useState<PhoneNumberTypeItem[]>([]);
  const [activeOwnership, setActiveOwnership] = useState<PhoneNumberOwnership>('dealership');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editType, setEditType] = useState<PhoneNumberTypeItem | null>(null);
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
      setError('Перед тем, как создавать типы номеров, пожалуйста, добавьте компанию.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createPhoneNumberType({ holdingId: selectedHoldingId, name: form.name.trim(), ownership: form.ownership, isActive: form.isActive });
      setCreateOpen(false);
      setNotice('Тип номера создан.');
      await loadData(selectedHoldingId);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Не удалось создать тип номера.');
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(form: TypeFormState) {
    if (!editType) return;
    setSaving(true);
    setError(null);
    try {
      await updatePhoneNumberType(editType.id, { name: form.name.trim(), ownership: form.ownership, isActive: form.isActive });
      setEditType(null);
      setNotice('Тип номера обновлён.');
      await loadData(selectedHoldingId);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Не удалось обновить тип номера.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 className="sa-page-title">Типы номеров</h1>

      {notice && (
        <div className="sa-batch-live-note" style={{ marginBottom: 12 }}>{notice}</div>
      )}
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
              setNotice(null);
            }}
            disabled={holdingsLoading || holdings.length === 0}
            loading={holdingsLoading}
          />
        </div>
        <div className="sa-toolbar-actions">
          <button type="button" className="sa-btn-brutal-3d" disabled={!selectedHoldingId} onClick={() => { setError(null); setCreateOpen(true); }}>
            <LetsIcon name="add-light" size={16} bold />
            Создать номер
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
        <table className="sa-table sa-holdings-table">
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
                  <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => { setError(null); setEditType(item); }}>
                    Редактировать
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TypeModal
        open={createOpen}
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
        initial={editType ? { name: editType.name, ownership: editType.ownership, isActive: editType.isActive } : EMPTY_FORM}
        holdingName={selectedHolding?.name || null}
        title="Редактировать тип номера"
        submitLabel="Сохранить изменения"
        saving={saving}
        error={editType ? error : null}
        requireChanges
        onClose={() => setEditType(null)}
        onSubmit={handleEdit}
      />
    </div>
  );
}
