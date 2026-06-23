import React, { useEffect, useMemo, useState } from 'react';
import {
  analyzeImportSource,
  createImportSource,
  deleteImportSource,
  fetchImportDetail,
  fetchImportedItems,
  fetchImportedTags,
  fetchImports,
  fetchHoldings,
  generateImportTagRule,
  generateImportTagRules,
  runImportSource,
  updateImportSource,
  type ImportAIConfig,
  type ImportedDataItem,
  type ImportPreviewItem,
  type ImportRunItem,
  type ImportSourceItem,
  type ImportTagOperator,
  type ImportTagRule,
  type HoldingItem,
} from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';

type WizardStep = 1 | 2 | 3;
type DataPageTab = 'data' | 'imports';
type DescriptionModalItem = {
  title: string;
  sourceName: string;
  description: string;
};
type TagsModalItem = {
  title: string;
  tags: string[];
};
type ImportEditModalItem = ImportSourceItem;
type ImportInfoModalData = {
  item: ImportSourceItem;
  runs: ImportRunItem[];
};

const EMPTY_AI_CONFIG: ImportAIConfig = {
  entityType: 'item',
  externalIdField: null,
  titleFields: [],
  descriptionFields: [],
  fieldLabels: {},
  importantFields: [],
  ignoredFields: [],
};

const OPERATORS: { value: ImportTagOperator; label: string }[] = [
  { value: 'equals', label: 'Равно' },
  { value: 'notEquals', label: 'Не равно' },
  { value: 'contains', label: 'Содержит' },
  { value: 'notContains', label: 'Не содержит' },
  { value: 'exists', label: 'Поле заполнено' },
  { value: 'notExists', label: 'Поле пустое' },
  { value: 'greaterThan', label: 'Больше' },
  { value: 'lessThan', label: 'Меньше' },
  { value: 'greaterOrEqual', label: 'Больше или равно' },
  { value: 'lessOrEqual', label: 'Меньше или равно' },
  { value: 'in', label: 'Одно из значений' },
  { value: 'regex', label: 'По шаблону' },
];

const DATA_PAGE_SIZE = 25;

function overlayCardStyle(width = 920): React.CSSProperties {
  return {
    width: `min(100%, ${width}px)`,
    maxHeight: '90vh',
    overflowY: 'auto',
    background: '#fff',
    borderRadius: 24,
    boxShadow: '0 28px 80px rgba(15,23,42,0.28)',
    padding: 22,
  };
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

function statusLabel(status: ImportSourceItem['status']): string {
  if (status === 'active') return 'Активен';
  if (status === 'paused') return 'Пауза';
  return 'Ошибка';
}

function runStatusLabel(status: ImportRunItem['status']): string {
  if (status === 'success') return 'Успешно';
  if (status === 'running') return 'Выполняется';
  return 'Ошибка';
}

function scheduleLabel(value: string | null | undefined): string {
  if (!value) return 'Вручную';
  if (value === 'hourly') return 'Раз в час';
  if (value === 'daily') return 'Раз в день';
  if (value === 'weekly') return 'Раз в неделю';
  return value;
}

function stringifyRuleValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseRuleValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.includes(',')) return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  return trimmed;
}

function operatorLabel(value: ImportTagOperator): string {
  return OPERATORS.find((operator) => operator.value === value)?.label || value;
}

function flattenFields(value: unknown, prefix = '', out = new Set<string>()): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out.add(prefix);
    return Array.from(out);
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) flattenFields(nested, path, out);
    else out.add(path);
  }
  return Array.from(out);
}

function flattenFieldsFromItems(items: unknown[]): string[] {
  const out = new Set<string>();
  items.forEach((item) => flattenFields(item, '', out));
  return Array.from(out);
}

