import React, { useEffect, useMemo, useState } from 'react';
import {
  createHolding,
  deleteHolding,
  fetchDealerships,
  fetchHoldings,
  updateHolding,
  type DealershipItem,
  type HoldingItem,
  type HoldingType,
} from '../../../shared/api/adminPanel';
import { useToast } from '../../../shared/ui/toast/ToastProvider';

type HoldingFormState = {
  name: string;
  type: HoldingType;
  isActive: boolean;
  dealershipIds: string[];
};

const EMPTY_HOLDING_FORM: HoldingFormState = {
  name: '',
  type: 'own',
  isActive: true,
  dealershipIds: [],
};

function buildHoldingForm(item: HoldingItem): HoldingFormState {
  return {
    name: item.name,
    type: item.type,
    isActive: item.isActive,
    dealershipIds: item.dealerships.map((dealership) => dealership.id),
  };
}

function normalizeHoldingForm(form: HoldingFormState) {
  return {
    name: form.name.trim(),
    type: form.type,
    isActive: form.isActive,
    dealershipIds: [...form.dealershipIds].sort(),
  };
}

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

function ModalFrame(props: {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}) {
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
      <div style={overlayCardStyle(props.width)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{props.title}</h2>
            {props.subtitle && (
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--sa-text-secondary)' }}>{props.subtitle}</div>
            )}
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function HoldingsPage() {
  const { showToast } = useToast();
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [dealerships, setDealerships] = useState<DealershipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [holdingTypeFilter, setHoldingTypeFilter] = useState<'all' | HoldingType>('all');
  const [holdingStatusFilter, setHoldingStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const [createHoldingOpen, setCreateHoldingOpen] = useState(false);
  const [editHoldingOpen, setEditHoldingOpen] = useState(false);
  const [deleteHoldingOpen, setDeleteHoldingOpen] = useState(false);
  const [holdingDealershipsOpen, setHoldingDealershipsOpen] = useState(false);
  const [attachDealershipOpen, setAttachDealershipOpen] = useState(false);

  const [holdingForm, setHoldingForm] = useState<HoldingFormState>(EMPTY_HOLDING_FORM);
  const [initialHoldingForm, setInitialHoldingForm] = useState<HoldingFormState>(EMPTY_HOLDING_FORM);
  const [savingHolding, setSavingHolding] = useState(false);
  const [activeHolding, setActiveHolding] = useState<HoldingItem | null>(null);
  const [attachDealershipSearch, setAttachDealershipSearch] = useState('');

  async function loadData() {
    setLoading(true);
    try {
      const [nextHoldings, nextDealerships] = await Promise.all([
        fetchHoldings({
          search: debouncedSearch,
          type: holdingTypeFilter,
          status: holdingStatusFilter,
        }),
        fetchDealerships(),
      ]);
      setHoldings(nextHoldings);
      setDealerships(nextDealerships);
      setActiveHolding((current) => (current ? nextHoldings.find((item) => item.id === current.id) || null : current));
      return { nextHoldings, nextDealerships };
    } catch (loadError) {
      showToast({
        type: 'error',
        title: 'Не удалось загрузить структуру',
        description: loadError instanceof Error ? loadError.message : 'Попробуйте повторить действие.',
      });
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    loadData().catch(() => undefined);
  }, [debouncedSearch, holdingStatusFilter, holdingTypeFilter]);

  const unassignedDealerships = useMemo(
    () => dealerships.filter((item) => !item.holdingId),
    [dealerships],
  );

  function openCreateHolding() {
    setHoldingForm(EMPTY_HOLDING_FORM);
    setInitialHoldingForm(EMPTY_HOLDING_FORM);
    setActiveHolding(null);
    setCreateHoldingOpen(true);
  }

  function openEditHolding(item: HoldingItem) {
    const nextForm = buildHoldingForm(item);
    setActiveHolding(item);
    setHoldingForm(nextForm);
    setInitialHoldingForm(nextForm);
    setEditHoldingOpen(true);
  }

  function openHoldingDealerships(item: HoldingItem) {
    setActiveHolding(item);
    setHoldingDealershipsOpen(true);
    setAttachDealershipOpen(false);
  }

  function openAttachDealerships(item: HoldingItem) {
    setActiveHolding(item);
    setAttachDealershipSearch('');
    setAttachDealershipOpen(true);
  }

  async function handleCreateHoldingSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSavingHolding(true);
    try {
      await createHolding({
        name: holdingForm.name,
        type: holdingForm.type,
        code: null,
        isActive: true,
        dealershipIds: [],
      });
      setCreateHoldingOpen(false);
      showToast({ type: 'success', title: 'Холдинг создан', description: holdingForm.name });
      await loadData();
    } catch (submitError) {
      showToast({
        type: 'error',
        title: 'Не удалось создать холдинг',
        description: submitError instanceof Error ? submitError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSavingHolding(false);
    }
  }

  const filteredAttachDealerships = useMemo(() => {
    const query = attachDealershipSearch.trim().toLowerCase();
    const items = unassignedDealerships.filter((item) => {
      if (!query) return true;
      const haystack = [item.name, item.city || '', item.address || '', item.code || ''].join(' ').toLowerCase();
      return haystack.includes(query);
    });
    return items.slice(0, 5);
  }, [attachDealershipSearch, unassignedDealerships]);

  async function handleEditHoldingSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!activeHolding) return;
    setSavingHolding(true);
    try {
      await updateHolding(activeHolding.id, {
        name: holdingForm.name,
        type: holdingForm.type,
        code: activeHolding.code || null,
        isActive: holdingForm.isActive,
        dealershipIds: holdingForm.dealershipIds,
      });
      setEditHoldingOpen(false);
      showToast({ type: 'success', title: 'Холдинг сохранён', description: holdingForm.name });
      await loadData();
    } catch (submitError) {
      showToast({
        type: 'error',
        title: 'Не удалось обновить холдинг',
        description: submitError instanceof Error ? submitError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSavingHolding(false);
    }
  }

  async function handleDeleteHoldingConfirm() {
    if (!activeHolding) return;
    setSavingHolding(true);
    try {
      await deleteHolding(activeHolding.id);
      setDeleteHoldingOpen(false);
      setActiveHolding(null);
      showToast({ type: 'success', title: 'Холдинг удалён', description: 'Автосалоны отвязаны.' });
      await loadData();
    } catch (submitError) {
      showToast({
        type: 'error',
        title: 'Не удалось удалить холдинг',
        description: submitError instanceof Error ? submitError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSavingHolding(false);
    }
  }

  async function handleAttachDealership(holdingId: string, dealershipId: string) {
    const targetHolding = holdings.find((item) => item.id === holdingId) || activeHolding;
    if (!targetHolding) return;
    setSavingHolding(true);
    try {
      await updateHolding(holdingId, {
        name: targetHolding.name,
        type: targetHolding.type,
        code: targetHolding.code || null,
        isActive: targetHolding.isActive,
        dealershipIds: [...targetHolding.dealerships.map((item) => item.id), dealershipId],
      });
      setAttachDealershipOpen(false);
      showToast({ type: 'success', title: 'Автосалон привязан к холдингу' });
      await loadData();
    } catch (attachError) {
      showToast({
        type: 'error',
        title: 'Не удалось привязать автосалон',
        description: attachError instanceof Error ? attachError.message : 'Попробуйте повторить действие.',
      });
    } finally {
      setSavingHolding(false);
    }
  }

  function renderHoldingForm(onSubmit: (event: React.FormEvent) => void, submitLabel: string, options?: { mode: 'create' | 'edit' }) {
    const mode = options?.mode ?? 'edit';
    const isCreate = mode === 'create';
    const isDirty = JSON.stringify(normalizeHoldingForm(holdingForm)) !== JSON.stringify(normalizeHoldingForm(initialHoldingForm));
    const isSubmitDisabled = savingHolding || (!isCreate && !isDirty);

    return (
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 16 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span>Название</span>
          <input className="sa-input" value={holdingForm.name} onChange={(event) => setHoldingForm((current) => ({ ...current, name: event.target.value }))} required />
        </label>
        <fieldset style={{ display: 'grid', gap: 8, border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 4 }}>Тип холдинга</legend>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={holdingForm.type === 'own' ? 'sa-btn-primary' : 'sa-btn-outline'}
              onClick={() => setHoldingForm((current) => ({ ...current, type: 'own' }))}
            >
              Собственный
            </button>
            <button
              type="button"
              className={holdingForm.type === 'franchised' ? 'sa-btn-primary' : 'sa-btn-outline'}
              onClick={() => setHoldingForm((current) => ({ ...current, type: 'franchised' }))}
            >
              Франчайзинговый
            </button>
          </div>
        </fieldset>
        {!isCreate && (
          <button
            type="button"
            className="sa-toggle-field"
            aria-pressed={holdingForm.isActive}
            onClick={() => setHoldingForm((current) => ({ ...current, isActive: !current.isActive }))}
          >
            <span className="sa-toggle-field__text">Холдинг включен и пользуется системой</span>
            <span className="sa-toggle-field__control" aria-hidden="true">
              <span className="sa-toggle-field__thumb" />
            </span>
          </button>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" className="sa-btn-outline" onClick={() => { setCreateHoldingOpen(false); setEditHoldingOpen(false); }}>Отмена</button>
          <button type="submit" className="sa-btn-primary" disabled={isSubmitDisabled}>
            {savingHolding ? 'Сохраняем...' : submitLabel}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div>
      <h1 className="sa-page-title">Холдинги</h1>
      <p className="sa-page-subtitle">
        Отдельный административный контур для управления оргструктурой и связями автосалонов.
      </p>

      <div className="sa-toolbar">
        <div className="sa-toolbar-row">
          <div className="sa-search-wrap">
            <svg className="sa-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              className="sa-search-input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Поиск по холдингу или автосалону…"
            />
          </div>
          <select className="sa-select" value={holdingTypeFilter} onChange={(event) => setHoldingTypeFilter(event.target.value as 'all' | HoldingType)}>
            <option value="all">Тип холдинга: все</option>
            <option value="own">Собственный</option>
            <option value="franchised">Франчайзинговый</option>
          </select>
          <select className="sa-select" value={holdingStatusFilter} onChange={(event) => setHoldingStatusFilter(event.target.value as 'all' | 'active' | 'inactive')}>
            <option value="all">Статус: все</option>
            <option value="active">Активный</option>
            <option value="inactive">Деактивированный</option>
          </select>
          <button type="button" className="sa-btn-primary" onClick={openCreateHolding}>Новый холдинг</button>
          <button
            type="button"
            className="sa-btn-outline"
            onClick={() => {
              setSearchInput('');
              setDebouncedSearch('');
              setHoldingTypeFilter('all');
              setHoldingStatusFilter('all');
            }}
          >
            Сбросить
          </button>
        </div>
        <div className="sa-toolbar-chips">
          <span className="sa-chip">Холдингов: {holdings.length}</span>
          <span className="sa-chip">Автосалонов: {dealerships.length}</span>
          <span className="sa-chip">Без холдинга: {unassignedDealerships.length}</span>
        </div>
      </div>

      <div className="sa-companies-table-wrap sa-desktop-only">
        <table className="sa-table sa-table-sortable">
          <thead>
            <tr>
              <th>Холдинг</th>
              <th>Тип</th>
              <th className="sa-text-right">Автосалоны</th>
              <th>Статус</th>
              <th style={{ width: 148 }}>Действия</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="sa-meta" style={{ padding: 32 }}>Загрузка структуры...</td></tr>
            ) : holdings.length === 0 ? (
              <tr><td colSpan={6} className="sa-meta" style={{ padding: 32 }}>По текущим фильтрам холдинги не найдены.</td></tr>
            ) : (
              holdings.map((item) => (
                <tr
                  key={item.id}
                  className="sa-row-clickable"
                  onClick={() => openHoldingDealerships(item)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => event.key === 'Enter' && openHoldingDealerships(item)}
                >
                  <td>
                    <div className="sa-cell-name">{item.name}</div>
                    <div className="sa-cell-city">{item.code || 'Код не указан'}</div>
                  </td>
                  <td>{item.type === 'own' ? 'Собственный' : 'Франчайзинговый'}</td>
                  <td className="sa-text-right">{item.dealershipsCount}</td>
                  <td>
                    <span className={`sa-status-badge ${item.isActive ? 'sa-status-norm' : 'sa-status-no-data'}`}>
                      {item.isActive ? 'Активен' : 'Выключен'}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 8 }} onClick={(event) => event.stopPropagation()}>
                      <button type="button" className="sa-btn-outline sa-btn-icon" onClick={() => openEditHolding(item)} aria-label="Редактировать холдинг" title="Редактировать">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
                        </svg>
                      </button>
                      <button type="button" className="sa-btn-danger sa-btn-icon" onClick={() => { setActiveHolding(item); setDeleteHoldingOpen(true); }} aria-label="Удалить холдинг" title="Удалить">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </div>
                  </td>
                  <td className="sa-row-chevron-cell">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="sa-mobile-only">
        {loading ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка структуры...</div>
        ) : holdings.length === 0 ? (
          <div className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>По текущим фильтрам холдинги не найдены.</div>
        ) : (
          holdings.map((item) => (
            <div
              key={item.id}
              className="sa-mobile-row"
              onClick={() => openHoldingDealerships(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => event.key === 'Enter' && openHoldingDealerships(item)}
            >
              <div className="sa-mobile-row-header">
                <div>
                  <div className="sa-cell-name">{item.name}</div>
                  <div className="sa-cell-city">{item.code || 'Код не указан'}</div>
                </div>
                <span className={`sa-status-badge ${item.isActive ? 'sa-status-norm' : 'sa-status-no-data'}`}>
                  {item.isActive ? 'Активен' : 'Выключен'}
                </span>
              </div>
              <div className="sa-mobile-chips">
                <span className="sa-metric-chip">{item.type === 'own' ? 'Собственный' : 'Франчайзинговый'}</span>
                <span className="sa-metric-chip">{item.dealershipsCount} салонов</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }} onClick={(event) => event.stopPropagation()}>
                <button type="button" className="sa-btn-outline" onClick={() => openEditHolding(item)}>Редактировать</button>
                <button type="button" className="sa-btn-danger" onClick={() => { setActiveHolding(item); setDeleteHoldingOpen(true); }}>Удалить</button>
              </div>
            </div>
          ))
        )}
      </div>

      <ModalFrame title="Новый холдинг" subtitle="Создание холдинга, к которому после можно привязать автосалоны" open={createHoldingOpen} onClose={() => setCreateHoldingOpen(false)}>
        {renderHoldingForm(handleCreateHoldingSubmit, 'Создать холдинг', { mode: 'create' })}
      </ModalFrame>

      <ModalFrame title="Редактировать холдинг" subtitle="Можно поменять состав автосалонов внутри холдинга." open={editHoldingOpen && !!activeHolding} onClose={() => setEditHoldingOpen(false)}>
        {renderHoldingForm(handleEditHoldingSubmit, 'Сохранить холдинг', { mode: 'edit' })}
      </ModalFrame>

      <ModalFrame title={activeHolding ? `Автосалоны холдинга ${activeHolding.name}` : 'Автосалоны холдинга'} open={holdingDealershipsOpen && !!activeHolding} onClose={() => setHoldingDealershipsOpen(false)}>
        {activeHolding && (
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13 }}>
                Здесь отображаются все автосалоны, привязанные к холдингу.
              </div>
              <button type="button" className="sa-btn-primary" onClick={() => openAttachDealerships(activeHolding)}>+</button>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {activeHolding.dealerships.length === 0 ? (
                <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Пока нет привязанных автосалонов.</div>
              ) : activeHolding.dealerships.map((dealership) => (
                <div key={dealership.id} className="sa-card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{dealership.name}</div>
                    <div style={{ fontSize: 13, color: 'var(--sa-text-secondary)' }}>
                      {dealership.city || '—'} · {dealership.address || 'Адрес не указан'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </ModalFrame>

      <ModalFrame title={activeHolding ? `Привязать автосалоны к ${activeHolding.name}` : 'Привязать автосалоны'} open={attachDealershipOpen && !!activeHolding} onClose={() => setAttachDealershipOpen(false)}>
        {activeHolding && (
          <div style={{ display: 'grid', gap: 12 }}>
            <input
              className="sa-input"
              value={attachDealershipSearch}
              onChange={(event) => setAttachDealershipSearch(event.target.value)}
              placeholder="Поиск по названию, городу, адресу или коду"
            />
            {unassignedDealerships.length === 0 ? (
              <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Нет доступных для привязки автосалонов.</div>
            ) : filteredAttachDealerships.length === 0 ? (
              <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Ничего не найдено.</div>
            ) : filteredAttachDealerships.map((item) => (
              <div key={item.id} className="sa-card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{item.name}</div>
                  <div style={{ fontSize: 13, color: 'var(--sa-text-secondary)' }}>
                    {item.city || '—'} · {item.address || 'Адрес не указан'}
                  </div>
                </div>
                <button type="button" className="sa-btn-primary" onClick={() => void handleAttachDealership(activeHolding.id, item.id)} disabled={savingHolding}>
                  Привязать
                </button>
              </div>
            ))}
          </div>
        )}
      </ModalFrame>

      <ModalFrame title="Удалить холдинг" subtitle="Автосалоны сохранятся и станут независимыми." open={deleteHoldingOpen && !!activeHolding} onClose={() => setDeleteHoldingOpen(false)} width={520}>
        {activeHolding && (
          <div style={{ display: 'grid', gap: 16 }}>
            <p style={{ margin: 0 }}>
              Удалить холдинг <strong>{activeHolding.name}</strong>?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="sa-btn-outline" onClick={() => setDeleteHoldingOpen(false)}>Отмена</button>
              <button type="button" className="sa-btn-danger" onClick={handleDeleteHoldingConfirm} disabled={savingHolding}>
                {savingHolding ? 'Удаляем...' : 'Удалить'}
              </button>
            </div>
          </div>
        )}
      </ModalFrame>

    </div>
  );
}
