import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  fetchDemoCallConfiguration,
  updateDemoCallProfile,
  updateDemoCallScript,
  updateDemoCallVoice,
  type CallScriptObjection,
  type CallScriptQuestion,
  type CallScriptSuccessCriterion,
  type DemoCallConfiguration,
  type DemoCallProfileItem,
  type DemoCallScriptItem,
  type DemoCallVoiceItem,
} from '../../../shared/api/adminPanel';
import { TrashIcon } from '../../../shared/ui/icons/ActionIcons';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { useToast } from '../../../shared/ui/toast/ToastProvider';

export type DemoDictionaryTab = 'demo-voices' | 'demo-profile' | 'demo-script';

const TEMPERAMENTS = [
  { value: 'calm', label: 'Спокойный' },
  { value: 'doubtful', label: 'Сомневающийся' },
  { value: 'irritated', label: 'Раздражённый' },
  { value: 'hurried', label: 'Торопящийся' },
] as const;

const PATIENCE = [
  { value: 'low', label: 'Низкое' },
  { value: 'medium', label: 'Среднее' },
  { value: 'high', label: 'Высокое' },
] as const;

const REPLY_LENGTHS = [
  { value: 'short', label: 'Короткие' },
  { value: 'medium', label: 'Средние' },
  { value: 'detailed', label: 'Подробные' },
] as const;

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function AutoResizeTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = 'auto';
    ref.current.style.height = `${ref.current.scrollHeight}px`;
  }, [props.value]);
  return <textarea {...props} ref={ref} style={{ minHeight: 72, overflowY: 'hidden', resize: 'none', ...props.style }} />;
}

function LoadingState() {
  return <div className="dictionaries-empty">Загружаем настройки демо-стенда…</div>;
}

function ErrorState(props: { message: string; onRetry: () => void }) {
  return (
    <div className="dictionaries-notice dictionaries-notice--error demo-settings-error">
      <span>{props.message}</span>
      <button type="button" onClick={props.onRetry}>Повторить</button>
    </div>
  );
}

