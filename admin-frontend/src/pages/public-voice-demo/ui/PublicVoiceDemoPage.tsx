import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CallInsightCard, type CallInsightDetail } from '../../../widgets/call-insight-card';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { AuditAnalyticsReport } from '../../../widgets/audit-analytics-report';
import { FlowButton } from '../../landing/ui/FlowButton';
import { FinalDemoBlock } from '../../landing/ui/FinalDemoBlock';
import { LandingHeader } from '../../landing/ui/LandingHeader';
import { TryClientPicker } from '../../landing/ui/TryClientPicker';
import { SalsaLogo } from '../../../shared/ui/logo/SalsaLogo';
import { LANDING_HOME, LEGAL_NAV, OPERATOR_ADDRESS } from '../../landing/lib/legalDocuments';
import { DEFAULT_TRY_CLIENT_ID, TRY_CLIENTS, isTryClientId, type TryClientId } from '../../landing/lib/tryClients';
import '../../../shared/ui/styles/admin-panel.css';
import '../../../shared/ui/styles/theme-brutal.css';
import '../../landing/ui/landing.css';
import './public-voice-demo.css';

function GridEnds() {
  return (
    <>
      <span className="sl-x sl-x-l" aria-hidden>+</span>
      <span className="sl-x sl-x-r" aria-hidden>+</span>
    </>
  );
}

const API_BASE = '';
const CALL_ID_PARAM = 'callId';
const PHONE_PARAM = 'phone';
const SCRIPT_PARAM = 'script';
const LEGACY_CLIENT_PARAM = 'client';
const NATIONAL_LEN = 10;

type DemoClientId = TryClientId;

type DemoCallState = CallInsightDetail & {
  callId: string;
  transcriptTurns: number;
  hasEvaluation: boolean;
  isProcessing: boolean;
  processingStage: 'transcript' | 'evaluation' | null;
  unifiedReport?: AuditDetailItem['unifiedReport'];
  recordingStatus?: AuditDetailItem['recordingStatus'];
  recordingUrl?: string | null;
};

function apiErrorMessage(status: number, fallback: string): string {
  if (status === 429) return 'Слишком много запросов. Подождите несколько секунд.';
  if (status === 502 || status === 503 || status === 504) {
    return 'Сервис временно недоступен. Повторяем запрос…';
  }
  return `${fallback} (HTTP ${status}).`;
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(apiErrorMessage(response.status, fallback));
    }
  }
  if (!response.ok) {
    const serverMessage = data && typeof data === 'object' && 'error' in data
      ? String((data as { error?: unknown }).error || '')
      : '';
    throw new Error(serverMessage || apiErrorMessage(response.status, fallback));
  }
  if (data == null || typeof data !== 'object') {
    throw new Error(`${fallback}: сервер вернул некорректный ответ.`);
  }
  return data as T;
}

function readCallIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(CALL_ID_PARAM);
  return value && value.trim() ? value.trim() : null;
}

function readPhoneFromUrl(): string {
  return new URLSearchParams(window.location.search).get(PHONE_PARAM)?.trim() || '';
}

function readDemoClientIdFromUrl(): DemoClientId {
  const params = new URLSearchParams(window.location.search);
  const value = (params.get(SCRIPT_PARAM) || params.get(LEGACY_CLIENT_PARAM))?.trim().toLowerCase();
  return isTryClientId(value) ? value : DEFAULT_TRY_CLIENT_ID;
}

function shouldAutoStartFromUrl(params: URLSearchParams): boolean {
  if (params.get(CALL_ID_PARAM)?.trim()) return false;
  const value = (params.get(SCRIPT_PARAM) || params.get(LEGACY_CLIENT_PARAM))?.trim().toLowerCase();
  return parseNationalDigits(params.get(PHONE_PARAM)?.trim() || '').length === NATIONAL_LEN && isTryClientId(value);
}

function stripDemoCallParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(CALL_ID_PARAM);
  next.delete(PHONE_PARAM);
  next.delete(SCRIPT_PARAM);
  next.delete(LEGACY_CLIENT_PARAM);
  return next;
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

function formatDisplayPhone(raw: string | undefined): string {
  if (!raw || raw === '—') return '';
  const national = parseNationalDigits(raw);
  if (national.length === NATIONAL_LEN) return formatPhoneFieldValue(national, true).trim();
  return raw;
}

function parseNationalDigits(input: string): string {
  const trimmed = input.trim();
  let d = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+7') || trimmed.startsWith('+')) {
    if (d.startsWith('7')) d = d.slice(1);
  } else if (d.length >= 11 && (d.startsWith('8') || d.startsWith('7'))) {
    d = d.slice(1);
  }
  return d.slice(0, NATIONAL_LEN);
}

