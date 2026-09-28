import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  archiveEvaluationChecklist,
  createEvaluationChecklist,
  fetchEvaluationChecklists,
  fetchHoldings,
  updateEvaluationChecklist,
  type EvaluationChecklistItem,
  type EvaluationChecklistItemDefinition,
  type HoldingItem,
} from '../../../shared/api/adminPanel';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { useToast } from '../../../shared/ui/toast/ToastProvider';
import { ArchiveIcon, EditIcon } from '../../../shared/ui/icons/ActionIcons';
import './checklists.css';

const CATEGORIES = ['Контакт', 'Выявление запроса', 'Предложение решения', 'Аргументация и доверие', 'Следующий шаг', 'Коммуникация'];

function itemId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `criterion_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function blankItem(): EvaluationChecklistItemDefinition {
  return { id: itemId(), title: '', instruction: '', category: CATEGORIES[0], points: 10, allowNa: false };
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function ChecklistList({
  rows,
  loading = false,
  emptyText,
  onEdit,
  onArchive,
}: {
  rows: EvaluationChecklistItem[];
  loading?: boolean;
  emptyText: string;
  onEdit: (row: EvaluationChecklistItem) => void;
  onArchive: (row: EvaluationChecklistItem) => void;
}) {
  return (
    <section className="sa-card checklist-list-card">
      {loading ? <div className="checklist-empty">Загрузка…</div> : rows.length === 0 ? (
        <div className="checklist-empty">{emptyText}</div>
      ) : (
        <div className="checklist-list">
          {rows.map((row, index) => (
            <article className="checklist-row" key={row.id}>
              <div className="checklist-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
              <div className="checklist-main">
                <h3 className="checklist-name">{row.name}</h3>
                <div className="checklist-updated">Обновлён {formatUpdatedAt(row.updatedAt)}</div>
              </div>
              <div className="checklist-stats">
                <div className="checklist-stat"><strong>{row.items.length}</strong><span>критериев</span></div>
                <div className="checklist-stat checklist-stat-points"><strong>{row.totalPoints}</strong><span>из 100 баллов</span></div>
              </div>
              <div className="checklist-actions">
                <button className="sa-btn-outline sa-btn-icon checklist-action" type="button" onClick={() => onEdit(row)} aria-label={`Изменить «${row.name}»`} title="Изменить">
                  <EditIcon />
                </button>
                <button className="sa-btn-outline sa-btn-icon checklist-action checklist-archive-action" type="button" onClick={() => onArchive(row)} aria-label={`Архивировать «${row.name}»`} title="Архивировать">
                  <ArchiveIcon />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function ChecklistsPage({ isSuperadmin }: { isSuperadmin: boolean }) {
  const { showToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const isCreatePage = location.pathname === '/checklists/new';
  const editChecklistMatch = location.pathname.match(/^\/checklists\/([^/]+)\/edit$/);
  const editChecklistId = editChecklistMatch ? decodeURIComponent(editChecklistMatch[1]) : null;
  const isChecklistEditPage = Boolean(editChecklistId);
  const isChecklistFormPage = isCreatePage || isChecklistEditPage;
  const isTemplatesTab = isSuperadmin && location.pathname.startsWith('/checklists/templates');
  const initializedEditIdRef = useRef<string | null>(null);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [rows, setRows] = useState<EvaluationChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EvaluationChecklistItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [asTemplate, setAsTemplate] = useState(false);
  const [sourceTemplateId, setSourceTemplateId] = useState('');
  const [name, setName] = useState('');
  const [items, setItems] = useState<EvaluationChecklistItemDefinition[]>([blankItem()]);
  const [pointDrafts, setPointDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchHoldings({ status: 'active' })
      .then(setHoldings)
      .catch((error) => showToast({ type: 'error', title: 'Не удалось загрузить компании', description: error instanceof Error ? error.message : '' }))
      .finally(() => setHoldingsLoading(false));
  }, [showToast]);

  useEffect(() => {
    if (!selectedHoldingId && !isSuperadmin) return;
    setLoading(true);
    fetchEvaluationChecklists(selectedHoldingId || null)
      .then(setRows)
      .catch((error) => showToast({ type: 'error', title: 'Не удалось загрузить чек-листы', description: error instanceof Error ? error.message : '' }))
      .finally(() => setLoading(false));
  }, [isSuperadmin, selectedHoldingId, showToast]);

  useEffect(() => {
    if (!isSuperadmin && location.pathname.startsWith('/checklists/templates')) {
      navigate('/checklists', { replace: true });
    }
  }, [isSuperadmin, location.pathname, navigate]);

  useEffect(() => {
    if (isCreatePage) beginCreate();
    else setCreating(false);
  }, [isCreatePage]);

  useEffect(() => {
    if (!editChecklistId) {
      initializedEditIdRef.current = null;
      return;
    }
    if (loading || initializedEditIdRef.current === editChecklistId) return;
    initializedEditIdRef.current = editChecklistId;
    const row = rows.find((item) => item.id === editChecklistId && !item.isTemplate);
    if (row) {
      beginEdit(row);
      return;
    }
    showToast({ type: 'error', title: 'Чек-лист не найден' });
    navigate('/checklists', { replace: true });
  }, [editChecklistId, loading, navigate, rows, showToast]);

  const templates = rows.filter((item) => item.isTemplate);
  const companyRows = rows.filter((item) => !item.isTemplate && item.holdingId === selectedHoldingId);
  const total = useMemo(() => Math.round(items.reduce((sum, item) => {
    const raw = pointDrafts[item.id] ?? String(item.points);
    return sum + (Number(raw.replace(',', '.')) || 0);
  }, 0) * 10) / 10, [items, pointDrafts]);
  const hasInvalidPoints = useMemo(() => items.some((item) => {
    const value = Number((pointDrafts[item.id] ?? String(item.points)).replace(',', '.'));
    return !Number.isFinite(value) || value <= 0 || value > 100;
  }), [items, pointDrafts]);
  const editorOpen = creating || Boolean(editing);

  function beginCreate(template?: EvaluationChecklistItem) {
    const nextItems = template ? template.items.map((item) => ({ ...item, id: itemId() })) : [];
    setEditing(null);
    setCreating(true);
    setAsTemplate(false);
    setSourceTemplateId(template?.id || '');
    setName(template ? `${template.name} — копия` : '');
    setItems(nextItems);
    setPointDrafts(Object.fromEntries(nextItems.map((item) => [item.id, String(item.points)])));
  }

  function beginTemplate() {
    const nextItems: EvaluationChecklistItemDefinition[] = [];
    setEditing(null);
    setCreating(true);
    setAsTemplate(true);
    setSourceTemplateId('');
    setName('');
    setItems(nextItems);
    setPointDrafts(Object.fromEntries(nextItems.map((item) => [item.id, String(item.points)])));
  }

  function beginEdit(row: EvaluationChecklistItem) {
    const nextItems = row.items.map((item) => ({ ...item }));
    setCreating(false);
    setEditing(row);
    setAsTemplate(row.isTemplate);
    setSourceTemplateId(row.sourceTemplateId || '');
    setName(row.name);
    setItems(nextItems);
    setPointDrafts(Object.fromEntries(nextItems.map((item) => [item.id, String(item.points)])));
  }

  function closeEditor() {
    setCreating(false);
    setEditing(null);
    if (isChecklistFormPage) navigate('/checklists');
  }

  function openChecklistCreate() {
    navigate('/checklists/new');
  }

  function openChecklistEdit(row: EvaluationChecklistItem) {
    navigate(`/checklists/${encodeURIComponent(row.id)}/edit`);
  }

  function clearTemplateDraft() {
    setSourceTemplateId('');
    setName('');
    setItems([]);
    setPointDrafts({});
  }

  function navigateToSection(path: '/checklists' | '/checklists/templates') {
    setCreating(false);
    setEditing(null);
    navigate(path);
  }

  function patchItem(id: string, patch: Partial<EvaluationChecklistItemDefinition>) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || items.some((item) => !item.title.trim()) || hasInvalidPoints || total <= 0 || total > 100) return;
    if (!asTemplate && !selectedHoldingId) return;
    setSaving(true);
    try {
      const payloadItems = items.map((item) => ({
        ...item,
        title: item.title.trim(),
        instruction: item.instruction.trim() || item.title.trim(),
        points: Number((pointDrafts[item.id] ?? String(item.points)).replace(',', '.')),
      }));
      const saved = editing
        ? await updateEvaluationChecklist(editing.id, { name: name.trim(), items: payloadItems })
        : await createEvaluationChecklist({
          holdingId: asTemplate ? null : selectedHoldingId,
          name: name.trim(),
          isTemplate: asTemplate,
          sourceTemplateId: null,
          items: payloadItems,
        });
      setRows((current) => editing ? current.map((row) => row.id === saved.id ? saved : row) : [saved, ...current]);
      showToast({ type: 'success', title: editing ? 'Чек-лист обновлён' : 'Чек-лист создан', description: saved.name });
      setCreating(false);
      setEditing(null);
      if (!editing || isChecklistEditPage) navigate(asTemplate ? '/checklists/templates' : '/checklists');
    } catch (error) {
      showToast({ type: 'error', title: 'Не удалось сохранить чек-лист', description: error instanceof Error ? error.message : '' });
    } finally {
      setSaving(false);
    }
  }

  async function archive(row: EvaluationChecklistItem) {
    if (!window.confirm(`Архивировать «${row.name}»?`)) return;
    try {
      await archiveEvaluationChecklist(row.id);
      setRows((current) => current.filter((item) => item.id !== row.id));
      if (editing?.id === row.id) closeEditor();
    } catch (error) {
      showToast({ type: 'error', title: 'Не удалось архивировать чек-лист', description: error instanceof Error ? error.message : '' });
    }
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 4 }}>{isCreatePage ? 'Создание чек-листа' : isChecklistEditPage ? 'Редактирование чек-листа' : isTemplatesTab ? 'Шаблоны чек-листов' : 'Чек-листы'}</h1>
          <div className="sa-meta">Критерии, по которым оцениваются звонки и тренировки.</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <HoldingSelectPicker
            holdings={holdings}
            value={selectedHoldingId}
            onChange={setSelectedHoldingId}
            disabled={holdingsLoading || holdings.length === 0}
            loading={holdingsLoading}
          />
          {!isChecklistFormPage && isTemplatesTab && <button type="button" className="sa-btn-primary" onClick={beginTemplate}>Создать шаблон</button>}
          {!isChecklistFormPage && !isTemplatesTab && <button type="button" className="sa-btn-primary" onClick={openChecklistCreate} disabled={!selectedHoldingId}>Создать чек-лист</button>}
        </div>
      </div>

      {!isChecklistFormPage && (
        <div className="sa-dialog-tabs" role="tablist" aria-label="Раздел чек-листов">
          <button type="button" role="tab" aria-selected={!isTemplatesTab} className={`sa-dialog-tab ${!isTemplatesTab ? 'sa-dialog-tab-active' : ''}`} onClick={() => navigateToSection('/checklists')}>Чек-листы</button>
          {isSuperadmin && <button type="button" role="tab" aria-selected={isTemplatesTab} className={`sa-dialog-tab ${isTemplatesTab ? 'sa-dialog-tab-active' : ''}`} onClick={() => navigateToSection('/checklists/templates')}>Шаблоны</button>}
        </div>
      )}

      {editorOpen && (
        <form className="sa-card" onSubmit={save} style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>{editing ? editing.isTemplate ? 'Редактирование шаблона' : 'Редактирование чек-листа' : asTemplate ? 'Новый шаблон' : 'Новый чек-лист'}</h2>
            <button type="button" className="sa-btn-text" onClick={closeEditor}>Закрыть</button>
          </div>
          {!editing && !asTemplate && templates.length > 0 && (
            <label style={{ display: 'grid', gap: 6 }}><span>Создать из шаблона</span>
              <select className="sa-input" value={sourceTemplateId} onChange={(event) => {
                const template = templates.find((row) => row.id === event.target.value);
                if (template) beginCreate(template); else clearTemplateDraft();
              }}><option value="">Без шаблона</option>{templates.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
            </label>
          )}
          <label style={{ display: 'grid', gap: 6 }}><span>Название</span><input className="sa-input" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>Пункты</strong>
              <div className="sa-meta" style={{ marginTop: 4 }}>«Не применимо» разрешает исключить пункт из оценки, если эта тема не возникла в разговоре.</div>
            </div>
            <span className={total > 100 ? 'sa-text-danger' : 'sa-meta'}>Сумма: {total} / 100</span>
          </div>
          {items.map((item, index) => (
            <div key={item.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.2fr) minmax(220px, 2fr) minmax(170px, 1fr) 100px auto auto', gap: 8, alignItems: 'center' }}>
              <input className="sa-input" placeholder={`Пункт ${index + 1}`} value={item.title} onChange={(event) => patchItem(item.id, { title: event.target.value })} />
              <input className="sa-input" placeholder="Что должен проверить AI" value={item.instruction} onChange={(event) => patchItem(item.id, { instruction: event.target.value })} />
              <select className="sa-input" value={item.category} onChange={(event) => patchItem(item.id, { category: event.target.value })}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select>
              <input
                className="sa-input"
                type="text"
                inputMode="decimal"
                placeholder="Баллы"
                value={pointDrafts[item.id] ?? String(item.points)}
                onChange={(event) => {
                  const value = event.target.value.replace(/[^0-9.,]/g, '').replace(/([.,].*)[.,]/g, '$1');
                  setPointDrafts((current) => ({ ...current, [item.id]: value }));
                }}
              />
              <label className="sa-filter-check" title="AI сможет отметить пункт как неприменимый и исключить его из расчёта">
                <input type="checkbox" checked={item.allowNa} onChange={(event) => patchItem(item.id, { allowNa: event.target.checked })} />
                Можно не применять
              </label>
              <button type="button" className="sa-btn-text" onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}>Удалить</button>
            </div>
          ))}
          <button type="button" className="sa-btn-outline" onClick={() => {
            const next = blankItem();
            setItems((current) => [...current, next]);
            setPointDrafts((current) => ({ ...current, [next.id]: String(next.points) }));
          }}>Добавить пункт</button>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="sa-btn-outline" onClick={closeEditor}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={saving || !name.trim() || hasInvalidPoints || total <= 0 || total > 100 || items.some((item) => !item.title.trim())}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
          </div>
        </form>
      )}

      {isChecklistEditPage && !editing && <section className="sa-card checklist-empty">Загрузка чек-листа…</section>}

      {isTemplatesTab && (
        <ChecklistList rows={templates} loading={loading} emptyText="Шаблоны ещё не созданы." onEdit={beginEdit} onArchive={archive} />
      )}

      {!isChecklistFormPage && !isTemplatesTab && (
        <ChecklistList rows={companyRows} loading={loading} emptyText="Чек-листы ещё не созданы." onEdit={openChecklistEdit} onArchive={archive} />
      )}
    </div>
  );
}
