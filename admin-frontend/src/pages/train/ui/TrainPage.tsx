import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import {
  abandonTrainerSession,
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
import { buildTrainerSessionPath, parseAdminPath } from '../../../shared/routing/adminRoutes';
import { BrutalSelect } from '../../../shared/ui/BrutalSelect';
import { LetsIcon } from '../../../shared/ui/icons/LetsIcon';
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

function trainerScoreClass(score: number): 'sa-score-green' | 'sa-score-orange' | 'sa-score-red' {
  if (score >= 76) return 'sa-score-green';
  if (score >= 50) return 'sa-score-orange';
  return 'sa-score-red';
}

function planQuestLabel(status: string): string {
  if (status === 'completed') return 'Выполнено';
  if (status === 'in_progress') return 'В процессе';
  if (status === 'failed') return 'Не пройдено';
  return 'Доступно';
}

const VOICE_BAR_COUNT = 28;
const RECORD_LEVEL_BARS = 16;

function TrainerDoneCircle(props: { size: 'plan' | 'quest' }) {
  const iconSize = props.size === 'plan' ? 20 : 22;
  return (
    <span className={`train-hub-status-circle train-hub-status-circle--done train-hub-status-circle--${props.size}`} aria-hidden>
      <LetsIcon name="done-light" size={iconSize} strokeWidth={2} />
    </span>
  );
}

function TrainerFailedCircle(props: { size: 'plan' | 'quest' }) {
  const iconSize = props.size === 'plan' ? 20 : 22;
  return (
    <span className={`train-hub-status-circle train-hub-status-circle--failed train-hub-status-circle--${props.size}`} aria-hidden>
      <LetsIcon name="close-round-light" size={iconSize} strokeWidth={2} />
    </span>
  );
}

function buildSequentialPlanDotStates(items: TrainerPlanItem[], total: number): Array<'empty' | 'done' | 'failed'> {
  const dots: Array<'empty' | 'done' | 'failed'> = Array.from({ length: total }, () => 'empty');
  const resolved = items
    .filter((item) => item.status === 'completed' || item.status === 'failed')
    .sort((left, right) => {
      const leftTime = left.completedAt ? Date.parse(left.completedAt) : Number.MAX_SAFE_INTEGER;
      const rightTime = right.completedAt ? Date.parse(right.completedAt) : Number.MAX_SAFE_INTEGER;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return 0;
    });

  let withoutTimestamp = 0;
  resolved.forEach((item, index) => {
    if (index >= total) return;
    if (!item.completedAt) withoutTimestamp += 1;
    dots[index] = item.status === 'completed' ? 'done' : 'failed';
  });

  if (withoutTimestamp === resolved.length && resolved.length > 0) {
    const states: Array<'done' | 'failed'> = [];
    items.forEach((item) => {
      if (item.status === 'completed') states.push('done');
    });
    items.forEach((item) => {
      if (item.status === 'failed') states.push('failed');
    });
    for (let index = 0; index < Math.min(total, states.length); index += 1) {
      dots[index] = states[index];
    }
  }

  return dots;
}

function TrainerProgressDots(props: {
  items: TrainerPlanItem[];
  fallbackTotal?: number;
  size?: 'md' | 'lg';
}) {
  const sourceItems = props.items.length > 0
    ? props.items
    : Array.from({ length: props.fallbackTotal ?? 3 }, (_, index) => ({
      id: `placeholder-${index}`,
      scenarioId: null,
      scenarioName: '',
      status: 'not_started',
      trainerSessionId: null,
    }));
  const completed = sourceItems.filter((item) => item.status === 'completed').length;
  const total = sourceItems.length;
  const dotStates = buildSequentialPlanDotStates(sourceItems, total);
  const sizeClass = props.size === 'lg' ? 'train-hub-dots--lg' : 'train-hub-dots--md';

  return (
    <div className={`train-hub-dots ${sizeClass}`} role="img" aria-label={`${completed} из ${total} выполнено`}>
      {dotStates.map((state, index) => {
        if (state === 'done') {
          return props.size === 'lg'
            ? <TrainerDoneCircle key={sourceItems[index]?.id || index} size="plan" />
            : <span key={sourceItems[index]?.id || index} className="train-hub-dot train-hub-dot--done" />;
        }

        if (state === 'failed') {
          return props.size === 'lg'
            ? <TrainerFailedCircle key={sourceItems[index]?.id || index} size="plan" />
            : <span key={sourceItems[index]?.id || index} className="train-hub-dot train-hub-dot--failed" />;
        }

        return (
          <span key={sourceItems[index]?.id || index} className="train-hub-dot train-hub-dot--empty" />
        );
      })}
    </div>
  );
}

function TrainerStatCard(props: { label: string; value: React.ReactNode; hint?: string; game?: boolean }) {
  return (
    <div className={`sa-card sa-kpi-card sa-kpi-card-air sa-brutal-card train-hub-stat-card ${props.game ? 'train-hub-stat-card--game' : ''}`}>
      <div className="sa-kpi-card-top">
        <div className="sa-kpi-card-heading">{props.label}</div>
      </div>
      <div className="sa-kpi-card-spacer" aria-hidden />
      <div className="sa-kpi-card-bottom">
        <div className={props.game ? 'train-hub-stat-game-value' : 'sa-kpi-value sa-kpi-value-large'}>{props.value}</div>
        {props.hint && <div className="sa-kpi-desc">{props.hint}</div>}
      </div>
    </div>
  );
}

function TrainerQuestCard(props: {
  item: TrainerPlanItem;
  index: number;
  busy: boolean;
  onStart: (item: TrainerPlanItem) => void;
  onContinue: (sessionId: string) => void;
}) {
  const { item, index } = props;
  const isDone = item.status === 'completed';
  const isFailed = item.status === 'failed';
  const isActive = item.status === 'in_progress';
  const canStart = !isDone && !isFailed && !isActive;

  const handleClick = () => {
    if (isActive && item.trainerSessionId) {
      props.onContinue(item.trainerSessionId);
      return;
    }
    if (canStart) props.onStart(item);
  };

  return (
    <article
      className={`train-hub-quest train-hub-quest--${item.status || 'not_started'}`}
      style={{ animationDelay: `${props.index * 60}ms` }}
    >
      <div className="train-hub-quest-index">
        {isDone ? <TrainerDoneCircle size="quest" /> : isFailed ? <TrainerFailedCircle size="quest" /> : index + 1}
      </div>
      <div className="train-hub-quest-body">
        <div className="train-hub-quest-title">{item.scenarioName || 'Сценарий'}</div>
        <div className="train-hub-quest-meta">{planQuestLabel(item.status)}</div>
      </div>
      {!isDone && !isFailed && (
        <button
          type="button"
          className="sa-btn-brutal-3d train-hub-quest-action"
          disabled={props.busy}
          onClick={handleClick}
        >
          {isActive ? 'Продолжить' : 'Начать'}
        </button>
      )}
      {(isDone || isFailed) && (
        <span className={`train-hub-quest-badge ${isDone ? 'sa-score-green' : 'sa-score-red'}`}>
          {planQuestLabel(item.status)}
        </span>
      )}
    </article>
  );
}

function TrainerHub(props: {
  profile: TrainerProfile | null;
  planItems: TrainerPlanItem[];
  history: TrainerSessionSummary[];
  completedPlanCount: number;
  busy: boolean;
  error: string | null;
  canStartFree: boolean;
  onNewSession: () => void;
  onStartPlan: (item: TrainerPlanItem) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const planTotal = props.planItems.length || 3;

  return (
    <div className="train-hub sa-page-enter">
      <header className="train-hub-block train-hub-header">
        <div>
          <h1 className="sa-page-title train-hub-title">Тренажёр</h1>
          <p className="train-hub-subtitle">
            {props.profile
              ? `${props.profile.branchName}${props.profile.city ? `, ${props.profile.city}` : ''} · ${props.profile.companyName}`
              : 'Тренировка диалога с виртуальным клиентом'}
          </p>
        </div>
        <button
          type="button"
          className="sa-btn-brutal-3d train-hub-new-btn"
          disabled={props.busy || !props.canStartFree}
          onClick={props.onNewSession}
        >
          <LetsIcon name="add-light" size={16} bold />
          Новая тренировка
        </button>
      </header>

      {props.error && (
        <div className="train-hub-block train-hub-error" role="alert">{props.error}</div>
      )}

      <div className="train-hub-block sa-kpi-grid train-hub-stats">
        <TrainerStatCard
          label="Стрик"
          value={props.profile?.currentStreak ?? 0}
          hint={`Рекорд ${props.profile?.longestStreak ?? 0} дн.`}
        />
        <TrainerStatCard
          label="AI-баллы"
          value={props.profile?.totalPoints ?? 0}
          hint="За всё время"
        />
        <TrainerStatCard
          label="Сессии за 30 дней"
          value={props.profile?.sessions30d ?? 0}
          hint={`${props.profile?.sessionsTotal ?? 0} всего`}
        />
        <TrainerStatCard
          label="План дня"
          game
          value={(
            <TrainerProgressDots
              items={props.planItems}
              fallbackTotal={3}
              size="lg"
            />
          )}
          hint={`${props.completedPlanCount} из ${planTotal} выполнено`}
        />
      </div>

      <section className="train-hub-block train-hub-section">
        <div className="train-hub-section-head">
          <h2 className="train-hub-section-title">Задачи на день</h2>
        </div>
        {props.planItems.length === 0 ? (
          <p className="train-hub-empty">На сегодня задач пока нет. Запустите свободную тренировку.</p>
        ) : (
          <div className="train-hub-quests">
            {props.planItems.map((item, index) => (
              <TrainerQuestCard
                key={item.id}
                item={item}
                index={index}
                busy={props.busy}
                onStart={props.onStartPlan}
                onContinue={props.onOpenSession}
              />
            ))}
          </div>
        )}
      </section>

      <section className="train-hub-block train-hub-section">
        <div className="train-hub-section-head">
          <h2 className="train-hub-section-title">История тренировок</h2>
        </div>
        {props.history.length === 0 ? (
          <p className="train-hub-empty">История появится после первой тренировки.</p>
        ) : (
          <div className="train-hub-panel sa-companies-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Сценарий</th>
                  <th>Дата</th>
                  <th>Тип</th>
                  <th>Оценка</th>
                  <th>Балл</th>
                </tr>
              </thead>
              <tbody>
                {props.history.map((item) => {
                  const score = item.score;
                  const qualityTag = trainerQualityTag(score);
                  return (
                    <tr
                      key={item.id}
                      className="sa-row-clickable"
                      onClick={() => props.onOpenSession(item.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          props.onOpenSession(item.id);
                        }
                      }}
                    >
                      <td>{item.scenarioName || 'Тренировка'}</td>
                      <td className="sa-meta">{formatDateShort(item.completedAt || item.startedAt)}</td>
                      <td>{item.type === 'plan' ? 'План' : 'Свободная'}</td>
                      <td>
                        {qualityTag ? (
                          <span className={trainerScoreClass(score ?? 0)}>{qualityTag}</span>
                        ) : (
                          <span className="sa-meta">—</span>
                        )}
                      </td>
                      <td>
                        {score != null ? (
                          <span className={`sa-kpi-value ${trainerScoreClass(score)}`}>{score.toFixed(0)}</span>
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
        )}
      </section>
    </div>
  );
}

function TrainerStreakCelebration(props: {
  previousStreak: number;
  newStreak: number;
  scenarioName: string;
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
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(startDelay);
      if (tick) window.clearInterval(tick);
    };
  }, [props.previousStreak, props.newStreak]);

  return (
    <div className="train-streak-celebration-backdrop" role="dialog" aria-modal aria-labelledby="train-streak-title">
      <section className="train-streak-celebration">
        <div className="train-streak-celebration-confetti" aria-hidden>
          {Array.from({ length: 12 }).map((_, index) => (
            <span key={index} className="train-streak-confetti-piece" style={{ ['--i' as string]: index }} />
          ))}
        </div>
        <div className="train-streak-celebration-kicker">Поздравляем!</div>
        <h2 id="train-streak-title" className="train-streak-celebration-title">Диалог завершён</h2>
        <p className="train-streak-celebration-scenario">{props.scenarioName}</p>
        <div className={`train-streak-celebration-streak ${popped ? 'train-streak-celebration-streak--pop' : ''}`}>
          <span className="train-streak-celebration-label">Стрик</span>
          <span className="train-streak-celebration-value" key={displayStreak}>{displayStreak}</span>
          <span className="train-streak-celebration-unit">дн.</span>
        </div>
        <p className="train-streak-celebration-hint">Продолжайте в том же духе — завтра стрик может вырасти ещё</p>
        <button type="button" className="sa-btn-brutal-3d train-streak-celebration-btn" onClick={props.onClose}>
          Отлично!
        </button>
      </section>
    </div>
  );
}

function TrainModalBackdrop(props: { children: React.ReactNode; onClose: () => void }) {
  return createPortal(
    <div className="train-modal-backdrop" onClick={props.onClose} role="presentation">
      {props.children}
    </div>,
    document.body,
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
    <TrainModalBackdrop onClose={props.onClose}>
      <section className="train-new-modal" onClick={(event) => event.stopPropagation()}>
        <header className="train-report-header">
          <div>
            <div className="train-report-kicker">Новая тренировка</div>
            <h2>Свободная тренировка</h2>
          </div>
          <button type="button" className="sa-btn-brutal-3d train-close-button" onClick={props.onClose}>×</button>
        </header>
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
        <button type="button" className="sa-btn-brutal-3d train-modal-submit" disabled={props.busy || !props.scenarioId} onClick={props.onStart}>
          Начать тренировку
        </button>
      </section>
    </TrainModalBackdrop>
  );
}

function ReportPanel(props: { report: TrainerReport; onClose: () => void }) {
  const recommendations = props.report.topRecommendations.slice(0, 3).map((item) => {
    if (typeof item === 'string') return item;
    return String(item.title || item.recommendation || item.description || 'Рекомендация');
  });
  const checklist = props.report.checklist.slice(0, 6);
  return (
    <TrainModalBackdrop onClose={props.onClose}>
      <section className="train-report train-report-modal" onClick={(event) => event.stopPropagation()}>
        <header className="train-report-header">
          <div>
            <div className="train-report-kicker">{props.report.type === 'plan' ? 'План дня' : 'Свободная тренировка'}</div>
            <h2>{props.report.scenarioName}</h2>
          </div>
          <button type="button" className="sa-btn-brutal-3d train-close-button" onClick={props.onClose}>×</button>
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
    </TrainModalBackdrop>
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
    <section className="train-inline-report train-audit-report train-audit-report-brutal sa-page-enter">
      <div className="train-report-complete-banner">Сессия завершена</div>
      <div className="sa-card sa-brutal-card sa-audit-summary train-report-summary-card">
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
        <div className="sa-card sa-brutal-card sa-kpi-card train-report-kpi-card">
          <div className="sa-kpi-label">Общий балл</div>
          <div className={`sa-kpi-value ${ratingClass(score)}`}>{score}</div>
        </div>
        <div className="sa-card sa-brutal-card sa-kpi-card train-report-kpi-card">
          <div className="sa-kpi-label">Очки</div>
          <div className="sa-kpi-value">{props.report.finalPoints ?? 0}</div>
        </div>
        <div className="sa-card sa-brutal-card sa-kpi-card train-report-kpi-card">
          <div className="sa-kpi-label">Да / Частично / Нет</div>
          <div className="sa-kpi-value">{checklistStats.pass}/{checklistStats.warn}/{checklistStats.fail}</div>
        </div>
      </div>

      {dimensions.length > 0 && (
        <div className="sa-card sa-brutal-card train-report-block-card">
          <div className="sa-chart-wrap">
            <h3 className="sa-chart-title">Оценка по блокам</h3>
            <div className="sa-hbar-list">
              {dimensions.map((item) => (
                <div className="sa-hbar-row" key={item.label}>
                  <span className="sa-hbar-label">{item.label}</span>
                  <div className="sa-hbar-track">
                    <div className="sa-hbar-fill" style={{ width: `${item.score}%`, background: item.score >= 80 ? 'var(--tb-status-green)' : item.score >= 50 ? 'var(--tb-status-orange)' : 'var(--tb-status-red)' }} />
                  </div>
                  <span className={`sa-hbar-score ${ratingClass(item.score)}`}>{item.score}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="sa-card sa-brutal-card train-report-block-card">
        <h3 className="sa-card-heading train-report-section-title">Чек-лист</h3>
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

      <div className="sa-detail-insights train-report-insights">
        <div className="sa-card sa-brutal-card train-report-block-card" style={{ flex: 1 }}>
          <h3 className="sa-card-heading train-report-section-title">ТОП-ошибки</h3>
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
        <div className="sa-card sa-brutal-card train-report-block-card" style={{ flex: 1 }}>
          <h3 className="sa-card-heading train-report-section-title">Рекомендации</h3>
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
  const waveform = useVoiceWaveform(
    props.message.audioUrl,
    VOICE_BAR_COUNT,
    `${props.message.id}:${props.message.audioUrl || props.message.textFallback || ''}`,
  );
  useEffect(() => {
    if (!props.message.autoPlay || !audioRef.current) return;
    audioRef.current.play().catch(() => {});
  }, [props.message.autoPlay]);
  const durationLabel = props.message.durationSec
    ? `0:${String(Math.min(59, props.message.durationSec)).padStart(2, '0')}`
    : '0:00';
  const filledBars = Math.round((progress / 100) * VOICE_BAR_COUNT);
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
  const [recordLevels, setRecordLevels] = useState<number[]>(() => Array.from({ length: RECORD_LEVEL_BARS }, () => 0.12));
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
    setRecordLevels(Array.from({ length: RECORD_LEVEL_BARS }, () => 0.12));
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
    setRecordLevels(Array.from({ length: RECORD_LEVEL_BARS }, () => 0.12));

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

  return (
    <section className={`train-chat-shell ${props.embedded ? 'train-chat-shell-embedded' : ''}`}>
      <header className="train-chat-header">
        <button type="button" className="sa-btn-brutal-3d train-back-button" onClick={props.onClose} title="К тренажёру" aria-label="К тренажёру">←</button>
        <div className="train-client-avatar">AI</div>
        <div>
          <strong>{props.clientTitle}</strong>
          <span>{props.session.scenarioName}</span>
        </div>
      </header>
      <div className="train-chat-body">
          <div className={`train-chat-thread ${ended ? 'train-chat-thread--ended' : ''}`}>
          {messages.length === 0 ? (
            <div className="train-chat-status">Клиент подключается...</div>
          ) : (
            messages.map((message) => <AudioBubble key={message.id} message={message} />)
          )}
          {sending && <div className="train-chat-status">Клиент отвечает...</div>}
          {error && <div className="train-chat-error">{error}</div>}
          {ended && !props.report && <div className="train-chat-status">Сессия завершена. Отчёт появится в истории.</div>}
          {ended && props.report && <InlineSessionAnalytics report={props.report} />}
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
              disabled={sending}
              onClick={toggleRecording}
            >
              <span className="train-record-button-core" />
              {recording && <span className="train-record-button-pulse" aria-hidden />}
            </button>
            {recording && <div className="train-record-label">Идёт запись…</div>}
          </div>
        </footer>
      )}
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
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [streakCelebration, setStreakCelebration] = useState<{
    previousStreak: number;
    newStreak: number;
    scenarioName: string;
  } | null>(null);

  const completedPlanCount = useMemo(() => planItems.filter((item) => item.status === 'completed').length, [planItems]);
  const firstScenarioId = selectedScenarioId || scenarios[0]?.id || '';

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
      setError(null);
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
      navigate(buildTrainerSessionPath(data.session.id));
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
      navigate(buildTrainerSessionPath(data.session.id));
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

  const rootClassName = `train-app theme-brutal${embedded ? ' train-app-embedded' : ''}`;

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
              report={activeReport}
              clientTitle={clientProfileTitle(activeCaseContext)}
              embedded
              onClose={async () => {
                if (activeSession?.status === 'in_progress') {
                  try {
                    await abandonTrainerSession(activeSession.id);
                    await load({ silent: true });
                  } catch {
                    // ignore — user is leaving anyway
                  }
                }
                navigate(buildTrainerSessionPath());
              }}
              onSessionUpdate={async (session) => {
                setActiveSession(session);
                if (session.status === 'completed' || session.status === 'failed') {
                  const previousStreak = profile?.currentStreak ?? 0;

                  await load({ silent: true });
                  if (session.status === 'failed') {
                    setActiveReport(await fetchTrainerReport(session.id));
                    return;
                  }

                  setActiveReport(await fetchTrainerReport(session.id));
                  const freshProfile = await fetchTrainerProfile();
                  setProfile(freshProfile);
                  setStreakCelebration({
                    previousStreak,
                    newStreak: freshProfile.currentStreak,
                    scenarioName: session.scenarioName || 'Тренировка',
                  });
                }
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
          planItems={planItems}
          history={history}
          completedPlanCount={completedPlanCount}
          busy={busy}
          error={error}
          canStartFree={Boolean(firstScenarioId)}
          onNewSession={() => setNewSessionOpen(true)}
          onStartPlan={startPlan}
          onOpenSession={(sessionId) => navigate(buildTrainerSessionPath(sessionId))}
        />
      )}

      {streakCelebration && (
        <TrainerStreakCelebration
          previousStreak={streakCelebration.previousStreak}
          newStreak={streakCelebration.newStreak}
          scenarioName={streakCelebration.scenarioName}
          onClose={() => setStreakCelebration(null)}
        />
      )}
      {report && <ReportPanel report={report} onClose={() => setReport(null)} />}
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
    </div>
  );
}
