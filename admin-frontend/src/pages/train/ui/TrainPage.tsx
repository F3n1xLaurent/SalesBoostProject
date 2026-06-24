import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  fetchTrainerDialog,
  fetchTrainerHistory,
  fetchTrainerProfile,
  fetchTrainerReport,
  fetchTrainerScenarios,
  fetchTrainerTodayPlan,
  sendTrainerVoiceMessage,
  startTrainerSession,
  type TrainerInitialMessage,
  type TrainerPlanItem,
  type TrainerProfile,
  type TrainerReport,
  type TrainerScenario,
  type TrainerSessionSummary,
} from '../../../shared/api/trainer';
import { ratingClass } from '../../../shared/lib/admin-panel/utils';
import '../../../shared/ui/styles/admin-panel.css';
import './train-page.css';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type ChatMessage = {
  id: number;
  role: 'client' | 'manager';
  audioUrl: string | null;
  durationSec?: number | null;
  textFallback?: string;
  autoPlay?: boolean;
};

const difficultyLabels: Record<string, string> = {
  easy: 'Лёгкая',
  medium: 'Средняя',
  hard: 'Сложная',
};

const clientTypeLabels: Record<string, string> = {
  random: 'Случайный клиент',
  careful: 'Внимательный клиент',
  price_sensitive: 'Клиент, чувствительный к цене',
};

function clientProfileTitle(caseContext: Record<string, unknown> | null): string {
  const profile = caseContext?.clientProfile && typeof caseContext.clientProfile === 'object'
    ? caseContext.clientProfile as Record<string, unknown>
    : {};
  const rawName = String(profile.name || '').trim();
  if (rawName && rawName !== 'AI-клиент') return rawName;
  const type = String(profile.type || caseContext?.clientType || 'random');
  return clientTypeLabels[type] || 'Клиент';
}

function scoreLabel(score: number | null): string {
  if (score == null) return '—';
  if (score >= 76) return 'Хорошо';
  if (score >= 50) return 'Средне';
  return 'Плохо';
}

function sessionStatusLabel(status: string, score: number | null): string {
  if (status === 'completed') return score == null ? 'Пройдена' : `${score}/100`;
  if (status === 'failed') return 'Провалена';
  if (status === 'in_progress') return 'В процессе';
  return 'Не начата';
}

function checklistStatusLabel(value: unknown): string {
  const status = String(value || '').toUpperCase();
  if (status === 'YES') return 'Да';
  if (status === 'PARTIAL') return 'Частично';
  if (status === 'NO') return 'Нет';
  return status || '—';
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function MetricTile(props: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="train-metric">
      <div className="train-metric-label">{props.label}</div>
      <div className="train-metric-value">{props.value}</div>
      {props.hint && <div className="train-metric-hint">{props.hint}</div>}
    </div>
  );
}

function PlanCard(props: {
  item: TrainerPlanItem;
  index: number;
  busy: boolean;
  onStart: (item: TrainerPlanItem) => void;
}) {
  const status = sessionStatusLabel(props.item.status, null);
  const canStart = props.item.status === 'not_started' || !props.item.status;
  return (
    <article className={`train-plan-card train-plan-card-${canStart ? 'active' : 'done'}`}>
      <div className="train-plan-index">{props.index + 1}</div>
      <div className="train-plan-body">
        <div className="train-plan-title">{props.item.scenarioName || 'Сценарий'}</div>
        <div className="train-plan-status">{status}</div>
      </div>
      <button className="train-icon-button" disabled={!canStart || props.busy} onClick={() => props.onStart(props.item)} title="Начать">
        ▶
      </button>
    </article>
  );
}

function HistoryItem(props: { item: TrainerSessionSummary; onOpen: (id: string) => void }) {
  const score = props.item.score;
  return (
    <button className="train-history-item" onClick={() => props.onOpen(props.item.id)}>
      <span>
        <strong>{props.item.scenarioName}</strong>
        <small>
          {formatDateTime(props.item.completedAt || props.item.startedAt)} · {props.item.type === 'plan' ? 'План' : 'Свободная'}
          {props.item.finalPoints != null ? ` · ${props.item.finalPoints} очков` : ''}
        </small>
      </span>
      <span className={`train-score-pill train-score-${score == null ? 'empty' : score >= 76 ? 'good' : score >= 50 ? 'mid' : 'bad'}`}>
        {score == null ? '—' : score}
      </span>
    </button>
  );
}

