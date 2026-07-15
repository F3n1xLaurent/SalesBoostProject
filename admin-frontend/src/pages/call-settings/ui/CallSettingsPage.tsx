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
  deleteCallPlan,
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
import { EditIcon, PhoneIcon, RefreshIcon, TrashIcon } from '../../../shared/ui/icons/ActionIcons';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { BrutalSelect } from '../../../shared/ui/BrutalSelect';
import { BrutalSegmented } from '../../../shared/ui/brutal-segmented';
import { DeleteConfirmModal } from '../../../shared/ui/delete-confirm-modal';
import { ModalPortal } from '../../../shared/ui/ModalPortal';
import { SlideOver } from '../../../shared/ui/slide-over';
import { useToast } from '../../../shared/ui/toast/ToastProvider';
import { UnsavedChangesModal } from '../../../shared/ui/unsaved-changes-modal';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';

const PROFILE_FORM_ID = 'call-settings-profile-form';
const VOICE_EDIT_FORM_ID = 'call-settings-voice-edit-form';
const VOICE_CREATE_FORM_ID = 'call-settings-voice-create-form';
const SELECTED_ROW_BG = '#F5F5F5';

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

function normalizeScriptForm(form: CallScriptForm) {
  return {
    name: form.name.trim(),
    profileIds: [...form.profileIds].sort(),
    context: form.context.trim(),
    dataCondition: {
      holdingId: form.dataCondition.holdingId,
      tags: [...form.dataCondition.tags].sort(),
    },
    objections: form.objections.map((item) => ({
      id: item.id,
      phrase: item.phrase.trim(),
      whenAppropriate: item.whenAppropriate.trim(),
    })),
    questions: form.questions.map((item) => ({
      id: item.id,
      text: item.text.trim(),
      required: item.required,
    })),
    successCriteria: form.successCriteria.map((item) => ({
      id: item.id,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      expectedAnswer: item.expectedAnswer.trim(),
      score: item.score,
    })),
  };
}

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

function normalizeProfileForm(form: CustomerProfileForm) {
  const ages = normalizeAgeRange(form.ageFrom, form.ageTo);
  return {
    name: form.name.trim(),
    voiceId: form.voiceId,
    ageFrom: ages.ageFrom,
    ageTo: ages.ageTo,
    temperament: form.temperament,
    patience: form.patience,
    replyLength: form.replyLength,
    communicationStyle: form.communicationStyle.trim(),
  };
}

