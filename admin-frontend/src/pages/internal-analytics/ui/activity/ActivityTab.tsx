import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '../../../../entities/session';
import { Select } from '../../../../components/ui/select';
import { ToggleGroup } from '../../../../components/ui/toggle-group';
import { Kpis } from './Kpis';
import { DailyActive } from './DailyActive';
import { EntitiesTable } from './EntitiesTable';
import { Roles } from './Roles';
import { Trainer } from './Trainer';
import { Calls } from './Calls';
import { Value } from './Value';
import { Sections } from './Sections';
import type { ActivityResponse } from './types';
import './activity.css';
export function ActivityTab() {
  const location = useLocation(), navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const period = params.get('period') ?? '30', company = params.get('company') ?? '', branch = params.get('branch') ?? '';
  const [data, setData] = useState<ActivityResponse | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const request = useRef(0);
  const filter = (patch: Record<string, string>) => {
    const next = new URLSearchParams(location.search); for (const [key, value] of Object.entries(patch)) {
      if (value)
        next.set(key, value);
      else
        next.delete(key);
    } next.set('tab', 'activity'); navigate({ pathname: location.pathname, search: `?${next}` });
  };
  useEffect(() => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ period });
    if (company)
      query.set('companyId', company);
    if (branch)
      query.set('branchId', branch);
    void apiFetch(`/api/admin/internal-analytics/activity?${query}`).then(async (response) => {
      const payload = await response.json(); if (!response.ok)
        throw new Error(payload.error || 'Не удалось загрузить аналитику.'); if (request.current === current)
        setData(payload);
    }).catch(reason => {
      if (request.current === current)
        setError(reason instanceof Error ? reason.message : 'Ошибка загрузки.');
    }).finally(() => {
      if (request.current === current)
        setLoading(false);
    });
    return () => { request.current++; };
  }, [period, company, branch, retry]);
  return <div className="activity-v3" aria-busy={loading}><div className="av-toolbar"><div className="av-scope-filters"><Select label="Компания" value={company || 'all'} onValueChange={value => filter({ company: value === 'all' ? '' : value, branch: '' })} items={[{ value: 'all', label: 'Все компании' }, ...(data?.filters.companies ?? []).map(item => ({ value: item.id, label: item.name }))]} /><Select label="Точка" value={branch || 'all'} disabled={!company || loading} onValueChange={value => filter({ branch: value === 'all' ? '' : value })} items={[{ value: 'all', label: 'Все точки' }, ...(data?.filters.branches ?? []).filter(item => item.companyId === company).map(item => ({ value: item.id, label: item.name }))]} /></div><ToggleGroup value={period} onValueChange={value => filter({ period: value })} /></div>{error && <div className="av-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(v => v + 1)}><RefreshCw size={14} />Повторить</button></div>}{!data && loading && <div className="av-skeletons" role="status" aria-label="Загружаем активность"><div className="av-kpis">{Array.from({ length: 5 }, (_, i) => <div key={i} className="av-skeleton av-skeleton-kpi" />)}</div><div className="av-skeleton av-skeleton-chart" /><div className="av-two"><div className="av-skeleton av-skeleton-chart" /><div className="av-skeleton av-skeleton-chart" /></div></div>}{data && <div className={`av-content ${loading || error ? 'av-pending' : ''}`}><Kpis data={data} /><DailyActive data={data.dailyActive} /><EntitiesTable data={data.table} companyName={data.filters.companies.find(item => item.id === data.scope.companyId)?.name} onSelect={id => data.table.kind === 'companies' ? filter({ company: id, branch: '' }) : filter({ branch: id })} /><Roles data={data.roles} /><div className="av-two"><Trainer data={data.trainer} /><Calls data={data.calls} /></div><Value data={data.value} growth={data.kpis.northStar.value} /><Sections data={data.sections} /></div>}</div>;
}
