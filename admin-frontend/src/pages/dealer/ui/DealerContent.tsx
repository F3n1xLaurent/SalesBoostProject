import React, { useState, useEffect, useMemo, useRef } from 'react';
import { apiFetch } from '../../../entities/session';
import { CallInsightCard, type CallInsightDetail } from '../../../widgets/call-insight-card';
import {
  Card,
  CardBody,
  Button,
  Input,
  Spacer,
} from '@heroui/react';

type Attempt = {
  id: number | string;
  type: 'attempt' | 'training';
  sessionId?: number;
  userName: string;
  totalScore: number | null;
  qualityTag: string | null;
  summary?: string | null;
  finishedAt?: string | null;
};

type CallSummary = {
  id: number;
  to: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  outcome: string | null;
  totalScore: number | null;
  hasEvaluation: boolean;
  source?: string | null;
  dealershipId?: string | null;
  dealershipName?: string | null;
  planId?: string | null;
  planName?: string | null;
};

type CallFilters = {
  source: 'all' | 'scheduled' | 'manual';
  status: 'all' | 'good' | 'medium' | 'bad' | 'no_answer' | 'broken';
  dealershipId: string;
  planId: string;
};

type CallDetail = CallInsightDetail;

type AttemptDetail = {
  id: number;
  type?: 'attempt' | 'training';
  userName: string;
  testTitle: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalScore: number | null;
  level?: string | null;
  qualityTag: string | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  dimensionScores?: Record<string, number> | null;
  steps: {
    order: number;
    customerMessage: string;
    answer: string;
    score: number | null;
    feedback: string | null;
    betterExample: string | null;
  }[];
};

type TeamSummary = {
  totalAttempts: number;
  avgScore: number;
  levelCounts: {
    Junior: number;
    Middle: number;
    Senior: number;
  };
  topWeaknesses: { weakness: string; count: number }[];
  topStrengths: { strength: string; count: number }[];
  expertSummary: string | null;
};

type VoiceDashboard = {
  totalCalls: number;
  answeredPercent: number;
  missedPercent: number;
  avgDurationSec: number;
  outcomeBreakdown: {
    completed: number;
    no_answer: number;
    busy: number;
    failed: number;
    disconnected: number;
  };
};

type ExpensesInfo = {
  periodStart: string;
  periodEnd: string;
  totalSpentUsd: number;
  currency: string;
  error: string | null;
  billingUrl: string;
};

type ScopedDealership = {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  holdingName: string | null;
  managersCount: number;
  isActive: boolean;
};
const isDevHost =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname.endsWith('.lhr.life'));

function buildDemoCalls(): CallSummary[] {
  const now = Date.now();
  const baseNumber = '+79998887766';
  return Array.from({ length: 10 }).map((_, idx) => {
    const start = new Date(now - (idx + 1) * 3600_000);
    const duration = 40 + idx * 10;
    const outcomes = [ 'completed', 'no_answer', 'busy', 'disconnected' ] as const;
    const outcome = outcomes[idx % outcomes.length];
    const scores = [ 92, 78, 64, 48, 30, null, 85, 55, 10, null ];
    const score = scores[idx] ?? null;
    return {
      id: 10_000 + idx,
      to: baseNumber,
      startedAt: start.toISOString(),
      endedAt: outcome === 'completed' ? new Date(start.getTime() + duration * 1000).toISOString() : start.toISOString(),
      durationSec: outcome === 'completed' ? duration : null,
      outcome,
      totalScore: score,
        hasEvaluation: score != null,
    };
  });
}

const API_BASE = '';

function buildMockAttempts(): Attempt[] {
  const names = ['Иванов А.С.', 'Петрова Е.В.', 'Сидоров К.М.', 'Козлова Н.А.', 'Орлов Д.И.', 'Новикова О.П.', 'Белов С.Г.', 'Фёдорова И.Л.'];
  const tags = ['Хорошо', 'Средне', 'Плохо', null, 'Хорошо', 'Средне', null, 'Хорошо'];
  const now = Date.now();
  return names.map((name, idx) => {
    const score = [92, 68, 43, 78, 55, 87, null, 71][idx] ?? null;
    return {
      id: 5000 + idx,
      type: idx % 3 === 0 ? 'training' as const : 'attempt' as const,
      sessionId: idx % 3 === 0 ? 100 + idx : undefined,
      userName: name,
      totalScore: score,
      qualityTag: tags[idx],
      summary: [
        'Хорошая работа с возражениями, но слабое закрытие сделки.',
        'Необходимо улучшить приветствие и выявление потребностей.',
        'Слабая коммуникация, отсутствие следующего шага.',
        'Уверенная работа по скрипту, все этапы пройдены.',
        'Средний результат, рекомендуется тренировка по работе с возражениями.',
        'Отличный контакт с клиентом, высокая конверсия.',
        null,
        'Достаточно хорошо, но есть зоны роста в закрытии.',
      ][idx],
      finishedAt: new Date(now - (idx + 1) * 7200_000).toISOString(),
    };
  });
}

