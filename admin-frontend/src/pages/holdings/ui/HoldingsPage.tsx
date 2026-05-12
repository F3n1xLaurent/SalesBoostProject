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
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [dealerships, setDealerships] = useState<DealershipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [savingHolding, setSavingHolding] = useState(false);
  const [activeHolding, setActiveHolding] = useState<HoldingItem | null>(null);
  const [attachDealershipSearch, setAttachDealershipSearch] = useState('');

  async function loadData() {
    setLoading(true);
    setError(null);
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
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить структуру.');
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
    setActiveHolding(null);
    setCreateHoldingOpen(true);
  }

  function openEditHolding(item: HoldingItem) {
    setActiveHolding(item);
    setHoldingForm({
      name: item.name,
      type: item.type,
      isActive: item.isActive,
      dealershipIds: item.dealerships.map((dealership) => dealership.id),
    });
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
    setError(null);
    try {
      await createHolding({
        name: holdingForm.name,
        type: holdingForm.type,
        code: null,
        isActive: true,
        dealershipIds: [],
      });
      setCreateHoldingOpen(false);
      setNotice('Холдинг создан.');
      await loadData();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Не удалось создать холдинг.');
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
    setError(null);
    try {
      await updateHolding(activeHolding.id, {
        name: holdingForm.name,
        type: holdingForm.type,
        code: activeHolding.code || null,
        isActive: holdingForm.isActive,
        dealershipIds: holdingForm.dealershipIds,
      });
      setEditHoldingOpen(false);
      setNotice('Холдинг обновлён.');
      await loadData();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Не удалось обновить холдинг.');
    } finally {
      setSavingHolding(false);
    }
  }

  async function handleDeleteHoldingConfirm() {
    if (!activeHolding) return;
    setSavingHolding(true);
    setError(null);
    try {
      await deleteHolding(activeHolding.id);
      setDeleteHoldingOpen(false);
      setActiveHolding(null);
      setNotice('Холдинг удалён. Автосалоны отвязаны.');
      await loadData();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Не удалось удалить холдинг.');
    } finally {
      setSavingHolding(false);
    }
  }

  async function handleAttachDealership(holdingId: string, dealershipId: string) {
    const targetHolding = holdings.find((item) => item.id === holdingId) || activeHolding;
    if (!targetHolding) return;
    setSavingHolding(true);
    setError(null);
    try {
      await updateHolding(holdingId, {
        name: targetHolding.name,
        type: targetHolding.type,
        code: targetHolding.code || null,
        isActive: targetHolding.isActive,
        dealershipIds: [...targetHolding.dealerships.map((item) => item.id), dealershipId],
      });
      setAttachDealershipOpen(false);
      setNotice('Автосалон привязан к холдингу.');
      await loadData();
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : 'Не удалось привязать автосалон.');
    } finally {
      setSavingHolding(false);
    }
  }

  function renderHoldingForm(onSubmit: (event: React.FormEvent) => void, submitLabel: string, options?: { mode: 'create' | 'edit' }) {
    const mode = options?.mode ?? 'edit';
    const isCreate = mode === 'create';

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
          <label className="sa-filter-check">
            <input type="checkbox" checked={holdingForm.isActive} onChange={(event) => setHoldingForm((current) => ({ ...current, isActive: event.target.checked }))} />
            <span>Холдинг включен и пользуется системой</span>
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" className="sa-btn-outline" onClick={() => { setCreateHoldingOpen(false); setEditHoldingOpen(false); }}>Отмена</button>
          <button type="submit" className="sa-btn-primary" disabled={savingHolding}>
            {savingHolding ? 'Сохраняем...' : submitLabel}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 30 }}>Холдинги</h1>
            <div style={{ marginTop: 8, color: 'var(--sa-text-secondary)', maxWidth: 740 }}>
              Отдельный административный контур для управления оргструктурой. Холдинги группируют автосалоны, при этом часть автосалонов может существовать без холдинга.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="sa-btn-primary" onClick={openCreateHolding}>Новый холдинг</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: 'var(--sa-text-secondary)', fontSize: 13 }}>
          <span>Холдингов: {holdings.length}</span>
          <span>Автосалонов: {dealerships.length}</span>
          <span>Без холдинга: {unassignedDealerships.length}</span>
        </div>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(260px, 1.6fr) repeat(2, minmax(180px, 0.8fr)) auto' }}>
          <input
            className="sa-input"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Поиск по коду, холдингу или автосалону"
          />
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
        {notice && (
          <div style={{ padding: 12, borderRadius: 14, background: '#ecfdf5', color: '#047857', fontSize: 14 }}>
            {notice}
          </div>
        )}
        {error && (
          <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
            {error}
          </div>
        )}
      </section>

      {loading ? (
        <div className="sa-card" style={{ padding: 20 }}>Загрузка структуры...</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {holdings.map((item) => (
            <section key={item.id} className="sa-card" style={{ padding: 18, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <h2 style={{ margin: 0, fontSize: 22 }}>{item.name}</h2>
                    <span className="sa-metric-chip">{item.type === 'own' ? 'Собственный' : 'Франчайзинговый'}</span>
                    <span className="sa-metric-chip">{item.isActive ? 'Активен' : 'Выключен'}</span>
                    <span className="sa-metric-chip">{item.dealershipsCount} салонов</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="sa-btn-outline" onClick={() => openHoldingDealerships(item)}>Автосалоны</button>
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
              </div>
            </section>
          ))}

          {holdings.length === 0 && (
            <div className="sa-card" style={{ padding: 20 }}>
              По текущим фильтрам холдинги не найдены.
            </div>
          )}
        </div>
      )}

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
