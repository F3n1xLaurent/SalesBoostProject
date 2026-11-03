import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallInsightDetail } from '../../../shared/model/call-insight/types';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { DemoCallResult } from './DemoCallResult';
import { ReportHeader } from '../../../shared/ui/demo-report/ReportHeader';

vi.mock('../../../widgets/call-insight-card', () => ({ CallInsightCard: () => <div>Fallback report</div> }));
vi.mock('../../../widgets/audit-analytics-report', () => ({ AuditAnalyticsReport: () => <div>Unified report</div> }));

// This test runner uses classic JSX; Vite uses the automatic React runtime.
beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const detail: CallInsightDetail & { isProcessing: boolean } = {
  id: 1, to: '+79507503215', startedAt: '2026-11-03T10:45:55Z', endedAt: '2026-11-03T10:46:02Z',
  outcome: 'no_answer', durationSec: 7, totalScore: null, qualityTag: null,
  strengths: [], weaknesses: [], recommendations: [], transcript: [], isProcessing: false,
  processingError: 'Недозвон: абонент не ответил или отклонил вызов.',
};

function renderResult(item = detail, auditDetail: AuditDetailItem | null = null) {
  return renderToStaticMarkup(<DemoCallResult detail={item} auditDetail={auditDetail}
    phone="+7 950 750-32-15" loading={false} onRetry={() => {}} onReset={() => {}} />);
}

describe('public demo result screen', () => {
  it.each(['no_answer', 'busy', 'failed', 'cancelled'])('replaces the entire %s report with the missed call screen', (outcome) => {
    const html = renderResult({ ...detail, outcome });
    expect(html).toContain('Не удалось дозвониться');
    expect(html).toContain('Позвонить ещё раз');
    expect(html).not.toContain('Fallback report');
    expect(html).not.toContain('AI рейтинг');
    expect(html).not.toContain('Ошибка обработки');
    expect(html).not.toContain(outcome);
  });

  it('hides even a previously generated report when the call was not answered', () => {
    expect(renderResult(detail, {} as AuditDetailItem)).not.toContain('Unified report');
  });

  it('keeps the real conversation report', () => {
    const html = renderResult({ ...detail, outcome: 'disconnected', processingError: null, transcript: [
      { role: 'client', text: 'Сколько стоит автомобиль?' }, { role: 'manager', text: 'Два миллиона рублей.' },
    ] });
    expect(html).toContain('Fallback report');
    expect(html).not.toContain('Не удалось дозвониться');
  });
});

describe('report status labels', () => {
  it.each([
    ['no_answer', 'Нет ответа'], ['busy', 'Абонент занят'], ['failed', 'Не удалось соединиться'],
    ['cancelled', 'Вызов отменён'], ['disconnected', 'Завершён'], ['completed', 'Завершён'],
    ['provider_internal_status', 'Статус не определён'],
  ])('never exposes the technical status %s', (outcome, label) => {
    const html = renderToStaticMarkup(<ReportHeader detail={{ ...detail, outcome }} onExportPdf={() => {}} />);
    expect(html).toContain(label);
    expect(html).not.toContain(outcome);
    if (outcome === 'no_answer' || outcome === 'busy') expect(html).not.toContain('Ошибка обработки');
  });
});
