import React, { useEffect, useMemo, useState } from 'react';
import { useUnit } from 'effector-react';
import { useLocation, useNavigate } from 'react-router';
import {
  createCallCustomerProfile,
  createCallCustomerVoice,
  createCallPlan,
  createCallScript,
  deleteCallCustomerProfile,
  deleteCallCustomerVoice,
  deleteCallScript,
  fetchAuditDetail,
  fetchCallPlanOptions,
  fetchCallPlans,
  fetchCallPlanCalls,
  fetchCallCustomerProfiles,
  fetchCallCustomerVoices,
  fetchCallScripts,
  fetchHoldings,
  fetchImportedItems,
  fetchImportedTags,
  initiateCallPlan,
  previewCallPlanPrompt,
  updateCallCustomerProfile,
  updateCallCustomerVoice,
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
  type CallCustomerVoiceItem,
  type CallScriptItem,
  type CallScriptSuccessCriterion,
  type CustomerPatience,
  type CustomerTemperament,
  type AuditDetailItem,
  type HoldingItem,
  type ReplyLength,
} from '../../../shared/api/adminPanel';
import { useGlobalHoldingFilter } from '../../../shared/lib/global-holding-filter/useGlobalHoldingFilter';
import { $auth } from '../../../entities/session';
import { HoldingSelectPicker } from '../../../shared/ui/filter-picker/HoldingSelectPicker';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { ModalPortal } from '../../../shared/ui/ModalPortal';
import { SlideOver } from '../../../shared/ui/slide-over';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';

type CallSettingsTab = 'profiles' | 'scripts' | 'plan';
type CallSettingsRoute =
  | { tab: 'profiles' }
  | { tab: 'scripts'; scriptId?: string; create?: boolean }
  | { tab: 'plan'; planId?: string; create?: boolean; edit?: boolean };
type CustomerProfile = CallCustomerProfileItem;
type CustomerVoice = CallCustomerVoiceItem;
type CustomerProfileForm = Omit<CustomerProfile, 'id' | 'holdingId' | 'createdAt' | 'updatedAt'>;
type CustomerVoiceForm = Omit<CustomerVoice, 'createdAt' | 'updatedAt' | 'isDeleted'>;
type SuccessCriterion = CallScriptSuccessCriterion;
type CallScript = CallScriptItem;
type CallScriptForm = Omit<CallScript, 'id' | 'holdingId' | 'createdAt' | 'updatedAt'>;
type CallPlan = CallPlanItem;
type CallPlanForm = Omit<CallPlan, 'id' | 'createdAt' | 'updatedAt' | 'lastInitiatedAt' | 'lastBatchId'>;

const FALLBACK_VOICE_ID = 'marin';

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
  { value: 'manual', label: 'Вручную' },
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekly', label: 'Раз в неделю' },
];

const CALL_SETTINGS_PATHS: Record<CallSettingsTab, string> = {
  profiles: '/call-settings/profiles',
  scripts: '/call-settings/scripts',
  plan: '/call-settings/plans',
};

function formatPlanCallDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatPlanCallStatus(outcome: string | null | undefined, status: string | null | undefined): string {
  const value = String(outcome || status || '').trim().toLowerCase();
  if (value === 'completed' || value === 'disconnected') return 'Завершено';
  if (value === 'no_answer') return 'Недозвон';
  if (value === 'busy') return 'Занято';
  if (value === 'failed') return 'Ошибка';
  if (value === 'voicemail') return 'Автоответчик';
  if (value === 'running' || value === 'dialing' || value === 'in_progress' || value === 'progress') return 'В работе';
  if (value === 'retry_wait') return 'Ожидает повтора';
  if (value === 'queued') return 'В очереди';
  if (value === 'cancelled' || value === 'canceled') return 'Отменено';
  return value || '—';
}

function planCallStatusClass(outcome: string | null | undefined, status: string | null | undefined): string {
  const value = String(outcome || status || '').trim().toLowerCase();
  if (value === 'completed' || value === 'disconnected') return 'sa-audit-status-completed';
  if (value === 'failed') return 'sa-audit-status-failed';
  return 'sa-audit-status-interrupted';
}

