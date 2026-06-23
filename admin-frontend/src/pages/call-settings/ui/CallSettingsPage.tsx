import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  createCallCustomerProfile,
  createCallPlan,
  createCallScript,
  deleteCallCustomerProfile,
  deleteCallScript,
  fetchCallPlanOptions,
  fetchCallPlans,
  fetchCallPlanCalls,
  fetchCallCustomerProfiles,
  fetchCallScripts,
  fetchHoldings,
  fetchImportedItems,
  fetchImportedTags,
  initiateCallPlan,
  previewCallPlanPrompt,
  updateCallCustomerProfile,
  updateCallPlan,
  updateCallScript,
  type CallPlanDealershipOption,
  type CallPlanEmployeeOption,
  type CallPlanFrequency,
  type CallPlanItem,
  type CallPlanCallItem,
  type CallPlanOptions,
  type CallPlanPromptPreview,
  type CallPlanTargetType,
  type CallCustomerProfileItem,
  type CallScriptItem,
  type CallScriptSuccessCriterion,
  type CustomerPatience,
  type CustomerTemperament,
  type HoldingItem,
  type ReplyLength,
} from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';

type CallSettingsTab = 'profiles' | 'scripts' | 'plan';
type CallSettingsRoute =
  | { tab: 'profiles' }
  | { tab: 'scripts'; scriptId?: string; create?: boolean }
  | { tab: 'plan'; planId?: string; create?: boolean; edit?: boolean };
type CustomerProfile = CallCustomerProfileItem;
type CustomerProfileForm = Omit<CustomerProfile, 'id' | 'holdingId' | 'createdAt' | 'updatedAt'>;
type SuccessCriterion = CallScriptSuccessCriterion;
type CallScript = CallScriptItem;
type CallScriptForm = Omit<CallScript, 'id' | 'holdingId' | 'createdAt' | 'updatedAt'>;
type CallPlan = CallPlanItem;
type CallPlanForm = Omit<CallPlan, 'id' | 'createdAt' | 'updatedAt' | 'lastInitiatedAt' | 'lastBatchId'>;

const VOICES = [
  { id: 'marin', label: 'Естественный' },
  { id: 'cedar', label: 'Тёплый' },
  { id: 'sage', label: 'Спокойный' },
  { id: 'ash', label: 'Мягкий' },
  { id: 'verse', label: 'Разговорный' },
  { id: 'coral', label: 'Живой' },
  { id: 'nova', label: 'Энергичный' },
  { id: 'echo', label: 'Уверенный' },
];

const TEMPERAMENTS: Array<{ value: CustomerTemperament; label: string }> = [
  { value: 'calm', label: 'Спокойный' },
  { value: 'doubtful', label: 'Сомневающийся' },
  { value: 'irritated', label: 'Раздражённый' },
  { value: 'hurried', label: 'Торопящийся' },
];

const PATIENCE: Array<{ value: CustomerPatience; label: string }> = [
  { value: 'low', label: 'Низкое' },
  { value: 'medium', label: 'Среднее' },
  { value: 'high', label: 'Высокое' },
];

const REPLY_LENGTHS: Array<{ value: ReplyLength; label: string }> = [
  { value: 'short', label: 'Короткие' },
  { value: 'medium', label: 'Средние' },
  { value: 'detailed', label: 'Подробные' },
];

const PLAN_FREQUENCIES: Array<{ value: CallPlanFrequency; label: string }> = [
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekly', label: 'Раз в неделю' },
];

const CALL_SETTINGS_PATHS: Record<CallSettingsTab, string> = {
  profiles: '/call-settings/profiles',
  scripts: '/call-settings/scripts',
  plan: '/call-settings/plans',
};

const EMPTY_FORM: CustomerProfileForm = {
  name: '',
  voiceId: VOICES[0].id,
  age: 35,
  character: '',
  temperament: 'calm',
  patience: 'medium',
  replyLength: 'medium',
  communicationStyle: '',
};

const EMPTY_SCRIPT_FORM: CallScriptForm = {
  name: '',
  profileIds: [],
  context: '',
  dataCondition: { holdingId: null, tags: [] },
  objections: [],
  questions: [],
  successCriteria: [],
};

function voiceLabel(id: string): string {
  return VOICES.find((voice) => voice.id === id)?.label || 'Универсальный';
}

function optionLabel<T extends string>(items: Array<{ value: T; label: string }>, value: T): string {
  return items.find((item) => item.value === value)?.label || value;
}

