import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchTrainerHistory,
  fetchTrainerProfile,
  type TrainerProfile,
  type TrainerSessionSummary,
} from '../../../shared/api/trainer';
import { ratingClass, scoreBarColor } from '../../../shared/lib/admin-panel/utils';
import { BrutalCard } from '../../../shared/ui/brutal-card';
import {
  Card,
  CardBody,
  Button,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
} from '@heroui/react';

const API_BASE = '';

type TrainingMessage = {
  id: number;
  role: 'client' | 'manager';
  audioUrl: string | null;
  textFallback?: string;
  durationSec?: number;
  autoPlay?: boolean;
};

type WebTestResult = {
  verdict: 'pass' | 'fail';
  totalScore: number;
  qualityTag: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  reasonCode: string | null;
};

type WebTestHistoryItem = {
  id: string;
  sessionId: string | null;
  createdAt: string;
  status: 'unfinished' | 'completed';
  turns: number;
  result?: WebTestResult | null;
};

const STAFF_WEB_HISTORY_STORAGE_KEY = 'staff_web_test_history_v1';

function trainerQualityTag(score: number | null) {
  if (score == null) return null;
  if (score >= 85) return 'Отлично';
  if (score >= 76) return 'Хорошо';
  if (score >= 50) return 'Средне';
  return 'Нужно улучшить';
}

function trainerFailureReasonLabel(reason: string | null | undefined) {
  if (!reason) return null;
  const base = reason.split(':')[0];
  const labels: Record<string, string> = {
    PROFANITY: 'Недопустимая лексика',
    BAD_TONE: 'Грубый / враждебный тон',
    IGNORED_QUESTIONS: 'Игнорирование вопросов клиента',
    POOR_COMMUNICATION: 'Низкое качество коммуникации',
    REPEATED_LOW_EFFORT: 'Повторные некачественные ответы',
    REPEATED_LOW_QUALITY: 'Повторные некачественные/формальные ответы',
    DISENGAGEMENT: 'Менеджер завершил коммуникацию / отказался от диалога',
    rude_language: 'Недопустимая лексика',
    ignored_questions: 'Игнорирование вопросов клиента',
    poor_communication: 'Низкое качество коммуникации',
    repeated_low_effort: 'Повторные некачественные ответы',
    repeated_low_quality: 'Повторные некачественные/формальные ответы',
    disengagement: 'Менеджер завершил коммуникацию / отказался от диалога',
  };
  if (labels[base]) return labels[base];
  if (base === 'CRITICAL_EVASION' || base === 'critical_evasion') {
    const topic = reason.split(':')[1] ?? '';
    return topic ? `Критический вопрос проигнорирован (${topic})` : 'Критический вопрос проигнорирован';
  }
  return 'Тренировка досрочно завершена';
}

function staffScoreClass(score: number): 'sa-score-green' | 'sa-score-orange' | 'sa-score-red' {
  if (score >= 76) return 'sa-score-green';
  if (score >= 50) return 'sa-score-orange';
  return 'sa-score-red';
}