function ChatListButton(props: {
  title: string;
  subtitle: string;
  badge?: string | number | null;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`train-chat-list-item ${props.active ? 'train-chat-list-item-active' : ''}`} disabled={props.disabled} onClick={props.onClick}>
      <span className="train-chat-avatar">AI</span>
      <span className="train-chat-list-copy">
        <strong>{props.title}</strong>
        <small>{props.subtitle}</small>
      </span>
      {props.badge != null && <span className="train-chat-badge">{props.badge}</span>}
    </button>
  );
}

function ProfileModal(props: { profile: TrainerProfile | null; onClose: () => void }) {
  return (
    <div className="train-report-backdrop" onClick={props.onClose}>
      <section className="train-profile-modal" onClick={(event) => event.stopPropagation()}>
        <header className="train-report-header">
          <div>
            <div className="train-report-kicker">Профиль менеджера</div>
            <h2>{props.profile?.fullName ?? 'Профиль'}</h2>
          </div>
          <button className="train-close-button" onClick={props.onClose}>×</button>
        </header>
        <div className="train-profile-modal-meta">
          <span>{props.profile?.companyName}</span>
          <span>{props.profile?.branchName}{props.profile?.city ? ` · ${props.profile.city}` : ''}</span>
        </div>
        <div className="train-profile-metrics">
          <MetricTile label="Стрик" value={`${props.profile?.currentStreak ?? 0} дн.`} hint={`Рекорд ${props.profile?.longestStreak ?? 0}`} />
          <MetricTile label="Очки" value={props.profile?.totalPoints ?? 0} hint="За всё время" />
          <MetricTile label="Сессии 30 дней" value={props.profile?.sessions30d ?? 0} hint={`${props.profile?.sessionsTotal ?? 0} всего`} />
        </div>
      </section>
    </div>
  );
}

