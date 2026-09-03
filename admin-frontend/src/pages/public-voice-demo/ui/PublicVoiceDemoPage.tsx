import React, { useEffect, useMemo, useState } from 'react';
import { CallInsightCard, type CallInsightDetail } from '../../../widgets/call-insight-card';
import './public-voice-demo.css';
import { computeMockFromTranscript, type TranscriptTurn } from '../lib/demoMockEvaluation';
import { buildPrecomputedExampleDetail } from '../lib/demoExampleReportsLoader';
import { DEMO_REPORT_EXAMPLES, type ExampleTier } from '../model/demoReportExamples';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { DemoUnifiedReport } from './DemoUnifiedReport';

const API_BASE = '';
const CALL_ID_PARAM = 'callId';
const MOCK_CALL_ID = 'mock';
const NATIONAL_LEN = 10;

/** UI-only: open `/demo-call?previewWait=call` or `...&previewWait=processing` to see waiting screens without a call. */
type PreviewWaitConfig =
  | { kind: 'call' }
  | { kind: 'processing'; stage: 'transcript' | 'evaluation' };

function readPreviewWaitConfig(): PreviewWaitConfig | null {
  const params = new URLSearchParams(window.location.search);
  const w = params.get('previewWait')?.trim().toLowerCase();
  if (!w) return null;
  if (w === 'call' || w === 'conversation') return { kind: 'call' };
  if (w === 'processing' || w === 'analytics') {
    const stage = params.get('previewStage')?.trim().toLowerCase();
    if (stage === 'transcript') return { kind: 'processing', stage: 'transcript' };
    return { kind: 'processing', stage: 'evaluation' };
  }
  return null;
}

type DemoCallState = CallInsightDetail & {
  callId: string;
  transcriptTurns: number;
  hasEvaluation: boolean;
  isProcessing: boolean;
  processingStage: 'transcript' | 'evaluation' | null;
  unifiedReport?: AuditDetailItem['unifiedReport'];
};

function buildPreviewCallWaitingDetail(): DemoCallState {
  const now = Date.now();
  return {
    id: -2,
    to: '+7 999 123 45 67',
    startedAt: new Date(now - 90_000).toISOString(),
    endedAt: null,
    outcome: null,
    durationSec: null,
    totalScore: null,
    qualityTag: null,
    strengths: [],
    weaknesses: [],
    recommendations: [],
    transcript: [],
    dimensionScores: null,
    processingError: null,
    callSummary: null,
    replyImprovements: null,
    callId: 'preview-call',
    transcriptTurns: 0,
    hasEvaluation: false,
    isProcessing: false,
    processingStage: null,
  };
}

function buildPreviewProcessingWaitingDetail(stage: 'transcript' | 'evaluation'): DemoCallState {
  const now = Date.now();
  return {
    id: -3,
    to: '+7 999 123 45 67',
    startedAt: new Date(now - 120_000).toISOString(),
    endedAt: new Date(now - 8000).toISOString(),
    outcome: 'completed',
    durationSec: 112,
    totalScore: null,
    qualityTag: null,
    strengths: [],
    weaknesses: [],
    recommendations: [],
    transcript: [],
    dimensionScores: null,
    processingError: null,
    callSummary: null,
    replyImprovements: null,
    callId: 'preview-processing',
    transcriptTurns: 0,
    hasEvaluation: false,
    isProcessing: true,
    processingStage: stage,
  };
}

function readCallIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(CALL_ID_PARAM);
  return value && value.trim() ? value.trim() : null;
}

function writeCallIdToUrl(callId: string | null) {
  const url = new URL(window.location.href);
  if (callId) url.searchParams.set(CALL_ID_PARAM, callId);
  else url.searchParams.delete(CALL_ID_PARAM);
  window.history.replaceState({}, '', url.toString());
}

function isCallFinal(detail: DemoCallState | null): boolean {
  if (!detail || !detail.endedAt) return false;
  if (detail.isProcessing) return false;
  return detail.hasEvaluation || !!detail.processingError || detail.transcriptTurns > 0;
}

type WaitingPhase = 'call_active' | 'processing';

/** Пока нет `endedAt` с сервера — считаем, что идёт живой разговор. После — обработка и отчёт. */
function getWaitingPhase(detail: DemoCallState | null): WaitingPhase {
  if (!detail) return 'call_active';
  if (!detail.endedAt) return 'call_active';
  return 'processing';
}