function compactList(values: string[], fallback = 'Определим автоматически'): string {
  const clean = values.map((value) => value.trim()).filter(Boolean);
  if (clean.length === 0) return fallback;
  return clean.slice(0, 3).join(', ') + (clean.length > 3 ? ` +${clean.length - 3}` : '');
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function lineClampStyle(lines: number): React.CSSProperties {
  return {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: lines,
    overflow: 'hidden',
    whiteSpace: 'pre-line',
  };
}

function CompactTagsCell(props: {
  tags: string[];
  onOpen: () => void;
}) {
  if (props.tags.length === 0) return <span className="sa-meta">—</span>;
  const visible = props.tags.slice(0, 2);
  const hiddenCount = Math.max(0, props.tags.length - visible.length);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, maxWidth: 220, overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {visible.map((tag) => (
        <span
          key={tag}
          className="sa-chip"
          title={tag}
          style={{ maxWidth: 94, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}
        >
          {tag}
        </span>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="sa-btn-outline sa-btn-sm"
          onClick={props.onOpen}
          style={{ padding: '4px 8px', minHeight: 26, flex: '0 0 auto' }}
          title={props.tags.join(', ')}
        >
          +{hiddenCount}
        </button>
      )}
    </div>
  );
}

function TagsModal(props: {
  item: TagsModalItem | null;
  onClose: () => void;
}) {
  if (!props.item) return null;
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 130 }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle(640)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>Теги</h2>
            <div style={{ marginTop: 6, color: 'var(--sa-text-secondary)', fontSize: 13, ...lineClampStyle(1) }}>{props.item.title}</div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {props.item.tags.map((tag) => (
            <span key={tag} className="sa-chip" title={tag} style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tag}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TagFilterPicker(props: {
  availableTags: string[];
  selectedTags: string[];
  loading: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTags = props.availableTags
    .filter((tag) => !props.selectedTags.includes(tag))
    .filter((tag) => !normalizedQuery || tag.toLowerCase().includes(normalizedQuery))
    .slice(0, 30);

  function addTag(tag: string) {
    props.onChange([...props.selectedTags, tag]);
    setQuery('');
    setOpen(false);
  }

  return (
    <div style={{ position: 'relative', display: 'grid', gap: 8 }}>
      <input
        className="sa-input"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        placeholder={props.loading ? 'Загружаем теги...' : 'Найти тег'}
        disabled={props.loading || props.availableTags.length === 0}
      />
      {open && !props.loading && (
        <div style={{ position: 'absolute', top: 44, left: 0, right: 0, zIndex: 20, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--sa-divider)', borderRadius: 12, background: '#fff', boxShadow: '0 18px 36px rgba(15,23,42,0.14)', padding: 6 }}>
          {filteredTags.length ? filteredTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onMouseDown={(event) => { event.preventDefault(); addTag(tag); }}
              style={{ width: '100%', border: 0, background: 'transparent', padding: '8px 10px', textAlign: 'left', borderRadius: 8, cursor: 'pointer', color: 'var(--sa-text)' }}
            >
              {tag}
            </button>
          )) : (
            <div className="sa-meta" style={{ padding: 10 }}>Теги не найдены</div>
          )}
        </div>
      )}
      {props.selectedTags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {props.selectedTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="sa-chip"
              onClick={() => props.onChange(props.selectedTags.filter((item) => item !== tag))}
              title="Убрать фильтр"
              style={{ border: 0, cursor: 'pointer', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {tag} ×
            </button>
          ))}
          <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => props.onChange([])}>Сбросить</button>
        </div>
      )}
    </div>
  );
}

function DescriptionModal(props: {
  item: DescriptionModalItem | null;
  onClose: () => void;
}) {
  if (!props.item) return null;
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 130 }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle(760)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22 }}>{props.item.title}</h2>
            <div style={{ marginTop: 6, color: 'var(--sa-text-secondary)', fontSize: 13 }}>{props.item.sourceName}</div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            fontFamily: 'inherit',
            color: 'var(--sa-text)',
            lineHeight: 1.55,
            fontSize: 14,
          }}
        >
          {props.item.description}
        </pre>
      </div>
    </div>
  );
}

