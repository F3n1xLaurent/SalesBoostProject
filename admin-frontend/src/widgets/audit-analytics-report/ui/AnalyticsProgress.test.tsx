import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnalyticsProgress } from './AnalyticsProgress';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';

const detail = (overrides: Partial<NonNullable<AuditDetailItem['analyticsProgress']>> = {}) => ({
  transcript: [], analyticsProgress: { stage: 'evaluation' as const, status: 'processing' as const, transcriptReady: true, evaluationReady: false, message: 'Анализируем разговор.', ...overrides },
});
describe('animated analytics stages', () => {
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
});
