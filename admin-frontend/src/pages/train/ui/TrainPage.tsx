import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import {
  abandonTrainerSession,
  fetchTrainerAuditDetail,
  fetchTrainerDialog,
  fetchTrainerHistory,
  fetchTrainerProfile,
  fetchTrainerScenarios,
  sendTrainerVoiceMessage,
  startTrainerSession,
  waitForTrainerReport,
  type TrainerInitialMessage,
  type TrainerProfile,
  type TrainerScenario,
  type TrainerSessionSummary,
} from '../../../shared/api/trainer';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { buildTrainerSessionPath, parseAdminPath } from '../../../shared/routing/adminRoutes';
import { BrutalModal } from '../../../shared/ui/brutal-modal';
import { BrutalSelect } from '../../../shared/ui/BrutalSelect';
import { SingleSelectFilterPicker } from '../../../shared/ui/filter-picker/SingleSelectFilterPicker';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
import { SlideOver } from '../../../shared/ui/slide-over';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import '../../../shared/ui/styles/admin-panel.css';
import '../../../shared/ui/styles/theme-brutal.css';
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

function formatDateShort(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function trainerQualityTag(score: number | null): string | null {
  if (score == null) return null;
  if (score >= 85) return 'Отлично';
  if (score >= 76) return 'Хорошо';
  if (score >= 50) return 'Средне';
  return 'Нужно улучшить';
}

type HistoryGradeFilter = 'all' | 'excellent' | 'good' | 'medium' | 'improve' | 'none';

function historyGradeKey(score: number | null): Exclude<HistoryGradeFilter, 'all'> {
  if (score == null) return 'none';
  if (score >= 85) return 'excellent';
  if (score >= 76) return 'good';
  if (score >= 50) return 'medium';
  return 'improve';
}

function trainerScoreClass(score: number): 'sa-score-green' | 'sa-score-orange' | 'sa-score-red' {
  if (score >= 76) return 'sa-score-green';
  if (score >= 50) return 'sa-score-orange';
  return 'sa-score-red';
}

const VOICE_BAR_COUNT = 28;
const RECORD_LEVEL_BARS = 16;
const DAILY_FREE_GOAL = 3;
const HISTORY_PAGE_SIZE = 15;

function isLocalToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  );
}

function countTodayFreeCompleted(history: TrainerSessionSummary[]): number {
  return history.filter((item) => (
    item.type === 'free'
    && item.status === 'completed'
    && isLocalToday(item.completedAt || item.startedAt)
  )).length;
}

function TrainerDoneCircle(props: { size: 'plan' | 'quest' }) {
  const iconSize = props.size === 'plan' ? 28 : 22;
  return (
    <span className={`train-hub-status-circle train-hub-status-circle--done train-hub-status-circle--${props.size}`} aria-hidden>
      <LetsIcon name="done-light" size={iconSize} strokeWidth={2} />
    </span>
  );
}

function TrainerProgressDots(props: {
  completed: number;
  total?: number;
  size?: 'md' | 'lg';
}) {
  const total = props.total ?? DAILY_FREE_GOAL;
  const completed = Math.max(0, Math.min(props.completed, total));
  const sizeClass = props.size === 'lg' ? 'train-hub-dots--lg' : 'train-hub-dots--md';

  return (
    <div className={`train-hub-dots ${sizeClass}`} role="img" aria-label={`${completed} из ${total} выполнено`}>
      {Array.from({ length: total }).map((_, index) => {
        if (index < completed) {
          return props.size === 'lg'
            ? <TrainerDoneCircle key={index} size="plan" />
            : <span key={index} className="train-hub-dot train-hub-dot--done" />;
        }
        return <span key={index} className="train-hub-dot train-hub-dot--empty" />;
      })}
    </div>
  );
}

