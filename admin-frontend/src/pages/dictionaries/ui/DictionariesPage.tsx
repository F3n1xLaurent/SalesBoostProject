import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { createCity, fetchCities, updateCity } from '../../../shared/api/adminPanel';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { EditIcon } from '../../../shared/ui/icons/ActionIcons';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { useToast } from '../../../shared/ui/toast/ToastProvider';
import { DemoCallSettings, type DemoDictionaryTab } from './DemoCallSettings';
import './dictionaries.css';

const CITY_PAGE_SIZE = 100;
const CITY_ROW_HEIGHT = 52;
const CITY_LIST_HEIGHT = 520;
const CITY_LIST_OVERSCAN = 6;
const CREATE_CITY_FORM_ID = 'create-dictionary-city-form';
type DictionaryTab = 'cities' | DemoDictionaryTab;
const DICTIONARY_TABS: Array<{ value: DictionaryTab; label: string }> = [
  { value: 'cities', label: 'Города' },
  { value: 'demo-voices', label: 'Голоса (Демо)' },
  { value: 'demo-profile', label: 'Профиль клиента (Демо)' },
  { value: 'demo-script', label: 'Скрипт (Демо)' },
];

function mergeUniqueCities(current: string[], next: string[]): string[] {
  const seen = new Set(current);
  return [...current, ...next.filter((city) => !seen.has(city))];
}