function formatNationalSpaced(national: string): string {
  const a = national.slice(0, 3);
  const b = national.slice(3, 6);
  const c = national.slice(6, 8);
  const d = national.slice(8, 10);
  let s = a;
  if (b) s += ` ${b}`;
  if (c) s += `-${c}`;
  if (d) s += `-${d}`;
  return s;
}

function formatPhoneFieldValue(national: string, focused: boolean): string {
  if (!national && !focused) return '';
  const rest = formatNationalSpaced(national);
  return rest ? `+7 ${rest}` : '+7 ';
}

function formatE164FromNational(national: string): string {
  return `+7${national}`;
}

function demoCallToAuditDetail(detail: DemoCallState): AuditDetailItem | null {
  const report = detail.unifiedReport;
  if (!report) return null;
  const status: AuditDetailItem['status'] =
    detail.outcome === 'failed' ? 'failed' : detail.outcome === 'disconnected' ? 'interrupted' : 'completed';
  return {
    id: String(detail.callId || detail.id),
    type: 'call',
    dateTime: detail.startedAt ?? new Date().toISOString(),
    employeeId: '',
    employeeName: 'Менеджер',
    dealershipId: '',
    dealershipName: 'Демо-стенд',
    city: '',
    totalScore: report.totalScore,
    verdict: report.verdict,
    status,
    duration: detail.durationSec ?? 0,
    communicationFlag: 'ok',
    blocksBreakdown: [],
    checklist: [],
    transcript: [],
    events: [],
    errors: [],
    topQuestions: [],
    recommendedTrainings: [],
    answerTimeSec: null,
    attempts: 1,
    callback: false,
    scenarioName: 'Демо-звонок',
    assignedBy: null,
    failReason: detail.processingError ?? null,
    recordingStatus: detail.recordingStatus ?? (detail.recordingUrl ? 'ready' : null),
    recordingUrl: detail.recordingUrl ?? null,
    unifiedReport: report,
  };
}