function waitingStatusLabel(phase: WaitingPhase, detail: DemoCallState | null): string {
  if (phase === 'call_active') return 'На линии';
  if (detail?.isProcessing && detail.processingStage === 'evaluation') return 'Формируем аналитику и отчёт…';
  if (detail?.isProcessing && detail.processingStage === 'transcript') return 'Получаем расшифровку…';
  return 'Завершаем подготовку отчёта…';
}

function buildMockDetail(to: string): DemoCallState {
  const now = Date.now();
  const startedAt = new Date(now - 1000 * 62).toISOString();
  const endedAt = new Date(now - 1000 * 7).toISOString();
  const transcript: TranscriptTurn[] = [
    { role: 'client', text: 'Здравствуйте. Подскажите, Toyota Camry есть в наличии?' },
    { role: 'manager', text: 'Добрый день! Да, Camry есть. Подскажите, какую комплектацию и год рассматриваете?' },
    { role: 'client', text: 'Скорее 2.5, комплектация побогаче. И сколько стоит?' },
    { role: 'manager', text: 'Цена зависит от комплектации и пробега. Есть разные варианты.' },
    { role: 'client', text: 'А в кредит можно? И у меня есть машина в трейд-ин.' },
    { role: 'manager', text: 'Да, кредит возможен. Трейд-ин тоже делаем.' },
    { role: 'client', text: 'Дорого получается.' },
    { role: 'manager', text: 'Ну, цены сейчас такие. Можем посмотреть.' },
    { role: 'client', text: 'Я бы хотел приехать посмотреть, но не уверен.' },
    { role: 'manager', text: 'Хорошо, приезжайте.' },
  ];
  const computed = computeMockFromTranscript(transcript);
  return {
    id: -1,
    to,
    startedAt,
    endedAt,
    outcome: computed.outcome,
    durationSec: computed.durationSec,
    totalScore: computed.totalScore,
    qualityTag: computed.qualityTag,
    strengths: computed.strengths,
    weaknesses: computed.weaknesses,
    recommendations: computed.recommendations,
    dimensionScores: computed.dimensionScores,
    processingError: null,
    callSummary: computed.callSummary,
    replyImprovements: computed.replyImprovements,
    transcript,
    callId: MOCK_CALL_ID,
    transcriptTurns: transcript.length,
    hasEvaluation: true,
    isProcessing: false,
    processingStage: null,
  };
}

/** 10 digits after country code (RU); strips leading 7/8 when 11 digits pasted. */
function parseNationalDigits(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d.length >= 11 && d.startsWith('8')) d = d.slice(1);
  if (d.length >= 11 && d.startsWith('7')) d = d.slice(1);
  return d.slice(0, NATIONAL_LEN);
}

function formatNationalSpaced(national: string): string {
  let s = '';
  for (let i = 0; i < national.length; i++) {
    if (i === 3 || i === 6 || i === 8) s += ' ';
    s += national[i];
  }
  return s;
}

function formatE164FromNational(national: string): string {
  return `+7${national}`;
}

