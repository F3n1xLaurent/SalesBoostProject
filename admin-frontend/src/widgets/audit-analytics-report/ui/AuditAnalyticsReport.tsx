import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { trackProductEvent } from '../../../shared/analytics/productAnalytics';
import { ratingClass } from '../../../shared/lib/admin-panel/utils';
import { apiFetch } from '../../../entities/session';

type UnifiedReport = NonNullable<AuditDetailItem['unifiedReport']>;
type DialogLine = UnifiedReport['dialog'][number] & { betterExample?: string | null };

const STATUS_LABELS: Record<AuditDetailItem['status'], string> = {
  completed: 'Завершён',
  failed: 'Провал',
  interrupted: 'Прерван',
};

const STATUS_CLASS: Record<AuditDetailItem['status'], string> = {
  completed: 'sa-audit-status-completed',
  failed: 'sa-audit-status-failed',
  interrupted: 'sa-audit-status-interrupted',
};

const IMPORTANCE_CLASS: Record<UnifiedReport['keyFindings'][number]['importance'], string> = {
  Критично: 'critical',
  Важно: 'important',
  Средне: 'medium',
};

const MARK_LABELS: Record<NonNullable<UnifiedReport['dialog'][number]['mark']>, string> = {
  positive: 'Положительно',
  normal: 'Можно лучше',
  negative: 'Плохо',
};

const MARK_CLASS: Record<NonNullable<UnifiedReport['dialog'][number]['mark']>, string> = {
  positive: 'good',
  normal: 'normal',
  negative: 'bad',
};

function formatDuration(seconds: number) {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function scoreTone(score: number) {
  if (score >= 76) return 'good';
  if (score >= 50) return 'mid';
  return 'bad';
}

function resolveCategoryScores(
  categories: UnifiedReport['categories'],
  detail: AuditDetailItem,
  totalScore: number,
): UnifiedReport['categories'] {
  const allZero = categories.every((item) => item.score === 0);
  if (!allZero) return categories;

  const fromBlocks = new Map(
    detail.blocksBreakdown.map((item) => [item.block, Math.max(0, Math.min(100, Math.round(item.score)))]),
  );
  const fallback = Math.max(0, Math.min(100, Math.round(totalScore || detail.totalScore || 0)));

  return categories.map((item) => ({
    ...item,
    score: fromBlocks.get(item.name) ?? fallback,
  }));
}

function enrichDialogExamples(
  dialog: UnifiedReport['dialog'],
  findings: UnifiedReport['keyFindings'],
): DialogLine[] {
  return dialog.map((line) => {
    const existing = (line as DialogLine).betterExample?.trim() || null;
    if (line.role !== 'manager') return { ...line, betterExample: null };
    if (existing) return { ...line, betterExample: existing };

    const text = line.text.trim().toLowerCase();
    const matched = findings.find((finding) => {
      const quote = finding.quote.trim().toLowerCase();
      if (!quote || !text) return false;
      return text.includes(quote)
        || quote.includes(text)
        || text.includes(quote.slice(0, Math.min(40, quote.length)));
    });

    return {
      ...line,
      betterExample: matched?.betterExample?.trim() || null,
    };
  });
}

function ScoreGauge({ score }: { score: number }) {
  const size = 132;
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const tone = scoreTone(score);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setProgress(0);
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setProgress(Math.max(0, Math.min(100, score))));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [score]);

  const offset = circumference - (progress / 100) * circumference;

  return (
    <div className={`sa-call-report-gauge sa-call-report-gauge--${tone}`} aria-label={`Общий балл ${score} из 100`}>
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
      <div className="sa-call-report-gauge-center">
        <strong>{score}</strong>
      </div>
    </div>
  );
}

const CALL_WAVEFORM_BARS = 220;
const EMPTY_CALL_WAVEFORM = Array.from({ length: CALL_WAVEFORM_BARS }, (_, index) =>
  0.08 + (Math.sin(index * 0.47) + 1) * 0.035,
);

function formatPlaybackTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

async function analyzeCallWaveform(blob: Blob): Promise<number[]> {
  const AudioContextCtor = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return EMPTY_CALL_WAVEFORM;
  const context = new AudioContextCtor();
  try {
    const audioBuffer = await context.decodeAudioData((await blob.arrayBuffer()).slice(0));
    const blockSize = Math.max(1, Math.floor(audioBuffer.length / CALL_WAVEFORM_BARS));
    const peaks = Array.from({ length: CALL_WAVEFORM_BARS }, (_, index) => {
      const start = index * blockSize;
      const end = Math.min(audioBuffer.length, start + blockSize);
      const sampleStep = Math.max(1, Math.floor((end - start) / 256));
      let peak = 0;
      for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
        const channel = audioBuffer.getChannelData(channelIndex);
        for (let sample = start; sample < end; sample += sampleStep) {
          peak = Math.max(peak, Math.abs(channel[sample]));
        }
      }
      return peak;
    });
    const sorted = [...peaks].sort((a, b) => a - b);
    const normalizationPeak = Math.max(sorted[Math.floor(sorted.length * 0.96)] ?? 0, 0.001);
    return peaks.map((peak) => Math.max(0.06, Math.min(1, peak / normalizationPeak)));
  } finally {
    await context.close().catch(() => undefined);
  }
}

function CallRecordingPlayer({ recordingUrl }: { recordingUrl: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>(EMPTY_CALL_WAVEFORM);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setAudioUrl(null);
    setWaveform(EMPTY_CALL_WAVEFORM);
    setLoading(true);
    setError(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    apiFetch(recordingUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Recording request failed');
        const blob = await response.blob();
        if (blob.size === 0) throw new Error('Recording is empty');
        objectUrl = URL.createObjectURL(blob);
        setAudioUrl(objectUrl);
        analyzeCallWaveform(blob)
          .then((levels) => {
            if (!controller.signal.aborted) setWaveform(levels);
          })
          .catch(() => undefined);
      })
      .catch((requestError) => {
        if (!(requestError instanceof DOMException && requestError.name === 'AbortError')) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [recordingUrl]);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audio.duration && audio.currentTime >= audio.duration - 0.05) audio.currentTime = 0;
    audio.play().catch(() => setError(true));
  }

  function seek(event: React.MouseEvent<HTMLButtonElement>) {
    const audio = audioRef.current;
    if (!audio || event.detail === 0 || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    setCurrentTime(audio.currentTime);
  }

  function seekWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const shift = event.key === 'ArrowRight' ? 5 : -5;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + shift));
    setCurrentTime(audio.currentTime);
  }

  return (
    <section className="sa-call-report-recording">
      <div className="sa-call-report-recording-copy">
        <strong>Запись звонка</strong>
        <span>{loading ? 'Загружаем аудио…' : error ? 'Не удалось загрузить запись' : 'Можно прослушать разговор целиком'}</span>
      </div>
      <div className="sa-call-report-recording-player">
        <audio
          ref={audioRef}
          preload="metadata"
          src={audioUrl || undefined}
          onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
        <button
          type="button"
          className="sa-call-report-recording-play"
          disabled={!audioUrl || loading || error}
          onClick={togglePlayback}
          aria-label={playing ? 'Поставить запись на паузу' : 'Воспроизвести запись звонка'}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" aria-hidden><path d="M7 5h3v14H7zM14 5h3v14h-3z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden><path d="m8 5 11 7-11 7V5Z" /></svg>
          )}
        </button>
        <button
          type="button"
          className="sa-call-report-waveform"
          disabled={!audioUrl || error}
          onClick={seek}
          onKeyDown={seekWithKeyboard}
          aria-label={`Перемотать запись. Прослушано ${Math.round(progress * 100)}%`}
        >
          <svg viewBox={`0 0 ${CALL_WAVEFORM_BARS * 3} 68`} preserveAspectRatio="none" aria-hidden>
            {waveform.map((level, index) => {
              const height = 3 + level * 58;
              const played = index / waveform.length <= progress;
              return (
                <line
                  key={index}
                  className={played ? 'is-played' : undefined}
                  x1={index * 3 + 1.5}
                  x2={index * 3 + 1.5}
                  y1={(68 - height) / 2}
                  y2={(68 + height) / 2}
                />
              );
            })}
          </svg>
        </button>
        <span className="sa-call-report-recording-time">
          {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
        </span>
      </div>
    </section>
  );
}

