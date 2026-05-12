import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createPhoneNumberType,
  fetchPhoneNumberTypes,
  updatePhoneNumberType,
  type PhoneNumberOwnership,
  type PhoneNumberTypeItem,
} from '../../../shared/api/adminPanel';

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
  dealership: 'Для автосалонов',
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
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название</span>
            <input className="sa-input" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Принадлежность</span>
            <select className="sa-select" value={form.ownership} onChange={(event) => setForm((current) => ({ ...current, ownership: event.target.value as PhoneNumberOwnership }))}>
              <option value="dealership">Для автосалонов</option>
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
  const [items, setItems] = useState<PhoneNumberTypeItem[]>([]);
  const [activeOwnership, setActiveOwnership] = useState<PhoneNumberOwnership>('dealership');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editType, setEditType] = useState<PhoneNumberTypeItem | null>(null);

  const filtered = useMemo(
    () => items.filter((item) => item.ownership === activeOwnership),
    [items, activeOwnership],
  );

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchPhoneNumberTypes());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить типы номеров.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleCreate(form: TypeFormState) {
    setSaving(true);
    setError(null);
    try {
      await createPhoneNumberType({ name: form.name.trim(), ownership: form.ownership, isActive: form.isActive });
      setCreateOpen(false);
      setNotice('Тип номера создан.');
      await loadData();
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
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Не удалось обновить тип номера.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h1 className="sa-page-title" style={{ marginBottom: 6 }}>Типы номеров</h1>
            <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>
              Справочник типов телефонных номеров для автосалонов и пользователей.
            </div>
          </div>
          <button type="button" className="sa-btn-primary" onClick={() => { setError(null); setCreateOpen(true); }}>
            Создать тип
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['dealership', 'user'] as PhoneNumberOwnership[]).map((ownership) => (
            <button
              key={ownership}
              type="button"
              className={activeOwnership === ownership ? 'sa-btn-primary' : 'sa-btn-outline'}
              onClick={() => setActiveOwnership(ownership)}
            >
              {OWNERSHIP_LABELS[ownership]}
            </button>
          ))}
        </div>

        {notice && <div style={{ padding: 12, borderRadius: 14, background: '#ecfdf5', color: '#047857', fontSize: 14 }}>{notice}</div>}
        {error && !createOpen && !editType && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>{error}</div>}
      </section>

      <section className="sa-card" style={{ padding: 20 }}>
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Принадлежность</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="sa-meta" style={{ padding: 28 }}>Загрузка...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={4} className="sa-meta" style={{ padding: 28 }}>Типов пока нет</td></tr>
              ) : filtered.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 700 }}>{item.name}</td>
                  <td>{OWNERSHIP_LABELS[item.ownership]}</td>
                  <td><span className={item.isActive ? 'sa-emp-status' : 'sa-emp-status sa-emp-warn'}>{item.isActive ? 'Активен' : 'Неактивен'}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => { setError(null); setEditType(item); }}>
                      Редактировать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <TypeModal
        open={createOpen}
        initial={{ ...EMPTY_FORM, ownership: activeOwnership }}
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
