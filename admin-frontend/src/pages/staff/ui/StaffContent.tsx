import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchTrainerHistory,
  fetchTrainerProfile,
  type TrainerProfile,
  type TrainerSessionSummary,
} from '../../../shared/api/trainer';
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

function uniqueNonEmpty(values: Array<string | null | undefined>, limit: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

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
    const avgScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    const bestScore = scores.length ? Math.max(...scores) : 0;
    const passRate = scores.length ? Math.round((scores.filter((score) => score >= 76).length / scores.length) * 100) : 0;
    const recentScores = scoredHistory.slice(0, 10).map((item) => Math.round(Number(item.score))).reverse();
    const strengths = uniqueNonEmpty(
      scoredHistory
        .filter((item) => Number(item.score) >= 85)
        .map((item) => item.scenarioName),
      3,
    );
    const weaknesses = uniqueNonEmpty(
      scoredHistory
        .filter((item) => Number(item.score) < 76)
        .map((item) => trainerFailureReasonLabel(item.failureReason) || item.scenarioName),
      3,
    );
    return {
      totalTests: profile?.sessionsTotal ?? completedHistory.length,
      avgScore,
      bestScore,
      passRate,
      recentScores,
      strengths,
      weaknesses,
    };
  }, [completedHistory.length, profile?.sessionsTotal, scoredHistory]);
  const scoreColor = (s: number) => s >= 76 ? 'text-success-400' : s >= 50 ? 'text-warning-400' : 'text-danger-400';

  return (
    <div className="space-y-4">
      {error && (
        <Card shadow="sm" className="admin-card-light">
          <CardBody>
            <p className="text-xs text-danger-400">{error}</p>
          </CardBody>
        </Card>
      )}

      {/* Profile header */}
      <Card shadow="sm" className="admin-card-light">
        <CardBody>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">{loading ? 'Загрузка…' : profile?.fullName ?? 'Профиль не найден'}</div>
              <div className="text-[12px] text-default-500">
                {profile ? `${profile.branchName}${profile.city ? `, ${profile.city}` : ''} · ${profile.companyName}` : 'Нет данных о сотруднике'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-default-500">AI‑баллы</div>
              <div className="text-2xl font-bold">{profile?.totalPoints ?? 0}</div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Всего тестов', value: String(stats.totalTests), sub: null },
          { label: 'Средний балл', value: stats.avgScore.toFixed(1), sub: null },
          { label: 'Лучший балл', value: String(stats.bestScore), sub: null },
          { label: '% прохождения', value: `${stats.passRate}%`, sub: null },
        ].map((kpi) => (
          <Card key={kpi.label} shadow="sm" className="admin-card-light">
            <CardBody className="text-center py-3">
              <div className="text-[11px] text-default-500 mb-1">{kpi.label}</div>
              <div className="text-xl font-bold">{kpi.value}</div>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Strengths & Weaknesses */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card shadow="sm" className="admin-card-light">
          <CardBody>
            <div className="text-sm font-semibold mb-2">✅ Лучшие сценарии</div>
            <div className="space-y-1">
              {stats.strengths.length === 0 ? (
                <div className="text-xs text-default-500">Появятся после тренировок с высоким баллом.</div>
              ) : stats.strengths.map((s, i) => (
                <div key={i} className="text-xs text-default-500 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  {s}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
        <Card shadow="sm" className="admin-card-light">
          <CardBody>
            <div className="text-sm font-semibold mb-2">⚠️ Зоны роста</div>
            <div className="space-y-1">
              {stats.weaknesses.length === 0 ? (
                <div className="text-xs text-default-500">Пока нет сессий ниже проходного порога.</div>
              ) : stats.weaknesses.map((w, i) => (
                <div key={i} className="text-xs text-default-500 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                  {w}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Recent scores chart */}
      <Card shadow="sm" className="admin-card-light">
        <CardBody>
          <div className="text-sm font-semibold mb-3">Динамика баллов (последние 10 тестов)</div>
          {stats.recentScores.length === 0 ? (
            <p className="text-xs text-default-500">Нет завершённых тренировок с оценкой.</p>
          ) : (
            <div className="flex items-end gap-2 h-24">
              {stats.recentScores.map((s, i) => {
                const pct = Math.max(10, s);
                const color = s >= 76 ? 'bg-emerald-500' : s >= 50 ? 'bg-amber-500' : 'bg-rose-500';
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <div className="text-[10px] text-default-500">{s}</div>
                    <div className={`w-full rounded-t ${color}`} style={{ height: `${pct}%` }} />
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Recent attempts */}
      <Card shadow="sm" className="admin-card-light">
        <CardBody>
          <div className="text-sm font-semibold mb-3">Последние тренировки</div>
          {loading ? (
            <p className="text-xs text-default-500">Загрузка…</p>
          ) : history.length === 0 ? (
            <p className="text-xs text-default-500">Нет данных о тренировках.</p>
          ) : (
            <div className="space-y-2">
              {history.slice(0, 5).map((a) => {
                const score = a.score;
                const sc = score == null ? 'text-default-500' : scoreColor(score);
                const finishedAt = a.completedAt ?? a.startedAt;
                const qualityTag = trainerQualityTag(score);
                return (
                  <div key={a.id} className="flex items-center justify-between rounded-xl admin-card-inner px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{a.scenarioName || 'Тренировка'}</div>
                      <div className="text-[10px] text-default-500">
                        {finishedAt ? new Date(finishedAt).toLocaleDateString('ru-RU') : '—'}
                        {qualityTag && ` · ${qualityTag}`}
                      </div>
                    </div>
                    <div className={`text-base font-bold ml-3 ${sc}`}>
                      {score != null ? score.toFixed(0) : 'Н/Д'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
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