export function AuditAnalyticsReport({
  detail,
  onOpenEmployee,
}: {
  detail: AuditDetailItem;
  onOpenEmployee?: (id: string) => void;
}) {
  const report = detail.unifiedReport;
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const date = new Date(detail.dateTime);
  const dateStr = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const categories = useMemo(
    () => (report ? resolveCategoryScores(report.categories, detail, report.totalScore) : []),
    [detail, report],
  );
  const dialogLines = useMemo(
    () => (report ? enrichDialogExamples(report.dialog, report.keyFindings) : []),
    [report],
  );

  useEffect(() => {
    if (!report) return;
    const targetType = detail.type === 'call' ? 'voice_call' : 'trainer_session';
    const properties = { report_type: detail.type } as const;
    trackProductEvent('report_viewed', { targetType, targetId: detail.id, properties });
    trackProductEvent('score_viewed', { targetType, targetId: detail.id, properties });
  }, [detail.id, detail.type, report]);

  const toggleFindings = () => {
    if (!findingsOpen) {
      trackProductEvent('errors_viewed', {
        targetType: detail.type === 'call' ? 'voice_call' : 'trainer_session',
        targetId: detail.id,
        properties: { report_type: detail.type },
      });
    }
    setFindingsOpen(!findingsOpen);
  };

  const toggleRecommendations = () => {
    if (!recommendationsOpen) {
      trackProductEvent('recommendations_viewed', {
        targetType: detail.type === 'call' ? 'voice_call' : 'trainer_session',
        targetId: detail.id,
        properties: { report_type: detail.type },
      });
    }
    setRecommendationsOpen(!recommendationsOpen);
  };

  return (
    <div className="sa-call-report">
      <div className="sa-call-report-header">
        <div>
          <div className="sa-call-report-eyebrow-row">
            <div className="sa-call-report-eyebrow">{detail.type === 'trainer' ? 'Отчёт по тренировке' : 'Отчёт по звонку'}</div>
            <span className={`sa-status-badge ${STATUS_CLASS[detail.status]}`}>{STATUS_LABELS[detail.status]}</span>
          </div>
          <h1 className="sa-page-title sa-call-report-title">{detail.employeeName}</h1>
          <div className="sa-call-report-meta">
            {detail.type === 'call' ? (
              <>
                <span>{detail.dealershipName}</span>
                <span>{detail.city}</span>
                <span>{dateStr}, {timeStr}</span>
                <span>Длительность: {formatDuration(detail.duration)}</span>
              </>
            ) : (
              <>
                <span>{detail.dealershipName}</span>
                <span>Сценарий: {detail.scenarioName || '—'}</span>
                <span>{dateStr}, {timeStr}</span>
              </>
            )}
          </div>
        </div>
        <div className="sa-call-report-header-actions">
          {detail.employeeId && (
            <button className="sa-btn-text" onClick={() => onOpenEmployee?.(detail.employeeId)}>
              Профиль сотрудника →
            </button>
          )}
        </div>
      </div>

      {detail.type === 'call' && detail.recordingStatus === 'ready' && detail.recordingUrl && (
        <CallRecordingPlayer recordingUrl={detail.recordingUrl} />
      )}

      {!report ? (
        <section className="sa-call-report-section">
          <h2 className="sa-section-title">Отчёт</h2>
          <p className="sa-call-report-section-desc">
            Для полного отчёта нужны transcript и AI-оценка звонка. Если данные уже есть, откройте страницу позже: backend догенерирует отчёт и сохранит его.
          </p>
        </section>
      ) : (
        <>
          <section className="sa-call-report-score">
            <ScoreGauge score={report.totalScore} />
            <div className="sa-call-report-score-body">
              <div className="sa-call-report-verdict">{report.verdict}</div>
              <p>{report.summary}</p>
              {detail.failReason && <div className="sa-audit-fail-reason">{detail.failReason}</div>}
            </div>
          </section>

          <section className="sa-call-report-block">
            <h2 className="sa-section-title">Категории</h2>
            <div className="sa-call-report-category-grid">
              {categories.map((item) => (
                <div key={item.name} className="sa-call-report-category">
                  <div className="sa-call-report-category-top">
                    <strong>{item.name}</strong>
                    <span className={ratingClass(item.score)}>{item.score}</span>
                  </div>
                  <div className="sa-call-report-category-bar">
                    <i
                      className={`sa-call-report-category-fill sa-call-report-category-fill--${scoreTone(item.score)}`}
                      style={{ width: `${item.score <= 0 ? 5 : Math.max(item.score, 4)}%` }}
                    />
                  </div>
                  <p>{item.comment}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="sa-call-report-two-col">
            <div className="sa-call-report-section">
              <h2 className="sa-section-title">Сильные стороны</h2>
              {report.strengths.length ? (
                <ul className="sa-call-report-list sa-call-report-list--strengths">
                  {report.strengths.map((item) => (
                    <li key={item}>
                      <span className="sa-call-report-list-icon" aria-hidden>+</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="sa-chart-empty">Сильные стороны не выделены</div>
              )}
            </div>
            <div className="sa-call-report-section">
              <h2 className="sa-section-title">Слабые стороны</h2>
              {report.weaknesses.length ? (
                <ul className="sa-call-report-list sa-call-report-list--weaknesses">
                  {report.weaknesses.map((item) => (
                    <li key={item}>
                      <span className="sa-call-report-list-icon" aria-hidden>−</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="sa-chart-empty">Слабые стороны не выделены</div>
              )}
            </div>
          </section>

          <section className="sa-call-report-block">
            <button
              type="button"
              className={`sa-call-report-collapse-toggle${findingsOpen ? ' is-open' : ''}`}
              aria-expanded={findingsOpen}
              onClick={toggleFindings}
            >
              <span className="sa-call-report-collapse-icon" aria-hidden>{findingsOpen ? '−' : '+'}</span>
              <span className="sa-section-title">Ключевые находки</span>
              <span className="sa-call-report-collapse-meta">
                {report.keyFindings.length ? `${report.keyFindings.length}` : 'Нет данных'}
              </span>
            </button>
            {findingsOpen ? (
              report.keyFindings.length ? (
                <div className="sa-call-report-findings-list">
                  {report.keyFindings.map((finding, index) => (
                    <article
                      key={`${finding.problemTitle}-${finding.category}-${index}`}
                      className={`sa-call-report-finding-row sa-call-report-finding-row--${IMPORTANCE_CLASS[finding.importance]}`}
                    >
                      <div className="sa-call-report-finding-index">{index + 1}</div>
                      <div className="sa-call-report-finding-main">
                        <div className="sa-call-report-finding-head">
                          <div>
                            <h3>{finding.problemTitle}</h3>
                            <div className="sa-call-report-finding-meta">{finding.category}</div>
                          </div>
                          <b className={`sa-call-report-priority sa-call-report-priority--${IMPORTANCE_CLASS[finding.importance]}`}>
                            {finding.importance}
                          </b>
                        </div>
                        {finding.comment ? <p className="sa-call-report-finding-comment">{finding.comment}</p> : null}
                        {(finding.quote || finding.betterExample) ? (
                          <div className="sa-call-report-finding-evidence">
                            {finding.quote ? (
                              <div className="sa-call-report-finding-quote">
                                <span>Цитата</span>
                                <p>{finding.quote}</p>
                              </div>
                            ) : null}
                            {finding.betterExample ? (
                              <div className="sa-call-report-better">
                                <span>Как лучше</span>
                                <p>{finding.betterExample}</p>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="sa-chart-empty">Значимые проблемы не выделены</div>
              )
            ) : null}
          </section>

          <section className="sa-call-report-block">
            <button
              type="button"
              className={`sa-call-report-collapse-toggle${transcriptOpen ? ' is-open' : ''}`}
              aria-expanded={transcriptOpen}
              onClick={() => setTranscriptOpen((current) => !current)}
            >
              <span className="sa-call-report-collapse-icon" aria-hidden>{transcriptOpen ? '−' : '+'}</span>
              <span className="sa-section-title">Транскрипт диалога</span>
              <span className="sa-call-report-collapse-meta">
                {dialogLines.length ? `${dialogLines.length} реплик` : 'Нет данных'}
              </span>
            </button>
            {transcriptOpen ? (
              <div className="sa-call-report-section sa-call-report-section--dialog">
                <div className="sa-call-report-dialog">
                  {dialogLines.length ? dialogLines.map((line, index) => (
                    <div
                      key={`${index}-${line.role}`}
                      className={[
                        'sa-call-report-turn',
                        `sa-call-report-turn--${line.role}`,
                        line.mark ? `sa-call-report-turn--mark-${MARK_CLASS[line.mark]}` : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <div className="sa-call-report-turn-meta">
                        <strong>{line.role === 'client' ? 'Клиент' : 'Менеджер'}</strong>
                        {line.mark && (
                          <b className={`sa-call-report-mark sa-call-report-mark--${MARK_CLASS[line.mark]}`}>
                            {MARK_LABELS[line.mark]}
                          </b>
                        )}
                      </div>
                      <div className="sa-call-report-turn-text">{line.text}</div>
                      {line.comment ? <div className="sa-call-report-turn-comment">{line.comment}</div> : null}
                      {line.betterExample ? (
                        <div className="sa-call-report-turn-example">
                          <span>Пример ответа</span>
                          <p>{line.betterExample}</p>
                        </div>
                      ) : null}
                    </div>
                  )) : <div className="sa-chart-empty">Диалог недоступен</div>}
                </div>
              </div>
            ) : null}
          </section>

          <section className="sa-call-report-block">
            <button
              type="button"
              className={`sa-call-report-collapse-toggle${recommendationsOpen ? ' is-open' : ''}`}
              aria-expanded={recommendationsOpen}
              onClick={toggleRecommendations}
            >
              <span className="sa-call-report-collapse-icon" aria-hidden>{recommendationsOpen ? '−' : '+'}</span>
              <span className="sa-section-title">Рекомендации</span>
              <span className="sa-call-report-collapse-meta">
                {report.recommendations.length ? `${report.recommendations.length}` : 'Нет данных'}
              </span>
            </button>
            {recommendationsOpen ? (
              report.recommendations.length ? (
                <div className="sa-call-report-actions-list">
                  {report.recommendations.map((item, index) => (
                    <div key={`${item.category}-${item.text}`} className="sa-call-report-action">
                      <span className="sa-call-report-action-num">{index + 1}</span>
                      <div className="sa-call-report-action-body">
                        <p>{item.text}</p>
                        <div className="sa-call-report-action-tags">
                          <span className="sa-call-report-action-tag sa-call-report-action-tag--category">
                            <em>Категория</em>
                            {item.category}
                          </span>
                          {item.problemTitle ? (
                            <span className="sa-call-report-action-tag sa-call-report-action-tag--problem">
                              <em>Проблема</em>
                              {item.problemTitle}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sa-chart-empty">Рекомендации не сформированы</div>
              )
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