function DemoVoicesForm(props: {
  voices: DemoCallVoiceItem[];
  onSaved: (voice: DemoCallVoiceItem) => void;
}) {
  const { showToast } = useToast();
  const [forms, setForms] = useState<Record<string, DemoCallVoiceItem>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForms(Object.fromEntries(props.voices.map((voice) => [voice.id, { ...voice }])));
  }, [props.voices]);

  function patchVoice(id: string, patch: Partial<DemoCallVoiceItem>) {
    setForms((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  async function saveVoice(voice: DemoCallVoiceItem) {
    if (!voice.name.trim() || !voice.elevenLabsVoiceId.trim()) return;
    setSavingId(voice.id);
    setError(null);
    try {
      const saved = await updateDemoCallVoice(voice.id, {
        name: voice.name.trim(),
        description: voice.description.trim(),
        gender: voice.gender,
        elevenLabsVoiceId: voice.elevenLabsVoiceId.trim(),
        communicationModifier: voice.communicationModifier.trim(),
      });
      props.onSaved(saved);
      showToast({ type: 'success', title: 'Голос сохранён', description: saved.name });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось сохранить голос.');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="demo-settings-stack">
      <div className="demo-settings-intro">
        <div>
          <h2>Голоса демо-стенда</h2>
          <p className="sa-meta">Имена и описания показываются на лендинге и в демо-звонке. Voice ID используется только backend.</p>
        </div>
        <span className="sa-chip">3 голоса</span>
      </div>
      {error && <div className="dictionaries-notice dictionaries-notice--error"><span>{error}</span></div>}
      <div className="demo-voices-grid">
        {props.voices.map((voice) => {
          const form = forms[voice.id] || voice;
          const dirty = JSON.stringify(form) !== JSON.stringify(voice);
          return (
            <form
              key={voice.id}
              className="sa-card demo-voice-card"
              onSubmit={(event) => { event.preventDefault(); void saveVoice(form); }}
            >
              <div className="demo-voice-card__heading">
                <div>
                  <strong>{form.name || voice.id}</strong>
                  <div className="sa-meta">ID: {voice.id}</div>
                </div>
                <span className="sa-chip">{form.gender === 'female' ? 'Женский' : 'Мужской'}</span>
              </div>
              <label className="demo-field">
                <span>Имя</span>
                <input className="sa-input" maxLength={80} value={form.name} onChange={(event) => patchVoice(voice.id, { name: event.target.value })} />
              </label>
              <label className="demo-field">
                <span>Короткое описание</span>
                <input className="sa-input" maxLength={180} value={form.description} onChange={(event) => patchVoice(voice.id, { description: event.target.value })} />
              </label>
              <label className="demo-field">
                <span>Пол голоса</span>
                <select className="sa-input" value={form.gender} onChange={(event) => patchVoice(voice.id, { gender: event.target.value as 'male' | 'female' })}>
                  <option value="male">Мужской</option>
                  <option value="female">Женский</option>
                </select>
              </label>
              <label className="demo-field">
                <span>ElevenLabs Voice ID</span>
                <input className="sa-input demo-mono-input" value={form.elevenLabsVoiceId} onChange={(event) => patchVoice(voice.id, { elevenLabsVoiceId: event.target.value })} />
              </label>
              <label className="demo-field">
                <span>Модификатор поведения</span>
                <textarea className="sa-input" rows={5} maxLength={2000} value={form.communicationModifier} onChange={(event) => patchVoice(voice.id, { communicationModifier: event.target.value })} />
              </label>
              <button className="sa-btn-primary" type="submit" disabled={savingId !== null || !dirty || !form.name.trim() || !form.elevenLabsVoiceId.trim()}>
                {savingId === voice.id ? 'Сохраняем…' : 'Сохранить голос'}
              </button>
            </form>
          );
        })}
      </div>
    </div>
  );
}

function DemoProfileForm(props: {
  profile: DemoCallProfileItem;
  onSaved: (profile: DemoCallProfileItem) => void;
}) {
  const { showToast } = useToast();
  const [form, setForm] = useState(props.profile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(props.profile), [props.profile]);
  const dirty = JSON.stringify(form) !== JSON.stringify(props.profile);
  const ageFillLeft = ((Math.min(form.ageFrom, form.ageTo) - 18) / 47) * 100;
  const ageFillRight = 100 - ((Math.max(form.ageFrom, form.ageTo) - 18) / 47) * 100;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateDemoCallProfile({
        name: form.name.trim(),
        age: form.age,
        ageFrom: form.ageFrom,
        ageTo: form.ageTo,
        character: form.character.trim(),
        temperament: form.temperament,
        patience: form.patience,
        replyLength: form.replyLength,
        communicationStyle: form.communicationStyle.trim(),
      });
      props.onSaved(saved);
      showToast({ type: 'success', title: 'Профиль клиента сохранён' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось сохранить профиль.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="sa-card demo-settings-form" onSubmit={save}>
      <div className="demo-settings-intro">
        <div>
          <h2>Профиль клиента демо-стенда</h2>
          <p className="sa-meta">Единый профиль применяется ко всем трём демо-голосам. Индивидуальное поведение голоса добавляется поверх него.</p>
        </div>
        <span className="sa-chip">Постоянный профиль</span>
      </div>
      {error && <div className="dictionaries-notice dictionaries-notice--error"><span>{error}</span></div>}
      <label className="demo-field">
        <span>Название профиля</span>
        <input className="sa-input" maxLength={160} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
      </label>
      <label className="demo-field">
        <span>Возраст: {form.ageFrom === form.ageTo ? form.ageFrom : `${form.ageFrom}–${form.ageTo}`}</span>
        <div className="demo-age-range">
          <div className="demo-age-range__track" />
          <div className="demo-age-range__fill" style={{ left: `${ageFillLeft}%`, right: `${ageFillRight}%` }} />
          <input type="range" min={18} max={65} value={form.ageFrom} onChange={(event) => setForm((current) => {
            const ageFrom = Math.min(Number(event.target.value), current.ageTo);
            return { ...current, ageFrom, age: Math.round((ageFrom + current.ageTo) / 2) };
          })} className="sa-range-thumb" />
          <input type="range" min={18} max={65} value={form.ageTo} onChange={(event) => setForm((current) => {
            const ageTo = Math.max(Number(event.target.value), current.ageFrom);
            return { ...current, ageTo, age: Math.round((current.ageFrom + ageTo) / 2) };
          })} className="sa-range-thumb" />
        </div>
      </label>
      <div className="demo-form-grid">
        <label className="demo-field">
          <span>Темперамент</span>
          <select className="sa-input" value={form.temperament} onChange={(event) => setForm((current) => ({ ...current, temperament: event.target.value as DemoCallProfileItem['temperament'] }))}>
            {TEMPERAMENTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="demo-field">
          <span>Терпение клиента</span>
          <select className="sa-input" value={form.patience} onChange={(event) => setForm((current) => ({ ...current, patience: event.target.value as DemoCallProfileItem['patience'] }))}>
            {PATIENCE.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="demo-field">
          <span>Длина реплик</span>
          <select className="sa-input" value={form.replyLength} onChange={(event) => setForm((current) => ({ ...current, replyLength: event.target.value as DemoCallProfileItem['replyLength'] }))}>
            {REPLY_LENGTHS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <label className="demo-field">
        <span>Примеры живых вопросов / стиль коммуникации</span>
        <textarea className="sa-input" rows={7} maxLength={8000} value={form.communicationStyle} onChange={(event) => setForm((current) => ({ ...current, communicationStyle: event.target.value }))} />
      </label>
      <div className="demo-settings-actions">
        <button type="button" className="sa-btn-outline" disabled={!dirty || saving} onClick={() => setForm(props.profile)}>Отменить изменения</button>
        <button type="submit" className="sa-btn-primary" disabled={!dirty || saving || !form.name.trim()}>{saving ? 'Сохраняем…' : 'Сохранить профиль'}</button>
      </div>
    </form>
  );
}

type EditableScript = DemoCallScriptItem;

function syncCriteria(script: EditableScript): CallScriptSuccessCriterion[] {
  const current = new Map(script.successCriteria.map((item) => [`${item.sourceType}:${item.sourceId}`, item]));
  const questions = script.questions.map((item) => current.get(`question:${item.id}`) ?? {
    id: createId(), sourceType: 'question' as const, sourceId: item.id, expectedAnswer: '', score: 0,
  });
  const objections = script.objections.map((item) => current.get(`objection:${item.id}`) ?? {
    id: createId(), sourceType: 'objection' as const, sourceId: item.id, expectedAnswer: '', score: 0,
  });
  return [...questions, ...objections];
}

function DemoScriptForm(props: {
  script: DemoCallScriptItem;
  profile: DemoCallProfileItem;
  onSaved: (script: DemoCallScriptItem) => void;
}) {
  const { showToast } = useToast();
  const [form, setForm] = useState<EditableScript>(props.script);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newObjection, setNewObjection] = useState({ phrase: '', whenAppropriate: '' });
  const [newQuestion, setNewQuestion] = useState({ text: '', required: true });

  useEffect(() => setForm(props.script), [props.script]);
  const dirty = JSON.stringify(form) !== JSON.stringify(props.script);
  const criteria = useMemo(() => syncCriteria(form), [form.questions, form.objections, form.successCriteria]);

  function addObjection() {
    const phrase = newObjection.phrase.trim();
    if (!phrase) return;
    const objections = [...form.objections, { id: createId(), phrase, whenAppropriate: newObjection.whenAppropriate.trim() }];
    const next = { ...form, objections };
    setForm({ ...next, successCriteria: syncCriteria(next) });
    setNewObjection({ phrase: '', whenAppropriate: '' });
  }

  function addQuestion() {
    const text = newQuestion.text.trim();
    if (!text) return;
    const questions = [...form.questions, { id: createId(), text, required: newQuestion.required }];
    const next = { ...form, questions };
    setForm({ ...next, successCriteria: syncCriteria(next) });
    setNewQuestion({ text: '', required: true });
  }

  function removeSource(type: 'question' | 'objection', id: string) {
    const next = type === 'question'
      ? { ...form, questions: form.questions.filter((item) => item.id !== id) }
      : { ...form, objections: form.objections.filter((item) => item.id !== id) };
    setForm({ ...next, successCriteria: syncCriteria(next) });
  }

  function updateCriterion(id: string, patch: Partial<CallScriptSuccessCriterion>) {
    setForm((current) => ({
      ...current,
      successCriteria: syncCriteria(current).map((item) => item.id === id ? { ...item, ...patch } : item),
    }));
  }

  function sourceLabel(criterion: CallScriptSuccessCriterion): string {
    if (criterion.sourceType === 'question') {
      return `Вопрос: ${form.questions.find((item) => item.id === criterion.sourceId)?.text || '—'}`;
    }
    return `Возражение: ${form.objections.find((item) => item.id === criterion.sourceId)?.phrase || '—'}`;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim() || !form.itemTitle.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateDemoCallScript({
        name: form.name.trim(),
        itemTitle: form.itemTitle.trim(),
        context: form.context.trim(),
        dataText: form.dataText.trim(),
        objections: form.objections,
        questions: form.questions,
        successCriteria: syncCriteria(form).map((item) => ({
          ...item,
          expectedAnswer: item.expectedAnswer.trim(),
          score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))),
        })),
      });
      props.onSaved(saved);
      showToast({ type: 'success', title: 'Демо-скрипт сохранён' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось сохранить скрипт.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="demo-settings-stack" onSubmit={save}>
      {error && <div className="dictionaries-notice dictionaries-notice--error"><span>{error}</span></div>}
      <section className="sa-card demo-settings-form">
        <div className="demo-settings-intro">
          <div>
            <h2>Скрипт демо-звонка</h2>
            <p className="sa-meta">Использует тот же сборщик промпта, что и ручной и автоматический план прозвона.</p>
          </div>
        </div>
        <label className="demo-field">
          <span>Название скрипта</span>
          <input className="sa-input" maxLength={200} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <div className="demo-field">
          <span>Профиль клиента</span>
          <div className="demo-fixed-profile">
            <strong>{props.profile.name}</strong>
            <span className="sa-meta">{props.profile.ageFrom === props.profile.ageTo ? `${props.profile.ageFrom} лет` : `${props.profile.ageFrom}–${props.profile.ageTo} лет`}</span>
          </div>
        </div>
        <label className="demo-field">
          <span>Контекст (Потребность)</span>
          <textarea className="sa-input" rows={5} maxLength={20000} value={form.context} onChange={(event) => setForm((current) => ({ ...current, context: event.target.value }))} />
        </label>
      </section>

      <section className="sa-card demo-settings-form">
        <div>
          <h3>Данные для разговора</h3>
          <p className="sa-meta">Текст передаётся в промпт вместо выборки из импортированных данных компании.</p>
        </div>
        <label className="demo-field">
          <span>Основной объект разговора</span>
          <input className="sa-input" maxLength={500} value={form.itemTitle} onChange={(event) => setForm((current) => ({ ...current, itemTitle: event.target.value }))} placeholder="Например, Porsche Cayenne" />
        </label>
        <label className="demo-field">
          <span>Описание и факты</span>
          <textarea className="sa-input" rows={12} maxLength={100000} value={form.dataText} onChange={(event) => setForm((current) => ({ ...current, dataText: event.target.value }))} />
        </label>
      </section>

      <section className="sa-card demo-settings-form">
        <div className="demo-section-heading"><h3>Возражения</h3><span className="sa-chip">{form.objections.length}</span></div>
        <div className="demo-add-grid">
          <input className="sa-input" value={newObjection.phrase} onChange={(event) => setNewObjection((current) => ({ ...current, phrase: event.target.value }))} placeholder="Фраза клиента" />
          <input className="sa-input" value={newObjection.whenAppropriate} onChange={(event) => setNewObjection((current) => ({ ...current, whenAppropriate: event.target.value }))} placeholder="Когда уместна" />
          <button type="button" className="sa-btn-outline" onClick={addObjection} disabled={!newObjection.phrase.trim()}><LetsIcon name="add-light" size={16} bold />Добавить</button>
        </div>
        <div className="demo-source-list">
          {form.objections.map((item: CallScriptObjection) => (
            <div key={item.id} className="demo-source-row"><div><strong>{item.phrase}</strong><div className="sa-meta">{item.whenAppropriate || 'Любой кейс'}</div></div><button type="button" className="sa-btn-outline sa-btn-icon" onClick={() => removeSource('objection', item.id)} aria-label="Удалить возражение"><TrashIcon /></button></div>
          ))}
          {form.objections.length === 0 && <div className="sa-meta">Возражения пока не добавлены.</div>}
        </div>
      </section>

      <section className="sa-card demo-settings-form">
        <div className="demo-section-heading"><h3>Список вопросов</h3><span className="sa-chip">{form.questions.length}</span></div>
        <div className="demo-add-grid demo-add-grid--question">
          <input className="sa-input" value={newQuestion.text} onChange={(event) => setNewQuestion((current) => ({ ...current, text: event.target.value }))} placeholder="Вопрос клиента" />
          <label className="sa-filter-check"><input type="checkbox" checked={newQuestion.required} onChange={(event) => setNewQuestion((current) => ({ ...current, required: event.target.checked }))} />Обязательный</label>
          <button type="button" className="sa-btn-outline" onClick={addQuestion} disabled={!newQuestion.text.trim()}><LetsIcon name="add-light" size={16} bold />Добавить</button>
        </div>
        <div className="demo-source-list">
          {form.questions.map((item: CallScriptQuestion) => (
            <div key={item.id} className="demo-source-row"><div><strong>{item.text}</strong><div className="sa-meta">{item.required ? 'Обязательный' : 'Не обязательный'}</div></div><button type="button" className="sa-btn-outline sa-btn-icon" onClick={() => removeSource('question', item.id)} aria-label="Удалить вопрос"><TrashIcon /></button></div>
          ))}
          {form.questions.length === 0 && <div className="sa-meta">Вопросы пока не добавлены.</div>}
        </div>
      </section>

      <section className="sa-card demo-settings-form">
        <h3>Условия успеха</h3>
        {criteria.length === 0 ? <div className="sa-meta">Добавьте вопросы или возражения, чтобы настроить условия успеха.</div> : (
          <div className="sa-table-wrap">
            <table className="sa-table demo-criteria-table">
              <thead><tr><th>Вопрос/Возражение</th><th>Эталон ответа</th><th>AI-рейтинг</th></tr></thead>
              <tbody>{criteria.map((criterion) => (
                <tr key={criterion.id}>
                  <td title={sourceLabel(criterion)}>{sourceLabel(criterion)}</td>
                  <td><AutoResizeTextarea className="sa-input" value={criterion.expectedAnswer} onChange={(event) => updateCriterion(criterion.id, { expectedAnswer: event.target.value })} /></td>
                  <td><input className="sa-input" type="number" min={0} max={100} value={criterion.score} onChange={(event) => updateCriterion(criterion.id, { score: Math.max(0, Math.min(100, Number(event.target.value))) })} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <div className="demo-settings-actions">
        <button type="button" className="sa-btn-outline" disabled={!dirty || saving} onClick={() => setForm(props.script)}>Отменить изменения</button>
        <button type="submit" className="sa-btn-primary" disabled={!dirty || saving || !form.name.trim() || !form.itemTitle.trim()}>{saving ? 'Сохраняем…' : 'Сохранить скрипт'}</button>
      </div>
    </form>
  );
}

export function DemoCallSettings(props: { tab: DemoDictionaryTab }) {
  const [configuration, setConfiguration] = useState<DemoCallConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDemoCallConfiguration()
      .then((result) => { if (!cancelled) setConfiguration(result); })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Не удалось загрузить настройки демо-стенда.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  if (loading && !configuration) return <section className="dictionaries-card"><LoadingState /></section>;
  if (error && !configuration) return <section className="dictionaries-card"><ErrorState message={error} onRetry={() => setReloadToken((value) => value + 1)} /></section>;
  if (!configuration) return null;

  if (props.tab === 'demo-voices') {
    return <DemoVoicesForm voices={configuration.voices} onSaved={(voice) => setConfiguration((current) => current ? { ...current, voices: current.voices.map((item) => item.id === voice.id ? voice : item) } : current)} />;
  }
  if (props.tab === 'demo-profile') {
    return <DemoProfileForm profile={configuration.profile} onSaved={(profile) => setConfiguration((current) => current ? { ...current, profile } : current)} />;
  }
  return <DemoScriptForm script={configuration.script} profile={configuration.profile} onSaved={(script) => setConfiguration((current) => current ? { ...current, script } : current)} />;
}