export function DictionariesPage() {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const listRef = useRef<HTMLDivElement>(null);
  const requestGenerationRef = useRef(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingCity, setEditingCity] = useState<string | null>(null);
  const [newCityName, setNewCityName] = useState('');
  const [createAttempted, setCreateAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    setLoading(true);
    setLoadingMore(false);
    setLoadError(null);
    setCities([]);
    setHasMore(true);
    setScrollTop(0);
    listRef.current?.scrollTo({ top: 0 });

    fetchCities({ search: debouncedSearch, limit: CITY_PAGE_SIZE, offset: 0 })
      .then((result) => {
        if (cancelled || generation !== requestGenerationRef.current) return;
        setCities(result.items);
        setHasMore(result.hasMore);
      })
      .catch((error) => {
        if (cancelled || generation !== requestGenerationRef.current) return;
        setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить города.');
        setHasMore(false);
      })
      .finally(() => {
        if (!cancelled && generation === requestGenerationRef.current) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, reloadToken]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;
    const generation = requestGenerationRef.current;
    const offset = cities.length;
    setLoadingMore(true);
    try {
      const result = await fetchCities({ search: debouncedSearch, limit: CITY_PAGE_SIZE, offset });
      if (generation !== requestGenerationRef.current) return;
      setCities((current) => current.length === offset ? mergeUniqueCities(current, result.items) : current);
      setHasMore(result.hasMore);
    } catch (error) {
      if (generation === requestGenerationRef.current) {
        setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить следующую часть списка.');
        setHasMore(false);
      }
    } finally {
      if (generation === requestGenerationRef.current) setLoadingMore(false);
    }
  }, [cities.length, debouncedSearch, hasMore, loading, loadingMore]);

  const virtualRows = useMemo(() => {
    const firstIndex = Math.max(0, Math.floor(scrollTop / CITY_ROW_HEIGHT) - CITY_LIST_OVERSCAN);
    const visibleCount = Math.ceil(CITY_LIST_HEIGHT / CITY_ROW_HEIGHT) + CITY_LIST_OVERSCAN * 2;
    const lastIndex = Math.min(cities.length, firstIndex + visibleCount);
    return cities.slice(firstIndex, lastIndex).map((city, index) => ({
      city,
      index: firstIndex + index,
    }));
  }, [cities, scrollTop]);

  function handleListScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - CITY_ROW_HEIGHT * 8) {
      void loadMore();
    }
  }

  function openCreateCity() {
    setEditingCity(null);
    setNewCityName('');
    setCreateAttempted(false);
    setCreateError(null);
    setCreateOpen(true);
  }

  function openEditCity(city: string) {
    setCreateOpen(false);
    setEditingCity(city);
    setNewCityName(city);
    setCreateAttempted(false);
    setCreateError(null);
  }

  function closeCreateCity() {
    if (creating) return;
    setCreateOpen(false);
    setEditingCity(null);
  }

  async function handleSaveCity(event: React.FormEvent) {
    event.preventDefault();
    setCreateAttempted(true);
    const name = newCityName.trim();
    if (!name) return;

    setCreating(true);
    setCreateError(null);
    try {
      const savedName = editingCity
        ? await updateCity(editingCity, name)
        : await createCity(name);
      setCreateOpen(false);
      setEditingCity(null);
      setNewCityName('');
      showToast({
        type: 'success',
        title: editingCity ? 'Город переименован' : 'Город добавлен',
        description: savedName,
      });
      setReloadToken((value) => value + 1);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Не удалось добавить город.');
    } finally {
      setCreating(false);
    }
  }

  const nameInvalid = createAttempted && !newCityName.trim();
  const cityModalOpen = createOpen || editingCity !== null;
  const cityNameUnchanged = editingCity !== null && newCityName.trim() === editingCity;
  const listHeight = cities.length * CITY_ROW_HEIGHT;
  const requestedTab = searchParams.get('tab') as DictionaryTab | null;
  const activeTab = DICTIONARY_TABS.some((tab) => tab.value === requestedTab) ? requestedTab! : 'cities';

  function selectTab(tab: DictionaryTab) {
    const next = new URLSearchParams(searchParams);
    if (tab === 'cities') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next, { replace: true });
  }

  return (
    <div className="dictionaries-page">
      <header className="dictionaries-page__header">
        <div>
          <h1 className="sa-page-title">Справочники</h1>
          <p className="sa-meta">Системные справочные данные платформы. Доступны только суперадминистратору.</p>
        </div>
      </header>

      <div className="sa-dialog-tabs" role="tablist" aria-label="Справочники">
        {DICTIONARY_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.value}
            className={`sa-dialog-tab${activeTab === tab.value ? ' sa-dialog-tab-active' : ''}`}
            onClick={() => selectTab(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'cities' ? <><section className="dictionaries-card">
        <div className="dictionaries-toolbar">
          <label className="dictionaries-search">
            <span className="dictionaries-search__icon" aria-hidden><LetsIcon name="search" size={18} /></span>
            <input
              type="search"
              value={search}
              placeholder="Поиск по названию города"
              aria-label="Поиск по названию города"
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button type="button" aria-label="Очистить поиск" onClick={() => setSearch('')}>
                <LetsIcon name="close-round" size={17} />
              </button>
            )}
          </label>
          <button type="button" className="sa-btn-primary dictionaries-add-button" onClick={openCreateCity}>
            <LetsIcon name="add-round" size={18} />
            Добавить город
          </button>
        </div>

        <div className="dictionaries-list-heading">
          <span>Название</span>
          <span>{loading ? 'Загрузка…' : `Загружено: ${cities.length}`}</span>
        </div>

        {loadError && (
          <div className="dictionaries-notice dictionaries-notice--error">
            <span>{loadError}</span>
            <button type="button" onClick={() => setReloadToken((value) => value + 1)}>Повторить</button>
          </div>
        )}

        {loading && cities.length === 0 ? (
          <div className="dictionaries-empty">Загружаем города…</div>
        ) : loadError && cities.length === 0 ? null : cities.length === 0 ? (
          <div className="dictionaries-empty">{debouncedSearch ? 'По вашему запросу города не найдены.' : 'Справочник городов пуст.'}</div>
        ) : (
          <div
            ref={listRef}
            className="dictionaries-virtual-list"
            style={{ height: CITY_LIST_HEIGHT }}
            role="list"
            aria-label="Список городов"
            onScroll={handleListScroll}
          >
            <div className="dictionaries-virtual-list__spacer" style={{ height: listHeight }}>
              {virtualRows.map(({ city, index }) => (
                <div
                  key={city}
                  className="dictionaries-city-row"
                  style={{ height: CITY_ROW_HEIGHT, transform: `translateY(${index * CITY_ROW_HEIGHT}px)` }}
                  role="listitem"
                >
                  <span>{city}</span>
                  <div className="dictionaries-city-row__actions">
                    <small>{index + 1}</small>
                    <button type="button" aria-label={`Переименовать город ${city}`} title="Переименовать" onClick={() => openEditCity(city)}>
                      <EditIcon />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {loadingMore && <div className="dictionaries-loading-more">Загружаем ещё…</div>}
          </div>
        )}
      </section>

      <BrutalModal
        open={cityModalOpen}
        onClose={closeCreateCity}
        title={editingCity ? 'Переименовать город' : 'Добавить город'}
        subtitle={editingCity
          ? 'Новое название также обновится у всех точек, использующих этот город.'
          : 'Город станет доступен в формах создания и редактирования точек.'}
        width="medium"
        footer={(
          <div className="sa-modal-footer-row">
            <div className="sa-modal-footer-row__right">
              <button type="button" className="sa-btn-outline" onClick={closeCreateCity} disabled={creating}>Отмена</button>
              <button type="submit" form={CREATE_CITY_FORM_ID} className="sa-btn-primary" disabled={creating || !newCityName.trim() || cityNameUnchanged}>
                {creating ? 'Сохраняем…' : editingCity ? 'Сохранить' : 'Добавить город'}
              </button>
            </div>
          </div>
        )}
      >
        <form id={CREATE_CITY_FORM_ID} className="dictionaries-create-form" onSubmit={handleSaveCity}>
          <label>
            <span>Название города</span>
            <input
              className={`sa-input${nameInvalid ? ' sa-field-invalid' : ''}`}
              value={newCityName}
              maxLength={160}
              autoFocus
              placeholder="Например, Оренбург"
              aria-invalid={nameInvalid || undefined}
              onChange={(event) => {
                setNewCityName(event.target.value);
                setCreateError(null);
              }}
            />
          </label>
          {nameInvalid && <div className="dictionaries-field-error">Введите название города.</div>}
          {createError && <div className="dictionaries-notice dictionaries-notice--error">{createError}</div>}
        </form>
      </BrutalModal>
      </> : <DemoCallSettings tab={activeTab} />}
    </div>
  );
}
