import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { ReportTestingPage } from './ReportTestingPage';
vi.mock('../../../shared/api/autoTesting', () => ({ autoTestingClient: () => ({ fetchRun: vi.fn() }) }));
vi.mock('./RealtimeRegressionPanel', () => ({ RealtimeRegressionPanel: ({ target, planId, disabled }: any) => <button data-target={target} data-source={planId} disabled={disabled}>Запустить всю серию</button> }));
it('offers code-defined report fixtures, not existing call/training selectors', () => {
  const html = renderToStaticMarkup(<MemoryRouter><ReportTestingPage available /></MemoryRouter>);
  expect(html).toContain('29 пунктов'); expect(html).toContain('12 встроенных сценариев'); expect(html).toContain('data-target="report"'); expect(html).toContain('data-source="report-builtin-v1"'); expect(html).not.toContain('<select'); expect(html).toContain('требуют ручной проверки');
});
it('does not silently open the latest run while an archived report is loading', () => {
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/testing?target=report&runId=saved-id']}><ReportTestingPage available /></MemoryRouter>);
  expect(html).toContain('value="saved-id"'); expect(html).toContain('Загружаем проверку'); expect(html).not.toContain('data-target="report"');
});
