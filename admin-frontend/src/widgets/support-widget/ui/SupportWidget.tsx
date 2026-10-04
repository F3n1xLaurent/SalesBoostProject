import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  Loader2,
  MessageCircle,
  Plus,
  Send,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import {
  closeSupportTicket,
  createSupportTicket,
  downloadSupportAttachment,
  getSupportMeta,
  getSupportTicket,
  listSupportTickets,
  markSupportTicketRead,
  rateSupportTicket,
  sendSupportMessage,
  uploadSupportAttachment,
  type SupportMessage,
  type SupportTicket,
} from '../../../shared/api/support';
import { appendSupportFiles, pastedSupportFiles, SupportFilePicker, SupportMessageAttachments } from './SupportAttachments';
import './support-widget.css';

type View = 'list' | 'create' | 'thread';

const CATEGORY_LABELS: Record<string, string> = {
  access_and_roles: 'Доступы и роли',
  billing_and_plans: 'Тарифы и счета',
  product_usage: 'Вопрос по работе с продуктом',
  integrations_and_api: 'Интеграции и API',
  ai_score_review: 'Пересмотр оценки AI',
  product_feedback: 'Пожелание к продукту',
  data_import: 'Импорт данных',
  technical_issue: 'Техническая проблема',
  other: 'Другое',
};

const STATUS_LABELS: Record<string, string> = {
  new: 'Принято',
  open: 'В работе',
  waiting: 'Ждём вашего ответа',
  on_hold: 'На удержании',
  resolved: 'Решено',
  closed: 'Закрыто',
  reopened: 'Переоткрыто',
  duplicate: 'Дубль',
  spam: 'Закрыто',
};

function formatDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat('ru-RU', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Произошла ошибка. Попробуйте ещё раз.';
}

