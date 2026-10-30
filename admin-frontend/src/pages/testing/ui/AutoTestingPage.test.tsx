import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AutoTestingPage } from './AutoTestingPage';

vi.mock('../../../shared/api/autoTesting', () => ({ fetchAutoTestingCatalog: vi.fn(), fetchCallPlanAutoTest: vi.fn() }));
vi.mock('./RealtimeRegressionPanel', () => ({ RealtimeRegressionPanel: () => <div>Latest report placeholder</div> }));
vi.mock('./TrainerTestingPage', () => ({ TrainerTestingPage: () => <div>Trainer tests placeholder</div> }));

describe('open a saved autotest by ID', () => {
  it('offers a lookup in the regular autotest page', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/testing?tab=autotesting']}><AutoTestingPage plans={[]} loading={false} /></MemoryRouter>);
    expect(html).toContain('Открыть сохранённую проверку по ID');
    expect(html).toContain('Latest report placeholder');
  });
  it('does not silently replace a requested historical report with the latest report', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/testing?tab=autotesting&runId=persisted-id']}><AutoTestingPage plans={[]} loading={false} /></MemoryRouter>);
    expect(html).toContain('value="persisted-id"');
    expect(html).toContain('Загружаем проверку persisted-id');
    expect(html).not.toContain('Latest report placeholder');
    expect(html).toContain('К последним проверкам');
  });
});