function NewSessionModal(props: {
  scenarios: TrainerScenario[];
  scenarioId: string;
  difficulty: 'easy' | 'medium' | 'hard';
  clientType: string;
  busy: boolean;
  onScenarioChange: (value: string) => void;
  onDifficultyChange: (value: 'easy' | 'medium' | 'hard') => void;
  onClientTypeChange: (value: string) => void;
  onStart: () => void;
  onClose: () => void;
}) {
  return (
    <div className="train-report-backdrop" onClick={props.onClose}>
      <section className="train-new-modal" onClick={(event) => event.stopPropagation()}>
        <header className="train-report-header">
          <div>
            <div className="train-report-kicker">Новый чат</div>
            <h2>Свободная тренировка</h2>
          </div>
          <button className="train-close-button" onClick={props.onClose}>×</button>
        </header>
        <div className="train-controls train-controls-modal">
          <label>
            <span>Сценарий</span>
            <select value={props.scenarioId} onChange={(event) => props.onScenarioChange(event.target.value)}>
              {props.scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
            </select>
          </label>
          <label>
            <span>Сложность</span>
            <select value={props.difficulty} onChange={(event) => props.onDifficultyChange(event.target.value as 'easy' | 'medium' | 'hard')}>
              {Object.entries(difficultyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>Тип клиента</span>
            <select value={props.clientType} onChange={(event) => props.onClientTypeChange(event.target.value)}>
              <option value="random">Случайный</option>
              <option value="careful">Внимательный</option>
              <option value="price_sensitive">Цена важна</option>
            </select>
          </label>
        </div>
        <button className="train-primary-button train-new-start" disabled={props.busy || !props.scenarioId} onClick={props.onStart}>
          Создать чат
        </button>
      </section>
    </div>
  );
}

function ReportPanel(props: { report: TrainerReport; onClose: () => void }) {
  const recommendations = props.report.topRecommendations.slice(0, 3).map((item) => {
    if (typeof item === 'string') return item;
    return String(item.title || item.recommendation || item.description || 'Рекомендация');
  });
  const checklist = props.report.checklist.slice(0, 6);
  return (
    <div className="train-report-backdrop" onClick={props.onClose}>
      <section className="train-report" onClick={(event) => event.stopPropagation()}>
        <header className="train-report-header">
          <div>
            <div className="train-report-kicker">{props.report.type === 'plan' ? 'План дня' : 'Свободная тренировка'}</div>
            <h2>{props.report.scenarioName}</h2>
          </div>
          <button className="train-close-button" onClick={props.onClose}>×</button>
        </header>
        <div className="train-report-score">
          <strong>{props.report.score ?? 0}</strong>
          <span>{scoreLabel(props.report.score)}</span>
          <small>{props.report.finalPoints ?? 0} очков · ×{props.report.multiplier}</small>
        </div>
        <div className="train-report-grid">
          <div>
            <h3>Чек-лист</h3>
            {checklist.length === 0 ? (
              <p className="train-muted">Данные появятся после оценки сессии.</p>
            ) : (
              checklist.map((item, index) => (
                <div className="train-report-row" key={index}>
                  <span>{String(item.comment || item.code || item.expectedAnswer || `Пункт ${index + 1}`)}</span>
                  <b>{checklistStatusLabel(item.status ?? item.score)}</b>
                </div>
              ))
            )}
          </div>
          <div>
            <h3>Рекомендации</h3>
            {recommendations.length === 0 ? (
              <p className="train-muted">Пока нет рекомендаций.</p>
            ) : (
              recommendations.map((item, index) => <p className="train-recommendation" key={index}>{item}</p>)
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function InlineSessionAnalytics(props: { report: TrainerReport }) {
  const planCriteriaRaw = props.report.evaluation?.plan_criteria && typeof props.report.evaluation.plan_criteria === 'object'
    ? props.report.evaluation.plan_criteria as Record<string, unknown>
    : null;
  const planCriteriaItems = Array.isArray(planCriteriaRaw?.items)
    ? planCriteriaRaw.items.map((raw) => {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const maxScore = Number(item.maxScore ?? 0);
      const score = Number(item.score ?? 0);
      return {
        expectedAnswer: String(item.expectedAnswer || item.title || item.name || item.question || 'Критерий скрипта'),
        maxScore: Number.isFinite(maxScore) ? maxScore : 0,
        score: Number.isFinite(score) ? score : 0,
        evidence: String(item.evidence || item.comment || item.reason || ''),
      };
    })
    : [];
  const recommendations = props.report.topRecommendations.slice(0, 3).map((item) => {
    if (typeof item === 'string') return item;
    return String(item.title || item.recommendation || item.description || 'Рекомендация');
  });
  const checklist = props.report.checklist.slice(0, 6);
  const score = Number(planCriteriaRaw?.percent ?? props.report.score ?? 0);
  const criteriaChecklist = planCriteriaItems.length > 0
    ? planCriteriaItems.map((item) => {
      const ratio = item.maxScore > 0 ? item.score / item.maxScore : 0;
      return {
        label: item.expectedAnswer,
        result: ratio >= 0.8 ? 'pass' : ratio >= 0.4 ? 'warn' : 'fail',
        quote: item.evidence || `Баллы: ${item.score} из ${item.maxScore}`,
      };
    })
    : checklist.map((item, index) => {
      const status = String(item.status ?? item.result ?? '').toUpperCase();
      return {
        label: String(item.comment || item.code || item.expectedAnswer || `Пункт ${index + 1}`),
        result: status === 'YES' || status === 'PASS' ? 'pass' : status === 'PARTIAL' || status === 'WARN' ? 'warn' : 'fail',
        quote: String(item.evidence || item.comment || ''),
      };
    });
  const checklistStats = criteriaChecklist.reduce((acc, item) => {
    if (item.result === 'pass') acc.pass += 1;
    else if (item.result === 'warn') acc.warn += 1;
    else acc.fail += 1;
    return acc;
  }, { pass: 0, warn: 0, fail: 0 });
  const dimensionsSource = props.report.dimensions && typeof props.report.dimensions === 'object'
    ? props.report.dimensions
    : (props.report.evaluation?.dimension_scores && typeof props.report.evaluation.dimension_scores === 'object'
      ? props.report.evaluation.dimension_scores as Record<string, unknown>
      : {});
  const dimensions = Object.entries(dimensionsSource)
    .map(([key, value]) => {
      const raw = typeof value === 'number'
        ? value
        : typeof value === 'object' && value !== null
          ? Number((value as Record<string, unknown>).score ?? (value as Record<string, unknown>).value)
          : Number(value);
      return {
        label: key.replace(/_/g, ' '),
        score: Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0,
      };
    })
    .filter((item) => item.score > 0)
    .slice(0, 4);
  const scriptIssueItems = planCriteriaItems
    .filter((item) => item.maxScore <= 0 || item.score / item.maxScore < 0.8)
    .map((item) => ({
      title: item.expectedAnswer,
      severity: item.maxScore > 0 && item.score / item.maxScore >= 0.4 ? 'MEDIUM' : 'HIGH',
      evidence: item.evidence || `Баллы: ${item.score} из ${item.maxScore}`,
    }));
  const issueItems = (scriptIssueItems.length > 0 ? scriptIssueItems : props.report.objectionsAnalysis
    .map((item) => ({
      title: String(item.recommendation || item.issue_type || item.issue || item.title || 'Ошибка'),
      severity: String(item.severity || '').toUpperCase(),
      evidence: String(item.evidence || item.comment || ''),
    }))
    .filter((item) => item.title.trim())
  ).slice(0, 5);
  return (
    <section className="train-inline-report train-audit-report">
      <div className="sa-card sa-audit-summary">
        <div className="sa-audit-summary-score-wrap">
          <div className={`sa-audit-summary-score ${ratingClass(score)}`}>{score}</div>
          <div className="sa-audit-summary-score-label">Общий балл</div>
        </div>
        <div className="sa-audit-summary-body">
          <div className="sa-audit-summary-verdict">{scoreLabel(props.report.score)}</div>
          <div className="sa-audit-summary-meta">
            <span className="sa-metric-chip">Сценарий: {props.report.scenarioName}</span>
            <span className="sa-metric-chip">Очки: {props.report.finalPoints ?? 0}</span>
            <span className="sa-metric-chip">Множитель: ×{props.report.multiplier}</span>
          </div>
          {props.report.failureReason && (
            <div className="sa-audit-fail-reason">
              <strong>Причина провала:</strong> {props.report.failureReason}
            </div>
          )}
        </div>
      </div>

      <div className="sa-kpi-grid sa-kpi-grid-audit">
        <div className="sa-card sa-kpi-card">
          <div className="sa-kpi-label">Общий балл</div>
          <div className={`sa-kpi-value ${ratingClass(score)}`}>{score}</div>
        </div>
        <div className="sa-card sa-kpi-card">
          <div className="sa-kpi-label">Очки</div>
          <div className="sa-kpi-value">{props.report.finalPoints ?? 0}</div>
        </div>
        <div className="sa-card sa-kpi-card">
          <div className="sa-kpi-label">Да / Частично / Нет</div>
          <div className="sa-kpi-value">{checklistStats.pass}/{checklistStats.warn}/{checklistStats.fail}</div>
        </div>
      </div>

      {dimensions.length > 0 && (
        <div className="sa-card">
          <div className="sa-chart-wrap">
            <h3 className="sa-chart-title">Оценка по блокам</h3>
            <div className="sa-hbar-list">
              {dimensions.map((item) => (
                <div className="sa-hbar-row" key={item.label}>
                  <span className="sa-hbar-label">{item.label}</span>
                  <div className="sa-hbar-track">
                    <div className="sa-hbar-fill" style={{ width: `${item.score}%`, background: item.score >= 80 ? '#34D399' : item.score >= 50 ? '#FBBF24' : '#F87171' }} />
                  </div>
                  <span className={`sa-hbar-score ${ratingClass(item.score)}`}>{item.score}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="sa-card">
        <h3 className="sa-card-heading">Чек-лист</h3>
        {criteriaChecklist.length === 0 ? (
          <div className="sa-chart-empty">Нет данных чек-листа</div>
        ) : (
          <div className="sa-checklist">
            {criteriaChecklist.map((item, index) => {
              const resultClass = item.result === 'pass' ? 'sa-check-pass' : item.result === 'warn' ? 'sa-check-warn' : 'sa-check-fail';
              const resultLabel = item.result === 'pass' ? 'Да' : item.result === 'warn' ? 'Частично' : 'Нет';
              return (
                <div className={`sa-checklist-item ${resultClass}`} key={index}>
                  <span className="sa-checklist-icon">{resultLabel}</span>
                  <div className="sa-checklist-content">
                    <div className="sa-checklist-label">{item.label}</div>
                    {item.quote && <div className="sa-checklist-quote">{item.quote}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="sa-detail-insights">
        <div className="sa-card" style={{ flex: 1 }}>
          <h3 className="sa-card-heading">ТОП-ошибки</h3>
          {issueItems.length === 0 ? (
            <div className="sa-chart-empty">Критичных ошибок не найдено</div>
          ) : (
            <ul className="sa-issue-list">
              {issueItems.map((item, index) => (
                <li className="sa-issue-item" key={index}>
                  <span className="sa-issue-name">{item.title}</span>
                  <span className="sa-issue-pct">{item.severity || index + 1}</span>
                  <div className="sa-issue-bar"><div className="sa-issue-bar-fill" style={{ width: `${item.severity === 'HIGH' ? 100 : item.severity === 'MEDIUM' ? 70 : 45}%` }} /></div>
                  {item.evidence && <div className="sa-meta">{item.evidence}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="sa-card" style={{ flex: 1 }}>
          <h3 className="sa-card-heading">Рекомендации</h3>
          {recommendations.length === 0 ? (
            <div className="sa-chart-empty">Нет рекомендаций</div>
          ) : (
            <div className="sa-training-list">
              {recommendations.map((item, index) => (
                <div className="sa-training-item" key={index}>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>{item}</div>
                    <div className="sa-meta">Отработать в следующей тренировке</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function microphoneErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name || '') : '';
  const message = error instanceof Error ? error.message : String(error || '');
  const text = `${name} ${message}`.toLowerCase();
  if (text.includes('permission denied by system') || text.includes('notallowederror') || text.includes('permission denied')) {
    return 'Система заблокировала микрофон для браузера. Проверьте настройки macOS/Windows: Privacy & Security → Microphone, разрешите микрофон для браузера и перезапустите вкладку.';
  }
  if (text.includes('notfounderror') || text.includes('device not found')) {
    return 'Микрофон не найден. Проверьте, что устройство подключено и выбрано в настройках браузера.';
  }
  if (text.includes('notreadableerror') || text.includes('could not start')) {
    return 'Микрофон занят другим приложением. Закройте Zoom/Telegram/браузерные вкладки, которые могут использовать микрофон.';
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Браузер разрешает микрофон только на HTTPS или localhost. Откройте страницу через localhost/127.0.0.1 или HTTPS.';
  }
  return message || 'Не удалось включить микрофон.';
}

function audioDataUrl(base64: string | null | undefined, mimeType?: string | null): string | null {
  if (!base64) return null;
  return `data:${mimeType || 'audio/ogg'};base64,${base64}`;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const length = Math.max(1, Math.round(input.length / ratio));
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sum += input[sourceIndex];
      count += 1;
    }
    result[index] = count ? sum / count : input[start] || 0;
  }
  return result;
}

function pcm16FromFloat32(input: Float32Array): Uint8Array {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function wavBlobFromPcm16(pcm: Uint8Array, sampleRate = 16000): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, pcm.length, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

function AudioBubble(props: { message: ChatMessage; onPlayed?: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!props.message.autoPlay || !audioRef.current) return;
    audioRef.current.play().catch(() => {});
  }, [props.message.autoPlay]);
  const durationLabel = props.message.durationSec
    ? `0:${String(Math.min(59, props.message.durationSec)).padStart(2, '0')}`
    : '0:00';
  function toggleAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }
  return (
    <div className={`train-audio-bubble ${props.message.role === 'client' ? 'train-audio-client' : 'train-audio-manager'}`}>
      {props.message.audioUrl ? (
        <div className="train-voice-row">
          <button className="train-voice-play" type="button" onClick={toggleAudio} aria-label={playing ? 'Пауза' : 'Проиграть'}>
            {playing ? 'Ⅱ' : '▶'}
          </button>
          <div className="train-voice-main">
            <div className="train-voice-wave" style={{ '--voice-progress': `${progress}%` } as React.CSSProperties}>
              {Array.from({ length: 28 }).map((_, index) => <span key={index} />)}
            </div>
            <div className="train-voice-meta">
              <span>{durationLabel}</span>
              <span>{props.message.role === 'client' ? 'Клиент' : 'Вы'}</span>
            </div>
          </div>
          <audio
            ref={audioRef}
            src={props.message.audioUrl}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => {
              const audio = event.currentTarget;
              setProgress(audio.duration ? Math.min(100, (audio.currentTime / audio.duration) * 100) : 0);
            }}
            onEnded={() => {
              setPlaying(false);
              setProgress(0);
              props.onPlayed?.();
            }}
          />
        </div>
      ) : (
        <div className="train-voice-pending">{props.message.textFallback || 'Голосовое сообщение'}</div>
      )}
      {props.message.textFallback && props.message.audioUrl && (
        <p className="train-message-transcript">{props.message.textFallback}</p>
      )}
    </div>
  );
}

function SessionPreview(props: {
  session: TrainerSessionSummary;
  initialMessage: TrainerInitialMessage | null;
  transcript?: TrainerInitialMessage['transcript'];
  report?: TrainerReport | null;
  clientTitle: string;
  embedded?: boolean;
  onClose: () => void;
  onSessionUpdate: (session: TrainerSessionSummary) => void;
}) {
  const buildInitialMessages = (): ChatMessage[] => {
    if (props.transcript?.length) {
      return props.transcript.map((turn, index) => ({
        id: index + 1,
        role: turn.role,
        audioUrl: audioDataUrl(turn.audioBase64, turn.audioMimeType),
        durationSec: turn.durationSec,
        textFallback: turn.text || (turn.role === 'client' ? 'Сообщение клиента' : 'Сообщение менеджера'),
      }));
    }
    const first = props.initialMessage;
    if (!first?.clientMessage) return [];
    return [{
      id: 1,
      role: 'client',
      audioUrl: audioDataUrl(first.audioBase64, first.audioMimeType),
      textFallback: first.clientMessage,
      autoPlay: Boolean(first.audioBase64),
    }];
  };
  const [messages, setMessages] = useState<ChatMessage[]>(buildInitialMessages);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [ended, setEnded] = useState(props.session.status === 'completed' || props.session.status === 'failed');
  const [error, setError] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const recordStartedAtRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    audioContextRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    setMessages(buildInitialMessages());
    setEnded(props.session.status === 'completed' || props.session.status === 'failed');
    setError(null);
    setSending(false);
    setRecording(false);
  }, [props.session.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending, error, ended]);

  async function sendVoiceAudio(params: {
    audioBase64: string;
    mimeType: string;
    durationSec: number;
    managerAudioUrl: string;
  }) {
    const managerAudioUrl = params.managerAudioUrl;
    const idBase = messages.length ? messages[messages.length - 1].id + 1 : 1;
    setMessages((prev) => [
      ...prev,
      { id: idBase, role: 'manager', audioUrl: managerAudioUrl, durationSec: params.durationSec },
      { id: idBase + 1, role: 'client', audioUrl: null, textFallback: 'Клиент отвечает...' },
    ]);
    setSending(true);
    setError(null);
    try {
      const data = await sendTrainerVoiceMessage(props.session.id, {
        audioBase64: params.audioBase64,
        mimeType: params.mimeType,
        durationSec: params.durationSec,
      });
      setMessages((prev) => prev.map((message) => message.id === idBase + 1
        ? {
          id: idBase + 1,
          role: 'client',
          audioUrl: audioDataUrl(data.audioBase64, data.audioMimeType),
          textFallback: data.clientMessage,
          autoPlay: Boolean(data.audioBase64),
        }
        : message));
      setEnded(data.endConversation);
      props.onSessionUpdate(data.session);
    } catch (sendError) {
      setMessages((prev) => prev.map((message) => message.id === idBase + 1
        ? { ...message, textFallback: 'Не удалось получить ответ клиента.', audioUrl: null }
        : message));
      setError(sendError instanceof Error ? sendError.message : 'Не удалось отправить голосовое сообщение.');
    } finally {
      setSending(false);
    }
  }

  async function stopPcmRecording() {
    const audioContext = audioContextRef.current;
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setRecording(false);

    const durationSec = Math.max(1, Math.round((Date.now() - recordStartedAtRef.current) / 1000));
    const inputRate = audioContext?.sampleRate || 48000;
    await audioContext?.close().catch(() => {});
    audioContextRef.current = null;
    const samples = downsampleTo16k(concatFloat32(pcmChunksRef.current), inputRate);
    pcmChunksRef.current = [];
    if (samples.length === 0) return;
    const pcm = pcm16FromFloat32(samples);
    const wavBlob = wavBlobFromPcm16(pcm);
    await sendVoiceAudio({
      audioBase64: bytesToBase64(pcm),
      mimeType: 'audio/pcm;rate=16000',
      durationSec,
      managerAudioUrl: URL.createObjectURL(wavBlob),
    });
  }

  async function toggleRecording() {
    if (recording) {
      await stopPcmRecording();
      return;
    }
    if (sending || ended) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error('AudioContext is not supported');
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      pcmChunksRef.current = [];
      recordStartedAtRef.current = Date.now();
      processor.onaudioprocess = (event) => {
        pcmChunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      processorRef.current = processor;
      setRecording(true);
      setError(null);
    } catch (recordError) {
      setError(microphoneErrorMessage(recordError));
    }
  }

  return (
    <section className={`train-chat-shell ${props.embedded ? 'train-chat-shell-embedded' : ''}`}>
      <header className="train-chat-header">
        <button className="train-back-button" onClick={props.onClose}>←</button>
        <div className="train-client-avatar">AI</div>
        <div>
          <strong>{props.clientTitle}</strong>
          <span>{props.session.scenarioName}</span>
        </div>
      </header>
      <div className="train-chat-body">
        <div className="train-chat-thread">
          {messages.length === 0 ? (
            <div className="train-chat-status">Клиент подключается...</div>
          ) : (
            messages.map((message) => <AudioBubble key={message.id} message={message} />)
          )}
          {sending && <div className="train-chat-status">Клиент отвечает...</div>}
          {error && <div className="train-chat-error">{error}</div>}
          {ended && <div className="train-chat-status">Сессия завершена. Отчёт появится в истории.</div>}
          {ended && props.report && <InlineSessionAnalytics report={props.report} />}
          <div ref={messagesEndRef} />
        </div>
      </div>
      <footer className="train-recorder-bar">
        <button
          className={`train-record-button ${recording ? 'train-record-button-active' : ''}`}
          title="Записать голосовое сообщение"
          disabled={sending || ended}
          onClick={toggleRecording}
        >
          <span />
        </button>
      </footer>
    </section>
  );
}

export function TrainPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedSessionId = useMemo(() => {
    const match = location.pathname.match(/^\/train\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }, [location.pathname]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<TrainerProfile | null>(null);
  const [scenarios, setScenarios] = useState<TrainerScenario[]>([]);
  const [planItems, setPlanItems] = useState<TrainerPlanItem[]>([]);
  const [history, setHistory] = useState<TrainerSessionSummary[]>([]);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [clientType, setClientType] = useState('random');
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [activeSession, setActiveSession] = useState<TrainerSessionSummary | null>(null);
  const [activeInitialMessage, setActiveInitialMessage] = useState<TrainerInitialMessage | null>(null);
  const [activeTranscript, setActiveTranscript] = useState<TrainerInitialMessage['transcript']>([]);
  const [activeReport, setActiveReport] = useState<TrainerReport | null>(null);
  const [activeCaseContext, setActiveCaseContext] = useState<Record<string, unknown> | null>(null);
  const [report, setReport] = useState<TrainerReport | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  const completedPlanCount = useMemo(() => planItems.filter((item) => item.status === 'completed').length, [planItems]);
  const firstScenarioId = selectedScenarioId || scenarios[0]?.id || '';
  const activePlanItems = useMemo(() => planItems.filter((item) => item.status === 'not_started' || item.status === 'in_progress'), [planItems]);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoadState('loading');
      setError(null);
    }
    try {
      const [profileData, scenarioData, planData, historyData] = await Promise.all([
        fetchTrainerProfile(),
        fetchTrainerScenarios(),
        fetchTrainerTodayPlan(),
        fetchTrainerHistory(),
      ]);
      setProfile(profileData);
      setScenarios(scenarioData);
      setPlanItems(planData.sessions);
      setHistory(historyData);
      setSelectedScenarioId((current) => current || scenarioData[0]?.id || '');
      setLoadState('ready');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить тренажёр.');
      if (!options?.silent) setLoadState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedSessionId) {
      setActiveSession(null);
      setActiveInitialMessage(null);
      setActiveTranscript([]);
      setActiveReport(null);
      setActiveCaseContext(null);
      return;
    }
    let cancelled = false;
    async function loadSelectedSession() {
      setBusy(true);
      setError(null);
      try {
        const dialog = await fetchTrainerDialog(selectedSessionId as string);
        if (cancelled) return;
        setActiveSession(dialog.session);
        setActiveInitialMessage(null);
        setActiveTranscript(dialog.transcript);
        setActiveCaseContext(dialog.caseContext);
        if (dialog.session.status === 'completed' || dialog.session.status === 'failed') {
          const sessionReport = await fetchTrainerReport(dialog.session.id);
          if (!cancelled) setActiveReport(sessionReport);
        } else {
          setActiveReport(null);
        }
      } catch (selectedError) {
        if (!cancelled) setError(selectedError instanceof Error ? selectedError.message : 'Не удалось открыть тренировку.');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    loadSelectedSession();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  async function startPlan(item: TrainerPlanItem) {
    setBusy(true);
    setError(null);
    try {
      const data = await startTrainerSession({
        sessionType: 'plan',
        planItemId: item.id,
        scenarioId: item.scenarioId,
        difficulty: 'medium',
        clientType: 'random',
      });
      setActiveSession(data.session);
      setActiveInitialMessage(data.initialMessage);
      setActiveTranscript(data.initialMessage?.transcript ?? []);
      setActiveReport(null);
      setActiveCaseContext(data.caseContext);
      setNewSessionOpen(false);
      navigate(`/train/${encodeURIComponent(data.session.id)}`);
      await load({ silent: true });
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Не удалось начать тренировку.');
    } finally {
      setBusy(false);
    }
  }

  async function startFree() {
    if (!firstScenarioId) return;
    setBusy(true);
    setError(null);
    try {
      const data = await startTrainerSession({
        sessionType: 'free',
        scenarioId: firstScenarioId,
        difficulty,
        clientType,
      });
      setActiveSession(data.session);
      setActiveInitialMessage(data.initialMessage);
      setActiveTranscript(data.initialMessage?.transcript ?? []);
      setActiveReport(null);
      setActiveCaseContext(data.caseContext);
      setNewSessionOpen(false);
      navigate(`/train/${encodeURIComponent(data.session.id)}`);
      await load({ silent: true });
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Не удалось начать тренировку.');
    } finally {
      setBusy(false);
    }
  }

  async function openReport(id: string) {
    setBusy(true);
    setError(null);
    try {
      setReport(await fetchTrainerReport(id));
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Не удалось открыть отчёт.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="train-app">
      {loadState === 'loading' ? (
        <div className="train-loading">Загрузка...</div>
      ) : loadState === 'error' ? (
        <div className="train-error">
          <strong>{error}</strong>
          <button onClick={load}>Повторить</button>
        </div>
      ) : (
        <div className={`train-telegram ${activeSession ? 'train-telegram-chat-open' : ''}`}>
          <aside className="train-chat-sidebar">
            <header className="train-chat-sidebar-head">
              <button className="train-profile-button" onClick={() => setProfileOpen(true)}>
                <span className="train-profile-avatar">{profile?.fullName.slice(0, 1).toUpperCase() || 'M'}</span>
                <span>
                  <strong>{profile?.fullName}</strong>
                  <small>{profile?.branchName}{profile?.city ? ` · ${profile.city}` : ''}</small>
                </span>
              </button>
              <button className="train-plus-button" onClick={() => setNewSessionOpen(true)} title="Новый чат">+</button>
            </header>

            <div className="train-search-fake">Поиск</div>
            {error && <div className="train-inline-error">{error}</div>}

            <div className="train-chat-list">
              {activePlanItems.length > 0 && (
                <div className="train-chat-list-group">
                  <div className="train-chat-list-label">План дня · {completedPlanCount}/{planItems.length || 3}</div>
                  {activePlanItems.map((item) => (
                    <ChatListButton
                      key={item.id}
                      title={item.scenarioName || 'Плановая тренировка'}
                      subtitle={item.status === 'in_progress' ? 'В процессе' : 'Нажмите, чтобы начать'}
                      badge={item.status === 'in_progress' ? '…' : '▶'}
                      active={Boolean(item.trainerSessionId && selectedSessionId === item.trainerSessionId)}
                      disabled={busy}
                      onClick={() => item.status === 'in_progress' && item.trainerSessionId
                        ? navigate(`/train/${encodeURIComponent(item.trainerSessionId)}`)
                        : startPlan(item)}
                    />
                  ))}
                </div>
              )}

              <div className="train-chat-list-group">
                <div className="train-chat-list-label">История сессий</div>
                {history.length === 0 ? (
                  <div className="train-empty train-empty-chat">История появится после первой тренировки.</div>
                ) : (
                  history.slice(0, 30).map((item) => (
                    <ChatListButton
                      key={item.id}
                      title={item.scenarioName}
                      subtitle={`${formatDateTime(item.completedAt || item.startedAt)} · ${item.type === 'plan' ? 'План' : 'Свободная'}`}
                      badge={item.score ?? '—'}
                      active={selectedSessionId === item.id}
                      onClick={() => navigate(`/train/${encodeURIComponent(item.id)}`)}
                    />
                  ))
                )}
              </div>
            </div>
          </aside>

          <section className="train-chat-pane">
            {activeSession ? (
              <SessionPreview
                session={activeSession}
                initialMessage={activeInitialMessage}
                transcript={activeTranscript}
                report={activeReport}
                clientTitle={clientProfileTitle(activeCaseContext)}
                embedded
                onClose={() => {
                  navigate('/train');
                }}
                onSessionUpdate={async (session) => {
                  setActiveSession(session);
                  if (session.status === 'completed' || session.status === 'failed') {
                    await load({ silent: true });
                    setActiveReport(await fetchTrainerReport(session.id));
                  }
                }}
              />
            ) : (
              <div className="train-chat-empty-pane">
                <div className="train-empty-hero">
                  <div className="train-empty-hero-avatar">AI</div>
                  <h1>AI Тренажёр</h1>
                  <p>Выберите чат слева или создайте новую тренировку через плюс.</p>
                  <button className="train-primary-button" disabled={busy || !firstScenarioId} onClick={() => setNewSessionOpen(true)}>Новый чат</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {report && <ReportPanel report={report} onClose={() => setReport(null)} />}
      {profileOpen && <ProfileModal profile={profile} onClose={() => setProfileOpen(false)} />}
      {newSessionOpen && (
        <NewSessionModal
          scenarios={scenarios}
          scenarioId={firstScenarioId}
          difficulty={difficulty}
          clientType={clientType}
          busy={busy}
          onScenarioChange={setSelectedScenarioId}
          onDifficultyChange={setDifficulty}
          onClientTypeChange={setClientType}
          onStart={startFree}
          onClose={() => setNewSessionOpen(false)}
        />
      )}
    </main>
  );
}