function profileFormFromItem(profile: CustomerProfile | null, fallbackVoiceId: string): CustomerProfileForm {
  if (!profile) {
    return { ...EMPTY_FORM, voiceId: fallbackVoiceId };
  }
  return {
    name: profile.name,
    voiceId: profile.voiceId,
    age: profile.age,
    ageFrom: profile.ageFrom ?? profile.age,
    ageTo: profile.ageTo ?? profile.age,
    character: '',
    temperament: profile.temperament,
    patience: profile.patience,
    replyLength: profile.replyLength,
    communicationStyle: profile.communicationStyle,
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
  saving?: boolean;
  onClose: () => void;
  onSave: (profile: CustomerProfileForm) => void;
  onDelete?: () => void;
}) {
  const activeVoices = useMemo(() => props.voices.filter((voice) => voice.isEnabled), [props.voices]);
  const fallbackVoiceId = activeVoices[0]?.id ?? FALLBACK_VOICE_ID;
  const [form, setForm] = useState<CustomerProfileForm>(() => profileFormFromItem(props.initialProfile, fallbackVoiceId));
  const [initialForm, setInitialForm] = useState<CustomerProfileForm>(() => profileFormFromItem(props.initialProfile, fallbackVoiceId));
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const wasOpenRef = React.useRef(false);
  const isEdit = Boolean(props.initialProfile);
  const selectedVoice = props.voices.find((voice) => voice.id === form.voiceId);
  const visibleVoices = useMemo(
    () => selectedVoice && !activeVoices.some((voice) => voice.id === selectedVoice.id)
      ? [selectedVoice, ...activeVoices]
      : activeVoices,
    [activeVoices, selectedVoice],
  );
  const voiceOptions = useMemo(
    () => visibleVoices.map((voice) => ({
      value: voice.id,
      label: `${voice.name}${voice.isEnabled ? '' : ' (выключен)'}`,
    })),
    [visibleVoices],
  );
  const isDirty = useMemo(
    () => JSON.stringify(normalizeProfileForm(form)) !== JSON.stringify(normalizeProfileForm(initialForm)),
    [form, initialForm],
  );
  const nameInvalid = attempted && !form.name.trim();

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      const next = profileFormFromItem(props.initialProfile, activeVoices[0]?.id ?? FALLBACK_VOICE_ID);
      setForm(next);
      setInitialForm(next);
      setAttempted(false);
      setUnsavedOpen(false);
      setDeleteConfirm(false);
    }
    if (!props.open) {
      setDeleteConfirm(false);
      setUnsavedOpen(false);
    }
    wasOpenRef.current = props.open;
  }, [props.open, props.initialProfile, activeVoices]);

  if (!props.open) return null;

  function requestClose() {
    if (isEdit && isDirty) {
      setUnsavedOpen(true);
      return;
    }
    props.onClose();
  }

  function persist(): boolean {
    if (!form.name.trim() || activeVoices.length === 0) {
      setAttempted(true);
      return false;
    }
    if (isEdit && !isDirty) return false;
    props.onSave({
      ...form,
      name: form.name.trim(),
      ...normalizeAgeRange(form.ageFrom, form.ageTo),
      character: '',
      communicationStyle: form.communicationStyle.trim(),
    });
    return true;
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    persist();
  }

  const ageFillLeft = ((Math.min(form.ageFrom, form.ageTo) - 18) / 47) * 100;
  const ageFillRight = 100 - ((Math.max(form.ageFrom, form.ageTo) - 18) / 47) * 100;

  return (
    <>
      <BrutalModal
        open={props.open}
        onClose={requestClose}
        title={isEdit ? 'Редактировать профиль' : 'Создать профиль'}
        subtitle="Параметры клиента для голосового обзвона."
        width="medium"
        footer={(
          <div className="sa-modal-footer-row">
            {isEdit && props.onDelete ? (
              <button
                type="button"
                className="sa-btn-danger"
                onClick={() => setDeleteConfirm(true)}
                disabled={props.saving}
              >
                Удалить
              </button>
            ) : <span />}
            <div className="sa-modal-footer-row__right">
              <button type="button" className="sa-btn-outline" onClick={requestClose} disabled={props.saving}>Отмена</button>
              <button
                type="submit"
                form={PROFILE_FORM_ID}
                className="sa-btn-primary"
                disabled={props.saving || (isEdit && !isDirty) || activeVoices.length === 0}
              >
                {props.saving ? 'Сохраняем...' : isEdit ? 'Сохранить' : 'Создать профиль'}
              </button>
            </div>
          </div>
        )}
      >
        <form id={PROFILE_FORM_ID} onSubmit={save} style={{ display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название профиля</span>
            <input
              className={`sa-input${nameInvalid ? ' sa-field-invalid' : ''}`}
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              aria-invalid={nameInvalid || undefined}
            />
          </label>

          <div style={{ display: 'grid', gap: 6 }}>
            <span>Голос</span>
            <BrutalSelect
              value={form.voiceId}
              options={voiceOptions.length > 0 ? voiceOptions : [{ value: form.voiceId || FALLBACK_VOICE_ID, label: 'Нет включенных голосов' }]}
              disabled={activeVoices.length === 0}
              aria-label="Голос"
              onChange={(value) => setForm((current) => ({ ...current, voiceId: value }))}
            />
          </div>

          <label style={{ display: 'grid', gap: 8 }}>
            <span>Возраст: {form.ageFrom === form.ageTo ? form.ageFrom : `${form.ageFrom}-${form.ageTo}`}</span>
            <div style={{ position: 'relative', height: 28, display: 'grid', alignItems: 'center' }}>
              <div style={{ position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 999, background: 'rgba(22, 22, 19, 0.12)' }} />
              <div
                style={{
                  position: 'absolute',
                  left: `${ageFillLeft}%`,
                  right: `${ageFillRight}%`,
                  height: 4,
                  borderRadius: 999,
                  background: 'var(--tb-ink, #161613)',
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
            <div style={{ display: 'grid', gap: 6 }}>
              <span>Темперамент</span>
              <BrutalSelect
                value={form.temperament}
                options={TEMPERAMENTS.map((item) => ({ value: item.value, label: item.label }))}
                aria-label="Темперамент"
                onChange={(value) => setForm((current) => ({ ...current, temperament: value as CustomerTemperament }))}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <span>Терпение клиента</span>
              <BrutalSelect
                value={form.patience}
                options={PATIENCE.map((item) => ({ value: item.value, label: item.label }))}
                aria-label="Терпение клиента"
                onChange={(value) => setForm((current) => ({ ...current, patience: value as CustomerPatience }))}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <span>Длина реплик</span>
              <BrutalSelect
                value={form.replyLength}
                options={REPLY_LENGTHS.map((item) => ({ value: item.value, label: item.label }))}
                aria-label="Длина реплик"
                onChange={(value) => setForm((current) => ({ ...current, replyLength: value as ReplyLength }))}
              />
            </div>
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Примеры живых вопросов / стиль коммуникации</span>
            <textarea className="sa-input" rows={5} value={form.communicationStyle} onChange={(event) => setForm((current) => ({ ...current, communicationStyle: event.target.value }))} />
          </label>
        </form>
      </BrutalModal>

      <UnsavedChangesModal
        open={unsavedOpen}
        saving={props.saving}
        onCancel={() => setUnsavedOpen(false)}
        onDiscard={() => {
          setUnsavedOpen(false);
          props.onClose();
        }}
        onSave={() => {
          setAttempted(true);
          if (persist()) setUnsavedOpen(false);
        }}
      />

      <DeleteConfirmModal
        open={deleteConfirm}
        title={`Удалить профиль «${form.name || props.initialProfile?.name || ''}»?`}
        saving={props.saving}
        onCancel={() => setDeleteConfirm(false)}
        onConfirm={() => {
          setDeleteConfirm(false);
          props.onDelete?.();
        }}
      />
    </>
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<CustomerVoiceForm>({
    id: '',
    name: '',
    elevenLabsCode: '',
    openaiCode: '',
    isEnabled: true,
  });
  const [newVoice, setNewVoice] = useState<CustomerVoiceForm>({
    id: '',
    name: '',
    elevenLabsCode: '',
    openaiCode: '',
    isEnabled: true,
  });
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const [initialEditForm, setInitialEditForm] = useState<CustomerVoiceForm | null>(null);

  useEffect(() => {
    if (!props.open) {
      setEditingId(null);
      setDeleteConfirm(false);
      setUnsavedOpen(false);
      setInitialEditForm(null);
      return;
    }
    setNewVoice({ id: '', name: '', elevenLabsCode: '', openaiCode: '', isEnabled: true });
  }, [props.open]);

  useEffect(() => {
    if (!editingId) {
      setInitialEditForm(null);
      return;
    }
    const voice = props.voices.find((item) => item.id === editingId);
    if (!voice) {
      setEditingId(null);
      return;
    }
    const next = {
      id: voice.id,
      name: voice.name,
      elevenLabsCode: voice.elevenLabsCode || '',
      openaiCode: voice.openaiCode || '',
      isEnabled: voice.isEnabled,
    };
    setEditForm(next);
    setInitialEditForm(next);
  }, [editingId, props.voices]);

  if (!props.open) return null;

  const editing = editingId !== null;
  const saving = props.savingId !== null;
  const voiceDirty = Boolean(
    editing
    && initialEditForm
    && JSON.stringify({
      name: editForm.name.trim(),
      elevenLabsCode: (editForm.elevenLabsCode || '').trim(),
      openaiCode: (editForm.openaiCode || '').trim(),
      isEnabled: editForm.isEnabled,
    }) !== JSON.stringify({
      name: initialEditForm.name.trim(),
      elevenLabsCode: (initialEditForm.elevenLabsCode || '').trim(),
      openaiCode: (initialEditForm.openaiCode || '').trim(),
      isEnabled: initialEditForm.isEnabled,
    }),
  );

  async function persistEdit(): Promise<boolean> {
    if (!editingId || !editForm.name.trim()) return false;
    if (!voiceDirty) return false;
    await props.onUpdate(editingId, {
      name: editForm.name.trim(),
      elevenLabsCode: editForm.elevenLabsCode?.trim() || null,
      openaiCode: editForm.openaiCode?.trim() || null,
      isEnabled: editForm.isEnabled,
    });
    setEditingId(null);
    return true;
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    await persistEdit();
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

  function openEdit(voice: CustomerVoice) {
    setEditingId(voice.id);
    const next = {
      id: voice.id,
      name: voice.name,
      elevenLabsCode: voice.elevenLabsCode || '',
      openaiCode: voice.openaiCode || '',
      isEnabled: voice.isEnabled,
    };
    setEditForm(next);
    setInitialEditForm(next);
  }

  function requestLeaveEdit() {
    if (voiceDirty) {
      setUnsavedOpen(true);
      return;
    }
    setEditingId(null);
  }

  function requestCloseModal() {
    if (editing) {
      requestLeaveEdit();
      return;
    }
    props.onClose();
  }

  return (
    <>
      <BrutalModal
        open={props.open}
        onClose={requestCloseModal}
        title={editing ? 'Редактировать голос' : 'Голоса клиентов'}
        subtitle={editing
          ? `ID: ${editForm.id}`
          : 'Доступно только суперадминам. Выключенные голоса нельзя выбрать в профиле.'}
        width="wide"
        footer={(
          <div className="sa-modal-footer-row">
            {editing ? (
              <button
                type="button"
                className="sa-btn-danger"
                disabled={saving}
                onClick={() => setDeleteConfirm(true)}
              >
                Удалить
              </button>
            ) : <span />}
            <div className="sa-modal-footer-row__right">
              {editing ? (
                <>
                  <button type="button" className="sa-btn-outline" disabled={saving} onClick={requestLeaveEdit}>Назад</button>
                  <button
                    type="submit"
                    form={VOICE_EDIT_FORM_ID}
                    className="sa-btn-primary"
                    disabled={saving || !editForm.name.trim() || !voiceDirty}
                  >
                    {props.savingId === editingId ? 'Сохраняем...' : 'Сохранить'}
                  </button>
                </>
              ) : (
                <button type="button" className="sa-btn-outline" onClick={props.onClose}>Закрыть</button>
              )}
            </div>
          </div>
        )}
      >
        {editing ? (
          <form id={VOICE_EDIT_FORM_ID} onSubmit={saveEdit} style={{ display: 'grid', gap: 14 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Название</span>
              <input className="sa-input" value={editForm.name} onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))} required />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Код ElevenLabs</span>
              <input className="sa-input" placeholder="может быть пусто" value={editForm.elevenLabsCode || ''} onChange={(event) => setEditForm((current) => ({ ...current, elevenLabsCode: event.target.value }))} />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Код OpenAI</span>
              <input className="sa-input" placeholder="может быть пусто" value={editForm.openaiCode || ''} onChange={(event) => setEditForm((current) => ({ ...current, openaiCode: event.target.value }))} />
            </label>
            <button
              type="button"
              className="sa-toggle-field"
              aria-pressed={editForm.isEnabled}
              onClick={() => setEditForm((current) => ({ ...current, isEnabled: !current.isEnabled }))}
            >
              <span className="sa-toggle-field__text">Голос включен</span>
              <span className="sa-toggle-field__control" aria-hidden="true">
                <span className="sa-toggle-field__thumb" />
              </span>
            </button>
          </form>
        ) : (
          <div style={{ display: 'grid', gap: 18 }}>
            <div className="sa-table-wrap">
              <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: 140 }}>ID</th>
                    <th>Название</th>
                    <th>ElevenLabs</th>
                    <th>OpenAI</th>
                    <th style={{ width: 120 }}>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {props.voices.map((voice) => (
                    <tr
                      key={voice.id}
                      className="sa-row-clickable"
                      onClick={() => openEdit(voice)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => event.key === 'Enter' && openEdit(voice)}
                    >
                      <td><code>{voice.id}</code></td>
                      <td>{voice.name}</td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{voice.elevenLabsCode || '—'}</td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{voice.openaiCode || '—'}</td>
                      <td>{voice.isEnabled ? 'Включен' : 'Выключен'}</td>
                    </tr>
                  ))}
                  {props.voices.length === 0 && (
                    <tr><td colSpan={5} className="sa-meta" style={{ padding: 24, textAlign: 'center' }}>Голоса пока не добавлены.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <form id={VOICE_CREATE_FORM_ID} onSubmit={createVoice} style={{ display: 'grid', gap: 12, paddingTop: 4, borderTop: '1px solid var(--sa-divider)' }}>
              <h3 className="sa-section-title" style={{ margin: 0 }}>Добавить голос</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
                <input className="sa-input" placeholder="id" value={newVoice.id} onChange={(event) => setNewVoice((current) => ({ ...current, id: event.target.value }))} />
                <input className="sa-input" placeholder="Название голоса" value={newVoice.name} onChange={(event) => setNewVoice((current) => ({ ...current, name: event.target.value }))} />
                <input className="sa-input" placeholder="код ElevenLabs" value={newVoice.elevenLabsCode || ''} onChange={(event) => setNewVoice((current) => ({ ...current, elevenLabsCode: event.target.value }))} />
                <input className="sa-input" placeholder="код OpenAI" value={newVoice.openaiCode || ''} onChange={(event) => setNewVoice((current) => ({ ...current, openaiCode: event.target.value }))} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="sa-toggle-field"
                  aria-pressed={newVoice.isEnabled}
                  onClick={() => setNewVoice((current) => ({ ...current, isEnabled: !current.isEnabled }))}
                  style={{ width: 'fit-content' }}
                >
                  <span className="sa-toggle-field__text">Включен</span>
                  <span className="sa-toggle-field__control" aria-hidden="true">
                    <span className="sa-toggle-field__thumb" />
                  </span>
                </button>
                <button type="submit" className="sa-btn-primary" disabled={props.savingId === 'new' || !newVoice.id.trim() || !newVoice.name.trim()}>
                  {props.savingId === 'new' ? 'Добавляем...' : 'Добавить голос'}
                </button>
              </div>
            </form>
          </div>
        )}
      </BrutalModal>

      <UnsavedChangesModal
        open={unsavedOpen}
        saving={saving}
        onCancel={() => setUnsavedOpen(false)}
        onDiscard={() => {
          setUnsavedOpen(false);
          setEditingId(null);
        }}
        onSave={async () => {
          if (await persistEdit()) setUnsavedOpen(false);
        }}
      />

      <DeleteConfirmModal
        open={deleteConfirm}
        title={`Удалить голос «${editForm.name}»?`}
        saving={saving}
        onCancel={() => setDeleteConfirm(false)}
        onConfirm={async () => {
          const voice = props.voices.find((item) => item.id === editingId);
          if (!voice) {
            setDeleteConfirm(false);
            return;
          }
          setDeleteConfirm(false);
          await props.onDelete(voice);
          setEditingId(null);
        }}
      />
    </>
  );
}

function ScriptEditor(props: {
  holdingId: string;
  initialScript?: CallScript | null;
  profiles: CustomerProfile[];
  onBack: () => void;
  onSave: (script: Omit<CallScript, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onDelete?: () => void;
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
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [initialSnapshot, setInitialSnapshot] = useState('');
  const isEdit = Boolean(props.initialScript);

  useEffect(() => {
    const source = props.initialScript;
    const nextForm = source
      ? {
        name: source.name,
        profileIds: [...source.profileIds],
        context: source.context,
        dataCondition: { holdingId: props.holdingId, tags: [...source.dataCondition.tags] },
        objections: source.objections.map((item) => ({ ...item })),
        questions: source.questions.map((item) => ({ ...item })),
        successCriteria: source.successCriteria.map((item) => ({ ...item })),
      }
      : {
        ...EMPTY_SCRIPT_FORM,
        profileIds: [],
        dataCondition: { holdingId: props.holdingId, tags: [] },
        objections: [],
        questions: [],
        successCriteria: [],
      };
    setForm(nextForm);
    setScoreDrafts(Object.fromEntries((nextForm.successCriteria || []).map((item) => [item.id, String(item.score)])));
    setInitialSnapshot(JSON.stringify(normalizeScriptForm(nextForm)));
    setAttempted(false);
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
    setAttempted(true);
    if (!form.name.trim()) return;
    if (isEdit && !isDirty) return;
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

  const isDirty = JSON.stringify(normalizeScriptForm({
    ...form,
    successCriteria: form.successCriteria.map((item) => ({
      ...item,
      score: clampScore(Number(scoreDrafts[item.id] || item.score || 0)),
    })),
  })) !== initialSnapshot;
  const nameInvalid = attempted && !form.name.trim();

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="sa-breadcrumb">
        <button type="button" className="sa-btn-text" onClick={props.onBack}>Скрипты</button>
        <span className="sa-breadcrumb-sep">→</span>
        <span>{isEdit ? (form.name.trim() || props.initialScript?.name || 'Скрипт') : 'Новый скрипт'}</span>
      </div>

      <h1 className="sa-page-title">{isEdit ? 'Скрипт' : 'Создание скрипта'}</h1>

      <form onSubmit={save} style={{ display: 'grid', gap: 16 }}>
        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Название скрипта</span>
            <input
              className={`sa-input${nameInvalid ? ' sa-field-invalid' : ''}`}
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
              aria-invalid={nameInvalid || undefined}
            />
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
                          className="sa-filter-check"
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '20px minmax(0, 1fr)',
                            gap: 10,
                            alignItems: 'center',
                            padding: '10px 12px',
                            borderTop: '1px solid var(--sa-divider)',
                            borderRadius: 0,
                            borderLeft: 0,
                            borderRight: 0,
                            borderBottom: 0,
                            background: checked ? SELECTED_ROW_BG : '#fff',
                            cursor: 'pointer',
                            minHeight: 0,
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
            <button type="button" className="sa-btn-outline" onClick={() => setObjectionModalOpen(true)}>
              <LetsIcon name="add-light" size={16} bold />
              Добавить возражение
            </button>
          </div>
          {form.objections.length === 0 ? <div className="sa-meta">Возражения пока не добавлены.</div> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {form.objections.map((item) => (
                <div key={item.id} style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: 12, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                  <div>
                    <strong>{item.phrase}</strong>
                    <div className="sa-meta" style={{ marginTop: 4 }}>{item.whenAppropriate || 'Любой кейс'}</div>
                  </div>
                  <button
                    type="button"
                    className="sa-btn-outline sa-btn-icon"
                    onClick={() => removeObjection(item.id)}
                    aria-label="Удалить возражение"
                    title="Удалить"
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 18 }}>Список вопросов</h3>
            <button type="button" className="sa-btn-outline" onClick={() => setQuestionModalOpen(true)}>
              <LetsIcon name="add-light" size={16} bold />
              Добавить вопрос
            </button>
          </div>
          {form.questions.length === 0 ? <div className="sa-meta">Вопросы пока не добавлены.</div> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {form.questions.map((item) => (
                <div key={item.id} style={{ border: '1px solid var(--sa-divider)', borderRadius: 12, padding: 12, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                  <div>
                    <strong>{item.text}</strong>
                    <div className="sa-meta" style={{ marginTop: 4 }}>{item.required ? 'Обязательный' : 'Не обязательный'}</div>
                  </div>
                  <button
                    type="button"
                    className="sa-btn-outline sa-btn-icon"
                    onClick={() => removeQuestion(item.id)}
                    aria-label="Удалить вопрос"
                    title="Удалить"
                  >
                    <TrashIcon />
                  </button>
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

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          {isEdit && props.onDelete ? (
            <button type="button" className="sa-btn-danger" onClick={() => setDeleteConfirm(true)}>Удалить</button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="sa-btn-outline" onClick={props.onBack}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={isEdit && !isDirty}>
              {isEdit ? 'Сохранить изменения' : 'Сохранить скрипт'}
            </button>
          </div>
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
      <DeleteConfirmModal
        open={deleteConfirm}
        title={`Удалить скрипт «${form.name || props.initialScript?.name || ''}»?`}
        nested={false}
        onCancel={() => setDeleteConfirm(false)}
        onConfirm={() => {
          setDeleteConfirm(false);
          props.onDelete?.();
        }}
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
  invalid?: boolean;
  renderItem: (item: T, selected: boolean) => React.ReactNode;
  onToggle: (id: string) => void;
}) {
  return (
    <div
      className={props.invalid ? 'sa-field-invalid' : undefined}
      style={{ border: `1px solid ${props.invalid ? 'var(--sa-danger, #b91c1c)' : 'var(--sa-divider)'}`, borderRadius: 14, overflow: 'hidden', background: '#fff' }}
    >
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
              className="sa-filter-check"
              style={{
                display: 'grid',
                gridTemplateColumns: '20px minmax(0, 1fr)',
                gap: 10,
                alignItems: 'center',
                padding: '11px 12px',
                borderTop: '1px solid var(--sa-divider)',
                borderRadius: 0,
                borderLeft: 0,
                borderRight: 0,
                borderBottom: 0,
                background: selected ? SELECTED_ROW_BG : '#fff',
                cursor: 'pointer',
                minHeight: 0,
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
  onDelete?: () => void;
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
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [initialSnapshot, setInitialSnapshot] = useState('');
  const isEdit = Boolean(props.initialPlan);

  useEffect(() => {
    const next = {
      name: props.initialPlan?.name || '',
      targetType: props.initialPlan?.targetType || 'employees' as CallPlanTargetType,
      targetIds: props.initialPlan?.targetIds || [],
      scriptId: props.initialPlan?.scriptId || '',
      phoneNumberTypeId: props.initialPlan?.phoneNumberTypeId || '',
      frequency: props.initialPlan?.frequency || 'daily' as CallPlanFrequency,
      callTimeFrom: props.initialPlan?.callTimeFrom || '09:00',
      callTimeTo: props.initialPlan?.callTimeTo || '09:15',
    };
    setName(next.name);
    setTargetType(next.targetType);
    setTargetIds(next.targetIds);
    setScriptId(next.scriptId);
    setPhoneNumberTypeId(next.phoneNumberTypeId);
    setFrequency(next.frequency);
    setCallTimeFrom(next.callTimeFrom);
    setCallTimeTo(next.callTimeTo);
    setInitialSnapshot(JSON.stringify(next));
    setAttempted(false);
  }, [props.initialPlan]);

  useEffect(() => {
    if (props.initialPlan) return;
    setScriptId((current) => current || props.options.scripts[0]?.id || '');
    setPhoneNumberTypeId((current) => current || props.options.phoneNumberTypes[0]?.id || '');
  }, [props.initialPlan, props.options.scripts, props.options.phoneNumberTypes]);

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
    setAttempted(true);
    if (!scriptId || !phoneNumberTypeId || targetIds.length === 0) return;
    const payload = {
      holdingId: props.holdingId,
      name: name.trim() || (targetType === 'employees' ? 'Обзвон сотрудников' : 'Обзвон точек'),
      targetType,
      targetIds,
      scriptId,
      phoneNumberTypeId,
      frequency,
      callTimeFrom,
      callTimeTo,
    };
    if (isEdit && JSON.stringify({
      name,
      targetType,
      targetIds,
      scriptId,
      phoneNumberTypeId,
      frequency,
      callTimeFrom,
      callTimeTo,
    }) === initialSnapshot) return;
    props.onSave(payload);
  }

  const currentSnapshot = JSON.stringify({
    name,
    targetType,
    targetIds,
    scriptId,
    phoneNumberTypeId,
    frequency,
    callTimeFrom,
    callTimeTo,
  });
  const isDirty = currentSnapshot !== initialSnapshot;
  const targetsInvalid = attempted && targetIds.length === 0;
  const scriptInvalid = attempted && !scriptId;
  const phoneTypeInvalid = attempted && !phoneNumberTypeId;

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="sa-breadcrumb">
        <button type="button" className="sa-btn-text" onClick={props.onBack}>План прозвона</button>
        <span className="sa-breadcrumb-sep">→</span>
        <span>{props.initialPlan ? (name.trim() || props.initialPlan.name) : 'Новый обзвон'}</span>
      </div>

      <h1 className="sa-page-title">{props.initialPlan ? 'Редактирование прозвона' : 'Создание прозвона'}</h1>

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
          <div style={{ display: 'grid', gap: 8 }}>
            <span>Аудитория</span>
            <BrutalSegmented
              value={targetType}
              options={[
                { value: 'employees', label: 'Сотрудники' },
                { value: 'dealerships', label: 'Точки' },
              ]}
              onChange={switchTargetType}
              ariaLabel="Тип аудитории"
            />
            <div className="sa-meta">
              {targetType === 'employees'
                ? 'Обзвон конкретных сотрудников'
                : 'Обзвон всех сотрудников точки/точек'}
            </div>
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
              invalid={targetsInvalid}
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
              invalid={targetsInvalid}
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
          {targetsInvalid && (
            <div className="sa-meta" style={{ color: '#b91c1c' }}>Выберите хотя бы одного участника аудитории.</div>
          )}
        </section>

        <section className="sa-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <span>Скрипт</span>
              <BrutalSelect
                value={scriptId}
                options={[
                  { value: '', label: 'Выберите скрипт' },
                  ...props.options.scripts.map((script) => ({ value: script.id, label: script.name })),
                ]}
                aria-label="Скрипт"
                invalid={scriptInvalid}
                onChange={setScriptId}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <span>Тип номера</span>
              <BrutalSelect
                value={phoneNumberTypeId}
                options={[
                  { value: '', label: 'Выберите тип номера' },
                  ...props.options.phoneNumberTypes.map((type) => ({ value: type.id, label: type.name })),
                ]}
                aria-label="Тип номера"
                invalid={phoneTypeInvalid}
                onChange={setPhoneNumberTypeId}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <span>Частотность</span>
              <BrutalSelect
                value={frequency}
                options={PLAN_FREQUENCIES.map((item) => ({ value: item.value, label: item.label }))}
                aria-label="Частотность"
                onChange={(value) => setFrequency(value as CallPlanFrequency)}
              />
            </div>
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

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          {props.initialPlan && props.onDelete ? (
            <button type="button" className="sa-btn-danger" onClick={() => setDeleteConfirm(true)}>Удалить</button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="sa-btn-outline" onClick={props.onBack}>Отмена</button>
            <button type="submit" className="sa-btn-primary" disabled={isEdit && !isDirty}>
              {props.initialPlan ? 'Сохранить изменения' : 'Создать обзвон'}
            </button>
          </div>
        </div>
      </form>
      <DeleteConfirmModal
        open={deleteConfirm}
        title={`Удалить план «${name || props.initialPlan?.name || ''}»?`}
        nested={false}
        onCancel={() => setDeleteConfirm(false)}
        onConfirm={() => {
          setDeleteConfirm(false);
          props.onDelete?.();
        }}
      />
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
  const [modalOpen, setModalOpen] = useState(false);
  const [voicesModalOpen, setVoicesModalOpen] = useState(false);
  const [voiceSavingId, setVoiceSavingId] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
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
  const [planDeleteConfirm, setPlanDeleteConfirm] = useState(false);
  const { showToast } = useToast();
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
    setProfileSaving(true);
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
      showToast({
        type: 'success',
        title: editingProfile ? 'Профиль сохранён' : 'Профиль создан',
        description: saved.name,
      });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Не удалось сохранить профиль клиента.';
      showToast({ type: 'error', title: 'Не удалось сохранить профиль', description: message });
    } finally {
      setProfileSaving(false);
    }
  }

  async function saveNewVoice(voice: CustomerVoiceForm) {
    setVoiceSavingId('new');
    try {
      const created = await createCallCustomerVoice(voice);
      setVoices((current) => [...current.filter((item) => item.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name, 'ru')));
      showToast({ type: 'success', title: 'Голос добавлен', description: created.name });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Не удалось добавить голос.';
      showToast({ type: 'error', title: 'Не удалось добавить голос', description: message });
      throw saveError;
    } finally {
      setVoiceSavingId(null);
    }
  }

  async function saveExistingVoice(id: string, voice: Omit<CustomerVoiceForm, 'id'>) {
    setVoiceSavingId(id);
    try {
      const updated = await updateCallCustomerVoice(id, voice);
      setVoices((current) => current.map((item) => item.id === id ? updated : item).sort((a, b) => a.name.localeCompare(b.name, 'ru')));
      showToast({ type: 'success', title: 'Голос сохранён', description: updated.name });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Не удалось обновить голос.';
      showToast({ type: 'error', title: 'Не удалось сохранить голос', description: message });
      throw saveError;
    } finally {
      setVoiceSavingId(null);
    }
  }

  async function removeVoice(voice: CustomerVoice) {
    setVoiceSavingId(voice.id);
    try {
      await deleteCallCustomerVoice(voice.id);
      setVoices((current) => current.filter((item) => item.id !== voice.id));
      showToast({ type: 'success', title: 'Голос удалён', description: voice.name });
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Не удалось удалить голос.';
      showToast({ type: 'error', title: 'Не удалось удалить голос', description: message });
    } finally {
      setVoiceSavingId(null);
    }
  }

  async function removeProfile(profile: CustomerProfile) {
    setProfileSaving(true);
    try {
      await deleteCallCustomerProfile(profile.id);
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setScripts((current) => current.map((script) => ({ ...script, profileIds: script.profileIds.filter((id) => id !== profile.id) })));
      setModalOpen(false);
      setEditingProfile(null);
      showToast({ type: 'success', title: 'Профиль удалён', description: profile.name });
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Не удалось удалить профиль клиента.';
      showToast({ type: 'error', title: 'Не удалось удалить профиль', description: message });
    } finally {
      setProfileSaving(false);
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
      showToast({
        type: 'success',
        title: editingScript ? 'Скрипт сохранён' : 'Скрипт создан',
        description: saved.name,
      });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Не удалось сохранить скрипт.';
      showToast({ type: 'error', title: 'Не удалось сохранить скрипт', description: message });
    }
  }

  function openScriptEditor(script?: CallScript) {
    navigate(script ? `/call-settings/scripts/${encodeURIComponent(script.id)}` : '/call-settings/scripts/new');
  }

  async function removeScript(script: CallScript) {
    try {
      await deleteCallScript(script.id);
      setScripts((current) => current.filter((item) => item.id !== script.id));
      if (route.tab === 'scripts' && route.scriptId === script.id) navigate(CALL_SETTINGS_PATHS.scripts, { replace: true });
      showToast({ type: 'success', title: 'Скрипт удалён', description: script.name });
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Не удалось удалить скрипт.';
      showToast({ type: 'error', title: 'Не удалось удалить скрипт', description: message });
    }
  }

  async function removePlan(plan: CallPlan) {
    try {
      await deleteCallPlan(plan.id);
      setPlans((current) => current.filter((item) => item.id !== plan.id));
      setSelectedPlan(null);
      setPlanCalls([]);
      setPlanEditorOpen(false);
      navigate(CALL_SETTINGS_PATHS.plan, { replace: true });
      showToast({ type: 'success', title: 'План прозвона удалён', description: plan.name });
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Не удалось удалить план прозвона.';
      showToast({ type: 'error', title: 'Не удалось удалить план', description: message });
    }
  }

  async function savePlan(plan: CallPlanForm) {
    try {
      const isEdit = route.tab === 'plan' && route.edit && route.planId;
      const saved = isEdit
        ? await updateCallPlan(route.planId!, plan)
        : await createCallPlan(plan);
      setPlans((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current];
      });
      setPlanEditorOpen(false);
      navigate(`/call-settings/plans/${encodeURIComponent(saved.id)}`, { replace: true });
      showToast({
        type: 'success',
        title: isEdit ? 'План сохранён' : 'План создан',
        description: saved.name,
      });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Не удалось сохранить план прозвона.';
      showToast({ type: 'error', title: 'Не удалось сохранить план', description: message });
    }
  }

  async function initiatePlan(plan: CallPlan) {
    try {
      const result = await initiateCallPlan(plan.id);
      setPlans((current) => current.map((item) => item.id === result.item.id ? result.item : item));
      showToast({ type: 'success', title: 'Прозвон инициирован', description: `${result.totalJobs} звонков` });
      if (selectedPlan?.id === plan.id || route.planId === plan.id) await openPlanHistory(result.item, { skipNavigate: true });
    } catch (initError) {
      const message = initError instanceof Error ? initError.message : 'Не удалось инициировать прозвон.';
      showToast({ type: 'error', title: 'Не удалось инициировать прозвон', description: message });
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
      showToast({ type: 'success', title: 'Промпт скопирован' });
    } catch {
      showToast({ type: 'error', title: 'Не удалось скопировать промпт' });
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
        onDelete={editingScript ? () => removeScript(editingScript) : undefined}
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
        onBack={() => navigate(CALL_SETTINGS_PATHS.plan)}
        onSave={savePlan}
        onDelete={initialPlan ? () => removePlan(initialPlan) : undefined}
      />
    );
  }

  if (selectedPlan) {
    const selectedScript = scripts.find((script) => script.id === selectedPlan.scriptId);
    const selectedPhoneType = planOptions.phoneNumberTypes.find((type) => type.id === selectedPlan.phoneNumberTypeId);
    const selectedEmployees = selectedPlan.targetType === 'employees'
      ? planOptions.employees.filter((employee) => selectedPlan.targetIds.includes(employee.id))
      : planOptions.employees.filter((employee) => selectedPlan.targetIds.includes(employee.dealershipId));
    const audienceCount = selectedPlan.targetType === 'employees'
      ? selectedPlan.targetIds.length
      : planOptions.dealerships.filter((item) => selectedPlan.targetIds.includes(item.id)).reduce((sum, item) => sum + item.employeesCount, 0);
    const scheduleLabel = PLAN_FREQUENCIES.find((item) => item.value === selectedPlan.frequency)?.label || selectedPlan.frequency;
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <div className="sa-breadcrumb">
          <button type="button" className="sa-btn-text" onClick={() => navigate(CALL_SETTINGS_PATHS.plan)}>План прозвона</button>
          <span className="sa-breadcrumb-sep">→</span>
          <span>{selectedPlan.name}</span>
        </div>

        <section className="sa-card" style={{ padding: 20, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h1 className="sa-page-title" style={{ marginBottom: 6 }}>{selectedPlan.name}</h1>
            <div className="sa-meta">Состав плана, история прозвонов и аналитика.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="sa-btn-outline" onClick={() => openPlanHistory(selectedPlan)}>
              <RefreshIcon />
              Обновить
            </button>
            <button type="button" className="sa-btn-outline" onClick={() => navigate(`/call-settings/plans/${encodeURIComponent(selectedPlan.id)}/edit`)}>
              <EditIcon />
              Редактировать
            </button>
            <button type="button" className="sa-btn-outline" onClick={() => initiatePlan(selectedPlan)}>
              <PhoneIcon />
              Позвонить по аудитории
            </button>
            <button type="button" className="sa-btn-danger" onClick={() => setPlanDeleteConfirm(true)}>Удалить</button>
          </div>
        </section>

        <div className="sa-kpi-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <div className="sa-card sa-brutal-card" style={{ padding: '14px 16px', minHeight: 0 }}>
            <div className="sa-meta">Аудитория</div>
            <div style={{ marginTop: 8, fontSize: 15, fontWeight: 650, lineHeight: 1.3 }}>
              {selectedPlan.targetType === 'employees' ? 'Сотрудники' : 'Точки'}
            </div>
            <div className="sa-meta" style={{ marginTop: 4 }}>{audienceCount} выбрано</div>
          </div>
          <div className="sa-card sa-brutal-card" style={{ padding: '14px 16px', minHeight: 0 }}>
            <div className="sa-meta">Скрипт</div>
            <div style={{ marginTop: 8, fontSize: 15, fontWeight: 650, lineHeight: 1.3 }}>
              {selectedScript?.name || 'Не найден'}
            </div>
          </div>
          <div className="sa-card sa-brutal-card" style={{ padding: '14px 16px', minHeight: 0 }}>
            <div className="sa-meta">Тип номера</div>
            <div style={{ marginTop: 8, fontSize: 15, fontWeight: 650, lineHeight: 1.3 }}>
              {selectedPhoneType?.name || 'Не найден'}
            </div>
          </div>
          <div className="sa-card sa-brutal-card" style={{ padding: '14px 16px', minHeight: 0 }}>
            <div className="sa-meta">Расписание</div>
            <div style={{ marginTop: 8, fontSize: 15, fontWeight: 650, lineHeight: 1.3 }}>{scheduleLabel}</div>
            {selectedPlan.frequency !== 'manual' && (
              <div className="sa-meta" style={{ marginTop: 4 }}>{selectedPlan.callTimeFrom} - {selectedPlan.callTimeTo}</div>
            )}
          </div>
        </div>

        <section style={{ display: 'grid', gap: 12 }}>
          <h2 className="sa-section-title" style={{ margin: 0 }}>Выбранные сотрудники</h2>
          <div className="sa-companies-table-wrap sa-desktop-only">
            <table className="sa-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th style={{ width: 220 }}>Точка</th>
                  <th style={{ width: 220 }}>Email</th>
                  <th style={{ width: 160 }}>Телефон</th>
                </tr>
              </thead>
              <tbody>
                {selectedEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="sa-empty-state">
                      Сотрудники не найдены в текущей компании.
                    </td>
                  </tr>
                ) : (
                  selectedEmployees.map((employee) => (
                    <tr key={employee.id}>
                      <td>
                        <div className="sa-cell-name">{employee.fullName}</div>
                      </td>
                      <td>{employee.dealershipName}</td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{employee.email || '—'}</td>
                      <td>{employee.phone || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section style={{ display: 'grid', gap: 12 }}>
          <h2 className="sa-section-title" style={{ margin: 0 }}>История прозвонов</h2>
          {planCallsLoading ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Загрузка...</div>
          ) : planCalls.length === 0 ? (
            <div className="sa-meta" style={{ padding: 28, textAlign: 'center' }}>Звонков по этому плану пока нет.</div>
          ) : (
            <div className="sa-companies-table-wrap sa-desktop-only">
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
                    const canOpenAnalytics = Boolean(call.auditId);
                    return (
                      <tr
                        key={call.id}
                        className={canOpenAnalytics ? 'sa-row-clickable' : undefined}
                        onClick={() => {
                          if (!canOpenAnalytics) {
                            showToast({
                              type: 'info',
                              title: 'Аналитика ещё не готова',
                              description: 'Появится после создания проверки по звонку.',
                            });
                            return;
                          }
                          void openCallAnalyticsDrawer(call);
                        }}
                        role={canOpenAnalytics ? 'button' : undefined}
                        tabIndex={canOpenAnalytics ? 0 : undefined}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && canOpenAnalytics) void openCallAnalyticsDrawer(call);
                        }}
                      >
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
                        <td>{new Date(call.startedAt).toLocaleString('ru-RU')}</td>
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
        <DeleteConfirmModal
          open={planDeleteConfirm}
          title={`Удалить план «${selectedPlan.name}»?`}
          nested={false}
          onCancel={() => setPlanDeleteConfirm(false)}
          onConfirm={() => {
            setPlanDeleteConfirm(false);
            void removePlan(selectedPlan);
          }}
        />
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
              Создать профиль
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
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка...</td></tr>
              ) : sortedProfiles.length === 0 ? (
                <tr>
                  <td colSpan={7} className="sa-empty-state">
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
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка...</td></tr>
              ) : sortedScripts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="sa-empty-state">
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
                <th className="sa-text-right sa-holdings-actions-col" style={{ width: 88 }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="sa-meta" style={{ padding: 32, textAlign: 'center' }}>Загрузка...</td></tr>
              ) : sortedPlans.length === 0 ? (
                <tr>
                  <td colSpan={6} className="sa-empty-state">
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
                      <td className="sa-holdings-actions-cell sa-text-right" onClick={(event) => event.stopPropagation()}>
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
                      </td>
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
        saving={profileSaving}
        onClose={() => { setModalOpen(false); setEditingProfile(null); }}
        onSave={saveProfile}
        onDelete={editingProfile ? () => void removeProfile(editingProfile) : undefined}
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
