import React, { useEffect, useMemo, useState } from 'react';
import {
  analyzeImportSource,
  createImportSource,
  deleteImportSource,
  fetchImportDetail,
  fetchImportedItems,
  fetchImports,
  generateImportTagRule,
  previewImportConfig,
  runImportSource,
  testImportTagRules,
  updateImportSource,
  type ImportAIConfig,
  type ImportedDataItem,
  type ImportPreviewItem,
  type ImportRunItem,
  type ImportSourceItem,
  type ImportTagOperator,
  type ImportTagRule,
} from '../../../shared/api/adminPanel';

type WizardStep = 1 | 2 | 3 | 4;
type DataPageTab = 'data' | 'imports';
type DescriptionModalItem = {
  title: string;
  sourceName: string;
  description: string;
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
  sampleItems?: unknown[];
}) {
  const [ruleName, setRuleName] = useState('');
  const [ruleField, setRuleField] = useState('');
  const [ruleOperator, setRuleOperator] = useState<ImportTagOperator>('equals');
  const [ruleValue, setRuleValue] = useState('');
  const [aiRuleText, setAiRuleText] = useState('');
  const [tagTestItems, setTagTestItems] = useState<Array<{ item: unknown; tags: string[] }>>([]);
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
  }

  async function addAiRule() {
    setBusy(true);
    setError(null);
    try {
      const generated = await generateImportTagRule({ text: aiRuleText, availableFields: props.availableFields });
      props.onChange([...props.tagRules, { id: `rule-${Date.now()}`, enabled: true, ...generated }]);
      setAiRuleText('');
    } catch (ruleError) {
      setError(ruleError instanceof Error ? ruleError.message : 'Не удалось сформировать правило.');
    } finally {
      setBusy(false);
    }
  }

  async function testRules() {
    if (!props.sampleItems?.length) return;
    setBusy(true);
    setError(null);
    try {
      setTagTestItems(await testImportTagRules({ sampleItems: props.sampleItems, tagRules: props.tagRules }));
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : 'Не удалось протестировать правила.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {error && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>{error}</div>}

      <section style={{ border: '1px solid var(--sa-divider)', borderRadius: 16, padding: 14, display: 'grid', gap: 12, background: '#f9fafb' }}>
        <div>
          <h4 style={{ margin: '0 0 4px', fontSize: 15 }}>Добавить правило вручную</h4>
          <div className="sa-meta">Укажите, какой тег поставить и при каком условии.</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="sa-meta">Название тега</span>
            <input className="sa-input" placeholder="Например: VIP" value={ruleName} onChange={(event) => setRuleName(event.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="sa-meta">Поле данных</span>
            <select className="sa-select" value={ruleField} onChange={(event) => setRuleField(event.target.value)}>
              <option value="">Выберите поле</option>
              {props.availableFields.map((field) => <option key={field} value={field}>{field}</option>)}
            </select>
          </label>
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
        <div><button className="sa-btn-outline" onClick={addManualRule}>Добавить правило</button></div>
      </section>

      <section style={{ border: '1px solid var(--sa-divider)', borderRadius: 16, padding: 14, display: 'grid', gap: 10, background: '#fff' }}>
        <div>
          <h4 style={{ margin: '0 0 4px', fontSize: 15 }}>AI-правило обычным языком</h4>
          <div className="sa-meta">Опишите правило словами, система сама подберёт поле и условие.</div>
        </div>
        <textarea className="sa-input" rows={3} value={aiRuleText} onChange={(event) => setAiRuleText(event.target.value)} placeholder="Проставь тег Комиссия, если commission равно true" />
        <div><button className="sa-btn-outline" disabled={busy || !aiRuleText.trim()} onClick={() => void addAiRule()}>Сформировать правило</button></div>
      </section>

      <section style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <div>
            <h4 style={{ margin: '0 0 4px', fontSize: 15 }}>Текущие правила</h4>
            <div className="sa-meta">Эти правила применяются только к этому источнику импорта.</div>
          </div>
          <span className="sa-chip">{props.tagRules.length} правил</span>
        </div>
        {props.tagRules.length ? props.tagRules.map((rule, index) => (
          <div key={rule.id} style={{ border: '1px solid var(--sa-divider)', borderRadius: 16, padding: 14, display: 'grid', gap: 12, background: rule.enabled ? '#fff' : '#f9fafb' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>Правило {index + 1}</strong>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--sa-text-secondary)', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
                />
                {rule.enabled ? 'Включено' : 'Выключено'}
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, alignItems: 'end' }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="sa-meta">Тег</span>
                <input className="sa-input" value={rule.name} onChange={(event) => updateRule(rule.id, { name: event.target.value })} />
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="sa-meta">Поле</span>
                <select className="sa-select" value={rule.condition.field} onChange={(event) => updateRuleCondition(rule.id, { field: event.target.value })}>
                  {props.availableFields.includes(rule.condition.field) ? null : <option value={rule.condition.field}>{rule.condition.field}</option>}
                  {props.availableFields.map((field) => <option key={field} value={field}>{field}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="sa-meta">Условие</span>
                <select className="sa-select" value={rule.condition.operator} onChange={(event) => updateRuleCondition(rule.id, { operator: event.target.value as ImportTagOperator })}>
                  {OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="sa-meta">Значение</span>
                <input className="sa-input" value={stringifyRuleValue(rule.condition.value)} onChange={(event) => updateRuleCondition(rule.id, { value: parseRuleValue(event.target.value) })} />
              </label>
              <button className="sa-btn-outline" style={{ justifySelf: 'start' }} onClick={() => props.onChange(props.tagRules.filter((item) => item.id !== rule.id))}>Удалить</button>
            </div>
          </div>
        )) : (
          <div style={{ padding: 16, border: '1px dashed var(--sa-divider)', borderRadius: 16, color: 'var(--sa-text-secondary)', fontSize: 14 }}>
            Правил пока нет. Добавьте правило вручную или сформируйте его через AI.
          </div>
        )}
      </section>

      {props.sampleItems?.length ? (
        <section style={{ border: '1px solid var(--sa-divider)', borderRadius: 16, padding: 14, display: 'grid', gap: 10, background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Тест на sample-элементах</h3>
            <button className="sa-btn-outline" disabled={busy || props.tagRules.length === 0} onClick={() => void testRules()}>
              {busy ? 'Тестируем...' : 'Протестировать правила'}
            </button>
          </div>
          {tagTestItems.length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {tagTestItems.map((result, index) => (
                <div key={index} className="sa-card" style={{ padding: 10 }}>
                  <div style={{ fontWeight: 700 }}>Sample {index + 1}</div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {result.tags.length ? result.tags.map((tag) => <span key={tag} className="sa-chip">{tag}</span>) : <span className="sa-meta">Теги не применились</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="sa-meta">Запустите тест, чтобы увидеть теги для sample-данных.</div>}
        </section>
      ) : null}
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
    setError(null);
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
                <div className="sa-meta">Теги автоматически проставляются новым данным при запуске этого импорта.</div>
              </div>
              <TagRulesEditor availableFields={fieldsFromImportSource(props.item)} tagRules={tagRules} onChange={setTagRules} />
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
}) {
  const [step, setStep] = useState<WizardStep>(1);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [schedule, setSchedule] = useState('manual');
  const [format, setFormat] = useState<ImportSourceItem['format']>('json');
  const [itemsPath, setItemsPath] = useState('');
  const [sampleItems, setSampleItems] = useState<unknown[]>([]);
  const [aiConfig, setAiConfig] = useState<ImportAIConfig>(EMPTY_AI_CONFIG);
  const [previewItems, setPreviewItems] = useState<ImportPreviewItem[]>([]);
  const [tagRules, setTagRules] = useState<ImportTagRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableFields = useMemo(() => flattenFields(sampleItems[0] || {}), [sampleItems]);

  useEffect(() => {
    if (!props.open) return;
    setStep(1);
    setName('');
    setUrl('');
    setSchedule('manual');
    setFormat('json');
    setItemsPath('');
    setSampleItems([]);
    setAiConfig(EMPTY_AI_CONFIG);
    setPreviewItems([]);
    setTagRules([]);
    setError(null);
  }, [props.open]);

  if (!props.open) return null;

  async function analyze() {
    setBusy(true);
    setError(null);
    try {
      const result = await analyzeImportSource(url);
      setFormat(result.format);
      setItemsPath(result.itemsPath);
      setSampleItems(result.sampleItems);
      setAiConfig(result.aiConfig);
      setPreviewItems(result.previewItems);
      setStep(2);
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : 'Не удалось проанализировать источник.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshPreview() {
    setBusy(true);
    setError(null);
    try {
      setPreviewItems(await previewImportConfig({ sampleItems, aiConfig, tagRules }));
      setStep(4);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Не удалось построить preview.');
    } finally {
      setBusy(false);
    }
  }

  async function saveImport() {
    setBusy(true);
    setError(null);
    try {
      await createImportSource({
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
            <div style={{ marginTop: 6, color: 'var(--sa-text-secondary)', fontSize: 13 }}>Шаг {step} из 4</div>
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
              <button type="submit" className="sa-btn-primary" disabled={busy || !name.trim() || !url.trim()}>
                {busy ? 'Анализируем...' : 'Проанализировать источник'}
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div style={{ display: 'grid', gap: 16 }}>
            <div className="sa-card" style={{ padding: 12 }}>
              <div><strong>Формат:</strong> {format}</div>
              <div><strong>Путь элементов:</strong> {itemsPath}</div>
              <div><strong>Тип сущности:</strong> {aiConfig.entityType}</div>
              <div><strong>Title fields:</strong> {aiConfig.titleFields.join(', ') || '—'}</div>
              <div><strong>Description fields:</strong> {aiConfig.descriptionFields.join(', ') || '—'}</div>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {previewItems.map((item, index) => (
                <div key={index} className="sa-card" style={{ padding: 12 }}>
                  <div style={{ fontWeight: 700 }}>{item.title}</div>
                  <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13, whiteSpace: 'pre-line' }}>{item.description}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button className="sa-btn-outline" onClick={() => setStep(1)}>Назад</button>
              <button className="sa-btn-primary" onClick={() => setStep(3)}>Настроить теги</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'grid', gap: 16 }}>
            <TagRulesEditor availableFields={availableFields} tagRules={tagRules} onChange={setTagRules} sampleItems={sampleItems} />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button className="sa-btn-outline" onClick={() => setStep(2)}>Назад</button>
              <button className="sa-btn-primary" disabled={busy} onClick={() => void refreshPreview()}>{busy ? 'Строим...' : 'Финальный preview'}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={{ display: 'grid', gap: 14 }}>
            {previewItems.map((item, index) => (
              <div key={index} className="sa-card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 700 }}>{item.title}</div>
                <div style={{ color: 'var(--sa-text-secondary)', fontSize: 13, whiteSpace: 'pre-line' }}>{item.description}</div>
                {!!item.tags.length && <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>{item.tags.map((tag) => <span key={tag} className="sa-chip">{tag}</span>)}</div>}
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button className="sa-btn-outline" onClick={() => setStep(3)}>Назад</button>
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
  const [items, setItems] = useState<ImportSourceItem[]>([]);
  const [dataItems, setDataItems] = useState<ImportedDataItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editModalItem, setEditModalItem] = useState<ImportEditModalItem | null>(null);
  const [infoModalData, setInfoModalData] = useState<ImportInfoModalData | null>(null);
  const [descriptionModalItem, setDescriptionModalItem] = useState<DescriptionModalItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchImports();
      setItems(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить импорты.');
    } finally {
      setLoading(false);
    }
  }

  async function loadDataItems() {
    setDataLoading(true);
    setDataError(null);
    try {
      setDataItems(await fetchImportedItems({ limit: 200 }));
    } catch (loadError) {
      setDataError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить данные.');
    } finally {
      setDataLoading(false);
    }
  }

  useEffect(() => { void loadList(); }, []);
  useEffect(() => { void loadDataItems(); }, []);

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

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 className="sa-page-title" style={{ marginBottom: 6 }}>Данные</h1>
            <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Импортированные элементы и настройки источников данных.</div>
          </div>
          {activePageTab === 'imports' && <button className="sa-btn-primary" onClick={() => setWizardOpen(true)}>Создать импорт</button>}
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
        <section className="sa-card" style={{ padding: 20 }}>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Описание</th>
                  <th>Источник</th>
                  <th>Теги</th>
                  <th>Обновлено</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {dataLoading ? (
                  <tr><td colSpan={6} className="sa-meta" style={{ padding: 28 }}>Загрузка...</td></tr>
                ) : dataItems.length === 0 ? (
                  <tr><td colSpan={6} className="sa-meta" style={{ padding: 28 }}>Данных пока нет</td></tr>
                ) : dataItems.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 700, minWidth: 180 }}>{item.title}</td>
                    <td style={{ maxWidth: 560 }}>
                      <div style={{ ...lineClampStyle(3), color: 'var(--sa-text-secondary)' }}>{item.description}</div>
                    </td>
                    <td>{item.importSourceName}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {item.tags.length ? item.tags.map((tag) => <span key={tag} className="sa-chip">{tag}</span>) : <span className="sa-meta">—</span>}
                      </div>
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

      <ImportWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onSaved={() => void loadList()} />
      <ImportInfoModal data={infoModalData} onClose={() => setInfoModalData(null)} />
      <ImportEditModal item={editModalItem} onClose={() => setEditModalItem(null)} onSaved={handleImportSaved} />
      <DescriptionModal item={descriptionModalItem} onClose={() => setDescriptionModalItem(null)} />
    </div>
  );
}
