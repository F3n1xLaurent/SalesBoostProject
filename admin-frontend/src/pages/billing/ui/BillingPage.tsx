import React, { useEffect, useState } from 'react';
import { apiJson } from '../../../entities/session';
import { fetchHoldings, type HoldingItem } from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { CalendarIcon, EditIcon, PhoneIcon } from '../../../shared/ui/icons/ActionIcons';
import './billing.css';

type Payment = {
  id: string; amountKopecks: number; paidAt: string; startsAt: string; endsAt: string | null;
  calls: boolean; trainer: boolean; comment: string; status: 'active' | 'cancelled'; version: number;
};
type Change = { id: string; paymentId: string | null; actorName: string; action: string; createdAt: string; beforeJson: string | null; afterJson: string };
type Billing = { enabled: boolean; access: { calls: boolean; trainer: boolean }; payments: Payment[]; changes: Change[] };
type Form = { amount: string; paidAt: string; startsAt: string; endsAt: string; calls: boolean; trainer: boolean; comment: string; status: 'active' | 'cancelled' };
const money = (value: number) => (value / 100).toLocaleString('ru-RU', { style: 'currency', currency: 'RUB' });
const date = (value: string) => new Date(value).toLocaleDateString('ru-RU');
function localDate(value = new Date().toISOString()) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoDay(value: string, end = false) {
  return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString();
}
function period(p: { startsAt: string; endsAt: string | null }) { return `${date(p.startsAt)} — ${p.endsAt ? date(p.endsAt) : 'бессрочно'}`; }
function paymentState(p: Payment) {
  if (p.status === 'cancelled') return 'Отменена';
  if (new Date(p.startsAt) > new Date()) return 'Ожидает начала';
  if (p.endsAt && new Date(p.endsAt) < new Date()) return 'Срок истёк';
  return 'Действует';
}
function StatusBadge({ state }: { state: string }) {
  const tone = state === 'Действует' || state === 'Доступен' ? 'green'
    : state === 'Ожидает начала' ? 'amber' : state === 'Отменена' ? 'red' : 'neutral';
  return <span className={`billing-badge billing-badge--${tone}`}><span />{state}</span>;
}

function ModuleTags({ calls, trainer }: { calls: boolean; trainer: boolean }) {
  return <div className="billing-tags">
    {calls && <span className="billing-tag"><PhoneIcon />Обзвон</span>}
    {trainer && <span className="billing-tag"><LetsIcon name="mic" size={14} />Тренажёр</span>}
  </div>;
}

function HistorySnapshot({ json }: { json: string }) {
  const value = JSON.parse(json);
  if ('enabled' in value) {
    return <div className="billing-history-setting"><LetsIcon name="setting-alt-line" size={18} />
      {value.enabled ? 'Биллинг включён' : 'Биллинг выключен'}
    </div>;
  }
  const payment = value as Payment;
  return <div className="billing-history-snapshot">
    <strong>{money(payment.amountKopecks)}</strong>
    <ModuleTags calls={payment.calls} trainer={payment.trainer} />
    <span>Дата оплаты: {date(payment.paidAt)}</span>
    <span>Доступ: {period(payment)}</span>
    <span>{payment.status === 'cancelled' ? 'Оплата отменена' : 'Оплата активна'}</span>
    <p>{payment.comment}</p>
  </div>;
}