function buildMockTeamSummary(): TeamSummary {
  return {
    totalAttempts: 156,
    avgScore: 72.4,
    levelCounts: { Junior: 3, Middle: 4, Senior: 2 },
    topWeaknesses: [
      { weakness: 'Закрытие сделки', count: 42 },
      { weakness: 'Работа с возражениями', count: 35 },
      { weakness: 'Следующий шаг', count: 28 },
    ],
    topStrengths: [
      { strength: 'Приветствие', count: 89 },
      { strength: 'Выявление потребностей', count: 72 },
      { strength: 'Презентация', count: 68 },
    ],
    expertSummary: 'Команда показывает стабильные результаты. Основные зоны роста: закрытие сделки и работа с возражениями. Рекомендуется назначить дополнительные тренировки по этим направлениям.',
  };
}

function buildMockVoiceDashboard(): VoiceDashboard {
  return {
    totalCalls: 87,
    answeredPercent: 74,
    missedPercent: 26,
    avgDurationSec: 185,
    outcomeBreakdown: { completed: 52, no_answer: 18, busy: 7, failed: 5, disconnected: 5 },
  };
}

function buildMockCallDetail(id: number): CallDetail {
  const scores: Record<string, number> = {
    'Приветствие': 8.5,
    'Выявление потребностей': 7.2,
    'Презентация': 6.8,
    'Работа с возражениями': 5.4,
    'Закрытие сделки': 4.9,
  };
  return {
    id,
    to: '+79998887766',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    endedAt: new Date(Date.now() - 3300_000).toISOString(),
    outcome: 'completed',
    durationSec: 300,
    totalScore: 68,
    qualityTag: 'Средне',
    strengths: ['Уверенное приветствие', 'Хорошая презентация продукта'],
    weaknesses: ['Не предложил следующий шаг', 'Слабая работа с возражениями'],
    recommendations: ['Пройти тренировку по закрытию сделки', 'Изучить типовые возражения клиентов'],
    transcript: [
      { role: 'client', text: 'Здравствуйте, я хотел бы узнать про новый Camry.' },
      { role: 'manager', text: 'Добрый день! Да, конечно, расскажу вам подробнее. Какой бюджет рассматриваете?' },
      { role: 'client', text: 'Ну, где-то в районе 3 миллионов, может чуть больше.' },
      { role: 'manager', text: 'Отлично! У нас как раз есть отличные комплектации в этом диапазоне.' },
      { role: 'client', text: 'А какие-то скидки сейчас есть?' },
      { role: 'manager', text: 'Да, сейчас действует специальная программа. Давайте я расскажу подробнее.' },
      { role: 'client', text: 'Хорошо, послушаю.' },
      { role: 'manager', text: 'В комплектации Престиж у вас полный привод, кожаный салон и панорамная крыша.' },
    ],
    dimensionScores: scores,
  };
}

