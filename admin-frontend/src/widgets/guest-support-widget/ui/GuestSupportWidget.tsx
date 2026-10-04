import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, CircleHelp, Loader2, MessageCircle, Plus, Send, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import {
  createPublicSupportTicket,
  downloadPublicSupportAttachment,
  getPublicSupportMeta,
  getPublicSupportTicket,
  markPublicSupportTicketRead,
  ratePublicSupportTicket,
  sendPublicSupportMessage,
  uploadPublicSupportAttachment,
  type PublicSupportReference,
} from '../../../shared/api/publicSupport';
import type { SupportMessage, SupportTicket } from '../../../shared/api/support';
import '../../support-widget/ui/support-widget.css';
import { appendSupportFiles, pastedSupportFiles, SupportFilePicker, SupportMessageAttachments } from '../../support-widget/ui/SupportAttachments';
import './guest-support-widget.css';

type View = 'list' | 'create' | 'thread';
type StoredContact = { name: string; email: string; phone: string };
type GuestTicket = {
  reference: PublicSupportReference;
  ticket: SupportTicket;
  messages: SupportMessage[];
  rating: { isSatisfied: boolean; comment: string | null; createdAt: string } | null;
};

const REFERENCES_KEY = 'salesboost:guest-support-tickets:v1';
const CONTACT_KEY = 'salesboost:guest-support-contact:v1';

const CATEGORY_LABELS: Record<string, string> = {
  registration: 'Регистрация',
  password_recovery: 'Забыл пароль',
  other: 'Другой вопрос',
};

const STATUS_LABELS: Record<string, string> = {
  new: 'Принято', open: 'В работе', waiting: 'Ждём ответа', on_hold: 'На удержании',
  resolved: 'Решено', closed: 'Закрыто', reopened: 'Переоткрыто', duplicate: 'Дубль', spam: 'Закрыто',
};

function readReferences(): PublicSupportReference[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REFERENCES_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => (
      item && typeof item.id === 'string' && typeof item.accessToken === 'string'
    )).slice(0, 10);
  } catch {
    return [];
  }
}

function writeReferences(references: PublicSupportReference[]) {
  localStorage.setItem(REFERENCES_KEY, JSON.stringify(references.slice(0, 10)));
}