export function SupportWidget() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('list');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [categories, setCategories] = useState<string[]>(Object.keys(CATEGORY_LABELS));
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [subject, setSubject] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const [reply, setReply] = useState('');
  const [ratingComment, setRatingComment] = useState('');
  const [rating, setRating] = useState<boolean | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const previousUnreadRef = useRef<number | null>(null);

  const unreadCount = useMemo(
    () => tickets.reduce((sum, ticket) => sum + ticket.unreadCount, 0),
    [tickets],
  );

  useEffect(() => {
    const previous = previousUnreadRef.current;
    previousUnreadRef.current = unreadCount;
    if (previous === null || unreadCount <= previous || document.visibilityState === 'visible') return;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Новый ответ поддержки', { body: 'Откройте чат, чтобы прочитать сообщение.' });
    }
  }, [unreadCount]);

  const loadTickets = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const response = await listSupportTickets({ limit: 50 });
      setTickets(response.items);
      setError(null);
    } catch (nextError) {
      if (showLoader) setError(errorMessage(nextError));
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  const loadThread = useCallback(async (ticketId: string, showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const response = await getSupportTicket(ticketId);
      setSelectedTicket(response.ticket);
      setMessages(response.messages);
      setRating(response.rating?.isSatisfied ?? null);
      setRatingComment(response.rating?.comment ?? '');
      setError(null);
      if (document.visibilityState === 'visible') {
        void markSupportTicketRead(ticketId).then(() => {
          setTickets((current) => current.map((ticket) => (
            ticket.id === ticketId ? { ...ticket, unreadCount: 0 } : ticket
          )));
        }).catch(() => undefined);
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      loadTickets(false),
      getSupportMeta().then((meta) => setCategories(meta.categories)).catch(() => undefined),
    ]);
    const timer = window.setInterval(() => void loadTickets(false), 30_000);
    return () => window.clearInterval(timer);
  }, [loadTickets]);

  useEffect(() => {
    if (!open || view !== 'thread' || !selectedTicket) return;
    const timer = window.setInterval(() => void loadThread(selectedTicket.id, false), 10_000);
    return () => window.clearInterval(timer);
  }, [loadThread, open, selectedTicket?.id, view]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (view === 'thread') messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, view]);

  async function openTicket(ticket: SupportTicket) {
    setPendingFiles([]);
    setSelectedTicket(ticket);
    setView('thread');
    setError(null);
    await loadThread(ticket.id);
  }

  function startCreate() {
    setCategory('');
    setSubject('');
    setNewMessage('');
    setPendingFiles([]);
    setError(null);
    setView('create');
  }

  async function submitTicket(event: React.FormEvent) {
    event.preventDefault();
    if (!category || !newMessage.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await createSupportTicket({
        category,
        subject: subject.trim() || undefined,
        message: newMessage.trim(),
      });
      setSelectedTicket(response.ticket);
      setMessages([response.message]);
      setRating(null);
      setRatingComment('');
      setView('thread');
      if (pendingFiles.length) {
        try {
          await Promise.all(pendingFiles.map((file) => uploadSupportAttachment(response.ticket.id, response.message.id, file)));
        } catch (uploadError) {
          setError(`Обращение создано, но не все файлы загрузились: ${errorMessage(uploadError)}`);
        }
      }
      await loadThread(response.ticket.id, false);
      setPendingFiles([]);
      await loadTickets(false);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReply(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedTicket || !reply.trim() || submitting) return;
    const text = reply.trim();
    setSubmitting(true);
    setError(null);
    try {
      const response = await sendSupportMessage(selectedTicket.id, text);
      setReply('');
      setSelectedTicket(response.ticket);
      setMessages((current) => [...current, response.message]);
      if (pendingFiles.length) {
        try {
          await Promise.all(pendingFiles.map((file) => uploadSupportAttachment(response.ticket.id, response.message.id, file)));
        } catch (uploadError) {
          setError(`Сообщение отправлено, но не все файлы загрузились: ${errorMessage(uploadError)}`);
        }
      }
      if (pendingFiles.length) await loadThread(response.ticket.id, false);
      setPendingFiles([]);
      await loadTickets(false);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRating(value: boolean) {
    if (!selectedTicket || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await rateSupportTicket(selectedTicket.id, {
        isSatisfied: value,
        comment: ratingComment.trim() || undefined,
      });
      setRating(response.isSatisfied);
      setRatingComment(response.comment ?? '');
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  async function closeTicket() {
    if (!selectedTicket || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await closeSupportTicket(selectedTicket.id);
      setSelectedTicket(response.ticket);
      await loadTickets(false);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  const canReply = selectedTicket && !['duplicate', 'spam'].includes(selectedTicket.status);
  const canRate = selectedTicket && ['resolved', 'closed'].includes(selectedTicket.status);

  return (
    <div className="support-widget-root">
      {open && (
        <section className="support-widget-panel" role="dialog" aria-modal="false" aria-label="Техническая поддержка">
          <header className="support-widget-header">
            <div className="support-widget-header-main">
              {view !== 'list' && (
                <button
                  type="button"
                  className="support-widget-icon-button"
                  aria-label="Назад к обращениям"
                  onClick={() => {
                    setPendingFiles([]);
                    setView('list');
                    setError(null);
                    void loadTickets();
                  }}
                >
                  <ArrowLeft size={20} />
                </button>
              )}
              <div>
                <div className="support-widget-title">
                  {view === 'create' ? 'Новое обращение' : view === 'thread' ? selectedTicket?.number : 'Поддержка'}
                </div>
                <div className="support-widget-subtitle">
                  {view === 'thread' && selectedTicket
                    ? STATUS_LABELS[selectedTicket.status]
                    : 'Ответим и поможем разобраться'}
                </div>
              </div>
            </div>
            <button type="button" className="support-widget-icon-button" aria-label="Закрыть поддержку" onClick={() => setOpen(false)}>
              <X size={20} />
            </button>
          </header>

          {error && (
            <div className="support-widget-error" role="alert">
              {error}
              <button type="button" onClick={() => setError(null)} aria-label="Скрыть ошибку"><X size={15} /></button>
            </div>
          )}

          {view === 'list' && (
            <div className="support-widget-content support-widget-list-view">
              <button type="button" className="support-widget-new-button" onClick={startCreate}>
                <span><Plus size={20} /></span>
                <div>
                  <strong>Создать обращение</strong>
                  <small>Опишите вопрос — мы вернёмся с ответом</small>
                </div>
                <ChevronRight size={20} />
              </button>

              <div className="support-widget-section-heading">Ваши обращения</div>
              {loading ? (
                <div className="support-widget-state"><Loader2 className="support-widget-spin" size={24} />Загружаем обращения…</div>
              ) : tickets.length === 0 ? (
                <div className="support-widget-empty">
                  <CircleHelp size={32} />
                  <strong>Обращений пока нет</strong>
                  <span>Если появится вопрос, напишите нам.</span>
                </div>
              ) : (
                <div className="support-widget-ticket-list">
                  {tickets.map((ticket) => (
                    <button key={ticket.id} type="button" className="support-widget-ticket" onClick={() => void openTicket(ticket)}>
                      <div className="support-widget-ticket-topline">
                        <span className="support-widget-ticket-number">{ticket.number}</span>
                        <span className={`support-widget-status support-widget-status--${ticket.status}`}>{STATUS_LABELS[ticket.status]}</span>
                      </div>
                      <strong>{ticket.subject || CATEGORY_LABELS[ticket.category] || ticket.category}</strong>
                      <div className="support-widget-ticket-meta">
                        <span>{CATEGORY_LABELS[ticket.category] || ticket.category}</span>
                        <span>{formatDate(ticket.lastMessageAt)}</span>
                      </div>
                      {ticket.unreadCount > 0 && <span className="support-widget-ticket-unread">{ticket.unreadCount}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {view === 'create' && (
            <form className="support-widget-content support-widget-form" onSubmit={submitTicket}>
              <label>
                <span>Категория</span>
                <select value={category} onChange={(event) => setCategory(event.target.value)} required>
                  <option value="">Выберите категорию</option>
                  {categories.map((item) => <option key={item} value={item}>{CATEGORY_LABELS[item] || item}</option>)}
                </select>
              </label>
              <label>
                <span>Тема <small>необязательно</small></span>
                <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} placeholder="Коротко о вопросе" />
              </label>
              <label className="support-widget-form-message">
                <span>Сообщение</span>
                <textarea
                  value={newMessage}
                  onChange={(event) => setNewMessage(event.target.value)}
                  maxLength={10_000}
                  placeholder="Расскажите, что произошло и что вы ожидали увидеть"
                  required
                  onPaste={(event) => {
                    const files = pastedSupportFiles(event);
                    if (!files.length) return;
                    event.preventDefault();
                    const result = appendSupportFiles(pendingFiles, files);
                    if (result.error) setError(result.error);
                    setPendingFiles(result.files);
                  }}
                />
                <small>{newMessage.length.toLocaleString('ru-RU')} / 10 000</small>
              </label>
              <SupportFilePicker files={pendingFiles} disabled={submitting} onChange={setPendingFiles} onError={setError} />
              <button type="submit" className="support-widget-primary-button" disabled={!category || !newMessage.trim() || submitting}>
                {submitting ? <Loader2 className="support-widget-spin" size={18} /> : <Send size={18} />}
                Отправить обращение
              </button>
            </form>
          )}

          {view === 'thread' && (
            <>
              <div className="support-widget-thread">
                {loading && messages.length === 0 ? (
                  <div className="support-widget-state"><Loader2 className="support-widget-spin" size={24} />Загружаем переписку…</div>
                ) : (
                  <>
                    {selectedTicket && (
                      <div className="support-widget-thread-context">
                        <span>{CATEGORY_LABELS[selectedTicket.category] || selectedTicket.category}</span>
                        <strong>{selectedTicket.subject || 'Обращение в поддержку'}</strong>
                        {!selectedTicket.firstResponseAt && selectedTicket.slaFirstResponseMinutes && (
                          <small className={selectedTicket.slaFirstResponseBreached ? 'is-breached' : ''}>
                            {selectedTicket.slaFirstResponseBreached
                              ? 'Плановое время первого ответа превышено'
                              : `Плановое время первого ответа — ${selectedTicket.slaFirstResponseMinutes} мин.`}
                          </small>
                        )}
                      </div>
                    )}
                    {messages.map((message) => (
                      <div key={message.id} className={`support-widget-message support-widget-message--${message.authorType}`}>
                        <div>{message.body}</div>
                        <SupportMessageAttachments attachments={message.attachments} loadBlob={downloadSupportAttachment} />
                        <time>{message.authorType === 'customer' ? 'Вы' : message.authorType === 'support' ? 'Поддержка' : 'Система'} · {formatDate(message.sentAt)}</time>
                      </div>
                    ))}
                    {canRate && (
                      <div className="support-widget-rating">
                        <strong>Удалось решить ваш вопрос?</strong>
                        <div className="support-widget-rating-actions">
                          <button type="button" className={rating === true ? 'is-active' : ''} onClick={() => void submitRating(true)} disabled={submitting}>
                            <ThumbsUp size={18} /> Да
                          </button>
                          <button type="button" className={rating === false ? 'is-active' : ''} onClick={() => void submitRating(false)} disabled={submitting}>
                            <ThumbsDown size={18} /> Нет
                          </button>
                        </div>
                        <textarea value={ratingComment} onChange={(event) => setRatingComment(event.target.value)} maxLength={2000} placeholder="Комментарий к оценке — необязательно" />
                        {rating !== null && <small><Check size={14} /> Оценка сохранена</small>}
                        {selectedTicket?.status === 'resolved' && (
                          <button type="button" className="support-widget-close-ticket" onClick={() => void closeTicket()} disabled={submitting}>Закрыть обращение</button>
                        )}
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </>
                )}
              </div>
              {canReply && (
                <form className="support-widget-reply" onSubmit={submitReply}>
                  <SupportFilePicker files={pendingFiles} disabled={submitting} onChange={setPendingFiles} onError={setError} />
                  <textarea
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    maxLength={10_000}
                    placeholder="Напишите сообщение…"
                    onPaste={(event) => {
                      const files = pastedSupportFiles(event);
                      if (!files.length) return;
                      event.preventDefault();
                      const result = appendSupportFiles(pendingFiles, files);
                      if (result.error) setError(result.error);
                      setPendingFiles(result.files);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <button type="submit" aria-label="Отправить сообщение" disabled={!reply.trim() || submitting}>
                    {submitting ? <Loader2 className="support-widget-spin" size={19} /> : <Send size={19} />}
                  </button>
                </form>
              )}
            </>
          )}
        </section>
      )}

      <button
        type="button"
        className={`support-widget-launcher${open ? ' is-open' : ''}`}
        aria-label={open ? 'Закрыть поддержку' : 'Открыть поддержку'}
        aria-expanded={open}
        onClick={() => {
          if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined);
          setOpen((current) => !current);
          if (!open) void loadTickets();
        }}
      >
        {open ? <X size={23} /> : <MessageCircle size={23} />}
        <span>{open ? 'Закрыть' : 'Поддержка'}</span>
        {!open && unreadCount > 0 && <b>{unreadCount > 99 ? '99+' : unreadCount}</b>}
      </button>
    </div>
  );
}