export function PublicVoiceDemoPage() {
  const [previewConfig] = useState<PreviewWaitConfig | null>(() => readPreviewWaitConfig());
  const [nationalDigits, setNationalDigits] = useState('');
  const [callId, setCallId] = useState<string | null>(() => readCallIdFromUrl());
  const [detail, setDetail] = useState<DemoCallState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewWaitingDetail = useMemo((): DemoCallState | null => {
    if (!previewConfig) return null;
    if (previewConfig.kind === 'call') return buildPreviewCallWaitingDetail();
    return buildPreviewProcessingWaitingDetail(previewConfig.stage);
  }, [previewConfig]);

  const effectiveWaitingDetail = previewWaitingDetail ?? detail;

  useEffect(() => {
    if (previewConfig) return;
    writeCallIdToUrl(callId);
  }, [callId, previewConfig]);

  /** Старые ссылки `?callId=mock` без локального state — подставляем единый mock-отчёт. */
  useEffect(() => {
    if (previewConfig) return;
    if (callId !== MOCK_CALL_ID || detail) return;
    const to = nationalDigits.length === NATIONAL_LEN ? formatE164FromNational(nationalDigits) : '+79999999999';
    setDetail(buildMockDetail(to));
  }, [callId, detail, previewConfig, nationalDigits]);

  useEffect(() => {
    if (previewConfig) return;
    if (!callId || callId === MOCK_CALL_ID || isCallFinal(detail)) return;

    let cancelled = false;

    const loadDetail = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/public/demo-call/${encodeURIComponent(callId)}`);
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        if (!response.ok) {
          throw new Error(data?.error || 'Не удалось получить статус звонка.');
        }
        if (cancelled) return;
        setDetail(data as DemoCallState);
        setNationalDigits((current) => {
          if (current.length === NATIONAL_LEN) return current;
          return parseNationalDigits(String(data?.to ?? ''));
        });
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Не удалось получить статус звонка.');
      }
    };

    loadDetail();
    const interval = window.setInterval(() => {
      loadDetail().catch(() => {});
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [callId, detail, previewConfig]);

  const screenState = useMemo<'form' | 'waiting' | 'result'>(() => {
    if (previewConfig) return 'waiting';
    if (!callId) return 'form';
    return isCallFinal(detail) ? 'result' : 'waiting';
  }, [previewConfig, callId, detail]);

  const waitingPhase = useMemo(() => getWaitingPhase(effectiveWaitingDetail), [effectiveWaitingDetail]);
  const waitingStatus = useMemo(
    () => waitingStatusLabel(waitingPhase, effectiveWaitingDetail),
    [waitingPhase, effectiveWaitingDetail]
  );

  const processingSteps = useMemo(
    () => [
      { label: 'Оцениваем диалог', kind: 'eval' as const },
      { label: 'Считаем показатели', kind: 'metrics' as const },
      { label: 'Собираем рекомендации', kind: 'reco' as const },
      { label: 'Формируем отчёт', kind: 'final' as const },
    ],
    []
  );

  const [processingStep, setProcessingStep] = useState(0);
  const [exampleTier, setExampleTier] = useState<ExampleTier | null>(null);

  const exampleReportDetail = useMemo((): CallInsightDetail | null => {
    if (!exampleTier || previewConfig) return null;
    return buildPrecomputedExampleDetail(exampleTier);
  }, [exampleTier, previewConfig]);

  useEffect(() => {
    if (waitingPhase !== 'processing') return;
    const id = window.setInterval(() => {
      setProcessingStep((s) => (s + 1) % processingSteps.length);
    }, 950);
    return () => window.clearInterval(id);
  }, [waitingPhase, processingSteps.length]);

  async function handleStartCall() {
    if (nationalDigits.length !== NATIONAL_LEN) {
      setError('Введите полный номер: 10 цифр после +7.');
      return;
    }
    const to = formatE164FromNational(nationalDigits);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/public/demo-call/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, scenario: 'realtime_pure' }),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(data?.error || `Не удалось запустить звонок (${response.status}).`);
      }
      setCallId(data.callId);
      setDetail(null);
      setExampleTier(null);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Не удалось запустить звонок.');
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    if (previewConfig) {
      window.location.assign(window.location.pathname);
      return;
    }
    setCallId(null);
    setDetail(null);
    setError(null);
    setNationalDigits('');
    setExampleTier(null);
  }

  function handleCloseExampleReport() {
    setExampleTier(null);
  }

  function onPhoneInputChange(raw: string) {
    setNationalDigits(parseNationalDigits(raw));
  }

  const displayPhone =
    nationalDigits.length > 0 ? formatNationalSpaced(nationalDigits) : '';
  const waitingNumber =
    effectiveWaitingDetail?.to ||
    (nationalDigits.length ? formatE164FromNational(nationalDigits) : '—');

  return (
    <div className="admin-app demo-call-brutal min-h-screen">
      <div className="demo-call-brutal__inner">
        <div className="demo-call-brutal__hero-block">
          <div className="demo-call-brutal__brand" aria-label="Sales Boost">
            Sales Boost
          </div>

          <h1 className="demo-call-brutal__title">
            <span className="demo-call-brutal__title-line">Узнайте, выдержит ли ваш бизнес</span>
            <span className="demo-call-brutal__title-line">первый разговор</span>
          </h1>
          <p className="demo-call-brutal__subtitle">Оставьте номер и получите разбор диалога</p>

          {screenState === 'form' && !exampleTier && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleStartCall();
                }}
              >
                <div
                  className={
                    previewConfig
                      ? 'demo-call-brutal__pill'
                      : 'demo-call-brutal__pill demo-call-brutal__pill--attention'
                  }
                >
                  <span className="demo-call-brutal__prefix" aria-hidden>
                    +7
                  </span>
                  <div className="demo-call-brutal__input-wrap">
                    <input
                      className="demo-call-brutal__input"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      placeholder="999 999 99 99"
                      aria-label="Номер телефона"
                      value={displayPhone}
                      onChange={(e) => onPhoneInputChange(e.target.value)}
                    />
                  </div>
                  <button type="submit" className="demo-call-brutal__cta" disabled={loading}>
                    {loading ? 'Звоним…' : 'Позвонить'}
                  </button>
                </div>
              </form>
              {error && <div className="demo-call-brutal__error">{error}</div>}
            </>
          )}
        </div>

        {screenState === 'form' && !exampleTier && (
          <section className="demo-examples" aria-labelledby="demo-examples-heading">
            <h2 id="demo-examples-heading" className="demo-examples__title">
              Три звонка — три судьбы
            </h2>
            <p className="demo-examples__subtitle">Примеры диалогов</p>
            <div className="demo-examples__grid">
              {DEMO_REPORT_EXAMPLES.map((ex) => (
                <article key={ex.id} className="demo-example-card">
                  <div className="demo-example-card__tier">
                    <span className={`demo-example-card__dot ${ex.dotClass}`} aria-hidden />
                    <span className="demo-example-card__tier-label">{ex.managerLabel}</span>
                  </div>
                  <h3 className="demo-example-card__name">{ex.title}</h3>
                  <p className="demo-example-card__teaser">{ex.teaser}</p>
                  <button
                    type="button"
                    className="demo-example-card__cta"
                    onClick={() => setExampleTier(ex.id)}
                  >
                    Открыть отчёт
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        {screenState === 'form' && exampleTier && exampleReportDetail && (
          <div>
            <div className="demo-brutal-insight-wrap">
              <CallInsightCard detail={exampleReportDetail} />
            </div>
            <button type="button" className="demo-brutal-btn-secondary" onClick={handleCloseExampleReport}>
              На главную
            </button>
          </div>
        )}

        {screenState === 'waiting' && (
          <div>
            <div className="demo-brutal-panel">
              {waitingPhase === 'call_active' ? (
                <>
                  <div className="demo-wait-visual demo-wait-visual--call" aria-hidden>
                    <span className="demo-wait-bars">
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  <div className="demo-brutal-panel__title">Идёт разговор</div>
                  <p className="demo-brutal-panel__text demo-brutal-panel__text--compact">
                    Завершите диалог и мы подготовим отчёт
                  </p>
                </>
              ) : (
                <>
                  <div className="demo-wait-visual demo-wait-visual--report" aria-hidden>
                    <div className="demo-wait-doc demo-wait-doc--lg">
                      <div className="demo-wait-doc__line" />
                      <div className="demo-wait-doc__line" />
                      <div className="demo-wait-doc__line demo-wait-doc__line--short" />
                      <div className="demo-wait-doc__scan" />
                    </div>
                  </div>
                  <div className="demo-brutal-panel__title">Готовим разбор</div>

                  <div className="demo-wait-steps" aria-label="Этапы обработки">
                    {processingSteps.map((s, idx) => {
                      const active = idx === processingStep;
                      const done = idx < processingStep;
                      return (
                        <div
                          key={s.kind}
                          className={[
                            'demo-wait-step',
                            active ? 'demo-wait-step--active' : '',
                            done ? 'demo-wait-step--done' : '',
                          ].filter(Boolean).join(' ')}
                        >
                          <span className="demo-wait-step__dot" aria-hidden />
                          <span className="demo-wait-step__text">{s.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              {waitingPhase === 'call_active' && (
                <div className="demo-first-block__tech demo-wait-details">
                  <div className="demo-first-block__tech-row">
                    <div className="demo-first-block__tech-k">Номер</div>
                    <div className="demo-first-block__tech-v">{waitingNumber}</div>
                  </div>
                  <div className="demo-first-block__tech-row">
                    <div className="demo-first-block__tech-k">Статус</div>
                    <div className="demo-first-block__tech-v">{waitingStatus}</div>
                  </div>
                </div>
              )}
              {error && <div className="demo-call-brutal__error" style={{ marginTop: '1rem' }}>{error}</div>}
            </div>
            <button type="button" className="demo-brutal-btn-secondary" onClick={handleReset}>
              Сбросить и ввести другой номер
            </button>
          </div>
        )}

        {screenState === 'result' && detail && (
          <div>
            <div className="demo-brutal-insight-wrap">
              {detail.unifiedReport
                ? <DemoUnifiedReport report={detail.unifiedReport} />
                : <CallInsightCard detail={detail} />}
            </div>
            <button type="button" className="demo-brutal-btn-primary" onClick={handleReset}>
              Запустить новый звонок
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