export function PublicVoiceDemoPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [nationalDigits, setNationalDigits] = useState(() => parseNationalDigits(readPhoneFromUrl()));
  const [phoneFocused, setPhoneFocused] = useState(false);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const [demoClientId, setDemoClientId] = useState<DemoClientId>(() => readDemoClientIdFromUrl());
  const autoStartRequested = useMemo(() => shouldAutoStartFromUrl(searchParams), [searchParams]);
  const [autoStartDismissed, setAutoStartDismissed] = useState(false);
  const autoStartActive = autoStartRequested && !autoStartDismissed;
  const autoStartAttemptedRef = useRef(false);
  const [callId, setCallId] = useState<string | null>(() => readCallIdFromUrl());
  const [detail, setDetail] = useState<DemoCallState | null>(null);
  const [loading, setLoading] = useState(() => shouldAutoStartFromUrl(searchParams));
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState(false);
  const callIsFinal = isCallFinal(detail);

  useEffect(() => {
    if (!callId) return;
    const urlCallId = searchParams.get(CALL_ID_PARAM)?.trim() || null;
    if (urlCallId === callId) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(CALL_ID_PARAM, callId);
        return next;
      },
      { replace: true }
    );
  }, [callId, searchParams, setSearchParams]);

  useEffect(() => {
    if (!callId || callIsFinal) return;

    let cancelled = false;
    let inFlight = false;
    let activeController: AbortController | null = null;
    let consecutiveFailures = 0;

    const loadDetail = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      try {
        const response = await fetch(`${API_BASE}/api/public/demo-call/${encodeURIComponent(callId)}`, {
          signal: controller.signal,
        });
        const data = await readJsonResponse<DemoCallState>(response, 'Не удалось получить статус звонка');
        if (cancelled) return;
        consecutiveFailures = 0;
        setDetail(data);
        setNationalDigits((current) => {
          if (current.length === NATIONAL_LEN) return current;
          return parseNationalDigits(String(data?.to ?? ''));
        });
        setError(null);
      } catch (loadError) {
        if (cancelled || (loadError instanceof DOMException && loadError.name === 'AbortError')) return;
        consecutiveFailures += 1;
        // A single polling failure is transient and should not flash an error
        // while the next scheduled request can recover automatically.
        if (consecutiveFailures >= 2) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось получить статус звонка.');
        }
      } finally {
        if (activeController === controller) activeController = null;
        inFlight = false;
      }
    };

    void loadDetail();
    const interval = window.setInterval(() => {
      void loadDetail();
    }, 3000);

    return () => {
      cancelled = true;
      activeController?.abort();
      window.clearInterval(interval);
    };
  }, [callId, callIsFinal]);

  const screenState = useMemo<'form' | 'waiting' | 'result'>(() => {
    if (!callId) {
      if (autoStartActive && !error) return 'waiting';
      return 'form';
    }
    return isCallFinal(detail) ? 'result' : 'waiting';
  }, [callId, detail, autoStartActive, error]);

  const waitingPhase = useMemo(() => getWaitingPhase(detail), [detail]);

  const processingSteps = useMemo(
    () => [
      'Слушаем запись разговора',
      'Проверяем реплики менеджера',
      'Анализируем возражения',
      'Считаем оценки',
      'Собираем рекомендации',
      'Формируем отчёт',
    ],
    []
  );

  const [processingStep, setProcessingStep] = useState(0);

  useEffect(() => {
    if (waitingPhase !== 'processing') {
      setProcessingStep(0);
      return;
    }
    const id = window.setInterval(() => {
      setProcessingStep((s) => (s + 1) % processingSteps.length);
    }, 2400);
    return () => window.clearInterval(id);
  }, [waitingPhase, processingSteps.length]);

  const handleStartCall = useCallback(async () => {
    if (nationalDigits.length !== NATIONAL_LEN) {
      setPhoneError(true);
      setError(null);
      phoneInputRef.current?.focus();
      return;
    }
    const to = formatE164FromNational(nationalDigits);
    setLoading(true);
    setError(null);
    setPhoneError(false);
    try {
      const response = await fetch(`${API_BASE}/api/public/demo-call/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, client: demoClientId, scenario: 'realtime_pure' }),
      });
      const data = await readJsonResponse<{ callId: string }>(response, 'Не удалось запустить звонок');
      setCallId(data.callId);
      setDetail(null);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Не удалось запустить звонок.');
    } finally {
      setLoading(false);
    }
  }, [demoClientId, nationalDigits]);

  useEffect(() => {
    if (!autoStartActive || callId || autoStartAttemptedRef.current) return;
    autoStartAttemptedRef.current = true;
    void handleStartCall();
  }, [autoStartActive, callId, handleStartCall]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [screenState, waitingPhase]);

  function handleReset() {
    autoStartAttemptedRef.current = true;
    setAutoStartDismissed(true);
    setCallId(null);
    setDetail(null);
    setError(null);
    setPhoneError(false);
    setNationalDigits('');
    setLoading(false);
    setSearchParams((prev) => stripDemoCallParams(prev), { replace: true });
  }

  function onPhoneInputChange(raw: string) {
    setNationalDigits(parseNationalDigits(raw));
    if (phoneError) setPhoneError(false);
  }

  const resultAuditDetail = useMemo(
    () => (detail ? demoCallToAuditDetail(detail) : null),
    [detail]
  );

  const displayPhone = formatPhoneFieldValue(nationalDigits, phoneFocused);
  const waitingNumber = formatDisplayPhone(
    detail?.to || (nationalDigits.length ? formatE164FromNational(nationalDigits) : '')
  );
  const waitingClient =
    TRY_CLIENTS.find((client) => client.id === demoClientId) ?? TRY_CLIENTS[1];
  const innerMode = Boolean(resultAuditDetail)
    ? 'wide'
    : screenState === 'form'
      ? 'form'
      : screenState === 'waiting'
        ? 'wait'
        : '';

  return (
    <div className="theme-brutal sl-page sl-demo-page demo-call-brutal">
      <LandingHeader home={LANDING_HOME} />

      <div className="sl-inner sl-body">
        <main className="sl-demo">
          <div className={`demo-call-brutal__inner${innerMode ? ` demo-call-brutal__inner--${innerMode}` : ''}`}>
            {screenState === 'form' && (
            <div className="demo-call-brutal__hero-block">
              <div className="sl-section-tag">Живая проверка</div>
              <h1 className="demo-call-brutal__title">
                <span className="demo-call-brutal__title-line">Узнайте, выдержит ли</span>
                <span className="demo-call-brutal__title-line">ваш бизнес первый разговор</span>
              </h1>
              <p className="demo-call-brutal__subtitle">
                Выберите, кто позвонит. Получите звонок и разбор диалога
              </p>
                  <div className="demo-stand-picker sl-try-panel">
                    <TryClientPicker value={demoClientId} onChange={setDemoClientId} />
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleStartCall();
                    }}
                  >
                    <div className={`demo-call-brutal__pill${phoneError ? ' is-invalid' : ''}`}>
                      <input
                        ref={phoneInputRef}
                        className="demo-call-brutal__input"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="+7 999 000-00-00"
                        aria-label="Номер телефона"
                        aria-invalid={phoneError}
                        value={displayPhone}
                        onFocus={() => {
                          setPhoneFocused(true);
                          requestAnimationFrame(() => {
                            const el = phoneInputRef.current;
                            if (!el) return;
                            const len = el.value.length;
                            el.setSelectionRange(len, len);
                          });
                        }}
                        onBlur={() => setPhoneFocused(false)}
                        onChange={(e) => onPhoneInputChange(e.target.value)}
                      />
                      <FlowButton
                        text={loading ? 'Звоним…' : 'Позвонить'}
                        type="submit"
                        variant="solid"
                        disabled={loading}
                        className="demo-call-brutal__cta-flow"
                      />
                    </div>
                  </form>
                  <p className="sl-try-legal">
                    Нажимая кнопку, вы даёте{' '}
                    <Link to="/landing/consent" target="_blank" rel="noopener noreferrer">
                      согласие на обработку персональных данных
                    </Link>
                  </p>
                  {error && <div className="demo-call-brutal__error">{error}</div>}
            </div>
            )}

            {screenState === 'waiting' && (
              <div className="demo-stand-stack demo-wait-scene">
                <div className="demo-wait-card">
                  <div className="demo-wait-visual-slot">
                    {waitingPhase === 'call_active' ? (
                      <div className="demo-wait-pulse" aria-hidden>
                        <span className="demo-wait-pulse__ring" />
                        <span className="demo-wait-pulse__ring" />
                        <span className="demo-wait-pulse__ring" />
                        <span className="demo-wait-pulse__ring" />
                        <span className="demo-wait-pulse__core">
                          <svg viewBox="0 0 24 24" aria-hidden>
                            <path
                              fill="currentColor"
                              d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
                            />
                          </svg>
                        </span>
                      </div>
                    ) : (
                      <div className="demo-wait-loader" aria-hidden>
                        <svg viewBox="0 0 72 72">
                          <circle className="demo-wait-loader__track" cx="36" cy="36" r="28" />
                          <circle className="demo-wait-loader__arc" cx="36" cy="36" r="28" />
                        </svg>
                      </div>
                    )}
                  </div>
                  {waitingPhase === 'call_active' ? (
                    <>
                      <h2 className="demo-wait-card__title">Сейчас поступит звонок</h2>
                      <div className="demo-wait-card__copy">
                        <p className="demo-wait-card__text">
                          {waitingClient.name} сейчас вам позвонит. Ответьте — после разговора появится отчёт.
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <h2 className="demo-wait-card__title">Разбираем диалог</h2>
                      <div className="demo-wait-card__copy">
                        <p className="demo-wait-cycle" aria-live="polite">
                          <span key={processingSteps[processingStep]}>{processingSteps[processingStep]}</span>
                        </p>
                        <p className="demo-wait-card__text">
                          Обычно это занимает около 15 секунд
                        </p>
                      </div>
                    </>
                  )}
                  <div className="demo-wait-phone-slot">
                    {waitingPhase === 'call_active' && waitingNumber ? (
                      <div className="demo-wait-phone">{waitingNumber}</div>
                    ) : null}
                  </div>
                  {error && <div className="demo-call-brutal__error" style={{ marginTop: '1rem' }}>{error}</div>}
                </div>
                <FlowButton
                  text="Ввести другой номер"
                  type="button"
                  onClick={handleReset}
                  className="demo-stand-action"
                />
              </div>
            )}

            {screenState === 'result' && detail && (
              <div className="demo-stand-stack">
                <div className="demo-stand-report">
                  {resultAuditDetail ? (
                    <AuditAnalyticsReport detail={resultAuditDetail} />
                  ) : (
                    <div className="demo-brutal-insight-wrap">
                      <CallInsightCard detail={detail} />
                    </div>
                  )}
                </div>
                <FlowButton
                  text="Запустить новый звонок"
                  type="button"
                  variant="solid"
                  onClick={handleReset}
                  className="demo-stand-action"
                />
              </div>
            )}
          </div>

          {(screenState === 'form' || screenState === 'result') && (
            <FinalDemoBlock
              showCallCta={false}
              id="demo-stand-lead"
              className="demo-stand-final"
            />
          )}
        </main>

        <footer className="sl-footer">
          <div className="sl-footer-main">
            <div className="sl-footer-brand">
              <span className="sl-footer-logo">
                <SalsaLogo className="sl-footer-logo-svg" />
              </span>
              <span className="sl-footer-note">AI-платформа контроля качества продаж</span>
            </div>
          </div>
          <div className="sl-footer-meta">
            <span className="sl-footer-address">Юридический адрес: {OPERATOR_ADDRESS}</span>
            <div className="sl-footer-legal">
              {LEGAL_NAV.map((item) => (
                <Link key={item.slug} to={item.path}>{item.navLabel}</Link>
              ))}
            </div>
            <span className="sl-footer-copy">© {new Date().getFullYear()}</span>
          </div>
          <GridEnds />
        </footer>
      </div>
    </div>
  );
}
