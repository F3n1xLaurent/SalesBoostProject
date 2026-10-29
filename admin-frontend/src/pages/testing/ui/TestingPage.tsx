import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { fetchCallPlans, fetchHoldings, type CallPlanItem, type HoldingItem } from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { YandexRealtimeTestPage } from './YandexRealtimeTestPage';

export function TestingPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [holdingError, setHoldingError] = useState<string | null>(null);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [planState, setPlanState] = useState<{ holdingId: string; plans: CallPlanItem[]; loading: boolean; error: string | null }>({
    holdingId: '', plans: [], loading: false, error: null,
  });

  useEffect(() => {
    if (location.pathname.replace(/\/+$/u, '') === '/call-settings/realtime-test') {
      navigate({ pathname: '/testing', search: location.search, hash: location.hash }, { replace: true });
    }
  }, [location.pathname, location.search, location.hash, navigate]);

  useEffect(() => {
    let cancelled = false;
    fetchHoldings({ status: 'active' })
      .then((items) => { if (!cancelled) setHoldings(items); })
      .catch((error) => { if (!cancelled) setHoldingError(error instanceof Error ? error.message : 'Не удалось загрузить компании.'); })
      .finally(() => { if (!cancelled) setHoldingsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (holdingsLoading || !holdings.some((holding) => holding.id === selectedHoldingId)) return;
    let cancelled = false;
    setPlanState({ holdingId: selectedHoldingId, plans: [], loading: true, error: null });
    fetchCallPlans({ holdingId: selectedHoldingId })
      .then((plans) => {
        if (!cancelled) setPlanState({ holdingId: selectedHoldingId, plans: [...plans].sort((a, b) => a.name.localeCompare(b.name, 'ru')), loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setPlanState({ holdingId: selectedHoldingId, plans: [], loading: false, error: error instanceof Error ? error.message : 'Не удалось загрузить планы прозвона.' });
      });
    return () => { cancelled = true; };
  }, [holdings, holdingsLoading, selectedHoldingId]);

  // Never leave the previous company's plans actionable while a new one loads.
  const hasHolding = holdings.some((holding) => holding.id === selectedHoldingId);
  const currentPlans = hasHolding && planState.holdingId === selectedHoldingId;
  const error = holdingError || (currentPlans ? planState.error : null);

  return (
    <div>
      <h1 className="sa-page-title">Тестирование</h1>
      <div className="sa-toolbar sa-toolbar-split sa-holdings-toolbar">
        <div className="sa-toolbar-filters">
          <HoldingSelectPicker holdings={holdings} value={selectedHoldingId} onChange={setSelectedHoldingId}
            disabled={holdingsLoading || holdings.length === 0} loading={holdingsLoading} />
        </div>
      </div>
      {error && <div className="sa-batch-live-error" style={{ marginBottom: 12 }} role="alert">{error}</div>}
      <YandexRealtimeTestPage plans={currentPlans ? planState.plans : []}
        loading={holdingsLoading || (hasHolding && (!currentPlans || planState.loading))} />
    </div>
  );
}