const EMPTY_FORM: CustomerProfileForm = {
  name: '',
  voiceId: FALLBACK_VOICE_ID,
  age: 35,
  ageFrom: 30,
  ageTo: 40,
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

function voiceLabel(id: string, voices: CustomerVoice[]): string {
  return voices.find((voice) => voice.id === id)?.name || 'Универсальный';
}

function normalizeAgeRange(ageFrom: number, ageTo: number): { ageFrom: number; ageTo: number; age: number } {
  const from = Math.max(18, Math.min(65, Math.round(Number.isFinite(ageFrom) ? ageFrom : 35)));
  const to = Math.max(18, Math.min(65, Math.round(Number.isFinite(ageTo) ? ageTo : from)));
  const normalizedFrom = Math.min(from, to);
  const normalizedTo = Math.max(from, to);
  return {
    ageFrom: normalizedFrom,
    ageTo: normalizedTo,
    age: Math.round((normalizedFrom + normalizedTo) / 2),
  };
}

function ageRangeLabel(profile: Pick<CustomerProfile, 'age' | 'ageFrom' | 'ageTo'>): string {
  const { ageFrom, ageTo } = normalizeAgeRange(profile.ageFrom ?? profile.age, profile.ageTo ?? profile.age);
  return ageFrom === ageTo ? `${ageFrom} лет` : `${ageFrom}-${ageTo} лет`;
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
    <ModalPortal open={props.open} onClose={props.onClose} modalClassName="sa-modal-medium">
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
    </ModalPortal>
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
    <ModalPortal open={props.open} onClose={props.onClose} modalClassName="sa-modal-medium">
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
    </ModalPortal>
  );
}