function TagRulesEditor(props: {
  availableFields: string[];
  tagRules: ImportTagRule[];
  onChange: (rules: ImportTagRule[]) => void;
}) {
  const [ruleName, setRuleName] = useState('');
  const [ruleField, setRuleField] = useState('');
  const [ruleOperator, setRuleOperator] = useState<ImportTagOperator>('equals');
  const [ruleValue, setRuleValue] = useState('');
  const [aiRuleText, setAiRuleText] = useState('');
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRule(ruleId: string, patch: Partial<ImportTagRule>) {
    props.onChange(props.tagRules.map((item) => (item.id === ruleId ? { ...item, ...patch } : item)));
  }

  function updateRuleCondition(ruleId: string, patch: Partial<ImportTagRule['condition']>) {
    props.onChange(props.tagRules.map((item) => (
      item.id === ruleId ? { ...item, condition: { ...item.condition, ...patch } } : item
    )));
  }

  function addManualRule() {
    if (!ruleName.trim() || !ruleField.trim()) return;
    props.onChange([
      ...props.tagRules,
      {
        id: `rule-${Date.now()}`,
        name: ruleName.trim(),
        enabled: true,
        condition: { field: ruleField.trim(), operator: ruleOperator, value: parseRuleValue(ruleValue) },
      },
    ]);
    setRuleName('');
    setRuleField('');
    setRuleValue('');
    setRuleOperator('equals');
    setManualModalOpen(false);
  }

  async function addAiRule() {
    setBusy(true);
    setError(null);
    try {
      const generated = await generateImportTagRule({ text: aiRuleText, availableFields: props.availableFields });
      props.onChange([...props.tagRules, { id: `rule-${Date.now()}`, enabled: true, ...generated }]);
      setAiRuleText('');
      setAiModalOpen(false);
    } catch (ruleError) {
      setError(ruleError instanceof Error ? ruleError.message : 'Не удалось сформировать правило.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>{error}</div>}

      <section style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h4 style={{ margin: '0 0 4px', fontSize: 16 }}>Правила автотегов</h4>
            <div className="sa-meta">Источник будет сам проставлять эти теги при импорте.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="sa-chip">{props.tagRules.length} правил</span>
            <button className="sa-btn-outline sa-btn-sm" onClick={() => { setError(null); setManualModalOpen(true); }}>Добавить вручную</button>
            <button className="sa-btn-primary sa-btn-sm" onClick={() => { setError(null); setAiModalOpen(true); }}>AI-правило</button>
          </div>
        </div>
        {props.tagRules.length ? props.tagRules.map((rule, index) => (
          <div key={rule.id} style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: '8px 10px', display: 'grid', gridTemplateColumns: 'minmax(118px, 1.1fr) minmax(118px, 1fr) minmax(118px, 1fr) minmax(100px, 0.8fr) auto auto', gap: 8, alignItems: 'center', overflowX: 'auto', background: rule.enabled ? '#fff' : '#f9fafb' }}>
            <input className="sa-input" style={{ minHeight: 34, height: 34 }} aria-label={`Тег правила ${index + 1}`} value={rule.name} onChange={(event) => updateRule(rule.id, { name: event.target.value })} />
            <select className="sa-select" style={{ minHeight: 34, height: 34 }} aria-label="Поле" value={rule.condition.field} onChange={(event) => updateRuleCondition(rule.id, { field: event.target.value })}>
              {props.availableFields.includes(rule.condition.field) ? null : <option value={rule.condition.field}>{rule.condition.field}</option>}
              {props.availableFields.map((field) => <option key={field} value={field}>{field}</option>)}
            </select>
            <select className="sa-select" style={{ minHeight: 34, height: 34 }} aria-label="Условие" value={rule.condition.operator} onChange={(event) => updateRuleCondition(rule.id, { operator: event.target.value as ImportTagOperator })}>
              {OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
            </select>
            <input className="sa-input" style={{ minHeight: 34, height: 34 }} aria-label="Значение" placeholder={operatorLabel(rule.condition.operator)} value={stringifyRuleValue(rule.condition.value)} onChange={(event) => updateRuleCondition(rule.id, { value: parseRuleValue(event.target.value) })} />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--sa-text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
              />
              Вкл.
            </label>
            <button className="sa-btn-outline sa-btn-sm" onClick={() => props.onChange(props.tagRules.filter((item) => item.id !== rule.id))}>Удалить</button>
          </div>
        )) : (
          <div style={{ padding: 14, border: '1px dashed var(--sa-divider)', borderRadius: 12, color: 'var(--sa-text-secondary)', fontSize: 14 }}>
            Правил пока нет. Добавьте вручную или сформируйте через AI.
          </div>
        )}
      </section>

      {manualModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 140 }} onClick={() => setManualModalOpen(false)}>
          <div style={overlayCardStyle(620)} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 20 }}>Добавить правило</h3>
                <div className="sa-meta" style={{ marginTop: 4 }}>Выберите тег и условие, при котором он ставится.</div>
              </div>
              <button type="button" className="sa-btn-outline sa-btn-icon" onClick={() => setManualModalOpen(false)} aria-label="Закрыть">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="sa-meta">Название тега</span>
                <input className="sa-input" autoFocus placeholder="Например: VIP" value={ruleName} onChange={(event) => setRuleName(event.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="sa-meta">Поле данных</span>
                <select className="sa-select" value={ruleField} onChange={(event) => setRuleField(event.target.value)}>
                  <option value="">Выберите поле</option>
                  {props.availableFields.map((field) => <option key={field} value={field}>{field}</option>)}
                </select>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span className="sa-meta">Условие</span>
                  <select className="sa-select" value={ruleOperator} onChange={(event) => setRuleOperator(event.target.value as ImportTagOperator)}>
                    {OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span className="sa-meta">Значение</span>
                  <input className="sa-input" placeholder="С чем сравнить" value={ruleValue} onChange={(event) => setRuleValue(event.target.value)} />
                </label>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="sa-btn-outline" onClick={() => setManualModalOpen(false)}>Отмена</button>
                <button className="sa-btn-primary" disabled={!ruleName.trim() || !ruleField.trim()} onClick={addManualRule}>Добавить</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {aiModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 140 }} onClick={() => setAiModalOpen(false)}>
          <div style={overlayCardStyle(620)} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 20 }}>AI-правило</h3>
                <div className="sa-meta" style={{ marginTop: 4 }}>Опишите обычными словами, какой тег и когда ставить.</div>
              </div>
              <button type="button" className="sa-btn-outline sa-btn-icon" onClick={() => setAiModalOpen(false)} aria-label="Закрыть">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <textarea className="sa-input" autoFocus rows={4} value={aiRuleText} onChange={(event) => setAiRuleText(event.target.value)} placeholder="Например: проставь тег Комиссия, если в данных есть комиссия" />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="sa-btn-outline" onClick={() => setAiModalOpen(false)}>Отмена</button>
                <button className="sa-btn-primary" disabled={busy || !aiRuleText.trim()} onClick={() => void addAiRule()}>{busy ? 'Создаем...' : 'Создать правило'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fieldsFromImportSource(item: ImportSourceItem): string[] {
  return Array.from(new Set([
    ...item.aiConfig.importantFields,
    ...item.aiConfig.titleFields,
    ...item.aiConfig.descriptionFields,
    ...Object.keys(item.aiConfig.fieldLabels || {}),
    item.aiConfig.externalIdField || '',
  ].map((field) => field.trim()).filter(Boolean)));
}

function fieldsFromImportedItems(items: ImportedDataItem[]): string[] {
  const out = new Set<string>();
  items.forEach((item) => {
    flattenFields(item.rawData, '', out);
    flattenFields(item.normalizedData, '', out);
  });
  return Array.from(out);
}

function ImportEditModal(props: {
  item: ImportEditModalItem | null;
  onClose: () => void;
  onSaved: (item: ImportSourceItem) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [schedule, setSchedule] = useState('manual');
  const [status, setStatus] = useState<ImportSourceItem['status']>('active');
  const [tagRules, setTagRules] = useState<ImportTagRule[]>([]);
  const [editTab, setEditTab] = useState<'settings' | 'tags'>('settings');
  const [sourceFields, setSourceFields] = useState<string[]>([]);
  const [sourceFieldsLoading, setSourceFieldsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.item) return;
    setName(props.item.name);
    setUrl(props.item.url);
    setSchedule(props.item.schedule || 'manual');
    setStatus(props.item.status);
    setTagRules(props.item.tagRules);
    setEditTab('settings');
    setSourceFields(fieldsFromImportSource(props.item));
    setError(null);
  }, [props.item]);

  useEffect(() => {
    if (!props.item) return;
    let cancelled = false;
    setSourceFieldsLoading(true);
    fetchImportedItems({ sourceId: props.item.id, limit: 100 })
      .then((result) => {
        if (cancelled || !props.item) return;
        setSourceFields(Array.from(new Set([
          ...fieldsFromImportSource(props.item),
          ...fieldsFromImportedItems(result.items),
        ])));
      })
      .catch(() => {
        if (!cancelled && props.item) setSourceFields(fieldsFromImportSource(props.item));
      })
      .finally(() => {
        if (!cancelled) setSourceFieldsLoading(false);
      });
    return () => { cancelled = true; };
  }, [props.item]);

  if (!props.item) return null;

  async function save() {
    if (!props.item) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateImportSource(props.item.id, {
        name: name.trim(),
        url: url.trim(),
        schedule: schedule === 'manual' ? null : schedule,
        status,
        tagRules,
      });
      props.onSaved(updated);
      props.onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить импорт.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 130 }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle(980)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>Редактировать импорт</h2>
            <div style={{ marginTop: 6, color: 'var(--sa-text-secondary)', fontSize: 13 }}>{props.item.format} · {props.item.itemsPath}</div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {error && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14, marginBottom: 14 }}>{error}</div>}

        <div style={{ display: 'grid', gap: 18 }}>
          <section className="sa-card" style={{ padding: 14, display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
              <div><div className="sa-meta">Статус</div><strong>{statusLabel(status)}</strong></div>
              <div><div className="sa-meta">Запуск</div><strong>{scheduleLabel(schedule === 'manual' ? null : schedule)}</strong></div>
              <div><div className="sa-meta">Формат</div><strong>{props.item.format.toUpperCase()}</strong></div>
              <div><div className="sa-meta">Правил тегов</div><strong>{tagRules.length}</strong></div>
            </div>
            <div>
              <div className="sa-meta">Источник данных</div>
              <div style={{ wordBreak: 'break-all' }}>{url}</div>
            </div>
          </section>

          <div className="sa-dialog-tabs" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className={`sa-dialog-tab ${editTab === 'settings' ? 'sa-dialog-tab-active' : ''}`}
              onClick={() => setEditTab('settings')}
            >
              Настройки
            </button>
            <button
              type="button"
              className={`sa-dialog-tab ${editTab === 'tags' ? 'sa-dialog-tab-active' : ''}`}
              onClick={() => setEditTab('tags')}
            >
              Теги
            </button>
          </div>

          {editTab === 'settings' && (
            <section className="sa-card" style={{ padding: 16, display: 'grid', gap: 14 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>Настройки источника</h3>
                <div className="sa-meta">Здесь меняются название, ссылка, периодичность и состояние импорта.</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span>Название</span>
                  <input className="sa-input" value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span>URL источника</span>
                  <input className="sa-input" value={url} onChange={(event) => setUrl(event.target.value)} />
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span>Периодичность запуска</span>
                  <select className="sa-select" value={schedule} onChange={(event) => setSchedule(event.target.value)}>
                    <option value="manual">Вручную</option>
                    <option value="hourly">Раз в час</option>
                    <option value="daily">Раз в день</option>
                    <option value="weekly">Раз в неделю</option>
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span>Состояние</span>
                  <select className="sa-select" value={status} onChange={(event) => setStatus(event.target.value as ImportSourceItem['status'])}>
                    <option value="active">Активен</option>
                    <option value="paused">Пауза</option>
                    <option value="error">Ошибка</option>
                  </select>
                </label>
              </div>
            </section>
          )}

          {editTab === 'tags' && (
            <section className="sa-card" style={{ padding: 16, display: 'grid', gap: 14 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>Правила тегов</h3>
                <div className="sa-meta">
                  Теги автоматически проставляются новым данным при запуске этого импорта.
                  {sourceFieldsLoading ? ' Загружаем поля из данных...' : ` Доступно полей: ${sourceFields.length}.`}
                </div>
              </div>
              <TagRulesEditor availableFields={sourceFields} tagRules={tagRules} onChange={setTagRules} />
            </section>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', borderTop: '1px solid var(--sa-divider)', paddingTop: 14, flexWrap: 'wrap' }}>
            <div className="sa-meta">Изменения применятся после сохранения.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="sa-btn-outline" onClick={props.onClose}>Отмена</button>
              <button className="sa-btn-primary" disabled={busy || !name.trim() || !url.trim()} onClick={() => void save()}>
                {busy ? 'Сохраняем...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportInfoModal(props: {
  data: ImportInfoModalData | null;
  onClose: () => void;
}) {
  if (!props.data) return null;
  const { item, runs } = props.data;
  const latestRuns = runs.slice(0, 5);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 130 }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle(860)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{item.name}</h2>
            <div style={{ marginTop: 6, color: 'var(--sa-text-secondary)', fontSize: 13 }}>Информация об импорте</div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          <section className="sa-card" style={{ padding: 14, display: 'grid', gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Основное</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <div><div className="sa-meta">Статус</div><strong>{statusLabel(item.status)}</strong></div>
              <div><div className="sa-meta">Запуск</div><strong>{scheduleLabel(item.schedule)}</strong></div>
              <div><div className="sa-meta">Формат</div><strong>{item.format.toUpperCase()}</strong></div>
              <div><div className="sa-meta">Загружено данных</div><strong>{item.itemsCount}</strong></div>
              <div><div className="sa-meta">Последний запуск</div><strong>{formatDate(item.lastRunAt)}</strong></div>
            </div>
            <div>
              <div className="sa-meta">Источник</div>
              <div style={{ wordBreak: 'break-all' }}>{item.url}</div>
            </div>
            {item.lastError && (
              <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
                Последняя ошибка: {item.lastError}
              </div>
            )}
          </section>

          <section className="sa-card" style={{ padding: 14, display: 'grid', gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Теги</h3>
            {item.tagRules.length ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {item.tagRules.map((rule) => (
                  <div key={rule.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--sa-divider)' }}>
                    <div>
                      <strong>{rule.name}</strong>
                      <div className="sa-meta">{rule.condition.field} {rule.condition.operator} {stringifyRuleValue(rule.condition.value)}</div>
                    </div>
                    <span className="sa-chip">{rule.enabled ? 'Включен' : 'Выключен'}</span>
                  </div>
                ))}
              </div>
            ) : <div className="sa-meta">Правила тегов пока не настроены.</div>}
          </section>

          <section className="sa-card" style={{ padding: 14, display: 'grid', gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Последние 5 запусков</h3>
            {latestRuns.length ? (
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Статус</th>
                      <th className="sa-text-right">Найдено</th>
                      <th className="sa-text-right">Новых</th>
                      <th className="sa-text-right">Обновлено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestRuns.map((run) => (
                      <tr key={run.id}>
                        <td>{formatDate(run.startedAt)}</td>
                        <td>{runStatusLabel(run.status)}</td>
                        <td className="sa-text-right">{run.totalItems}</td>
                        <td className="sa-text-right">{run.createdItems}</td>
                        <td className="sa-text-right">{run.updatedItems}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="sa-meta">Запусков пока не было.</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

function ImportWizard(props: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  holdings: HoldingItem[];
  selectedHoldingId: string | null;
}) {
  const [step, setStep] = useState<WizardStep>(1);
  const [holdingId, setHoldingId] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [schedule, setSchedule] = useState('manual');
  const [format, setFormat] = useState<ImportSourceItem['format']>('json');
  const [itemsPath, setItemsPath] = useState('');
  const [sampleItems, setSampleItems] = useState<unknown[]>([]);
  const [aiConfig, setAiConfig] = useState<ImportAIConfig>(EMPTY_AI_CONFIG);
  const [previewItems, setPreviewItems] = useState<ImportPreviewItem[]>([]);
  const [tagRules, setTagRules] = useState<ImportTagRule[]>([]);
  const [autoRulesGenerated, setAutoRulesGenerated] = useState(false);
  const [autoRulesBusy, setAutoRulesBusy] = useState(false);
  const [autoRulesError, setAutoRulesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableFields = useMemo(() => flattenFieldsFromItems(sampleItems), [sampleItems]);

  useEffect(() => {
    if (!props.open) return;
    setStep(1);
    setHoldingId(props.selectedHoldingId || props.holdings[0]?.id || '');
    setName('');
    setUrl('');
    setSchedule('manual');
    setFormat('json');
    setItemsPath('');
    setSampleItems([]);
    setAiConfig(EMPTY_AI_CONFIG);
    setPreviewItems([]);
    setTagRules([]);
    setAutoRulesGenerated(false);
    setAutoRulesBusy(false);
    setAutoRulesError(null);
    setError(null);
  }, [props.open, props.selectedHoldingId, props.holdings]);

  if (!props.open) return null;

  async function generateAutoRules(sample: unknown[], fields: string[]) {
    if (sample.length === 0 || fields.length === 0) return;
    setAutoRulesBusy(true);
    setAutoRulesError(null);
    try {
      const generatedRules = await generateImportTagRules({ sampleItems: sample.slice(0, 5), availableFields: fields });
      setTagRules(generatedRules);
      setAutoRulesGenerated(true);
    } catch (rulesError) {
      setAutoRulesError(rulesError instanceof Error ? rulesError.message : 'Не удалось сформировать автотеги.');
      setAutoRulesGenerated(true);
    } finally {
      setAutoRulesBusy(false);
    }
  }

  async function analyze() {
    setBusy(true);
    setError(null);
    setAutoRulesError(null);
    try {
      const result = await analyzeImportSource(url);
      const resultFields = flattenFieldsFromItems(result.sampleItems);
      setFormat(result.format);
      setItemsPath(result.itemsPath);
      setSampleItems(result.sampleItems);
      setAiConfig(result.aiConfig);
      setPreviewItems(result.previewItems);
      setTagRules([]);
      setAutoRulesGenerated(false);
      setStep(2);
      void generateAutoRules(result.sampleItems, resultFields);
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : 'Не удалось проанализировать источник.');
    } finally {
      setBusy(false);
    }
  }

  async function openTagStep() {
    setStep(3);
    if (!autoRulesGenerated && !autoRulesBusy && tagRules.length === 0) void generateAutoRules(sampleItems, availableFields);
  }

  async function saveImport() {
    setBusy(true);
    setError(null);
    try {
      await createImportSource({
        holdingId,
        name: name.trim(),
        url,
        format,
        schedule: schedule === 'manual' ? null : schedule,
        itemsPath,
        aiConfig,
        tagRules,
      });
      props.onSaved();
      props.onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить импорт.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 120 }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle()} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>Создать импорт</h2>
            <div style={{ marginTop: 6, color: 'var(--sa-text-secondary)', fontSize: 13 }}>Шаг {step} из 3</div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {error && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14, marginBottom: 14 }}>{error}</div>}

        {step === 1 && (
          <form onSubmit={(event) => { event.preventDefault(); void analyze(); }} style={{ display: 'grid', gap: 14 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Название</span>
              <input className="sa-input" value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Компания</span>
              <select className="sa-select" value={holdingId} onChange={(event) => setHoldingId(event.target.value)} required>
                <option value="">Выберите компанию</option>
                {props.holdings.map((holding) => <option key={holding.id} value={holding.id}>{holding.name}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>URL источника</span>
              <input className="sa-input" value={url} onChange={(event) => setUrl(event.target.value)} required placeholder="https://example.com/feed.xml" />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Периодичность</span>
              <select className="sa-select" value={schedule} onChange={(event) => setSchedule(event.target.value)}>
                <option value="manual">Вручную</option>
                <option value="hourly">Раз в час</option>
                <option value="daily">Раз в день</option>
                <option value="weekly">Раз в неделю</option>
              </select>
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="sa-btn-primary" disabled={busy || !holdingId || !name.trim() || !url.trim()}>
                {busy ? 'Анализируем...' : 'Проанализировать источник'}
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <h3 style={{ margin: 0, fontSize: 18 }}>Источник распознан</h3>
              <div className="sa-meta">Проверили структуру данных и подготовили понятный вид для импорта.</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
              <div style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: 12, background: '#fff' }}>
                <div className="sa-meta">Нашли примеров</div>
                <strong style={{ display: 'block', marginTop: 4, fontSize: 20 }}>{sampleItems.length}</strong>
              </div>
              <div style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: 12, background: '#fff' }}>
                <div className="sa-meta">Название элемента</div>
                <strong style={{ display: 'block', marginTop: 4, fontSize: 14, ...lineClampStyle(1) }}>{compactList(aiConfig.titleFields)}</strong>
              </div>
              <div style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: 12, background: '#fff' }}>
                <div className="sa-meta">Описание собираем из</div>
                <strong style={{ display: 'block', marginTop: 4, fontSize: 14, ...lineClampStyle(1) }}>{compactList(aiConfig.descriptionFields, 'ключевых полей')}</strong>
              </div>
              <div style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: 12, background: '#fff' }}>
                <div className="sa-meta">Автотеги</div>
                <strong style={{ display: 'block', marginTop: 4, fontSize: 14, ...lineClampStyle(1) }}>
                  {autoRulesBusy ? 'Готовим...' : tagRules.length ? `Готово: ${tagRules.length}` : autoRulesGenerated ? 'Не сформированы' : 'Запускаем'}
                </strong>
              </div>
            </div>
            {autoRulesError && (
              <div style={{ padding: 10, borderRadius: 12, background: '#fff7ed', color: '#9a3412', fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>Автотеги не сформировались автоматически. Их можно добавить на следующем шаге.</span>
                <button
                  type="button"
                  className="sa-btn-outline sa-btn-sm"
                  disabled={autoRulesBusy || sampleItems.length === 0 || availableFields.length === 0}
                  onClick={() => void generateAutoRules(sampleItems, availableFields)}
                >
                  {autoRulesBusy ? 'Пробуем...' : 'Попробовать снова'}
                </button>
              </div>
            )}
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                <strong style={{ fontSize: 15 }}>Примеры данных</strong>
                <span className="sa-chip">{format.toUpperCase()}</span>
              </div>
              {previewItems.slice(0, 3).map((item, index) => (
                <div key={index} style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: '10px 12px', background: '#fff', display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="sa-chip">#{index + 1}</span>
                    <strong style={{ ...lineClampStyle(1) }}>{item.title}</strong>
                  </div>
                  <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13, ...lineClampStyle(2) }}>{item.description}</div>
                </div>
              ))}
              {previewItems.length > 3 && <div className="sa-meta">Еще {previewItems.length - 3} примера скрыты, чтобы не перегружать окно.</div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button className="sa-btn-outline" onClick={() => setStep(1)}>Назад</button>
              <button className="sa-btn-primary" disabled={busy} onClick={() => void openTagStep()}>
                {autoRulesBusy ? 'Теги готовятся...' : 'Настроить теги'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'grid', gap: 16 }}>
            <TagRulesEditor availableFields={availableFields} tagRules={tagRules} onChange={setTagRules} />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button className="sa-btn-outline" onClick={() => setStep(2)}>Назад</button>
              <button className="sa-btn-primary" disabled={busy} onClick={() => void saveImport()}>{busy ? 'Сохраняем...' : 'Сохранить импорт'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ImportsPage() {
  const [activePageTab, setActivePageTab] = useState<DataPageTab>('data');
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [items, setItems] = useState<ImportSourceItem[]>([]);
  const [dataItems, setDataItems] = useState<ImportedDataItem[]>([]);
  const [dataTotal, setDataTotal] = useState(0);
  const [dataPage, setDataPage] = useState(0);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [filtersLoading, setFiltersLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editModalItem, setEditModalItem] = useState<ImportEditModalItem | null>(null);
  const [infoModalData, setInfoModalData] = useState<ImportInfoModalData | null>(null);
  const [descriptionModalItem, setDescriptionModalItem] = useState<DescriptionModalItem | null>(null);
  const [tagsModalItem, setTagsModalItem] = useState<TagsModalItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);

  async function loadHoldings() {
    setHoldingsLoading(true);
    try {
      const next = await fetchHoldings({ status: 'active' });
      setHoldings(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить компании.');
    } finally {
      setHoldingsLoading(false);
    }
  }

  async function loadList() {
    if (!selectedHoldingId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await fetchImports({ holdingId: selectedHoldingId });
      setItems(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить импорты.');
    } finally {
      setLoading(false);
    }
  }

  async function loadDataItems() {
    if (!selectedHoldingId) {
      setDataItems([]);
      setDataTotal(0);
      setDataLoading(false);
      return;
    }
    setDataLoading(true);
    setDataError(null);
    try {
      const result = await fetchImportedItems({
        limit: DATA_PAGE_SIZE,
        offset: dataPage * DATA_PAGE_SIZE,
        holdingId: selectedHoldingId,
        search,
        tags: selectedTags,
      });
      setDataItems(result.items);
      setDataTotal(result.total);
    } catch (loadError) {
      setDataError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить данные.');
    } finally {
      setDataLoading(false);
    }
  }

  async function loadTags() {
    if (!selectedHoldingId) {
      setAvailableTags([]);
      setSelectedTags([]);
      setFiltersLoading(false);
      return;
    }
    setFiltersLoading(true);
    try {
      const tags = await fetchImportedTags({ holdingId: selectedHoldingId });
      setAvailableTags(tags);
      setSelectedTags((current) => current.filter((tag) => tags.includes(tag)));
    } finally {
      setFiltersLoading(false);
    }
  }

  useEffect(() => { void loadHoldings(); }, []);
  useEffect(() => {
    void loadList();
    void loadTags();
  }, [selectedHoldingId]);
  useEffect(() => { void loadDataItems(); }, [selectedHoldingId, search, selectedTags, dataPage]);
  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(dataTotal / DATA_PAGE_SIZE) - 1);
    if (dataPage > maxPage) setDataPage(maxPage);
  }, [dataTotal, dataPage]);

  async function runImport(id: string) {
    setBusyId(id);
    try {
      await runImportSource(id);
      await loadList();
      await loadDataItems();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Не удалось запустить импорт.');
    } finally {
      setBusyId(null);
    }
  }

  async function togglePause(item: ImportSourceItem) {
    setBusyId(item.id);
    try {
      await updateImportSource(item.id, { status: item.status === 'paused' ? 'active' : 'paused' });
      await loadList();
    } finally {
      setBusyId(null);
    }
  }

  async function removeImport(item: ImportSourceItem) {
    if (!window.confirm(`Удалить импорт "${item.name}"?`)) return;
    setBusyId(item.id);
    try {
      await deleteImportSource(item.id);
      await loadList();
      await loadDataItems();
    } finally {
      setBusyId(null);
    }
  }

  function handleImportSaved(item: ImportSourceItem) {
    setItems((current) => current.map((entry) => (entry.id === item.id ? item : entry)));
    void loadList();
  }

  async function openImportInfo(item: ImportSourceItem) {
    setBusyId(item.id);
    try {
      const detail = await fetchImportDetail(item.id);
      setInfoModalData({ item: detail.item, runs: detail.runs });
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : 'Не удалось загрузить информацию об импорте.');
    } finally {
      setBusyId(null);
    }
  }

  const dataTotalPages = Math.max(1, Math.ceil(dataTotal / DATA_PAGE_SIZE));
  const dataPageStart = dataTotal === 0 ? 0 : dataPage * DATA_PAGE_SIZE + 1;
  const dataPageEnd = Math.min(dataTotal, dataPage * DATA_PAGE_SIZE + dataItems.length);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 className="sa-page-title" style={{ marginBottom: 6 }}>Данные</h1>
            <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Импортированные элементы и настройки источников данных.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <select
              className="sa-select"
              value={selectedHoldingId}
              onChange={(event) => {
                setSelectedHoldingId(event.target.value);
                setSelectedTags([]);
                setDataPage(0);
              }}
              style={{ minWidth: 220 }}
              disabled={holdingsLoading || holdings.length === 0}
            >
              {holdings.length === 0 ? <option value="">Нет компаний</option> : null}
              {holdings.map((holding) => <option key={holding.id} value={holding.id}>{holding.name}</option>)}
            </select>
            {activePageTab === 'imports' && <button className="sa-btn-primary" disabled={holdings.length === 0} onClick={() => setWizardOpen(true)}>Создать импорт</button>}
          </div>
        </div>
        <div className="sa-dialog-tabs" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={`sa-dialog-tab ${activePageTab === 'data' ? 'sa-dialog-tab-active' : ''}`}
            onClick={() => setActivePageTab('data')}
          >
            Данные
          </button>
          <button
            type="button"
            className={`sa-dialog-tab ${activePageTab === 'imports' ? 'sa-dialog-tab-active' : ''}`}
            onClick={() => setActivePageTab('imports')}
          >
            Импорт
          </button>
        </div>
        {error && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>{error}</div>}
        {dataError && activePageTab === 'data' && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>{dataError}</div>}
      </section>

      {activePageTab === 'data' && (
        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <input
              className="sa-input"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setDataPage(0);
              }}
              placeholder="Поиск по названию, описанию или данным"
              style={{ flex: '1 1 280px', minWidth: 0 }}
            />
            <div style={{ flex: '1 1 300px', minWidth: 260, maxWidth: 420 }}>
              <TagFilterPicker
                availableTags={availableTags}
                selectedTags={selectedTags}
                loading={filtersLoading}
                onChange={(tags) => {
                  setSelectedTags(tags);
                  setDataPage(0);
                }}
              />
            </div>
            <div style={{ minHeight: 38, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap' }}>
              <span className="sa-chip">Найдено: {dataTotal}</span>
            </div>
          </div>
          <div className="sa-table-wrap">
            <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Название</th>
                  <th style={{ width: 300 }}>Описание</th>
                  <th style={{ width: 140 }}>Источник</th>
                  <th style={{ width: 240 }}>Теги</th>
                  <th style={{ width: 150 }}>Обновлено</th>
                  <th style={{ width: 72 }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {dataLoading ? (
                  <tr><td colSpan={6} className="sa-meta" style={{ padding: 28 }}>Загрузка...</td></tr>
                ) : dataItems.length === 0 ? (
                  <tr><td colSpan={6} className="sa-meta" style={{ padding: 28 }}>Данных пока нет</td></tr>
                ) : dataItems.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.title}>{item.title}</td>
                    <td style={{ overflow: 'hidden' }}>
                      <div style={{ ...lineClampStyle(2), color: 'var(--sa-text-secondary)' }}>{item.description}</div>
                    </td>
                    <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.importSourceName}>{item.importSourceName}</td>
                    <td style={{ overflow: 'hidden' }}>
                      <CompactTagsCell
                        tags={item.tags}
                        onOpen={() => setTagsModalItem({ title: item.title, tags: item.tags })}
                      />
                    </td>
                    <td>{formatDate(item.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="sa-btn-outline sa-btn-icon"
                        onClick={() => setDescriptionModalItem({ title: item.title, sourceName: item.importSourceName, description: item.description })}
                        aria-label="Открыть описание"
                        title="Открыть описание"
                      >
                        <EyeIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="sa-meta">
              Показано {dataPageStart}-{dataPageEnd} из {dataTotal}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="sa-btn-outline sa-btn-sm"
                disabled={dataLoading || dataPage === 0}
                onClick={() => setDataPage((current) => Math.max(0, current - 1))}
              >
                Назад
              </button>
              <span className="sa-chip">Страница {dataPage + 1} из {dataTotalPages}</span>
              <button
                type="button"
                className="sa-btn-outline sa-btn-sm"
                disabled={dataLoading || dataPage + 1 >= dataTotalPages}
                onClick={() => setDataPage((current) => current + 1)}
              >
                Вперед
              </button>
            </div>
          </div>
        </section>
      )}

      {activePageTab === 'imports' && (
        <section className="sa-card" style={{ padding: 20 }}>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Статус</th>
                  <th>URL</th>
                  <th>Формат</th>
                  <th>Последний запуск</th>
                  <th className="sa-text-right">Элементы</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="sa-meta" style={{ padding: 28 }}>Загрузка...</td></tr>
                ) : items.length === 0 ? (
                  <tr><td colSpan={7} className="sa-meta" style={{ padding: 28 }}>Импортов пока нет</td></tr>
                ) : items.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 700 }}>{item.name}</td>
                    <td><span className={item.status === 'error' ? 'sa-emp-status sa-emp-warn' : 'sa-emp-status'}>{statusLabel(item.status)}</span></td>
                    <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.url}</td>
                    <td>{item.format}</td>
                    <td>{formatDate(item.lastRunAt)}</td>
                    <td className="sa-text-right">{item.itemsCount}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button className="sa-btn-outline sa-btn-sm" disabled={busyId === item.id} onClick={() => void runImport(item.id)}>Запустить</button>
                        <button
                          className="sa-btn-outline sa-btn-icon"
                          disabled={busyId === item.id}
                          onClick={() => void openImportInfo(item)}
                          aria-label="Посмотреть импорт"
                          title="Посмотреть импорт"
                        >
                          <EyeIcon />
                        </button>
                        <button
                          className="sa-btn-outline sa-btn-icon"
                          disabled={busyId === item.id}
                          onClick={() => setEditModalItem(item)}
                          aria-label="Редактировать импорт"
                          title="Редактировать импорт"
                        >
                          <EditIcon />
                        </button>
                        <button className="sa-btn-outline sa-btn-sm" disabled={busyId === item.id} onClick={() => void togglePause(item)}>{item.status === 'paused' ? 'Возобновить' : 'Пауза'}</button>
                        <button className="sa-btn-danger sa-btn-sm" disabled={busyId === item.id} onClick={() => void removeImport(item)}>Удалить</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ImportWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onSaved={() => { void loadList(); void loadDataItems(); void loadTags(); }}
        holdings={holdings}
        selectedHoldingId={selectedHoldingId || null}
      />
      <ImportInfoModal data={infoModalData} onClose={() => setInfoModalData(null)} />
      <ImportEditModal item={editModalItem} onClose={() => setEditModalItem(null)} onSaved={handleImportSaved} />
      <DescriptionModal item={descriptionModalItem} onClose={() => setDescriptionModalItem(null)} />
      <TagsModal item={tagsModalItem} onClose={() => setTagsModalItem(null)} />
    </div>
  );
}
