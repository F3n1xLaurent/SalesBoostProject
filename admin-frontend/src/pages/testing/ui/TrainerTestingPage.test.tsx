import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { TrainerTestingPage } from './TrainerTestingPage';
import { TRAINER_BUILTIN_SUITE_ID } from '../../../../../src/testing/trainerBuiltinFixtures';

vi.mock('../../../shared/api/autoTesting', () => ({ autoTestingClient: () => ({ fetchRun: vi.fn() }) }));
vi.mock('./RealtimeRegressionPanel', () => ({ RealtimeRegressionPanel: ({ planId, disabled }: { planId: string; disabled: boolean }) => <div data-suite={planId}><button type="button" disabled={disabled}>Запустить всю серию</button></div> }));

describe('trainer autotests use built-in data without prerequisites', () => {
  it('offers a ready-to-run built-in set instead of requiring saved training selectors', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/testing?tab=autotesting&target=trainer']}><TrainerTestingPage available /></MemoryRouter>);
    expect(html).toContain(`data-suite="${TRAINER_BUILTIN_SUITE_ID}"`); expect(html).toContain('Женский профиль подключается автоматически');
    expect(html).toContain('Скептик'); expect(html).toContain('Сомневающаяся'); expect(html).toContain('Болтун');
    expect(html).not.toContain('<select'); expect(html).toContain('<button type="button">Запустить всю серию</button>');
    expect(html).not.toContain('Тренировка-образец');
  });
  it('keeps direct access to archived run IDs without substituting a new report', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/testing?tab=autotesting&target=trainer&runId=old-id']}><TrainerTestingPage available /></MemoryRouter>);
    expect(html).toContain('value="old-id"'); expect(html).toContain('Загружаем проверку'); expect(html).not.toContain('data-suite=');
  });
});