function readContact(): StoredContact {
  try {
    const value = JSON.parse(localStorage.getItem(CONTACT_KEY) || '{}');
    return {
      name: typeof value.name === 'string' ? value.name : '',
      email: typeof value.email === 'string' ? value.email : '',
      phone: typeof value.phone === 'string' ? value.phone : '',
    };
  } catch {
    return { name: '', email: '', phone: '' };
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat('ru-RU', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : 'Произошла ошибка. Попробуйте ещё раз.';
}

export function GuestSupportWidget() {
  const storedContact = useMemo(readContact, []);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('list');
  const [tickets, setTickets] = useState<GuestTicket[]>([]);
  const [selected, setSelected] = useState<GuestTicket | null>(null);
  const [categories, setCategories] = useState<string[]>(Object.keys(CATEGORY_LABELS));
  const [supportOpen, setSupportOpen] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [name, setName] = useState(storedContact.name);
  const [email, setEmail] = useState(storedContact.email);
  const [phone, setPhone] = useState(storedContact.phone);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');
  const [website, setWebsite] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [ratingComment, setRatingComment] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);
  const previousUnreadRef = useRef<number | null>(null);

  const unreadCount = tickets.reduce((sum, item) => sum + item.ticket.unreadCount, 0);

  useEffect(() => {
    const previous = previousUnreadRef.current;
    previousUnreadRef.current = unreadCount;
    if (previous === null || unreadCount <= previous || document.visibilityState === 'visible') return;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Новый ответ поддержки', { body: 'Откройте чат на странице входа, чтобы прочитать сообщение.' });
    }
  }, [unreadCount]);

  const loadTickets = useCallback(async (showLoader = true) => {
    const references = readReferences();
    if (!references.length) {
      setTickets([]);
      return;
    }
    if (showLoader) setLoading(true);
    const results = await Promise.allSettled(references.map(async (reference) => ({
      reference,
      response: await getPublicSupportTicket(reference),
    })));
    const available: GuestTicket[] = [];
    const validReferences: PublicSupportReference[] = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      validReferences.push(result.value.reference);
      available.push({
        reference: result.value.reference,
        ticket: result.value.response.ticket,
        messages: result.value.response.messages,
        rating: result.value.response.rating,
      });
    }
    available.sort((a, b) => new Date(b.ticket.lastMessageAt).getTime() - new Date(a.ticket.lastMessageAt).getTime());
    setTickets(available);
    if (validReferences.length !== references.length) writeReferences(validReferences);
    if (showLoader) setLoading(false);
  }, []);

  const refreshThread = useCallback(async (item: GuestTicket, showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const response = await getPublicSupportTicket(item.reference);
      const next = { reference: item.reference, ticket: response.ticket, messages: response.messages, rating: response.rating };
      setSelected(next);
      setRatingComment(response.rating?.comment ?? '');
      setTickets((current) => current.map((entry) => entry.ticket.id === next.ticket.id ? next : entry));
      if (document.visibilityState === 'visible') {
        void markPublicSupportTicketRead(item.reference).then(() => {
          setTickets((current) => current.map((entry) => entry.ticket.id === next.ticket.id
            ? { ...entry, ticket: { ...entry.ticket, unreadCount: 0 } }
            : entry));
        }).catch(() => undefined);
      }
      setError(null);
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void getPublicSupportMeta().then((meta) => {
      setCategories(meta.categories);
      setSupportOpen(meta.supportHours.isOpen);
    }).catch(() => undefined);
    void loadTickets(false);
    const timer = window.setInterval(() => void loadTickets(false), 30_000);
    return () => window.clearInterval(timer);
  }, [loadTickets]);

  useEffect(() => {
    if (!open || view !== 'thread' || !selected) return;
    const timer = window.setInterval(() => void refreshThread(selected), 10_000);
    return () => window.clearInterval(timer);
  }, [open, refreshThread, selected?.ticket.id, view]);

  useEffect(() => {
    if (view === 'thread') endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selected?.messages, view]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  function startCreate() {
    setCategory('');
    setSubject('');
    setMessage('');
    setPendingFiles([]);
    setError(null);
    setView('create');
  }

  async function submitTicket(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (!email.trim() && !phone.trim()) {
      setError('Укажите email или номер телефона, чтобы мы могли связаться с вами.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await createPublicSupportTicket({
        category,
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        subject: subject.trim() || undefined,
        message: message.trim(),
        website,
      });
      const reference = { id: response.ticket.id, accessToken: response.accessToken };
      const references = [reference, ...readReferences().filter((item) => item.id !== reference.id)];
      writeReferences(references);
      localStorage.setItem(CONTACT_KEY, JSON.stringify({ name: name.trim(), email: email.trim(), phone: phone.trim() }));
      const next: GuestTicket = { reference, ticket: response.ticket, messages: response.messages, rating: null };
      setSelected(next);
      setTickets((current) => [next, ...current]);
      setView('thread');
      if (pendingFiles.length) {
        try {
          await Promise.all(pendingFiles.map((file) => uploadPublicSupportAttachment(reference, response.messages[0].id, file)));
          await refreshThread(next);
        } catch (uploadError) {
          setError(`Обращение создано, но не все файлы загрузились: ${messageFromError(uploadError)}`);
        }
      }
      setPendingFiles([]);
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReply(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !reply.trim() || submitting) return;
    const text = reply.trim();
    setSubmitting(true);
    setError(null);
    try {
      const response = await sendPublicSupportMessage(selected.reference, text);
      const next = {
        ...selected,
        ticket: response.ticket,
        messages: [...selected.messages, response.message],
      };
      setSelected(next);
      setTickets((current) => current.map((item) => item.ticket.id === next.ticket.id ? next : item));
      setReply('');
      if (pendingFiles.length) {
        try {
          await Promise.all(pendingFiles.map((file) => uploadPublicSupportAttachment(selected.reference, response.message.id, file)));
          await refreshThread(next);
        } catch (uploadError) {
          setError(`Сообщение отправлено, но не все файлы загрузились: ${messageFromError(uploadError)}`);
        }
      }
      setPendingFiles([]);
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRating(isSatisfied: boolean) {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const saved = await ratePublicSupportTicket(selected.reference, {
        isSatisfied,
        comment: ratingComment.trim() || undefined,
      });
      const next = {
        ...selected,
        rating: { isSatisfied: saved.isSatisfied, comment: saved.comment, createdAt: saved.updatedAt },
      };
      setSelected(next);
      setTickets((current) => current.map((item) => item.ticket.id === next.ticket.id ? next : item));
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="support-widget-root guest-support-widget-root">
      {open && (
        <section className="support-widget-panel" role="dialog" aria-label="Техническая поддержка">
          <header className="support-widget-header">
            <div className="support-widget-header-main">
              {view !== 'list' && (
                <button type="button" className="support-widget-icon-button" aria-label="Назад" onClick={() => { setPendingFiles([]); setView('list'); setError(null); void loadTickets(); }}>
                  <ArrowLeft size={20} />
                </button>
              )}
              <div>
                <div className="support-widget-title">{view === 'create' ? 'Новое обращение' : view === 'thread' ? selected?.ticket.number : 'Поддержка'}</div>
                <div className="support-widget-subtitle">
                  {view === 'thread' && selected ? STATUS_LABELS[selected.ticket.status] : supportOpen === false ? 'Ответим в рабочее время' : 'Мы на связи'}
                </div>
              </div>
            </div>
            <button type="button" className="support-widget-icon-button" aria-label="Закрыть" onClick={() => setOpen(false)}><X size={20} /></button>
          </header>

          {error && <div className="support-widget-error" role="alert">{error}<button type="button" onClick={() => setError(null)}><X size={15} /></button></div>}

          {view === 'list' && (
            <div className="support-widget-content support-widget-list-view">
              <button type="button" className="support-widget-new-button" onClick={startCreate}>
                <span><Plus size={20} /></span>
                <div><strong>Написать в поддержку</strong><small>Регистрация, доступ или другой вопрос</small></div>
                <ChevronRight size={20} />
              </button>
              <div className="support-widget-section-heading">Обращения с этого устройства</div>
              {loading ? (
                <div className="support-widget-state"><Loader2 className="support-widget-spin" size={24} />Загрузка…</div>
              ) : tickets.length === 0 ? (
                <div className="support-widget-empty"><CircleHelp size={32} /><strong>Здесь появится переписка</strong><span>Создайте обращение, и мы ответим в чате.</span></div>
              ) : (
                <div className="support-widget-ticket-list">
                  {tickets.map((item) => (
                    <button key={item.ticket.id} type="button" className="support-widget-ticket" onClick={() => { setPendingFiles([]); setSelected(item); setRatingComment(item.rating?.comment ?? ''); setView('thread'); void refreshThread(item, true); }}>
                      <div className="support-widget-ticket-topline"><span className="support-widget-ticket-number">{item.ticket.number}</span><span className={`support-widget-status support-widget-status--${item.ticket.status}`}>{STATUS_LABELS[item.ticket.status]}</span></div>
                      <strong>{item.ticket.subject || CATEGORY_LABELS[item.ticket.category]}</strong>
                      <div className="support-widget-ticket-meta"><span>{CATEGORY_LABELS[item.ticket.category]}</span><span>{formatDate(item.ticket.lastMessageAt)}</span></div>
                      {item.ticket.unreadCount > 0 && <span className="support-widget-ticket-unread">{item.ticket.unreadCount}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {view === 'create' && (
            <form className="support-widget-content support-widget-form guest-support-form" onSubmit={submitTicket}>
              <label><span>Категория</span><select value={category} onChange={(event) => setCategory(event.target.value)} required><option value="">Выберите категорию</option>{categories.map((item) => <option key={item} value={item}>{CATEGORY_LABELS[item] || item}</option>)}</select></label>
              <label><span>Ваше имя</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} autoComplete="name" required /></label>
              <div className="guest-support-contact-grid">
                <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="email" placeholder="name@example.ru" /></label>
                <label><span>Телефон</span><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40} autoComplete="tel" placeholder="+7…" /></label>
              </div>
              <small className="guest-support-contact-hint">Заполните хотя бы один способ связи: email или телефон.</small>
              <label><span>Тема <small>необязательно</small></span><input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} /></label>
              <label className="support-widget-form-message"><span>Сообщение</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={10_000} required placeholder="Опишите ваш вопрос" onPaste={(event) => { const files = pastedSupportFiles(event); if (!files.length) return; event.preventDefault(); const result = appendSupportFiles(pendingFiles, files); if (result.error) setError(result.error); setPendingFiles(result.files); }} /></label>
              <SupportFilePicker files={pendingFiles} disabled={submitting} onChange={setPendingFiles} onError={setError} />
              <label className="guest-support-honeypot" aria-hidden="true"><span>Сайт</span><input value={website} onChange={(event) => setWebsite(event.target.value)} tabIndex={-1} autoComplete="off" /></label>
              <button type="submit" className="support-widget-primary-button" disabled={!category || !name.trim() || !message.trim() || (!email.trim() && !phone.trim()) || submitting}>
                {submitting ? <Loader2 className="support-widget-spin" size={18} /> : <Send size={18} />}Отправить обращение
              </button>
            </form>
          )}

          {view === 'thread' && selected && (
            <>
              <div className="support-widget-thread">
                <div className="support-widget-thread-context">
                  <span>{CATEGORY_LABELS[selected.ticket.category]}</span>
                  <strong>{selected.ticket.subject || 'Обращение в поддержку'}</strong>
                  {!selected.ticket.firstResponseAt && selected.ticket.slaFirstResponseMinutes && (
                    <small className={selected.ticket.slaFirstResponseBreached ? 'is-breached' : ''}>
                      {selected.ticket.slaFirstResponseBreached ? 'Плановое время первого ответа превышено' : `Плановое время первого ответа — ${selected.ticket.slaFirstResponseMinutes} мин.`}
                    </small>
                  )}
                </div>
                {selected.messages.map((item) => (
                  <div key={item.id} className={`support-widget-message support-widget-message--${item.authorType}`}>
                    <div>{item.body}</div>
                    <SupportMessageAttachments attachments={item.attachments} loadBlob={(attachmentId) => downloadPublicSupportAttachment(selected.reference, attachmentId)} />
                    <time>{item.authorType === 'customer' ? 'Вы' : item.authorType === 'support' ? 'Поддержка' : 'Система'} · {formatDate(item.sentAt)}</time>
                  </div>
                ))}
                {['resolved', 'closed'].includes(selected.ticket.status) && (
                  <div className="support-widget-rating">
                    <strong>Удалось решить ваш вопрос?</strong>
                    <div className="support-widget-rating-actions">
                      <button type="button" className={selected.rating?.isSatisfied === true ? 'is-active' : ''} onClick={() => void submitRating(true)} disabled={submitting}><ThumbsUp size={18} /> Да</button>
                      <button type="button" className={selected.rating?.isSatisfied === false ? 'is-active' : ''} onClick={() => void submitRating(false)} disabled={submitting}><ThumbsDown size={18} /> Нет</button>
                    </div>
                    <textarea value={ratingComment} onChange={(event) => setRatingComment(event.target.value)} maxLength={2000} placeholder="Комментарий — необязательно" />
                    {selected.rating && <small><Check size={14} /> Оценка сохранена</small>}
                  </div>
                )}
                <div ref={endRef} />
              </div>
              {!['duplicate', 'spam'].includes(selected.ticket.status) && (
                <form className="support-widget-reply" onSubmit={submitReply}>
                  <SupportFilePicker files={pendingFiles} disabled={submitting} onChange={setPendingFiles} onError={setError} />
                  <textarea value={reply} onChange={(event) => setReply(event.target.value)} maxLength={10_000} placeholder="Напишите сообщение…" onPaste={(event) => { const files = pastedSupportFiles(event); if (!files.length) return; event.preventDefault(); const result = appendSupportFiles(pendingFiles, files); if (result.error) setError(result.error); setPendingFiles(result.files); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
                  <button type="submit" aria-label="Отправить" disabled={!reply.trim() || submitting}>{submitting ? <Loader2 className="support-widget-spin" size={19} /> : <Send size={19} />}</button>
                </form>
              )}
            </>
          )}
        </section>
      )}
      <button type="button" className={`support-widget-launcher${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined); setOpen((value) => !value); if (!open) void loadTickets(); }}>
        {open ? <X size={23} /> : <MessageCircle size={23} />}<span>{open ? 'Закрыть' : 'Поддержка'}</span>{!open && unreadCount > 0 && <b>{unreadCount > 99 ? '99+' : unreadCount}</b>}
      </button>
    </div>
  );
}