function CompanyBilling({ holdingId, companyName, deleted }: { holdingId: string; companyName: string; deleted: boolean }) {
  const [data, setData] = useState<Billing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Payment | 'new' | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState('');
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<'payments' | 'history'>('payments');
  const base = `/api/admin/billing/${encodeURIComponent(holdingId)}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiJson<Billing>(base, { signal: controller.signal }).then((value) => { setData(value); setError(''); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, reload]);
  // Refresh time-based access while the page stays open.
  useEffect(() => { const timer = window.setInterval(() => setReload((n) => n + 1), 60_000); return () => clearInterval(timer); }, []);
  function open(payment: Payment | 'new') {
    setEditing(payment); setFormError('');
    setForm(payment === 'new' ? { amount: '', paidAt: localDate(), startsAt: localDate(), endsAt: '', calls: false, trainer: false, comment: '', status: 'active' }
      : { amount: String(payment.amountKopecks / 100), paidAt: localDate(payment.paidAt), startsAt: localDate(payment.startsAt), endsAt: payment.endsAt ? localDate(payment.endsAt) : '', calls: payment.calls, trainer: payment.trainer, comment: payment.comment, status: payment.status });
  }
  async function toggle() {
    if (!data) return;
    setSaving(true); setError('');
    try { await apiJson(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !data.enabled }) }); setReload((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить биллинг.'); }
    finally { setSaving(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!form || !editing) return;
    const amount = form.amount.replace(/\s/g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 21474836.47) { setFormError('Укажите сумму от 0,01 до 21 474 836,47 ₽, не более двух знаков после запятой.'); return; }
    if (!form.calls && !form.trainer) { setFormError('Выберите хотя бы один модуль.'); return; }
    if (form.endsAt && form.endsAt < form.startsAt) { setFormError('Окончание доступа должно быть не раньше начала.'); return; }
    setSaving(true); setFormError('');
    try {
      const [rubles, kopecks = ''] = amount.split('.');
      await apiJson(`${base}/payments${editing === 'new' ? '' : `/${editing.id}`}`, { method: editing === 'new' ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountKopecks: Number(rubles) * 100 + Number(kopecks.padEnd(2, '0')), paidAt: isoDay(form.paidAt), startsAt: isoDay(form.startsAt), endsAt: form.endsAt ? isoDay(form.endsAt, true) : null,
          calls: form.calls, trainer: form.trainer, comment: form.comment, status: form.status, ...(editing === 'new' ? {} : { version: editing.version }) }) });
      setEditing(null); setReload((n) => n + 1);
    } catch (e) { setFormError(e instanceof Error ? e.message : 'Не удалось сохранить оплату.'); }
    finally { setSaving(false); }
  }
  function field<K extends keyof Form>(key: K, value: Form[K]) { setForm((current) => current ? { ...current, [key]: value } : current); }
  const payments = data?.payments ?? [];
  const recordedPayments = payments.filter((payment) => payment.status !== 'cancelled');
  const total = recordedPayments.reduce((sum, payment) => sum + payment.amountKopecks, 0);
  const activePayments = payments.filter((payment) => paymentState(payment) === 'Действует');
  const lastPayment = recordedPayments[0];
  const disabled = saving || loading || deleted;

  function modulePeriod(module: 'calls' | 'trainer') {
    if (!data?.enabled) return 'Без ограничений биллинга';
    const grants = activePayments.filter((payment) => payment[module]);
    if (!grants.length) return 'Добавьте оплату, чтобы открыть доступ';
    if (grants.some((payment) => !payment.endsAt)) return 'Доступ предоставлен бессрочно';
    const end = grants.reduce((latest, payment) => payment.endsAt! > latest ? payment.endsAt! : latest, '');
    return `Оплачен до ${date(end)} включительно`;
  }

  const addPaymentButton = (
    <button type="button" className="billing-primary-button" disabled={disabled} onClick={() => open('new')}>
      <LetsIcon name="add-light" size={20} />Добавить оплату
    </button>
  );

  return <>
    {error && <div role="alert" className="billing-error">{error}
      <button type="button" className="billing-text-button" onClick={() => setReload((n) => n + 1)}>Обновить</button>
    </div>}
    {!data ? <div className="billing-loading" role="status">
      <span className="billing-skeleton" /><span className="billing-skeleton" />
      <p>{loading ? 'Загружаем оплаты и доступ…' : 'Данные не загружены.'}</p>
    </div> : <>
      {deleted && <div className="billing-error">Компания удалена. Оплаты доступны только для просмотра.</div>}
      <div className="billing-overview">
        <section className="billing-summary" aria-label="Сводка по оплатам">
          <div className="billing-summary-top">
            <span className="billing-eyebrow">Сумма оплат</span>
            <span className="billing-summary-icon"><LetsIcon name="wallet" size={22} /></span>
          </div>
          <strong className="billing-total">{money(total)}</strong>
          <p className="billing-summary-caption">{companyName} · без отменённых оплат</p>
          <div className="billing-summary-bottom">
            <div><span>Записей об оплате</span><strong>{recordedPayments.length}</strong></div>
            <div><span>Последняя оплата</span><strong>{lastPayment ? date(lastPayment.paidAt) : 'Пока нет'}</strong></div>
          </div>
        </section>

        <section className={`billing-control ${data.enabled ? 'billing-control--enabled' : ''}`}>
          <div className="billing-control-top">
            <span className="billing-icon-box"><LetsIcon name="lock-light" size={22} /></span>
            <span className={`billing-control-label ${data.enabled ? 'is-enabled' : ''}`}>{data.enabled ? 'Включён' : 'Выключен'}</span>
          </div>
          <h2>Биллинг компании</h2>
          <p>{data.enabled ? 'Доступ к модулям определяется действующими оплатами.' : 'Сотрудникам доступны модули в рамках их ролей, без проверки оплат.'}</p>
          <div className="billing-control-bottom">
            <label className="billing-switch" htmlFor="company-billing-enabled">
              <input id="company-billing-enabled" type="checkbox" role="switch" checked={data.enabled} disabled={disabled} onChange={toggle} />
              <span className="billing-switch-track" aria-hidden="true"><span /></span>
              <span>Проверять оплаченный доступ</span>
            </label>
          </div>
        </section>
      </div>

      <section className="billing-access-section" aria-labelledby="billing-access-title">
        <div className="billing-section-heading"><h2 id="billing-access-title">Доступ к модулям</h2><span>В рамках прав сотрудников</span></div>
        <div className="billing-modules">
          {(['calls', 'trainer'] as const).map((key) => <div key={key} className={`billing-module ${data.access[key] ? 'is-active' : ''}`}>
            <div className="billing-module-top">
              <span className="billing-icon-box">{key === 'calls' ? <PhoneIcon /> : <LetsIcon name="mic" size={23} />}</span>
              <StatusBadge state={data.access[key] ? 'Доступен' : 'Нет доступа'} />
            </div>
            <h3>{key === 'calls' ? 'Обзвон точек' : 'Тренажёр'}</h3>
            <p>{key === 'calls' ? 'Запуск звонков и плановых проверок точек' : 'Практика диалогов и развитие навыков продаж'}</p>
            <div className="billing-module-period"><CalendarIcon />{modulePeriod(key)}</div>
          </div>)}
        </div>
      </section>

      <section className="billing-ledger" aria-label="Оплаты и история изменений">
        <div className="billing-ledger-toolbar">
          <div className="billing-tabs" role="tablist" aria-label="Разделы биллинга">
            <button type="button" id="billing-payments-tab" role="tab" aria-selected={tab === 'payments'} aria-controls="billing-payments-panel" tabIndex={tab === 'payments' ? 0 : -1}
              onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setTab('history'); document.getElementById('billing-history-tab')?.focus(); } }}
              onClick={() => setTab('payments')}>Оплаты<span>{payments.length}</span></button>
            <button type="button" id="billing-history-tab" role="tab" aria-selected={tab === 'history'} aria-controls="billing-history-panel" tabIndex={tab === 'history' ? 0 : -1}
              onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setTab('payments'); document.getElementById('billing-payments-tab')?.focus(); } }}
              onClick={() => setTab('history')}>История изменений<span>{data.changes.length}</span></button>
          </div>
          {addPaymentButton}
        </div>

        <div role="tabpanel" id="billing-payments-panel" aria-labelledby="billing-payments-tab" hidden={tab !== 'payments'}>
          {!payments.length ? <div className="billing-empty">
            <span className="billing-empty-icon"><LetsIcon name="file-dock-light" size={32} /></span>
            <h3>Здесь будут оплаты компании</h3>
            <p>Добавьте первую оплату, укажите договор<br />и выберите модули, к которым предоставлен доступ.</p>
          </div> : <div className="billing-table-scroll">
            <table className="billing-table">
              <thead><tr><th>Оплата</th><th>Модули и срок доступа</th><th>Комментарий / договор</th><th>Статус</th><th><span className="billing-sr-only">Действия</span></th></tr></thead>
              <tbody>{payments.map((payment) => <tr key={payment.id} className={payment.status === 'cancelled' ? 'billing-row--cancelled' : ''}>
                <td data-label="Оплата"><strong className="billing-payment-amount">{money(payment.amountKopecks)}</strong><span className="billing-payment-date">{date(payment.paidAt)}</span></td>
                <td data-label="Доступ"><ModuleTags calls={payment.calls} trainer={payment.trainer} /><span className="billing-payment-period">{period(payment)}</span></td>
                <td data-label="Комментарий" className="billing-comment">{payment.comment}</td>
                <td data-label="Статус"><StatusBadge state={paymentState(payment)} /></td>
                <td className="billing-row-action"><button type="button" className="billing-icon-button" disabled={disabled} onClick={() => open(payment)} aria-label={`Редактировать оплату ${money(payment.amountKopecks)} от ${date(payment.paidAt)}`} title="Редактировать оплату"><EditIcon /></button></td>
              </tr>)}</tbody>
            </table>
          </div>}
          <div className="billing-ledger-note"><LetsIcon name="lock-light" size={15} />Модули действующих оплат объединяются. Все изменения сохраняются в истории.</div>
        </div>

        <div role="tabpanel" id="billing-history-panel" aria-labelledby="billing-history-tab" hidden={tab !== 'history'}>
          {!data.changes.length ? <div className="billing-empty">
            <span className="billing-empty-icon"><LetsIcon name="time" size={32} /></span>
            <h3>История пока пуста</h3><p>Здесь появятся добавления оплат, правки<br />и изменения настроек биллинга.</p>
          </div> : <div className="billing-timeline">{data.changes.map((change) => <details className="billing-change" key={change.id}>
            <summary>
              <span className="billing-history-icon"><LetsIcon name={change.action === 'settings' ? 'setting-alt-line' : change.action === 'created' ? 'add-light' : 'file-dock-light'} size={19} /></span>
              <span className="billing-history-title"><strong>{change.action === 'settings' ? 'Изменены настройки биллинга' : change.action === 'created' ? 'Добавлена оплата' : 'Изменена оплата'}</strong><span>{change.actorName} · {new Date(change.createdAt).toLocaleString('ru-RU')}</span></span>
              <span className="billing-history-chevron"><LetsIcon name="expand-down-light" size={20} /></span>
            </summary>
            <div className={`billing-history-diff ${change.beforeJson ? '' : 'billing-history-diff--single'}`}>
              {change.beforeJson && <div><span className="billing-diff-label">До изменения</span><HistorySnapshot json={change.beforeJson} /></div>}
              <div><span className="billing-diff-label">{change.beforeJson ? 'После изменения' : 'Данные оплаты'}</span><HistorySnapshot json={change.afterJson} /></div>
            </div>
          </details>)}</div>}
        </div>
      </section>
    </>}

    <BrutalModal open={!!editing} onClose={() => { if (!saving) setEditing(null); }}
      title={editing === 'new' ? 'Новая оплата' : 'Редактировать оплату'} subtitle={companyName} modalClassName="billing-modal"
      footer={<div className="billing-form-footer"><span><LetsIcon name="lock-light" size={15} />Сохраним в истории</span><div>
        <button type="button" className="billing-secondary-button" disabled={saving} onClick={() => setEditing(null)}>Отмена</button>
        <button className="billing-primary-button" type="submit" form="billing-payment-form" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить оплату'}</button>
      </div></div>}>
      {form && <form id="billing-payment-form" className="billing-form" onSubmit={save}><fieldset disabled={saving}>
        {formError && <div role="alert" className="billing-error">{formError}</div>}
        <div className="billing-form-grid">
          <label>Сумма оплаты<div className="billing-amount-field"><input required inputMode="decimal" value={form.amount} onChange={(event) => field('amount', event.target.value)} placeholder="10 000" /><span>₽</span></div></label>
          <label>Дата оплаты<input className="billing-input" required type="date" value={form.paidAt} onChange={(event) => field('paidAt', event.target.value)} /></label>
        </div>

        <div className="billing-form-section"><h3>Что оплачено</h3><p>Выберите один или оба модуля</p>
          <div className="billing-form-modules">
            {(['calls', 'trainer'] as const).map((key) => <label key={key} className={`billing-module-choice ${form[key] ? 'is-selected' : ''}`}>
              <input type="checkbox" checked={form[key]} onChange={(event) => field(key, event.target.checked)} />
              <span className="billing-choice-icon">{key === 'calls' ? <PhoneIcon /> : <LetsIcon name="mic" size={21} />}</span>
              <strong>{key === 'calls' ? 'Обзвон точек' : 'Тренажёр'}</strong>
              <span className="billing-choice-description">{key === 'calls' ? 'Звонки и проверки' : 'Практика продаж'}</span>
            </label>)}
          </div>
        </div>

        <div className="billing-form-section"><div className="billing-form-section-heading"><h3>Период доступа</h3>
          <label className="billing-check"><input type="checkbox" checked={!form.endsAt} onChange={(event) => field('endsAt', event.target.checked ? '' : form.startsAt)} />Бессрочно</label>
        </div>
          <div className="billing-form-grid"><label>Доступ с<input className="billing-input" required type="date" value={form.startsAt} onChange={(event) => field('startsAt', event.target.value)} /></label>
            <label>Доступ до, включительно<input className="billing-input" type="date" min={form.startsAt} disabled={!form.endsAt} value={form.endsAt} onChange={(event) => field('endsAt', event.target.value)} /></label>
          </div>
          <p className="billing-note">Даты указаны по вашему местному времени.</p>
        </div>

        <label>Комментарий / договор<textarea className="billing-input" required maxLength={4000} rows={3} value={form.comment} onChange={(event) => field('comment', event.target.value)} placeholder="Например, договор №12: доступ к обзвону и тренажёру" /></label>
        {editing !== 'new' && <label className="billing-cancel-choice"><input type="checkbox" checked={form.status === 'cancelled'} onChange={(event) => field('status', event.target.checked ? 'cancelled' : 'active')} /><span><strong>Отменить оплату</strong><small>Оплата останется в истории и перестанет предоставлять доступ.</small></span></label>}
      </fieldset></form>}
    </BrutalModal>
  </>;
}

export function BillingPage() {
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [holdingId, setHoldingId] = useGlobalHoldingFilter(holdings, !loading && !error);
  useEffect(() => { let active = true; fetchHoldings().then((items) => { if (active) setHoldings(items); }).catch((e) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const selected = holdings.find((h) => h.id === holdingId);
  return <div className="billing-page">
    <header className="billing-page-header"><div><h1 className="sa-page-title">Биллинг</h1><p>Оплаты, подключённые модули и доступ компаний</p></div>
      <span className="billing-admin-label"><LetsIcon name="lock-light" size={16} />Только для суперадмина</span>
    </header>
    <div className="billing-company-toolbar sa-holdings-toolbar">
      <div className="billing-company-filter"><span>Компания</span><HoldingSelectPicker holdings={holdings} value={holdingId} onChange={setHoldingId} disabled={loading || !holdings.length} loading={loading} /></div>
      <span className="billing-company-hint">Оплаты и доступ для выбранной компании</span>
    </div>
    {error && <div role="alert" className="billing-error">{error}</div>}
    {selected ? <CompanyBilling key={selected.id} holdingId={selected.id} companyName={selected.name} deleted={!!selected.isDeleted} />
      : loading ? <div className="billing-loading" role="status">Загружаем компании…</div>
        : !error && <div className="billing-empty"><span className="billing-empty-icon"><LetsIcon name="wallet" size={32} /></span><h3>Выберите компанию</h3><p>Здесь можно управлять её оплатами и доступом к модулям.</p></div>}
  </div>;
}
