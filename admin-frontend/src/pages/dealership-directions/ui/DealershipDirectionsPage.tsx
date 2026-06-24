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
  initial: DirectionFormState;
  holdings: HoldingItem[];
  title: string;
  submitLabel: string;
  saving: boolean;
  error: string | null;
  requireChanges?: boolean;
  lockHolding?: boolean;
  onClose: () => void;
  onSubmit: (form: DirectionFormState) => void;
}) {
  const [form, setForm] = useState<DirectionFormState>(props.initial);
  const wasOpenRef = useRef(false);
  const isDirty = useMemo(
    () => JSON.stringify(normalizeForm(form)) !== JSON.stringify(normalizeForm(props.initial)),
    [form, props.initial],
  );

  useEffect(() => {
    if (props.open && !wasOpenRef.current) setForm(props.initial);
    wasOpenRef.current = props.open;
  }, [props.open, props.initial]);

  if (!props.open) return null;

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
      onClick={props.onClose}
    >
      <div style={overlayCardStyle()} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={props.title}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{props.title}</h2>
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
              disabled={props.lockHolding}
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

          <label className="sa-filter-check">
            <input type="checkbox" checked={form.isActive} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))} />
            <span>Направление активно</span>
          </label>

          {props.error && (
            <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
              {props.error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="sa-btn-outline" onClick={props.onClose}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={props.saving || !form.holdingId || !form.name.trim() || (!!props.requireChanges && !isDirty)}>
              {props.saving ? 'Сохраняем...' : props.submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
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
      setNotice('Направление обновлено.');
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Не удалось обновить направление точки.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: DealershipDirectionItem) {
    const confirmed = window.confirm(`Удалить направление "${item.name}"? Оно будет снято со всех точек этой компании.`);
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      await deleteDealershipDirection(item.id);
      setNotice('Направление удалено.');
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить направление точки.');
    } finally {
      setSaving(false);
    }
  }

  const createInitial = useMemo<DirectionFormState>(() => ({
    ...EMPTY_FORM,
    holdingId: selectedHoldingId,
  }), [selectedHoldingId]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h1 className="sa-page-title" style={{ marginBottom: 6 }}>Направления точек</h1>
            <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>
              Управляйте направлениями, которые доступны точкам внутри каждой компании.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <select
              className="sa-select"
              value={selectedHoldingId}
              onChange={(event) => {
                setSelectedHoldingId(event.target.value);
                setNotice(null);
              }}
              style={{ minWidth: 220 }}
              disabled={loading || holdings.length === 0}
              title="Глобальный фильтр по компаниям"
            >
              {holdings.length === 0 ? <option value="">Нет компаний</option> : null}
              {holdings.map((holding) => (
                <option key={holding.id} value={holding.id}>{holding.name}</option>
              ))}
            </select>
            <button type="button" className="sa-btn-primary" disabled={!selectedHoldingId} onClick={() => { setError(null); setCreateOpen(true); }}>
              Создать направление
            </button>
          </div>
        </div>

        {notice && <div style={{ padding: 12, borderRadius: 14, background: '#ecfdf5', color: '#047857', fontSize: 14 }}>{notice}</div>}
        {error && !createOpen && !editItem && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>{error}</div>}
      </section>

      <section className="sa-card" style={{ padding: 20 }}>
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={3} className="sa-meta" style={{ padding: 28 }}>Загрузка...</td></tr>
              ) : holdings.length === 0 ? (
                <tr><td colSpan={3} className="sa-meta" style={{ padding: 28 }}>Перед тем, как создавать направления точек, пожалуйста, добавьте компанию.</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={3} className="sa-meta" style={{ padding: 28 }}>Направлений пока нет</td></tr>
              ) : filtered.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 700 }}>{item.name}</td>
                  <td><span className={item.isActive ? 'sa-emp-status' : 'sa-emp-status sa-emp-warn'}>{item.isActive ? 'Активно' : 'Неактивно'}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => { setError(null); setEditItem(item); }}>
                        Редактировать
                      </button>
                      <button type="button" className="sa-btn-danger sa-btn-sm" disabled={saving} onClick={() => void handleDelete(item)}>
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <DirectionModal
        open={createOpen}
        initial={createInitial}
        holdings={holdings}
        title="Создать направление"
        submitLabel="Создать"
        saving={saving}
        error={createOpen ? error : null}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
      />

      <DirectionModal
        open={!!editItem}
        initial={editItem ? {
          holdingId: editItem.holdingId,
          name: editItem.name,
          code: editItem.code || '',
          isActive: editItem.isActive,
        } : EMPTY_FORM}
        holdings={holdings}
        title="Редактировать направление"
        submitLabel="Сохранить изменения"
        saving={saving}
        error={editItem ? error : null}
        requireChanges
        lockHolding
        onClose={() => setEditItem(null)}
        onSubmit={handleEdit}
      />
    </div>
  );
}