function buildMockAttemptDetail(attempt: Attempt): AttemptDetail {
  return {
    id: typeof attempt.id === 'number' ? attempt.id : parseInt(attempt.id as string, 10) || 0,
    type: attempt.type,
    userName: attempt.userName,
    testTitle: attempt.type === 'training' ? 'Тренировка: Работа с возражениями' : 'Проверка звонка',
    totalScore: attempt.totalScore,
    qualityTag: attempt.qualityTag,
    startedAt: new Date(Date.now() - 7200_000).toISOString(),
    finishedAt: attempt.finishedAt || new Date().toISOString(),
    strengths: ['Уверенное приветствие', 'Хорошая презентация'],
    weaknesses: ['Не предложил следующий шаг', 'Слабое закрытие'],
    recommendations: ['Тренировка по закрытию сделки'],
    dimensionScores: {
      'Приветствие': 8.5,
      'Выявление потребностей': 7.0,
      'Презентация': 6.5,
      'Работа с возражениями': 5.2,
      'Закрытие': 4.8,
    },
    steps: [
      {
        order: 1,
        customerMessage: 'Здравствуйте, меня интересует новый автомобиль.',
        answer: 'Добрый день! Рад вас приветствовать. Какой автомобиль рассматриваете?',
        score: 8.5,
        feedback: 'Хорошее приветствие, установлен контакт.',
        betterExample: null,
      },
      {
        order: 2,
        customerMessage: 'Хочу что-то в районе 3 миллионов.',
        answer: 'У нас есть несколько отличных вариантов в этом ценовом диапазоне.',
        score: 7.0,
        feedback: 'Нужно было задать уточняющие вопросы о потребностях.',
        betterExample: 'Отлично! А какой тип кузова предпочитаете — седан, кроссовер? Для города или загорода?',
      },
      {
        order: 3,
        customerMessage: 'А скидки есть?',
        answer: 'Сейчас действуют специальные условия по trade-in.',
        score: 5.5,
        feedback: 'Не раскрыл полностью предложение, не предложил визит.',
        betterExample: 'Да, сейчас действует программа trade-in с выгодой до 300 тысяч. Давайте запишу вас на тест-драйв, чтобы вы могли оценить автомобиль лично?',
      },
    ],
  };
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Sub-components (copied exactly from old App.tsx)                      */
/* ─────────────────────────────────────────────────────────────────────── */

function EmployeesTab(props: {
  loading: boolean;
  error: string | null;
  attempts: Attempt[];
  attemptViewMode: 'list' | 'attempt';
  selectedAttemptForPage: Attempt | null;
  onAttemptCardPageBack: () => void;
  onOpenAttemptPage: (a: Attempt) => void;
}) {
  const { loading, error, attempts, attemptViewMode, selectedAttemptForPage, onAttemptCardPageBack, onOpenAttemptPage } = props;
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  async function loadDetail(attempt: Attempt) {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      let url: string;
      if (attempt.type === 'training' && attempt.sessionId) {
        url = `${API_BASE}/api/admin/training-sessions/${attempt.sessionId}`;
      } else {
        url = `${API_BASE}/api/admin/attempts/${attempt.id}`;
      }
      const res = await apiFetch(url);
      if (!res.ok) {
        if (isDevHost) {
          setDetail(buildMockAttemptDetail(attempt));
          return;
        }
        throw new Error(`Сервер ответил ${res.status}`);
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (data) {
        setDetail(data as AttemptDetail);
      } else if (isDevHost) {
        setDetail(buildMockAttemptDetail(attempt));
      }
    } catch {
      if (isDevHost) {
        setDetail(buildMockAttemptDetail(attempt));
      } else {
        setDetailError('Данные недоступны. Запустите бэкенд.');
      }
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (attemptViewMode === 'attempt' && selectedAttemptForPage) {
      loadDetail(selectedAttemptForPage);
    }
  }, [attemptViewMode, selectedAttemptForPage]);
  if (loading) {
    return (
      <Card shadow="sm">
        <CardBody className="text-sm text-default-500">Загрузка сотрудников…</CardBody>
      </Card>
    );
  }
  if (error) {
    return (
      <Card shadow="sm">
        <CardBody className="text-sm text-danger-400">Ошибка: {error}</CardBody>
      </Card>
    );
  }
  if (attemptViewMode === 'attempt' && selectedAttemptForPage) {
    const d = detail;
    return (
      <div className="space-y-4">
        <Button size="sm" variant="flat" onPress={onAttemptCardPageBack} startContent={<span>←</span>}>
          Назад
        </Button>
        <Card shadow="sm" className="admin-card-light">
          <CardBody>
            {detailLoading ? (
              <div className="rounded-2xl admin-card-inner px-4 py-3 text-sm text-default-500">Загрузка…</div>
            ) : detailError ? (
              <div className="rounded-2xl admin-card-inner px-4 py-3 text-sm text-danger">Ошибка: {detailError}</div>
            ) : d ? (
              <div className="rounded-2xl admin-card-inner px-4 py-3 space-y-4">
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-semibold text-sm">{d.userName}</div>
                    <div className="text-[11px] text-default-500">{d.testTitle}</div>
                  </div>
                  {d.qualityTag && (
                    <span className="text-[11px] px-2 py-1 rounded-full admin-badge-neutral">{d.qualityTag}</span>
                  )}
                </div>
                <div className="text-2xl font-bold">{d.totalScore != null ? `${d.totalScore.toFixed(1)}/100` : 'Н/Д'}</div>
                <div className="text-xs text-default-500 space-y-1">
                  <div>Начало: {d.startedAt ? new Date(d.startedAt).toLocaleString('ru-RU') : '—'}</div>
                  <div>Конец: {d.finishedAt ? new Date(d.finishedAt).toLocaleString('ru-RU') : '—'}</div>
                </div>
                {d.dimensionScores && (
                  <div>
                    <div className="text-xs font-semibold mb-1">Ключевые показатели</div>
                    <div className="space-y-2">
                      {Object.entries(d.dimensionScores).map(([key, value]) => {
                        const v = typeof value === 'number' ? value : 0;
                        const norm = v <= 1 ? v * 10 : v;
                        const pct = Math.max(0, Math.min(10, norm)) * 10;
                        const color = norm >= 8 ? 'bg-emerald-500' : norm >= 5 ? 'bg-amber-500' : 'bg-rose-500';
                        const label = key.replace(/_/g, ' ');
                        return (
                          <div key={key} className="space-y-1">
                            <div className="flex justify-between text-[11px] text-default-500">
                              <span>{label}</span>
                              <span>{norm.toFixed(1)}/10</span>
                            </div>
                            <div className="h-1.5 rounded-full admin-progress-track overflow-hidden">
                              <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-xs font-semibold mb-1">✅ Сильные стороны</div>
                  {d.strengths?.length ? (
                    <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">{d.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  ) : (
                    <p className="text-xs text-default-500">Нет выделенных сильных сторон.</p>
                  )}
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1">⚠️ Зоны роста</div>
                  {d.weaknesses?.length ? (
                    <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">{d.weaknesses.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  ) : (
                    <p className="text-xs text-default-500">Зоны роста не выделены.</p>
                  )}
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1">💡 Рекомендации</div>
                  {d.recommendations?.length ? (
                    <ul className="text-xs text-default-500 list-disc pl-4 space-y-1">{d.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  ) : (
                    <p className="text-xs text-default-500">Отдельных рекомендаций нет.</p>
                  )}
                </div>
                {!!d.steps?.length && (
                  <div>
                    <div className="text-xs font-semibold mb-1">Диалог по шагам</div>
                    <div className="space-y-3">
                      {d.steps.map((step) => (
                        <div key={step.order} className="rounded-md admin-card-inner p-2 text-xs space-y-1">
                          <div className="flex justify-between items-center">
                            <span className="font-semibold">Шаг {step.order}</span>
                            {step.score != null && <span className="text-[11px] text-default-500">Балл: {step.score.toFixed(1)}</span>}
                          </div>
                          <div><span className="font-semibold">Клиент:</span> <span className="text-default-500">{step.customerMessage}</span></div>
                          <div><span className="font-semibold">Менеджер:</span> <span className="text-default-500">{step.answer}</span></div>
                          {step.feedback && <div className="text-[11px] text-default-500">Отзыв: {step.feedback}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>
    );
  }
  if (!attempts.length) {
    return (
      <Card shadow="sm" className="admin-card-light">
        <CardBody className="text-sm text-default-500">Пока нет оценённых звонков.</CardBody>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
        {attempts.map((a) => {
          const score = a.totalScore;
          const scoreClass =
            score == null ? 'text-default-500' : score >= 76 ? 'text-success-400' : score >= 50 ? 'text-warning-400' : 'text-danger-400';
          const quality =
            a.qualityTag ||
            (score != null ? (score >= 76 ? 'Хорошо' : score >= 50 ? 'Средне' : 'Плохо') : null);
          return (
            <Card
              key={a.id}
              isPressable
              onPress={() => onOpenAttemptPage(a)}
              shadow="sm"
              className="admin-card-light w-full"
            >
              <CardBody>
                <div className="flex justify-between items-center mb-1">
                  <div className="font-semibold text-sm">{a.userName}</div>
                  {quality && (
                    <span className="text-[11px] px-2 py-1 rounded-full bg-default-100 text-default-700">{quality}</span>
                  )}
                </div>
                <div className={`text-xl font-bold ${scoreClass}`}>{score != null ? `${score.toFixed(1)}/100` : 'Н/Д'}</div>
                {a.finishedAt && (
                  <div className="text-[11px] text-default-500 mt-1">
                    {new Date(a.finishedAt).toLocaleString('ru-RU')}
                  </div>
                )}
                {a.summary && (
                  <div className="mt-2 text-xs text-default-500 line-clamp-3">{a.summary}</div>
                )}
              </CardBody>
            </Card>
          );
        })}
    </div>
  );
}

function CallsTab(props: {
  loading: boolean;
  error: string | null;
  calls: CallSummary[];
  phone: string;
  onPhoneChange: (v: string) => void;
  startCallLoading: boolean;
  startCallStatus: string | null;
  onStartCall: () => void;
  selectedCallId: number | null;
  callDetail: CallDetail | null;
  callDetailLoading: boolean;
  callDetailError: string | null;
  onSelectCall: (id: number) => void;
  callViewMode: 'list' | 'call';
  onCallCardPageBack: () => void;
  filters: CallFilters;
  onFiltersChange: (filters: CallFilters) => void;
  onRefreshCalls: () => void;
}) {
  const {
    loading,
    error,
    calls,
    phone,
    onPhoneChange,
    startCallLoading,
    startCallStatus,
    onStartCall,
    selectedCallId,
    callDetail,
    callDetailLoading,
    callDetailError,
    onSelectCall,
    callViewMode,
    onCallCardPageBack,
    filters,
    onFiltersChange,
    onRefreshCalls,
  } = props;

  const [savedNumbers, setSavedNumbers] = useState<string[]>([]);
  const [savedNumbersLoading, setSavedNumbersLoading] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadSaved() {
      setSavedNumbersLoading(true);
      try {
        const res = await apiFetch(`${API_BASE}/api/admin/test-numbers`);
        if (!res.ok) { if (!cancelled) setSavedNumbersLoading(false); return; }
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!cancelled && Array.isArray(data.numbers)) {
          setSavedNumbers(data.numbers as string[]);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setSavedNumbersLoading(false);
      }
    }
    loadSaved();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectCall = (id: number) => {
    onSelectCall(id);
  };
  const dealershipOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const call of calls) {
      if (call.dealershipId) map.set(call.dealershipId, call.dealershipName || call.dealershipId);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [calls]);
  const planOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const call of calls) {
      if (call.planId) map.set(call.planId, call.planName || call.planId);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [calls]);
  const setFilter = <K extends keyof CallFilters>(key: K, value: CallFilters[K]) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  if (callViewMode === 'call' && selectedCallId != null) {
    return (
      <div className="space-y-4">
        <Button size="sm" variant="flat" onPress={onCallCardPageBack} startContent={<span>←</span>}>
          Назад
        </Button>
        <Card shadow="sm" className="admin-card-light">
          <CardBody>
            {callDetailLoading ? (
              <div className="rounded-2xl admin-card-inner px-4 py-3 text-sm text-default-500">
                Загрузка…
              </div>
            ) : callDetailError ? (
              <div className="rounded-2xl admin-card-inner px-4 py-3 text-sm text-danger">
                Ошибка: {callDetailError}
              </div>
            ) : callDetail ? (
              <CallInsightCard detail={callDetail} />
            ) : null}
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card shadow="sm" className="admin-card-light">
        <CardBody>
          <div className="space-y-3">
            <div className="space-y-1 relative">
              <Input
                label="Номер телефона"
                labelPlacement="outside"
                placeholder="+7 999 123-45-67"
                value={phone}
                onChange={(e) => onPhoneChange(e.target.value)}
                endContent={
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    onPress={() => setSavedOpen((v) => !v)}
                    disabled={savedNumbersLoading || !savedNumbers.length}
                  >
                    ▼
                  </Button>
                }
              />
              {savedOpen && (
                <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg border border-default-200 admin-card-light shadow-lg max-h-40 overflow-auto text-xs">
                  {savedNumbersLoading ? (
                    <div className="px-3 py-2 text-default-500">Загрузка…</div>
                  ) : savedNumbers.length ? (
                    savedNumbers.map((num) => (
                      <button
                        key={num}
                        type="button"
                        className="w-full text-left px-3 py-2 hover:bg-default-100 rounded-md"
                        onClick={() => {
                          onPhoneChange(num);
                          setSavedOpen(false);
                        }}
                      >
                        {num}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-default-500">Нет сохранённых номеров</div>
                  )}
                </div>
              )}
            </div>
            <Button
              color="primary"
              fullWidth
              isLoading={startCallLoading}
              onPress={onStartCall}
            >
              Позвонить
            </Button>
            {startCallStatus && (
              <p className="text-[12px] text-default-500">{startCallStatus}</p>
            )}
          </div>
        </CardBody>
      </Card>

      <Spacer y={1} />

      <div>
        <h3 className="text-sm font-semibold mb-1">История звонков</h3>
        <p className="text-[11px] text-default-500 mb-2">
          По одному номеру может быть несколько карточек (история звонков).
        </p>
        <Card shadow="sm" className="admin-card-light mb-3">
          <CardBody>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
              <label className="space-y-1">
                <span className="text-default-500">Источник</span>
                <select className="sa-select w-full" value={filters.source} onChange={(event) => setFilter('source', event.target.value as CallFilters['source'])}>
                  <option value="all">Все</option>
                  <option value="scheduled">По расписанию</option>
                  <option value="manual">Ручные</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-default-500">Статус</span>
                <select className="sa-select w-full" value={filters.status} onChange={(event) => setFilter('status', event.target.value as CallFilters['status'])}>
                  <option value="all">Все</option>
                  <option value="good">Хорошо</option>
                  <option value="medium">Средне</option>
                  <option value="bad">Плохо</option>
                  <option value="no_answer">Нет ответа</option>
                  <option value="broken">Обрыв / сбой</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-default-500">Точка</span>
                <select className="sa-select w-full" value={filters.dealershipId} onChange={(event) => setFilter('dealershipId', event.target.value)}>
                  <option value="">Все</option>
                  {dealershipOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-default-500">План</span>
                <select className="sa-select w-full" value={filters.planId} onChange={(event) => setFilter('planId', event.target.value)}>
                  <option value="">Все</option>
                  {planOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="flat" onPress={onRefreshCalls}>Применить</Button>
              <Button size="sm" variant="light" onPress={() => onFiltersChange({ source: 'all', status: 'all', dealershipId: '', planId: '' })}>Сбросить</Button>
            </div>
          </CardBody>
        </Card>
        {loading ? (
          <Card shadow="sm">
            <CardBody className="text-sm text-default-500">Загрузка звонков…</CardBody>
          </Card>
        ) : error ? (
          <Card shadow="sm">
            <CardBody className="text-sm text-danger-400">Ошибка: {error}</CardBody>
          </Card>
        ) : !calls.length && !isDevHost ? (
          <Card shadow="sm">
            <CardBody className="text-sm text-default-500">Нет звонков.</CardBody>
          </Card>
        ) : (
          <div className="space-y-3">
            {(calls.length ? calls : buildDemoCalls()).map((c) => {
              const inProgress = !c.endedAt;
              const score = c.totalScore;
              const scoreClass =
                score == null
                  ? 'text-default-500'
                  : score >= 76
                  ? 'text-success-400'
                  : score >= 50
                  ? 'text-warning-400'
                  : 'text-danger-400';
              const duration =
                c.durationSec != null
                  ? c.durationSec >= 60
                    ? `${Math.floor(c.durationSec / 60)} мин ${c.durationSec % 60} с`
                    : `${c.durationSec} с`
                  : '—';
              return (
                <Card
                  key={c.id}
                  isPressable
                  onPress={() => handleSelectCall(c.id)}
                  className={`admin-card-light w-full ${selectedCallId === c.id ? 'ring-2 ring-primary' : ''}`}
                  shadow="sm"
                >
                  <CardBody>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm font-medium">{c.to}</span>
                      {!inProgress && (
                    <span className={`text-base font-semibold ${scoreClass}`}>
                      {score != null ? `${score.toFixed(0)}/100` : 'Н/Д'}
                    </span>
                      )}
                    </div>
                    <div className="text-[11px] text-default-500 mb-1">
                      {c.startedAt ? new Date(c.startedAt).toLocaleString('ru-RU') : '—'}
                    </div>
                    <div className="text-[11px] text-default-500">
                      Исход: {c.outcome ?? (inProgress ? 'Идёт звонок…' : '—')} · Длительность: {duration}
                    </div>
                    {(c.dealershipName || c.planName || c.source) && (
                      <div className="text-[11px] text-default-500 mt-1">
                        {c.source === 'scheduled' ? 'По расписанию' : c.source === 'manual' ? 'Ручной' : c.source || 'Источник —'}
                        {c.dealershipName ? ` · ${c.dealershipName}` : ''}
                        {c.planName ? ` · ${c.planName}` : ''}
                      </div>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function TeamTab(props: { loading: boolean; error: string | null; summary: TeamSummary | null; voice: VoiceDashboard | null }) {
  const { loading, error, summary, voice } = props;

  if (loading) {
    return (
      <Card shadow="sm" className="admin-card-light">
        <CardBody className="text-sm text-default-500">Загрузка командной статистики…</CardBody>
      </Card>
    );
  }
  if (error) {
    return (
      <Card shadow="sm" className="admin-card-light">
        <CardBody className="text-sm text-danger-400">Ошибка: {error}</CardBody>
      </Card>
    );
  }
  if (!summary) {
    return (
      <Card shadow="sm" className="admin-card-light">
        <CardBody className="text-sm text-default-500">Пока нет достаточных данных по команде.</CardBody>
      </Card>
    );
  }

  const { totalAttempts, avgScore, levelCounts, topWeaknesses, topStrengths, expertSummary } = summary;
  const answeredPct = voice?.answeredPercent ?? 0;
  const missedPct = voice?.missedPercent ?? 0;
  const totalCalls = voice?.totalCalls ?? 0;

  return (
    <div className="space-y-3">
      {/* Executive KPI */}
      <Card shadow="sm" className="admin-card-light">
        <CardBody>
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="text-xs text-default-500 mb-1">Всего оценённых диалогов</div>
              <div className="text-3xl font-bold">{totalAttempts}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-default-500 mb-1">⭐ AI‑рейтинг точки</div>
              <div className="text-3xl font-semibold">{avgScore.toFixed(1)}/100</div>
            </div>
          </div>
          {voice && (
            <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-[11px] text-default-500 mb-1">📞 Дозвон</div>
                <div className="text-lg font-semibold">{answeredPct}%</div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-default-500 mb-1">❌ Пропущенные</div>
                <div className="text-lg font-semibold">{missedPct}%</div>
              </div>
            </div>
          )}
          {voice && (
            <div className="mt-3 text-[11px] text-default-500">
              Всего обработанных звонков: {totalCalls}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Телефония и доступность */}
      {voice && (
        <Card shadow="sm" className="admin-card-light">
          <CardBody>
            <div className="text-xs font-semibold mb-2">Телефония и доступность</div>
            <div className="mb-3">
              <div className="flex justify-between text-[11px] text-default-500 mb-1">
                <span>Взяли / не взяли</span>
                <span>
                  {answeredPct}% / {missedPct}%
                </span>
              </div>
              <div className="h-2 rounded-full admin-progress-track overflow-hidden">
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${answeredPct}%` }}
                />
              </div>
            </div>

            <div className="text-[11px] text-default-500 mb-1">Исход звонков</div>
            <div className="space-y-1 text-[11px]">
              {(['completed', 'no_answer', 'busy', 'failed', 'disconnected'] as const).map((k) => {
                const labelMap: Record<string, string> = {
                  completed: 'Разговор состоялся',
                  no_answer: 'Не взяли трубку',
                  busy: 'Занято',
                  failed: 'Ошибка/сбой',
                  disconnected: 'Отключён',
                };
                const count = voice.outcomeBreakdown[k];
                const pct = voice.totalCalls > 0 ? Math.round((count / voice.totalCalls) * 100) : 0;
                if (!count) return null;
                const color =
                  k === 'completed'
                    ? 'bg-emerald-500'
                    : k === 'no_answer'
                    ? 'bg-rose-500'
                    : 'bg-amber-500';
                return (
                  <div key={k} className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${color}`} />
                    <div className="flex-1 flex justify-between">
                      <span>{labelMap[k]}</span>
                      <span className="text-default-500">
                        {pct}% ({count})
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {voice.avgDurationSec > 0 && (
              <div className="mt-3 text-[11px] text-default-500">
                Средняя длительность разговора: ~{voice.avgDurationSec} с
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Уровень сотрудников */}
      <Card shadow="sm" className="admin-card-light">
        <CardBody>
          <div className="text-xs font-semibold mb-2">Уровень сотрудников</div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-md admin-card-inner p-2">
              <div className="text-[11px] text-default-500 mb-1">Junior</div>
              <div className="text-lg font-semibold">{levelCounts.Junior}</div>
            </div>
            <div className="rounded-md admin-card-inner p-2">
              <div className="text-[11px] text-default-500 mb-1">Middle</div>
              <div className="text-lg font-semibold">{levelCounts.Middle}</div>
            </div>
            <div className="rounded-md admin-card-inner p-2">
              <div className="text-[11px] text-default-500 mb-1">Senior</div>
              <div className="text-lg font-semibold">{levelCounts.Senior}</div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Сильные / слабые стороны команды */}
      {(topWeaknesses.length > 0 || topStrengths.length > 0) && (
        <Card shadow="sm" className="admin-card-light">
          <CardBody className="grid grid-cols-1 gap-4">
            {topWeaknesses.length > 0 && (
              <div>
                <div className="text-xs font-semibold mb-1">Главные зоны для улучшения</div>
                <ul className="text-xs text-default-500 space-y-1 list-disc pl-4">
                  {topWeaknesses.map((w, idx) => (
                    <li key={idx}>
                      {w.weakness} <span className="text-[11px] text-default-500">({w.count})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {topStrengths.length > 0 && (
              <div>
                <div className="text-xs font-semibold mb-1">Сильные стороны команды</div>
                <ul className="text-xs text-default-500 space-y-1 list-disc pl-4">
                  {topStrengths.map((s, idx) => (
                    <li key={idx}>
                      {s.strength} <span className="text-[11px] text-default-500">({s.count})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Экспертное резюме */}
      {expertSummary && (
        <Card shadow="sm" className="admin-card-light">
          <CardBody>
            <div className="text-xs font-semibold mb-1">Экспертное резюме</div>
            <p className="text-xs text-default-500 whitespace-pre-line">{expertSummary}</p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function DealerCompaniesTab() {
  const [items, setItems] = useState<ScopedDealership[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`${API_BASE}/api/admin/dealerships`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить точки.');
        if (!cancelled) {
          setItems(Array.isArray(data.items) ? data.items as ScopedDealership[] : []);
        }
      } catch (loadError) {
        if (!cancelled) {
          setItems([]);
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить точки.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-3">
      <Card shadow="sm" className="admin-card-light">
        <CardBody>
          <div className="text-sm font-semibold mb-1">Точка</div>
          <p className="text-xs text-default-500 mb-3">
            Реальные данные по доступным точкам из org-структуры.
          </p>
          {loading && <div className="text-xs text-default-500">Загрузка...</div>}
          {error && <div className="text-xs text-danger">{error}</div>}
          <div className="space-y-2 text-xs">
            {items.map((d) => (
              <div
                key={d.id}
                className="rounded-md admin-card-inner p-2 flex justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="font-semibold truncate">{d.name}</div>
                  <div className="text-[11px] text-default-500">
                    Город: {d.city || '—'} · Компания: {d.holdingName || 'Без компании'} · Менеджеров: {d.managersCount}
                  </div>
                  <div className="text-[11px] text-default-500">
                    {d.address || 'Адрес не указан'}
                  </div>
                </div>
                <div className="text-right text-[11px]">
                  <div className="text-xs text-default-500">Статус</div>
                  <div className="text-sm font-semibold">{d.isActive ? 'Активен' : 'Отключён'}</div>
                </div>
              </div>
            ))}
            {!loading && !error && items.length === 0 && (
              <div className="text-xs text-default-500">Нет доступных точек.</div>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  DealerContent – self-contained dealer view with tab switcher          */
/* ─────────────────────────────────────────────────────────────────────── */

export type DealerTab = 'dealer-companies' | 'dealer-employees' | 'dealer-calls' | 'dealer-team';

export function DealerContent(props: { summary: any; voice: any; loadingSummary: boolean; activeTab: DealerTab }) {
  const activeTab = props.activeTab;

  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [attemptsError, setAttemptsError] = useState<string | null>(null);

  const [teamSummary, setTeamSummary] = useState<TeamSummary | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);

  const [voiceDashboard, setVoiceDashboard] = useState<VoiceDashboard | null>(null);

  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [callsLoading, setCallsLoading] = useState(false);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [callFilters, setCallFilters] = useState<CallFilters>({ source: 'all', status: 'all', dealershipId: '', planId: '' });
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);
  const [callDetail, setCallDetail] = useState<CallDetail | null>(null);
  const [callDetailLoading, setCallDetailLoading] = useState(false);
  const [callDetailError, setCallDetailError] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [startCallLoading, setStartCallLoading] = useState(false);
  const [startCallStatus, setStartCallStatus] = useState<string | null>(null);
  const [dealerCardView, setDealerCardView] = useState<'list' | 'call' | 'attempt'>('list');
  const [selectedAttemptForPage, setSelectedAttemptForPage] = useState<Attempt | null>(null);

  useEffect(() => {
    setDealerCardView('list');
    setSelectedAttemptForPage(null);
    setSelectedCallId(null);
    if (activeTab === 'dealer-employees') {
      loadAttempts();
    } else if (activeTab === 'dealer-calls') {
      loadCalls();
    } else if (activeTab === 'dealer-team') {
      loadTeamSummary();
    }
  }, [activeTab]);

  async function safeFetchJson(url: string): Promise<any> {
    try {
      const res = await apiFetch(url);
      if (!res.ok) return null;
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function loadAttempts() {
    setAttemptsLoading(true);
    setAttemptsError(null);
    try {
      const data = await safeFetchJson(`${API_BASE}/api/admin/attempts?page=0&limit=1000`);
      const list = data?.attempts ?? [];
      setAttempts(list.length ? list : (isDevHost ? buildMockAttempts() : []));
    } catch {
      setAttempts(isDevHost ? buildMockAttempts() : []);
    } finally {
      setAttemptsLoading(false);
    }
  }

  async function loadCalls() {
    setCallsLoading(true);
    setCallsError(null);
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (callFilters.source !== 'all') query.set('source', callFilters.source);
      if (callFilters.status !== 'all') query.set('status', callFilters.status);
      if (callFilters.dealershipId) query.set('dealershipId', callFilters.dealershipId);
      if (callFilters.planId) query.set('planId', callFilters.planId);
      const data = await safeFetchJson(`${API_BASE}/api/admin/call-history?${query.toString()}`);
      setCalls(data?.calls ?? []);
    } catch {
      setCalls([]);
    } finally {
      setCallsLoading(false);
    }
  }

  async function loadTeamSummary() {
    setTeamLoading(true);
    setTeamError(null);
    try {
      const [data, voiceRes] = await Promise.all([
        safeFetchJson(`${API_BASE}/api/admin/summary`),
        safeFetchJson(`${API_BASE}/api/admin/voice-dashboard`),
      ]);
      if (data) {
        setTeamSummary({
          totalAttempts: data.totalAttempts ?? 0,
          avgScore: data.avgScore ?? 0,
          levelCounts: data.levelCounts ?? { Junior: 0, Middle: 0, Senior: 0 },
          topWeaknesses: Array.isArray(data.topWeaknesses) ? data.topWeaknesses : [],
          topStrengths: Array.isArray(data.topStrengths) ? data.topStrengths : [],
          expertSummary: typeof data.expertSummary === 'string' ? data.expertSummary : null,
        });
      } else if (isDevHost) {
        setTeamSummary(buildMockTeamSummary());
      }
      if (voiceRes) {
        setVoiceDashboard({
          totalCalls: voiceRes.totalCalls ?? 0,
          answeredPercent: voiceRes.answeredPercent ?? 0,
          missedPercent: voiceRes.missedPercent ?? 0,
          avgDurationSec: voiceRes.avgDurationSec ?? 0,
          outcomeBreakdown: {
            completed: voiceRes.outcomeBreakdown?.completed ?? 0,
            no_answer: voiceRes.outcomeBreakdown?.no_answer ?? 0,
            busy: voiceRes.outcomeBreakdown?.busy ?? 0,
            failed: voiceRes.outcomeBreakdown?.failed ?? 0,
            disconnected: voiceRes.outcomeBreakdown?.disconnected ?? 0,
          },
        });
      } else if (isDevHost) {
        setVoiceDashboard(buildMockVoiceDashboard());
      }
    } catch {
      if (isDevHost) {
        setTeamSummary(buildMockTeamSummary());
        setVoiceDashboard(buildMockVoiceDashboard());
      }
    } finally {
      setTeamLoading(false);
    }
  }

  async function handleStartCall() {
    if (!phone.trim()) {
      setStartCallStatus('Введите номер телефона.');
      return;
    }
    setStartCallLoading(true);
    setStartCallStatus('Инициируем звонок...');
    try {
      const res = await apiFetch(`${API_BASE}/api/admin/start-voice-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: phone.trim(), scenario: 'realtime_pure' }),
      });
      if (!res.ok) {
        const data = await res.text().then(t => t ? JSON.parse(t) : {}).catch(() => ({}));
        setStartCallStatus(data.error || `Бэкенд недоступен (${res.status})`);
      } else {
        const data = await res.text().then(t => t ? JSON.parse(t) : {}).catch(() => ({}));
        setStartCallStatus(`Звонок инициирован. Номер: ${data.to || phone}`);
        loadCalls();
      }
    } catch (e: any) {
      setStartCallStatus(`Ошибка: ${e?.message || 'неизвестная ошибка'}`);
    } finally {
      setStartCallLoading(false);
    }
  }

  async function loadCallDetail(id: number) {
    setSelectedCallId(id);
    setCallDetail(null);
    setCallDetailError(null);
    setCallDetailLoading(true);
    try {
      const data = await safeFetchJson(`${API_BASE}/api/admin/call-history/${id}`);
      if (data) {
        setCallDetail(data);
      } else if (isDevHost) {
        setCallDetail(buildMockCallDetail(id));
      } else {
        setCallDetailError('Данные недоступны. Запустите бэкенд.');
      }
    } catch {
      if (isDevHost) {
        setCallDetail(buildMockCallDetail(id));
      } else {
        setCallDetailError('Данные недоступны. Запустите бэкенд.');
      }
    } finally {
      setCallDetailLoading(false);
    }
  }

  return (
    <div>
      {activeTab === 'dealer-companies' && <DealerCompaniesTab />}
      {activeTab === 'dealer-calls' && (
        <CallsTab
          loading={callsLoading}
          error={callsError}
          calls={calls}
          phone={phone}
          onPhoneChange={setPhone}
          startCallLoading={startCallLoading}
          startCallStatus={startCallStatus}
          onStartCall={handleStartCall}
          selectedCallId={selectedCallId}
          callDetail={callDetail}
          callDetailLoading={callDetailLoading}
          callDetailError={callDetailError}
          onSelectCall={(id) => { loadCallDetail(id); setDealerCardView('call'); }}
          callViewMode={dealerCardView as 'list' | 'call'}
          onCallCardPageBack={() => setDealerCardView('list')}
          filters={callFilters}
          onFiltersChange={setCallFilters}
          onRefreshCalls={loadCalls}
        />
      )}
      {activeTab === 'dealer-employees' && (
        <EmployeesTab
          loading={attemptsLoading}
          error={attemptsError}
          attempts={attempts}
          attemptViewMode={dealerCardView as 'list' | 'attempt'}
          selectedAttemptForPage={selectedAttemptForPage}
          onAttemptCardPageBack={() => { setDealerCardView('list'); setSelectedAttemptForPage(null); }}
          onOpenAttemptPage={(a) => { setSelectedAttemptForPage(a); setDealerCardView('attempt'); }}
        />
      )}
      {activeTab === 'dealer-team' && (
        <TeamTab
          loading={teamLoading || props.loadingSummary}
          error={teamError}
          summary={teamSummary ?? props.summary}
          voice={voiceDashboard ?? props.voice}
        />
      )}
    </div>
  );
}