function TrainerHub(props: {
  profile: TrainerProfile | null;
  history: TrainerSessionSummary[];
  busy: boolean;
  error: string | null;
  canStartFree: boolean;
  onNewSession: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenReport: (sessionId: string) => void;
}) {
  const [filterScenario, setFilterScenario] = useState('all');
  const [filterType, setFilterType] = useState<'all' | 'free' | 'plan'>('all');
  const [filterGrade, setFilterGrade] = useState<HistoryGradeFilter>('all');
  const [historyPage, setHistoryPage] = useState(1);
  const todayFreeCompleted = useMemo(() => countTodayFreeCompleted(props.history), [props.history]);

  const scenarioOptions = useMemo(() => {
    const names = [...new Set(props.history.map((item) => item.scenarioName || 'Тренировка'))]
      .sort((left, right) => left.localeCompare(right, 'ru'));
    return [
      { value: 'all', label: 'Все сценарии' },
      ...names.map((name) => ({ value: name, label: name })),
    ];
  }, [props.history]);

  const typeOptions = useMemo(() => ([
    { value: 'all' as const, label: 'Все типы' },
    { value: 'free' as const, label: 'Свободная' },
    { value: 'plan' as const, label: 'План' },
  ]), []);

  const gradeOptions = useMemo(() => ([
    { value: 'all' as const, label: 'Все оценки' },
    { value: 'excellent' as const, label: 'Отлично' },
    { value: 'good' as const, label: 'Хорошо' },
    { value: 'medium' as const, label: 'Средне' },
    { value: 'improve' as const, label: 'Нужно улучшить' },
    { value: 'none' as const, label: 'Без оценки' },
  ]), []);

  const filteredHistory = useMemo(() => props.history.filter((item) => {
    if (item.status === 'in_progress') return false;
    const scenarioName = item.scenarioName || 'Тренировка';
    if (filterScenario !== 'all' && scenarioName !== filterScenario) return false;
    if (filterType !== 'all' && item.type !== filterType) return false;
    if (filterGrade !== 'all' && historyGradeKey(item.score) !== filterGrade) return false;
    return true;
  }), [props.history, filterScenario, filterType, filterGrade]);

  const historyTotalPages = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, historyTotalPages);
  const historyStartIndex = (safeHistoryPage - 1) * HISTORY_PAGE_SIZE;
  const pagedHistory = filteredHistory.slice(historyStartIndex, historyStartIndex + HISTORY_PAGE_SIZE);

  useEffect(() => {
    setHistoryPage(1);
  }, [filterScenario, filterType, filterGrade, props.history]);

  function handleHistoryOpen(item: TrainerSessionSummary) {
    if (item.status === 'completed' || item.status === 'failed') {
      props.onOpenReport(item.id);
    }
  }

  function historyStatusLabel(item: TrainerSessionSummary): { text: string; className?: string } {
    if (item.status === 'cancelled') return { text: 'Прервана' };
    if ((item.status === 'completed' || item.status === 'failed') && item.score == null && !item.reportReady) {
      return { text: 'Оценивается…', className: 'sa-meta' };
    }
    if (item.status === 'failed') {
      const tag = trainerQualityTag(item.score);
      return tag
        ? { text: tag, className: trainerScoreClass(item.score ?? 0) }
        : { text: 'Провал', className: 'sa-score-red' };
    }
    const tag = trainerQualityTag(item.score);
    if (tag) return { text: tag, className: trainerScoreClass(item.score ?? 0) };
    return { text: '—' };
  }

  return (
    <div className="train-hub sa-page-enter">
      <header className="train-hub-block train-hub-header">
        <div>
          <h1 className="sa-page-title train-hub-title">Тренажёр</h1>
        </div>
      </header>

      {props.error && (
        <div className="train-hub-block train-hub-error" role="alert">{props.error}</div>
      )}

      <section className="train-hub-block train-hub-plan-hero">
        <div className="train-hub-plan-hero-card">
          <div className="train-hub-plan-hero-label">План дня</div>
          <TrainerProgressDots
            completed={todayFreeCompleted}
            total={DAILY_FREE_GOAL}
            size="lg"
          />
          <p className="train-hub-plan-hero-hint">
            {Math.min(todayFreeCompleted, DAILY_FREE_GOAL)} из {DAILY_FREE_GOAL} выполнено
          </p>
          <button
            type="button"
            className="sa-btn-brutal-3d train-hub-start-btn"
            disabled={props.busy || !props.canStartFree}
            onClick={props.onNewSession}
          >
            <LetsIcon name="add-light" size={18} bold strokeWidth={2} />
            Начать тренировку
          </button>
        </div>
      </section>

      <section className="train-hub-block train-hub-section train-hub-history">
        <div className="train-hub-section-head">
          <h2 className="train-hub-section-title">История тренировок</h2>
          {props.history.length > 0 && (
            <div className="train-hub-history-filters">
              <div className="sa-tag-filter-picker-wrap">
                <SingleSelectFilterPicker
                  options={scenarioOptions}
                  value={filterScenario}
                  onChange={setFilterScenario}
                  placeholder="Сценарий"
                />
              </div>
              <div className="sa-tag-filter-picker-wrap">
                <SingleSelectFilterPicker
                  options={typeOptions}
                  value={filterType}
                  onChange={setFilterType}
                  placeholder="Тип"
                />
              </div>
              <div className="sa-tag-filter-picker-wrap">
                <SingleSelectFilterPicker
                  options={gradeOptions}
                  value={filterGrade}
                  onChange={setFilterGrade}
                  placeholder="Оценка"
                />
              </div>
            </div>
          )}
        </div>
        {props.history.length === 0 ? (
          <p className="train-hub-empty">История появится после первой тренировки.</p>
        ) : filteredHistory.length === 0 ? (
          <p className="train-hub-empty">Нет тренировок по выбранным фильтрам.</p>
        ) : (
          <>
            <div className="train-hub-panel sa-companies-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Дата</th>
                    <th>Тип</th>
                    <th>Оценка</th>
                    <th>Балл</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedHistory.map((item) => {
                    const score = item.score;
                    const status = historyStatusLabel(item);
                    const canOpen = item.status === 'completed' || item.status === 'failed';
                    return (
                      <tr
                        key={item.id}
                        className={canOpen ? 'sa-row-clickable' : undefined}
                        onClick={canOpen ? () => handleHistoryOpen(item) : undefined}
                        role={canOpen ? 'button' : undefined}
                        tabIndex={canOpen ? 0 : undefined}
                        onKeyDown={canOpen ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleHistoryOpen(item);
                          }
                        } : undefined}
                      >
                        <td>{item.displayName || item.title || item.scenarioName || 'Тренировка'}</td>
                        <td className="sa-meta">{formatDateShort(item.completedAt || item.startedAt)}</td>
                        <td>{item.type === 'plan' ? 'План' : 'Свободная'}</td>
                        <td>
                          {status.className ? (
                            <span className={status.className}>{status.text}</span>
                          ) : (
                            <span className="sa-meta">{status.text}</span>
                          )}
                        </td>
                        <td>
                          {score != null ? (
                            <span className={`sa-kpi-value ${trainerScoreClass(score)}`}>{score.toFixed(0)}</span>
                          ) : status.text === 'Оценивается…' ? (
                            <span className="sa-meta">…</span>
                          ) : (
                            <span className="sa-meta">Н/Д</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={`sa-audit-history-pagination${filteredHistory.length > HISTORY_PAGE_SIZE ? '' : ' is-empty'}`}>
              {filteredHistory.length > HISTORY_PAGE_SIZE ? (
                <>
                  <span className="sa-meta">
                    Показаны {historyStartIndex + 1}-{Math.min(historyStartIndex + HISTORY_PAGE_SIZE, filteredHistory.length)} из {filteredHistory.length}
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      type="button"
                      className="sa-btn-field sa-btn-sm"
                      disabled={safeHistoryPage === 1}
                      onClick={() => setHistoryPage((current) => Math.max(1, current - 1))}
                    >
                      Назад
                    </button>
                    <span className="sa-metric-chip">Стр. {safeHistoryPage} из {historyTotalPages}</span>
                    <button
                      type="button"
                      className="sa-btn-field sa-btn-sm"
                      disabled={safeHistoryPage === historyTotalPages}
                      onClick={() => setHistoryPage((current) => Math.min(historyTotalPages, current + 1))}
                    >
                      Вперёд
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function trainerSessionLabel(session: Pick<TrainerSessionSummary, 'displayName' | 'title' | 'scenarioName'>): string {
  return session.displayName || session.title || session.scenarioName || 'Тренировка';
}

function voiceBubbleWidthPx(durationSec?: number | null): number {
  const bars = voiceBarCountForDuration(durationSec);
  // play button + gap + waveform bars (3px + 3px gap) + bubble padding
  return Math.max(140, Math.min(420, 38 + 9 + bars * 6 + 28));
}

function voiceBarCountForDuration(durationSec?: number | null): number {
  const sec = Math.max(0.6, Math.min(28, Number(durationSec) || 2));
  return Math.max(8, Math.min(36, Math.round(8 + sec * 1.35)));
}

function estimateDurationFromAudioUrl(url: string | null | undefined): number | null {
  if (!url || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const header = url.slice(0, comma);
  const base64 = url.slice(comma + 1);
  const bytes = Math.floor(base64.length * 0.75);
  if (bytes < 200) return 1;
  if (/wav/i.test(header)) {
    const pcmBytes = Math.max(0, bytes - 44);
    return Math.max(1, Math.round(pcmBytes / (16000 * 2)));
  }
  // compressed voice ≈ 12–16 kbps
  return Math.max(1, Math.round(bytes / 1800));
}

function localPlanDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function TrainMiniScoreGauge(props: { score: number }) {
  const score = Math.max(0, Math.min(100, Math.round(props.score)));
  const tone = score >= 76 ? 'good' : score >= 50 ? 'mid' : 'bad';
  const size = 72;
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setProgress(0);
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setProgress(score));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [score]);

  const offset = circumference - (progress / 100) * circumference;

  return (
    <div className={`train-report-score-gauge sa-call-report-gauge--${tone}`} aria-label={`Балл ${score}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          className="sa-call-report-gauge-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="sa-call-report-gauge-fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="train-report-score-gauge-center">
        <strong>{score}</strong>
      </div>
    </div>
  );
}

function TrainerSuccessCelebration(props: {
  title?: string;
  onClose: () => void;
}) {
  return createPortal(
    <div className="theme-brutal train-streak-celebration-backdrop" role="dialog" aria-modal aria-labelledby="train-success-title">
      <section className="train-streak-celebration train-success-celebration">
        <div className="train-hub-status-circle train-hub-status-circle--done train-success-check-circle" aria-hidden>
          <LetsIcon name="done-light" size={30} strokeWidth={2} />
        </div>
        <h2 id="train-success-title" className="train-streak-celebration-title">Готово</h2>
        <p className="train-streak-celebration-scenario">{props.title || 'Тренировка завершена'}</p>
        <button type="button" className="sa-btn-brutal-3d train-streak-celebration-btn" onClick={props.onClose}>
          Продолжить
        </button>
      </section>
    </div>,
    document.body,
  );
}

function TrainerStreakCelebration(props: {
  previousStreak: number;
  newStreak: number;
  onClose: () => void;
}) {
  const [displayStreak, setDisplayStreak] = useState(props.previousStreak);
  const [popped, setPopped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let tick: ReturnType<typeof setInterval> | undefined;

    setDisplayStreak(props.previousStreak);
    setPopped(false);

    const startDelay = window.setTimeout(() => {
      if (cancelled) return;
      const from = props.previousStreak;
      const to = props.newStreak;
      if (to <= from) {
        setDisplayStreak(to);
        setPopped(true);
        return;
      }

      let current = from;
      tick = window.setInterval(() => {
        if (cancelled) return;
        current += 1;
        setDisplayStreak(current);
        if (current >= to) {
          if (tick) window.clearInterval(tick);
          setPopped(true);
        }
      }, 380);
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(startDelay);
      if (tick) window.clearInterval(tick);
    };
  }, [props.previousStreak, props.newStreak]);

  return createPortal(
    <div className="theme-brutal train-streak-celebration-backdrop" role="dialog" aria-modal aria-labelledby="train-streak-title">
      <section className="train-streak-celebration">
        <div className="train-streak-celebration-kicker">Стрик</div>
        <h2 id="train-streak-title" className="train-streak-celebration-title">Первая тренировка дня</h2>
        <div className={`train-streak-celebration-streak ${popped ? 'train-streak-celebration-streak--pop' : ''}`}>
          <span className="train-streak-celebration-value" key={displayStreak}>{displayStreak}</span>
          <span className="train-streak-celebration-unit">дн.</span>
        </div>
        <button type="button" className="sa-btn-brutal-3d train-streak-celebration-btn" onClick={props.onClose}>
          Отлично!
        </button>
      </section>
    </div>,
    document.body,
  );
}

function NewSessionModal(props: {
  open: boolean;
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
    <BrutalModal
      open={props.open}
      onClose={props.onClose}
      title="Новая тренировка"
      subtitle="Свободная тренировка с виртуальным клиентом"
      width="medium"
      footer={(
        <div className="sa-modal-footer-row">
          <span />
          <div className="sa-modal-footer-row__right">
            <button type="button" className="sa-btn-outline" disabled={props.busy} onClick={props.onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="sa-btn-primary"
              disabled={props.busy || !props.scenarioId}
              onClick={props.onStart}
            >
              Начать тренировку
            </button>
          </div>
        </div>
      )}
    >
      <div className="train-controls train-controls-modal">
        <label>
          <span>Сценарий</span>
          <BrutalSelect
            value={props.scenarioId}
            options={props.scenarios.map((scenario) => ({ value: scenario.id, label: scenario.name }))}
            placeholder="Выберите сценарий"
            disabled={props.busy}
            onChange={props.onScenarioChange}
          />
        </label>
        <label>
          <span>Сложность</span>
          <BrutalSelect
            value={props.difficulty}
            options={Object.entries(difficultyLabels).map(([value, label]) => ({ value, label }))}
            disabled={props.busy}
            onChange={(value) => props.onDifficultyChange(value as 'easy' | 'medium' | 'hard')}
          />
        </label>
        <label>
          <span>Тип клиента</span>
          <BrutalSelect
            value={props.clientType}
            options={[
              { value: 'random', label: 'Случайный' },
              { value: 'careful', label: 'Внимательный' },
              { value: 'price_sensitive', label: 'Цена важна' },
            ]}
            disabled={props.busy}
            onChange={props.onClientTypeChange}
          />
        </label>
      </div>
    </BrutalModal>
  );
}

function ReportDrawer(props: {
  open: boolean;
  detail: AuditDetailItem | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <SlideOver open={props.open} title="Отчёт тренировки" width="xl" onClose={props.onClose}>
      {props.loading ? (
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Загрузка отчёта...</div>
      ) : props.error ? (
        <div className="sa-card" style={{ padding: 20 }}>
          <div style={{ color: '#b91c1c', fontWeight: 700 }}>Не удалось открыть отчёт</div>
          <div className="sa-meta" style={{ marginTop: 8 }}>{props.error}</div>
        </div>
      ) : props.detail ? (
        <AuditAnalyticsReport detail={props.detail} />
      ) : (
        <div className="sa-meta" style={{ padding: 48, textAlign: 'center' }}>Выберите тренировку.</div>
      )}
    </SlideOver>
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

function float32Rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) sum += input[index] * input[index];
  return Math.sqrt(sum / input.length);
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

function seededFallbackWaveform(barCount: number, seed: string): number[] {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Array.from({ length: barCount }, (_, index) => {
    hash = Math.imul(hash ^ (index + 1), 2246822519);
    const value = ((hash >>> 0) % 1000) / 1000;
    return 0.2 + value * 0.75;
  });
}

const waveformCache = new Map<string, number[]>();

async function analyzeAudioWaveform(audioUrl: string, barCount: number): Promise<number[]> {
  const cached = waveformCache.get(audioUrl);
  if (cached) return cached;

  const response = await fetch(audioUrl);
  const arrayBuffer = await response.arrayBuffer();
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('AudioContext is not supported');

  const ctx = new AudioContextCtor();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channel = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channel.length / barCount));
    const bars: number[] = [];

    for (let index = 0; index < barCount; index += 1) {
      const start = index * blockSize;
      const end = Math.min(channel.length, start + blockSize);
      let peak = 0;
      for (let sample = start; sample < end; sample += 1) {
        peak = Math.max(peak, Math.abs(channel[sample]));
      }
      bars.push(peak);
    }

    const max = Math.max(...bars, 0.001);
    const normalized = bars.map((value) => Math.max(0.16, Math.min(1, 0.16 + (value / max) * 0.84)));
    waveformCache.set(audioUrl, normalized);
    return normalized;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function useVoiceWaveform(audioUrl: string | null, barCount: number, seed: string): number[] {
  const [levels, setLevels] = useState<number[]>(() => seededFallbackWaveform(barCount, seed));

  useEffect(() => {
    if (!audioUrl) {
      setLevels(seededFallbackWaveform(barCount, seed));
      return undefined;
    }

    let cancelled = false;
    analyzeAudioWaveform(audioUrl, barCount)
      .then((result) => {
        if (!cancelled) setLevels(result);
      })
      .catch(() => {
        if (!cancelled) setLevels(seededFallbackWaveform(barCount, seed));
      });

    return () => {
      cancelled = true;
    };
  }, [audioUrl, barCount, seed]);

  return levels;
}

function AudioBubble(props: { message: ChatMessage; onPlayed?: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const estimated = estimateDurationFromAudioUrl(props.message.audioUrl);
  const [resolvedDuration, setResolvedDuration] = useState<number | null>(
    props.message.durationSec ?? estimated,
  );
  const durationSec = resolvedDuration ?? props.message.durationSec ?? estimated;
  const barCount = voiceBarCountForDuration(durationSec);
  const waveform = useVoiceWaveform(
    props.message.audioUrl,
    barCount,
    `${props.message.id}:${props.message.audioUrl || props.message.textFallback || ''}`,
  );
  useEffect(() => {
    setResolvedDuration(props.message.durationSec ?? estimateDurationFromAudioUrl(props.message.audioUrl));
  }, [props.message.durationSec, props.message.id, props.message.audioUrl]);

  useEffect(() => {
    if (!props.message.autoPlay || !props.message.audioUrl) return;
    const audio = audioRef.current;
    if (!audio) return;
    let cancelled = false;
    const tryPlay = () => {
      if (cancelled) return;
      audio.play().catch(() => {});
    };
    tryPlay();
    audio.addEventListener('canplay', tryPlay);
    audio.addEventListener('loadeddata', tryPlay);
    const retry = window.setTimeout(tryPlay, 180);
    const retry2 = window.setTimeout(tryPlay, 600);
    return () => {
      cancelled = true;
      audio.removeEventListener('canplay', tryPlay);
      audio.removeEventListener('loadeddata', tryPlay);
      window.clearTimeout(retry);
      window.clearTimeout(retry2);
    };
  }, [props.message.autoPlay, props.message.audioUrl, props.message.id]);

  const durationLabel = durationSec != null
    ? `0:${String(Math.min(59, Math.max(0, Math.round(durationSec)))).padStart(2, '0')}`
    : '0:00';
  const filledBars = Math.round((progress / 100) * barCount);
  const bubbleWidth = props.message.audioUrl ? voiceBubbleWidthPx(durationSec) : undefined;
  function toggleAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }
  return (
    <div
      className={`train-audio-bubble ${props.message.role === 'client' ? 'train-audio-client' : 'train-audio-manager'}`}
      style={bubbleWidth ? { width: `${bubbleWidth}px`, maxWidth: 'min(420px, 92%)' } : undefined}
    >
      {props.message.audioUrl ? (
        <div className="train-voice-row">
          <button className="train-voice-play" type="button" onClick={toggleAudio} aria-label={playing ? 'Пауза' : 'Проиграть'}>
            {playing ? 'Ⅱ' : '▶'}
          </button>
          <div className="train-voice-main">
            <div className={`train-voice-wave ${playing ? 'train-voice-wave--playing' : ''}`}>
              {waveform.map((level, index) => (
                <span
                  key={index}
                  className={index < filledBars ? 'train-voice-bar-filled' : ''}
                  style={{ height: `${5 + level * 19}px` }}
                />
              ))}
            </div>
            <div className="train-voice-meta">
              <span>{durationLabel}</span>
              <span>{props.message.role === 'client' ? 'Клиент' : 'Вы'}</span>
            </div>
          </div>
          <audio
            ref={audioRef}
            src={props.message.audioUrl}
            preload="auto"
            onLoadedMetadata={(event) => {
              const audioDuration = event.currentTarget.duration;
              if (Number.isFinite(audioDuration) && audioDuration > 0 && audioDuration < 600) {
                setResolvedDuration(Math.max(1, Math.round(audioDuration)));
              }
            }}
            onDurationChange={(event) => {
              const audioDuration = event.currentTarget.duration;
              if (Number.isFinite(audioDuration) && audioDuration > 0 && audioDuration < 600) {
                setResolvedDuration(Math.max(1, Math.round(audioDuration)));
              }
            }}
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
    </div>
  );
}

function SessionPreview(props: {
  session: TrainerSessionSummary;
  initialMessage: TrainerInitialMessage | null;
  transcript?: TrainerInitialMessage['transcript'];
  clientTitle: string;
  embedded?: boolean;
  onClose: () => void | Promise<void>;
  onOpenReport?: () => void;
  onSessionUpdate: (session: TrainerSessionSummary) => void;
  onSessionFinished: (session: TrainerSessionSummary) => void | Promise<void>;
}) {
  const buildInitialMessages = (): ChatMessage[] => {
    if (props.transcript?.length) {
      const lastClientIndex = [...props.transcript]
        .map((turn, index) => (turn.role === 'client' && turn.audioBase64 ? index : -1))
        .filter((index) => index >= 0)
        .pop() ?? -1;
      return props.transcript.map((turn, index) => ({
        id: index + 1,
        role: turn.role,
        audioUrl: audioDataUrl(turn.audioBase64, turn.audioMimeType),
        durationSec: turn.durationSec ?? estimateDurationFromAudioUrl(audioDataUrl(turn.audioBase64, turn.audioMimeType)),
        textFallback: turn.text || (turn.role === 'client' ? 'Сообщение клиента' : 'Сообщение менеджера'),
        autoPlay: props.session.status === 'in_progress' && index === lastClientIndex,
      }));
    }
    const first = props.initialMessage;
    if (!first?.clientMessage) return [];
    const audioUrl = audioDataUrl(first.audioBase64, first.audioMimeType);
    return [{
      id: 1,
      role: 'client',
      audioUrl,
      durationSec: estimateDurationFromAudioUrl(audioUrl),
      textFallback: first.clientMessage,
      autoPlay: Boolean(first.audioBase64),
    }];
  };
  const [messages, setMessages] = useState<ChatMessage[]>(buildInitialMessages);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordLevels, setRecordLevels] = useState<number[]>(() => Array.from({ length: RECORD_LEVEL_BARS }, () => 0.12));
  const [ended, setEnded] = useState(props.session.status === 'completed' || props.session.status === 'failed');
  const [completionPhase, setCompletionPhase] = useState<'idle' | 'dialog' | 'report' | 'ready'>(
    props.session.status === 'completed' || props.session.status === 'failed'
      ? (props.session.reportReady ? 'ready' : 'report')
      : 'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const recordStartedAtRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const finishAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    audioContextRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((track) => track.stop());
    finishAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    setMessages(buildInitialMessages());
    const isEnded = props.session.status === 'completed' || props.session.status === 'failed';
    setEnded(isEnded);
    setCompletionPhase(isEnded ? (props.session.reportReady ? 'ready' : 'report') : 'idle');
    setError(null);
    setSending(false);
    setRecording(false);
    setRecordLevels(Array.from({ length: RECORD_LEVEL_BARS }, () => 0.12));
  }, [props.session.id]);

  useEffect(() => {
    // Hydrate first bot voice when it arrives after async session init.
    setMessages((current) => {
      if (current.length > 0) return current;
      const next = buildInitialMessages();
      return next.length > 0 ? next : current;
    });
  }, [props.transcript, props.initialMessage]);

  useEffect(() => {
    if (!(props.session.status === 'completed' || props.session.status === 'failed')) return;
    if (props.session.reportReady) return;
    if (finishAbortRef.current) return;
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      setCompletionPhase('report');
      try {
        const readySession = await waitForTrainerReport(props.session.id, { signal: controller.signal });
        if (cancelled) return;
        setCompletionPhase('ready');
        props.onSessionUpdate(readySession);
      } catch {
        if (!cancelled) setCompletionPhase('ready');
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.session.id, props.session.status, props.session.reportReady]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending, error, ended, completionPhase]);

  async function finishConversation(session: TrainerSessionSummary) {
    setEnded(true);
    setCompletionPhase('dialog');
    props.onSessionUpdate(session);
    finishAbortRef.current?.abort();
    const controller = new AbortController();
    finishAbortRef.current = controller;
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      if (controller.signal.aborted) return;
      setCompletionPhase('report');
      const readySession = session.reportReady
        ? session
        : await waitForTrainerReport(session.id, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setCompletionPhase('ready');
      props.onSessionUpdate(readySession);
      await props.onSessionFinished(readySession);
    } catch (finishError) {
      if (controller.signal.aborted) return;
      setCompletionPhase('ready');
      setError(finishError instanceof Error ? finishError.message : 'Не удалось сформировать отчёт.');
      props.onSessionUpdate(session);
      await props.onSessionFinished(session);
    } finally {
      if (finishAbortRef.current === controller) finishAbortRef.current = null;
    }
  }

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
      const clientAudioUrl = audioDataUrl(data.audioBase64, data.audioMimeType);
      if (!clientAudioUrl) {
        throw new Error('Клиент ответил без аудио. Попробуйте отправить сообщение ещё раз.');
      }
      setMessages((prev) => prev.map((message) => message.id === idBase + 1
        ? {
          id: idBase + 1,
          role: 'client',
          audioUrl: clientAudioUrl,
          durationSec: estimateDurationFromAudioUrl(clientAudioUrl),
          textFallback: data.clientMessage,
          autoPlay: true,
        }
        : message));
      if (data.endConversation) {
        await finishConversation(data.session);
      } else {
        props.onSessionUpdate(data.session);
      }
    } catch (sendError) {
      setMessages((prev) => prev.filter((message) => message.id !== idBase + 1));
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
    setRecordLevels(Array.from({ length: RECORD_LEVEL_BARS }, () => 0.12));

    const durationSec = Math.max(0, Math.round((Date.now() - recordStartedAtRef.current) / 1000));
    const inputRate = audioContext?.sampleRate || 48000;
    await audioContext?.close().catch(() => {});
    audioContextRef.current = null;
    const samples = downsampleTo16k(concatFloat32(pcmChunksRef.current), inputRate);
    pcmChunksRef.current = [];
    if (samples.length < 1600 || durationSec < 1) {
      setError('Слишком короткое сообщение. Удерживайте запись хотя бы 1 секунду.');
      return;
    }
    if (float32Rms(samples) < 0.008) {
      setError('Речь почти не слышна. Проверьте микрофон и запишите ещё раз.');
      return;
    }
    const pcm = pcm16FromFloat32(samples);
    const wavBlob = wavBlobFromPcm16(pcm);
    await sendVoiceAudio({
      audioBase64: bytesToBase64(pcm),
      mimeType: 'audio/pcm;rate=16000',
      durationSec: Math.max(1, durationSec),
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
        const channel = event.inputBuffer.getChannelData(0);
        pcmChunksRef.current.push(new Float32Array(channel));
        let sum = 0;
        for (let index = 0; index < channel.length; index += 1) sum += channel[index] * channel[index];
        const rms = Math.sqrt(sum / Math.max(1, channel.length));
        const level = Math.min(1, Math.max(0.1, rms * 11));
        setRecordLevels((prev) => [...prev.slice(1), level]);
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

  function requestLeave() {
    if (ended || props.session.status !== 'in_progress') {
      props.onClose();
      return;
    }
    setLeaveConfirmOpen(true);
  }

  async function confirmLeave() {
    if (leaving) return;
    setLeaving(true);
    try {
      await props.onClose();
    } finally {
      setLeaving(false);
      setLeaveConfirmOpen(false);
    }
  }

  return (
    <section className={`train-chat-shell ${props.embedded ? 'train-chat-shell-embedded' : ''}`}>
      <header className="train-chat-header">
        <div className="train-chat-header-main">
          <div className="train-client-avatar">AI</div>
          <div className="train-chat-header-copy">
            <strong>{props.clientTitle}</strong>
            <span>{trainerSessionLabel(props.session)}</span>
          </div>
        </div>
        <button
          type="button"
          className="sa-btn-brutal-3d train-close-button"
          onClick={requestLeave}
          title="Закрыть тренировку"
          aria-label="Закрыть тренировку"
        >
          <LetsIcon name="close-round-light" size={18} strokeWidth={2} />
        </button>
      </header>
      <div className="train-chat-body">
        <div className={`train-chat-thread ${ended ? 'train-chat-thread--ended' : ''}`}>
          {messages.length === 0 ? (
            <div className="train-chat-status">Клиент подключается...</div>
          ) : (
            messages.map((message) => <AudioBubble key={message.id} message={message} />)
          )}
          {error && <div className="train-chat-error">{error}</div>}
          {ended && completionPhase === 'dialog' && (
            <div className="train-report-ready train-report-ready--status">
              <div className="train-report-ready-copy">
                <strong>Диалог завершён</strong>
                <span>Сохраняем переписку…</span>
              </div>
            </div>
          )}
          {ended && completionPhase === 'report' && (
            <div className="train-report-ready train-report-ready--status train-report-ready--generating">
              <div className="train-report-ai-icon" aria-hidden>
                <span className="train-report-ai-orbit" />
                <span className="train-report-ai-orbit train-report-ai-orbit--slow" />
                <span className="train-report-ai-core">
                  <LetsIcon name="star" size={20} strokeWidth={2} />
                </span>
              </div>
              <div className="train-report-ready-copy">
                <strong>Формируем отчёт</strong>
                <span>Разбираем реплики и собираем оценку…</span>
              </div>
            </div>
          )}
          {ended && completionPhase === 'ready' && (
            <div className="train-report-ready">
              {props.session.score != null && (
                <TrainMiniScoreGauge score={props.session.score} />
              )}
              <div className="train-report-ready-copy">
                <strong>Отчёт готов</strong>
                <span>Откройте разбор тренировки в боковой панели.</span>
              </div>
              <button type="button" className="sa-btn-brutal-3d sa-btn-sm" onClick={props.onOpenReport}>
                Открыть отчёт
              </button>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>
      {!ended && (
        <footer className={`train-recorder-bar ${recording ? 'train-recorder-bar--active' : ''}`}>
          <div className={`train-record-zone ${recording ? 'train-record-zone--live' : ''}`}>
            {recording && (
              <div className="train-record-visualizer" aria-hidden>
                {recordLevels.map((level, index) => (
                  <span
                    key={index}
                    className="train-record-visualizer-bar"
                    style={{ ['--lvl' as string]: level }}
                  />
                ))}
              </div>
            )}
            <button
              className={`train-record-button ${recording ? 'train-record-button-active' : ''}`}
              title="Записать голосовое сообщение"
              disabled={sending || leaving}
              onClick={toggleRecording}
            >
              <span className="train-record-button-core" />
              {recording && <span className="train-record-button-pulse" aria-hidden />}
            </button>
            {recording && <div className="train-record-label">Идёт запись…</div>}
          </div>
        </footer>
      )}

      <BrutalModal
        open={leaveConfirmOpen}
        nested
        hideClose
        onClose={() => { if (!leaving) setLeaveConfirmOpen(false); }}
        title="Прервать тренировку?"
        subtitle="Результаты и отчёт не сохранятся."
        width="narrow"
        footer={(
          <div className="sa-unsaved-actions">
            <button
              type="button"
              className="sa-btn-outline"
              onClick={() => setLeaveConfirmOpen(false)}
              disabled={leaving}
            >
              Остаться
            </button>
            <button
              type="button"
              className="sa-btn-danger"
              onClick={() => { void confirmLeave(); }}
              disabled={leaving}
            >
              {leaving ? 'Выходим…' : 'Выйти'}
            </button>
          </div>
        )}
      >
        {null}
      </BrutalModal>
    </section>
  );
}

export function TrainPage(props: { embedded?: boolean }) {
  const embedded = props.embedded ?? false;
  const navigate = useNavigate();
  const location = useLocation();
  const route = parseAdminPath(location.pathname);
  const selectedSessionId = route.trainerSessionId ?? null;
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<TrainerProfile | null>(null);
  const [scenarios, setScenarios] = useState<TrainerScenario[]>([]);
  const [history, setHistory] = useState<TrainerSessionSummary[]>([]);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [clientType, setClientType] = useState('random');
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [activeSession, setActiveSession] = useState<TrainerSessionSummary | null>(null);
  const [activeInitialMessage, setActiveInitialMessage] = useState<TrainerInitialMessage | null>(null);
  const [activeTranscript, setActiveTranscript] = useState<TrainerInitialMessage['transcript']>([]);
  const [activeCaseContext, setActiveCaseContext] = useState<Record<string, unknown> | null>(null);
  const [reportDrawerOpen, setReportDrawerOpen] = useState(false);
  const [reportDrawerLoading, setReportDrawerLoading] = useState(false);
  const [reportDrawerError, setReportDrawerError] = useState<string | null>(null);
  const [reportDrawerDetail, setReportDrawerDetail] = useState<AuditDetailItem | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [celebration, setCelebration] = useState<{
    phase: 'success' | 'streak';
    previousStreak: number;
    newStreak: number;
    title: string;
    showStreak: boolean;
  } | null>(null);

  const firstScenarioId = selectedScenarioId || scenarios[0]?.id || '';

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoadState('loading');
      setError(null);
    }
    try {
      const [profileData, scenarioData, historyData] = await Promise.all([
        fetchTrainerProfile(),
        fetchTrainerScenarios(),
        fetchTrainerHistory(),
      ]);
      setProfile(profileData);
      setScenarios(scenarioData);
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
    if (selectedSessionId) return;
    const hasPendingEvaluation = history.some((item) => (
      (item.status === 'completed' || item.status === 'failed')
      && item.score == null
      && !item.reportReady
    ));
    if (!hasPendingEvaluation) return;
    const timer = window.setInterval(() => {
      void load({ silent: true });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [history, load, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setActiveSession(null);
      setActiveInitialMessage(null);
      setActiveTranscript([]);
      setActiveCaseContext(null);
      setError(null);
      return;
    }
    let cancelled = false;
    async function loadSelectedSession() {
      setBusy(true);
      setError(null);
      try {
        const startedAt = Date.now();
        while (!cancelled) {
          const dialog = await fetchTrainerDialog(selectedSessionId as string);
          if (cancelled) return;
          setActiveSession(dialog.session);
          setActiveCaseContext(dialog.caseContext);
          setActiveInitialMessage(null);
          setActiveTranscript(dialog.transcript);
          const hasMessages = dialog.transcript.length > 0;
          const ended = dialog.session.status !== 'in_progress';
          if (hasMessages || ended || Date.now() - startedAt > 90_000) {
            break;
          }
          // Show chat shell while first client voice is still generating.
          setBusy(false);
          await new Promise((resolve) => window.setTimeout(resolve, 700));
        }
      } catch (selectedError) {
        if (!cancelled) setError(selectedError instanceof Error ? selectedError.message : 'Не удалось открыть тренировку.');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void loadSelectedSession();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

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
      setActiveInitialMessage(null);
      setActiveTranscript([]);
      setActiveCaseContext(data.caseContext);
      setNewSessionOpen(false);
      navigate(buildTrainerSessionPath(data.session.id));
      void load({ silent: true });
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Не удалось начать тренировку.');
    } finally {
      setBusy(false);
    }
  }

  function closeReportDrawer() {
    setReportDrawerOpen(false);
    setReportDrawerError(null);
    setReportDrawerDetail(null);
    setReportDrawerLoading(false);
  }

  async function openReport(id: string) {
    setReportDrawerOpen(true);
    setReportDrawerLoading(true);
    setReportDrawerError(null);
    setReportDrawerDetail(null);
    try {
      const detail = await fetchTrainerAuditDetail(id);
      setReportDrawerDetail(detail);
    } catch (reportError) {
      setReportDrawerError(reportError instanceof Error ? reportError.message : 'Не удалось открыть отчёт.');
    } finally {
      setReportDrawerLoading(false);
    }
  }

  const rootClassName = [
    'train-app',
    'theme-brutal',
    embedded ? 'train-app-embedded' : '',
    selectedSessionId ? 'train-app--session' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClassName}>
      {loadState === 'loading' ? (
        <div className="train-loading">Загрузка...</div>
      ) : loadState === 'error' ? (
        <div className="train-error">
          <strong>{error}</strong>
          <button type="button" className="sa-btn-brutal-3d" onClick={load}>Повторить</button>
        </div>
      ) : selectedSessionId ? (
        <div className="train-session-wrap">
          {busy && !activeSession ? (
            <div className="train-session-loading">Загрузка тренировки…</div>
          ) : activeSession ? (
            <SessionPreview
              session={activeSession}
              initialMessage={activeInitialMessage}
              transcript={activeTranscript}
              clientTitle={clientProfileTitle(activeCaseContext)}
              embedded
              onOpenReport={() => { void openReport(activeSession.id); }}
              onClose={async () => {
                if (activeSession?.status === 'in_progress') {
                  try {
                    await abandonTrainerSession(activeSession.id);
                  } catch {
                    // ignore — user is leaving anyway
                  }
                }
                await load({ silent: true });
                navigate(buildTrainerSessionPath());
              }}
              onSessionUpdate={(session) => {
                setActiveSession(session);
              }}
              onSessionFinished={async (session) => {
                if (session.status === 'failed') {
                  await load({ silent: true });
                  void openReport(session.id);
                  return;
                }
                const previousStreak = profile?.currentStreak ?? 0;
                const wasFirstOfDay = profile?.lastActiveDate !== localPlanDate();
                await load({ silent: true });
                const freshProfile = await fetchTrainerProfile();
                setProfile(freshProfile);
                setCelebration({
                  phase: 'success',
                  previousStreak,
                  newStreak: freshProfile.currentStreak,
                  title: trainerSessionLabel(session),
                  showStreak: wasFirstOfDay,
                });
              }}
            />
          ) : error ? (
            <div className="train-session-loading">
              <p>{error}</p>
              <button type="button" className="sa-btn-brutal-3d" onClick={() => navigate(buildTrainerSessionPath())}>
                К тренажёру
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <TrainerHub
          profile={profile}
          history={history}
          busy={busy}
          error={error}
          canStartFree={Boolean(firstScenarioId)}
          onNewSession={() => setNewSessionOpen(true)}
          onOpenSession={(sessionId) => navigate(buildTrainerSessionPath(sessionId))}
          onOpenReport={(sessionId) => { void openReport(sessionId); }}
        />
      )}

      {celebration?.phase === 'success' && (
        <TrainerSuccessCelebration
          title={celebration.title}
          onClose={() => {
            if (celebration.showStreak) {
              setCelebration({ ...celebration, phase: 'streak' });
              return;
            }
            setCelebration(null);
          }}
        />
      )}
      {celebration?.phase === 'streak' && (
        <TrainerStreakCelebration
          previousStreak={celebration.previousStreak}
          newStreak={celebration.newStreak}
          onClose={() => setCelebration(null)}
        />
      )}
      <ReportDrawer
        open={reportDrawerOpen}
        detail={reportDrawerDetail}
        loading={reportDrawerLoading}
        error={reportDrawerError}
        onClose={closeReportDrawer}
      />
      <NewSessionModal
        open={newSessionOpen}
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
    </div>
  );
}
