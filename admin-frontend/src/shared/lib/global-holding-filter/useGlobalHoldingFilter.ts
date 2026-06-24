import { useCallback, useEffect, useState } from 'react';

type HoldingOption = {
  id: string;
};

const STORAGE_KEY = 'salesboost.globalHoldingFilter.holdingId';
const CHANGE_EVENT = 'salesboost:globalHoldingFilterChange';

function readStoredHoldingId(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredHoldingId(holdingId: string): void {
  try {
    if (holdingId) window.localStorage.setItem(STORAGE_KEY, holdingId);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { holdingId } }));
}

export function useGlobalHoldingFilter<T extends HoldingOption>(holdings: T[], ready = true): [string, (holdingId: string) => void] {
  const [selectedHoldingId, setSelectedHoldingId] = useState(readStoredHoldingId);

  const setGlobalHoldingId = useCallback((holdingId: string) => {
    setSelectedHoldingId(holdingId);
    writeStoredHoldingId(holdingId);
  }, []);

  useEffect(() => {
    const handleChange = (event: Event) => {
      const next = event instanceof CustomEvent ? String(event.detail?.holdingId || '') : readStoredHoldingId();
      setSelectedHoldingId(next);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setSelectedHoldingId(event.newValue || '');
    };
    window.addEventListener(CHANGE_EVENT, handleChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handleChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (holdings.length === 0) {
      if (selectedHoldingId) setGlobalHoldingId('');
      return;
    }
    if (holdings.some((holding) => holding.id === selectedHoldingId)) return;
    const storedHoldingId = readStoredHoldingId();
    const nextHoldingId = holdings.some((holding) => holding.id === storedHoldingId)
      ? storedHoldingId
      : holdings[0].id;
    if (nextHoldingId !== selectedHoldingId) setGlobalHoldingId(nextHoldingId);
  }, [holdings, ready, selectedHoldingId, setGlobalHoldingId]);

  return [selectedHoldingId, setGlobalHoldingId];
}
