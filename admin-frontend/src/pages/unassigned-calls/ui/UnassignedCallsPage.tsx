import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { apiJson } from '../../../entities/session/api/api';
import { SlideOver } from '../../../shared/ui/slide-over';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import { AUDITS_CHANGED_EVENT, fetchAuditDetail, type AuditDetailItem } from '../../../shared/api/adminPanel';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { BrutalSelect } from '../../../shared/ui/BrutalSelect';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { useToast } from '../../../shared/ui/toast/ToastProvider';
import './UnassignedCallsPage.css';

type Call = { id: number; callId: string; to: string; startedAt: string; durationSec: number | null;
  outcome: string | null; totalScore: number | null; attributionIntroducedName: string | null;
  dealershipId: string; dealership: { name: string }; phoneNumberTypeName: string | null };
type Dealership = { id: string; name: string; managerProfiles: { id: string; fullName: string; email: string | null }[] };
type Data = { calls: Call[]; dealerships: Dealership[]; total: number; page: number; pageSize: number; totalPages: number; canAssign: boolean };
const outcomes: Record<string, string> = { completed: 'Завершён', no_answer: 'Нет ответа', busy: 'Занято', failed: 'Ошибка', disconnected: 'Разъединён' };

export function UnassignedCallsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const reportCallId = searchParams.get('callId')?.trim().replace(/^call-/, '') || null;
  function setReportCallId(id: number | null) {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (id === null) next.delete('callId');
      else next.set('callId', String(id));
      return next;
    }, { replace: id === null });
  }
  const [data, setData] = useState<Data | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [assigningCall, setAssigningCall] = useState<Call | null>(null);
  const [reportDetail, setReportDetail] = useState<AuditDetailItem | null>(null);
  const [reportLoading, setReportLoading] = useState(Boolean(reportCallId));
  const [reportError, setReportError] = useState('');
  const [saving, setSaving] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const invalidPeriod = Boolean(fromDate && toDate && fromDate > toDate);
  useEffect(() => {
    let cancelled = false;
    setData(null); setSelected({}); setError('');
    if (invalidPeriod) { setLoading(false); return; }
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q: search });
    // Local calendar days match the timezone used to display the call timestamps.
    if (fromDate) params.set('from', new Date(`${fromDate}T00:00:00`).toISOString());
    if (toDate) {
      const end = new Date(`${toDate}T00:00:00`);
      end.setDate(end.getDate() + 1);
      params.set('to', end.toISOString());
    }
    apiJson<Data>(`/api/admin/unassigned-calls?${params}`)
      .then(result => { if (!cancelled) { setData(result); if (result.page !== page) setPage(result.page); } })
      .catch(err => { if (!cancelled) setError(err.message || 'Не удалось загрузить звонки.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, pageSize, search, fromDate, toDate, invalidPeriod, revision]);

  useEffect(() => {
    if (reportCallId === null) return;
    const controller = new AbortController();
    setReportLoading(true); setReportError(''); setReportDetail(null);
    fetchAuditDetail(`call-${reportCallId}`, controller.signal)
      .then(detail => {
        if (!controller.signal.aborted) {
          if (detail) setReportDetail(detail);
          else setReportError('Отчёт не найден или звонок больше недоступен.');
        }
      })
      .catch(err => { if (!controller.signal.aborted) setReportError(err instanceof Error ? err.message : 'Не удалось открыть отчёт.'); })
      .finally(() => { if (!controller.signal.aborted) setReportLoading(false); });
    return () => controller.abort();
  }, [reportCallId]);

  async function assign(call: Call) {
    setSaving(call.id); setError('');
    try {
      await apiJson(`/api/admin/unassigned-calls/${call.id}/assign`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ managerId: selected[call.id] }) });
      setAssigningCall(null);
      showToast({ type: 'success', title: 'Ответственный назначен', description: 'Метрики звонка учтены у сотрудника.' });
      window.dispatchEvent(new Event(AUDITS_CHANGED_EVENT));
      if (data?.calls.length === 1 && page > 1) setPage(page - 1);
      else setRevision(value => value + 1);
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось назначить ответственного.'); }
    finally { setSaving(null); }
  }

  const canAssign = Boolean(data?.canAssign);
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  const hasFilters = Boolean(searchInput || fromDate || toDate);
  const pageNumbers = [...new Set([1, ...Array.from({ length: 5 }, (_, i) => page + i - 2), totalPages])]
    .filter(value => value >= 1 && value <= totalPages).sort((a, b) => a - b);

  return (
    <section className="sa-unassigned-calls" aria-labelledby="unassigned-calls-title">
      <div className="sa-unassigned-calls__intro">
        <h1 id="unassigned-calls-title" className="sa-page-title">Нераспределённые звонки</h1>
        <p className="sa-page-subtitle">Назначайте ответственных за звонки на общие номера точки. Оценка и метрики звонка будут учтены в результатах сотрудника.</p>
      </div>

      <div className="sa-toolbar sa-toolbar-split sa-holdings-toolbar">
        <div className="sa-toolbar-filters">
          <div className="sa-search-wrap sa-unassigned-calls__search">
            <svg className="sa-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" />
            </svg>
            <input className="sa-search-input" type="search" aria-label="Поиск по номеру или ID звонка"
              placeholder="Номер телефона или ID звонка…" value={searchInput} disabled={saving !== null}
              onChange={event => setSearchInput(event.target.value)} />
          </div>
          <div className="sa-unassigned-calls__dates">
            <label className="sa-unassigned-calls__filter"><span className="sa-meta">С</span>
              <input className="sa-input" type="date" aria-label="Дата начала" value={fromDate} max={toDate || undefined}
                disabled={saving !== null} onChange={event => { setFromDate(event.target.value); setPage(1); }} />
            </label>
            <label className="sa-unassigned-calls__filter"><span className="sa-meta">По</span>
              <input className="sa-input" type="date" aria-label="Дата окончания" value={toDate} min={fromDate || undefined}
                disabled={saving !== null} onChange={event => { setToDate(event.target.value); setPage(1); }} />
            </label>
          </div>
          {hasFilters && <button type="button" className="sa-filter-reset" disabled={saving !== null}
            onClick={() => { setSearchInput(''); setSearch(''); setFromDate(''); setToDate(''); setPage(1); }}>Сбросить</button>}
        </div>
        <div className="sa-toolbar-actions">
          <button type="button" className="sa-btn-outline" disabled={loading || invalidPeriod || saving !== null} onClick={() => setRevision(value => value + 1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 12M4 12l2.3 6A7 7 0 0 0 18 17" />
            </svg>
            Обновить
          </button>
        </div>
      </div>

      {invalidPeriod && <div className="sa-batch-live-error sa-unassigned-calls__notice" role="alert">Дата начала должна быть не позже даты окончания.</div>}
      {error && !assigningCall && <div className="sa-batch-live-error sa-unassigned-calls__notice" role="alert">{error}</div>}
      {data && !canAssign && <div className="sa-batch-live-note sa-unassigned-calls__notice">
        <LetsIcon name="lock-light" size={16} /> Доступ только для чтения
      </div>}

      <div className="sa-companies-table-wrap sa-holdings-table-wrap sa-unassigned-calls__table-wrap" aria-busy={loading}>
        <table className="sa-table sa-holdings-table sa-unassigned-calls__table">
          <caption className="sa-unassigned-calls__sr-only">Завершённые звонки без ответственного сотрудника</caption>
          <thead><tr>
            <th scope="col">Звонок</th>
            <th scope="col">Точка</th>
            <th scope="col">Результат</th>
            <th scope="col">Оценка</th>
            <th scope="col">Представился</th>
            {canAssign && <th scope="col">Ответственный</th>}
          </tr></thead>
          <tbody>
            {loading || !data || !data.calls.length ? (
              <tr className="sa-unassigned-calls__state-row"><td colSpan={canAssign ? 6 : 5}>
                <div className="sa-unassigned-calls__empty" role="status">
                  <span className="sa-unassigned-calls__empty-icon"><LetsIcon name="phone" size={24} /></span>
                  <div className="sa-cell-name">{loading ? 'Загрузка звонков…' : invalidPeriod ? 'Проверьте период' : !data ? 'Не удалось загрузить звонки' : hasFilters ? 'Звонки не найдены' : 'Нераспределённых звонков нет'}</div>
                  <div className="sa-meta">{loading ? 'Получаем завершённые звонки доступных точек.' : invalidPeriod ? 'Укажите корректные даты начала и окончания.' : !data ? 'Попробуйте обновить список.' : hasFilters ? 'Измените период или поисковый запрос.' : 'Новые завершённые звонки без ответственного появятся здесь.'}</div>
                </div>
              </td></tr>
            ) : data.calls.map(call => {
              const managers = data.dealerships.find(d => d.id === call.dealershipId)?.managerProfiles ?? [];
              const statusClass = call.outcome === 'completed' ? 'sa-status-norm'
                : call.outcome === 'failed' ? 'sa-status-critical' : 'sa-status-no-data';
              const scoreClass = call.totalScore == null ? 'sa-meta' : call.totalScore >= 76 ? 'sa-score-green'
                : call.totalScore >= 50 ? 'sa-score-orange' : 'sa-score-red';
              return <tr key={call.id} className="sa-row-clickable"
                onClick={() => setReportCallId(call.id)}
                onKeyDown={event => {
                  if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault(); setReportCallId(call.id);
                  }
                }}
                tabIndex={0} aria-label={`Открыть отчёт по звонку ${call.to}, №${call.id}`}>

                <td data-label="Звонок">
                  <div className="sa-cell-name sa-unassigned-calls__phone">{call.to}</div>
                  <div className="sa-meta">#{call.id} · {new Date(call.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</div>
                </td>
                <td data-label="Точка">
                  <div className="sa-cell-name">{call.dealership.name}</div>
                  <div className="sa-meta">{call.phoneNumberTypeName || 'Общий номер'}</div>
                </td>
                <td data-label="Результат">
                  <span className={`sa-status-badge ${statusClass}`}>{outcomes[call.outcome || ''] || 'Завершён'}</span>
                  <div className="sa-meta sa-unassigned-calls__duration">{call.durationSec == null ? 'Длительность не указана' : `${Math.floor(call.durationSec / 60)} мин ${call.durationSec % 60} сек`}</div>
                </td>
                <td data-label="Оценка"><span className={scoreClass}>{call.totalScore == null ? '—' : Math.round(call.totalScore)}</span></td>
                <td data-label="Представился">{call.attributionIntroducedName || <span className="sa-meta">Не определено</span>}</td>
                {canAssign && <td data-label="Ответственный" className="sa-unassigned-calls__assignee-cell">
                  {managers.length ? <button type="button" className="sa-btn-outline" disabled={saving !== null}
                    aria-label={`Назначить ответственного за звонок ${call.to}`}
                    onClick={event => { event.stopPropagation(); setError(''); setAssigningCall(call); }}>
                    <LetsIcon name="user" size={16} /> Назначить
                  </button> : <span className="sa-meta">В точке нет активных сотрудников</span>}
                </td>}
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <div className="sa-audit-history-pagination sa-unassigned-calls__pagination">
        <div className="sa-unassigned-calls__page-summary">
          <span className="sa-meta" aria-live="polite">{loading ? 'Загрузка…' : data
            ? data.total ? `Показаны ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, data.total)} из ${data.total}` : 'Показано 0 из 0'
            : 'Нет данных'}</span>
          <div className="sa-unassigned-calls__page-size">
            <span className="sa-meta">На странице</span>
            <BrutalSelect aria-label="Звонков на странице" value={String(pageSize)}
              options={[10, 25, 50, 100].map(value => ({ value: String(value), label: String(value) }))}
              disabled={loading || saving !== null} onChange={value => { setPageSize(Number(value)); setPage(1); }} />
          </div>
        </div>
        <nav className="sa-unassigned-calls__page-buttons" aria-label="Страницы звонков">
          <button type="button" className="sa-btn-field sa-btn-sm" disabled={!data || loading || page <= 1 || saving !== null} onClick={() => setPage(page - 1)}>Назад</button>
          {pageNumbers.map((number, index) => <React.Fragment key={number}>
            {index > 0 && number - pageNumbers[index - 1] > 1 && <span className="sa-meta" aria-hidden="true">…</span>}
            <button type="button" className={`sa-btn-field sa-btn-sm${page === number ? ' sa-unassigned-calls__page-current' : ''}`}
              aria-label={`Страница ${number}`} aria-current={page === number ? 'page' : undefined}
              disabled={!data || loading || saving !== null} onClick={() => setPage(number)}>{number}</button>
          </React.Fragment>)}
          <button type="button" className="sa-btn-field sa-btn-sm" disabled={!data || loading || page >= totalPages || saving !== null} onClick={() => setPage(page + 1)}>Далее</button>
        </nav>
      </div>
      <SlideOver open={reportCallId !== null} title="Аналитика звонка" width="xl" onClose={() => setReportCallId(null)}>
        {reportLoading ? <div className="sa-unassigned-calls__empty sa-meta" role="status">Загрузка отчёта…</div>
          : reportError ? <div className="sa-batch-live-error" role="alert">{reportError}</div>
          : reportDetail ? <AuditAnalyticsReport key={reportDetail.id} detail={reportDetail} allowRetry={false} /> : null}
      </SlideOver>
      {assigningCall && <BrutalModal
        open
        title="Назначить ответственного"
        subtitle="Звонок и его метрики будут учтены в результатах выбранного сотрудника."
        width="medium"
        onClose={() => { if (saving === null) setAssigningCall(null); }}
        footer={<div className="sa-modal-footer-row"><div className="sa-modal-footer-row__right">
          <button type="button" className="sa-btn-outline" disabled={saving !== null} onClick={() => setAssigningCall(null)}>Отмена</button>
          <button type="button" className="sa-btn-primary" disabled={!selected[assigningCall.id] || saving !== null} onClick={() => void assign(assigningCall)}>
            {saving !== null ? 'Сохранение…' : 'Назначить'}
          </button>
        </div></div>}
      >
        <div className="sa-unassigned-calls__dialog-summary">
          <div className="sa-cell-name">{assigningCall.to}</div>
          <div className="sa-meta">{assigningCall.dealership.name} · {new Date(assigningCall.startedAt).toLocaleString('ru-RU')}</div>
          {assigningCall.attributionIntroducedName && <div className="sa-meta">Представился: {assigningCall.attributionIntroducedName}</div>}
        </div>
        <div className="sa-unassigned-calls__assignment">
          <span className="sa-meta">Ответственный сотрудник</span>
          <BrutalSelect
            aria-label="Ответственный сотрудник"
            value={selected[assigningCall.id] || ''}
            placeholder="Выберите сотрудника"
            options={(data?.dealerships.find(d => d.id === assigningCall.dealershipId)?.managerProfiles ?? [])
              .map(m => ({ value: m.id, label: `${m.fullName} · ${m.email || m.id.slice(-8)}` }))}
            disabled={saving !== null}
            onChange={value => setSelected(current => ({ ...current, [assigningCall.id]: value }))}
          />
          {error && <div className="sa-batch-live-error" role="alert">{error}</div>}
        </div>
      </BrutalModal>}
    </section>
  );
}