function StaffScoreTrendChart(props: {
  points: Array<{ date: string; avgScore: number; count: number }>;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const points = props.points;
  if (points.length === 0) return null;

  const W = 960;
  const H = 168;
  const pad = { top: 16, right: 20, bottom: 28, left: 36 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const step = points.length <= 1 ? 0 : cw / (points.length - 1);
  const xs = points.map((_, i) => pad.left + i * step);
  const ys = points.map((p) => pad.top + ch - (Math.max(0, Math.min(100, p.avgScore)) / 100) * ch);
  const pathD = points.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${ys[i]}`).join(' ');
  const stroke = 'var(--tb-ink)';

  return (
    <div className="sa-chart-wrap sa-chart-wrap-full sa-staff-trend-chart">
      <div className="sa-chart-plot">
        <svg
          className="sa-trend-chart-svg"
          width="100%"
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="staffTrendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.14" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0, 25, 50, 75, 100].map((v) => {
            const y = pad.top + ch - (v / 100) * ch;
            return (
              <g key={v}>
                <line x1={pad.left} y1={y} x2={pad.left + cw} y2={y} stroke="var(--sa-divider)" strokeWidth="1" strokeDasharray="4" />
                <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--sa-text-secondary)">{v}</text>
              </g>
            );
          })}
          {points.map((p, i) => (
            <text key={`${p.date}-${i}`} x={xs[i]} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--sa-text-secondary)">
              {p.date.slice(5)}
            </text>
          ))}
          <path d={`${pathD} L ${xs[xs.length - 1]} ${pad.top + ch} L ${xs[0]} ${pad.top + ch} Z`} fill="url(#staffTrendFill)" />
          <path d={pathD} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {points.map((_, i) => (
            <rect
              key={`h-${i}`}
              x={xs[i] - (step || 40) / 2}
              y={pad.top}
              width={step || 40}
              height={ch}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
            />
          ))}
          {hoverIdx !== null && (
            <line
              x1={xs[hoverIdx]}
              y1={pad.top}
              x2={xs[hoverIdx]}
              y2={pad.top + ch}
              stroke="var(--sa-text-secondary)"
              strokeWidth="1"
              strokeDasharray="3"
              opacity="0.4"
            />
          )}
          {points.map((p, i) => (
            <circle
              key={`${p.date}-dot-${i}`}
              cx={xs[i]}
              cy={ys[i]}
              r={hoverIdx === i ? 5.5 : 4}
              fill={hoverIdx === i ? '#fff' : stroke}
              stroke={stroke}
              strokeWidth={hoverIdx === i ? 2.5 : 0}
              style={{ transition: 'r .15s, fill .15s', cursor: 'pointer' }}
            />
          ))}
        </svg>
        {hoverIdx !== null && (() => {
          const p = points[hoverIdx];
          const leftPct = (xs[hoverIdx] / W) * 100;
          const topPct = (ys[hoverIdx] / H) * 100;
          const placeBelow = topPct < 28;
          return (
            <div
              className={`sa-chart-hover-tooltip${placeBelow ? ' sa-chart-hover-tooltip-below' : ''}`}
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            >
              <div className="sa-chart-hover-tooltip-row">Дата: {p.date}</div>
              <div className="sa-chart-hover-tooltip-row is-strong">Балл: {p.avgScore.toFixed(0)}</div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function StaffProfileKpi(props: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="sa-card sa-kpi-card sa-kpi-card-air sa-brutal-card sa-staff-kpi-card">
      <div className="sa-kpi-card-top">
        <div className="sa-kpi-card-heading">{props.label}</div>
      </div>
      <div className="sa-kpi-card-spacer" aria-hidden />
      <div className="sa-kpi-card-bottom">
        <div className={`sa-kpi-value sa-kpi-value-large ${props.valueClass ?? ''}`.trim()}>{props.value}</div>
        {props.hint ? <div className="sa-kpi-desc">{props.hint}</div> : null}
      </div>
    </div>
  );
}

/* ================================================================
   Profile page (statistics)
   ================================================================ */

export function StaffProfileContent() {
  const [profile, setProfile] = useState<TrainerProfile | null>(null);
  const [history, setHistory] = useState<TrainerSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([fetchTrainerProfile(), fetchTrainerHistory()])
      .then(([nextProfile, nextHistory]) => {
        if (cancelled) return;
        setProfile(nextProfile);
        setHistory(nextHistory);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setProfile(null);
        setHistory([]);
        setError(e?.message || 'Не удалось загрузить профиль.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const completedHistory = useMemo(
    () => history.filter((item) => item.status === 'completed' || item.status === 'failed'),
    [history],
  );
  const scoredHistory = useMemo(
    () => completedHistory.filter((item) => item.score != null),
    [completedHistory],
  );
  const stats = useMemo(() => {
    const scores = scoredHistory.map((item) => Number(item.score));
    const avgScore = profile?.avgScore ?? (scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0);
    const fallbackTrend = [...scoredHistory]
      .slice(0, 10)
      .reverse()
      .map((item) => ({
        date: (item.completedAt || item.startedAt || '').slice(0, 10),
        avgScore: Math.round(Number(item.score)),
        count: 1,
      }))
      .filter((item) => item.date);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const testsLast7d = profile?.testsLast7d ?? completedHistory.filter((item) => {
      const stamp = Date.parse(item.completedAt || item.startedAt || '');
      return Number.isFinite(stamp) && stamp >= weekAgo;
    }).length;
    const categoryScores = profile?.categoryScores ?? [
      { name: 'Контакт', score: 0, comment: 'Нет данных из тренажёра.', hint: 'Нет данных по категории «Контакт»' },
      { name: 'Диагностика', score: 0, comment: 'Нет данных из тренажёра.', hint: 'Нет данных по категории «Диагностика»' },
      { name: 'Продукт', score: 0, comment: 'Нет данных из тренажёра.', hint: 'Нет данных по категории «Продукт»' },
      { name: 'Закрытие', score: 0, comment: 'Нет данных из тренажёра.', hint: 'Нет данных по категории «Закрытие»' },
      { name: 'Коммуникация', score: 0, comment: 'Нет данных из тренажёра.', hint: 'Нет данных по категории «Коммуникация»' },
    ];
    return {
      avgScore,
      testsLast7d,
      sessions30d: profile?.sessions30d ?? 0,
      sessionsTotal: profile?.sessionsTotal ?? completedHistory.length,
      currentStreak: profile?.currentStreak ?? 0,
      longestStreak: profile?.longestStreak ?? 0,
      totalPoints: profile?.totalPoints ?? 0,
      categoryScores,
      scoreTrend: (profile?.scoreTrend && profile.scoreTrend.length > 0) ? profile.scoreTrend : fallbackTrend,
    };
  }, [completedHistory, profile, scoredHistory]);

  const locationLabel = profile
    ? [profile.branchName, profile.city].filter(Boolean).join(', ')
    : null;

  return (
    <div className="sa-staff-profile-root sa-page-enter">
      {error && (
        <div className="sa-staff-profile-error" role="alert">
          {error}
        </div>
      )}

      <header className="sa-staff-profile-header">
        <div className="sa-staff-profile-intro">
          <h1 className="sa-page-title sa-staff-profile-title">
            {loading ? 'Загрузка…' : profile?.fullName ?? 'Профиль не найден'}
          </h1>
          <p className="sa-staff-profile-meta">
            {profile
              ? `${locationLabel ? `${locationLabel} · ` : ''}${profile.companyName}`
              : 'Нет данных о сотруднике'}
          </p>
        </div>
      </header>

      <section className="sa-section sa-staff-profile-section">
        <h2 className="sa-section-title">Ключевые метрики</h2>
        <div className="sa-kpi-grid sa-staff-kpi-grid">
          <StaffProfileKpi
            label="Средний балл"
            value={stats.avgScore ? stats.avgScore.toFixed(1) : '—'}
            hint="По всем тренировкам"
            valueClass={stats.avgScore ? staffScoreClass(stats.avgScore) : undefined}
          />
          <StaffProfileKpi
            label="Стрик"
            value={String(stats.currentStreak)}
            hint={`Рекорд ${stats.longestStreak} дн.`}
          />
          <StaffProfileKpi
            label="AI-баллы"
            value={String(stats.totalPoints)}
            hint="За всё время"
          />
          <StaffProfileKpi
            label="Сессии"
            value={String(stats.sessions30d)}
            hint={`${stats.testsLast7d} за 7 дней`}
          />
        </div>
      </section>

      <section className="sa-section sa-staff-profile-section">
        <h2 className="sa-section-title">Навыки по категориям</h2>
        <div className="sa-card sa-brutal-card sa-staff-skills-card">
          <div className="sa-brutal-card-body">
            {stats.categoryScores.every((item) => item.score === 0) && scoredHistory.length === 0 ? (
              <p className="sa-staff-profile-empty">Появятся после первых оценённых тренировок.</p>
            ) : (
              <div className="sa-staff-skills-grid">
                {stats.categoryScores.map((item) => (
                  <div key={item.name} className="sa-staff-skill-card" title={item.hint}>
                    <div className="sa-staff-skill-top">
                      <strong>{item.name}</strong>
                      <span className={ratingClass(item.score)}>{item.score}</span>
                    </div>
                    <div className="sa-staff-skill-bar">
                      <i
                        style={{
                          width: `${item.score <= 0 ? 5 : Math.max(item.score, 4)}%`,
                          background: scoreBarColor(item.score),
                        }}
                      />
                    </div>
                    <p className="sa-staff-skill-comment">{item.comment || item.hint}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="sa-section sa-staff-profile-section">
        <h2 className="sa-section-title">Динамика баллов</h2>
        {stats.scoreTrend.length === 0 ? (
          <p className="sa-staff-profile-empty">Нет завершённых тренировок с оценкой.</p>
        ) : (
          <BrutalCard title="Последние 10 тестов" className="sa-staff-chart-card">
            <StaffScoreTrendChart points={stats.scoreTrend} />
          </BrutalCard>
        )}
      </section>
    </div>
  );
}

/* ================================================================
   Trainer page (history + testing)
   ================================================================ */

export function StaffTrainerContent() {
  const [webHistory, setWebHistory] = useState<WebTestHistoryItem[]>([]);
  const [selectedWebItem, setSelectedWebItem] = useState<WebTestHistoryItem | null>(null);
  const [testMode, setTestMode] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STAFF_WEB_HISTORY_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const normalized = parsed
        .filter((x: any) => x && typeof x === 'object')
        .map((x: any) => ({
          id: String(x.id ?? ''),
          sessionId: typeof x.sessionId === 'string' || x.sessionId === null ? x.sessionId : null,
          createdAt: typeof x.createdAt === 'string' ? x.createdAt : new Date().toISOString(),
          status: x.status === 'completed' ? 'completed' as const : 'unfinished' as const,
          turns: Number.isFinite(x.turns) ? Number(x.turns) : 0,
          result: x.result && typeof x.result === 'object'
            ? {
                verdict: x.result.verdict === 'pass' ? 'pass' as const : 'fail' as const,
                totalScore: Number.isFinite(x.result.totalScore) ? Number(x.result.totalScore) : 0,
                qualityTag: typeof x.result.qualityTag === 'string' ? x.result.qualityTag : 'Нужно улучшить',
                summary: typeof x.result.summary === 'string' ? x.result.summary : '',
                strengths: Array.isArray(x.result.strengths) ? x.result.strengths.map(String) : [],
                weaknesses: Array.isArray(x.result.weaknesses) ? x.result.weaknesses.map(String) : [],
                recommendations: Array.isArray(x.result.recommendations) ? x.result.recommendations.map(String) : [],
                reasonCode: typeof x.result.reasonCode === 'string' || x.result.reasonCode === null ? x.result.reasonCode : null,
              }
            : null,
        }))
        .filter((x: any) => x.id)
        .slice(0, 30);
      setWebHistory(normalized);
    } catch {
      // ignore malformed history
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STAFF_WEB_HISTORY_STORAGE_KEY, JSON.stringify(webHistory.slice(0, 30)));
    } catch {
      // ignore
    }
  }, [webHistory]);

  if (testMode) {
    return (
      <StaffTestScreen
        onBack={() => setTestMode(false)}
        onSessionClosed={(item) => {
          setWebHistory((prev) => [item, ...prev].slice(0, 30));
          setTestMode(false);
        }}
      />
    );
  }

  if (selectedWebItem) {
    const item = selectedWebItem;
    return (
      <div className="space-y-4">
        <Button size="sm" variant="flat" onPress={() => setSelectedWebItem(null)} startContent={<span>←</span>}>
          Назад
        </Button>
        <Card shadow="sm" className="admin-card-light">
          <CardBody>
            <div className="rounded-2xl admin-card-inner px-4 py-3 space-y-3 text-sm">
              <div className="flex justify-between items-center">
                <div className="font-semibold">Web‑тест</div>
                <span
                  className={`text-[11px] px-2 py-1 rounded-full ${
                    item.status === 'unfinished' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'
                  }`}
                >
                  {item.status === 'unfinished' ? 'Не завершён' : 'Завершён'}
                </span>
              </div>
              <div className="text-xs text-default-500 space-y-1">
                <div>Дата: {new Date(item.createdAt).toLocaleString('ru-RU')}</div>
                <div>Сообщений: {item.turns}</div>
              </div>
              {item.result && (
                <div className="space-y-3 pt-2 border-t border-default-200">
                  <div className="text-xl font-semibold">{item.result.totalScore}/100</div>
                  <div className="text-xs text-default-400">{item.result.summary}</div>
                  {!!item.result.strengths?.length && (
                    <div>
                      <div className="text-xs font-semibold mb-1">✅ Сильные стороны</div>
                      <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">
                        {item.result.strengths.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                  {!!item.result.weaknesses?.length && (
                    <div>
                      <div className="text-xs font-semibold mb-1">⚠️ Зоны роста</div>
                      <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">
                        {item.result.weaknesses.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </div>
                  )}
                  {!!item.result.recommendations?.length && (
                    <div>
                      <div className="text-xs font-semibold mb-1">💡 Рекомендации</div>
                      <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">
                        {item.result.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card shadow="sm" className="admin-card-light">
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">Тренажёр</div>
              <div className="text-[12px] text-default-500">Тренировка диалога с виртуальным клиентом</div>
            </div>
          </div>
          <Button size="lg" color="primary" fullWidth className="h-12 font-semibold" onPress={() => setTestMode(true)}>
            Начать тестирование
          </Button>
        </CardBody>
      </Card>

      <Card shadow="sm" className="admin-card-light">
        <CardBody className="space-y-3">
          <div className="text-sm font-semibold">История тестов</div>
          {webHistory.length === 0 ? (
            <p className="text-xs text-default-500">После прохождения тестов здесь появятся карточки с результатами.</p>
          ) : (
            <div className="space-y-2">
              {webHistory.map((item) => (
                <Card
                  key={item.id}
                  isPressable
                  onPress={() => setSelectedWebItem(item)}
                  shadow="sm"
                  className="admin-card-light w-full"
                >
                  <CardBody>
                    <div className="flex justify-between items-center mb-1">
                      <div className="font-semibold text-sm">Тренировка</div>
                      <span
                        className={`text-[11px] px-2 py-1 rounded-full ${
                          item.status === 'unfinished'
                            ? 'bg-amber-500/20 text-amber-300'
                            : item.result?.verdict === 'pass'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-rose-500/20 text-rose-300'
                        }`}
                      >
                        {item.status === 'unfinished'
                          ? 'Не завершён'
                          : item.result?.verdict === 'pass'
                          ? 'Пройден'
                          : 'Не пройден'}
                      </span>
                    </div>
                    <div className="text-lg font-semibold text-default-300">
                      {item.result?.totalScore != null ? `${item.result.totalScore}/100` : 'Н/Д'}
                    </div>
                    <div className="text-[11px] text-default-500 mt-1">
                      {new Date(item.createdAt).toLocaleString('ru-RU')} · Сообщений: {item.turns}
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ================================================================
   Test screen with mock fallback
   ================================================================ */

function StaffTestScreen(props: { onBack: () => void; onSessionClosed?: (item: WebTestHistoryItem) => void }) {
  const { onBack, onSessionClosed } = props;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TrainingMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [finalResult, setFinalResult] = useState<WebTestResult | null>(null);
  const [mustListenClientMessageId, setMustListenClientMessageId] = useState<number | null>(null);
  const [heardClientMessageIds, setHeardClientMessageIds] = useState<number[]>([]);
  const [stopPlaybackSignal, setStopPlaybackSignal] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordStartedAtRef = useRef<number>(0);
  const shouldSendRecordingRef = useRef(true);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const startTraining = async () => {
    setSending(true);
    setError(null);
    setFinalResult(null);
    setMessages([{ id: 1, role: 'client', audioUrl: null, textFallback: '...' }]);
    try {
      const res = await fetch(`${API_BASE}/api/training/web/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strictness: 'medium', profile: 'normal', replyMode: 'text+voice', voice: 'male' }),
      });
      const data = await parseApiJson(res);
      if (!res.ok) {
        throw new Error(data.error || `Ошибка ${res.status}`);
      }
      setSessionId(data.sessionId);
      setMessages([{
        id: 1,
        role: 'client',
        audioUrl: data.audioBase64 ? `data:audio/ogg;base64,${data.audioBase64}` : null,
        textFallback: data.clientMessage || 'Клиент подключён.',
        autoPlay: Boolean(data.audioBase64),
      }]);
      setMustListenClientMessageId(data.audioBase64 ? 1 : null);
      setStarted(true);
      setEnded(data.endConversation ?? false);
      if (data.result && data.endConversation) {
        setFinalResult(data.result as WebTestResult);
      }
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === 1 ? { ...m, textFallback: 'Не удалось запустить тест. Попробуйте ещё раз.' } : m,
        ),
      );
      setError(e?.message || 'Не удалось запустить тренировку');
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    startTraining();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result !== 'string') return reject(new Error('Не удалось прочитать аудио'));
        const base64 = result.split(',')[1] || '';
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Ошибка чтения аудио'));
      reader.readAsDataURL(blob);
    });

  const parseApiJson = async (res: Response) => {
    const raw = await res.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(
        res.status === 503
          ? 'Сервер временно недоступен (HTTP 503). Повторите отправку через несколько секунд.'
          : `Сервер вернул не JSON (HTTP ${res.status}). Проверьте, что backend запущен и /api проксируется на него.`,
      );
    }
  };

  const sendVoiceBlob = async (blob: Blob, durationSec: number) => {
    if (!sessionId || ended) return;
    const managerAudioUrl = URL.createObjectURL(blob);
    const idBase = messages.length ? messages[messages.length - 1].id + 1 : 1;
    setMessages((prev) => [
      ...prev,
      { id: idBase, role: 'manager', audioUrl: managerAudioUrl, durationSec },
      { id: idBase + 1, role: 'client', audioUrl: null, textFallback: '...' },
    ]);
    setSending(true);
    setError(null);

    try {
      const audioBase64 = await blobToBase64(blob);
      let res: Response | null = null;
      for (let i = 0; i < 2; i += 1) {
        res = await fetch(`${API_BASE}/api/training/web/voice-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            audioBase64,
            mimeType: blob.type || 'audio/webm',
            replyMode: 'text+voice',
            voice: 'male',
          }),
        });
        if (res.status !== 503) break;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      if (!res) throw new Error('Сервер недоступен');
      const data = await parseApiJson(res);
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
      setMessages((prev) => {
        const copy = [...prev];
        const lastIdx = copy.findIndex((m) => m.id === idBase + 1);
        if (lastIdx >= 0) {
          copy[lastIdx] = {
            id: idBase + 1,
            role: 'client',
            audioUrl: data.audioBase64 ? `data:audio/ogg;base64,${data.audioBase64}` : null,
            textFallback: data.clientMessage || 'Ответ получен',
            autoPlay: Boolean(data.audioBase64),
          };
        }
        return copy;
      });
      setMustListenClientMessageId(data.audioBase64 ? idBase + 1 : null);
      setEnded(data.endConversation ?? false);
      if (data.result && data.endConversation) {
        setFinalResult(data.result as WebTestResult);
      }
    } catch (e: any) {
      setMessages((prev) => {
        const copy = [...prev];
        const lastIdx = copy.findIndex((m) => m.id === idBase + 1);
        if (lastIdx >= 0) {
          copy[lastIdx] = {
            id: idBase + 1,
            role: 'client',
            audioUrl: null,
            textFallback: 'Сервер временно недоступен. Повторите голосовое сообщение.',
          };
        }
        return copy;
      });
      setError(e?.message || 'Сервер временно недоступен');
    } finally {
      setSending(false);
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      shouldSendRecordingRef.current = true;
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }
    if (mustListenClientMessageId && !heardClientMessageIds.includes(mustListenClientMessageId)) {
      setError('Сначала полностью прослушайте последнее сообщение клиента');
      return;
    }
    if (!sessionId || sending || ended) return;
    try {
      setStopPlaybackSignal((prev) => prev + 1);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];
      mediaRecorderRef.current = recorder;
      recordStartedAtRef.current = Date.now();
      shouldSendRecordingRef.current = true;

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.85;
      analyserRef.current = analyser;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += data[i];
        const avg = sum / data.length;
        setInputLevel(Math.min(1, avg / 120));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        try {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
          setInputLevel(0);
          if (shouldSendRecordingRef.current) {
            const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
            const durationSec = Math.max(1, Math.round((Date.now() - recordStartedAtRef.current) / 1000));
            await sendVoiceBlob(blob, durationSec);
          }
        } finally {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          if (audioCtxRef.current) {
            audioCtxRef.current.close().catch(() => {});
            audioCtxRef.current = null;
          }
        }
      };
      recorder.start();
      setRecording(true);
    } catch (e: any) {
      setError(e?.message || 'Не удалось включить микрофон');
    }
  };

  const cancelRecording = () => {
    if (!recording) return;
    shouldSendRecordingRef.current = false;
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const handleBackPress = () => {
    const hasProgress = started && messages.length > 0;
    const unfinished = hasProgress && !ended;
    if (unfinished) { setExitConfirmOpen(true); return; }
    closeSessionAndExit(false);
  };

  const closeSessionAndExit = (forceUnfinished: boolean) => {
    const hasProgress = started && messages.length > 0;
    if (hasProgress) {
      const item: WebTestHistoryItem = {
        id: `web_hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        createdAt: new Date().toISOString(),
        status: forceUnfinished ? 'unfinished' : ended ? 'completed' : 'unfinished',
        turns: messages.length,
        result: forceUnfinished ? null : finalResult,
      };
      if (onSessionClosed) onSessionClosed(item);
      else onBack();
      return;
    }
    onBack();
  };

  const requiresListening =
    Boolean(mustListenClientMessageId) &&
    !heardClientMessageIds.includes(mustListenClientMessageId as number);

  if (ended && finalResult) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Button size="sm" variant="flat" onPress={() => closeSessionAndExit(false)}>
            ← Назад
          </Button>
          <div className="text-sm font-semibold">Тестирование завершено</div>
          <div />
        </div>
        <Card shadow="sm" className="admin-card-light">
          <CardBody className="space-y-4">
            <div className="flex justify-between items-start">
              <div className="text-sm text-default-500">Итоги диалога</div>
              <span className={`text-[11px] px-2 py-1 rounded-full ${
                finalResult.verdict === 'pass' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
              }`}>
                {finalResult.verdict === 'pass' ? 'Пройдено' : 'Не пройдено'}
              </span>
            </div>
            <div className="text-3xl font-bold">{finalResult.totalScore}/100</div>
            <div className="text-sm text-default-400">{finalResult.summary}</div>
            <div className="space-y-3">
              <div>
                <div className="text-xs font-semibold mb-1">✅ Сильные стороны</div>
                {finalResult.strengths.length ? (
                  <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">{finalResult.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                ) : <div className="text-xs text-default-500">—</div>}
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">⚠️ Зоны роста</div>
                {finalResult.weaknesses.length ? (
                  <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">{finalResult.weaknesses.map((w, i) => <li key={i}>{w}</li>)}</ul>
                ) : <div className="text-xs text-default-500">—</div>}
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">💡 Рекомендации</div>
                {finalResult.recommendations.length ? (
                  <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">{finalResult.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
                ) : <div className="text-xs text-default-500">—</div>}
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-170px)] min-h-[520px]" style={{ color: 'var(--text-body)' }}>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="flat" onPress={handleBackPress}>
          ← Назад
        </Button>
        <div className="text-sm font-semibold">Тест с виртуальным клиентом</div>
        <div className="text-[11px] text-default-500">
          {ended ? 'Диалог завершён' : started ? 'Тренировка идёт' : 'Запуск...'}
        </div>
      </div>
      <Card shadow="sm" className="admin-card-light flex-1 min-h-0">
        <CardBody className="space-y-2 text-xs h-full overflow-y-auto">
          {messages.length === 0 && (
            <div className="text-[11px] text-default-500">
              Ожидаем первое сообщение от клиента…
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === 'manager' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[86%] rounded-2xl px-3 py-2 ${
                  m.role === 'manager'
                    ? 'rounded-br-sm'
                    : 'rounded-bl-sm border border-default-300 text-default-800'
                }`}
                style={m.role === 'manager'
                  ? {
                      background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                      color: '#ffffff',
                      boxShadow: '0 4px 14px rgba(79, 70, 229, 0.25)',
                    }
                  : { background: 'rgba(243, 244, 246, 0.96)' }
                }
              >
                {m.audioUrl ? (
                  <VoiceBubble
                    messageId={m.id}
                    audioUrl={m.audioUrl}
                    side={m.role}
                    durationSec={m.durationSec}
                    autoPlay={Boolean(m.autoPlay)}
                    stopPlaybackSignal={stopPlaybackSignal}
                    mustFinishBeforeRecord={m.role === 'client' && mustListenClientMessageId === m.id}
                    onFirstFullListen={(messageId) => {
                      setHeardClientMessageIds((prev) => prev.includes(messageId) ? prev : [...prev, messageId]);
                      setMustListenClientMessageId((prev) => (prev === messageId ? null : prev));
                    }}
                  />
                ) : m.role === 'client' && m.textFallback === '...' ? (
                  <ClientThinkingBubble />
                ) : (
                  <div className="text-[11px] opacity-80">{m.textFallback || 'Голос недоступен'}</div>
                )}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
      <div className="sticky bottom-0 mt-2 border-t backdrop-blur px-3 md:px-6 pt-3 pb-[calc(env(safe-area-inset-bottom)+12px)] rounded-2xl" style={{ borderColor: 'var(--block-border)', background: 'var(--card-bg)' }}>
        <div className="flex justify-center items-center min-h-[72px]">
          <div className="relative">
            {recording && (
              <Button
                size="sm"
                variant="flat"
                color="danger"
                onPress={cancelRecording}
                className="absolute right-full mr-4 top-1/2 -translate-y-1/2"
              >
                Отменить
              </Button>
            )}
            {recording && (
              <>
                <div className="absolute inset-0 rounded-full bg-danger-400/25" style={{ transform: `scale(${1.2 + inputLevel * 0.7})`, filter: 'blur(2px)' }} />
                <div className="absolute inset-0 rounded-full bg-danger-300/20" style={{ transform: `scale(${1.45 + inputLevel * 0.95})`, filter: 'blur(4px)' }} />
              </>
            )}
            <Button
              isIconOnly
              size="lg"
              radius="full"
              color={recording ? 'danger' : 'primary'}
              variant="solid"
              isDisabled={!sessionId || sending || ended || requiresListening}
              onPress={toggleRecording}
              className="w-16 h-16 md:w-20 md:h-20 relative z-10 text-white"
            >
              {recording ? (
                <span className="text-lg leading-none">■</span>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="w-7 h-7 md:w-8 md:h-8 fill-current"
                >
                  <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V6a3 3 0 0 0-3-3z" />
                  <path d="M18 11a1 1 0 1 0-2 0 4 4 0 1 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-3.09A6 6 0 0 0 18 11z" />
                </svg>
              )}
            </Button>
          </div>
        </div>

        {error && <div className="text-[11px] text-danger-400 text-center">{error}</div>}
        {recording && <div className="text-[11px] text-warning-400 text-center">Идёт запись… нажмите ещё раз, чтобы отправить</div>}
        {!recording && requiresListening && (
          <div className="text-[11px] text-default-500 text-center">
            Сначала дослушайте голосовое клиента до конца, затем запись разблокируется.
          </div>
        )}
        {ended && (
          <div className="text-[11px] text-success-400 text-center">
            Диалог завершён. Вы можете запустить новый тест.
          </div>
        )}
      </div>

      <Modal isOpen={exitConfirmOpen} onOpenChange={setExitConfirmOpen} placement="center" size="sm">
        <ModalContent className="admin-card-light">
          {() => (
            <>
              <ModalHeader className="text-sm font-semibold">Незавершённый тест</ModalHeader>
              <ModalBody>
                <div className="text-xs text-default-500">
                  Тест ещё не завершён. Если выйти сейчас, он сохранится как незавершённый.
                </div>
                <div className="flex justify-end gap-2 pt-2 pb-1">
                  <Button size="sm" variant="flat" onPress={() => setExitConfirmOpen(false)}>Остаться</Button>
                  <Button size="sm" color="warning" onPress={() => { setExitConfirmOpen(false); closeSessionAndExit(true); }}>Выйти</Button>
                </div>
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}

/* ================================================================
   Voice bubble & thinking indicator
   ================================================================ */

function VoiceBubble(props: {
  messageId: number;
  audioUrl: string;
  side: 'client' | 'manager';
  durationSec?: number;
  autoPlay?: boolean;
  stopPlaybackSignal?: number;
  mustFinishBeforeRecord?: boolean;
  onFirstFullListen?: (messageId: number) => void;
}) {
  const {
    messageId, audioUrl, side, durationSec,
    autoPlay = false, stopPlaybackSignal = 0,
    mustFinishBeforeRecord = false, onFirstFullListen,
  } = props;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const firstFullListenDoneRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [detectedDuration, setDetectedDuration] = useState(0);

  const bars = useMemo(() => {
    let seed = 0;
    for (let i = 0; i < audioUrl.length; i += 1) seed = (seed * 31 + audioUrl.charCodeAt(i)) >>> 0;
    const out: number[] = [];
    for (let i = 0; i < 52; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out.push(0.25 + ((seed % 100) / 100) * 0.75);
    }
    return out;
  }, [audioUrl]);

  const displayDuration = durationSec || detectedDuration || 0;
  const formatDuration = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); return; }
    try {
      if (audio.duration && audio.currentTime >= audio.duration - 0.05) { audio.currentTime = 0; setProgress(0); }
      await audio.play();
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!autoPlay) return;
    const audio = audioRef.current;
    if (!audio) return;
    let cancelled = false;
    let attempts = 0;
    const attemptPlay = () => {
      if (cancelled) return;
      attempts += 1;
      audio.play().catch(() => { if (attempts < 4) setTimeout(attemptPlay, 250); });
    };
    setProgress(0);
    audio.currentTime = 0;
    attemptPlay();
    return () => { cancelled = true; };
  }, [audioUrl, autoPlay]);

  useEffect(() => { audioRef.current?.pause(); }, [stopPlaybackSignal]);

  return (
    <div className="flex items-center gap-2 min-w-[220px]">
      <audio
        ref={audioRef} src={audioUrl} autoPlay={autoPlay} playsInline preload="metadata"
        onLoadedMetadata={() => { const d = audioRef.current?.duration || 0; if (Number.isFinite(d)) setDetectedDuration(Math.round(d)); }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false); setProgress(1);
          if (mustFinishBeforeRecord && !firstFullListenDoneRef.current) {
            firstFullListenDoneRef.current = true;
            onFirstFullListen?.(messageId);
          }
        }}
        onTimeUpdate={() => { const a = audioRef.current; if (a?.duration) setProgress(a.currentTime / a.duration); }}
      />
      <button type="button" onClick={togglePlay} className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${side === 'manager' ? 'bg-white/25 text-white' : 'bg-default-300/70 text-default-800'}`}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="flex-1 flex items-end gap-[1px] h-5">
        {bars.map((h, idx) => {
          const played = idx / bars.length < progress;
          return (
            <div key={idx} className={`w-[2px] rounded-full ${played ? (side === 'manager' ? 'bg-white' : 'bg-zinc-700') : (side === 'manager' ? 'bg-white/35' : 'bg-zinc-400/70')} ${playing ? 'transition-all duration-150' : ''}`}
              style={{ height: `${8 + h * 10}px` }} />
          );
        })}
      </div>
      <div className={`text-[12px] min-w-[42px] text-right font-medium ${side === 'manager' ? 'text-white/95' : 'text-default-800'}`}>
        {formatDuration(displayDuration)}
      </div>
    </div>
  );
}

function ClientThinkingBubble() {
  return (
    <div className="min-w-[220px] text-default-600">
      <div className="text-[11px] mb-1">Клиент записывает голосовое…</div>
      <div className="flex items-end gap-[2px] h-4">
        {Array.from({ length: 20 }).map((_, idx) => (
          <span key={idx} className="w-[2px] rounded-full bg-zinc-500/70 animate-pulse"
            style={{ height: `${6 + ((idx * 7) % 8)}px`, animationDelay: `${idx * 70}ms`, animationDuration: '900ms' }} />
        ))}
      </div>
    </div>
  );
}
