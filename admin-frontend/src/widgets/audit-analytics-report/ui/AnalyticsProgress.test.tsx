import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AnalyticsProgress } from './AnalyticsProgress';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';

const detail = (overrides: Partial<NonNullable<AuditDetailItem['analyticsProgress']>> = {}) => ({
  transcript: [], analyticsProgress: { stage: 'evaluation' as const, status: 'processing' as const, transcriptReady: true, evaluationReady: false, message: 'Анализируем разговор.', ...overrides },
});
afterEach(() => vi.useRealTimers());
describe('animated analytics stages', () => {
  it('does not offer a paid restart while a report is waiting for an available worker', () => {
    const html = renderToStaticMarkup(<AnalyticsProgress detail={detail({ status: 'waiting', waitingForSlot: true,
      startedAt: '2000-01-01T00:00:00Z', message: 'Отчёт в очереди на обработку.' })} onRetry={() => {}} />);
    expect(html).toContain('Отчёт в очереди');
    expect(html).not.toContain('Переполучить отчёт');
  });
  it.each(['waiting', 'processing'] as const)('shows retry for %s after two minutes even when reopening the report', (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:02:00Z'));
    const render = (startedAt: string) => renderToStaticMarkup(<AnalyticsProgress detail={detail({ status, startedAt })} onRetry={() => {}} />);
    expect(render('2026-11-03T12:00:00.001Z')).not.toContain('Переполучить отчёт');
    expect(render('2026-11-03T12:00:00.000Z')).toContain('Переполучить отчёт');
    expect(render('2026-11-03T12:02:00.000Z')).not.toContain('Переполучить отчёт');
  });
  it('shows confirmed completed/current/pending steps, not a fake percentage', () => {
    const html = renderToStaticMarkup(<AnalyticsProgress detail={detail()} />);
    expect(html).toContain('Расшифровка диалога'); expect(html).toContain('Первоначальная аналитика'); expect(html).toContain('Подготовка отчёта');
    expect(html.match(/is-done/g)).toHaveLength(1); expect(html.match(/is-active/g)).toHaveLength(1);
    expect(html).toContain('aria-current="step"'); expect(html).toContain('role="status"');
    expect(html).toContain('появится автоматически'); expect(html).not.toContain('%');
    expect(html).not.toContain('backend'); expect(html).not.toContain('transcript');
  });
  it('does not mark the next step as running when the backend is only waiting', () => {
    const html = renderToStaticMarkup(<AnalyticsProgress detail={detail({ status: 'waiting' })} />);
    expect(html).not.toContain('is-active'); expect(html).not.toContain('is-processing');
    expect(html).toContain('Ожидание');
  });
  it('shows a terminal error without an infinite spinner', () => {
    const html = renderToStaticMarkup(<AnalyticsProgress detail={detail({ status: 'failed', message: 'Не удалось подготовить отчёт.' })} />);
    expect(html).toContain('Не удалось подготовить аналитику'); expect(html).toContain('is-failed');
    expect(html).not.toContain('sa-analytics-progress-spinner'); expect(html).not.toContain('появится автоматически');
  });
  it('does not pretend to analyze an unanswered call', () => {
    const html = renderToStaticMarkup(<AnalyticsProgress detail={detail({ status: 'unavailable', transcriptReady: false })} />);
    expect(html).toContain('Нет разговора для анализа'); expect(html).not.toContain('<ol');
  });
  it('distinguishes a temporary connection problem from a failed analysis', () => {
    const html = renderToStaticMarkup(<AnalyticsProgress detail={detail()} connectionLost />);
    expect(html).toContain('проверку соединения автоматически'); expect(html).not.toContain('Не удалось подготовить аналитику');
  });
  it.each(['transcription', 'evaluation', 'report'] as const)('offers manual recovery after a %s failure', (stage) => {
    const html = renderToStaticMarkup(<AnalyticsProgress detail={detail({ stage, status: 'failed' })} onRetry={() => {}} />);
    expect(html).toContain('Переполучить отчёт');
    expect(html).toContain('<button type="button"');
  });
  it('disables repeated requests and shows a friendly launch error', () => {
    const html = renderToStaticMarkup(<AnalyticsProgress detail={detail({ status: 'failed' })} onRetry={() => {}} retrying retryError="Не удалось запустить подготовку отчёта." />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('Запускаем…');
    expect(html).toContain('role="alert"');
  });
  it('does not offer regeneration for processing, waiting or unavailable analytics, or without access', () => {
    for (const status of ['processing', 'waiting', 'unavailable', 'ready'] as const) {
      expect(renderToStaticMarkup(<AnalyticsProgress detail={detail({ status })} onRetry={() => {}} />)).not.toContain('Переполучить отчёт');
    }
    expect(renderToStaticMarkup(<AnalyticsProgress detail={detail({ status: 'failed' })} />)).not.toContain('Переполучить отчёт');
  });
});