function ProfileModal(props: {
  open: boolean;
  initialProfile: CustomerProfile | null;
  voices: CustomerVoice[];
  onClose: () => void;
  onSave: (profile: CustomerProfileForm) => void;
}) {
  const [form, setForm] = useState<CustomerProfileForm>(EMPTY_FORM);
  const isEdit = Boolean(props.initialProfile);
  const activeVoices = useMemo(() => props.voices.filter((voice) => voice.isEnabled), [props.voices]);
  const selectedVoice = props.voices.find((voice) => voice.id === form.voiceId);
  const visibleVoices = useMemo(
    () => selectedVoice && !activeVoices.some((voice) => voice.id === selectedVoice.id)
      ? [selectedVoice, ...activeVoices]
      : activeVoices,
    [activeVoices, selectedVoice],
  );

  useEffect(() => {
    if (!props.open) return;
    if (props.initialProfile) {
      setForm({
        name: props.initialProfile.name,
        voiceId: props.initialProfile.voiceId,
        age: props.initialProfile.age,
        ageFrom: props.initialProfile.ageFrom ?? props.initialProfile.age,
        ageTo: props.initialProfile.ageTo ?? props.initialProfile.age,
        character: '',
        temperament: props.initialProfile.temperament,
        patience: props.initialProfile.patience,
        replyLength: props.initialProfile.replyLength,
        communicationStyle: props.initialProfile.communicationStyle,
      });
    } else {
      setForm({ ...EMPTY_FORM, voiceId: activeVoices[0]?.id ?? FALLBACK_VOICE_ID });
    }
  }, [props.open, props.initialProfile, activeVoices]);

  if (!props.open) return null;

  function save(event: React.FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    props.onSave({
      ...form,
      name,
      ...normalizeAgeRange(form.ageFrom, form.ageTo),
      character: '',
      communicationStyle: form.communicationStyle.trim(),
    });
  }

  return (
    <ModalPortal open={props.open} onClose={props.onClose} modalClassName="sa-modal-medium">
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
            <select className="sa-select" value={form.voiceId} onChange={(event) => setForm((current) => ({ ...current, voiceId: event.target.value }))} disabled={activeVoices.length === 0}>
              {visibleVoices.length === 0 && <option value={form.voiceId}>Нет включенных голосов</option>}
              {visibleVoices.map((voice) => (
                <option key={voice.id} value={voice.id} disabled={!voice.isEnabled}>
                  {voice.name}{voice.isEnabled ? '' : ' (выключен)'}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 8 }}>
            <span>Возраст: {form.ageFrom === form.ageTo ? form.ageFrom : `${form.ageFrom}-${form.ageTo}`}</span>
            <div style={{ position: 'relative', height: 28, display: 'grid', alignItems: 'center' }}>
              <div style={{ position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 999, background: '#e5e7eb' }} />
              <div
                style={{
                  position: 'absolute',
                  left: `${((Math.min(form.ageFrom, form.ageTo) - 18) / 47) * 100}%`,
                  right: `${100 - ((Math.max(form.ageFrom, form.ageTo) - 18) / 47) * 100}%`,
                  height: 4,
                  borderRadius: 999,
                  background: '#6366f1',
                }}
              />
              <input
                type="range"
                min={18}
                max={65}
                value={form.ageFrom}
                onChange={(event) => setForm((current) => {
                  const nextFrom = Number(event.target.value);
                  const ageFrom = Math.min(nextFrom, current.ageTo);
                  return { ...current, ageFrom, age: Math.round((ageFrom + current.ageTo) / 2) };
                })}
                className="sa-range-thumb"
                style={{ position: 'absolute', inset: 0, width: '100%', margin: 0, background: 'transparent' }}
              />
              <input
                type="range"
                min={18}
                max={65}
                value={form.ageTo}
                onChange={(event) => setForm((current) => {
                  const nextTo = Number(event.target.value);
                  const ageTo = Math.max(nextTo, current.ageFrom);
                  return { ...current, ageTo, age: Math.round((current.ageFrom + ageTo) / 2) };
                })}
                className="sa-range-thumb"
                style={{ position: 'absolute', inset: 0, width: '100%', margin: 0, background: 'transparent' }}
              />
            </div>
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
            <button type="submit" className="sa-btn-primary" disabled={!form.name.trim() || activeVoices.length === 0}>{isEdit ? 'Сохранить профиль' : 'Создать профиль'}</button>
          </div>
        </form>
    </ModalPortal>
  );
}

function VoicesModal(props: {
  open: boolean;
  voices: CustomerVoice[];
  savingId: string | null;
  onClose: () => void;
  onCreate: (voice: CustomerVoiceForm) => Promise<void>;
  onUpdate: (id: string, voice: Omit<CustomerVoiceForm, 'id'>) => Promise<void>;
  onDelete: (voice: CustomerVoice) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, CustomerVoiceForm>>({});
  const [newVoice, setNewVoice] = useState<CustomerVoiceForm>({
    id: '',
    name: '',
    elevenLabsCode: '',
    openaiCode: '',
    isEnabled: true,
  });

  useEffect(() => {
    if (!props.open) return;
    setDrafts(Object.fromEntries(props.voices.map((voice) => [voice.id, {
      id: voice.id,
      name: voice.name,
      elevenLabsCode: voice.elevenLabsCode || '',
      openaiCode: voice.openaiCode || '',
      isEnabled: voice.isEnabled,
    }])));
    setNewVoice({ id: '', name: '', elevenLabsCode: '', openaiCode: '', isEnabled: true });
  }, [props.open, props.voices]);

  if (!props.open) return null;

  function updateDraft(id: string, patch: Partial<CustomerVoiceForm>) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  async function saveDraft(id: string) {
    const draft = drafts[id];
    if (!draft?.name.trim()) return;
    await props.onUpdate(id, {
      name: draft.name.trim(),
      elevenLabsCode: draft.elevenLabsCode?.trim() || null,
      openaiCode: draft.openaiCode?.trim() || null,
      isEnabled: draft.isEnabled,
    });
  }

  async function createVoice(event: React.FormEvent) {
    event.preventDefault();
    const id = newVoice.id.trim();
    const name = newVoice.name.trim();
    if (!id || !name) return;
    await props.onCreate({
      id,
      name,
      elevenLabsCode: newVoice.elevenLabsCode?.trim() || null,
      openaiCode: newVoice.openaiCode?.trim() || null,
      isEnabled: newVoice.isEnabled,
    });
    setNewVoice({ id: '', name: '', elevenLabsCode: '', openaiCode: '', isEnabled: true });
  }

  return (
    <ModalPortal open={props.open} onClose={props.onClose} modalClassName="sa-modal-wide">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 24 }}>Голоса клиентов</h2>
            <div className="sa-meta" style={{ marginTop: 4 }}>Доступно только суперадминам. Выключенные голоса нельзя выбрать в профиле клиента.</div>
          </div>
          <button type="button" className="sa-btn-outline sa-btn-icon" onClick={props.onClose} aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="sa-table-wrap" style={{ maxHeight: '44vh', overflow: 'auto' }}>
          <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: 140 }}>ID</th>
                <th>Название</th>
                <th>ElevenLabs</th>
                <th>OpenAI</th>
                <th style={{ width: 130 }}>Статус</th>
                <th style={{ width: 210 }} />
              </tr>
            </thead>
            <tbody>
              {props.voices.map((voice) => {
                const draft = drafts[voice.id] ?? {
                  id: voice.id,
                  name: voice.name,
                  elevenLabsCode: voice.elevenLabsCode || '',
                  openaiCode: voice.openaiCode || '',
                  isEnabled: voice.isEnabled,
                };
                return (
                  <tr key={voice.id}>
                    <td><code>{voice.id}</code></td>
                    <td><input className="sa-input" value={draft.name} onChange={(event) => updateDraft(voice.id, { name: event.target.value })} /></td>
                    <td><input className="sa-input" placeholder="может быть пусто" value={draft.elevenLabsCode || ''} onChange={(event) => updateDraft(voice.id, { elevenLabsCode: event.target.value })} /></td>
                    <td><input className="sa-input" placeholder="может быть пусто" value={draft.openaiCode || ''} onChange={(event) => updateDraft(voice.id, { openaiCode: event.target.value })} /></td>
                    <td>
                      <label className="sa-filter-check" style={{ width: 'fit-content' }}>
                        <input type="checkbox" checked={draft.isEnabled} onChange={(event) => updateDraft(voice.id, { isEnabled: event.target.checked })} />
                        Включен
                      </label>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button type="button" className="sa-btn-outline sa-btn-sm" disabled={props.savingId === voice.id || !draft.name.trim()} onClick={() => saveDraft(voice.id)}>
                          Сохранить
                        </button>
                        <button type="button" className="sa-btn-danger sa-btn-sm" disabled={props.savingId === voice.id} onClick={() => props.onDelete(voice)}>
                          Удалить
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {props.voices.length === 0 && (
                <tr><td colSpan={6} className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Голоса пока не добавлены.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form onSubmit={createVoice} style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--sa-divider)', display: 'grid', gap: 12 }}>
          <h3 className="sa-section-title" style={{ margin: 0 }}>Добавить голос</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 0.8fr) minmax(180px, 1fr) minmax(160px, 1fr) minmax(160px, 1fr) auto', gap: 10, alignItems: 'center' }}>
            <input className="sa-input" placeholder="id" value={newVoice.id} onChange={(event) => setNewVoice((current) => ({ ...current, id: event.target.value }))} />
            <input className="sa-input" placeholder="Название голоса" value={newVoice.name} onChange={(event) => setNewVoice((current) => ({ ...current, name: event.target.value }))} />
            <input className="sa-input" placeholder="код ElevenLabs" value={newVoice.elevenLabsCode || ''} onChange={(event) => setNewVoice((current) => ({ ...current, elevenLabsCode: event.target.value }))} />
            <input className="sa-input" placeholder="код OpenAI" value={newVoice.openaiCode || ''} onChange={(event) => setNewVoice((current) => ({ ...current, openaiCode: event.target.value }))} />
            <label className="sa-filter-check">
              <input type="checkbox" checked={newVoice.isEnabled} onChange={(event) => setNewVoice((current) => ({ ...current, isEnabled: event.target.checked }))} />
              Включен
            </label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="sa-btn-primary" disabled={props.savingId === 'new' || !newVoice.id.trim() || !newVoice.name.trim()}>Добавить голос</button>
          </div>
        </form>
    </ModalPortal>
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
  const isManualFrequency = frequency === 'manual';

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
          {!isManualFrequency && (
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
          )}
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
    <ModalPortal open onClose={props.onClose} modalClassName="sa-modal-wide">
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
    </ModalPortal>
  );
}

export function CallSettingsPage() {
  const auth = useUnit($auth);
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => parseCallSettingsRoute(location.pathname), [location.pathname]);
  const [activeTab, setActiveTab] = useState<CallSettingsTab>(route.tab);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [selectedHoldingId, setSelectedHoldingId] = useGlobalHoldingFilter(holdings, !holdingsLoading);
  const [profiles, setProfiles] = useState<CustomerProfile[]>([]);
  const [voices, setVoices] = useState<CustomerVoice[]>([]);
  const [scripts, setScripts] = useState<CallScript[]>([]);
  const [plans, setPlans] = useState<CallPlan[]>([]);
  const [planOptions, setPlanOptions] = useState<CallPlanOptions>({ employees: [], dealerships: [], phoneNumberTypes: [], scripts: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [voicesModalOpen, setVoicesModalOpen] = useState(false);
  const [voiceSavingId, setVoiceSavingId] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState<CustomerProfile | null>(null);
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<CallScript | null>(null);
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [promptPreview, setPromptPreview] = useState<CallPlanPromptPreview | null>(null);
  const [promptPreviewLoadingId, setPromptPreviewLoadingId] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<CallPlan | null>(null);
  const [planCalls, setPlanCalls] = useState<CallPlanCallItem[]>([]);
  const [planCallsLoading, setPlanCallsLoading] = useState(false);
  const [analyticsDrawerOpen, setAnalyticsDrawerOpen] = useState(false);
  const [analyticsDrawerLoading, setAnalyticsDrawerLoading] = useState(false);
  const [analyticsDrawerError, setAnalyticsDrawerError] = useState<string | null>(null);
  const [analyticsDrawerDetail, setAnalyticsDrawerDetail] = useState<AuditDetailItem | null>(null);
  const canManageVoices = auth.status === 'authenticated' && auth.user.allowedRoles.includes('super');

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
      fetchCallCustomerVoices(),
      fetchCallCustomerProfiles({ holdingId: selectedHoldingId }),
      fetchCallScripts({ holdingId: selectedHoldingId }),
      fetchCallPlans({ holdingId: selectedHoldingId }),
      fetchCallPlanOptions({ holdingId: selectedHoldingId }),
    ])
      .then(([nextVoices, nextProfiles, nextScripts, nextPlans, nextPlanOptions]) => {
        if (cancelled) return;
        setVoices(nextVoices);
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
      closeAnalyticsDrawer();
      return;
    }
    if (route.create) {
      setSelectedPlan(null);
      setPlanCalls([]);
      closeAnalyticsDrawer();
      setPlanEditorOpen(true);
      return;
    }
    setPlanEditorOpen(false);
    if (!route.planId) {
      setSelectedPlan(null);
      setPlanCalls([]);
      closeAnalyticsDrawer();
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
      closeAnalyticsDrawer();
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

  async function saveNewVoice(voice: CustomerVoiceForm) {
    setVoiceSavingId('new');
    setError(null);
    try {
      const created = await createCallCustomerVoice(voice);
      setVoices((current) => [...current.filter((item) => item.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name, 'ru')));
      setNotice('Голос добавлен.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось добавить голос.');
      throw saveError;
    } finally {
      setVoiceSavingId(null);
    }
  }

  async function saveExistingVoice(id: string, voice: Omit<CustomerVoiceForm, 'id'>) {
    setVoiceSavingId(id);
    setError(null);
    try {
      const updated = await updateCallCustomerVoice(id, voice);
      setVoices((current) => current.map((item) => item.id === id ? updated : item).sort((a, b) => a.name.localeCompare(b.name, 'ru')));
      setNotice('Голос обновлён.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось обновить голос.');
      throw saveError;
    } finally {
      setVoiceSavingId(null);
    }
  }

  async function removeVoice(voice: CustomerVoice) {
    if (!window.confirm(`Удалить голос "${voice.name}"? Он будет скрыт из интерфейса, но профили клиентов не сломаются.`)) return;
    setVoiceSavingId(voice.id);
    setError(null);
    try {
      await deleteCallCustomerVoice(voice.id);
      setVoices((current) => current.filter((item) => item.id !== voice.id));
      setNotice('Голос удалён из интерфейса.');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить голос.');
    } finally {
      setVoiceSavingId(null);
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
    setPlanCallsLoading(true);
    try {
      setPlanCalls(await fetchCallPlanCalls(plan.id));
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : 'Не удалось загрузить историю прозвона.');
    } finally {
      setPlanCallsLoading(false);
    }
  }

  function closeAnalyticsDrawer() {
    setAnalyticsDrawerOpen(false);
    setAnalyticsDrawerLoading(false);
    setAnalyticsDrawerError(null);
    setAnalyticsDrawerDetail(null);
  }

  async function openCallAnalyticsDrawer(call: CallPlanCallItem) {
    setAnalyticsDrawerOpen(true);
    setAnalyticsDrawerLoading(true);
    setAnalyticsDrawerError(null);
    setAnalyticsDrawerDetail(null);
    try {
      if (!call.auditId) {
        throw new Error('Аналитика ещё не готова: у звонка пока нет связанной проверки.');
      }
      const detail = await fetchAuditDetail(call.auditId);
      setAnalyticsDrawerDetail(detail);
    } catch (loadError) {
      setAnalyticsDrawerError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить аналитику звонка.');
    } finally {
      setAnalyticsDrawerLoading(false);
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
            <button type="button" className="sa-btn-primary" onClick={() => initiatePlan(selectedPlan)}>Позвонить по аудитории</button>
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
              {selectedPlan.frequency !== 'manual' && (
                <div className="sa-meta" style={{ marginTop: 4 }}>{selectedPlan.callTimeFrom} - {selectedPlan.callTimeTo}</div>
              )}
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
                    <th style={{ width: 170 }}>Номер</th>
                    <th style={{ width: 150 }}>Статус</th>
                    <th style={{ width: 120 }}>Оценка</th>
                    <th style={{ width: 130 }}>Время дозвона</th>
                    <th style={{ width: 140 }}>Время разговора</th>
                    <th style={{ width: 190 }}>Дата</th>
                  </tr>
                </thead>
                <tbody>
                  {planCalls.map((call) => {
                    const analytics = getEvaluationSummary(call.evaluation);
                    const score = call.totalScore ?? analytics.overallScore;
                    return (
                      <tr key={call.id}>
                        <td>
                          <strong>{call.employeeName || 'Сотрудник'}</strong>
                          <div className="sa-meta" style={{ marginTop: 4 }}>{call.dealershipName || 'Точка не указана'}</div>
                          {call.failureReason && <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>{call.failureReason}</div>}
                        </td>
                        <td>{call.phone}</td>
                        <td>
                          <span className={`sa-status-badge ${planCallStatusClass(call.outcome, call.status)}`}>
                            {formatPlanCallStatus(call.outcome, call.status)}
                          </span>
                        </td>
                        <td>
                          {score != null ? Math.round(score) : '—'}
                          {analytics.planPercent != null && <div className="sa-meta" style={{ marginTop: 4 }}>Условия: {Math.round(analytics.planPercent)}%</div>}
                        </td>
                        <td>{formatPlanCallDuration(call.answerTimeSec)}</td>
                        <td>{formatPlanCallDuration(call.talkDurationSec)}</td>
                        <td>
                          <div>{new Date(call.startedAt).toLocaleString('ru-RU')}</div>
                          <button
                            type="button"
                            className="sa-link-button"
                            onClick={() => void openCallAnalyticsDrawer(call)}
                            disabled={!call.auditId}
                            title={!call.auditId ? 'Аналитика появится после создания проверки по звонку' : undefined}
                            style={{ padding: 0, border: 0, background: 'transparent', color: call.auditId ? 'var(--sa-accent)' : 'var(--sa-text-secondary)', fontWeight: 700, cursor: call.auditId ? 'pointer' : 'not-allowed', marginTop: 6 }}
                          >
                            Показать аналитику
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <SlideOver open={analyticsDrawerOpen} title="Аналитика звонка" width="xl" onClose={closeAnalyticsDrawer}>
          {analyticsDrawerLoading ? (
            <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Загрузка аналитики...</div>
          ) : analyticsDrawerError ? (
            <div className="sa-card" style={{ padding: 20 }}>
              <div style={{ color: '#b91c1c', fontWeight: 700 }}>Не удалось открыть аналитику</div>
              <div className="sa-meta" style={{ marginTop: 8 }}>{analyticsDrawerError}</div>
            </div>
          ) : analyticsDrawerDetail ? (
            <AuditAnalyticsReport
              detail={analyticsDrawerDetail}
              onOpenEmployee={(employeeId) => navigate(`/users/${encodeURIComponent(employeeId)}`)}
            />
          ) : (
            <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Выберите звонок.</div>
          )}
        </SlideOver>
      </div>
    );
  }

  return (
    <div>
      <h1 className="sa-page-title">Настройки обзвона</h1>

      <div className="sa-toolbar sa-toolbar-split sa-holdings-toolbar">
        <div className="sa-toolbar-filters">
          <HoldingSelectPicker
            holdings={holdings}
            value={selectedHoldingId}
            onChange={setSelectedHoldingId}
            disabled={holdingsLoading || holdings.length === 0}
            loading={holdingsLoading}
          />
        </div>
        <div className="sa-toolbar-actions">
          {activeTab === 'profiles' && canManageVoices && (
            <button type="button" className="sa-btn-brutal-3d" onClick={() => setVoicesModalOpen(true)}>
              <LetsIcon name="sound-light" size={16} bold />
              Голоса
            </button>
          )}
          {activeTab === 'profiles' && (
            <button type="button" className="sa-btn-brutal-3d" disabled={!selectedHoldingId} onClick={openCreate}>
              <LetsIcon name="add-light" size={16} bold />
              Создать профиль клиента
            </button>
          )}
          {activeTab === 'scripts' && (
            <button type="button" className="sa-btn-brutal-3d" disabled={!selectedHoldingId} onClick={() => openScriptEditor()}>
              <LetsIcon name="add-light" size={16} bold />
              Создать скрипт
            </button>
          )}
          {activeTab === 'plan' && (
            <button type="button" className="sa-btn-brutal-3d" disabled={!selectedHoldingId} onClick={() => navigate('/call-settings/plans/new')}>
              <LetsIcon name="add-light" size={16} bold />
              Создать обзвон
            </button>
          )}
        </div>
      </div>

      <div className="sa-dialog-tabs" style={{ marginBottom: 16 }}>
        <button type="button" className={`sa-dialog-tab ${activeTab === 'profiles' ? 'sa-dialog-tab-active' : ''}`} onClick={() => navigate(CALL_SETTINGS_PATHS.profiles)}>Профили клиентов</button>
        <button type="button" className={`sa-dialog-tab ${activeTab === 'scripts' ? 'sa-dialog-tab-active' : ''}`} onClick={() => navigate(CALL_SETTINGS_PATHS.scripts)}>Скрипты</button>
        <button type="button" className={`sa-dialog-tab ${activeTab === 'plan' ? 'sa-dialog-tab-active' : ''}`} onClick={() => navigate(CALL_SETTINGS_PATHS.plan)}>План прозвона</button>
      </div>

      {error && <div className="sa-batch-live-error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="sa-batch-live-note" style={{ marginBottom: 12 }}>{notice}</div>}

      {activeTab === 'profiles' && (
        <div className="sa-companies-table-wrap sa-desktop-only">
          <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <thead>
              <tr>
                <th>Название</th>
                <th style={{ width: 110 }}>Возраст</th>
                <th style={{ width: 140 }}>Голос</th>
                <th style={{ width: 140 }}>Темперамент</th>
                <th style={{ width: 130 }}>Терпение</th>
                <th style={{ width: 130 }}>Реплики</th>
                <th>Стиль общения</th>
                <th style={{ width: 90 }} />
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка...</td></tr>
              ) : sortedProfiles.length === 0 ? (
                <tr>
                  <td colSpan={9} className="sa-empty-state">
                    Профилей клиентов пока нет
                  </td>
                </tr>
              ) : (
                sortedProfiles.map((profile) => (
                  <tr
                    key={profile.id}
                    className="sa-row-clickable"
                    onClick={() => openEdit(profile)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => event.key === 'Enter' && openEdit(profile)}
                  >
                    <td>
                      <div className="sa-cell-name">{profile.name}</div>
                    </td>
                    <td>{ageRangeLabel(profile)}</td>
                    <td>{voiceLabel(profile.voiceId, voices)}</td>
                    <td>{optionLabel(TEMPERAMENTS, profile.temperament)}</td>
                    <td>{optionLabel(PATIENCE, profile.patience)}</td>
                    <td>{optionLabel(REPLY_LENGTHS, profile.replyLength)}</td>
                    <td>
                      {profile.communicationStyle ? (
                        <span className="sa-meta" style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }} title={profile.communicationStyle}>
                          {profile.communicationStyle}
                        </span>
                      ) : (
                        <span className="sa-meta">—</span>
                      )}
                    </td>
                    <td className="sa-holdings-actions-cell" onClick={(event) => event.stopPropagation()}>
                      <button type="button" className="sa-btn-danger sa-btn-sm" onClick={() => removeProfile(profile)}>Удалить</button>
                    </td>
                    <td className="sa-row-chevron-cell">→</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'scripts' && (
        <div className="sa-companies-table-wrap sa-desktop-only">
          <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <thead>
              <tr>
                <th>Название</th>
                <th style={{ width: 220 }}>Профили</th>
                <th style={{ width: 180 }}>Выборка</th>
                <th style={{ width: 120 }}>Вопросы</th>
                <th style={{ width: 140 }}>Возражения</th>
                <th style={{ width: 90 }} />
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка...</td></tr>
              ) : sortedScripts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="sa-empty-state">
                    Скриптов пока нет
                  </td>
                </tr>
              ) : (
                sortedScripts.map((script) => {
                  const profileNames = script.profileIds
                    .map((id) => profiles.find((profile) => profile.id === id)?.name)
                    .filter(Boolean)
                    .join(', ');
                  return (
                    <tr
                      key={script.id}
                      className="sa-row-clickable"
                      onClick={() => openScriptEditor(script)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => event.key === 'Enter' && openScriptEditor(script)}
                    >
                      <td>
                        <div className="sa-cell-name">{script.name}</div>
                        {script.context && (
                          <div className="sa-meta" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{script.context}</div>
                        )}
                      </td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={profileNames}>{profileNames || '—'}</td>
                      <td>{script.dataCondition.tags.length ? `${script.dataCondition.tags.length} тегов` : 'Без тегов'}</td>
                      <td>{script.questions.length}</td>
                      <td>{script.objections.length}</td>
                      <td className="sa-holdings-actions-cell" onClick={(event) => event.stopPropagation()}>
                        <button type="button" className="sa-btn-danger sa-btn-sm" onClick={() => removeScript(script)}>Удалить</button>
                      </td>
                      <td className="sa-row-chevron-cell">→</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'plan' && (
        <div className="sa-companies-table-wrap sa-desktop-only">
          <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <thead>
              <tr>
                <th>План</th>
                <th style={{ width: 160 }}>Аудитория</th>
                <th style={{ width: 180 }}>Скрипт</th>
                <th style={{ width: 150 }}>Частотность</th>
                <th style={{ width: 140 }}>Время</th>
                <th style={{ width: 200 }} />
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка...</td></tr>
              ) : sortedPlans.length === 0 ? (
                <tr>
                  <td colSpan={7} className="sa-empty-state">
                    Планов прозвона пока нет
                  </td>
                </tr>
              ) : (
                sortedPlans.map((plan) => {
                  const script = scripts.find((item) => item.id === plan.scriptId);
                  const targetCount = plan.targetType === 'employees'
                    ? plan.targetIds.length
                    : planOptions.dealerships.filter((item) => plan.targetIds.includes(item.id)).reduce((sum, item) => sum + item.employeesCount, 0);
                  return (
                    <tr
                      key={plan.id}
                      className="sa-row-clickable"
                      onClick={() => openPlanHistory(plan)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => event.key === 'Enter' && openPlanHistory(plan)}
                    >
                      <td>
                        <div className="sa-cell-name">{plan.name}</div>
                        {plan.lastInitiatedAt && (
                          <div className="sa-meta" style={{ marginTop: 4 }}>Последний запуск: {new Date(plan.lastInitiatedAt).toLocaleString('ru-RU')}</div>
                        )}
                      </td>
                      <td>{plan.targetType === 'employees' ? `Сотрудники: ${targetCount}` : `Точки: ${plan.targetIds.length} · сотрудников: ${targetCount}`}</td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={script?.name || ''}>{script?.name || '—'}</td>
                      <td>{PLAN_FREQUENCIES.find((item) => item.value === plan.frequency)?.label || plan.frequency}</td>
                      <td>{plan.frequency === 'manual' ? '—' : `${plan.callTimeFrom} - ${plan.callTimeTo}`}</td>
                      <td className="sa-holdings-actions-cell" onClick={(event) => event.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
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
                          <button type="button" className="sa-btn-outline sa-btn-sm" onClick={() => initiatePlan(plan)}>Позвонить по аудитории</button>
                        </div>
                      </td>
                      <td className="sa-row-chevron-cell">→</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      <ProfileModal
        open={modalOpen}
        initialProfile={editingProfile}
        voices={voices}
        onClose={() => { setModalOpen(false); setEditingProfile(null); }}
        onSave={saveProfile}
      />
      <VoicesModal
        open={voicesModalOpen}
        voices={voices}
        savingId={voiceSavingId}
        onClose={() => setVoicesModalOpen(false)}
        onCreate={saveNewVoice}
        onUpdate={saveExistingVoice}
        onDelete={removeVoice}
      />
      <PromptPreviewModal
        preview={promptPreview}
        onClose={() => setPromptPreview(null)}
        onCopy={copyPromptPreview}
      />
    </div>
  );
}