function parseCallSettingsRoute(pathname: string): CallSettingsRoute {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [, section, id] = parts;
  if (section === 'scripts') {
    if (id === 'new') return { tab: 'scripts', create: true };
    return id ? { tab: 'scripts', scriptId: id } : { tab: 'scripts' };
  }
  if (section === 'plans' || section === 'plan') {
    if (id === 'new') return { tab: 'plan', create: true };
    if (id && parts[3] === 'edit') return { tab: 'plan', planId: id, edit: true };
    return id ? { tab: 'plan', planId: id } : { tab: 'plan' };
  }
  return { tab: 'profiles' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getEvaluationSummary(evaluation: unknown) {
  const data = asRecord(evaluation);
  const planCriteria = asRecord(data.plan_criteria);
  return {
    overallScore: asNumber(data.overall_score_0_100),
    summary: asText(data.summary) || asText(data.expert_summary) || asText(data.overall_summary),
    planPercent: asNumber(planCriteria.percent),
    planTotal: asNumber(planCriteria.totalScore),
    planMax: asNumber(planCriteria.maxScore),
    criteriaItems: asArray(planCriteria.items).map(asRecord),
    strengths: asArray(data.strengths).map(asText).filter(Boolean),
    issues: asArray(data.issues).map((item) => {
      const record = asRecord(item);
      return asText(record.title) || asText(record.issue) || asText(record.description) || asText(item);
    }).filter(Boolean),
    recommendations: asArray(data.recommendations).map((item) => {
      const record = asRecord(item);
      return asText(record.title) || asText(record.recommendation) || asText(record.description) || asText(item);
    }).filter(Boolean),
  };
}

function overlayCardStyle(width = 720): React.CSSProperties {
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

function createId(): string {
  return `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function syncSuccessCriteria(form: CallScriptForm): SuccessCriterion[] {
  const sources = [
    ...form.questions.map((item) => ({ sourceType: 'question' as const, sourceId: item.id })),
    ...form.objections.map((item) => ({ sourceType: 'objection' as const, sourceId: item.id })),
  ];
  return sources.map((source) => {
    const existing = form.successCriteria.find((item) => item.sourceType === source.sourceType && item.sourceId === source.sourceId);
    return existing || {
      id: createId(),
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      expectedAnswer: '',
      score: 80,
    };
  });
}

function ScriptTextModal(props: {
  open: boolean;
  title: string;
  firstLabel: string;
  secondLabel?: string;
  firstPlaceholder?: string;
  secondPlaceholder?: string;
  onClose: () => void;
  onSave: (first: string, second: string) => void;
}) {
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setFirst('');
    setSecond('');
  }, [props.open]);

  if (!props.open) return null;

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (!first.trim()) return;
    props.onSave(first.trim(), second.trim());
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 150 }} onClick={props.onClose}>
      <div style={overlayCardStyle(560)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>{props.title}</h2>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <form onSubmit={save} style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>{props.firstLabel}</span>
            <textarea className="sa-input" rows={3} value={first} placeholder={props.firstPlaceholder} onChange={(event) => setFirst(event.target.value)} autoFocus required />
          </label>
          {props.secondLabel && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span>{props.secondLabel}</span>
              <input className="sa-input" value={second} placeholder={props.secondPlaceholder} onChange={(event) => setSecond(event.target.value)} />
            </label>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="sa-btn-outline" onClick={props.onClose}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={!first.trim()}>Добавить</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function QuestionModal(props: {
  open: boolean;
  onClose: () => void;
  onSave: (text: string, required: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [required, setRequired] = useState(true);

  useEffect(() => {
    if (!props.open) return;
    setText('');
    setRequired(true);
  }, [props.open]);

  if (!props.open) return null;

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    props.onSave(text.trim(), required);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 150 }} onClick={props.onClose}>
      <div style={overlayCardStyle(560)} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>Добавить вопрос</h2>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <form onSubmit={save} style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Вопрос</span>
            <textarea className="sa-input" rows={3} value={text} onChange={(event) => setText(event.target.value)} autoFocus required />
          </label>
          <button
            type="button"
            className="sa-toggle-field"
            aria-pressed={required}
            onClick={() => setRequired((current) => !current)}
          >
            <span className="sa-toggle-field__text">{required ? 'Обязательный' : 'Не обязательный'}</span>
            <span className="sa-toggle-field__control" aria-hidden="true">
              <span className="sa-toggle-field__thumb" />
            </span>
          </button>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="sa-btn-outline" onClick={props.onClose}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={!text.trim()}>Добавить</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProfileModal(props: {
  open: boolean;
  initialProfile: CustomerProfile | null;
  onClose: () => void;
  onSave: (profile: CustomerProfileForm) => void;
}) {
  const [form, setForm] = useState<CustomerProfileForm>(EMPTY_FORM);
  const isEdit = Boolean(props.initialProfile);

  useEffect(() => {
    if (!props.open) return;
    if (props.initialProfile) {
      setForm({
        name: props.initialProfile.name,
        voiceId: props.initialProfile.voiceId,
        age: props.initialProfile.age,
        character: '',
        temperament: props.initialProfile.temperament,
        patience: props.initialProfile.patience,
        replyLength: props.initialProfile.replyLength,
        communicationStyle: props.initialProfile.communicationStyle,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [props.open, props.initialProfile]);

  if (!props.open) return null;

  function save(event: React.FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    props.onSave({
      ...form,
      name,
      character: '',
      communicationStyle: form.communicationStyle.trim(),
    });
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 130 }}
      onClick={props.onClose}
    >
      <div style={overlayCardStyle()} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>{isEdit ? 'Редактировать профиль клиента' : 'Создать профиль клиента'}</h2>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <form onSubmit={save} style={{ display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название профиля</span>
            <input className="sa-input" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Голос</span>
            <select className="sa-select" value={form.voiceId} onChange={(event) => setForm((current) => ({ ...current, voiceId: event.target.value }))}>
              {VOICES.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 8 }}>
            <span>Возраст: {form.age}</span>
            <input
              type="range"
              min={18}
              max={65}
              value={form.age}
              onChange={(event) => setForm((current) => ({ ...current, age: Number(event.target.value) }))}
            />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Темперамент</span>
              <select className="sa-select" value={form.temperament} onChange={(event) => setForm((current) => ({ ...current, temperament: event.target.value as CustomerTemperament }))}>
                {TEMPERAMENTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Терпение клиента</span>
              <select className="sa-select" value={form.patience} onChange={(event) => setForm((current) => ({ ...current, patience: event.target.value as CustomerPatience }))}>
                {PATIENCE.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Длина реплик</span>
              <select className="sa-select" value={form.replyLength} onChange={(event) => setForm((current) => ({ ...current, replyLength: event.target.value as ReplyLength }))}>
                {REPLY_LENGTHS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Примеры живых вопросов / стиль коммуникации</span>
            <textarea className="sa-input" rows={5} value={form.communicationStyle} onChange={(event) => setForm((current) => ({ ...current, communicationStyle: event.target.value }))} />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="sa-btn-outline" onClick={props.onClose}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={!form.name.trim()}>{isEdit ? 'Сохранить профиль' : 'Создать профиль'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ScriptEditor(props: {
  holdingId: string;
  initialScript?: CallScript | null;
  profiles: CustomerProfile[];
  onBack: () => void;
  onSave: (script: Omit<CallScript, 'id' | 'createdAt' | 'updatedAt'>) => void;
}) {
  const [form, setForm] = useState<CallScriptForm>(EMPTY_SCRIPT_FORM);
  const [tags, setTags] = useState<string[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [scoreDrafts, setScoreDrafts] = useState<Record<string, string>>({});
  const [matchedCount, setMatchedCount] = useState(0);
  const [countLoading, setCountLoading] = useState(false);
  const [objectionModalOpen, setObjectionModalOpen] = useState(false);
  const [questionModalOpen, setQuestionModalOpen] = useState(false);
  const isEdit = Boolean(props.initialScript);

  useEffect(() => {
    const source = props.initialScript;
    if (source) {
      setForm({
        name: source.name,
        profileIds: [...source.profileIds],
        context: source.context,
        dataCondition: { holdingId: props.holdingId, tags: [...source.dataCondition.tags] },
        objections: source.objections.map((item) => ({ ...item })),
        questions: source.questions.map((item) => ({ ...item })),
        successCriteria: source.successCriteria.map((item) => ({ ...item })),
      });
      setScoreDrafts(Object.fromEntries(source.successCriteria.map((item) => [item.id, String(item.score)])));
    } else {
      setForm({
        ...EMPTY_SCRIPT_FORM,
        profileIds: [],
        dataCondition: { holdingId: props.holdingId, tags: [] },
        objections: [],
        questions: [],
        successCriteria: [],
      });
      setScoreDrafts({});
    }
    setTagSearch('');
  }, [props.initialScript, props.holdingId]);

  useEffect(() => {
    setForm((current) => ({
      ...current,
      dataCondition: { holdingId: props.holdingId, tags: current.dataCondition.tags },
    }));
  }, [props.holdingId]);

  useEffect(() => {
    if (!form.dataCondition.holdingId) {
      setTags([]);
      return;
    }
    let cancelled = false;
    setTagsLoading(true);
    fetchImportedTags({ holdingId: form.dataCondition.holdingId })
      .then((items) => {
        if (cancelled) return;
        setTags(items);
        setForm((current) => ({
          ...current,
          dataCondition: {
            ...current.dataCondition,
            tags: current.dataCondition.tags.filter((tag) => items.includes(tag)),
          },
        }));
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      })
      .finally(() => {
        if (!cancelled) setTagsLoading(false);
      });
    return () => { cancelled = true; };
  }, [form.dataCondition.holdingId]);

  useEffect(() => {
    if (!form.dataCondition.holdingId || form.dataCondition.tags.length === 0) {
      setMatchedCount(0);
      setCountLoading(false);
      return;
    }
    let cancelled = false;
    setCountLoading(true);
    fetchImportedItems({
      holdingId: form.dataCondition.holdingId,
      tags: form.dataCondition.tags,
      limit: 1,
      offset: 0,
    })
      .then((result) => {
        if (!cancelled) setMatchedCount(result.total);
      })
      .catch(() => {
        if (!cancelled) setMatchedCount(0);
      })
      .finally(() => {
        if (!cancelled) setCountLoading(false);
      });
    return () => { cancelled = true; };
  }, [form.dataCondition.holdingId, form.dataCondition.tags]);

  const selectedTags = form.dataCondition.tags;
  const filteredTags = useMemo(() => {
    const query = tagSearch.trim().toLowerCase();
    const orderedTags = [...tags].sort((a, b) => {
      const aSelected = selectedTags.includes(a) ? 0 : 1;
      const bSelected = selectedTags.includes(b) ? 0 : 1;
      return aSelected - bSelected || a.localeCompare(b, 'ru');
    });
    if (!query) return orderedTags;
    return orderedTags.filter((tag) => tag.toLowerCase().includes(query));
  }, [tagSearch, tags, selectedTags]);

  function updateForm(patch: Partial<CallScriptForm>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function toggleProfile(profileId: string) {
    setForm((current) => ({
      ...current,
      profileIds: current.profileIds.includes(profileId)
        ? current.profileIds.filter((id) => id !== profileId)
        : [...current.profileIds, profileId],
    }));
  }

  function toggleTag(tag: string) {
    setForm((current) => ({
      ...current,
      dataCondition: {
        ...current.dataCondition,
        tags: current.dataCondition.tags.includes(tag)
          ? current.dataCondition.tags.filter((item) => item !== tag)
          : [...current.dataCondition.tags, tag],
      },
    }));
  }

  function clearTags() {
    setForm((current) => ({
      ...current,
      dataCondition: { ...current.dataCondition, tags: [] },
    }));
  }

  function addObjection(phrase: string, whenAppropriate: string) {
    setForm((current) => {
      const objections = [...current.objections, { id: createId(), phrase, whenAppropriate }];
      const next = { ...current, objections };
      return { ...next, successCriteria: syncSuccessCriteria(next) };
    });
    setObjectionModalOpen(false);
  }

  function addQuestion(text: string, required: boolean) {
    setForm((current) => {
      const questions = [...current.questions, { id: createId(), text, required }];
      const next = { ...current, questions };
      return { ...next, successCriteria: syncSuccessCriteria(next) };
    });
    setQuestionModalOpen(false);
  }

  function removeObjection(id: string) {
    setForm((current) => {
      const next = { ...current, objections: current.objections.filter((item) => item.id !== id) };
      return { ...next, successCriteria: syncSuccessCriteria(next) };
    });
  }

  function removeQuestion(id: string) {
    setForm((current) => {
      const next = { ...current, questions: current.questions.filter((item) => item.id !== id) };
      return { ...next, successCriteria: syncSuccessCriteria(next) };
    });
  }

  function sourceLabel(criterion: SuccessCriterion): string {
    if (criterion.sourceType === 'question') {
      const question = form.questions.find((item) => item.id === criterion.sourceId);
      return question ? `Вопрос: ${question.text}` : 'Вопрос';
    }
    const objection = form.objections.find((item) => item.id === criterion.sourceId);
    return objection ? `Возражение: ${objection.phrase}` : 'Возражение';
  }

  function updateCriterion(id: string, patch: Partial<SuccessCriterion>) {
    setForm((current) => ({
      ...current,
      successCriteria: current.successCriteria.map((item) => item.id === id ? { ...item, ...patch } : item),
    }));
  }

  function updateCriterionScore(id: string, value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 3);
    setScoreDrafts((current) => ({ ...current, [id]: digits }));
    if (!digits) return;
    updateCriterion(id, { score: clampScore(Number(digits)) });
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return;
    props.onSave({
      holdingId: props.holdingId,
      ...form,
      name: form.name.trim(),
      context: form.context.trim(),
      dataCondition: {
        holdingId: props.holdingId,
        tags: [...form.dataCondition.tags].sort(),
      },
      successCriteria: syncSuccessCriteria(form).map((item) => ({
        ...item,
        expectedAnswer: item.expectedAnswer.trim(),
        score: clampScore(Number(scoreDrafts[item.id] || item.score || 0)),
      })),
    });
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section className="sa-card" style={{ padding: 20, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 6 }}>{isEdit ? 'Скрипт' : 'Создание скрипта'}</h1>
          <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>{isEdit ? 'Посмотрите и отредактируйте настройки скрипта.' : 'Соберите контекст, выборку данных, вопросы и критерии оценки.'}</div>
        </div>
        <button type="button" className="sa-btn-outline" onClick={props.onBack}>Назад к скриптам</button>
      </section>

      <form onSubmit={save} style={{ display: 'grid', gap: 16 }}>
        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название скрипта</span>
            <input className="sa-input" value={form.name} onChange={(event) => updateForm({ name: event.target.value })} required />
          </label>

          <div style={{ display: 'grid', gap: 8 }}>
            <span>Профили клиента</span>
            {props.profiles.length === 0 ? (
              <div className="sa-meta">Сначала создайте хотя бы один профиль клиента.</div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {props.profiles.map((profile) => (
                  <label key={profile.id} className="sa-filter-check">
                    <input type="checkbox" checked={form.profileIds.includes(profile.id)} onChange={() => toggleProfile(profile.id)} />
                    {profile.name}
                  </label>
                ))}
              </div>
            )}
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Контекст (Потребность)</span>
            <textarea
              className="sa-input"
              rows={4}
              value={form.context}
              onChange={(event) => updateForm({ context: event.target.value })}
              placeholder="Опишите контекст и потребность клиента. Например: покупка автомобиля для всей семьи, первый поход в салон красоты, не может выбрать лучшее кольцо."
            />
          </label>
        </section>

        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 18 }}>Выборка данных</h3>
              <div className="sa-meta" style={{ marginTop: 4 }}>Выберите теги, по которым скрипт будет подбирать данные текущей компании.</div>
            </div>
            <span className="sa-chip">{countLoading ? 'Считаем...' : `Элементов: ${matchedCount}`}</span>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>Теги</span>
              <span className="sa-meta">Выбрано: {selectedTags.length} из {tags.length}</span>
            </div>
            {!form.dataCondition.holdingId ? (
              <div className="sa-meta">Выберите компанию, чтобы увидеть теги из данных.</div>
            ) : tagsLoading ? (
              <div className="sa-meta">Загружаем теги...</div>
            ) : tags.length === 0 ? (
              <div className="sa-meta">У выбранной компании пока нет тегов.</div>
            ) : (
              <div style={{ border: '1px solid var(--sa-divider)', borderRadius: 14, overflow: 'hidden', background: '#fff' }}>
                <div style={{ padding: 12, borderBottom: '1px solid var(--sa-divider)', display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      className="sa-input"
                      value={tagSearch}
                      onChange={(event) => setTagSearch(event.target.value)}
                      placeholder="Найти тег"
                      style={{ flex: '1 1 240px', minWidth: 0 }}
                    />
                    {selectedTags.length > 0 && (
                      <button type="button" className="sa-btn-outline sa-btn-sm" onClick={clearTags}>Очистить</button>
                    )}
                  </div>

                  {selectedTags.length > 0 ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 78, overflowY: 'auto' }}>
                      {selectedTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className="sa-chip sa-chip-active"
                          onClick={() => toggleTag(tag)}
                          title="Убрать тег"
                          style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="sa-meta">Можно оставить без тегов или выбрать несколько условий для выборки.</div>
                  )}
                </div>

                <div style={{ maxHeight: 260, overflowY: 'auto', display: 'grid' }}>
                  {filteredTags.length === 0 ? (
                    <div className="sa-meta" style={{ padding: 14 }}>По такому запросу тегов нет.</div>
                  ) : (
                    filteredTags.map((tag) => {
                      const checked = selectedTags.includes(tag);
                      return (
                        <label
                          key={tag}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '20px minmax(0, 1fr)',
                            gap: 10,
                            alignItems: 'center',
                            padding: '10px 12px',
                            borderTop: '1px solid var(--sa-divider)',
                            background: checked ? '#f0f7ff' : '#fff',
                            cursor: 'pointer',
                          }}
                        >
                          <input type="checkbox" checked={checked} onChange={() => toggleTag(tag)} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tag}>{tag}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 18 }}>Возражения</h3>
            <button type="button" className="sa-btn-outline" onClick={() => setObjectionModalOpen(true)}>Добавить возражение</button>
          </div>
          {form.objections.length === 0 ? <div className="sa-meta">Возражения пока не добавлены.</div> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {form.objections.map((item) => (
                <div key={item.id} style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: 12, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <strong>{item.phrase}</strong>
                    <div className="sa-meta" style={{ marginTop: 4 }}>{item.whenAppropriate || 'Любой кейс'}</div>
                  </div>
                  <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => removeObjection(item.id)}>Удалить</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 18 }}>Список вопросов</h3>
            <button type="button" className="sa-btn-outline" onClick={() => setQuestionModalOpen(true)}>Добавить вопрос</button>
          </div>
          {form.questions.length === 0 ? <div className="sa-meta">Вопросы пока не добавлены.</div> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {form.questions.map((item) => (
                <div key={item.id} style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: 12, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <strong>{item.text}</strong>
                    <div className="sa-meta" style={{ marginTop: 4 }}>{item.required ? 'Обязательный' : 'Не обязательный'}</div>
                  </div>
                  <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => removeQuestion(item.id)}>Удалить</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>Условия успеха</h3>
          {form.successCriteria.length === 0 ? <div className="sa-meta">Добавьте вопросы или возражения, чтобы настроить условия успеха.</div> : (
            <div className="sa-table-wrap">
              <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: 260 }}>Вопрос/Возражение</th>
                    <th>Эталон ответа</th>
                    <th style={{ width: 150 }}>Баллы</th>
                  </tr>
                </thead>
                <tbody>
                  {form.successCriteria.map((criterion) => (
                    <tr key={criterion.id}>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={sourceLabel(criterion)}>{sourceLabel(criterion)}</td>
                      <td>
                        <input className="sa-input" value={criterion.expectedAnswer} onChange={(event) => updateCriterion(criterion.id, { expectedAnswer: event.target.value })} />
                      </td>
                      <td>
                        <input
                          className="sa-input"
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={scoreDrafts[criterion.id] ?? String(criterion.score)}
                          onChange={(event) => updateCriterionScore(criterion.id, event.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="sa-btn-outline" onClick={props.onBack}>Отмена</button>
          <button type="submit" className="sa-btn-primary" disabled={!form.name.trim()}>{isEdit ? 'Сохранить изменения' : 'Сохранить скрипт'}</button>
        </div>
      </form>

      <ScriptTextModal
        open={objectionModalOpen}
        title="Добавить возражение"
        firstLabel="Фраза клиента"
        secondLabel="Когда уместна"
        firstPlaceholder="Видел дешевле у конкурентов"
        secondPlaceholder="высокий пробег, другой город, любой кейс"
        onClose={() => setObjectionModalOpen(false)}
        onSave={addObjection}
      />
      <QuestionModal
        open={questionModalOpen}
        onClose={() => setQuestionModalOpen(false)}
        onSave={addQuestion}
      />
    </div>
  );
}

function PlanTargetPicker<T extends { id: string }>(props: {
  title: string;
  search: string;
  onSearchChange: (value: string) => void;
  items: T[];
  selectedIds: string[];
  countLabel: string;
  emptyLabel: string;
  renderItem: (item: T, selected: boolean) => React.ReactNode;
  onToggle: (id: string) => void;
}) {
  return (
    <div style={{ border: '1px solid var(--sa-divider)', borderRadius: 14, overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--sa-divider)', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{props.title}</strong>
          <span className="sa-meta">{props.countLabel}</span>
        </div>
        <input className="sa-input" value={props.search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="Поиск" />
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', display: 'grid' }}>
        {props.items.length === 0 ? (
          <div className="sa-meta" style={{ padding: 14 }}>{props.emptyLabel}</div>
        ) : props.items.map((item) => {
          const selected = props.selectedIds.includes(item.id);
          return (
            <label
              key={item.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px minmax(0, 1fr)',
                gap: 10,
                alignItems: 'center',
                padding: '11px 12px',
                borderTop: '1px solid var(--sa-divider)',
                background: selected ? '#f0f7ff' : '#fff',
                cursor: 'pointer',
              }}
            >
              <input type="checkbox" checked={selected} onChange={() => props.onToggle(item.id)} />
              {props.renderItem(item, selected)}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function CallPlanEditor(props: {
  holdingId: string;
  options: CallPlanOptions;
  initialPlan?: CallPlan | null;
  onBack: () => void;
  onSave: (plan: CallPlanForm) => void;
}) {
  const [name, setName] = useState(props.initialPlan?.name || '');
  const [targetType, setTargetType] = useState<CallPlanTargetType>(props.initialPlan?.targetType || 'employees');
  const [targetIds, setTargetIds] = useState<string[]>(props.initialPlan?.targetIds || []);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [dealershipSearch, setDealershipSearch] = useState('');
  const [scriptId, setScriptId] = useState(props.initialPlan?.scriptId || '');
  const [phoneNumberTypeId, setPhoneNumberTypeId] = useState(props.initialPlan?.phoneNumberTypeId || '');
  const [frequency, setFrequency] = useState<CallPlanFrequency>(props.initialPlan?.frequency || 'daily');
  const [callTimeFrom, setCallTimeFrom] = useState(props.initialPlan?.callTimeFrom || '09:00');
  const [callTimeTo, setCallTimeTo] = useState(props.initialPlan?.callTimeTo || '09:15');

  useEffect(() => {
    setName(props.initialPlan?.name || '');
    setTargetType(props.initialPlan?.targetType || 'employees');
    setTargetIds(props.initialPlan?.targetIds || []);
    setScriptId(props.initialPlan?.scriptId || '');
    setPhoneNumberTypeId(props.initialPlan?.phoneNumberTypeId || '');
    setFrequency(props.initialPlan?.frequency || 'daily');
    setCallTimeFrom(props.initialPlan?.callTimeFrom || '09:00');
    setCallTimeTo(props.initialPlan?.callTimeTo || '09:15');
  }, [props.initialPlan]);

  useEffect(() => {
    setScriptId((current) => current || props.options.scripts[0]?.id || '');
    setPhoneNumberTypeId((current) => current || props.options.phoneNumberTypes[0]?.id || '');
  }, [props.options.scripts, props.options.phoneNumberTypes]);

  const filteredEmployees = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase();
    const list = [...props.options.employees].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
    if (!query) return list;
    return list.filter((item) => [item.fullName, item.email || '', item.phone || '', item.dealershipName].join(' ').toLowerCase().includes(query));
  }, [employeeSearch, props.options.employees]);

  const filteredDealerships = useMemo(() => {
    const query = dealershipSearch.trim().toLowerCase();
    const list = [...props.options.dealerships].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    if (!query) return list;
    return list.filter((item) => [item.name, item.city || '', item.address || ''].join(' ').toLowerCase().includes(query));
  }, [dealershipSearch, props.options.dealerships]);

  const selectedEmployeesCount = targetType === 'employees'
    ? targetIds.length
    : props.options.dealerships.filter((item) => targetIds.includes(item.id)).reduce((sum, item) => sum + item.employeesCount, 0);

  function switchTargetType(next: CallPlanTargetType) {
    setTargetType(next);
    setTargetIds([]);
  }

  function toggleTarget(id: string) {
    setTargetIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (!scriptId || !phoneNumberTypeId || targetIds.length === 0) return;
    props.onSave({
      holdingId: props.holdingId,
      name: name.trim() || (targetType === 'employees' ? 'Обзвон сотрудников' : 'Обзвон точек'),
      targetType,
      targetIds,
      scriptId,
      phoneNumberTypeId,
      frequency,
      callTimeFrom,
      callTimeTo,
    });
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section className="sa-card" style={{ padding: 20, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 className="sa-page-title" style={{ marginBottom: 6 }}>{props.initialPlan ? 'Редактирование прозвона' : 'Создание прозвона'}</h1>
          <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>
            {props.initialPlan ? 'Измените аудиторию, скрипт, тип номера и окно звонка.' : 'Выберите аудиторию, скрипт, тип номера и окно звонка.'}
          </div>
        </div>
        <button type="button" className="sa-btn-outline" onClick={props.onBack}>Назад к планам</button>
      </section>

      <form onSubmit={save} style={{ display: 'grid', gap: 16 }}>
        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название плана</span>
            <input
              className="sa-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={targetType === 'employees' ? 'Обзвон сотрудников' : 'Обзвон точек'}
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            {([
              { id: 'employees' as const, title: 'Сотрудники', text: 'Обзвон конкретных сотрудников' },
              { id: 'dealerships' as const, title: 'Точки', text: 'Обзвон всех сотрудников точки/точек' },
            ]).map((item) => (
              <button
                key={item.id}
                type="button"
                className={targetType === item.id ? 'sa-btn-primary' : 'sa-btn-outline'}
                onClick={() => switchTargetType(item.id)}
                style={{ minHeight: 94, justifyContent: 'flex-start', textAlign: 'left', display: 'grid', gap: 4 }}
              >
                <strong style={{ fontSize: 18 }}>{item.title}</strong>
                <span style={{ fontWeight: 500, opacity: 0.82 }}>{item.text}</span>
              </button>
            ))}
          </div>

          {targetType === 'employees' ? (
            <PlanTargetPicker<CallPlanEmployeeOption>
              title="Сотрудники"
              search={employeeSearch}
              onSearchChange={setEmployeeSearch}
              items={filteredEmployees}
              selectedIds={targetIds}
              countLabel={`Выбрано: ${selectedEmployeesCount}`}
              emptyLabel="Сотрудников не найдено."
              onToggle={toggleTarget}
              renderItem={(employee) => (
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{employee.fullName}</div>
                  <div className="sa-meta" style={{ marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {employee.dealershipName}{employee.email ? ` · ${employee.email}` : ''}
                  </div>
                </div>
              )}
            />
          ) : (
            <PlanTargetPicker<CallPlanDealershipOption>
              title="Точки"
              search={dealershipSearch}
              onSearchChange={setDealershipSearch}
              items={filteredDealerships}
              selectedIds={targetIds}
              countLabel={`Выбрано сотрудников: ${selectedEmployeesCount}`}
              emptyLabel="Точек не найдено."
              onToggle={toggleTarget}
              renderItem={(dealership) => (
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dealership.name}</div>
                  <div className="sa-meta" style={{ marginTop: 3 }}>
                    {dealership.city || 'Город не указан'} · сотрудников: {dealership.employeesCount}
                  </div>
                </div>
              )}
            />
          )}
        </section>

        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Скрипт</span>
              <select className="sa-select" value={scriptId} onChange={(event) => setScriptId(event.target.value)} required>
                <option value="">Выберите скрипт</option>
                {props.options.scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Тип номера</span>
              <select className="sa-select" value={phoneNumberTypeId} onChange={(event) => setPhoneNumberTypeId(event.target.value)} required>
                <option value="">Выберите тип номера</option>
                {props.options.phoneNumberTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Частотность</span>
              <select className="sa-select" value={frequency} onChange={(event) => setFrequency(event.target.value as CallPlanFrequency)}>
                {PLAN_FREQUENCIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Время звонка c</span>
              <input className="sa-input" type="time" min="09:00" max="21:45" step={900} value={callTimeFrom} onChange={(event) => setCallTimeFrom(event.target.value)} required />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Время звонка до</span>
              <input className="sa-input" type="time" min="09:15" max="22:00" step={900} value={callTimeTo} onChange={(event) => setCallTimeTo(event.target.value)} required />
            </label>
          </div>
        </section>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="sa-btn-outline" onClick={props.onBack}>Отмена</button>
          <button type="submit" className="sa-btn-primary" disabled={!scriptId || !phoneNumberTypeId || targetIds.length === 0}>
            {props.initialPlan ? 'Сохранить изменения' : 'Создать обзвон'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PromptPreviewModal(props: {
  preview: CallPlanPromptPreview | null;
  onClose: () => void;
  onCopy: () => void;
}) {
  if (!props.preview) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 160 }} onClick={props.onClose}>
      <div style={overlayCardStyle(980)} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Тест промпта">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>Тест промпта</h2>
            <div className="sa-meta" style={{ marginTop: 6 }}>
              Профиль: {props.preview.profile?.name || 'не выбран'} · Данные: {props.preview.importedItem?.title || 'нет элемента по condition'}
            </div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          {props.preview.importedItem?.tags?.length ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {props.preview.importedItem.tags.slice(0, 12).map((tag) => <span key={tag} className="sa-chip">{tag}</span>)}
            </div>
          ) : null}
          <textarea
            className="sa-input"
            readOnly
            value={props.preview.prompt}
            rows={24}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="sa-btn-outline" onClick={props.onCopy}>Скопировать</button>
            <button type="button" className="sa-btn-primary" onClick={props.onClose}>Закрыть</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CallSettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => parseCallSettingsRoute(location.pathname), [location.pathname]);
  const [activeTab, setActiveTab] = useState<CallSettingsTab>(route.tab);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [profiles, setProfiles] = useState<CustomerProfile[]>([]);
  const [scripts, setScripts] = useState<CallScript[]>([]);
  const [plans, setPlans] = useState<CallPlan[]>([]);
  const [planOptions, setPlanOptions] = useState<CallPlanOptions>({ employees: [], dealerships: [], phoneNumberTypes: [], scripts: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CustomerProfile | null>(null);
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<CallScript | null>(null);
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [promptPreview, setPromptPreview] = useState<CallPlanPromptPreview | null>(null);
  const [promptPreviewLoadingId, setPromptPreviewLoadingId] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<CallPlan | null>(null);
  const [planCalls, setPlanCalls] = useState<CallPlanCallItem[]>([]);
  const [planCallsLoading, setPlanCallsLoading] = useState(false);
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);

  useEffect(() => {
    if (location.pathname === '/call-settings') {
      navigate(CALL_SETTINGS_PATHS.profiles, { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    setActiveTab(route.tab);
  }, [route.tab]);

  useEffect(() => {
    let cancelled = false;
    setHoldingsLoading(true);
    fetchHoldings({ status: 'active' })
      .then((items) => {
        if (cancelled) return;
        setHoldings(items);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить компании.');
      })
      .finally(() => {
        if (!cancelled) setHoldingsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedHoldingId) {
      setProfiles([]);
      setScripts([]);
      setPlans([]);
      setPlanOptions({ employees: [], dealerships: [], phoneNumberTypes: [], scripts: [] });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchCallCustomerProfiles({ holdingId: selectedHoldingId }),
      fetchCallScripts({ holdingId: selectedHoldingId }),
      fetchCallPlans({ holdingId: selectedHoldingId }),
      fetchCallPlanOptions({ holdingId: selectedHoldingId }),
    ])
      .then(([nextProfiles, nextScripts, nextPlans, nextPlanOptions]) => {
        if (cancelled) return;
        setProfiles(nextProfiles);
        setScripts(nextScripts);
        setPlans(nextPlans);
        setPlanOptions(nextPlanOptions);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить настройки обзвона.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedHoldingId]);

  useEffect(() => {
    if (route.tab !== 'scripts') {
      setScriptEditorOpen(false);
      setEditingScript(null);
      return;
    }
    if (route.create) {
      setEditingScript(null);
      setScriptEditorOpen(true);
      return;
    }
    if (route.scriptId) {
      const script = scripts.find((item) => item.id === route.scriptId);
      if (script) {
        setEditingScript(script);
        setScriptEditorOpen(true);
      } else if (!loading && scripts.length > 0) {
        setError('Скрипт не найден в выбранной компании.');
        navigate(CALL_SETTINGS_PATHS.scripts, { replace: true });
      }
      return;
    }
    setScriptEditorOpen(false);
    setEditingScript(null);
  }, [loading, navigate, route, scripts]);

  useEffect(() => {
    if (route.tab !== 'plan') {
      setPlanEditorOpen(false);
      setSelectedPlan(null);
      setPlanCalls([]);
      setExpandedCallId(null);
      return;
    }
    if (route.create) {
      setSelectedPlan(null);
      setPlanCalls([]);
      setExpandedCallId(null);
      setPlanEditorOpen(true);
      return;
    }
    setPlanEditorOpen(false);
    if (!route.planId) {
      setSelectedPlan(null);
      setPlanCalls([]);
      setExpandedCallId(null);
      return;
    }
    const plan = plans.find((item) => item.id === route.planId);
    if (!plan) {
      if (!loading) {
        setError('План прозвона не найден в выбранной компании.');
        navigate(CALL_SETTINGS_PATHS.plan, { replace: true });
      }
      return;
    }
    if (route.edit) {
      setSelectedPlan(plan);
      setPlanCalls([]);
      setExpandedCallId(null);
      setPlanEditorOpen(true);
      return;
    }
    setPlanEditorOpen(false);
    if (selectedPlan?.id !== plan.id || selectedPlan.updatedAt !== plan.updatedAt) {
      void openPlanHistory(plan, { skipNavigate: true });
    }
  }, [loading, navigate, plans, route, selectedPlan?.id, selectedPlan?.updatedAt]);

  const sortedProfiles = useMemo(
    () => [...profiles].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [profiles],
  );
  const sortedScripts = useMemo(
    () => [...scripts].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [scripts],
  );
  const sortedPlans = useMemo(
    () => [...plans].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [plans],
  );

  function openCreate() {
    setEditingProfile(null);
    setModalOpen(true);
  }

  function openEdit(profile: CustomerProfile) {
    setEditingProfile(profile);
    setModalOpen(true);
  }

  async function saveProfile(profile: CustomerProfileForm) {
    if (!selectedHoldingId) return;
    try {
      const saved = editingProfile
        ? await updateCallCustomerProfile(editingProfile.id, profile)
        : await createCallCustomerProfile({ holdingId: selectedHoldingId, ...profile });
      setProfiles((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists ? current.map((item) => (item.id === saved.id ? saved : item)) : [...current, saved];
      });
      setModalOpen(false);
      setEditingProfile(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить профиль клиента.');
    }
  }

  async function removeProfile(profile: CustomerProfile) {
    if (!window.confirm(`Удалить профиль "${profile.name}"?`)) return;
    try {
      await deleteCallCustomerProfile(profile.id);
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setScripts((current) => current.map((script) => ({ ...script, profileIds: script.profileIds.filter((id) => id !== profile.id) })));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить профиль клиента.');
    }
  }

  async function saveScript(script: Omit<CallScript, 'id' | 'createdAt' | 'updatedAt'>) {
    try {
      const saved = editingScript
        ? await updateCallScript(editingScript.id, script)
        : await createCallScript(script);
      setScripts((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists ? current.map((item) => (item.id === saved.id ? saved : item)) : [...current, saved];
      });
      setScriptEditorOpen(true);
      setEditingScript(saved);
      navigate(`/call-settings/scripts/${encodeURIComponent(saved.id)}`, { replace: !editingScript });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить скрипт.');
    }
  }

  function openScriptEditor(script?: CallScript) {
    navigate(script ? `/call-settings/scripts/${encodeURIComponent(script.id)}` : '/call-settings/scripts/new');
  }

  async function removeScript(script: CallScript) {
    if (!window.confirm(`Удалить скрипт "${script.name}"?`)) return;
    try {
      await deleteCallScript(script.id);
      setScripts((current) => current.filter((item) => item.id !== script.id));
      if (route.tab === 'scripts' && route.scriptId === script.id) navigate(CALL_SETTINGS_PATHS.scripts, { replace: true });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить скрипт.');
    }
  }

  async function savePlan(plan: CallPlanForm) {
    try {
      const saved = route.tab === 'plan' && route.edit && route.planId
        ? await updateCallPlan(route.planId, plan)
        : await createCallPlan(plan);
      setPlans((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current];
      });
      setPlanEditorOpen(false);
      navigate(`/call-settings/plans/${encodeURIComponent(saved.id)}`, { replace: true });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить план прозвона.');
    }
  }

  async function initiatePlan(plan: CallPlan) {
    try {
      const result = await initiateCallPlan(plan.id);
      setPlans((current) => current.map((item) => item.id === result.item.id ? result.item : item));
      setNotice(`Прозвон инициирован: ${result.totalJobs} звонков.`);
      if (selectedPlan?.id === plan.id || route.planId === plan.id) await openPlanHistory(result.item, { skipNavigate: true });
    } catch (initError) {
      setError(initError instanceof Error ? initError.message : 'Не удалось инициировать прозвон.');
    }
  }

  async function openPlanHistory(plan: CallPlan, options?: { skipNavigate?: boolean }) {
    if (!options?.skipNavigate) navigate(`/call-settings/plans/${encodeURIComponent(plan.id)}`);
    setSelectedPlan(plan);
    setExpandedCallId(null);
    setPlanCallsLoading(true);
    try {
      setPlanCalls(await fetchCallPlanCalls(plan.id));
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : 'Не удалось загрузить историю прозвона.');
    } finally {
      setPlanCallsLoading(false);
    }
  }

  async function openPromptPreview(plan: CallPlan) {
    try {
      setPromptPreviewLoadingId(plan.id);
      const preview = await previewCallPlanPrompt(plan.id);
      setPromptPreview(preview);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Не удалось сгенерировать промпт.');
    } finally {
      setPromptPreviewLoadingId(null);
    }
  }

  async function copyPromptPreview() {
    if (!promptPreview) return;
    try {
      await navigator.clipboard.writeText(promptPreview.prompt);
      setNotice('Промпт скопирован.');
    } catch {
      setNotice('Не удалось скопировать автоматически.');
    }
  }

  if (scriptEditorOpen) {
    return (
      <ScriptEditor
        holdingId={selectedHoldingId}
        initialScript={editingScript}
        profiles={sortedProfiles}
        onBack={() => navigate(CALL_SETTINGS_PATHS.scripts)}
        onSave={saveScript}
      />
    );
  }

  if (planEditorOpen) {
    const initialPlan = route.tab === 'plan' && route.planId
      ? plans.find((plan) => plan.id === route.planId) ?? selectedPlan
      : null;
    return (
      <CallPlanEditor
        holdingId={selectedHoldingId}
        options={{ ...planOptions, scripts: sortedScripts }}
        initialPlan={initialPlan}
        onBack={() => {
          if (route.tab === 'plan' && route.planId) navigate(`/call-settings/plans/${encodeURIComponent(route.planId)}`);
          else navigate(CALL_SETTINGS_PATHS.plan);
        }}
        onSave={savePlan}
      />
    );
  }

  if (selectedPlan) {
    const selectedScript = scripts.find((script) => script.id === selectedPlan.scriptId);
    const selectedPhoneType = planOptions.phoneNumberTypes.find((type) => type.id === selectedPlan.phoneNumberTypeId);
    const selectedTargetItems = selectedPlan.targetType === 'employees'
      ? planOptions.employees.filter((employee) => selectedPlan.targetIds.includes(employee.id)).map((employee) => ({
        id: employee.id,
        title: employee.fullName,
        meta: employee.dealershipName,
      }))
      : planOptions.dealerships.filter((dealership) => selectedPlan.targetIds.includes(dealership.id)).map((dealership) => ({
        id: dealership.id,
        title: dealership.name,
        meta: `${dealership.city || 'Город не указан'} · сотрудников: ${dealership.employeesCount}`,
      }));
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <section className="sa-card" style={{ padding: 20, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h1 className="sa-page-title" style={{ marginBottom: 6 }}>{selectedPlan.name}</h1>
            <div className="sa-meta">Состав плана, история прозвонов и аналитика.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="sa-btn-outline" onClick={() => openPlanHistory(selectedPlan)}>Обновить</button>
            <button type="button" className="sa-btn-outline" onClick={() => navigate(`/call-settings/plans/${encodeURIComponent(selectedPlan.id)}/edit`)}>Редактировать</button>
            <button type="button" className="sa-btn-primary" onClick={() => initiatePlan(selectedPlan)}>Заинициировать сейчас</button>
            <button type="button" className="sa-btn-outline" onClick={() => navigate(CALL_SETTINGS_PATHS.plan)}>Назад к планам</button>
          </div>
        </section>
        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Из чего состоит план</h2>
            <span className="sa-chip">ID: {selectedPlan.id}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
            <div className="sa-card" style={{ padding: 12 }}>
              <div className="sa-meta">Аудитория</div>
              <strong>{selectedPlan.targetType === 'employees' ? 'Сотрудники' : 'Точки'}</strong>
              <div className="sa-meta" style={{ marginTop: 4 }}>{selectedTargetItems.length} выбрано</div>
            </div>
            <div className="sa-card" style={{ padding: 12 }}>
              <div className="sa-meta">Скрипт</div>
              <strong>{selectedScript?.name || 'Не найден'}</strong>
            </div>
            <div className="sa-card" style={{ padding: 12 }}>
              <div className="sa-meta">Тип номера</div>
              <strong>{selectedPhoneType?.name || 'Не найден'}</strong>
            </div>
            <div className="sa-card" style={{ padding: 12 }}>
              <div className="sa-meta">Расписание</div>
              <strong>{PLAN_FREQUENCIES.find((item) => item.value === selectedPlan.frequency)?.label || selectedPlan.frequency}</strong>
              <div className="sa-meta" style={{ marginTop: 4 }}>{selectedPlan.callTimeFrom} - {selectedPlan.callTimeTo}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontWeight: 700 }}>Выбранные {selectedPlan.targetType === 'employees' ? 'сотрудники' : 'точки'}</div>
            {selectedTargetItems.length === 0 ? (
              <div className="sa-meta">Выбранные элементы не найдены в текущей компании.</div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {selectedTargetItems.slice(0, 24).map((item) => (
                  <span key={item.id} className="sa-chip" title={item.meta}>{item.title}</span>
                ))}
                {selectedTargetItems.length > 24 && <span className="sa-chip">+{selectedTargetItems.length - 24}</span>}
              </div>
            )}
          </div>
        </section>
        <section className="sa-card" style={{ padding: 20 }}>
          {planCallsLoading ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Загрузка...</div>
          ) : planCalls.length === 0 ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Звонков по этому плану пока нет.</div>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th style={{ width: 170 }}>ID обзвона</th>
                    <th style={{ width: 170 }}>Номер</th>
                    <th style={{ width: 150 }}>Статус</th>
                    <th style={{ width: 120 }}>Оценка</th>
                    <th style={{ width: 190 }}>Дата</th>
                  </tr>
                </thead>
                <tbody>
                  {planCalls.map((call) => {
                    const analytics = getEvaluationSummary(call.evaluation);
                    const expanded = expandedCallId === call.id;
                    const score = call.totalScore ?? analytics.overallScore;
                    return (
                      <React.Fragment key={call.id}>
                        <tr>
                          <td>
                            <strong>{call.employeeName || 'Сотрудник'}</strong>
                            <div className="sa-meta" style={{ marginTop: 4 }}>{call.dealershipName || 'Точка не указана'}</div>
                            {call.failureReason && <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>{call.failureReason}</div>}
                          </td>
                          <td>
                            <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{call.callId}</code>
                          </td>
                          <td>{call.phone}</td>
                          <td>{call.outcome || call.status}</td>
                          <td>
                            {score != null ? Math.round(score) : '—'}
                            {analytics.planPercent != null && <div className="sa-meta" style={{ marginTop: 4 }}>Условия: {Math.round(analytics.planPercent)}%</div>}
                          </td>
                          <td>
                            <div>{new Date(call.startedAt).toLocaleString('ru-RU')}</div>
                            <button
                              type="button"
                              className="sa-link-button"
                              onClick={() => setExpandedCallId(expanded ? null : call.id)}
                              style={{ padding: 0, border: 0, background: 'transparent', color: 'var(--sa-accent)', fontWeight: 700, cursor: 'pointer', marginTop: 6 }}
                            >
                              {expanded ? 'Скрыть аналитику' : 'Показать аналитику'}
                            </button>
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={6} style={{ background: '#f8fafc', padding: 16 }}>
                              <div style={{ display: 'grid', gap: 14 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                                  <div className="sa-card" style={{ padding: 12 }}>
                                    <div className="sa-meta">ID обзвона</div>
                                    <code style={{ display: 'block', marginTop: 6, fontSize: 12, wordBreak: 'break-all' }}>{call.callId}</code>
                                  </div>
                                  <div className="sa-card" style={{ padding: 12 }}>
                                    <div className="sa-meta">Общая оценка</div>
                                    <strong style={{ fontSize: 22 }}>{score != null ? `${Math.round(score)} / 100` : 'Нет оценки'}</strong>
                                  </div>
                                  <div className="sa-card" style={{ padding: 12 }}>
                                    <div className="sa-meta">Условия успеха</div>
                                    <strong style={{ fontSize: 22 }}>
                                      {analytics.planPercent != null ? `${Math.round(analytics.planPercent)}%` : 'Нет данных'}
                                    </strong>
                                    {analytics.planTotal != null && analytics.planMax != null && (
                                      <div className="sa-meta" style={{ marginTop: 4 }}>{analytics.planTotal} из {analytics.planMax} баллов</div>
                                    )}
                                  </div>
                                  <div className="sa-card" style={{ padding: 12 }}>
                                    <div className="sa-meta">Транскрипт</div>
                                    <strong style={{ fontSize: 22 }}>{call.transcript.length}</strong>
                                    <div className="sa-meta" style={{ marginTop: 4 }}>реплик</div>
                                  </div>
                                </div>

                                {analytics.summary && (
                                  <div className="sa-card" style={{ padding: 12 }}>
                                    <div className="sa-meta" style={{ marginBottom: 6 }}>Краткий вывод</div>
                                    <div style={{ fontSize: 14, lineHeight: 1.5 }}>{analytics.summary}</div>
                                  </div>
                                )}

                                {analytics.criteriaItems.length > 0 && (
                                  <div className="sa-card" style={{ padding: 12, display: 'grid', gap: 10 }}>
                                    <div style={{ fontWeight: 700 }}>Оценка условий успеха</div>
                                    {analytics.criteriaItems.map((item, index) => {
                                      const expected = asText(item.expectedAnswer);
                                      const evidence = asText(item.evidence);
                                      const rawMaxScore = asNumber(item.maxScore) ?? 0;
                                      const rawItemScore = asNumber(item.score) ?? 0;
                                      const maxScore = Math.max(0, rawMaxScore);
                                      const itemScore = Math.max(0, Math.min(maxScore, rawItemScore));
                                      return (
                                        <div key={`${expected}-${index}`} style={{ borderTop: index === 0 ? 0 : '1px solid var(--sa-divider)', paddingTop: index === 0 ? 0 : 10 }}>
                                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                                            <div style={{ fontWeight: 600 }}>{expected || `Критерий ${index + 1}`}</div>
                                            <span className="sa-chip">{itemScore} / {maxScore}</span>
                                          </div>
                                          {evidence && <div className="sa-meta" style={{ marginTop: 5, lineHeight: 1.45 }}>{evidence}</div>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}

                                {(analytics.strengths.length > 0 || analytics.issues.length > 0 || analytics.recommendations.length > 0) && (
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                                    {analytics.strengths.length > 0 && (
                                      <div className="sa-card" style={{ padding: 12 }}>
                                        <div style={{ fontWeight: 700, marginBottom: 8 }}>Сильные стороны</div>
                                        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--sa-text-secondary)', fontSize: 13, lineHeight: 1.45 }}>
                                          {analytics.strengths.slice(0, 5).map((item) => <li key={item}>{item}</li>)}
                                        </ul>
                                      </div>
                                    )}
                                    {analytics.issues.length > 0 && (
                                      <div className="sa-card" style={{ padding: 12 }}>
                                        <div style={{ fontWeight: 700, marginBottom: 8 }}>Что просело</div>
                                        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--sa-text-secondary)', fontSize: 13, lineHeight: 1.45 }}>
                                          {analytics.issues.slice(0, 5).map((item) => <li key={item}>{item}</li>)}
                                        </ul>
                                      </div>
                                    )}
                                    {analytics.recommendations.length > 0 && (
                                      <div className="sa-card" style={{ padding: 12 }}>
                                        <div style={{ fontWeight: 700, marginBottom: 8 }}>Рекомендации</div>
                                        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--sa-text-secondary)', fontSize: 13, lineHeight: 1.45 }}>
                                          {analytics.recommendations.slice(0, 5).map((item) => <li key={item}>{item}</li>)}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                )}

                                {call.transcript.length > 0 && (
                                  <div className="sa-card" style={{ padding: 12, display: 'grid', gap: 8 }}>
                                    <div style={{ fontWeight: 700 }}>Транскрипт</div>
                                    <div style={{ display: 'grid', gap: 8, maxHeight: 300, overflow: 'auto' }}>
                                      {call.transcript.map((turn, index) => (
                                        <div key={`${turn.role}-${index}`} style={{ display: 'grid', gap: 3 }}>
                                          <span className="sa-meta">{turn.role === 'client' ? 'Клиент' : 'Сотрудник'}</span>
                                          <div style={{ fontSize: 13, lineHeight: 1.45 }}>{turn.text}</div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h1 className="sa-page-title" style={{ marginBottom: 6 }}>Настройки обзвона</h1>
            <div style={{ color: 'var(--sa-text-secondary)', fontSize: 14 }}>Профили клиентов, скрипты и план прозвона.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <select
              className="sa-select"
              value={selectedHoldingId}
              onChange={(event) => setSelectedHoldingId(event.target.value)}
              disabled={holdingsLoading || holdings.length === 0}
              style={{ minWidth: 220 }}
            >
              {holdings.length === 0 ? <option value="">Нет компаний</option> : null}
              {holdings.map((holding) => <option key={holding.id} value={holding.id}>{holding.name}</option>)}
            </select>
            {activeTab === 'profiles' && (
              <button type="button" className="sa-btn-primary" disabled={!selectedHoldingId} onClick={openCreate}>Создать профиль клиента</button>
            )}
            {activeTab === 'scripts' && (
              <button type="button" className="sa-btn-primary" disabled={!selectedHoldingId} onClick={() => openScriptEditor()}>Создать скрипт</button>
            )}
            {activeTab === 'plan' && (
              <button type="button" className="sa-btn-primary" disabled={!selectedHoldingId} onClick={() => navigate('/call-settings/plans/new')}>Создать обзвон</button>
            )}
          </div>
        </div>

        <div className="sa-dialog-tabs" style={{ marginBottom: 0 }}>
          <button type="button" className={`sa-dialog-tab ${activeTab === 'profiles' ? 'sa-dialog-tab-active' : ''}`} onClick={() => navigate(CALL_SETTINGS_PATHS.profiles)}>Профили клиентов</button>
          <button type="button" className={`sa-dialog-tab ${activeTab === 'scripts' ? 'sa-dialog-tab-active' : ''}`} onClick={() => navigate(CALL_SETTINGS_PATHS.scripts)}>Скрипты</button>
          <button type="button" className={`sa-dialog-tab ${activeTab === 'plan' ? 'sa-dialog-tab-active' : ''}`} onClick={() => navigate(CALL_SETTINGS_PATHS.plan)}>План прозвона</button>
        </div>
      </section>

      {error && <div style={{ padding: 12, borderRadius: 14, background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>{error}</div>}
      {notice && <div style={{ padding: 12, borderRadius: 14, background: '#eff6ff', color: '#1d4ed8', fontSize: 14 }}>{notice}</div>}

      {activeTab === 'profiles' && (
        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          {loading ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Загрузка...</div>
          ) : sortedProfiles.length === 0 ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Профилей клиентов пока нет.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {sortedProfiles.map((profile) => (
                <article key={profile.id} className="sa-card" style={{ padding: 14, display: 'grid', gap: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ margin: 0, fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.name}</h3>
                      <div className="sa-meta" style={{ marginTop: 4 }}>{profile.age} лет · {voiceLabel(profile.voiceId)}</div>
                    </div>
                    <span className="sa-chip">{optionLabel(TEMPERAMENTS, profile.temperament)}</span>
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span className="sa-chip">Терпение: {optionLabel(PATIENCE, profile.patience).toLowerCase()}</span>
                    <span className="sa-chip">Реплики: {optionLabel(REPLY_LENGTHS, profile.replyLength).toLowerCase()}</span>
                  </div>

                  {profile.communicationStyle && (
                    <div style={{ borderTop: '1px solid var(--sa-divider)', paddingTop: 10, color: 'var(--sa-text-secondary)', fontSize: 13, lineHeight: 1.45, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden', whiteSpace: 'pre-line' }}>
                      {profile.communicationStyle}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => openEdit(profile)}>Редактировать</button>
                    <button type="button" className="sa-btn-danger sa-btn-sm" onClick={() => removeProfile(profile)}>Удалить</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === 'scripts' && (
        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          {loading ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Загрузка...</div>
          ) : sortedScripts.length === 0 ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Скриптов пока нет.</div>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th>Название</th>
                    <th style={{ width: 220 }}>Профили</th>
                    <th style={{ width: 180 }}>Выборка</th>
                    <th style={{ width: 120 }}>Вопросы</th>
                    <th style={{ width: 140 }}>Возражения</th>
                    <th style={{ width: 190 }} />
                  </tr>
                </thead>
                <tbody>
                  {sortedScripts.map((script) => {
                    const profileNames = script.profileIds
                      .map((id) => profiles.find((profile) => profile.id === id)?.name)
                      .filter(Boolean)
                      .join(', ');
                    return (
                      <tr key={script.id}>
                        <td>
                          <strong>{script.name}</strong>
                          {script.context && (
                            <div className="sa-meta" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{script.context}</div>
                          )}
                        </td>
                        <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={profileNames}>{profileNames || '—'}</td>
                        <td>{script.dataCondition.tags.length ? `${script.dataCondition.tags.length} тегов` : 'Без тегов'}</td>
                        <td>{script.questions.length}</td>
                        <td>{script.objections.length}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                            <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => openScriptEditor(script)}>Открыть</button>
                            <button type="button" className="sa-btn-danger sa-btn-sm" onClick={() => removeScript(script)}>Удалить</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeTab === 'plan' && (
        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          {loading ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Загрузка...</div>
          ) : sortedPlans.length === 0 ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Планов прозвона пока нет.</div>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th>План</th>
                    <th style={{ width: 160 }}>Аудитория</th>
                    <th style={{ width: 180 }}>Скрипт</th>
                    <th style={{ width: 150 }}>Частотность</th>
                    <th style={{ width: 140 }}>Время</th>
                    <th style={{ width: 230 }} />
                  </tr>
                </thead>
                <tbody>
                  {sortedPlans.map((plan) => {
                    const script = scripts.find((item) => item.id === plan.scriptId);
                    const targetCount = plan.targetType === 'employees'
                      ? plan.targetIds.length
                      : planOptions.dealerships.filter((item) => plan.targetIds.includes(item.id)).reduce((sum, item) => sum + item.employeesCount, 0);
                    return (
                      <tr key={plan.id}>
                        <td>
                          <button type="button" className="sa-link-button" onClick={() => openPlanHistory(plan)} style={{ padding: 0, border: 0, background: 'transparent', color: 'var(--sa-accent)', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>{plan.name}</button>
                          {plan.lastInitiatedAt && (
                            <div className="sa-meta" style={{ marginTop: 4 }}>Последний запуск: {new Date(plan.lastInitiatedAt).toLocaleString('ru-RU')}</div>
                          )}
                        </td>
                        <td>{plan.targetType === 'employees' ? `Сотрудники: ${targetCount}` : `Точки: ${plan.targetIds.length} · сотрудников: ${targetCount}`}</td>
                        <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={script?.name || ''}>{script?.name || '—'}</td>
                        <td>{PLAN_FREQUENCIES.find((item) => item.value === plan.frequency)?.label || plan.frequency}</td>
                        <td>{plan.callTimeFrom} - {plan.callTimeTo}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="sa-btn-outline sa-btn-icon"
                              onClick={() => openPlanHistory(plan)}
                              aria-label="Посмотреть план"
                              title="Посмотреть план"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="sa-btn-outline sa-btn-icon"
                              onClick={() => openPromptPreview(plan)}
                              aria-label="Тест промпта"
                              title="Тест промпта"
                              disabled={promptPreviewLoadingId === plan.id}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M10 2v6L5 19a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3L14 8V2" />
                                <path d="M8 2h8" />
                                <path d="M7 16h10" />
                              </svg>
                            </button>
                            <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => initiatePlan(plan)}>Заинициировать сейчас</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <ProfileModal
        open={modalOpen}
        initialProfile={editingProfile}
        onClose={() => { setModalOpen(false); setEditingProfile(null); }}
        onSave={saveProfile}
      />
      <PromptPreviewModal
        preview={promptPreview}
        onClose={() => setPromptPreview(null)}
        onCopy={copyPromptPreview}
      />
    </div>
  );
}
